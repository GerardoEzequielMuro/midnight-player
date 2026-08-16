import { fft, nextPowerOfTwo } from './fft.js';
import { cueVector, FRAME_MS } from './vad.js';

/**
 * Candidate time-scale ratios.
 *
 * A subtitle written for one release can be wrong in two different ways, and
 * they need different fixes. A constant offset means the file starts late or
 * early — different recap, different logo, different trim — and one number
 * fixes the whole episode. Drift means the two are running at different speeds,
 * so a fixed offset that lines up the first line leaves the last line seconds
 * out, and the times have to be *scaled* rather than shifted.
 *
 * Drift comes from PAL speed-up: 24 fps film run at 25 fps plays 4% faster, and
 * the audio is pitched up with it. That is the 25 ÷ 23.976 family below.
 *
 * Worth knowing: 23.976 against 29.97 is NOT in this list on purpose. That
 * conversion is 3:2 pulldown, which repeats fields to fill time rather than
 * changing the clock — an hour of film is still an hour. Since this library is
 * 29.97 NTSC, the useful candidates here are 1.0 and the PAL pair; the 1.001
 * entries cover the NTSC 24 ↔ 23.976 slip.
 */
export const RATIOS = [
  1,
  25 / 23.976,
  23.976 / 25,
  25 / 24,
  24 / 25,
  1.001,
  1 / 1.001,
];

/**
 * Correlate two binary vectors and return the best alignment.
 *
 * Three details decide whether this works or produces confident nonsense:
 *
 * 1. Both vectors are zero-meaned first. Raw binary correlation is maximised by
 *    whatever shift overlaps the most ones, which drags the answer toward
 *    densely-speaking stretches regardless of whether anything actually lines
 *    up. Subtracting the mean removes that pull.
 *
 * 2. The score is divided by the product of the vector norms. Each candidate
 *    ratio resamples the subtitle vector and changes how much "on" time it
 *    contains, so raw peak heights are not comparable between ratios — without
 *    this, the ratio that merely produces the busiest vector wins.
 *
 * 3. Confidence is peak *prominence*, not peak height. A subtitle that matches
 *    nothing still produces its highest value somewhere, and that value can be
 *    respectable. What separates a real alignment is that the peak stands alone:
 *    sharp, and well clear of the next-best shift.
 */
export function correlate(audio, sub, { maxLagFrames, exclusionFrames = 250 }) {
  const n = Math.max(audio.length, sub.length);
  const size = nextPowerOfTwo(n * 2);

  const { re: aRe, im: aIm, norm: aNorm } = prepare(audio, size);
  const { re: bRe, im: bIm, norm: bNorm } = prepare(sub, size);

  fft(aRe, aIm);
  fft(bRe, bIm);

  // Correlation is a convolution with one input conjugated:
  //   r[m] = sum_i audio[i] * sub[i - m]   <->   FFT(audio) * conj(FFT(sub))
  // Zero-padding to twice the length keeps the circular wrap-around of the FFT
  // out of the lag range we actually read.
  for (let i = 0; i < size; i++) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  fft(aRe, aIm, true);

  const denom = aNorm * bNorm || 1;
  const maxLag = Math.min(maxLagFrames, size >> 1);

  let bestLag = 0;
  let bestVal = -Infinity;
  const readAt = (lag) => aRe[lag >= 0 ? lag : size + lag];

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = readAt(lag);
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }

  // Second-best peak, ignoring the neighbourhood of the winner — an adjacent
  // sample is the same peak, not a competing explanation.
  let runnerUp = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) <= exclusionFrames) continue;
    const v = readAt(lag);
    if (v > runnerUp) runnerUp = v;
  }

  const score = bestVal / denom;
  const prominence = runnerUp > 0 ? bestVal / runnerUp : bestVal > 0 ? 4 : 1;

  return { lagFrames: bestLag, score, prominence };
}

/** Zero-mean the real data, then zero-pad. Returns the norm for normalisation. */
function prepare(vec, size) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i];
  const mean = sum / (vec.length || 1);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] - mean;
    re[i] = v;
    sumSq += v * v;
  }
  return { re, im, norm: Math.sqrt(sumSq) };
}

/**
 * Search offset and time-scale together, and report how much to believe it.
 *
 * @returns {{offset:number, ratio:number, score:number, prominence:number,
 *            confidence:number, verdict:string, candidates:Array}}
 */
export function findAlignment(audioVector, cues, { maxOffsetSec = 180 } = {}) {
  if (!cues.length) throw new Error('subtitle track has no cues');
  if (!audioVector.length) throw new Error('no audio to align against');

  const frames = audioVector.length;
  const maxLagFrames = Math.round((maxOffsetSec * 1000) / FRAME_MS);

  const candidates = [];
  for (const ratio of RATIOS) {
    const sub = cueVector(cues, frames, { scale: ratio });
    const r = correlate(audioVector, sub, { maxLagFrames });
    candidates.push({
      ratio,
      offset: (r.lagFrames * FRAME_MS) / 1000,
      score: r.score,
      prominence: r.prominence,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  /*
   * Turning two numbers into one verdict.
   *
   * `score` says how well the shapes match at all; `prominence` says how much
   * better this shift is than every other shift. Both matter, and a failure in
   * either is disqualifying: a high score with no prominence means the track
   * correlates everywhere, which is what a wrong subtitle for a talkative
   * episode looks like.
   *
   * The thresholds are empirical, so the raw numbers are reported alongside the
   * verdict rather than hidden behind it.
   */
  /*
   * The thresholds below are calibrated against tracks whose correct answer was
   * known in advance — the subtitle muxed into each file, which was timed for
   * that exact cut. Those land at prominence 2.1 to 3.1. Alignments later shown
   * to be wrong by an independent brute-force overlap search sat at 1.05 to
   * 1.40. An earlier, looser calibration reported a 51-second error as "good",
   * which is the single worst thing this can do: silently ruin a subtitle that
   * the viewer then has to fix by hand without knowing why.
   *
   * So the bar sits above where wrong answers were observed, and the cost is
   * that some correct alignments are reported as merely uncertain. That is the
   * right trade — an uncertain verdict still shows the number and lets it be
   * applied deliberately.
   */
  const scorePart = clamp01((best.score - 0.13) / 0.13);
  const promPart = clamp01((best.prominence - 1.35) / 0.75);
  const confidence = Math.round(Math.min(scorePart, promPart) * 100) / 100;

  const verdict = confidence >= 0.65 ? 'good' : confidence >= 0.35 ? 'uncertain' : 'poor';

  return {
    offset: Math.round(best.offset * 1000) / 1000,
    ratio: best.ratio,
    score: Math.round(best.score * 1000) / 1000,
    prominence: Math.round(best.prominence * 100) / 100,
    confidence,
    verdict,
    candidates: candidates.map((c) => ({
      ratio: Math.round(c.ratio * 100000) / 100000,
      offset: Math.round(c.offset * 1000) / 1000,
      score: Math.round(c.score * 1000) / 1000,
      prominence: Math.round(c.prominence * 100) / 100,
    })),
  };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
