import { normalizeNewlines, TIME_LINE, parseTimeLine, sanitize, finalize } from './common.js';

/**
 * WebVTT. Same scan-for-timestamps approach as SRT, plus the blocks that VTT
 * adds and that carry no dialogue: the WEBVTT header, NOTE, STYLE and REGION.
 * Cue settings (align, position, line) trail the timestamp on the same line and
 * are ignored — this player positions subtitles itself.
 */
export function parseVtt(text) {
  const lines = normalizeNewlines(text).split('\n');
  const cues = [];
  let i = 0;

  if (/^﻿?WEBVTT/.test(lines[0] || '')) i++;

  while (i < lines.length) {
    const line = lines[i];

    if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
      i++;
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }

    const times = parseTimeLine(line);
    if (!times) {
      i++;
      continue;
    }
    i++;

    const body = [];
    while (i < lines.length && lines[i].trim() !== '') {
      if (TIME_LINE.test(lines[i])) break;
      body.push(lines[i]);
      i++;
    }

    cues.push({
      start: times.start,
      end: times.end,
      // <v Speaker> and <c.classname> are VTT-specific markup, not dialogue.
      text: sanitize(body.join('\n').replace(/<\/?(v|c|lang|ruby|rt)(\.[^>\s]*)?( [^>]*)?>/gi, '').trim()),
    });
  }

  return finalize(cues);
}
