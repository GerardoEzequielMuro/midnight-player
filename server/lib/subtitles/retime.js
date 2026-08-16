/**
 * Retime a subtitle file onto a different release, using a second subtitle file
 * as a bridge.
 *
 * The situation this solves: you have a good human translation whose timing is
 * wrong for your video, because it was made for another release. Correlating it
 * against the audio can only ever recover a shift and a stretch, and when the
 * two releases differ scene by scene — a longer recap here, a trimmed credit
 * roll there — no single shift and stretch exists. The alignment honestly
 * reports "poor" and you are no better off.
 *
 * But if you also have a subtitle in the *same language as a correctly-timed
 * track*, from the *same release as the translation*, it can act as a bridge:
 *
 *     bridge  (release timing, language A)  ─ same release ─  target (release timing, language B)
 *        │
 *        │ matched on text — same language, so this is reliable
 *        ▼
 *     reference (correct timing for your video, language A)
 *
 * Matching bridge to reference on text gives a set of anchor points between the
 * two timelines. Interpolating between anchors gives a piecewise map, which can
 * express per-scene differences that one offset and one ratio cannot. Applying
 * that map to the target retimes the translation without touching a word of it.
 */

/** Strip everything that is presentation rather than dialogue, for comparison. */
function normalize(text) {
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Dice coefficient over character bigrams: robust for near-identical lines. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) || 0;
    if (n > 0) {
      bigrams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * Monotonic sequence alignment between two cue lists.
 *
 * Needleman-Wunsch rather than nearest-neighbour matching, because cues must
 * pair up *in order*: a line repeated later in the episode would otherwise
 * happily match an earlier one and produce a time map that runs backwards.
 * At a few hundred cues per side the quadratic cost is irrelevant.
 */
export function matchCues(bridge, reference, { minSimilarity = 0.6, gapPenalty = -0.35 } = {}) {
  const a = bridge.map((c) => normalize(c.text));
  const b = reference.map((c) => normalize(c.text));
  const n = a.length;
  const m = b.length;

  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=diag 2=up 3=left

  for (let i = 1; i <= n; i++) {
    score[i][0] = score[i - 1][0] + gapPenalty;
    from[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    score[0][j] = score[0][j - 1] + gapPenalty;
    from[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(a[i - 1], b[j - 1]);
      // Below the threshold a pairing is worse than skipping both.
      const diag = score[i - 1][j - 1] + (sim >= minSimilarity ? sim : -0.5);
      const up = score[i - 1][j] + gapPenalty;
      const left = score[i][j - 1] + gapPenalty;
      if (diag >= up && diag >= left) {
        score[i][j] = diag;
        from[i][j] = 1;
      } else if (up >= left) {
        score[i][j] = up;
        from[i][j] = 2;
      } else {
        score[i][j] = left;
        from[i][j] = 3;
      }
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const move = from[i][j];
    if (move === 1) {
      const sim = similarity(a[i - 1], b[j - 1]);
      if (sim >= minSimilarity) pairs.push({ bridgeIndex: i - 1, referenceIndex: j - 1, similarity: sim });
      i--;
      j--;
    } else if (move === 2) i--;
    else j--;
  }
  pairs.reverse();
  return pairs;
}

/**
 * Build a piecewise-linear map from bridge time to reference time.
 *
 * Anchors that contradict their neighbours are dropped: a mismatched pair would
 * otherwise bend the map around it and drag every cue nearby out of place.
 */
export function buildTimeMap(bridge, reference, pairs) {
  return mapFromAnchors(
    pairs.map((p) => ({ from: bridge[p.bridgeIndex].start, to: reference[p.referenceIndex].start, similarity: p.similarity }))
  );
}

/**
 * Pair cues by *when* they happen rather than by what they say.
 *
 * Text matching needs a bridge subtitle in the same language as the correctly
 * timed track. Without one there is still a signal: two translations of the
 * same episode put their cues at the same moments, because the actors speak
 * when they speak. Shift the target by the global offset, then snap each cue to
 * the nearest reference cue.
 *
 * The window is deliberately tight. A wide one would always find something to
 * snap to and would manufacture anchors out of noise; a tight one simply fails
 * to match where the two disagree, which is the honest outcome.
 */
export function matchByTiming(target, reference, { offset = 0, window = 1.2 } = {}) {
  const anchors = [];
  let j = 0;

  for (const cue of target) {
    const shifted = cue.start + offset;
    while (j < reference.length - 1 && reference[j].start < shifted - window) j++;

    let best = null;
    let bestDiff = Infinity;
    for (let k = j; k < reference.length && reference[k].start <= shifted + window; k++) {
      const diff = Math.abs(reference[k].start - shifted);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = reference[k];
      }
    }
    if (best) anchors.push({ from: cue.start, to: best.start, similarity: 1 - bestDiff / window });
  }
  return anchors;
}

/**
 * Timing matching, bootstrapped.
 *
 * One pass can only anchor cues that already land near their counterpart, so a
 * rough starting offset finds a rough set of anchors and stops there. But those
 * anchors make a better map, and a better map brings more cues within reach —
 * so the search is repeated against its own output, tightening the window each
 * time. Cues that were three seconds out on the first pass are within one on
 * the second, and get anchored properly.
 *
 * It stops when a pass stops finding more, so a bad seed cannot be iterated
 * into a confident wrong answer.
 */
export function refineByTiming(target, reference, { offset = 0, passes = 4 } = {}) {
  let map = mapFromAnchors(matchByTiming(target, reference, { offset, window: 1.5 }));
  let previous = map.anchors.length;

  for (let pass = 0; pass < passes; pass++) {
    const window = 1.2 - pass * 0.15;
    const anchors = [];

    for (const cue of target) {
      const predicted = map.map(cue.start);
      let best = null;
      let bestDiff = Infinity;
      for (const r of reference) {
        const diff = Math.abs(r.start - predicted);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = r;
        }
      }
      if (best && bestDiff <= window) {
        anchors.push({ from: cue.start, to: best.start, similarity: 1 - bestDiff / window });
      }
    }

    if (anchors.length < 10) break;
    const next = mapFromAnchors(anchors);
    if (next.anchors.length <= previous) break; // no longer improving
    map = next;
    previous = next.anchors.length;
  }
  return map;
}

export function mapFromAnchors(input) {
  const anchors = [...input].sort((x, y) => x.from - y.from);

  const kept = [];
  for (const anchor of anchors) {
    const prev = kept[kept.length - 1];
    // Time must move forward on both sides; anything else is a bad match.
    if (prev && (anchor.from <= prev.from || anchor.to <= prev.to)) continue;
    kept.push(anchor);
  }

  return {
    anchors: kept,
    /** Map one timestamp, extrapolating with the end segments' slope. */
    map(t) {
      if (kept.length === 0) return t;
      if (kept.length === 1) return t + (kept[0].to - kept[0].from);

      /*
       * Outside the anchored range there is nothing to interpolate between, so
       * the map has to extrapolate — and that is where it can go badly wrong.
       *
       * Taking the slope from the outermost two anchors is fragile: if they sit
       * a fraction of a second apart the slope explodes, and cues past the last
       * anchor get flung minutes away. That produced a 202-second hole at the
       * end of one episode.
       *
       * So the slope is measured over a run of anchors rather than two, and
       * clamped. Two subtitle files for the same episode never legitimately run
       * at more than a few percent different speed, so anything outside that is
       * an artefact of the fit, not a real difference.
       */
      const edgeSlope = (from, to) => {
        const span = kept[to].from - kept[from].from;
        if (span < 1) return 1;
        return Math.max(0.95, Math.min(1.05, (kept[to].to - kept[from].to) / span));
      };

      if (t <= kept[0].from) {
        const upto = Math.min(kept.length - 1, 9);
        return kept[0].to + (t - kept[0].from) * edgeSlope(0, upto);
      }
      const last = kept.length - 1;
      if (t >= kept[last].from) {
        const from = Math.max(0, last - 9);
        return kept[last].to + (t - kept[last].from) * edgeSlope(from, last);
      }

      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (kept[mid].from <= t) lo = mid;
        else hi = mid;
      }
      const span = kept[hi].from - kept[lo].from || 1;
      const ratio = (t - kept[lo].from) / span;
      return kept[lo].to + ratio * (kept[hi].to - kept[lo].to);
    },
  };
}

/**
 * Apply a time map to a cue list.
 *
 * The text is copied through untouched — this moves a translation, it does not
 * rewrite one.
 */
export function applyTimeMap(cues, timeMap) {
  return cues.map((cue) => {
    const start = timeMap.map(cue.start);
    const end = timeMap.map(cue.end);
    return {
      ...cue,
      start,
      // A mapped cue must still last a sensible amount of time; segments of the
      // map can compress, and a cue squashed to nothing would never display.
      end: end > start + 0.2 ? end : start + Math.max(0.6, cue.end - cue.start),
    };
  });
}

/** How much this actually moved things, for reporting before anything is written. */
export function describeShift(before, after) {
  const deltas = before.map((c, i) => after[i].start - c.start);
  if (!deltas.length) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    first: round(deltas[0]),
    last: round(deltas[deltas.length - 1]),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    // A constant shift and a genuinely piecewise correction look very different
    // here, and the difference is worth seeing before accepting the result.
    spread: round(sorted[sorted.length - 1] - sorted[0]),
  };
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function toSrt(cues) {
  const stamp = (t) => {
    const clamped = Math.max(0, t);
    const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    return `${pad(clamped / 3600)}:${pad((clamped / 60) % 60)}:${pad(clamped % 60)},${String(ms).padStart(3, '0')}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${cueText(c)}\n`)
    .join('\n');
}

/** Back to plain subtitle text from the player's limited HTML. */
function cueText(cue) {
  return String(cue.text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
