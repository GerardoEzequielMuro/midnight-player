import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveBinaries() {
  let ffmpeg = null;
  let ffprobe = null;
  try {
    ffmpeg = require('ffmpeg-static');
  } catch {}
  try {
    ffprobe = require('ffprobe-static').path;
  } catch {}
  return { ffmpeg, ffprobe };
}

export const BIN = resolveBinaries();

/**
 * ffmpeg-static downloads its binary from an install script. npm 11 blocks
 * install scripts by default, so `npm install` can succeed while leaving no
 * ffmpeg on disk. Fail loudly at boot with the fix instead of at first play.
 */
export function checkBinaries() {
  const missing = [];
  if (!BIN.ffmpeg || !fs.existsSync(BIN.ffmpeg)) missing.push('ffmpeg');
  if (!BIN.ffprobe || !fs.existsSync(BIN.ffprobe)) missing.push('ffprobe');
  if (!missing.length) return null;
  return (
    `Missing ${missing.join(' and ')}.\n` +
    `  npm blocks package install scripts by default, so the binary was never downloaded.\n` +
    `  Fix with:  npm run setup\n` +
    `  (or: npm approve-scripts --allow-scripts-pending)`
  );
}

export function run(bin, args, { onStdout, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onStdout) onStdout(s);
      else out += s;
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      if (onStderr) onStderr(s);
      // Keep only the tail: ffmpeg is chatty and errors live at the end.
      err = (err + s).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(Object.assign(new Error(`${bin} exited ${code}\n${err}`), { code, stderr: err }));
    });
  });
}

export async function probe(file) {
  const { stdout } = await run(BIN.ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(stdout);
}

/** Reduce a raw ffprobe dump to the handful of fields the app actually uses. */
export function summarizeProbe(raw) {
  const streams = raw.streams || [];
  const pick = (type) => streams.filter((s) => s.codec_type === type);
  const lang = (s) => s.tags?.language || s.tags?.LANGUAGE || null;
  const title = (s) => s.tags?.title || s.tags?.TITLE || null;

  const video = pick('video').filter((s) => s.disposition?.attached_pic !== 1);
  return {
    duration: Number(raw.format?.duration) || null,
    formatName: raw.format?.format_name || null,
    size: Number(raw.format?.size) || null,
    video: video.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: parseFps(s.r_frame_rate),
      pixFmt: s.pix_fmt,
    })),
    audio: pick('audio').map((s) => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels,
      lang: lang(s),
      title: title(s),
      default: s.disposition?.default === 1,
    })),
    subtitles: pick('subtitle').map((s) => ({
      index: s.index,
      codec: s.codec_name,
      lang: lang(s),
      title: title(s),
      forced: s.disposition?.forced === 1,
      default: s.disposition?.default === 1,
    })),
  };
}

function parseFps(r) {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!d) return null;
  return Math.round((n / d) * 1000) / 1000;
}
