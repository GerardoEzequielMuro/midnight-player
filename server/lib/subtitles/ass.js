import { normalizeNewlines, sanitize, finalize } from './common.js';

/**
 * ASS/SSA — the dialogue, not the typesetting.
 *
 * Full ASS rendering means libass: positioning, rotation, karaoke, per-glyph
 * animation, vector drawing. None of that survives in a DOM overlay, and
 * pulling in a WebAssembly libass build for it is a lot of weight for subtitles
 * that are overwhelmingly plain dialogue. So override tags are stripped,
 * italic/bold/underline are kept, and drawing commands are dropped entirely
 * (they are shapes, and stripped of their tags they would render as noise).
 */
export function parseAss(text) {
  const lines = normalizeNewlines(text).split('\n');
  const cues = [];

  let inEvents = false;
  let fields = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\[/.test(trimmed)) {
      inEvents = /^\[events\]/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }

    // "Comment:" lines are authoring notes, not shown during playback.
    if (!/^Dialogue\s*:/i.test(trimmed)) continue;
    if (!fields) fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

    // The Text field is last and legitimately contains commas, so the split is
    // limited to the number of fields and the remainder is kept whole.
    const rest = trimmed.slice(trimmed.indexOf(':') + 1);
    const parts = splitLimit(rest, ',', fields.length);
    const row = Object.fromEntries(fields.map((f, idx) => [f, (parts[idx] || '').trim()]));

    const start = parseAssTime(row.start);
    const end = parseAssTime(row.end);
    if (start == null || end == null) continue;

    const raw = row.text || '';
    if (/\\p[1-9]/i.test(raw)) continue; // vector drawing, not text

    const styled = raw
      .replace(/\{[^}]*\\i1[^}]*\}/gi, '<i>')
      .replace(/\{[^}]*\\i0[^}]*\}/gi, '</i>')
      .replace(/\{[^}]*\\b1[^}]*\}/gi, '<b>')
      .replace(/\{[^}]*\\b0[^}]*\}/gi, '</b>')
      .replace(/\{[^}]*\}/g, '')      // every remaining override block
      .replace(/\\[Nn]/g, '\n')       // hard and soft line breaks
      .replace(/\\h/g, ' ');          // non-breaking space

    const clean = sanitize(styled);
    if (clean) cues.push({ start, end, text: clean });
  }

  return finalize(cues);
}

/** ASS times are H:MM:SS.cc — centiseconds, not milliseconds. */
function parseAssTime(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(s).trim());
  if (!m) return null;
  const frac = m[4].length === 2 ? Number(m[4]) / 100 : Number(m[4].padEnd(3, '0')) / 1000;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

function splitLimit(str, sep, limit) {
  const out = [];
  let from = 0;
  while (out.length < limit - 1) {
    const idx = str.indexOf(sep, from);
    if (idx === -1) break;
    out.push(str.slice(from, idx));
    from = idx + 1;
  }
  out.push(str.slice(from));
  return out;
}
