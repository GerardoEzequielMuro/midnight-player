/**
 * Fetch the missing "bridge" subtitles — the English file from the same release
 * as a translation you already have.
 *
 *   node tools/fetch-bridges.mjs S02E04 S02E05 ...
 *   node tools/fetch-bridges.mjs --write S02E04
 *
 * Without --write it only reports what it found. Files are saved next to the
 * translations they belong with, and an existing file is never overwritten.
 *
 * Having the bridge lets the retimer pair cues on wording rather than on
 * position, which is markedly more accurate.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

const SITE = 'https://www.subtitlecat.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const wanted = args.filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());
const DEST = args.find((a) => a.includes(':\\') || a.includes(':/')) || 'C:/Users/gerar/Downloads';

if (!wanted.length) {
  console.error('Give me at least one episode, e.g. S02E04');
  process.exit(1);
}

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

console.log(`Looking for English bridge files for: ${wanted.join(', ')}\n`);
let found = 0;
let saved = 0;

for (const tag of wanted) {
  const query = encodeURIComponent(`Midnight Diner Shinya shokudo ${tag}`);
  let html;
  try {
    html = await get(`${SITE}/index.php?search=${query}`);
  } catch (err) {
    console.log(`${tag}  search failed: ${err.message}`);
    continue;
  }

  // Result pages for the release we want end in ".en.html".
  const pages = [...new Set([...html.matchAll(/href="(subs\/[^"]*\.en\.html)"/g)].map((m) => m[1]))];
  const page = pages.find((p) => decodeURIComponent(p).toUpperCase().includes(tag));
  if (!page) {
    console.log(`${tag}  no matching release page found`);
    continue;
  }

  let detail;
  try {
    detail = await get(`${SITE}/${page}`);
  } catch (err) {
    console.log(`${tag}  page failed: ${err.message}`);
    continue;
  }

  /*
   * The file uploaded by a human sits at "<name>.en-orig.srt" in the release's
   * folder. Only languages someone has already asked for appear as ready-made
   * ".srt" links, so looking for those misses most pages — but every page names
   * the original in the handler behind its Translate button, along with the
   * folder it lives in.
   */
  const orig = detail.match(/translate_from_server_folder\('[^']*',\s*'([^']+\.srt)',\s*'([^']+)'\)/);
  const links = [...new Set([...detail.matchAll(/href="([^"]+\.srt)"/gi)].map((m) => m[1]))];
  const readyMade = links.find((l) => /\.en-en\.srt$/i.test(l));

  const english = orig ? `${orig[2].replace(/\/$/, '')}/${orig[1]}` : readyMade;
  if (!english) {
    console.log(`${tag}  page found, but no English file published on it`);
    continue;
  }

  // Save under the naming the library already uses for bridge files.
  const name = path.basename(decodeURIComponent(english)).replace(/\.en-orig\.srt$/i, '.en-en.srt');
  const target = path.join(DEST, name);
  found++;

  if (fssync.existsSync(target)) {
    console.log(`${tag}  already on disk — skipped`);
    continue;
  }
  if (!WRITE) {
    console.log(`${tag}  would download: ${name}`);
    continue;
  }

  try {
    const res = await fetch(SITE + encodeURI(english), { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();

    // Only keep it if it is actually a subtitle file.
    const cues = (body.match(/-->/g) || []).length;
    if (cues < 30) {
      console.log(`${tag}  downloaded but it is not a usable subtitle (${cues} cues) — discarded`);
      continue;
    }

    await fs.writeFile(target, body, 'utf8');
    saved++;
    console.log(`${tag}  saved ${cues} cues -> ${name}`);
  } catch (err) {
    console.log(`${tag}  download failed: ${err.message}`);
  }
}

console.log(`\n${found} found, ${saved} saved`);
if (!WRITE && found) console.log('report only — add --write to download.');
