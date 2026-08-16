/**
 * Audit every episode's subtitle situation in one pass.
 *
 *   node tools/qa.mjs
 *
 * For each episode it reports the correctly-timed reference track (embedded or
 * same-named sidecar), every candidate Spanish track, and for each of those how
 * well it actually lines up with the reference — overlap, coverage of the
 * episode's speech, the largest untranslated hole, and any stray markup.
 *
 * Overlap is the number that matters: 1.00 means the cues appear at the same
 * moments as the track authored for this exact cut. Coverage catches the other
 * failure, a file that is well timed but missing half its lines.
 */
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';
import { cueVector, FRAME_MS } from '../server/lib/align/vad.js';

const JUNK = [
  [/~/, 'tilde'],
  [/\{[^}]*\}/, 'ass-braces'],
  [/&[a-z]+;|&#\d+;/i, 'entity'],
  [/<(?!\/?i>)[^>]+>/i, 'html-tag'],
  [/\N|\n/, 'ass-newline'],
  [/\|/, 'pipe'],
  [/^\s*[-–—]\s*$/m, 'empty-dash'],
];

function overlap(a, b, frames) {
  const A = cueVector(a, frames);
  const B = cueVector(b, frames);
  let inter = 0, union = 0;
  for (let i = 0; i < frames; i++) {
    if (A[i] && B[i]) inter++;
    if (A[i] || B[i]) union++;
  }
  return union ? inter / union : 0;
}

/** Longest stretch of reference speech with no cue in the candidate. */
function biggestHole(reference, candidate) {
  let worst = 0, at = 0, run = 0, runStart = 0;
  let j = 0;
  for (const r of reference) {
    while (j < candidate.length && candidate[j].end < r.start) j++;
    const covered = j < candidate.length && candidate[j].start <= r.end;
    if (covered) { run = 0; continue; }
    if (run === 0) runStart = r.start;
    run = r.end - runStart;
    if (run > worst) { worst = run; at = runStart; }
  }
  return { seconds: Math.round(worst), at: Math.round(at) };
}

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
const rows = [];

for (const ep of episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (ep.media?.error) { rows.push({ tag, error: ep.media.error }); continue; }

  const embedded = (ep.media?.subtitles || []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  const videoBase = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const sidecar = ep.subs.find(
    (s) => path.dirname(s.path).toLowerCase() === path.dirname(ep.path).toLowerCase() &&
           path.basename(s.path, path.extname(s.path)).toLowerCase() === videoBase
  );

  let reference = null, refKind = 'none';
  try {
    if (embedded.length) { reference = await loadSubtitle(await extractEmbedded(cfg, ep, embedded[0].index)); refKind = 'embedded'; }
    else if (sidecar) { reference = await loadSubtitle(sidecar.path); refKind = 'sidecar'; }
  } catch (err) { refKind = `failed: ${err.message}`; }

  const frames = Math.round(((ep.media?.duration || 1500) * 1000) / FRAME_MS);
  const tracks = [];
  for (const s of ep.subs) {
    let sub;
    try { sub = await loadSubtitle(s.path); } catch { continue; }
    const text = sub.cues.map((c) => c.text).join('\n');
    tracks.push({
      file: s.file,
      lang: sub.detectedLang || s.lang || '?',
      cues: sub.cueCount,
      overlap: reference ? Number(overlap(reference.cues, sub.cues, frames).toFixed(2)) : null,
      hole: reference ? biggestHole(reference.cues, sub.cues) : null,
      junk: JUNK.filter(([re]) => re.test(text)).map(([, name]) => name),
      isReference: sidecar && s.path === sidecar.path,
    });
  }
  rows.push({ tag, refKind, refCues: reference?.cueCount ?? 0, duration: Math.round(ep.media?.duration || 0), tracks });
}

console.log(JSON.stringify(rows, null, 1));
