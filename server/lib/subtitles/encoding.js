import iconv from 'iconv-lite';
import jschardet from 'jschardet';

/**
 * Subtitle files carry no encoding declaration, and plenty of them are not
 * UTF-8. Reading a Windows-1252 file as UTF-8 is what turns accented characters
 * into garbage, so the encoding has to be worked out before parsing.
 *
 * Order matters: a byte-order mark is a fact, valid UTF-8 is near-certain
 * (arbitrary 8-bit text almost never happens to be valid multi-byte UTF-8),
 * and statistical detection is the last resort because it is a guess.
 */
export function decodeSubtitle(buf, { fallbackLatin = 'windows-1252' } = {}) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8', source: 'bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16le'), encoding: 'utf-16le', source: 'bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16be'), encoding: 'utf-16be', source: 'bom' };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8', source: 'validated' };
  } catch {
    // Not valid UTF-8 — fall through to detection.
  }

  let guess = null;
  let ranked = [];
  try {
    guess = jschardet.detect(buf);
    ranked = typeof jschardet.detectAll === 'function' ? jschardet.detectAll(buf) : [];
  } catch {}

  let candidate = normalizeEncodingName(guess?.encoding);

  /**
   * Break ties inside the single-byte Latin family in favour of Windows-1252.
   *
   * These encodings are identical below 0x80 and differ only in the high range,
   * so the detector separates them on letter-frequency statistics that need far
   * more text than a subtitle file provides. On a real file it reported
   * ISO-8859-2 at 0.95000042 against Windows-1252 at 0.95000000 — a tie decided
   * by floating-point noise, which is enough to turn "años" into "ańos".
   *
   * So: when the winner is a Latin single-byte encoding and Windows-1252 is
   * within a hair of it, take Windows-1252, which is overwhelmingly the most
   * common origin for subtitle files in practice. A genuinely confident
   * detection with a clear margin is still respected, and this never touches
   * multi-byte encodings — Shift-JIS, EUC-JP, Big5 and UTF-16 have strong
   * structural signatures and their detection is reliable.
   */
  if (candidate && LATIN_SINGLE_BYTE.has(candidate) && candidate !== fallbackLatin) {
    const top = guess?.confidence ?? 0;
    const contender = ranked.find((r) => normalizeEncodingName(r.encoding) === fallbackLatin);
    if (contender && top - contender.confidence <= 0.05) candidate = fallbackLatin;
  }

  if (candidate && iconv.encodingExists(candidate)) {
    return {
      text: iconv.decode(buf, candidate),
      encoding: candidate,
      source: 'detected',
      confidence: guess?.confidence ?? null,
    };
  }

  // Windows-1252 is the most common origin for subtitle files that are not
  // UTF-8, and it maps every byte to something, so it never throws.
  return { text: iconv.decode(buf, 'win1252'), encoding: 'windows-1252', source: 'fallback' };
}

const LATIN_SINGLE_BYTE = new Set([
  'iso-8859-1', 'iso-8859-2', 'iso-8859-3', 'iso-8859-4', 'iso-8859-9', 'iso-8859-15',
  'windows-1250', 'windows-1252', 'windows-1254',
]);

function normalizeEncodingName(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const map = {
    ascii: 'windows-1252', // pure ASCII decodes identically, but keeps 8-bit bytes readable
    'iso-8859-1': 'windows-1252',
    'iso-8859-2': 'iso-8859-2',
    'windows-1252': 'windows-1252',
    'windows-1251': 'windows-1251',
    'windows-1250': 'windows-1250',
    'windows-1253': 'windows-1253',
    'windows-1254': 'windows-1254',
    'windows-1255': 'windows-1255',
    'windows-1256': 'windows-1256',
    'koi8-r': 'koi8-r',
    'shift_jis': 'shift_jis',
    'euc-jp': 'euc-jp',
    'euc-kr': 'euc-kr',
    big5: 'big5',
    gb2312: 'gb2312',
    gb18030: 'gb18030',
    'utf-8': 'utf-8',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
  };
  return map[n] || n;
}
