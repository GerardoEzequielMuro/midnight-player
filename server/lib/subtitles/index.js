import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeSubtitle } from './encoding.js';
import { parseSrt } from './srt.js';
import { parseVtt } from './vtt.js';
import { parseAss } from './ass.js';
import { detectLanguage } from './language.js';

const cache = new Map(); // path -> { mtimeMs, size, result }

export async function loadSubtitle(file) {
  const st = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;

  const buf = await fs.readFile(file);
  const { text, encoding, source, confidence } = decodeSubtitle(buf);
  const ext = path.extname(file).slice(1).toLowerCase();

  let cues;
  if (ext === 'ass' || ext === 'ssa') cues = parseAss(text);
  else if (ext === 'vtt') cues = parseVtt(text);
  else cues = parseSrt(text); // .srt and .sub text variants

  const detected = detectLanguage(cues);

  const result = {
    format: ext,
    encoding,
    encodingSource: source,
    encodingConfidence: confidence ?? null,
    detectedLang: detected.lang,
    langConfidence: Math.round(detected.confidence * 100) / 100,
    langMethod: detected.method,
    cueCount: cues.length,
    duration: cues.length ? cues[cues.length - 1].end : 0,
    cues,
  };

  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}
