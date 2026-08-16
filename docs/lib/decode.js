/**
 * Text out of a subtitle file, without the npm encoding detector the server
 * build uses.
 *
 * A byte order mark is authoritative, so it decides first and is then dropped —
 * left in place it becomes a zero-width character at the head of the first cue.
 * With no mark, UTF-8 is tried in fatal mode: valid UTF-8 is not a thing that
 * happens by accident, so a clean decode is the answer. When it throws, the
 * file is one of the old single-byte encodings and windows-1252 is the one that
 * covers the Western European subtitles this player is likely to meet. It maps
 * every byte, so it cannot fail — the worst case is a wrong accent, not a
 * broken file.
 */
export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export async function readTextFile(file) {
  return decodeText(await file.arrayBuffer());
}
