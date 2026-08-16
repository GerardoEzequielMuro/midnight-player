import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BIN, run } from '../ffmpeg.js';

/**
 * Subtitles inside a Matroska file are not text on a timeline the browser can
 * read — they have to be pulled out with ffmpeg first.
 *
 * Two families exist and they are not interchangeable:
 *
 *  - Text (SubRip, ASS/SSA, mov_text, WebVTT). Extractable, and what this does.
 *  - Bitmap (PGS on Blu-ray, VobSub on DVD, DVB). These are *pictures* of text,
 *    one image per cue. Turning them into text needs OCR, which is a different
 *    program, a language model per language, and a proofreading pass. There is
 *    no honest way to extract them here, so they are reported as such rather
 *    than failing with something cryptic.
 */
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'text', 'mov_text', 'webvtt', 'microdvd']);
const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);

export function embeddedTrackKind(codec) {
  if (TEXT_CODECS.has(codec)) return 'text';
  if (BITMAP_CODECS.has(codec)) return 'bitmap';
  return 'unknown';
}

const inFlight = new Map(); // outPath -> Promise, so a double click extracts once

export async function extractEmbedded(cfg, ep, streamIndex) {
  const track = (ep.media?.subtitles || []).find((s) => s.index === Number(streamIndex));
  if (!track) throw new Error(`no subtitle track at stream ${streamIndex}`);

  const kind = embeddedTrackKind(track.codec);
  if (kind === 'bitmap') {
    throw Object.assign(
      new Error(`${track.codec} is an image-based subtitle track — it contains pictures of text, not text, so it can only be read with OCR`),
      { code: 'BITMAP' }
    );
  }
  if (kind === 'unknown') {
    throw new Error(`unsupported embedded subtitle codec: ${track.codec}`);
  }

  // ASS keeps its own extension so the styling survives the round trip;
  // everything else is normalised to SubRip on the way out.
  const keepAss = track.codec === 'ass' || track.codec === 'ssa';
  const ext = keepAss ? 'ass' : 'srt';
  const out = path.join(cfg.cacheDir, 'subs', `${ep.id}-s${streamIndex}.${ext}`);

  if (fs.existsSync(out)) return out;
  if (inFlight.has(out)) return inFlight.get(out);

  const job = (async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const partial = `${out}.part`;
    await run(BIN.ffmpeg, [
      '-hide_banner', '-nostdin', '-y',
      '-i', ep.path,
      '-map', `0:${streamIndex}`,
      '-c:s', keepAss ? 'copy' : 'srt',
      '-f', keepAss ? 'ass' : 'srt',
      partial,
    ]);
    await fsp.rename(partial, out);
    return out;
  })().finally(() => inFlight.delete(out));

  inFlight.set(out, job);
  return job;
}
