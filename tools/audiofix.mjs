/**
 * Correct a subtitle against the audio when its own source is already off.
 *
 *   node tools/audiofix.mjs S02E10           # measure only
 *   node tools/audiofix.mjs --write S02E10
 *
 * Translating a correctly-timed track gives correct timing for free — but only
 * as correct as the track it came from. S02E10's English source is itself about
 * a second early at the start and settles by the middle, so every translation of
 * it inherits that. Nothing in the subtitle world can see this; only the audio
 * can.
 *
 * So the episode is cut into windows, each window is aligned against the speech
 * on its own, and the confident ones become anchors for a piecewise map. That
 * shape — a drift that varies across the episode — is exactly what a single
 * offset cannot express.
 *
 * The result is measured again before anything is written, and kept only if it
 * is actually better. The original is backed up next to it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { parseSrt } from '../server/lib/subtitles/srt.js';
import { speechVector, FRAME_MS } from '../server/lib/align/vad.js';
import { findAlignment } from '../server/lib/align/xcorr.js';
import { mapFromAnchors, applyTimeMap, toSrt, describeShift } from '../server/lib/subtitles/retime.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const only = args.filter((a) => /^S\d{2}E\d{2}$/i.test(a)).map((a) => a.toUpperCase());
const WINDOWS = 16;
const MIN_CONF = 0.45;

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

/** Per-window offset against the audio; null where the audio cannot vouch for it. */
function profile(audio, cues, windows = WINDOWS) {
  const span = (audio.length * FRAME_MS) / 1000;
  const step = span / windows;
  const out = [];
  for (let k = 0; k < windows; k++) {
    const from = k * step;
    const f0 = Math.max(0, Math.round((from * 1000) / FRAME_MS));
    const f1 = Math.min(audio.length, Math.round(((k + 1) * step * 1000) / FRAME_MS));
    const slice = audio.subarray(f0, f1);
    const local = cues
      .filter((c) => c.start >= from && c.start < from + step)
      .map((c) => ({ ...c, start: c.start - from, end: c.end - from }));
    if (local.length < 6 || slice.length < 2000) { out.push(null); continue; }
    try {
      const r = findAlignment(slice, local, { maxOffsetSec: 20 });
      out.push(r.confidence >= MIN_CONF ? { at: from + step / 2, offset: r.offset } : null);
    } catch { out.push(null); }
  }
  return out;
}

const worstOf = (p) => {
  const v = p.filter(Boolean).map((x) => Math.abs(x.offset));
  return v.length ? Math.max(...v) : null;
};
const fmt = (p) => p.map((x) => (x ? ((x.offset >= 0 ? '+' : '') + x.offset.toFixed(1)).padStart(5) : '   · ')).join('');

for (const ep of episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (only.length && !only.includes(tag)) continue;
  const cand = ep.subs.find((s) => /\.es-419\.srt$/i.test(s.file) && !/retimed/i.test(s.file));
  if (!cand) { console.log(`${tag}  no translated track yet — skipped`); continue; }

  const audio = await speechVector(cfg, ep);
  const sub = await loadSubtitle(cand.path);

  const before = profile(audio, sub.cues);
  const anchors = before.filter(Boolean);
  if (anchors.length < 4) { console.log(`${tag}  only ${anchors.length} confident windows — leaving it alone`); continue; }

  // The offset is what the cues must move by, so the map sends each anchor
  // point to itself plus its own offset; between anchors it interpolates.
  const map = mapFromAnchors(anchors.map((a) => ({ from: a.at, to: a.at + a.offset, similarity: 1 })));
  const fixed = applyTimeMap(sub.cues, map);
  const after = profile(audio, fixed);

  /*
   * Judge the result at a second, coarser windowing as well.
   *
   * The map is fitted to sixteen windows, so of course it scores well against
   * sixteen windows — that is the thing it was built to satisfy, not evidence
   * that the episode got better. Measured at eight instead, one "improvement"
   * turned out to have pushed a stretch of S01E03 from 0.7s out to 2.2s: fewer,
   * wider windows caught a whole region the fit had bent, which sixteen narrow
   * ones each saw only a sliver of.
   *
   * So a correction has to hold up at a windowing it was not fitted to. That is
   * the difference between measuring the work and marking your own homework.
   */
  const COARSE = 8;
  const beforeCoarse = worstOf(profile(audio, sub.cues, COARSE));
  const afterCoarse = worstOf(profile(audio, fixed, COARSE));

  const w0 = worstOf(before);
  const w1 = worstOf(after);
  const shift = describeShift(sub.cues, fixed);
  console.log(`${tag}  before ${fmt(before)}   worst ${w0?.toFixed(2)}s`);
  console.log(`${tag}  after  ${fmt(after)}   worst ${w1?.toFixed(2)}s   moved ${shift.min}s..${shift.max}s`);

  /*
   * Measuring better is not enough. A map can score well and still have wrecked
   * the file — the first version of this scored 0.22s -> 0.08s on S03E10 while
   * quietly dropping a cue, because a cue squashed to nothing disappears when
   * the SRT is parsed back. So the written form is round-tripped and compared
   * with what went in: same number of lines, same text, and nothing moved
   * further than real drift plausibly could.
   */
  const roundTrip = parseSrt(toSrt(fixed));
  const intact =
    roundTrip.length === sub.cues.length && roundTrip.every((c, i) => c.text === sub.cues[i].text);
  const biggestMove = Math.max(...fixed.map((c, i) => Math.abs(c.start - sub.cues[i].start)));

  if (!intact) {
    console.log(`${tag}  REJECTED — ${sub.cues.length} cues in, ${roundTrip.length} survived the round trip\n`);
    continue;
  }
  if (biggestMove > 3) {
    console.log(`${tag}  REJECTED — would move a line ${biggestMove.toFixed(1)}s, past any real drift\n`);
    continue;
  }
  if (afterCoarse !== null && beforeCoarse !== null && afterCoarse > beforeCoarse + 0.05) {
    console.log(
      `${tag}  REJECTED — better at 16 windows but worse at ${COARSE} ` +
        `(${beforeCoarse.toFixed(2)}s -> ${afterCoarse.toFixed(2)}s)
`
    );
    continue;
  }
  if (w1 === null || w1 >= w0) { console.log(`${tag}  no improvement — original kept
`); continue; }
  if (!WRITE) { console.log(`${tag}  would improve ${w0.toFixed(2)}s -> ${w1.toFixed(2)}s (dry run)\n`); continue; }

  await fs.copyFile(cand.path, `${cand.path}.orig`);
  await fs.writeFile(cand.path, toSrt(fixed), 'utf8');
  console.log(`${tag}  written; original saved as ${path.basename(cand.path)}.orig\n`);
}
