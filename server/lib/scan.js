import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { probe, summarizeProbe } from './ffmpeg.js';
import { parseName } from './parseName.js';
import { loadSubtitle } from './subtitles/index.js';

export const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.wmv', '.flv', '.ogv']);
export const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);

const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

export function idFor(absPath) {
  return crypto.createHash('sha1').update(path.resolve(absPath).toLowerCase()).digest('hex').slice(0, 12);
}

async function walk(dir, out, { videos, subs }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable folder: skip rather than kill the whole scan
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(full, out, { videos, subs });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (videos && VIDEO_EXT.has(ext)) out.videos.push(full);
      else if (subs && SUB_EXT.has(ext)) out.subs.push(full);
    }
  }
}

/** Run `fn` over items with a fixed concurrency. ffprobe spawns a process per file. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { version: 1, probes: {} };
  }
}

export async function scanLibrary(cfg, { force = false, onProgress } = {}) {
  const cacheFile = path.join(cfg.cacheDir, 'scan.json');
  const cache = force ? { version: 1, probes: {} } : await loadCache(cacheFile);

  const found = { videos: [], subs: [] };
  for (const root of cfg.roots) await walk(root, found, { videos: true, subs: true });
  for (const root of cfg.subtitleRoots) await walk(root, found, { videos: false, subs: true });

  // Deduplicate: a folder can legitimately appear in both roots and subtitleRoots.
  found.videos = [...new Set(found.videos)];
  found.subs = [...new Set(found.subs)];

  let done = 0;
  const videos = await mapLimit(found.videos, 4, async (file) => {
    const st = await fs.stat(file);
    const key = file.toLowerCase();
    const cached = cache.probes[key];
    // mtime + size is the invalidation rule: re-probe only what actually changed.
    let media = cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size ? cached.media : null;
    if (!media) {
      try {
        media = summarizeProbe(await probe(file));
      } catch (err) {
        media = { error: String(err.message || err).slice(0, 300) };
      }
      cache.probes[key] = { mtimeMs: st.mtimeMs, size: st.size, media };
    }
    done++;
    if (onProgress) onProgress(done, found.videos.length, file);

    return {
      id: idFor(file),
      path: file,
      file: path.basename(file),
      dir: path.dirname(file),
      size: st.size,
      mtimeMs: st.mtimeMs,
      parsed: parseName(file),
      media,
    };
  });

  const subs = await Promise.all(
    found.subs.map(async (file) => {
      const st = await fs.stat(file);
      const base = {
        id: idFor(file),
        path: file,
        file: path.basename(file),
        dir: path.dirname(file),
        size: st.size,
        format: path.extname(file).slice(1).toLowerCase(),
        parsed: parseName(file),
      };
      // Parse now rather than on demand: subtitle files are small, the result
      // is cached by mtime, and it is the only way to know what language a
      // track is actually in — the filename lies about it.
      try {
        const parsed = await loadSubtitle(file);
        return {
          ...base,
          cueCount: parsed.cueCount,
          encoding: parsed.encoding,
          detectedLang: parsed.detectedLang,
          langConfidence: parsed.langConfidence,
        };
      } catch (err) {
        return { ...base, error: String(err.message || err).slice(0, 200) };
      }
    })
  );

  // Drop cache entries for files that no longer exist so scan.json cannot grow forever.
  const live = new Set(found.videos.map((f) => f.toLowerCase()));
  for (const k of Object.keys(cache.probes)) if (!live.has(k)) delete cache.probes[k];

  await fs.mkdir(cfg.cacheDir, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(cache));

  return { videos, subs, scannedAt: new Date().toISOString() };
}
