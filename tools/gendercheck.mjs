/**
 * Flag subtitle lines whose Spanish gender may not match who is on screen.
 *
 *   node tools/gendercheck.mjs S03E01 S03E02 ...
 *
 * Spanish marks gender on adjectives and participles; the English these were
 * translated from does not. A translator with no picture defaults to masculine,
 * and the mistake is invisible in the Spanish alone — you have to look back at
 * what the scene said.
 *
 * So each Spanish line carrying a masculine marker is checked against the
 * English around it. If the neighbourhood talks about a woman and never about a
 * man, the line is flagged. This does not correct anything and it is not proof
 * of an error: it produces a short list worth a human glance, which is the
 * honest limit of what can be automated here.
 */
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { findReference } from '../server/lib/reference.js';

const only = process.argv.slice(2).filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());

// Words that agree with ONE person and only exist in the masculine here.
//
// Deliberately narrow. The first version also listed solo, todos, nosotros and
// ellos, and every single flag it produced was wrong: "solo" is usually the
// adverb "only", and the plural pronouns are the normal generic form. A check
// that cries wolf eleven times out of eleven gets ignored, which is worse than
// not having it.
const MASC = /(bienvenido|listo|cansado|seguro|contento|preocupado|enojado|sorprendido|encantado|casado|enamorado|ocupado|tranquilo|molesto|perdido|equivocado|sentado|dispuesto|harto|muerto|nervioso|callado|serio|bueno|malo|querido|viejo|amigo|hijo|señor|niño|chico)/i;
const FEM_CTX = /\b(she|her|hers|herself|woman|women|wife|girl|daughter|mother|lady|madam|mrs|ms|sister|-chan)\b/i;
const MALE_CTX = /\b(he|him|his|himself|man|men|husband|boy|son|father|sir|mr|brother|master)\b/i;

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
const strip = (t) => String(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

let flagged = 0;
for (const ep of episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (only.length && !only.includes(tag)) continue;

  const es = ep.subs.find((s) => /\.es-419\.srt$/i.test(s.file) && !/retimed/i.test(s.file));
  const ref = await findReference(cfg, ep);
  if (!es || !ref) continue;

  const spanish = await loadSubtitle(es.path);
  const english = await loadSubtitle(ref.path);
  // Only index-comparable when the translation inherited the reference timing,
  // which is the whole point of this pipeline — but check rather than assume.
  if (spanish.cueCount !== english.cueCount) { console.log(`${tag}  cue counts differ — cannot compare`); continue; }

  const hits = [];
  for (let i = 0; i < spanish.cueCount; i++) {
    const line = strip(spanish.cues[i].text);
    if (!MASC.test(line)) continue;
    const around = english.cues.slice(Math.max(0, i - 3), i + 4).map((c) => strip(c.text)).join(' ');
    if (FEM_CTX.test(around) && !MALE_CTX.test(around)) {
      hits.push({ at: spanish.cues[i].start, en: strip(english.cues[i].text), es: line });
    }
  }

  if (hits.length) {
    flagged += hits.length;
    console.log(`\n${tag}  ${hits.length} line(s) worth checking`);
    for (const h of hits.slice(0, 6)) {
      const m = `${Math.floor(h.at / 60)}:${String(Math.round(h.at % 60)).padStart(2, '0')}`;
      console.log(`  [${m}]  EN  ${h.en.slice(0, 66)}`);
      console.log(`          ES  ${h.es.slice(0, 66)}`);
    }
    if (hits.length > 6) console.log(`  ...and ${hits.length - 6} more`);
  } else {
    console.log(`${tag}  nothing flagged`);
  }
}
console.log(`\n${flagged} line(s) flagged for a human look`);
