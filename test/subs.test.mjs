/**
 * Parser tests. Run with:  node test/make-fixtures.mjs && node test/subs.test.mjs
 * No test framework — these are assertions over generated fixtures.
 */
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { parseName } from '../server/lib/parseName.js';

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`}`);
}

// ---- filename parsing ----------------------------------------------------

const nameCases = [
  ['Shinya.Shokudo.S01E05.720p.x264.mkv', [1, 5]],
  ['Midnight.Diner.S02E10.Episode.20.1080p.NF.WEBRip.DDP2.0.x264-CLC_track3_[eng].srt', [2, 10]],
  ['Shinya Shokudo Season 2 Ep01 (1280x720 x264).srt', [2, 1]],
  ['Shinya Shokudo ep05 (1280x720 x264).srt', [null, 5]],
  ['Midnight Diner (Shinya shokudo) S02E05 Kanzume 720p.BluRay.x264.en-es-419.srt', [2, 5]],
  ['Some.Show.1x04.avi', [1, 4]],
  ['Some Show - 07.mkv', [null, 7]],
  ['random file with no number.mkv', [null, null]],
];
for (const [file, want] of nameCases) {
  const r = parseName(file);
  check(`parseName  ${file.slice(0, 52)}`, [r.season, r.episode], want);
}

// ---- subtitle parsing ----------------------------------------------------

const base = new URL('./fixtures/', import.meta.url).pathname.replace(/^\//, '');

const subCases = [
  ['win1252.srt', 'windows-1252', 2],
  ['utf8bom.srt', 'utf-8', 2],
  ['shiftjis.srt', 'shift_jis', 1],
  ['messy.srt', 'utf-8', 3],
  ['sample.vtt', 'utf-8', 2],
  ['sample.ass', 'utf-8', 3],
];
for (const [file, encoding, cueCount] of subCases) {
  const r = await loadSubtitle(base + file);
  check(`subtitle   ${file}`, [r.encoding, r.cueCount], [encoding, cueCount]);
}

// Encoding is the point of the exercise: a Windows-1252 file must survive
// intact, not arrive with mangled accents.
const w = await loadSubtitle(base + 'win1252.srt');
check('win1252 accents preserved', /Café.*años/.test(w.cues[0].text), true);

// ASS: styling kept, drawing commands and Comment lines dropped.
const a = await loadSubtitle(base + 'sample.ass');
check('ass italics kept', a.cues[0].text.includes('<i>'), true);
check('ass drops drawings and comments', a.cues.length, 3);
check('ass line break', a.cues[1].text.includes('<br>'), true);

// SRT: a blank line inside a cue must not split it in two.
const m = await loadSubtitle(base + 'messy.srt');
check('srt survives blank line inside cue', m.cues[1].text.includes('<br>'), true);

console.log(failures ? `\n${failures} FAILING` : '\nall tests pass');
process.exit(failures ? 1 : 0);
