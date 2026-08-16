/**
 * Translate a correctly-timed subtitle track into another language, keeping
 * every timestamp byte-identical.
 *
 *   node tools/translate.mjs S03E01                  # translate one episode
 *   node tools/translate.mjs S03E01 S03E02 S03E03
 *   node tools/translate.mjs --season 3              # a whole season
 *   node tools/translate.mjs --lang pt-BR S03E01
 *
 * Why translate rather than download: a subtitle written for another release
 * has to be dragged onto this one, and when the two cuts differ scene by scene
 * that never lands perfectly. The track that ships with your own file — muxed
 * into the MKV, or sitting beside it under the same name — is already correct
 * for this cut and complete. Translating that gives correct timing by
 * construction and no missing lines, because nothing is being moved at all.
 *
 * Timings are copied, never regenerated. The output is verified against the
 * source before it is written: same number of cues, identical start and end
 * times. A mismatch aborts rather than writing a subtly wrong file.
 *
 * Needs ANTHROPIC_API_KEY in the environment.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';
import { toSrt } from '../server/lib/subtitles/retime.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const TARGET = flag('lang', 'es-419');
const MODEL = flag('model', 'claude-opus-5');
const EFFORT = flag('effort', 'medium');
const BATCH = Number(flag('batch', 40));
const season = flag('season', null);
const episodes = args.filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.\n  PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
  process.exit(1);
}
if (!episodes.length && !season) {
  console.error('Give me at least one episode (S03E01) or --season 3');
  process.exit(1);
}

const client = new Anthropic();

const LANGUAGE_NAMES = {
  'es-419': 'Latin American Spanish',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  fr: 'French',
  it: 'Italian',
  de: 'German',
};
const targetName = LANGUAGE_NAMES[TARGET] || TARGET;

const SYSTEM = `You translate television subtitles into ${targetName}.

This is a quiet Japanese drama set in a late-night diner: ordinary people talking
over food. The register is casual and warm, occasionally wistful. Match it.

Rules:
- Translate the meaning, not the words. Subtitles are read in a second or two,
  so they must sound like speech, not like written prose.
- Keep Japanese food names and dishes as they are (nekomanma, katsudon, ochazuke,
  tonjiru). They are the point of each episode, and a translated name loses it.
- Keep names and honorifics as written (Miyuki-chan, Kosuzu-san). Keep "Master"
  for the proprietor — it is what the customers call him.
- Preserve <i>...</i> markup and line breaks exactly where they appear.
- A cue that is a sound effect, a sign, or a song lyric stays in that register;
  do not turn a sign into dialogue.
- If a line is already in ${targetName}, or is a proper name alone, return it unchanged.
- Never merge or split cues. One input line produces exactly one output line.`;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

/** The subtitle that is already correct for this exact video file. */
async function findSource(cfg, ep) {
  const embedded = (ep.media?.subtitles || []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  if (embedded.length) return extractEmbedded(cfg, ep, embedded[0].index);

  const base = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const sidecar = ep.subs.find(
    (s) =>
      path.dirname(s.path).toLowerCase() === path.dirname(ep.path).toLowerCase() &&
      path.basename(s.path, path.extname(s.path)).toLowerCase() === base
  );
  return sidecar ? sidecar.path : null;
}

async function translateBatch(cues, offset, total) {
  const numbered = cues.map((c, i) => ({ id: offset + i, text: c.text }));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: SYSTEM,
    output_config: {
      // A schema rather than free text: it guarantees one translation per cue,
      // each carrying back the id it belongs to, so a dropped or merged line
      // is impossible rather than merely unlikely.
      format: { type: 'json_schema', schema: RESULT_SCHEMA },
      effort: EFFORT,
    },
    messages: [
      {
        role: 'user',
        content:
          `Translate these subtitle lines into ${targetName}. ` +
          `They are lines ${offset + 1}-${offset + cues.length} of ${total}, in order, so read them as continuous dialogue.\n\n` +
          JSON.stringify(numbered, null, 1),
      },
    ],
  });

  const parsed = JSON.parse(response.content.find((b) => b.type === 'text').text);
  const byId = new Map(parsed.translations.map((t) => [t.id, t.text]));

  return cues.map((cue, i) => {
    const text = byId.get(offset + i);
    if (typeof text !== 'string') throw new Error(`model returned no line for cue ${offset + i + 1}`);
    return { ...cue, text };
  });
}

async function translateEpisode(cfg, ep, tag) {
  const sourceFile = await findSource(cfg, ep);
  if (!sourceFile) {
    console.log(`${tag}  no correctly-timed source track on this file — skipped`);
    return;
  }

  const out = path.join(path.dirname(ep.path), `${path.basename(ep.path, path.extname(ep.path))}.${TARGET}.srt`);
  if (fssync.existsSync(out)) {
    console.log(`${tag}  already translated — skipped`);
    return;
  }

  const source = await loadSubtitle(sourceFile);
  console.log(`${tag}  ${source.cueCount} cues from ${source.detectedLang || 'unknown'} -> ${TARGET}`);

  // Progress is written as it goes: a long run that dies partway through
  // resumes instead of paying for the same lines twice.
  const cacheFile = path.join(cfg.cacheDir, 'translate', `${ep.id}.${TARGET}.json`);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  let done = [];
  try {
    done = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}

  for (let i = done.length; i < source.cues.length; i += BATCH) {
    const slice = source.cues.slice(i, i + BATCH);
    const translated = await translateBatch(slice, i, source.cues.length);
    done.push(...translated);
    await fs.writeFile(cacheFile, JSON.stringify(done));
    process.stdout.write(`\r  ${tag}  ${done.length}/${source.cues.length} lines   `);
  }
  process.stdout.write('\r'.padEnd(40) + '\r');

  /*
   * Verify before writing. The whole value of this route is that the timing is
   * correct by construction, so a file whose timings drifted from the source is
   * worse than no file — it looks right and is not.
   */
  if (done.length !== source.cues.length) {
    throw new Error(`${tag}: got ${done.length} lines for ${source.cues.length} cues`);
  }
  for (let i = 0; i < done.length; i++) {
    if (done[i].start !== source.cues[i].start || done[i].end !== source.cues[i].end) {
      throw new Error(`${tag}: timing changed on cue ${i + 1} — refusing to write`);
    }
  }

  await fs.writeFile(out, toSrt(done), 'utf8');
  console.log(`${tag}  wrote ${path.basename(out)} (${done.length} lines, timings identical to source)`);
}

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes: all } = pairLibrary(raw.videos, raw.subs, cfg, {});

const wanted = all
  .filter((ep) => !ep.media?.error)
  .filter((ep) => {
    const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
    return season ? String(ep.season) === String(season) : episodes.includes(tag);
  })
  .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

if (!wanted.length) {
  console.error('No matching episodes found in the library.');
  process.exit(1);
}

console.log(`Translating ${wanted.length} episode(s) into ${targetName} with ${MODEL} (effort ${EFFORT})\n`);
for (const ep of wanted) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  await translateEpisode(cfg, ep, tag);
}
console.log('\nDone. Press Rescan in the player to pick the new tracks up.');
