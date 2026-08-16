/**
 * Check every episode's subtitles against the actual audio.
 *
 *   node tools/audiocheck.mjs              # all episodes
 *   node tools/audiocheck.mjs S03E01
 *
 * The other QA tool compares a subtitle to another subtitle. This one compares
 * it to the speech in the video itself: the audio is reduced to a per-frame
 * speech/silence vector, the cue times are reduced to the same kind of vector,
 * and the two are cross-correlated. A track authored for this cut peaks at an
 * offset of zero.
 *
 * The number to read is the offset. Confidence says how much to trust it — a
 * low peak means the audio could not confirm anything either way, which is not
 * the same as the subtitles being wrong.
 */
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { speechVector, FRAME_MS } from '../server/lib/align/vad.js';
import { findAlignment } from '../server/lib/align/xcorr.js';

const args = process.argv.slice(2);
const only = args.filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());
const LANG = /^(spa|es)/;
const REF = args.includes('--reference'); // measure the English source instead

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
const eps = episodes
  .filter((e) => !e.media?.error)
  .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

/*
 * A single global offset is not enough to call a track in sync.
 *
 * Cross-correlation over a whole episode returns the one shift that fits best
 * overall, and it can be near zero while individual scenes sit seconds out —
 * that is exactly what a subtitle dragged from another release looks like, and
 * every S03 track measured 0.00s globally while overlapping the correctly-timed
 * reference by only 0.6. So the episode is also cut into windows and each is
 * aligned on its own. The spread between windows is the number that catches
 * drift; the global offset only catches a constant shift.
 */
const WINDOWS = 8;

function windowAlign(audio, cues, from, to) {
  const f0 = Math.max(0, Math.round((from * 1000) / FRAME_MS));
  const f1 = Math.min(audio.length, Math.round((to * 1000) / FRAME_MS));
  const slice = audio.subarray(f0, f1);
  const local = cues
    .filter((c) => c.start >= from && c.start < to)
    .map((c) => ({ ...c, start: c.start - from, end: c.end - from }));
  if (local.length < 8 || slice.length < 3000) return null;
  try {
    return findAlignment(slice, local, { maxOffsetSec: 20 });
  } catch {
    return null;
  }
}

console.log('TAG     track                        global   windows (per-segment offset)        worst  verdict');
const bad = [];

for (const ep of eps) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (only.length && !only.includes(tag)) continue;

  // Prefer the freshly translated track; that is the one that will be shipped.
  const cand = REF
    ? (ep.subs.find((s) => path.basename(s.path, path.extname(s.path)).toLowerCase() ===
        path.basename(ep.path, path.extname(ep.path)).toLowerCase()) || null)
    :
    ep.subs.find((s) => /\.es-419\.srt$/i.test(s.file) && !/retimed/i.test(s.file)) ||
    ep.subs.find((s) => LANG.test(s.lang || '') && /retimed/i.test(s.file)) ||
    ep.subs.find((s) => LANG.test(s.lang || ''));
  if (!cand) { console.log(`${tag}   ** no spanish track **`); continue; }

  let audio;
  try {
    audio = await speechVector(cfg, ep);
  } catch (err) {
    console.log(`${tag}   audio failed: ${err.message}`);
    continue;
  }

  const sub = await loadSubtitle(cand.path);
  const r = findAlignment(audio, sub.cues, { maxOffsetSec: 60 });
  const span = (audio.length * FRAME_MS) / 1000;
  const step = span / WINDOWS;

  const segs = [];
  for (let k = 0; k < WINDOWS; k++) {
    const w = windowAlign(audio, sub.cues, k * step, (k + 1) * step);
    // Only windows the audio can actually vouch for; a quiet stretch says nothing.
    segs.push(w && w.confidence >= 0.4 ? w.offset : null);
  }

  const solid = segs.filter((x) => x !== null);
  const worst = solid.length ? Math.max(...solid.map(Math.abs)) : null;
  const verdict =
    solid.length < 3 ? 'unconfirmed' :
    worst <= 0.5 ? 'in sync' :
    worst <= 1.2 ? 'slight drift' : 'DRIFTS';
  if (verdict === 'DRIFTS') bad.push(`${tag} up to ${worst.toFixed(1)}s`);

  const strip = segs.map((x) => (x === null ? '  ·  ' : (x >= 0 ? '+' : '') + x.toFixed(1))).join(' ');
  console.log(
    `${tag}   ${cand.file.slice(-26).padEnd(28)} ${(r.offset >= 0 ? '+' : '') + r.offset.toFixed(2)}s  ` +
      `${strip.padEnd(36)} ${worst === null ? '  -  ' : worst.toFixed(1) + 's'}  ${verdict}`
  );
}

console.log(bad.length ? `\n${bad.length} out of sync: ${bad.join(', ')}` : '\nnothing measured as out of sync');
