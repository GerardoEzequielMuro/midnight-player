import { normalizeNewlines, TIME_LINE, parseTimeLine, sanitize, finalize } from './common.js';

/**
 * SRT, parsed by scanning for timestamp lines rather than by splitting on blank
 * lines. Real files have mixed CRLF/LF, missing or duplicated indices, blank
 * lines inside a cue, and no trailing newline — a blank-line split fails on all
 * of those, while "a cue starts at a timestamp" holds regardless.
 */
export function parseSrt(text) {
  const lines = normalizeNewlines(text).split('\n');
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const times = parseTimeLine(lines[i]);
    if (!times) {
      i++;
      continue;
    }
    i++;

    const body = [];
    while (i < lines.length) {
      // Stop at the next cue: either its timestamp line, or an index line
      // immediately followed by one.
      if (TIME_LINE.test(lines[i])) break;
      if (/^\s*\d+\s*$/.test(lines[i]) && i + 1 < lines.length && TIME_LINE.test(lines[i + 1])) break;
      body.push(lines[i]);
      i++;
    }

    cues.push({
      start: times.start,
      end: times.end,
      text: sanitize(body.join('\n').replace(/\n{2,}/g, '\n').trim()),
    });
  }

  return finalize(cues);
}
