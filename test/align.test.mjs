/**
 * Alignment tests against synthetic data, where the correct answer is known
 * because we caused it. Run: node test/align.test.mjs
 *
 * These matter more than the parser tests: a correlation that is subtly wrong
 * still returns a confident-looking number, and there is no way to eyeball it.
 */
import { findAlignment, correlate } from '../server/lib/align/xcorr.js';
import { cueVector, FRAME_MS } from '../server/lib/align/vad.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/** A fake episode: dialogue in irregular bursts, like real speech. */
function makeCues(count, seed = 1) {
  let t = 12;
  let rnd = seed;
  const next = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cues = [];
  for (let i = 0; i < count; i++) {
    const dur = 0.9 + next() * 2.6;
    cues.push({ start: t, end: t + dur, text: 'x' });
    t += dur + 0.35 + next() * 5.5;
  }
  return cues;
}

const DURATION = 1500;
const FRAMES = Math.round((DURATION * 1000) / FRAME_MS);

// The "audio" is the truth: a speech vector built from the real cue times.
const truth = makeCues(300);
const audio = cueVector(truth, FRAMES);

// ---- 1. constant offset ---------------------------------------------------

for (const shift of [-30, -4.5, 2.25, 11, 60]) {
  const shifted = truth.map((c) => ({ ...c, start: c.start - shift, end: c.end - shift }));
  const r = findAlignment(audio, shifted, { maxOffsetSec: 180 });
  const err = Math.abs(r.offset - shift);
  check(
    `constant offset ${String(shift).padStart(6)}s`,
    err <= 0.02 && r.ratio === 1 && r.verdict === 'good',
    `found ${r.offset}s ratio ${r.ratio} conf ${r.confidence} (${r.verdict})`
  );
}

// ---- 2. progressive drift (PAL speed-up) ----------------------------------

for (const [ratio, label] of [[25 / 23.976, 'PAL speed-up'], [23.976 / 25, 'PAL slow-down']]) {
  // The subtitle was authored for a differently-paced release: to recover the
  // truth its times must be multiplied by `ratio`, so build it by dividing.
  const drifted = truth.map((c) => ({ ...c, start: c.start / ratio, end: c.end / ratio }));
  const r = findAlignment(audio, drifted, { maxOffsetSec: 180 });
  const driftAtEnd = Math.abs((truth.at(-1).start) - (drifted.at(-1).start * r.ratio + r.offset));
  check(
    `${label} (ratio ${ratio.toFixed(4)})`,
    Math.abs(r.ratio - ratio) < 0.0005 && driftAtEnd < 1.0,
    `found ratio ${r.ratio.toFixed(5)} offset ${r.offset}s, residual at end ${driftAtEnd.toFixed(2)}s`
  );
}

// ---- 3. drift + offset together -------------------------------------------

{
  const ratio = 25 / 23.976;
  const shift = 8.5;
  const bad = truth.map((c) => ({ ...c, start: (c.start - shift) / ratio, end: (c.end - shift) / ratio }));
  const r = findAlignment(audio, bad, { maxOffsetSec: 180 });
  const endErr = Math.abs(truth.at(-1).start - (bad.at(-1).start * r.ratio + r.offset));
  check(
    'drift and offset combined',
    Math.abs(r.ratio - ratio) < 0.0005 && endErr < 1.0,
    `ratio ${r.ratio.toFixed(5)} offset ${r.offset}s, end error ${endErr.toFixed(2)}s`
  );
}

// ---- 4. the important negative case ---------------------------------------

{
  // Subtitles from a completely different episode. There is no correct answer,
  // so the only acceptable behaviour is to say so rather than invent one.
  const unrelated = makeCues(300, 987654);
  const r = findAlignment(audio, unrelated, { maxOffsetSec: 180 });
  check(
    'unrelated subtitles are reported as unreliable',
    r.verdict !== 'good',
    `conf ${r.confidence} (${r.verdict}) score ${r.score} prominence ${r.prominence}`
  );
}

// ---- 5. tolerance to imperfect speech detection ----------------------------

{
  // Real voice detection is not this clean: it misses quiet lines and fires on
  // music. Degrade the audio vector and check the answer survives.
  const noisy = Uint8Array.from(audio);
  let rnd = 42;
  const next = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < noisy.length; i++) {
    if (noisy[i] === 1 && next() < 0.18) noisy[i] = 0;   // missed speech
    else if (noisy[i] === 0 && next() < 0.06) noisy[i] = 1; // music read as speech
  }
  const shift = 7.25;
  const shifted = truth.map((c) => ({ ...c, start: c.start - shift, end: c.end - shift }));
  const r = findAlignment(noisy, shifted, { maxOffsetSec: 180 });
  check(
    'survives noisy voice detection',
    Math.abs(r.offset - shift) <= 0.05 && r.verdict === 'good',
    `found ${r.offset}s conf ${r.confidence}`
  );
}

// ---- 6. sign convention ---------------------------------------------------

{
  // A subtitle that appears too early needs a positive delay to push it later.
  const early = truth.map((c) => ({ ...c, start: c.start - 5, end: c.end - 5 }));
  const r = findAlignment(audio, early, { maxOffsetSec: 60 });
  check('early subtitles produce a positive offset', r.offset > 0, `offset ${r.offset}s`);

  const late = truth.map((c) => ({ ...c, start: c.start + 5, end: c.end + 5 }));
  const r2 = findAlignment(audio, late, { maxOffsetSec: 60 });
  check('late subtitles produce a negative offset', r2.offset < 0, `offset ${r2.offset}s`);
}

// ---- 7. correlation identity sanity ---------------------------------------

{
  const a = new Uint8Array(1000);
  const b = new Uint8Array(1000);
  for (let i = 100; i < 140; i++) a[i] = 1;
  for (let i = 130; i < 170; i++) b[i] = 1; // b is 30 frames later than a
  const r = correlate(a, b, { maxLagFrames: 400, exclusionFrames: 50 });
  check('correlation recovers a known lag', r.lagFrames === -30, `lag ${r.lagFrames} (expected -30)`);
}

console.log(failures ? `\n${failures} FAILING` : '\nall alignment tests pass');
process.exit(failures ? 1 : 0);
