/**
 * Threshold tuning, measured rather than guessed.
 *
 * The subtitle track embedded in each MKV was authored for that exact file, so
 * its correct alignment is known in advance: zero offset, no scaling. That makes
 * it usable as ground truth — a voice-detection setting is better if aligning
 * the embedded track lands closer to zero with a stronger, more isolated peak.
 *
 * Run: node test/tune-vad.mjs
 */
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { cachedEnergies, threshold, cueVector, FRAME_MS } from '../server/lib/align/vad.js';
import { findAlignment } from '../server/lib/align/xcorr.js';
import { extractEmbedded } from '../server/lib/subtitles/extract.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

const usable = episodes.filter((e) => !e.media?.error && e.media?.subtitles?.length).slice(0, 4);
console.log(`Ground truth: embedded tracks of ${usable.length} episodes\n`);

const SETTINGS = [
  { label: 'global threshold (original)', global: true },
  { label: 'local floor, target 55%', targetMax: 0.55 },
  { label: 'local floor, target 45%', targetMax: 0.45 },
  { label: 'local floor, target 35%', targetMax: 0.35 },
  { label: 'local floor, target 28%', targetMax: 0.28 },
  { label: 'local floor 3s blocks, 35%', targetMax: 0.35, blockFrames: 300 },
  { label: 'local floor 10s blocks, 35%', targetMax: 0.35, blockFrames: 1000 },
];

const prepared = [];
for (const ep of usable) {
  const energies = await cachedEnergies(cfg, ep);
  const idx = ep.media.subtitles[0].index;
  const file = await extractEmbedded(cfg, ep, idx);
  const { cues } = await loadSubtitle(file);
  prepared.push({ ep, energies, cues });
  process.stdout.write(`\r  prepared ${prepared.length}/${usable.length}   `);
}
console.log('\n');

console.log('setting                       speech%   |offset| err   score   prominence   verdicts');
for (const setting of SETTINGS) {
  const rows = [];
  for (const { energies, cues } of prepared) {
    const vec = setting.global ? globalThreshold(energies) : threshold(energies, setting);
    const speechPct = vec.reduce((n, v) => n + v, 0) / vec.length;
    const r = findAlignment(vec, cues, { maxOffsetSec: 120 });
    rows.push({ speechPct, err: Math.abs(r.offset), score: r.score, prom: r.prominence, verdict: r.verdict });
  }
  const avg = (k) => rows.reduce((n, r) => n + r[k], 0) / rows.length;
  const good = rows.filter((r) => r.verdict === 'good').length;
  console.log(
    `${setting.label.padEnd(29)} ${(avg('speechPct') * 100).toFixed(0).padStart(5)}%   ` +
      `${avg('err').toFixed(2).padStart(9)}s   ${avg('score').toFixed(3)}   ` +
      `${avg('prom').toFixed(2).padStart(8)}     ${good}/${rows.length} good`
  );
}

/** The first attempt: one threshold for the whole episode. */
function globalThreshold(energies) {
  const sorted = Float64Array.from(energies).sort();
  const at = (p) => sorted[Math.floor(p * sorted.length)];
  const cut = at(0.15) + 0.35 * (at(0.95) - at(0.15));
  const v = new Uint8Array(energies.length);
  for (let i = 0; i < energies.length; i++) v[i] = energies[i] > cut ? 1 : 0;
  return v;
}
