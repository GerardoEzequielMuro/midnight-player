/**
 * Independent check on the alignment, by brute force.
 *
 * The FFT search finds a peak; this does not use it. For every offset in a wide
 * range it measures how much the two cue patterns actually overlap
 * (intersection over union) and reports the best. It is far too slow to ship,
 * which is the point — it is a second opinion computed a different way.
 *
 * Ground truth is the subtitle track muxed into the file, which was timed
 * against this exact cut.
 *
 * Run: node test/verify-offsets.mjs
 */
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { cueVector, FRAME_MS } from '../server/lib/align/vad.js';
import { extractEmbedded } from '../server/lib/subtitles/extract.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

const usable = episodes.filter((e) => !e.media?.error && e.media?.subtitles?.length && e.subs.length);

function overlapAt(refVec, cues, frames, offsetSec) {
  const v = cueVector(cues, frames, { offsetSec });
  let inter = 0;
  let union = 0;
  for (let i = 0; i < frames; i++) {
    const a = refVec[i];
    const b = v[i];
    if (a && b) inter++;
    if (a || b) union++;
  }
  return union ? inter / union : 0;
}

console.log('Brute-force best offset of each Spanish track against the track inside the video\n');
console.log('ep       best offset   overlap   overlap at +5s   second-best peak');

const results = [];
for (const ep of usable) {
  const refFile = await extractEmbedded(cfg, ep, ep.media.subtitles[0].index);
  const ref = (await loadSubtitle(refFile)).cues;
  const target = (await loadSubtitle(ep.subs[0].path)).cues;

  const frames = Math.round(((ep.media.duration || 1500) * 1000) / FRAME_MS);
  const refVec = cueVector(ref, frames);

  let best = { offset: 0, iou: -1 };
  const curve = [];
  for (let off = -70; off <= 70; off += 0.1) {
    const iou = overlapAt(refVec, target, frames, off);
    curve.push({ off, iou });
    if (iou > best.iou) best = { offset: Math.round(off * 100) / 100, iou };
  }

  // Best peak at least 3s away from the winner, to see if it was a close call.
  let second = { offset: 0, iou: -1 };
  for (const p of curve) {
    if (Math.abs(p.off - best.offset) < 3) continue;
    if (p.iou > second.iou) second = { offset: Math.round(p.off * 100) / 100, iou: p.iou };
  }

  const atFive = overlapAt(refVec, target, frames, 5);
  results.push({ ep, best, second, atFive });
  console.log(
    ` S0${ep.season}E${String(ep.episode).padStart(2, '0')}  ${String(best.offset).padStart(8)}s   ` +
      `${best.iou.toFixed(3)}     ${atFive.toFixed(3)}            ${String(second.offset).padStart(7)}s ${second.iou.toFixed(3)}`
  );
}

const clean = results.filter((r) => r.best.iou > 0.35);
console.log(`\n${clean.length}/${results.length} tracks have a clear match (overlap > 0.35)`);
if (clean.length) {
  const offs = clean.map((r) => r.best.offset).sort((a, b) => a - b);
  console.log(`offsets of the clear matches: ${offs.join(', ')}`);
}
