/**
 * Assemble one tidy folder holding the whole series and its subtitles.
 *
 *   node tools/build-drive-folder.mjs             # report what it would build
 *   node tools/build-drive-folder.mjs --write
 *
 * Episodes are named "S01E01 - Akai wiener to tamagoyaki.mp4" with the subtitle
 * beside them under the same stem, which is what the player matches on.
 *
 * Files are hard-linked rather than copied. The library is around 13 GB and a
 * copy would mean carrying it twice on the same disk for no reason; a hard link
 * is the same bytes under a second name, costs nothing, and deleting either
 * name leaves the other intact. If linking is not possible — a different
 * volume, say — it falls back to copying and says so.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';

const WRITE = process.argv.includes('--write');
// An absolute Windows path given on the command line wins; otherwise this.
const given = process.argv.slice(2).find((a) => /^[A-Za-z]:/.test(a));
const DEST = given || 'C:/Users/gerar/Midnight Diner - para Drive';

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

let titles = {};
try { titles = JSON.parse(await fs.readFile('data/episode-titles.json', 'utf8')); } catch {}

/** Windows will not accept these in a name. */
const safe = (s) => s.replace(/[<>:"/\|?*]/g, '').replace(/\s+/g, ' ').trim();

async function place(from, to) {
  if (!WRITE) return 'planned';
  await fs.mkdir(path.dirname(to), { recursive: true });
  try { await fs.unlink(to); } catch {}
  try {
    await fs.link(from, to);
    return 'linked';
  } catch {
    await fs.copyFile(from, to);
    return 'copied';
  }
}

const sorted = episodes
  .filter((e) => e.season != null && e.episode != null)
  .sort((a, b) => a.season - b.season || a.episode - b.episode);

let linked = 0, copied = 0, missing = [];
const provisional = [];

for (const ep of sorted) {
  const tag = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
  const stem = safe(`${tag} - ${titles[tag] || 'Episodio ' + ep.episode}`);
  const seasonDir = path.join(DEST, `Temporada ${ep.season}`);

  // The finished track is the one named after the video and not ".retimed";
  // anything else is what was available before it existed.
  const spanish = ep.subs.filter((s) => /^(spa|es)/i.test(s.lang || ''));
  const best =
    spanish.find((s) => /\.es-419\.srt$/i.test(s.file) && !/retimed/i.test(s.file)) ||
    spanish.find((s) => !/retimed/i.test(s.file)) ||
    spanish[0];

  const isFinal = best && /\.es-419\.srt$/i.test(best.file) && !/retimed/i.test(best.file);
  if (!best) missing.push(tag);
  else if (!isFinal) provisional.push(tag);

  const videoOut = path.join(seasonDir, `${stem}${path.extname(ep.path)}`);
  const r1 = await place(ep.path, videoOut);
  r1 === 'linked' ? linked++ : r1 === 'copied' ? copied++ : null;

  if (best) {
    const subOut = path.join(seasonDir, `${stem}.es.srt`);
    const r2 = await place(best.path, subOut);
    r2 === 'linked' ? linked++ : r2 === 'copied' ? copied++ : null;
  }

  console.log(`${tag}  ${stem}${!best ? '   ** NO SUBTITLE **' : isFinal ? '' : '   (provisional subtitle)'}`);
}

console.log(`\ndestination: ${DEST}`);
console.log(`${sorted.length} episodes`);
if (WRITE) console.log(`${linked} hard-linked, ${copied} copied`);
else console.log('dry run — add --write to build it');
if (provisional.length) console.log(`\n${provisional.length} still on a provisional subtitle: ${provisional.join(' ')}`);
if (missing.length) console.log(`${missing.length} with no Spanish at all: ${missing.join(' ')}`);
