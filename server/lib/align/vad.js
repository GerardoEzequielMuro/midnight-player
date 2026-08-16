import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN } from '../ffmpeg.js';

export const FRAME_MS = 10;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160

/**
 * Turn the episode's audio into a binary "is someone speaking" vector, one
 * value per 10 ms.
 *
 * `node-vad` would have been the obvious dependency, but it is a native
 * node-gyp module with no prebuilt binaries for current Node, so it fails to
 * install. Energy in the speech band is the classic alternative and is enough
 * here: the goal is not to transcribe anything, only to find where speech
 * starts and stops, and correlation cares about the shape of that pattern
 * rather than its accuracy on any individual frame.
 *
 * The band-pass is done by ffmpeg rather than in JavaScript — it is C, it is
 * already in the pipeline, and it keeps this file down to the decision logic.
 */
export async function speechVector(cfg, ep, { onProgress, ...opts } = {}) {
  const energies = await cachedEnergies(cfg, ep, onProgress);
  return threshold(energies, opts);
}

/**
 * The frame energies are cached, not the speech/silence decision.
 *
 * Decoding the audio is the slow part by a wide margin; turning energies into a
 * yes/no vector is microseconds. Caching the earlier stage means the threshold
 * can be changed — or tuned against a track known to be correct — without
 * decoding anything again, and aligning a second track for the same episode is
 * effectively free.
 */
export async function cachedEnergies(cfg, ep, onProgress) {
  const cacheFile = path.join(cfg.cacheDir, 'vad', `${ep.id}.f32`);
  try {
    const cached = await fsp.readFile(cacheFile);
    return new Float32Array(cached.buffer, cached.byteOffset, cached.length / 4);
  } catch {
    // not cached yet
  }

  const energies = await frameEnergies(ep.path, onProgress);
  const asF32 = Float32Array.from(energies);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, Buffer.from(asF32.buffer));
  return asF32;
}

/** Root-mean-square energy per 10 ms frame, in dB. */
function frameEnergies(file, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      BIN.ffmpeg,
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', file,
        '-vn',
        // Telephone band: enough of the voice to find it, without the music and
        // rumble that would otherwise read as speech.
        '-af', 'highpass=f=300,lowpass=f=3400',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 's16le',
        '-',
      ],
      { windowsHide: true }
    );

    const out = [];
    let leftover = Buffer.alloc(0);
    let sumSq = 0;
    let count = 0;
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sumSq += s * s;
        count++;
        if (count === FRAME_SAMPLES) {
          // dB, floored so silence doesn't become -Infinity.
          out.push(10 * Math.log10(Math.max(sumSq / FRAME_SAMPLES, 1e-10)));
          sumSq = 0;
          count = 0;
          if (onProgress && out.length % 6000 === 0) onProgress(out.length * FRAME_MS / 1000);
        }
      }
      leftover = buf.subarray(usable);
    });

    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`audio extraction failed: ${stderr || code}`));
      resolve(Float64Array.from(out));
    });
  });
}

/**
 * Decide speech/silence from the energy curve.
 *
 * A fixed dB threshold is useless across releases — one episode is mastered
 * quietly, the next loudly. So the threshold is derived from this episode's own
 * distribution: the quiet end is its noise floor, the loud end is its speech
 * level, and the line is drawn between them.
 */
export function threshold(energies, { blockFrames = 500, floorPct = 0.2, deltas = [4, 5, 6, 7, 8, 10, 12, 15], targetMax = 0.35 } = {}) {
  /*
   * The threshold follows a *local* noise floor rather than one level for the
   * whole episode.
   *
   * A single global threshold was the first attempt and it marked 73% of this
   * show as speech, because the scenes run over constant kitchen ambience and
   * music that sit well above the quietest moments of the episode. A vector
   * that is almost entirely ones carries no shape, and correlation has nothing
   * to lock onto — the alignment came back "uncertain" even for a subtitle
   * known to be correct.
   *
   * Speech is a transient *above* whatever the background happens to be in that
   * scene, so the floor is measured per five-second block and interpolated
   * between blocks. Loud ambience raises the local floor with it instead of
   * swamping the decision.
   */
  const background = localFloor(energies, blockFrames, floorPct);

  /*
   * How far above the local floor counts as speech is then chosen by result:
   * take the smallest margin that keeps speech under a plausible share of the
   * runtime. Dialogue-led television runs roughly 30-45% speech, so a setting
   * that claims much more is measuring the room, not the actors.
   */
  const raw = new Uint8Array(energies.length);
  let chosen = deltas[deltas.length - 1];
  for (const delta of deltas) {
    let on = 0;
    for (let i = 0; i < energies.length; i++) if (energies[i] > background[i] + delta) on++;
    if (on / energies.length <= targetMax) {
      chosen = delta;
      break;
    }
  }
  for (let i = 0; i < energies.length; i++) raw[i] = energies[i] > background[i] + chosen ? 1 : 0;

  // Speech is continuous; single frames either way are noise in the decision,
  // not in the audio. Close gaps shorter than 150 ms, then drop bursts shorter
  // than 100 ms — in that order, so a burst broken by one quiet frame is
  // joined before being judged on length.
  fillRuns(raw, 0, 15);
  fillRuns(raw, 1, 10);
  return raw;
}

/**
 * Noise floor over time: a low percentile of each block, linearly interpolated
 * between block centres so the floor moves smoothly instead of stepping at
 * block boundaries.
 */
function localFloor(energies, blockFrames, pct) {
  const blocks = Math.max(1, Math.ceil(energies.length / blockFrames));
  const levels = new Float64Array(blocks);

  for (let b = 0; b < blocks; b++) {
    const from = b * blockFrames;
    const slice = Float64Array.from(energies.subarray(from, Math.min(from + blockFrames, energies.length))).sort();
    levels[b] = slice[Math.min(slice.length - 1, Math.floor(pct * slice.length))];
  }

  const out = new Float64Array(energies.length);
  for (let i = 0; i < energies.length; i++) {
    const pos = i / blockFrames - 0.5; // block centres sit half a block in
    const b0 = Math.max(0, Math.min(blocks - 1, Math.floor(pos)));
    const b1 = Math.max(0, Math.min(blocks - 1, b0 + 1));
    const t = Math.max(0, Math.min(1, pos - b0));
    out[i] = levels[b0] * (1 - t) + levels[b1] * t;
  }
  return out;
}

/** Flip runs of `value` shorter than `minLen` to the opposite value. */
function fillRuns(vec, value, minLen) {
  let start = -1;
  for (let i = 0; i <= vec.length; i++) {
    const isValue = i < vec.length && vec[i] === value;
    if (isValue && start === -1) start = i;
    else if (!isValue && start !== -1) {
      if (i - start < minLen && start > 0 && i < vec.length) {
        for (let j = start; j < i; j++) vec[j] = value ? 0 : 1;
      }
      start = -1;
    }
  }
}

/** The same binary shape, built from subtitle cue times instead of audio. */
export function cueVector(cues, frames, { scale = 1, offsetSec = 0 } = {}) {
  const vec = new Uint8Array(frames);
  for (const cue of cues) {
    const from = Math.round((cue.start * scale + offsetSec) * 1000 / FRAME_MS);
    const to = Math.round((cue.end * scale + offsetSec) * 1000 / FRAME_MS);
    for (let i = Math.max(0, from); i < Math.min(frames, to); i++) vec[i] = 1;
  }
  return vec;
}

/** Whether the slow step — decoding the audio — has already been done. */
export function hasCachedVector(cfg, ep) {
  return fs.existsSync(path.join(cfg.cacheDir, 'vad', `${ep.id}.f32`));
}
