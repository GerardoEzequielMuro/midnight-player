import path from 'node:path';
import { canonicalKey } from './parseName.js';

const LANG_HINTS = [
  [/\b(eng?|english)\b/i, 'eng'],
  [/\b(spa|esp|spanish|castellano|latino)\b/i, 'spa'],
  [/\b(jpn|jap|japanese)\b/i, 'jpn'],
  [/\b(por|pt-?br|portugues)\b/i, 'por'],
  [/\b(fre|fra|french)\b/i, 'fra'],
  [/\b(ger|deu|german)\b/i, 'deu'],
  [/\b(ita|italian)\b/i, 'ita'],
  [/\b(chi|zho|chinese)\b/i, 'zho'],
  [/\b(kor|korean)\b/i, 'kor'],
];

/** Guess a language from the subtitle file name: "...en.srt", "[eng]", "ENG Subs". */
export function guessSubLang(file) {
  const base = path.basename(file);
  const dotted = base.match(/\.([a-z]{2,3})\.[a-z0-9]+$/i);
  if (dotted) {
    const hit = LANG_HINTS.find(([re]) => re.test(dotted[1]));
    if (hit) return hit[1];
  }
  for (const [re, code] of LANG_HINTS) if (re.test(base)) return code;
  return null;
}

const epKey = (k, s, e) => `${k}|${s}|${e}`;

/**
 * Attach subtitle files to episodes.
 *
 * Filename equality is useless here: subs routinely live in another folder,
 * under another title for the same show, from another release. So matching is
 * done on (series, season, episode) with three tiers, and anything that does
 * not land cleanly is reported as unmatched rather than guessed into place.
 */
/**
 * Collapse several files of the same episode down to one.
 *
 * Rewrapping an MKV as MP4 leaves both on disk, and without this the library
 * lists every episode twice — same title, same number, two entries, and no way
 * to tell which is which. Preference goes to the container a browser can open
 * on its own, since that is the one that will actually play.
 */
const CONTAINER_RANK = ['.mp4', '.m4v', '.webm', '.mkv', '.avi'];

function dedupeByEpisode(videos) {
  const best = new Map();
  const loose = [];

  for (const v of videos) {
    // Anything we could not place stays listed; there is nothing to collapse it
    // against, and dropping it would hide the file entirely.
    if (v.parsed.season == null || v.parsed.episode == null) {
      loose.push(v);
      continue;
    }
    const key = `${v.parsed.titleKey}|${v.parsed.season}|${v.parsed.episode}`;
    const rank = (f) => {
      const i = CONTAINER_RANK.indexOf(f.path.slice(f.path.lastIndexOf('.')).toLowerCase());
      return i === -1 ? CONTAINER_RANK.length : i;
    };
    const held = best.get(key);
    if (!held || rank(v) < rank(held)) best.set(key, v);
  }
  return [...best.values(), ...loose];
}


export function pairLibrary(videos, subs, cfg, overrides = {}) {
  const episodes = dedupeByEpisode(videos).map((v) => ({
    ...v,
    key: canonicalKey(v.parsed.titleKey, cfg.aliasMap),
    season: v.parsed.season,
    episode: v.parsed.episode,
    subs: [],
  }));

  const byTitleSeasonEp = new Map();
  const bySeasonEp = new Map();
  const seasonsByKey = new Map();
  const byId = new Map();

  for (const ep of episodes) {
    byId.set(ep.id, ep);
    if (ep.episode == null) continue;
    if (ep.season != null) {
      if (!seasonsByKey.has(ep.key)) seasonsByKey.set(ep.key, new Set());
      seasonsByKey.get(ep.key).add(ep.season);
    }
    const k1 = epKey(ep.key, ep.season, ep.episode);
    if (!byTitleSeasonEp.has(k1)) byTitleSeasonEp.set(k1, []);
    byTitleSeasonEp.get(k1).push(ep);

    const k2 = `${ep.season}|${ep.episode}`;
    if (!bySeasonEp.has(k2)) bySeasonEp.set(k2, []);
    bySeasonEp.get(k2).push(ep);
  }

  const unmatched = [];

  for (const sub of subs) {
    // What the file contains beats what the file is called: a track named
    // "...en-es-419.srt" here holds no English at all.
    const nameLang = guessSubLang(sub.file);
    const track = {
      id: sub.id,
      path: sub.path,
      file: sub.file,
      format: sub.format,
      source: 'external',
      lang: sub.detectedLang || nameLang,
      langFromContent: !!sub.detectedLang,
      langConfidence: sub.langConfidence ?? null,
      langDisagrees: !!(sub.detectedLang && nameLang && sub.detectedLang !== nameLang),
      cueCount: sub.cueCount ?? null,
    };

    // A manual attachment from the UI always wins, including an explicit detach.
    if (Object.prototype.hasOwnProperty.call(overrides, sub.path)) {
      const target = overrides[sub.path];
      if (target && byId.has(target)) {
        byId.get(target).subs.push({ ...track, match: 'manual' });
        continue;
      }
      unmatched.push({ ...sub, reason: 'detached manually' });
      continue;
    }

    if (sub.parsed.episode == null) {
      unmatched.push({ ...sub, reason: 'no episode number in file name' });
      continue;
    }

    const key = canonicalKey(sub.parsed.titleKey, cfg.aliasMap);
    let season = sub.parsed.season;
    let inferredSeason = false;

    if (season == null) {
      const seasons = [...(seasonsByKey.get(key) || [])].sort((a, b) => a - b);
      if (seasons.length === 1) {
        season = seasons[0]; // unambiguous: the show only has one season here
      } else if (seasons.length > 1) {
        // Ambiguous. Default to the lowest season and flag it, so the UI can
        // warn instead of silently attaching S01 subs to an S02 episode.
        season = seasons[0];
        inferredSeason = true;
      }
    }

    // Tier 1: same series, same season, same episode.
    const t1 = byTitleSeasonEp.get(epKey(key, season, sub.parsed.episode)) || [];
    if (t1.length) {
      t1[0].subs.push({ ...track, match: 'title', inferredSeason, ambiguous: t1.length > 1 });
      continue;
    }

    const t2 = bySeasonEp.get(`${season}|${sub.parsed.episode}`) || [];

    // Tier 1b: one title contains the other. Release names often carry both,
    // as in "Midnight Diner (Shinya shokudo)", which matches neither name
    // exactly but is unambiguous once you compare word sets.
    const subWords = new Set(key.split(' ').filter(Boolean));
    const contained = t2.filter((ep) => {
      const epWords = ep.key.split(' ').filter(Boolean);
      if (!epWords.length) return false;
      return epWords.every((w) => subWords.has(w)) || [...subWords].every((w) => epWords.includes(w));
    });
    if (contained.length === 1) {
      contained[0].subs.push({ ...track, match: 'title', inferredSeason });
      continue;
    }

    // Tier 2: different series name, but exactly one episode in the whole
    // library has that season+episode. Covers "Midnight Diner" subs over
    // "Shinya Shokudo" videos when no alias is configured.
    if (t2.length === 1) {
      t2[0].subs.push({ ...track, match: 'guessed', inferredSeason });
      continue;
    }

    unmatched.push({
      ...sub,
      reason: t2.length > 1 ? `S${season}E${sub.parsed.episode} matches ${t2.length} episodes` : 'no matching episode',
    });
  }

  return { episodes, unmatched };
}

/** Group episodes into series → seasons for the library sidebar. */
export function groupSeries(episodes) {
  const series = new Map();
  for (const ep of episodes) {
    if (!series.has(ep.key)) series.set(ep.key, { key: ep.key, titles: new Map(), episodes: [] });
    const s = series.get(ep.key);
    s.titles.set(ep.parsed.title, (s.titles.get(ep.parsed.title) || 0) + 1);
    s.episodes.push(ep);
  }

  return [...series.values()]
    .map((s) => {
      const title = [...s.titles.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const unsorted = s.episodes.filter((e) => e.episode == null);
      const sorted = s.episodes
        .filter((e) => e.episode != null)
        .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.episode - b.episode);

      const seasons = new Map();
      for (const ep of sorted) {
        const n = ep.season ?? 1;
        if (!seasons.has(n)) seasons.set(n, []);
        seasons.get(n).push(ep);
      }
      return {
        key: s.key,
        title,
        episodeCount: sorted.length + unsorted.length,
        seasons: [...seasons.entries()].map(([number, episodes]) => ({ number, episodes })),
        loose: unsorted, // no episode number could be inferred: listed flat
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
