/**
 * Check every episode's subtitles properly, and say where they are wrong.
 *
 *   node tools/diagnose.mjs
 *   node tools/diagnose.mjs --lang eng
 *
 * A single overall score hides the faults that actually annoy you. A track can
 * be perfect for twenty minutes and drift at the end, or line up throughout but
 * stop before the episode does. So this measures each third of the runtime
 * separately, and checks coverage and cue sanity on top.
 *
 * Every episode is compared against a track known to be correctly timed for it:
 * the one muxed into the file, or the one shipped beside it.
 */
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';
import { cueVector, FRAME_MS } from '../server/lib/align/vad.js';

const args = process.argv.slice(2);
const langIdx = args.indexOf('--lang');
const WANT = langIdx >= 0 ? args[langIdx + 1] : 'spa';

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

/** Overlap of two cue lists over a time slice, as intersection over union. */
function overlap(a, b, from, to) {
  const frames = Math.round(((to - from) * 1000) / FRAME_MS);
  if (frames <= 0) return 0;
  const shift = (cues) => cues.map((c) => ({ ...c, start: c.start - from, end: c.end - from }));
  const A = cueVector(shift(a), frames);
  const B = cueVector(shift(b), frames);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < frames; i++) {
    if (A[i] && B[i]) inter++;
    if (A[i] || B[i]) union++;
  }
  return union ? inter / union : 1;
}

const rows = [];

for (const ep of episodes) {
  if (ep.media?.error) continue;
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;

  const embedded = (ep.media?.subtitles || []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  const videoBase = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const sidecar = ep.subs.find(
    (s) => path.basename(s.path, path.extname(s.path)).toLowerCase() === videoBase
  );
  if (!embedded.length && !sidecar) continue;

  const referenceFile = embedded.length ? await extractEmbedded(cfg, ep, embedded[0].index) : sidecar.path;
  const reference = await loadSubtitle(referenceFile);

  // What the player will actually show: prefer the retimed track.
  const candidates = ep.subs.filter((s) => s.lang === WANT);
  const track = candidates.find((s) => /\.retimed\./i.test(s.file)) || candidates[0];
  if (!track) continue;
  const subtitle = await loadSubtitle(track.path);

  const duration = ep.media?.duration || reference.duration || 1500;
  const third = duration / 3;

  const parts = [
    overlap(reference.cues, subtitle.cues, 0, third),
    overlap(reference.cues, subtitle.cues, third, third * 2),
    overlap(reference.cues, subtitle.cues, third * 2, duration),
  ];

  const refEnd = reference.cues.length ? reference.cues[reference.cues.length - 1].end : 0;
  const subEnd = subtitle.cues.length ? subtitle.cues[subtitle.cues.length - 1].end : 0;
  const subStart = subtitle.cues.length ? subtitle.cues[0].start : 0;

  // Sanity checks on the cues themselves.
  let negative = 0;
  let outOfOrder = 0;
  let tooLong = 0;
  for (let i = 0; i < subtitle.cues.length; i++) {
    const c = subtitle.cues[i];
    if (c.start < 0) negative++;
    if (i && c.start < subtitle.cues[i - 1].start) outOfOrder++;
    if (c.end - c.start > 20) tooLong++;
  }

  // The largest stretch with no subtitle at all, where the reference has some.
  let biggestGap = 0;
  let gapAt = 0;
  for (let i = 1; i < subtitle.cues.length; i++) {
    const gap = subtitle.cues[i].start - subtitle.cues[i - 1].end;
    if (gap > biggestGap) {
      const mid = (subtitle.cues[i - 1].end + subtitle.cues[i].start) / 2;
      if (reference.cues.some((c) => c.start > mid - 30 && c.start < mid + 30)) {
        biggestGap = gap;
        gapAt = subtitle.cues[i - 1].end;
      }
    }
  }

  rows.push({
    tag, parts, refEnd, subEnd, subStart,
    endsEarly: refEnd - subEnd,
    cues: subtitle.cueCount,
    refCues: reference.cueCount,
    negative, outOfOrder, tooLong, biggestGap, gapAt,
    retimed: /\.retimed\./i.test(track.file),
  });
}

const t = (n) => n.toFixed(2);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

console.log('        overlap by third      cues        ends      biggest');
console.log('ep      start  mid    end     sub/ref     early     silence');
for (const r of rows) {
  const worst = Math.min(...r.parts);
  const flag = worst < 0.35 ? ' <-- BAD' : worst < 0.5 ? ' <-- weak' : '';
  console.log(
    `${r.tag}   ${t(r.parts[0])}   ${t(r.parts[1])}   ${t(r.parts[2])}   ` +
      `${String(r.cues).padStart(3)}/${String(r.refCues).padEnd(3)}   ` +
      `${(r.endsEarly > 5 ? mmss(r.endsEarly) : '-').padStart(6)}   ` +
      `${(r.biggestGap > 45 ? `${Math.round(r.biggestGap)}s @${mmss(r.gapAt)}` : '-').padStart(12)}${flag}`
  );
}

const bad = rows.filter((r) => Math.min(...r.parts) < 0.35);
const weak = rows.filter((r) => Math.min(...r.parts) >= 0.35 && Math.min(...r.parts) < 0.5);
const early = rows.filter((r) => r.endsEarly > 60);
const broken = rows.filter((r) => r.negative || r.outOfOrder || r.tooLong > 5);

console.log(`\n${rows.length} episodes checked`);
console.log(`  ${bad.length} bad:  ${bad.map((r) => r.tag).join(', ') || 'none'}`);
console.log(`  ${weak.length} weak: ${weak.map((r) => r.tag).join(', ') || 'none'}`);
console.log(`  ${early.length} stop more than a minute before the dialogue does: ${early.map((r) => r.tag).join(', ') || 'none'}`);
console.log(`  ${broken.length} with malformed cues: ${broken.map((r) => `${r.tag}(${r.negative}neg ${r.outOfOrder}ooo ${r.tooLong}long)`).join(', ') || 'none'}`);
