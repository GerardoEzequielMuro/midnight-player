/**
 * Build the episode-name table from the subtitle filenames.
 *
 *   node tools/titles.mjs            # show what it found
 *   node tools/titles.mjs --write    # save data/episode-titles.json
 *
 * The names come from the files themselves rather than from a guess or a
 * scraped list: the subtitle downloads are named
 * "... S01E01 Akai wiener to tamagoyaki 720p.BluRay.x264...", and the part
 * between the episode number and the release tag is the dish the episode is
 * named after. That is the real title, and it is already on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';

const WRITE = process.argv.includes('--write');
const cfg = loadConfig([]);

// Everything after the title is release metadata; the title is what sits
// between the episode number and the first of these.
const RELEASE = /\s+\d{3,4}p|\s+(?:blu-?ray|hdtv|web-?dl|webrip|dvdrip|x264|x265|h264|aac|mbs)\b/i;

const roots = [...new Set([...cfg.roots, ...cfg.subtitleRoots, 'C:/Users/gerar/Downloads'])];
const titles = new Map();

for (const root of roots) {
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isFile() || !/\.(srt|ass|ssa|vtt)$/i.test(e.name)) continue;
    const m = e.name.match(/S(\d{2})E(\d{2})\s+(.+)$/i);
    if (!m) continue;
    const tag = `S${m[1]}E${m[2]}`.toUpperCase();
    const cut = m[3].search(RELEASE);
    const title = (cut === -1 ? m[3].replace(/\.[a-z0-9]+$/i, '') : m[3].slice(0, cut)).trim();
    if (!title || title.length > 60) continue;
    // Several files name the same episode; keep the longest, which is the one
    // that was not truncated by a shorter release tag.
    const held = titles.get(tag);
    if (!held || title.length > held.length) titles.set(tag, title);
  }
}

const sorted = [...titles.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [tag, title] of sorted) console.log(`${tag}  ${title}`);
console.log(`\n${sorted.length} episode names found`);

if (WRITE) {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/episode-titles.json', JSON.stringify(Object.fromEntries(sorted), null, 1), 'utf8');
  console.log('saved to data/episode-titles.json');
}
