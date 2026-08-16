import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BIN, run } from './ffmpeg.js';

// Codecs a mainstream browser can decode from an MP4 container.
const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const CONTAINER_OK = new Set(['.mp4', '.m4v', '.webm']);

/**
 * Pick the audio track to play. Preference order:
 *   1. the configured original language (default Japanese) — never auto-select a dub
 *   2. the track the file marks as default
 *   3. the first track
 */
export function pickAudio(media, cfg, requested) {
  const tracks = media?.audio || [];
  if (!tracks.length) return null;
  if (requested != null) {
    const hit = tracks.find((t) => t.index === Number(requested));
    if (hit) return hit;
  }
  const want = (cfg.preferredAudioLang || '').toLowerCase();
  if (want) {
    const byLang = tracks.find((t) => (t.lang || '').toLowerCase().startsWith(want.slice(0, 2)));
    if (byLang) return byLang;
  }
  return tracks.find((t) => t.default) || tracks[0];
}

/** Turn an ffprobe failure into something worth showing in a sidebar. */
function friendlyProbeError(raw) {
  const s = String(raw);
  if (/Read error|Invalid data found|End of file|moov atom not found|Invalid NAL/i.test(s)) {
    return 'unreadable — file looks incomplete (still downloading?)';
  }
  if (/Permission denied|being used by another process/i.test(s)) return 'locked by another program';
  if (/No such file/i.test(s)) return 'file is gone';
  return s.split('\n').filter(Boolean).pop()?.slice(0, 140) || 'could not be read';
}

export function planPlayback(ep, cfg, requestedAudio) {
  const media = ep.media || {};
  if (media.error) return { mode: 'error', reason: friendlyProbeError(media.error) };
  const video = media.video?.[0];
  if (!video) return { mode: 'error', reason: 'no video stream' };

  const audio = pickAudio(media, cfg, requestedAudio);
  const ext = path.extname(ep.path).toLowerCase();

  const videoOk = VIDEO_OK.has(video.codec) || (video.codec === 'hevc' && cfg.assumeHevcSupport);
  const audioOk = !audio || AUDIO_OK.has(audio.codec);
  const containerOk = CONTAINER_OK.has(ext);
  const onlyOneAudio = (media.audio?.length || 0) <= 1;

  // Direct play needs a browser container AND a track layout with nothing to choose:
  // if the file has several audio tracks we still remux, because a plain <video>
  // element cannot reliably switch audio tracks inside one MP4.
  if (containerOk && videoOk && audioOk && onlyOneAudio) {
    return { mode: 'direct', video: video.codec, audio: audio?.codec || null, audioIndex: audio?.index ?? null };
  }

  const mode = !videoOk ? 'transcode' : 'remux';
  return {
    mode,
    video: video.codec,
    audio: audio?.codec || null,
    audioIndex: audio?.index ?? null,
    copyVideo: videoOk,
    copyAudio: audioOk,
    // Why the UI cares: transcode burns CPU, remux is a disk copy.
    reason: !videoOk
      ? `${video.codec} is not playable in the browser — re-encoding video`
      : !audioOk
        ? `${ext.slice(1)} container${audio ? ` and ${audio.codec} audio` : ''} — repacking, audio re-encoded`
        : `${ext.slice(1)} container — repacking without re-encoding`,
  };
}

export function cacheFileFor(cfg, ep, plan) {
  const suffix = [`a${plan.audioIndex ?? 0}`, plan.copyVideo ? null : 'x264'].filter(Boolean).join('-');
  return path.join(cfg.cacheDir, 'remux', `${ep.id}-${suffix}.mp4`);
}

const jobs = new Map(); // outPath -> job state

/**
 * Only one ffmpeg at a time.
 *
 * Remuxing is disk-bound, and the episode you are watching is being read off
 * the same disk. Letting background prefetch jobs run in parallel with playback
 * starves the video: the file is ready but nothing can buffer through the I/O.
 * A queue of one keeps prefetch strictly in the background, and a user-opened
 * episode jumps the queue.
 */
const MAX_CONCURRENT = 1;
const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.state !== 'queued') continue; // cancelled while waiting
    running++;
    startJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

export function jobFor(outPath) {
  return jobs.get(outPath) || null;
}

export function statusFor(cfg, ep, plan) {
  if (plan.mode === 'direct') return { state: 'ready', progress: 1 };
  const out = cacheFileFor(cfg, ep, plan);
  const job = jobs.get(out);
  if (job && (job.state === 'running' || job.state === 'queued')) {
    return { state: job.state, progress: job.progress, queuedAhead: queue.indexOf(job) };
  }
  if (fs.existsSync(out)) return { state: 'ready', progress: 1 };
  if (job && job.state === 'error') return { state: 'error', progress: 0, error: job.error };
  return { state: 'idle', progress: 0 };
}

export function prepare(cfg, ep, plan, { priority = false } = {}) {
  const out = cacheFileFor(cfg, ep, plan);
  const existing = jobs.get(out);
  if (existing && (existing.state === 'running' || existing.state === 'queued')) {
    // Already waiting in line: move it to the front if the user is now watching it.
    if (priority && existing.state === 'queued') {
      const i = queue.indexOf(existing);
      if (i > 0) queue.splice(i, 1), queue.unshift(existing);
    }
    return existing;
  }
  if (fs.existsSync(out)) return { state: 'ready', progress: 1, out };

  const job = { state: 'queued', progress: 0, out, mode: plan.mode, cfg, ep, plan, queuedAt: Date.now() };
  jobs.set(out, job);
  if (priority) queue.unshift(job);
  else queue.push(job);
  pump();
  return job;
}

function startJob(job) {
  const { ep, plan, out } = job;
  job.state = 'running';
  job.startedAt = Date.now();

  const partial = `${out}.part`;
  const duration = ep.media?.duration || 0;

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', ep.path,
    '-map', '0:v:0',
    ...(plan.audioIndex != null ? ['-map', `0:${plan.audioIndex}`] : []),
    '-c:v', ...(plan.copyVideo ? ['copy'] : ['libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
    '-c:a', ...(plan.copyAudio ? ['copy'] : ['aac', '-b:a', '256k']),
    '-sn', '-dn',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    // We write to "<name>.mp4.part" and rename on success, so a half-finished
    // remux can never be served. ffmpeg picks its muxer from the extension,
    // and ".part" means nothing to it — so state the format explicitly.
    '-f', 'mp4',
    partial,
  ];

  let buffered = '';
  job.promise = (async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await run(BIN.ffmpeg, args, {
      onStdout: (chunk) => {
        // -progress emits key=value lines; out_time_us against the known
        // duration is the only reliable percentage ffmpeg gives us.
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k === 'out_time_us' && duration > 0) {
            const secs = Number(v) / 1e6;
            if (Number.isFinite(secs)) job.progress = Math.min(0.999, Math.max(job.progress, secs / duration));
          }
        }
      },
    });
    await fsp.rename(partial, out);
    job.state = 'ready';
    job.progress = 1;
    job.finishedAt = Date.now();
  })().catch(async (err) => {
    job.state = 'error';
    job.error = String(err.message || err).split('\n').slice(-6).join('\n');
    await fsp.rm(partial, { force: true }).catch(() => {});
  });

  return job.promise; // pump() waits on this to release the concurrency slot
}
