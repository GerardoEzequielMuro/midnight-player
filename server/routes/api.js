import path from 'node:path';
import { scanLibrary } from '../lib/scan.js';
import { pairLibrary, groupSeries } from '../lib/pair.js';
import { planPlayback, statusFor, prepare, cacheFileFor } from '../lib/playback.js';
import { serveFile } from '../lib/range.js';
import { loadSubtitle } from '../lib/subtitles/index.js';
import { extractEmbedded, embeddedTrackKind } from '../lib/subtitles/extract.js';
import { startAlignment, alignmentStatus } from '../lib/align/index.js';
import { detectTools } from '../lib/align/external.js';

/**
 * Which subtitle tracks the selector should offer, and which to start on.
 *
 * An episode here carries several: the English track muxed into the file, the
 * human translation it was retimed from, the retimed result, and finally the
 * one track that is actually correct for this cut. All of them mattered while
 * that last one was being produced; once it exists, showing the rest is a menu
 * of worse options. So the list is narrowed to the best Spanish track unless
 * cfg.singleSubtitle is turned off.
 *
 * Ranking prefers a file named after the video, because that is how a track
 * written for this exact cut is named, over anything carrying ".retimed" —
 * which by definition was dragged here from a different release.
 */
function offeredTracks(cfg, ep) {
  const embedded = (ep.media?.subtitles ?? []).map((s) => ({
    ...s,
    // Bitmap tracks are pictures of text; the UI must not offer them as
    // if they were selectable subtitles.
    kind: embeddedTrackKind(s.codec),
  }));

  const wanted = new RegExp(`^(${cfg.subtitleLang}|es)`, 'i');
  const base = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
  const rank = (s) => {
    const name = s.file.toLowerCase();
    if (name.startsWith(base) && !name.includes('.retimed.')) return 0;
    if (!name.includes('.retimed.')) return 1;
    return 2;
  };
  const best = ep.subs.filter((s) => wanted.test(s.lang || '')).sort((a, b) => rank(a) - rank(b))[0];

  // With no track in the wanted language there is nothing to narrow to, and
  // hiding everything would leave the episode with no subtitles at all.
  if (!cfg.singleSubtitle || !best) {
    return { subs: ep.subs, embeddedSubs: embedded, preferredTrack: best?.id ?? null };
  }
  return { subs: [best], embeddedSubs: [], preferredTrack: best.id };
}

export function createApi(cfg, store) {
  let raw = null;      // last scan result
  let library = null;  // paired + grouped view
  let scanning = null; // in-flight scan promise

  function rebuild() {
    const { episodes, unmatched } = pairLibrary(raw.videos, raw.subs, cfg, store.data.subOverrides);
    library = {
      series: groupSeries(episodes),
      unmatched,
      scannedAt: raw.scannedAt,
      counts: {
        episodes: episodes.length,
        subtitles: raw.subs.length,
        attached: episodes.reduce((n, e) => n + e.subs.length, 0),
        unmatched: unmatched.length,
      },
    };
    byId = new Map(episodes.map((e) => [e.id, e]));
    subsById = new Map(raw.subs.map((s) => [s.id, s]));
  }

  let byId = new Map();
  let subsById = new Map();

  async function ensureScan(force = false) {
    if (scanning) return scanning;
    if (raw && !force) return raw;
    scanning = (async () => {
      const t0 = Date.now();
      raw = await scanLibrary(cfg, {
        force,
        onProgress: (done, total) => {
          if (done === total || done % 10 === 0) process.stdout.write(`\r  probing ${done}/${total}   `);
        },
      });
      rebuild();
      console.log(`\r  scanned ${raw.videos.length} videos, ${raw.subs.length} subtitle files in ${Date.now() - t0}ms`);
      return raw;
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  /** Resolve a track id to its cues and, when it is a real file, its path. */
  async function resolveTrack(ep, trackId) {
    if (trackId.startsWith('emb:')) {
      const file = await extractEmbedded(cfg, ep, trackId.slice(4));
      const parsed = await loadSubtitle(file);
      return { cues: parsed.cues, path: file };
    }
    const sub = subsById.get(trackId);
    if (!sub) return null;
    const parsed = await loadSubtitle(sub.path);
    return { cues: parsed.cues, path: sub.path };
  }

  /** Strip absolute paths out of what we send to the browser, except where it's useful to show. */
  function publicEpisode(ep) {
    const saved = store.episode(ep.id);
    return {
      id: ep.id,
      file: ep.file,
      dir: ep.dir,
      title: ep.parsed.title,
      season: ep.season,
      episode: ep.episode,
      confidence: ep.parsed.confidence,
      pattern: ep.parsed.pattern,
      size: ep.size,
      duration: ep.media?.duration ?? null,
      video: ep.media?.video?.[0] ?? null,
      audio: ep.media?.audio ?? [],
      ...offeredTracks(cfg, ep),
      error: ep.media?.error ?? null,
      saved: {
        position: saved.position ?? 0,
        watched: !!saved.watched,
        subTrack: saved.subTrack ?? null,
        secondaryTrack: saved.secondaryTrack ?? null,
        delays: saved.delays || {},
      },
    };
  }

  return {
    ensureScan,

    async handle(req, res, url) {
      const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
      const route = seg.slice(1);

      if (route[0] === 'library') {
        await ensureScan();
        return json(res, {
          ...library,
          series: library.series.map((s) => ({
            ...s,
            seasons: s.seasons.map((se) => ({ ...se, episodes: se.episodes.map(publicEpisode) })),
            loose: s.loose.map(publicEpisode),
          })),
        });
      }

      if (route[0] === 'rescan' && req.method === 'POST') {
        await ensureScan(true);
        return json(res, { ok: true, counts: library.counts });
      }

      if (route[0] === 'episode' && route[1]) {
        await ensureScan();
        const ep = byId.get(route[1]);
        if (!ep) return json(res, { error: 'unknown episode' }, 404);

        const requestedAudio = url.searchParams.get('audio');
        const plan = planPlayback(ep, cfg, requestedAudio);
        const action = route[2];

        if (!action) return json(res, { ...publicEpisode(ep), plan });

        if (action === 'status') {
          if (plan.mode === 'error') {
            return json(res, { plan, status: { state: 'unavailable', progress: 0, error: plan.reason } });
          }
          return json(res, { plan, status: statusFor(cfg, ep, plan) });
        }

        if (action === 'prepare' && req.method === 'POST') {
          if (plan.mode === 'error') return json(res, { error: plan.reason }, 422);
          // Background prefetch queues behind whatever the user is actually opening.
          prepare(cfg, ep, plan, { priority: !url.searchParams.has('prefetch') });
          return json(res, { plan, status: statusFor(cfg, ep, plan) });
        }

        if (action === 'stream') {
          if (plan.mode === 'error') return json(res, { error: plan.reason }, 422);
          if (plan.mode === 'direct') return serveFile(req, res, ep.path);
          const out = cacheFileFor(cfg, ep, plan);
          const status = statusFor(cfg, ep, plan);
          if (status.state !== 'ready') {
            // 409 rather than a partial file: the .part is not seekable yet.
            return json(res, { error: 'not prepared', status }, 409);
          }
          return serveFile(req, res, out);
        }

        // A subtitle track living inside the MKV. Extracted with ffmpeg on
        // first request, cached, then parsed like any external file.
        if (action === 'embedded' && route[3] != null) {
          try {
            const file = await extractEmbedded(cfg, ep, route[3]);
            const parsed = await loadSubtitle(file);
            const track = (ep.media?.subtitles || []).find((s) => s.index === Number(route[3]));
            return json(res, { id: `emb:${route[3]}`, file: `track ${route[3]}`, lang: track?.lang || null, ...parsed });
          } catch (err) {
            // Unknown index or an unusable codec is a bad request, not a
            // server failure. Only a genuine extraction crash is a 500.
            const status = err.code === 'BITMAP' ? 422 : /no subtitle track|unsupported/i.test(err.message) ? 404 : 500;
            return json(res, { error: err.message, code: err.code || null }, status);
          }
        }

        // Chosen tracks, per-track delay and per-track time scale.
        if (action === 'subprefs' && req.method === 'POST') {
          const body = await readJson(req);
          const prev = store.episode(ep.id);
          store.setEpisode(ep.id, {
            subTrack: body.subTrack !== undefined ? asTrackId(body.subTrack) : prev.subTrack,
            secondaryTrack:
              body.secondaryTrack !== undefined ? asTrackId(body.secondaryTrack) : prev.secondaryTrack,
            delays: { ...(prev.delays || {}), ...numericMap(body.delays) },
            scales: { ...(prev.scales || {}), ...numericMap(body.scales) },
          });
          return json(res, { ok: true });
        }

        /*
         * Automatic alignment. The correction is only ever returned as two
         * numbers for the player to apply — the subtitle file on disk is never
         * written to, read-only from here.
         */
        if (action === 'align') {
          const trackId = url.searchParams.get('track');
          if (!trackId) return json(res, { error: 'track required' }, 400);

          if (req.method === 'POST') {
            let resolved;
            try {
              resolved = await resolveTrack(ep, trackId);
            } catch (err) {
              return json(res, { error: err.message }, 422);
            }
            if (!resolved) return json(res, { error: 'unknown track' }, 404);

            /*
             * A subtitle known to be correctly timed for this video doubles as
             * a timeline to align against. Two kinds qualify: a text track
             * muxed into the file, and a subtitle shipped beside the video
             * under the same name, which came with the release.
             *
             * The second case is what makes this work for MP4 releases, which
             * rarely carry subtitle tracks and use a sidecar file instead.
             */
            let referenceCues = null;
            const refTrack = (ep.media?.subtitles || [])
              .filter((s) => embeddedTrackKind(s.codec) === 'text')
              .find((s) => `emb:${s.index}` !== trackId);
            try {
              if (refTrack) {
                const refFile = await extractEmbedded(cfg, ep, refTrack.index);
                referenceCues = (await loadSubtitle(refFile)).cues;
              } else {
                const base = path.basename(ep.path, path.extname(ep.path)).toLowerCase();
                const sidecar = ep.subs.find(
                  (s) =>
                    s.id !== trackId &&
                    path.dirname(s.path).toLowerCase() === path.dirname(ep.path).toLowerCase() &&
                    path.basename(s.path, path.extname(s.path)).toLowerCase() === base
                );
                if (sidecar) referenceCues = (await loadSubtitle(sidecar.path)).cues;
              }
            } catch {
              // no reference available; audio alignment still runs
            }

            startAlignment(cfg, ep, { id: trackId }, resolved.cues, resolved.path, referenceCues);
            return json(res, { ok: true, status: publicJob(alignmentStatus(ep.id, trackId)) });
          }

          return json(res, { status: publicJob(alignmentStatus(ep.id, trackId)) });
        }

        if (action === 'progress' && req.method === 'POST') {
          const body = await readJson(req);
          store.setEpisode(ep.id, {
            position: body.position,
            duration: body.duration,
            ...(body.watched != null ? { watched: !!body.watched } : {}),
          });
          return json(res, { ok: true });
        }
      }

      // Parsed cues for one external subtitle file. Sent as JSON rather than
      // as a <track> file because the player renders subtitles itself: two
      // simultaneous tracks, live delay and custom styling are all impossible
      // through the native track API.
      if (route[0] === 'sub' && route[1]) {
        await ensureScan();
        const sub = subsById.get(route[1]);
        if (!sub) return json(res, { error: 'unknown subtitle' }, 404);
        try {
          const parsed = await loadSubtitle(sub.path);
          return json(res, { id: sub.id, file: sub.file, ...parsed });
        } catch (err) {
          return json(res, { error: `could not read subtitle: ${err.message}` }, 500);
        }
      }

      if (route[0] === 'aligners') {
        const tools = await detectTools();
        return json(res, { tools, engine: tools[0] || 'built-in' });
      }

      if (route[0] === 'prefs') {
        if (req.method === 'POST') {
          // Settings have a known shape, so say so. Storing whatever arrives
          // means one typo lives in the file forever.
          store.setPrefs(cleanPrefs(await readJson(req)));
          return json(res, { ok: true });
        }
        return json(res, store.data.prefs || {});
      }

      if (route[0] === 'attach' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.subPath !== 'string' || !body.subPath) {
          return json(res, { error: 'subPath must be a non-empty string' }, 400);
        }
        store.setOverride(body.subPath, asTrackId(body.episodeId));
        rebuild();
        return json(res, { ok: true, counts: library.counts });
      }

      return json(res, { error: 'unknown endpoint' }, 404);
    },
  };
}

function publicJob(job) {
  if (!job) return { state: 'idle' };
  return {
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    engine: job.engine,
    result: job.result || null,
    error: job.error || null,
    toolError: job.toolError || null,
  };
}

function json(res, body, status = 200) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

/**
 * Read a JSON request body, and insist that it is actually a JSON object.
 *
 * Returning `{}` on a parse failure looked forgiving and was dishonest: a
 * malformed body reported success while silently saving nothing. Arrays and
 * primitives are rejected for the same reason — spreading an array into stored
 * settings turns it into {"0": ..., "1": ...} and quietly corrupts the file.
 */
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400 });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { status: 400 });
  }
  return parsed;
}

/** Keep only entries whose value is a finite number. */
function numericMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const n = Number(value);
    // A non-numeric delay propagates into the player as NaN and silently
    // blanks the track, so it is dropped here rather than stored.
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

const asTrackId = (v) => (typeof v === 'string' && v ? v : null);

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** Keep only recognised settings, each within a sane range. */
function cleanPrefs(body) {
  const out = {};
  if (body.volume !== undefined) out.volume = num(body.volume, 0, 1);
  if (body.muted !== undefined) out.muted = !!body.muted;
  if (body.sidebarCollapsed !== undefined) out.sidebarCollapsed = !!body.sidebarCollapsed;

  const style = body.subtitleStyle;
  if (style && typeof style === 'object' && !Array.isArray(style)) {
    out.subtitleStyle = {
      size: num(style.size, 0.8, 12) ?? 3.2,
      bottom: num(style.bottom, 0, 60) ?? 6,
      bgOpacity: num(style.bgOpacity, 0, 1) ?? 0.55,
      color: /^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#ffffff',
      outline: !!style.outline,
    };
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}
