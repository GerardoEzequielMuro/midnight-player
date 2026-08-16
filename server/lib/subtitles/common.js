/** Shared helpers for the subtitle parsers. All of them emit the same cue model:
 *  { start, end, text }  — seconds, and HTML limited to <i> <b> <u> <br>. */

export const normalizeNewlines = (s) => s.replace(/\r\n?/g, '\n');

// Accepts both SRT ("00:00:20,000") and VTT ("00:20.000", hours optional).
const TS = String.raw`(?:(\d+):)?(\d{1,3}):(\d{2})[.,](\d{1,3})`;
export const TIME_LINE = new RegExp(`${TS}\\s*-->\\s*${TS}`);

export function toSeconds(h, m, s, ms) {
  // A VTT cue may omit hours, in which case the first captured group is the minutes.
  const msNum = Number(String(ms).padEnd(3, '0'));
  return Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + msNum / 1000;
}

export function parseTimeLine(line) {
  const m = TIME_LINE.exec(line);
  if (!m) return null;
  return {
    start: toSeconds(m[1], m[2], m[3], m[4]),
    end: toSeconds(m[5], m[6], m[7], m[8]),
  };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Subtitle text reaches the DOM as HTML, so everything is escaped first and
 * only the handful of tags that carry meaning are put back. Anything else in
 * the file — stray markup, font tags with attributes, scripts — stays inert.
 */
/**
 * Strip markup that is neither HTML nor meant to be read.
 *
 * These files were converted from ASS and the conversion left ASS syntax
 * behind: "\N" for a line break, "{...}" override blocks. SRT gives neither any
 * meaning, so they reached the screen as literal text — eight cues an episode
 * showed a bare "\N" in the middle of a sentence.
 *
 * The tilde is a different convention rather than a leftover: the Japanese
 * source wraps a sung line in "~". A Spanish viewer reads that as a stray
 * character, not as singing, so it becomes the note used everywhere else. Only
 * lines that open or close with one count as sung, which leaves a tilde inside
 * a sentence alone.
 */
function fromAss(raw) {
  const plain = String(raw)
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, '\n')
    .replace(/\\h/g, ' ');

  return plain
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!/^~|~$/.test(t)) return line;
      const bare = t.replace(/~/g, '').trim();
      return bare ? `\u266a ${bare} \u266a` : '';
    })
    .join('\n');
}

export function sanitize(raw) {
  const escaped = fromAss(raw).replace(/[&<>"]/g, (c) => ESC[c]);
  return escaped
    .replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\n/g, '<br>')
    .trim();
}

/** Cues must be time-ordered for the binary search the player does on every frame. */
export function finalize(cues) {
  const clean = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // A zero or negative duration would never display; give it a readable minimum.
  for (const c of clean) if (c.end <= c.start) c.end = c.start + 1.2;
  return clean;
}
