import * as path from './pathish.js';

/**
 * Copied from server/lib/parseName.js. Two changes, both forced by the browser:
 * node:path became the three-function shim next door, and normalizeTitle was
 * inlined from server/lib/config.js so nothing drags the config loader in. The
 * patterns and their confidences are untouched.
 */
export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Release-metadata tokens. These are stripped before any bare-number guess,
 * otherwise "x264" and "1080p" and the year in "Midnight.Diner.S02E10.2011"
 * all look like episode numbers.
 */
const JUNK = [
  /\[[^\]]*\]/g,                                  // [ENG Subs], [eng]
  /\b\d{3,4}\s?x\s?\d{3,4}\b/gi,                  // 1280x720
  /\b\d{3,4}[pi]\b/gi,                            // 720p, 1080i
  /\b[xh]\.?26[45]\b/gi,                          // x264, h.265
  /\b(hevc|avc|xvid|divx|vp9|av1)\b/gi,
  /\b(19|20)\d{2}\b/g,                            // years
  /\b(8|10)\s?bits?\b/gi,
  /\b(bluray|blu-ray|brrip|bdrip|bdremux|webrip|web-?dl|hdtv|dvdrip|remux|repack|proper|internal)\b/gi,
  /\b(aac|ac3|eac3|ddp?|dts(-hd)?|truehd|flac|opus|mp3)\s?\d?(\.\d)?\b/gi,
  /\b(nf|amzn|dsnp|hmax|atvp|itunes)\b/gi,
  /\btrack\s?\d+\b/gi,                            // _track3_ from mkv extraction
  /\b(multi|dual)\s?(audio|sub)\b/gi,
  /\b(eng|jpn|spa|esp|fre|ger)\s?subs?\b/gi,
];

function stripJunk(s) {
  let out = s;
  for (const re of JUNK) out = out.replace(re, ' ');
  return out.replace(/\(\s*\)|\{\s*\}/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanTitle(s) {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/[-–—]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract series / season / episode from a file name.
 * Returns { title, titleKey, season, episode, episodeEnd, confidence, pattern }.
 * `season` is null when the name never says one — the caller decides what to do
 * with that, this function does not invent one.
 */
export function parseName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const spaced = base.replace(/[._]+/g, ' ');

  const attempts = [
    // S01E04 / S1E4 / Season 2 Ep01 / S3.EP04 — also S01E04-E05 ranges
    {
      pattern: 'SxxExx',
      re: /\bs(?:eason)?\s*(\d{1,2})\s*[._\- ]*e(?:p|pisode)?\s*(\d{1,3})(?:\s*[-–]\s*e?(\d{1,3}))?\b/i,
      take: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null }),
      confidence: 1,
    },
    // 1x04 — guarded so 1280x720 cannot match (see test note in README)
    {
      pattern: 'NxNN',
      re: /\b(\d{1,2})x(\d{1,3})\b/i,
      take: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: null }),
      confidence: 0.95,
    },
    // "Season 2" and the episode number stated separately
    {
      pattern: 'season+ep',
      re: /\bs(?:eason)?\s*(\d{1,2})\b[\s\S]*?\be(?:p|pisode)?\s*[._\- ]?(\d{1,3})\b/i,
      take: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: null }),
      confidence: 0.9,
    },
    // ep05 / E01 / episode 4 — no season stated
    {
      pattern: 'ep-only',
      re: /\be(?:p|pisode)?\s*[._\- ]?(\d{1,3})\b/i,
      take: (m) => ({ season: null, episode: +m[1], episodeEnd: null }),
      confidence: 0.7,
    },
  ];

  for (const a of attempts) {
    // Explicit patterns run on the junk-stripped name too, so that a stray
    // "[eng]" or "x264" can never sit between "Season 2" and "Ep01".
    const target = a.pattern === 'ep-only' ? stripJunk(spaced) : spaced;
    const m = target.match(a.re);
    if (!m) continue;
    const parts = a.take(m);
    if (parts.episode > 999 || (parts.season != null && parts.season > 99)) continue;

    // A file named plainly "S01E01.mkv" has no title in front of the marker.
    // That is a normal layout — the series name lives in the folder — so fall
    // back to the directory rather than refusing to parse the file at all.
    const title = cleanTitle(stripJunk(target.slice(0, m.index))) || titleFromFolder(filePath);
    if (!title) continue;
    return { ...parts, title, titleKey: normalizeTitle(title), confidence: a.confidence, pattern: a.pattern };
  }

  // Last resort: a lone number somewhere in the name, after removing every
  // release token. Low confidence on purpose — the UI shows it as a guess.
  const stripped = stripJunk(spaced);
  const bare = stripped.match(/(.*?)\b(\d{1,3})\b(?!.*\b\d{1,3}\b)/);
  if (bare) {
    const title = cleanTitle(bare[1]);
    if (title) {
      return {
        season: null,
        episode: +bare[2],
        episodeEnd: null,
        title,
        titleKey: normalizeTitle(title),
        confidence: 0.4,
        pattern: 'bare-number',
      };
    }
  }

  // Nothing inferable. Listed flat, as asked.
  const title = cleanTitle(stripped) || base;
  return {
    season: null,
    episode: null,
    episodeEnd: null,
    title,
    titleKey: normalizeTitle(title),
    confidence: 0,
    pattern: 'none',
  };
}

/**
 * Series name from the folder structure, for files that carry only an episode
 * marker. A folder called "Season 1" names no series, so the search walks up
 * until it finds one that does.
 */
function titleFromFolder(filePath) {
  let dir = path.dirname(filePath);
  for (let depth = 0; depth < 3; depth++) {
    const name = path.basename(dir);
    if (!name || name.match(/^[a-z]:\\?$/i)) break;
    const cleaned = cleanTitle(
      stripJunk(name.replace(/\b(season|series|temporada)\s*\d+\b/gi, '').replace(/\bs\d{1,2}\b/gi, ''))
    );
    if (cleaned) return cleaned;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return '';
}
