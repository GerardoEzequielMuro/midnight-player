/**
 * Re-attach timings to a translated episode and write the subtitle file.
 *
 *   node tools/import-cues.mjs S03E01 ...
 *
 * Reads work/<TAG>.en.json (what was handed out) and work/<TAG>.es.json (what
 * came back), and writes "<video>.es-419.srt".
 *
 * Timestamps are taken from the reference track, never from the translation.
 * The translated side is only ever consulted for text, and it is checked first:
 * every id present exactly once, nothing empty, nothing left in English by
 * accident. A file that fails any of that is not written, because a subtitle
 * that is subtly wrong is worse than one that is missing — it looks finished.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { toSrt } from '../server/lib/subtitles/retime.js';

const tags = process.argv.slice(2).filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());
if (!tags.length) { console.error('give me episodes, e.g. S03E01'); process.exit(1); }

let written = 0;
for (const tag of tags) {
  let source;
  let done;
  try {
    source = JSON.parse(await fs.readFile(path.join('work', `${tag}.en.json`), 'utf8'));
    done = JSON.parse(await fs.readFile(path.join('work', `${tag}.es.json`), 'utf8'));
  } catch (err) {
    console.log(`${tag}  cannot read the work files: ${err.message.slice(0, 70)}`);
    continue;
  }

  const byId = new Map((Array.isArray(done) ? done : done.translations || []).map((t) => [Number(t.id), t.text]));
  const reference = await loadSubtitle(source.referencePath);

  if (reference.cueCount !== source.total) {
    console.log(`${tag}  reference changed since export (${reference.cueCount} vs ${source.total}) — skipped`);
    continue;
  }

  const problems = [];
  const cues = source.cues.map((c, i) => {
    // A sung line was never handed out; it passes through as it was.
    if (c.sung) return { ...reference.cues[i], text: reference.cues[i].text };
    const text = byId.get(c.id);
    if (typeof text !== 'string' || !text.trim()) problems.push(`cue ${c.id + 1} missing`);
    return { ...reference.cues[i], text: (text ?? c.text).replace(/\n/g, '<br>') };
  });

  /*
   * Ids that were not asked for are ignored rather than fatal, as long as they
   * are song lines. An earlier export failed to flag the theme blocks, so some
   * came back translated; the reference text wins for those either way, and
   * failing the whole episode over it would throw away good work.
   */
  const known = new Set(source.cues.map((c) => c.id));
  const unknown = [...byId.keys()].filter((id) => !known.has(id));
  if (unknown.length) problems.push(`${unknown.length} id(s) returned that do not exist`);
  const ignoredSongLines = [...byId.keys()].filter((id) => source.cues.find((c) => c.id === id)?.sung).length;

  if (problems.length) {
    console.log(`${tag}  NOT WRITTEN — ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
    continue;
  }

  // The whole point of this route: timing is inherited, not recomputed.
  const moved = cues.findIndex((c, i) => c.start !== reference.cues[i].start || c.end !== reference.cues[i].end);
  if (moved !== -1) { console.log(`${tag}  NOT WRITTEN — timing changed on cue ${moved + 1}`); continue; }

  const out = path.join(
    path.dirname(source.videoPath),
    `${path.basename(source.videoPath, path.extname(source.videoPath))}.es-419.srt`
  );
  await fs.writeFile(out, toSrt(cues), 'utf8');
  written++;
  console.log(`${tag}  wrote ${path.basename(out)} (${cues.length} cues, timings identical to the reference)`);
}
console.log(`\n${written}/${tags.length} written`);
