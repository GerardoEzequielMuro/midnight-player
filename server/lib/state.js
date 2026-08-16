import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { version: 1, episodes: {}, subOverrides: {}, prefs: {} };

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY;
    this.timer = null;
    try {
      this.data = { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {}
  }

  episode(id) {
    return this.data.episodes[id] || {};
  }

  setEpisode(id, patch) {
    this.data.episodes[id] = { ...this.data.episodes[id], ...patch };
    this.save();
  }

  setOverride(subPath, episodeId) {
    if (episodeId === undefined) delete this.data.subOverrides[subPath];
    else this.data.subOverrides[subPath] = episodeId; // null means "detached"
    this.save();
  }

  setPrefs(patch) {
    this.data.prefs = { ...this.data.prefs, ...patch };
    this.save();
  }

  /** Debounced + atomic: playback position writes land every few seconds. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const tmp = `${this.file}.tmp`;
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(this.data, null, 1));
        await fsp.rename(tmp, this.file);
      } catch (err) {
        console.error('[state] save failed:', err.message);
      }
    }, 1000);
    this.timer.unref?.();
  }
}
