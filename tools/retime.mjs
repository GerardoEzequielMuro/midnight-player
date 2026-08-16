/**
 * Retime translated subtitles onto your own release.
 *
 *   node tools/retime.mjs              # dry run: report what it would do
 *   node tools/retime.mjs --write      # write the retimed files
 *   node tools/retime.mjs --episode S01E02
 *
 * Nothing existing is ever modified. Output is a new file next to the original,
 * named "<original>.retimed.srt", which the library picks up on the next scan.
 *
 * Two routes, tried in that order:
 *
 *   by text    Needs a subtitle in the same language as a correctly-timed
 *              track, from the same release as the translation. Pairs cues on
 *              wording, which is near-exact when both come from the same
 *              translators. This is the precise one.
 *
 *   by timing  Needs nothing extra. Two translations of an episode put their
 *              cues at the same moments, because the actors speak when they
 *              speak, so cues can be paired on position alone. Coarser, but it
 *              still yields a piecewise correction — the thing a single offset
 *              cannot express.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/lib/config.js';
import { scanLibrary } from '../server/lib/scan.js';
import { pairLibrary } from '../server/lib/pair.js';
import { loadSubtitle } from '../server/lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../server/lib/subtitles/extract.js';
import {
  matchCues, buildTimeMap, applyTimeMap, describeShift, toSrt, matchByTiming, mapFromAnchors, refineByTiming,
} from '../server/lib/subtitles/retime.js';
import { cueVector, FRAME_MS } from '../server/lib/align/vad.js';
import { findAlignment } from '../server/lib/align/xcorr.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

// --episode S01E02 or --episode=S01E02. Guard the index lookup: indexOf returns
// -1 when the flag is absent, and args[0] would then be taken as the episode.
const episodeFlag = args.findIndex((a) => a === '--episode');
const inlineEpisode = args.find((a) => a.startsWith('--episode='));
const only = inlineEpisode ? inlineEpisode.split('=')[1] : episodeFlag >= 0 ? args[episodeFlag + 1] : null;

const cfg = loadConfig([]);
const raw = await scanLibrary(cfg);
const { episodes } = pairLibrary(raw.videos, raw.subs, cfg, {});

/** Two files are the same release when their names differ only by language tag. */
function releaseKey(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/[.\-_ ]?(en|eng|english|es|spa|es-419|spanish|lat|latino|pt|br|fr|de|it)([.\-_](419|br|mx|es))?$/i, '')
    .replace(/[.\-_ ]?(en|eng)[.\-_](es|spa)-?\d*$/i, '')
    .toLowerCase()
    .trim();
}

/** How much a retimed track actually overlaps the correctly-timed one. */
function overlapScore(reference, candidate, frames) {
  const A = cueVector(reference, frames);
  const B = cueVector(candidate, frames);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < frames; i++) {
    if (A[i] && B[i]) inter++;
    if (A[i] || B[i]) union++;
  }
  return union ? inter / union : 0;
}

let considered = 0;
let usable = 0;
const written = [];

for (const ep of episodes) {
  const tag = `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;
  if (only && tag !== only.toUpperCase()) continue;
  if (ep.media?.error || !ep.subs.length) continue;

  /*
   * The reference is a subtitle known to be correctly timed for this video:
   * a text track muxed into the file, or one shipped beside it under the same
   * name. The second case carries MP4 releases, which rarely have embedded
   * tracks — without it a whole season would be skipped.
   */
  const embedded = (ep.media?.subtitles || []).filter((s) => embeddedTrackKind(s.codec) === 'text');
  const videoBase = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const sidecar = ep.subs.find(
    (s) =>
      path.dirname(s.path).toLowerCase() === path.dirname(ep.path).toLowerCase() &&
      path.basename(s.path, path.extname(s.path)).toLowerCase() === videoBase
  );
  if (!embedded.length && !sidecar) continue;
  considered++;

  const referenceFile = embedded.length ? await extractEmbedded(cfg, ep, embedded[0].index) : sidecar.path;
  const reference = await loadSubtitle(referenceFile);

  // Anything already retimed is done; don't retime a retimed file.
  const targets = ep.subs.filter(
    (s) => s.lang && s.lang !== reference.detectedLang && s.path !== referenceFile && !/\.retimed\./i.test(s.file)
  );
  if (!targets.length) {
    console.log(`${tag}  nothing to retime — reference is ${reference.detectedLang}, no other language present`);
    continue;
  }

  // Prefer a target that has a same-release bridge, since the text route is better.
  let chosen = null;
  for (const target of targets) {
    const bridge = ep.subs.find(
      (s) => s.lang === reference.detectedLang && s.path !== target.path && releaseKey(s.file) === releaseKey(target.file)
    );
    if (bridge) { chosen = { target, bridge }; break; }
  }
  if (!chosen) chosen = { target: targets[0], bridge: null };

  const target = await loadSubtitle(chosen.target.path);
  let best = null;

  // ---- route one: text ----------------------------------------------------
  if (chosen.bridge) {
    const bridge = await loadSubtitle(chosen.bridge.path);

    /*
     * The text route rests on bridge and target sharing a timeline. Check it:
     * if they disagree they are not the same release, and the output would be
     * confidently wrong.
     */
    const sameLength = bridge.cueCount === target.cueCount;
    const drift = sameLength
      ? bridge.cues.reduce((n, c, i) => n + Math.abs(c.start - target.cues[i].start), 0) / bridge.cueCount
      : Infinity;

    if (sameLength && drift <= 0.5) {
      const pairs = matchCues(bridge.cues, reference.cues);
      const rate = pairs.length / Math.min(bridge.cueCount, reference.cueCount);
      const timeMap = buildTimeMap(bridge.cues, reference.cues, pairs);
      if (rate >= 0.5 && timeMap.anchors.length >= 8) {
        best = {
          how: 'by text  ',
          detail: `${pairs.length}/${Math.min(bridge.cueCount, reference.cueCount)} matched (${Math.round(rate * 100)}%)`,
          retimed: applyTimeMap(target.cues, timeMap),
          anchors: timeMap.anchors.length,
        };
      }
    }
  }

  // ---- route two: timing, when text was unavailable or too weak ------------
  if (!best) {
    const frames = Math.round(((ep.media?.duration || 1500) * 1000) / FRAME_MS);
    const referenceVector = cueVector(reference.cues, frames);
    const global = findAlignment(referenceVector, target.cues, { maxOffsetSec: 180 });

    /*
     * Try several starting points and keep whichever measurably works best.
     *
     * The refinement only converges if it starts somewhere near the truth, and
     * the correlation peak is not always the truth — on several episodes it
     * picked a shift that looked convincing and was wrong. So rather than trust
     * one seed, run each candidate through and score the result by how much it
     * actually overlaps the correctly-timed track. The answer is chosen by
     * measurement, not by which peak was tallest.
     */
    const seeds = [...new Set([global.offset, 0, ...global.candidates.slice(0, 4).map((c) => c.offset)])];
    let winner = null;

    for (const seed of seeds) {
      const map = refineByTiming(target.cues, reference.cues, { offset: seed });
      if (map.anchors.length < 20) continue;
      const retimed = applyTimeMap(target.cues, map);
      const score = overlapScore(reference.cues, retimed, frames);
      if (!winner || score > winner.score) winner = { map, retimed, score, seed };
    }

    if (winner && winner.map.anchors.length / target.cueCount >= 0.4) {
      best = {
        how: 'by timing',
        detail:
          `${winner.map.anchors.length}/${target.cueCount} anchored ` +
          `(${Math.round((winner.map.anchors.length / target.cueCount) * 100)}%), ` +
          `seed ${winner.seed >= 0 ? '+' : ''}${winner.seed}s, fit ${winner.score.toFixed(2)}`,
        retimed: winner.retimed,
        anchors: winner.map.anchors.length,
      };
    }
  }

  if (!best) {
    console.log(`${tag}  WEAK  neither route found enough to work with — left alone`);
    continue;
  }

  usable++;
  const shift = describeShift(target.cues, best.retimed);
  console.log(
    `${tag}  OK  ${best.how}  ${best.detail.padEnd(38)} ` +
      `shift ${shift.first >= 0 ? '+' : ''}${shift.first}s → ${shift.last >= 0 ? '+' : ''}${shift.last}s (spread ${shift.spread}s)`
  );

  if (WRITE) {
    const out = path.join(path.dirname(chosen.target.path), `${path.basename(chosen.target.path, '.srt')}.retimed.srt`);
    await fs.writeFile(out, toSrt(best.retimed), 'utf8');
    written.push(out);
  }
}

console.log(`\n${considered} episodes considered, ${usable} retimed`);
if (WRITE) console.log(`${written.length} files written`);
else console.log('dry run — nothing written. Add --write to create the retimed files.');
