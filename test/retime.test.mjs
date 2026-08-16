/**
 * Retiming tests. Run: node test/retime.test.mjs
 *
 * The scenario is built deliberately nasty: the bridge release differs from the
 * reference by a DIFFERENT amount in each act, which is exactly the case a
 * single offset and ratio cannot express and correlation reports as "poor".
 */
import { matchCues, buildTimeMap, applyTimeMap, describeShift, toSrt } from '../server/lib/subtitles/retime.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const LINES = [
  'as the day comes to an end', 'my own day begins', 'my menu is all there',
  'how is business doing', 'well enough i would say', 'the first time she came',
  'you have katsuobushi', 'i do have it but', 'you mean nekomanma',
  'you like it as well', 'can you wait a little while', 'should i make it from fresh rice',
  'really', 'bon apetit', 'how is it', 'after that day', 'here i am again',
  'is it work', 'promise you will not laugh', 'i get no work but i still want to sing',
  'do you have songs of your own', 'just one', 'bring your poster next time',
  'i will hang it there', 'what is this', 'want to buy one', 'i like it too',
  'let us listen', 'he is a composer i hear', 'that is an idea',
];

/** Correct timeline: what the video actually needs. */
const reference = LINES.map((text, i) => ({ start: 30 + i * 42.5, end: 30 + i * 42.5 + 2.4, text }));

/**
 * The other release. Each act is displaced differently — a longer cold open,
 * a trimmed mid-section, an extra sponsor card before the last act.
 */
const actShift = (t) => (t < 400 ? -6.5 : t < 900 ? -21.0 : -48.25);
const bridge = reference
  .map((c) => ({ start: c.start + actShift(c.start), end: c.end + actShift(c.start), text: c.text }))
  // that release also drops two lines the reference has
  .filter((_, i) => i !== 5 && i !== 19);

/** The translation: same timeline as the bridge, different language. */
const target = bridge.map((c, i) => ({ ...c, text: `linea numero ${i} en espanol` }));

const pairs = matchCues(bridge, reference);
check('matches most cues across releases', pairs.length >= bridge.length - 2, `${pairs.length}/${bridge.length}`);

const monotonic = pairs.every((p, i) => i === 0 || (p.bridgeIndex > pairs[i - 1].bridgeIndex && p.referenceIndex > pairs[i - 1].referenceIndex));
check('matches are strictly in order', monotonic);

const timeMap = buildTimeMap(bridge, reference, pairs);
check('builds anchors', timeMap.anchors.length >= bridge.length - 2, `${timeMap.anchors.length} anchors`);

const retimed = applyTimeMap(target, timeMap);

// Every retimed cue should land where the reference has that same line.
let worst = 0;
for (let i = 0; i < bridge.length; i++) {
  const expected = reference.find((r) => r.text === bridge[i].text);
  if (!expected) continue;
  worst = Math.max(worst, Math.abs(retimed[i].start - expected.start));
}
check('retimed cues land on the correct timeline', worst < 0.05, `worst error ${worst.toFixed(3)}s`);

// The point of the exercise: a single offset could not have done this.
const shift = describeShift(target, retimed);
check('correction is piecewise, not a constant shift', shift.spread > 30, `spread ${shift.spread}s across the episode`);

// Text must survive completely untouched — this moves a translation, not rewrites it.
const textIntact = retimed.every((c, i) => c.text === target[i].text);
check('translation text is unchanged', textIntact);

// Durations must stay sane after mapping.
const sane = retimed.every((c) => c.end > c.start && c.end - c.start < 15);
check('cue durations stay sensible', sane);

// Output must be valid SRT that our own parser can read back.
const srt = toSrt(retimed);
const { parseSrt } = await import('../server/lib/subtitles/srt.js');
const reparsed = parseSrt(srt);
check('output is valid SRT that round-trips', reparsed.length === retimed.length, `${reparsed.length}/${retimed.length} cues`);
check('round-trip preserves timing', Math.abs(reparsed[0].start - retimed[0].start) < 0.01);

// A file from a genuinely different show must not produce confident anchors.
const unrelated = Array.from({ length: 28 }, (_, i) => ({ start: 20 + i * 50, end: 22 + i * 50, text: `completely different dialogue ${i}` }));
const badPairs = matchCues(unrelated, reference);
check('unrelated subtitles produce almost no matches', badPairs.length <= 2, `${badPairs.length} matches`);

console.log(failures ? `\n${failures} FAILING` : '\nall retime tests pass');
process.exit(failures ? 1 : 0);
