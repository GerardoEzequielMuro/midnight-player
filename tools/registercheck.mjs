/**
 * Check that every episode speaks the same kind of Spanish.
 *
 *   node tools/registercheck.mjs
 *
 * Latin American Spanish is not one thing. A translator left to its own devices
 * will sometimes reach for Rioplatense — voseo, "che", "dale" — which is fine
 * Spanish and wrong here, because the rest of the series is neutral. Nothing in
 * a per-episode check catches it: each file is internally consistent and reads
 * well. It only shows up across episodes, when a viewer moving from one to the
 * next hits the switch.
 *
 * Two episodes did exactly that, which is why this exists.
 */
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';

/*
/*
 * Written as regex literals, not built from strings.
 *
 * Two escaping layers is one too many: going through new RegExp('...') the
 * pattern arrived as [p{L}] - a class of the four characters p, {, L, } - so
 * the lookbehind never fired and the checker matched "che" inside
 * "medianoche" and "vos" inside "huevos", reporting every episode as
 * Rioplatense. A literal has no such layer.
 *
 * The boundaries must also be Unicode-aware: JavaScript's \b is defined over
 * [A-Za-z0-9_], so an accented letter reads as a non-word character and a
 * boundary appears mid-word - which matched "dejá" inside "dejándolo".
 */
const VOSEO =
  /(?<!\p{L})(?:vos|che|dale|tenés|querés|podés|sabés|hacés|venís|sos|mirá|escuchá|vení|andá|decime|tomá|fijate|acordate|esperá|dejá|pará)(?!\p{L})/giu;
const NEUTRAL =
  /(?<!\p{L})(?:tú|ti|tienes|quieres|puedes|sabes|haces|vienes|eres|mira|escucha|ven|dime|toma|fíjate|acuérdate|espera|deja|para)(?!\p{L})/giu;

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

const rows = [];
for (const ep of episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  const f = ep.subs.find((s) => /\.es-419\.srt$/i.test(s.file) && !/retimed/i.test(s.file));
  if (!f) continue;
  const text = (await loadSubtitle(f.path)).cues.map((c) => c.text).join(' ');
  /*
   * Keep the phrase around each marker, not just the word.
   *
   * Some of these are only regional in one of their senses: "dale" as an
   * interjection is Rioplatense, while "dale tiempo" is the ordinary imperative
   * every Spanish speaker uses. The bare word cannot tell them apart, and three
   * separate flags turned out to be that kind, each costing a trip to go and
   * look. Printing the context makes a wrong flag obvious at a glance, which is
   * the difference between a check people read and one they learn to ignore.
   */
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const found = [...plain.matchAll(VOSEO)].map((m) => ({
    word: m[0].toLowerCase(),
    around: plain.slice(Math.max(0, m.index - 26), m.index + 30).trim(),
  }));
  rows.push({
    tag,
    voseo: found.length,
    neutral: (text.match(NEUTRAL) || []).length,
    hits: found,
  });
}

if (!rows.length) { console.log('no finished translations to compare yet'); process.exit(0); }

// Zero is the target, not a majority. An episode can read mostly neutral and
// still drop a "sos" or a "che" into a scene, and that is exactly the jolt this
// is meant to catch — so any marker at all is reported.
const odd = rows.filter((r) => r.voseo > 0);
for (const r of rows) {
  console.log(
    `${r.tag}  argentino ${String(r.voseo).padStart(3)}   neutral ${String(r.neutral).padStart(3)}   ` +
      (r.voseo ? '' : 'clean')
  );
  for (const h of r.hits) console.log(`      ${h.word.padEnd(9)} … ${h.around} …`);
}
console.log(
  odd.length
    ? `\n${odd.length} episode(s) in a different register: ${odd.map((r) => r.tag).join(' ')}`
    : `
all ${rows.length} finished episodes are clean neutral Spanish`
);
