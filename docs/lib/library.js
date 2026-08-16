import { parseName } from './parseName.js';
import { basename, dirname, extname, stem } from './pathish.js';
import { SUBTITLE_EXT } from './subtitles/index.js';

/**
 * A library, built from a flat list of files.
 *
 * Only the containers a browser can actually decode are listed as episodes.
 * The rest of the folder is usually full of .mkv — often the very same episode
 * — and quietly dropping it produces a library with holes in it and no
 * explanation, so those files are collected and named instead.
 */

export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm']);
const UNPLAYABLE_EXT = new Set(['.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.m2ts', '.ogv']);

export const tagOf = (season, episode) =>
  episode == null ? null : `S${String(season ?? 1).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

/**
 * A season the file name never stated, taken from the folders above it —
 * "Season 2", "Temporada 2", "S02". Returns null rather than guessing 1, so the
 * caller can tell "the folder says two" from "nobody said anything".
 */
function seasonFromPath(path) {
  const dir = dirname(path);
  if (!dir) return null;
  const segs = dir.split('/').reverse();
  for (const seg of segs) {
    const m = seg.match(/\b(?:season|series|temporada)\s*[._-]?\s*(\d{1,2})\b/i) || seg.match(/\bs(\d{1,2})\b(?!\s*e)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function describe(path) {
  const parsed = parseName(path);
  const season = parsed.season ?? seasonFromPath(path);
  return { ...parsed, season };
}

const hasToken = (name, token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i').test(name);

/**
 * Which subtitle file to start on, ranked the way the server build ranks it:
 * the wanted language first — es-419, then any bare Spanish tag — then a file
 * named after this exact video ahead of one carrying ".retimed.", which by
 * definition was dragged over from a different release. Lower is better.
 */
export function subRank(subName, videoStem) {
  const n = subName.toLowerCase();
  const lang = n.includes('es-419') ? 0 : hasToken(n, 'es') || hasToken(n, 'spa') || hasToken(n, 'esp') ? 1 : 2;
  const retimed = n.includes('.retimed.') ? 1 : 0;
  const named = n.startsWith(String(videoStem).toLowerCase()) ? 0 : 1;
  return lang * 100 + retimed * 10 + named;
}

export function buildLibrary(entries, titles = {}) {
  const videos = [];
  const subs = [];
  const skipped = [];

  for (const entry of entries) {
    const ext = extname(entry.name).toLowerCase();
    if (VIDEO_EXT.has(ext)) videos.push(entry);
    else if (SUBTITLE_EXT.has(ext)) subs.push(entry);
    else if (UNPLAYABLE_EXT.has(ext)) skipped.push({ file: entry.name, reason: `${ext.slice(1).toUpperCase()} — no browser plays this without a server to remux it` });
  }

  const episodes = videos.map((entry) => {
    const p = describe(entry.path);
    const season = p.episode == null ? null : p.season ?? 1;
    const tag = tagOf(season, p.episode);
    const fallback = stem(entry.name);
    const title = (tag && titles[tag]) || fallback;
    return {
      id: tag || `file:${entry.path}`,
      tag,
      season,
      episode: p.episode,
      title,
      label: tag ? `${tag} - ${title}` : title,
      file: entry.name,
      path: entry.path,
      dir: dirname(entry.path),
      stem: fallback,
      entry,
      subs: [],
    };
  });

  // Two indexes, tried in this order: the same season and episode, then — for
  // the odd file whose name carries no number at all — a subtitle sitting next
  // to it under the same stem.
  const byTag = new Map();
  const byStem = new Map();
  for (const ep of episodes) {
    if (ep.tag) {
      if (!byTag.has(ep.tag)) byTag.set(ep.tag, []);
      byTag.get(ep.tag).push(ep);
    }
    byStem.set(`${ep.dir}|${ep.stem.toLowerCase()}`, ep);
  }

  const unmatched = [];

  for (const entry of subs) {
    const p = describe(entry.path);
    const tag = tagOf(p.episode == null ? null : p.season ?? 1, p.episode);
    let targets = tag ? byTag.get(tag) : null;

    if (!targets) {
      // "Episode.srt" beside "Episode.mp4": walk the stem back one dotted
      // suffix at a time, which is how "…x264.en-es-419.srt" finds "…x264.mp4".
      const dir = dirname(entry.path);
      let s = stem(entry.name).toLowerCase();
      while (s.includes('.')) {
        const hit = byStem.get(`${dir}|${s}`);
        if (hit) { targets = [hit]; break; }
        s = s.slice(0, s.lastIndexOf('.'));
      }
      if (!targets) {
        const hit = byStem.get(`${dir}|${s}`);
        if (hit) targets = [hit];
      }
    }

    if (!targets || !targets.length) {
      unmatched.push({ file: entry.name, reason: tag ? `nothing in the library is ${tag}` : 'no episode number in the file name' });
      continue;
    }

    // A subtitle in the same folder as the video beats one from elsewhere.
    const dir = dirname(entry.path);
    const target = targets.find((e) => e.dir === dir) || targets[0];
    target.subs.push({ name: entry.name, path: entry.path, entry });
  }

  for (const ep of episodes) {
    ep.subs.sort((a, b) => subRank(a.name, ep.stem) - subRank(b.name, ep.stem) || a.name.localeCompare(b.name));
  }

  return { ...group(episodes), unmatched: [...unmatched, ...skipped], counts: counts(episodes, subs) };
}

function counts(episodes, subs) {
  const attached = episodes.reduce((n, e) => n + e.subs.length, 0);
  return { episodes: episodes.length, subtitles: subs.length, attached };
}

/** Seasons in order, then whatever carried no number at all. */
function group(episodes) {
  const bySeason = new Map();
  const loose = [];

  for (const ep of episodes) {
    if (ep.episode == null) { loose.push(ep); continue; }
    const key = ep.season ?? 1;
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key).push(ep);
  }

  const seasons = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, eps]) => ({ number, episodes: eps.sort((a, b) => a.episode - b.episode || a.file.localeCompare(b.file)) }));

  loose.sort((a, b) => a.file.localeCompare(b.file));
  return { seasons, loose };
}

/** Flat playing order — what "next episode" walks. */
export function orderOf(lib) {
  return [...lib.seasons.flatMap((s) => s.episodes), ...lib.loose];
}

/**
 * The library reduced to plain data, for localStorage. File handles cannot be
 * stored, so the shape is identical minus `entry`; a cached episode is drawn
 * exactly like a live one and only refuses at the moment you press play.
 */
export function toCache(lib, folderName) {
  const strip = (ep) => ({ ...ep, entry: null, subs: ep.subs.map((s) => ({ name: s.name, path: s.path })) });
  return {
    savedAt: Date.now(),
    folderName,
    counts: lib.counts,
    unmatched: lib.unmatched,
    seasons: lib.seasons.map((s) => ({ number: s.number, episodes: s.episodes.map(strip) })),
    loose: lib.loose.map(strip),
  };
}

export function fromCache(cache) {
  if (!cache?.seasons) return null;
  return {
    seasons: cache.seasons,
    loose: cache.loose || [],
    unmatched: cache.unmatched || [],
    counts: cache.counts || { episodes: 0, subtitles: 0, attached: 0 },
  };
}
