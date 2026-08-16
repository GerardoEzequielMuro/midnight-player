/**
 * Translate a correctly-timed subtitle track using the Gemini API, keeping every
 * timestamp byte-identical.
 *
 *   node tools/translate-gemini.mjs S03E01
 *   node tools/translate-gemini.mjs --season 3
 *   node tools/translate-gemini.mjs --lang pt-BR --model gemini-2.5-flash S03E01
 *
 * Same contract as tools/translate.mjs — timings are copied, never regenerated,
 * and the result is verified against the source before anything is written.
 * This variant exists because Google's free tier covers a job this size, so
 * translating a season costs nothing.
 *
 * Get a key at https://aistudio.google.com/apikey, then:
 *   PowerShell:  $env:GEMINI_API_KEY = "..."
 *
 * No SDK dependency — this speaks the REST API directly.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';
import { toSrt } from '../server/lib/subtitles/retime.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const TARGET = flag('lang', 'es-419');
const BATCH = Number(flag('batch', 50));
const DELAY = Number(flag('delay', 4000)); // free tier is ~15 requests/min
const FORCE = args.includes('--force');
const season = flag('season', null);
let MODEL = flag('model', null);
const episodes = args.filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());

if (!KEY) {
  console.error('GEMINI_API_KEY is not set.\n  Get a free key: https://aistudio.google.com/apikey\n  PowerShell:  $env:GEMINI_API_KEY = "..."');
  process.exit(1);
}
if (!episodes.length && !season) {
  console.error('Give me at least one episode (S03E01) or --season 3');
  process.exit(1);
}

const LANGUAGE_NAMES = {
  'es-419': 'Latin American Spanish',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  fr: 'French',
  it: 'Italian',
  de: 'German',
};
const targetName = LANGUAGE_NAMES[TARGET] || TARGET;

const CONTEXT = 10; // read-only lines shown either side of each batch

const INSTRUCTIONS = `You translate television subtitles into ${targetName}.

This is a quiet Japanese drama set in a late-night diner: ordinary people talking
over food. The register is casual and warm, occasionally wistful. Match it.

GENDER — what English hides and ${targetName} is forced to state:
- English adjectives and participles carry no gender; ${targetName} ones do. Every
  time you write one, decide who it refers to before you choose the ending.
- Work it out from the scene, not from the line alone: names and honorifics
  (-chan, -san, -kun), pronouns in nearby lines (she, her, his), and words like
  wife, husband, daughter. The surrounding lines are given to you for this.
- The proprietor, called Master, is a man.
- A greeting or remark aimed at someone on screen agrees with that person, not
  with a default. "Welcome" said to a woman is "Bienvenida", not "Bienvenido".
- When you genuinely cannot tell, do not fall back on masculine. Rephrase so
  gender never has to be stated — ${targetName} nearly always allows it
  ("¿te sientes bien?" rather than "¿estás enfermo?"). A neutral line is
  merely neutral; a wrongly gendered one is wrong twice, because it also tells
  the viewer something false about who is speaking.

Other rules:
- Translate the meaning, not the words. Subtitles are read in a second or two,
  so they must sound like speech, not like written prose.
- Keep Japanese food names as they are (nekomanma, katsudon, ochazuke, tonjiru).
  They are the point of each episode; a translated name loses it.
- Keep names and honorifics as written (Miyuki-chan, Kosuzu-san). Keep "Master"
  for the proprietor - it is what the customers call him.
- Preserve <i>...</i> markup exactly where it appears, and keep line breaks.
- A line that is a sound effect, a sign, or a song lyric stays in that register;
  do not turn a sign into dialogue.
- If a line is already in ${targetName}, or is a proper name alone, return it unchanged.
- Never merge or split lines. One input line produces exactly one output line.
- Return every id you were given, exactly once.`;

/*
 * The Japanese source marks singing by wrapping a line in "~". Spanish subtitles
 * use "♪". The swap happens here rather than in the prompt because the model has
 * no reason to care about a stray tilde: on the first run it preserved 35 of the
 * 36 markers and silently dropped one, and a lyric that reads as dialogue is a
 * real error. Doing it in code makes the count exact by construction.
 */
function stripLyrics(text) {
  const lines = String(text).split('\n');
  return {
    text: lines.map((l) => l.replace(/[\u266a~]+/g, ' ').replace(/\s+/g, ' ').trim()).join('\n'),
    flags: lines.map((l) => /[\u266a~]/.test(l)),
  };
}

function restoreLyrics(text, flags) {
  const lines = String(text).split('\n');
  // If the model changed the line count, fall back to the last known flag rather
  // than losing the marking entirely.
  return lines
    .map((l, i) => {
      const sung = flags[i] ?? flags[flags.length - 1];
      const bare = l.replace(/^[♪~\s]+|[♪~\s]+$/g, '');
      return sung && bare ? `♪ ${bare} ♪` : l;
    })
    .join('\n');
}

/*
 * The free tier caps requests PER DAY PER MODEL, not per minute: gemini-3.7-flash
 * allows 20 a day and then returns 429 no matter how long you wait. Backing off
 * therefore never recovers — it just burns the clock. But the cap is per model,
 * and the key can reach a dozen of them, so an exhausted model is a reason to
 * move to the next one rather than to stop.
 *
 * Ordered best-quality first. A whole episode is translated by one model so its
 * register stays consistent; the switch happens between episodes wherever
 * possible, and only mid-episode when a model runs dry partway through.
 */
const FALLBACKS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
];

const exhausted = new Set();

async function usableModels() {
  const res = await fetch(`${API}/models?key=${KEY}`);
  if (!res.ok) throw new Error(`could not list models: HTTP ${res.status}`);
  const { models = [] } = await res.json();
  const live = new Set(
    models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
  );
  return FALLBACKS.filter((m) => live.has(m));
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    translations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
        required: ['id', 'text'],
      },
    },
  },
  required: ['translations'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestTranslations(items, total, all) {
  // Explicit ids rather than a start offset: a retry covers whatever is still
  // missing, which is rarely a contiguous block, and renumbering it would hand
  // back translations under the wrong ids.
  const numbered = items.map(({ id, cue }) => ({ id, text: stripLyrics(cue.text).text }));
  const offset = items[0].id;
  const cues = items.map((it) => it.cue);

  /*
   * Lines either side of the batch, for reading only. A short line like "Welcome"
   * or "Are you all right?" cannot be gendered correctly from itself; who is in
   * the room is established a few cues earlier. Without this the model was
   * translating each block of thirty in isolation and defaulting to masculine.
   */
  const window = (from, to) =>
    all.slice(Math.max(0, from), Math.max(0, to)).map((c) => stripLyrics(c.text).text.replace(/\n/g, ' '));
  const before = window(offset - CONTEXT, offset);
  const after = window(offset + cues.length, offset + cues.length + CONTEXT);

  const body = {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `Translate these subtitle lines into ${targetName}. ` +
              `They are lines ${offset + 1}-${items[items.length - 1].id + 1} of ${total}, in order, so read them as continuous dialogue.\n\n` +
              JSON.stringify(numbered, null, 1),
          },
        ],
      },
    ],
    // A schema rather than free text: one translation per line, each carrying
    // back the id it belongs to, so a dropped or merged line is impossible.
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 32768,
    },
  };

  // The free tier is rate-limited per minute; back off and retry rather than
  // failing a long run over a throttle.
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}/models/${MODEL}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      process.stdout.write(`\r  rate limited, waiting ${Math.round(wait / 1000)}s…            `);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) throw new Error('empty response from the model');

    // A truncated response still parses as far as it got, so a parse failure and
    // a short array are the same problem: some ids are simply absent. Return
    // what came back and let the caller ask again for the rest.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const finish = data.candidates?.[0]?.finishReason;
      process.stdout.write(`\n  unparseable response${finish ? ` (finishReason ${finish})` : ''} — re-asking\n`);
      return new Map();
    }
    return new Map((parsed.translations || []).map((t) => [Number(t.id), t.text]));
  }
  throw new Error(`gave up after repeated rate limiting on ${MODEL}`);
}

/**
 * Translate a batch, re-asking for whatever did not come back.
 *
 * Models drop ids near the end of a long response, and a 30-episode unattended
 * run should not die because one line of one batch went missing. Each round
 * asks only for the ids still outstanding, which is both cheaper and more
 * reliable than repeating the whole block — the shorter the request, the less
 * likely it truncates again.
 */
async function translateBatch(cues, offset, total, all) {
  const got = new Map();
  let pending = cues.map((cue, i) => ({ cue, id: offset + i }));

  for (let round = 0; round < 4 && pending.length; round++) {
    // One request per round, never one per missing line: the free tier counts
    // requests per day, so fanning out a retry would spend the day's budget on
    // a handful of stragglers.
    const answers = await requestTranslations(pending, total, all);
    for (const [id, textOut] of answers) if (typeof textOut === 'string') got.set(id, textOut);
    pending = pending.filter((p) => !got.has(p.id));
    if (pending.length) process.stdout.write(`\n  re-asking ${pending.length} missing line(s)\n`);
  }

  if (pending.length) throw new Error(`no line returned for cue ${pending[0].id + 1} after 4 attempts`);

  return cues.map((cue, i) => {
    const translated = got.get(offset + i);
    const { flags } = stripLyrics(cue.text);
    return { ...cue, text: flags.some(Boolean) ? restoreLyrics(translated, flags) : translated };
  });
}

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

async function translateEpisode(cfg, ep, tag) {
  const sourceFile = await findSource(cfg, ep);
  if (!sourceFile) {
    console.log(`${tag}  no correctly-timed source track on this file — skipped`);
    return;
  }

  const out = path.join(path.dirname(ep.path), `${path.basename(ep.path, path.extname(ep.path))}.${TARGET}.srt`);
  if (fssync.existsSync(out) && !FORCE) {
    console.log(`${tag}  already translated — skipped`);
    return;
  }

  const source = await loadSubtitle(sourceFile);
  const cacheFile = path.join(cfg.cacheDir, 'translate', `${ep.id}.${TARGET}.json`);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });

  let done = [];
  if (FORCE) await fs.rm(cacheFile, { force: true });
  try {
    done = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}

  for (let i = done.length; i < source.cues.length; i += BATCH) {
    const slice = source.cues.slice(i, i + BATCH);
    done.push(...(await translateBatch(slice, i, source.cues.length, source.cues)));
    await fs.writeFile(cacheFile, JSON.stringify(done));
    process.stdout.write(`\r  ${tag}  ${done.length}/${source.cues.length} lines            `);
    await sleep(DELAY); // stay under the free tier's per-minute ceiling
  }
  process.stdout.write('\r'.padEnd(48) + '\r');

  /*
   * Verify before writing. The whole point of translating rather than retiming
   * is that the timing is correct by construction — a file whose timings drifted
   * from the source is worse than no file, because it looks right and is not.
   */
  if (done.length !== source.cues.length) {
    throw new Error(`${tag}: got ${done.length} lines for ${source.cues.length} cues`);
  }
  for (let i = 0; i < done.length; i++) {
    if (done[i].start !== source.cues[i].start || done[i].end !== source.cues[i].end) {
      throw new Error(`${tag}: timing changed on cue ${i + 1} — refusing to write`);
    }
  }

  const sungIn = source.cues.filter((c) => /[♪~]/.test(c.text)).length;
  const sungOut = done.filter((c) => /♪/.test(c.text)).length;
  if (sungIn !== sungOut) throw new Error(`${tag}: ${sungIn} sung lines in, ${sungOut} marked out - refusing to write`);

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

const POOL = MODEL ? [MODEL] : await usableModels();
if (!POOL.length) throw new Error('none of the known models are available on this key');
if (!MODEL) MODEL = POOL[0];
console.log(`Translating ${wanted.length} episode(s) into ${targetName} with ${MODEL}\n`);

for (const ep of wanted) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  await translateEpisode(cfg, ep, tag);
}
console.log('\nDone. Press Rescan in the player to pick the new tracks up.');
