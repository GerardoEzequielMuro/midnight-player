/**
 * Rewrap MKV episodes as MP4 so a browser can open them.
 *
 *   node tools/tomp4.mjs            # report what it would do
 *   node tools/tomp4.mjs --write
 *
 * The streams inside these files are already h264 and aac — exactly what every
 * browser plays. Only the container is the problem: Chrome will not open
 * Matroska. So this copies the streams across untouched (`-c copy`) rather than
 * re-encoding: no quality is lost and it runs at disk speed.
 *
 * Nothing is deleted. The MKV stays where it is, and the MP4 appears beside it.
 *
 * The English subtitle track muxed into each MKV is written out as a sidecar
 * .srt first. MP4 has no good home for it, and more importantly that track is
 * the timing reference the translator works from — dropping it would strand
 * every episode that has not been translated yet.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { probe, summarizeProbe } from '../server/lib/ffmpeg.js';
import { BIN, run as ffrun } from '../server/lib/ffmpeg.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

const run = (a) => ffrun(BIN.ffmpeg, a);

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
const mkvs = episodes
  .filter((e) => /\.mkv$/i.test(e.path) && !e.media?.error)
  .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

console.log(`${mkvs.length} MKV episodes to rewrap\n`);
let done = 0;

for (const ep of mkvs) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  const out = ep.path.replace(/\.mkv$/i, '.mp4');
  const base = path.basename(ep.path, path.extname(ep.path));
  const subOut = path.join(path.dirname(ep.path), `${base}.en.srt`);

  if (fssync.existsSync(out)) { console.log(`${tag}  mp4 already there — skipped`); continue; }
  if (!WRITE) { console.log(`${tag}  would write ${path.basename(out)}`); continue; }

  // Save the embedded reference before the container that holds it stops being
  // the one in use.
  const text = (ep.media?.subtitles ?? []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  if (text.length && !fssync.existsSync(subOut)) {
    try {
      await fs.copyFile(await extractEmbedded(cfg, ep, text[0].index), subOut);
    } catch (err) {
      console.log(`${tag}  could not save the embedded track: ${err.message.slice(0, 80)}`);
    }
  }

  // Written to a temp name first: an interrupted run must not leave a truncated
  // mp4 sitting there looking like a finished episode.
  const tmp = `${out}.part`;
  try {
    await run([
      '-v', 'error', '-y', '-i', ep.path,
      '-map', '0:v:0', '-map', '0:a', '-c', 'copy',
      // Subtitle streams are dropped deliberately; they are sidecars now.
      '-sn',
      // Without this the index sits at the end of the file and the browser has
      // to fetch the whole thing before it can play or seek.
      '-movflags', '+faststart',
      '-f', 'mp4', tmp,
    ]);
    await fs.rename(tmp, out);
    const size = (await fs.stat(out)).size;
    /*
     * Duration is checked against the video and audio streams, not the
     * container header. An MKV reports the longest of all its streams, and the
     * embedded subtitle track here runs past the last frame — the closing
     * credits outlast the picture. Comparing headers therefore made five
     * perfectly good remuxes look five seconds short.
     */
    const before = summarizeProbe(await probe(ep.path));
    const after = summarizeProbe(await probe(out));
    const mediaEnd = (p) => Math.max(p.video?.[0]?.duration ?? 0, p.audio?.[0]?.duration ?? 0, 0);
    const drift = Math.abs(mediaEnd(after) - mediaEnd(before));
    done++;
    console.log(
      `${tag}  ${path.basename(out)}  ${(size / 1e6).toFixed(0)} MB` +
        (drift > 1 ? `  WARNING: media is ${drift.toFixed(1)}s different` : '')
    );
  } catch (err) {
    await fs.rm(tmp, { force: true });
    console.log(`${tag}  FAILED: ${err.message.slice(0, 160)}`);
  }
}

console.log(WRITE ? `\n${done} rewrapped. The .mkv originals are untouched.` : '\ndry run — add --write');
