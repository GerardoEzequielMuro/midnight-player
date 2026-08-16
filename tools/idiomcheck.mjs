/**
 * Flag English idioms whose Spanish rendering may not travel.
 *
 *   node tools/idiomcheck.mjs
 *   node tools/idiomcheck.mjs S03E09
 *
 * The English these were translated from is American, and it reaches for
 * American figures of speech — "for pete's sake", "you bet", baseball, dimes.
 * Two things can go wrong. A translator can render the idiom literally, which
 * produces Spanish nobody says. Or it can reach for an equally regional Spanish
 * idiom, which only moves the problem to a different country.
 *
 * This cannot be judged automatically, so it does not try. It finds the English
 * lines that carry an idiom and prints what the Spanish did with each, for a
 * person to read. The output is short because the idioms are rare.
 */
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { findReference } from '../server/lib/reference.js';

const only = process.argv.slice(2).filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());

// American figures of speech, mild oaths, and sports metaphors — the three
// families that do not survive a literal crossing into Spanish.
const IDIOM = new RegExp(
  [
    "for pete'?s sake", "pete'?s sakes", 'holy cow', 'holy smokes', 'good grief', 'my goodness',
    'gee whiz', '\bgeez\b', '\bjeez\b', '\bgosh\b', '\bgolly\b', '\bdarn\b', '\bheck\b',
    '\bshucks\b', '\by\'all\b', '\byou bet\b', '\bno kidding\b', '\bbig deal\b',
    'piece of cake', 'break a leg', 'hit the sack', 'spill the beans', 'under the weather',
    '\bball ?park\b', 'home run', '\btouchdown\b', 'strike out', 'rain check', 'off base',
    'dime a dozen', '\bbucks?\b', '\bdimes?\b', '\bnickels?\b', '\bquarters?\b',
    'cost an arm and a leg', 'once in a blue moon', 'the whole nine yards', '\bkiddo\b',
    '\bbuddy\b', '\bpal\b', '\bswell\b', '\bneat\b', '\bjerk\b', '\bdude\b',
  ].join('|'),
  'i'
);

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});
const strip = (t) => String(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

let total = 0;
for (const ep of episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (only.length && !only.includes(tag)) continue;

  // Fall back to whatever track the player would actually show, so the episodes
  // still on an older subtitle are inspected too — those are the ones nobody
  // has read, and the timing checks say nothing about how they read.
  const mine = ep.subs.find((s) => /[.]es-419[.]srt$/i.test(s.file) && !/retimed/i.test(s.file));
  const es = mine || ep.subs.filter((s) => /^(spa|es)/i.test(s.lang || ''))[0];
  const source = mine ? 'translated' : 'older track';
  const ref = await findReference(cfg, ep);
  if (!es || !ref) continue;

  const english = await loadSubtitle(ref.path);
  const spanish = await loadSubtitle(es.path);
  // Index-comparable only because the translation inherited the reference timing.
  /*
   * A track from another release has its own cue count, so lines cannot be
   * paired by index. They can be paired by time: both describe the same
   * episode, and a retimed track sits within a second of the moment it belongs
   * to. Nearest-in-time is imprecise, but it only has to be close enough to put
   * the right two lines side by side for a person to read.
   */
  const byTime = (t) => {
    let best = null;
    let diff = Infinity;
    for (const c of spanish.cues) {
      const d = Math.abs(c.start - t);
      if (d < diff) { diff = d; best = c; }
    }
    return diff <= 2.5 ? best : null;
  };

  const hits = [];
  for (let i = 0; i < english.cueCount; i++) {
    const en = strip(english.cues[i].text);
    if (!IDIOM.test(en)) continue;
    const match = english.cueCount === spanish.cueCount ? spanish.cues[i] : byTime(english.cues[i].start);
    hits.push({ at: english.cues[i].start, en, es: match ? strip(match.text) : '(nothing at that moment)' });
  }
  if (!hits.length) continue;
  total += hits.length;
  console.log(`
${tag}  [${source}]  ${hits.length} line(s) with an American idiom`);
  for (const h of hits) {
    console.log(`  [${mm(h.at)}]  EN  ${h.en.slice(0, 72)}`);
    console.log(`            ES  ${h.es.slice(0, 72)}`);
  }
}
console.log(`\n${total} line(s) to read over`);
