import { parseSrt } from './srt.js';
import { parseVtt } from './vtt.js';
import { parseAss } from './ass.js';
import { extname } from '../pathish.js';

export const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

/** Which parser a file gets, from its extension. */
export function parseSubtitle(name, text) {
  const ext = extname(name).toLowerCase();
  if (ext === '.vtt') return parseVtt(text);
  if (ext === '.ass' || ext === '.ssa') return parseAss(text);
  return parseSrt(text);
}
