import { speechVector, hasCachedVector, cueVector, FRAME_MS } from './vad.js';
import { findAlignment } from './xcorr.js';
import { detectTools, alignWithTool } from './external.js';

const jobs = new Map(); // `${epId}:${trackId}` -> job

const keyFor = (epId, trackId) => `${epId}:${trackId}`;

export function alignmentStatus(epId, trackId) {
  return jobs.get(keyFor(epId, trackId)) || null;
}

/**
 * Align one subtitle track against the episode's audio.
 *
 * Runs as a job rather than a plain request because the first alignment for an
 * episode has to decode its whole audio track. That result is cached per
 * episode, so aligning a second track afterwards is nearly instant.
 */
const summarize = (r) => ({
  offset: r.offset,
  ratio: r.ratio,
  score: r.score,
  prominence: r.prominence,
  confidence: r.confidence,
});

export function startAlignment(cfg, ep, track, cues, subPath, referenceCues = null) {
  const key = keyFor(ep.id, track.id);
  const existing = jobs.get(key);
  if (existing && existing.state === 'running') return existing;

  const job = {
    state: 'running',
    stage: hasCachedVector(cfg, ep) ? 'correlating' : 'reading audio',
    progress: 0,
    startedAt: Date.now(),
  };
  jobs.set(key, job);

  job.promise = (async () => {
    const tools = await detectTools();

    // A dedicated tool, if the machine has one, beats this implementation.
    if (tools.length && subPath) {
      job.stage = `running ${tools[0]}`;
      job.engine = tools[0];
      try {
        const result = await alignWithTool(tools[0], cfg, ep, subPath);
        job.result = {
          ...result,
          verdict: result.confidence >= 0.65 ? 'good' : result.confidence >= 0.35 ? 'uncertain' : 'poor',
          engine: tools[0],
        };
        job.state = 'done';
        return;
      } catch (err) {
        // Fall through to the built-in method rather than failing outright.
        job.toolError = String(err.message || err).slice(0, 200);
      }
    }

    job.engine = 'built-in';
    const duration = ep.media?.duration || 0;
    const audio = await speechVector(cfg, ep, {
      onProgress: (sec) => {
        job.stage = 'reading audio';
        job.progress = duration ? Math.min(0.95, sec / duration) : 0;
      },
    });

    job.stage = 'correlating';
    job.progress = 0.97;

    const fromAudio = {
      ...findAlignment(audio, cues, { maxOffsetSec: 180 }),
      engine: 'audio',
      speechFrames: audio.reduce((n, v) => n + v, 0),
      totalFrames: audio.length,
    };

    /*
     * When the episode carries its own subtitle track, prefer aligning against
     * that instead of against the audio.
     *
     * A track muxed into the file was timed against this exact cut, so it is a
     * correct timeline for this video. Correlating one subtitle against another
     * compares two precise records of when people speak, where correlating
     * against audio compares a precise record to an inference drawn from
     * loudness — which on this show also contains a kitchen, a radio and a
     * street. Same algorithm, much cleaner inputs.
     *
     * Both are still computed, and whichever produces the more isolated peak
     * wins, because an embedded track is not guaranteed to be well-timed either.
     */
    let chosen = fromAudio;
    if (referenceCues && referenceCues.length) {
      job.stage = 'correlating against the track in the video';
      const reference = cueVector(referenceCues, audio.length);
      const fromReference = {
        ...findAlignment(reference, cues, { maxOffsetSec: 180 }),
        engine: 'reference track',
      };
      job.alternatives = { audio: summarize(fromAudio), reference: summarize(fromReference) };
      if (fromReference.prominence > fromAudio.prominence) chosen = fromReference;

      /*
       * Two methods, two different signals. When they land on the same answer
       * that is corroboration; when they disagree by more than a second, at
       * least one of them is wrong and there is no way to tell which — so the
       * verdict is capped no matter how convincing the winner looked alone.
       *
       * This is not hypothetical. On one episode the audio method returned
       * -0.01s and the reference method -51.25s, and the reference peak was
       * isolated enough to be called "good" on its own terms. It was wrong.
       */
      const disagreement = Math.abs(fromAudio.offset - fromReference.offset);
      if (disagreement > 1.5) {
        chosen = {
          ...chosen,
          confidence: Math.min(chosen.confidence, 0.3),
          verdict: 'poor',
          disagreement: Math.round(disagreement * 100) / 100,
        };
      } else if (disagreement <= 0.5 && chosen.prominence >= 1.2) {
        /*
         * Agreement is evidence too, not only a veto.
         *
         * The two methods read different signals — one infers speech from
         * loudness, the other uses a subtitle timeline written by a person for
         * this cut. Landing within half a second of each other is not something
         * two wrong answers do easily, so the verdict moves up one level.
         *
         * It moves up one level and no further: corroboration means the offset
         * is probably right, not that the peak was strong. Reaching "good" still
         * requires a reasonably isolated peak of its own.
         */
        const promoted = chosen.verdict === 'poor' ? 'uncertain' : chosen.prominence >= 1.5 ? 'good' : chosen.verdict;
        chosen = {
          ...chosen,
          verdict: promoted,
          confidence: Math.max(chosen.confidence, promoted === 'good' ? 0.7 : 0.45),
          corroborated: Math.round(disagreement * 100) / 100,
        };
      }
    }

    job.result = { ...chosen, frameMs: FRAME_MS, alternatives: job.alternatives || null };
    job.state = 'done';
    job.progress = 1;
  })().catch((err) => {
    job.state = 'error';
    job.error = String(err.message || err).slice(0, 300);
  });

  return job;
}
