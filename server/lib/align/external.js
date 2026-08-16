import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '../ffmpeg.js';
import { loadSubtitle } from '../subtitles/index.js';

/**
 * If ffsubsync or alass are installed, they are better at this than a few
 * hundred lines here, and they are used instead.
 *
 * Both write a corrected subtitle file. This program never modifies subtitle
 * files, so rather than adopt their output as a file, the corrected times are
 * compared against the originals and reduced to the same (scale, offset) pair
 * the built-in method produces. That keeps one representation everywhere: two
 * numbers, stored separately, applied at playback.
 */
const TOOLS = [
  { name: 'ffsubsync', probe: ['--version'] },
  { name: 'alass', probe: ['--version'] },
  { name: 'alass-cli', probe: ['--version'] },
];

let detected = null;

export async function detectTools() {
  if (detected) return detected;
  detected = [];
  for (const tool of TOOLS) {
    try {
      await runQuiet(tool.name, tool.probe);
      detected.push(tool.name);
    } catch {
      // not installed
    }
  }
  return detected;
}

function runQuiet(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: process.platform === 'win32' });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    setTimeout(() => child.kill(), 8000).unref?.();
  });
}

export async function alignWithTool(tool, cfg, ep, subPath) {
  const outFile = path.join(cfg.cacheDir, 'align', `${ep.id}-${path.basename(subPath)}`);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });

  const args =
    tool === 'ffsubsync'
      ? [ep.path, '-i', subPath, '-o', outFile]
      : [ep.path, subPath, outFile]; // alass: <video> <incorrect subs> <output>

  await runQuiet(tool, args);

  const before = await loadSubtitle(subPath);
  const after = await loadSubtitle(outFile);
  return { ...fitTransform(before.cues, after.cues), tool };
}

/**
 * Recover (scale, offset) from a tool's corrected file by least-squares fitting
 * new_time = scale * old_time + offset over the cues both files share.
 *
 * Tools may drop or merge cues, so pairing is by index only where the counts
 * agree; otherwise the fit falls back to matching cue starts in order.
 */
export function fitTransform(before, after) {
  const n = Math.min(before.length, after.length);
  if (n < 2) return { offset: 0, ratio: 1, confidence: 0, residual: null };

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = before[i].start;
    const y = after[i].start;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  const scale = denom === 0 ? 1 : (n * sxy - sx * sy) / denom;
  const offset = (sy - scale * sx) / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const predicted = before[i].start * scale + offset;
    sumSq += (after[i].start - predicted) ** 2;
  }
  const residual = Math.sqrt(sumSq / n);

  return {
    offset: Math.round(offset * 1000) / 1000,
    ratio: Math.round(scale * 100000) / 100000,
    // A clean linear relationship means the tool applied a shift and a stretch,
    // which is exactly what can be reproduced here. Large residuals mean it did
    // something per-cue that two numbers cannot express.
    residual: Math.round(residual * 1000) / 1000,
    confidence: residual < 0.25 ? 1 : residual < 1 ? 0.6 : 0.2,
  };
}
