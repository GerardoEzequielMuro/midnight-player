/**
 * Write an episode's correctly-timed reference track out as JSON for translation.
 *
 *   node tools/export-cues.mjs S03E01 S03E02 ...
 *
 * Only the text is handed over. Timestamps stay here and are re-attached by
 * tools/import-cues.mjs, so whatever does the translating cannot move a cue
 * even by accident — the failure that matters most is the one that is invisible
 * afterwards.
 *
 * Sung lines are marked and excluded from the work: they carry the closing
 * theme's lyrics, and they are passed through untouched rather than translated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { findReference } from '../server/lib/reference.js';

const wanted = process.argv.slice(2).filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());
if (!wanted.length) { console.error('give me episodes, e.g. S03E01 S03E02'); process.exit(1); }

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
await fs.mkdir('work', { recursive: true });

for (const tag of wanted) {
  const ep = episodes.find(
    (e) => `S${String(e.season ?? 0).padStart(2, '0')}E${String(e.episode ?? 0).padStart(2, '0')}` === tag
  );
  if (!ep) { console.log(`${tag}  not in the library`); continue; }

  const ref = await findReference(cfg, ep);
  if (!ref) { console.log(`${tag}  no correctly-timed reference`); continue; }

  const sub = await loadSubtitle(ref.path);
  /*
   * Find the opening and closing theme blocks.
   *
   * Some releases wrap sung lines in "~", which the parser turns into a music
   * note, and keying on that was enough for two episodes. The other six mark
   * nothing at all, so their theme songs went out as ordinary dialogue to be
   * translated — which is both wrong and not what anyone wants translated.
   *
   * The shape is the reliable signal instead. A theme cue is italic, runs to
   * two or more lines, and is long, because it carries a romanised line plus
   * its gloss. Ordinary italic dialogue is short and stands alone. Requiring a
   * run of four consecutive such cues is what separates the two: the themes
   * arrive as an unbroken block of a dozen or more, and no scene of dialogue
   * looks like that.
   */
  const looksSung = sub.cues.map((c) => {
    if (!/<i>/.test(c.text)) return false;
    const plain = c.text.replace(/<[^>]*>/g, '');
    return c.text.split('<br>').length >= 2 && plain.length >= 60;
  });

  const inSongBlock = new Array(sub.cueCount).fill(false);
  for (let i = 0; i < sub.cueCount; ) {
    if (!looksSung[i]) { i++; continue; }
    let j = i;
    while (j < sub.cueCount && looksSung[j]) j++;
    if (j - i >= 4) for (let k = i; k < j; k++) inSongBlock[k] = true;
    i = j;
  }

  const sung = (t, i) => /♪/.test(t) || inSongBlock[i];

  const payload = {
    tag,
    videoPath: ep.path,
    referencePath: ref.path,
    total: sub.cueCount,
    // Sung lines keep their id so the count still lines up, but carry a flag so
    // the translator skips them.
    cues: sub.cues.map((c, i) => ({
      id: i,
      sung: sung(c.text, i) || undefined,
      text: c.text.replace(/<br>/g, '\n'),
    })),
  };
  await fs.writeFile(path.join('work', `${tag}.en.json`), JSON.stringify(payload, null, 1), 'utf8');
  const toDo = payload.cues.filter((c) => !c.sung).length;
  console.log(`${tag}  ${sub.cueCount} cues (${toDo} to translate, ${sub.cueCount - toDo} sung, passed through)`);
}
