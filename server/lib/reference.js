import path from 'node:path';
import { extractEmbedded, embeddedTrackKind } from './subtitles/extract.js';

/**
 * Find the subtitle track that is known to be correctly timed for a video.
 *
 * Everything that fixes timing needs this: it is the one track authored against
 * this exact cut, so it is the truth other tracks are measured and corrected
 * against.
 *
 * Three places it can live, in order of confidence:
 *
 *   1. A text track muxed into the file. Unambiguous — it shipped inside it.
 *   2. A sidecar named exactly like the video. The usual convention.
 *   3. A sidecar named after the video plus a language tag. This is what
 *      rewrapping produces: MP4 has no good home for a subtitle track, so the
 *      embedded one is written out as "<video>.en.srt" and the video keeps only
 *      picture and sound. Without this case every rewrapped episode silently
 *      loses its reference, which is exactly what happened.
 */
export async function findReference(cfg, ep) {
  const embedded = (ep.media?.subtitles ?? []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  if (embedded.length) {
    return { path: await extractEmbedded(cfg, ep, embedded[0].index), kind: 'embedded' };
  }

  const dir = path.dirname(ep.path).toLowerCase();
  const base = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const beside = ep.subs.filter((s) => path.dirname(s.path).toLowerCase() === dir);

  const exact = beside.find((s) => path.basename(s.path, path.extname(s.path)).toLowerCase() === base);
  if (exact) return { path: exact.path, kind: 'sidecar' };

  // "<video>.en.srt" and friends. Restricted to a known language suffix so a
  // translation sitting beside the video is never mistaken for the reference.
  const tagged = beside.find((s) =>
    /^(en|eng|english)$/i.test(path.basename(s.path, path.extname(s.path)).slice(base.length + 1))
  );
  if (tagged) return { path: tagged.path, kind: 'sidecar (language-tagged)' };

  return null;
}
