/**
 * What the page remembers between visits.
 *
 * Two stores, because they hold two different kinds of thing:
 *
 *   localStorage — everything that is only data: where you stopped in each
 *   episode, whether you finished it, the subtitle delay you settled on, and
 *   how you like subtitles drawn. Also a cached copy of the last library, so a
 *   returning visitor sees their episodes on the first frame rather than after
 *   a folder scan — and so the browsers that cannot hold a folder handle still
 *   have something to show.
 *
 *   IndexedDB — the one thing localStorage cannot hold: the FileSystemHandle
 *   for the folder itself. Handles are structured-cloneable objects, not
 *   strings, so IndexedDB is the only place they survive a reload.
 */

const K_PREFS = 'midnight-player.prefs.v1';
const K_WATCH = 'midnight-player.watch.v1';
const K_LIB = 'midnight-player.library.v1';

const DB_NAME = 'midnight-player';
const DB_STORE = 'handles';
const HANDLE_KEY = 'root';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or disabled localStorage must not take the player down with it;
    // the session simply stops being remembered.
  }
}

// ---------- preferences ----------

export const DEFAULT_PREFS = {
  volume: 1,
  muted: false,
  sidebarCollapsed: false,
  subtitleStyle: { size: 3.2, color: '#ffffff', bgOpacity: 0.55, bottom: 6, outline: true },
};

export function loadPrefs() {
  const p = readJson(K_PREFS, DEFAULT_PREFS);
  p.subtitleStyle = { ...DEFAULT_PREFS.subtitleStyle, ...(p.subtitleStyle || {}) };
  return p;
}

export const savePrefs = (prefs) => writeJson(K_PREFS, prefs);

// ---------- per-episode state ----------

/**
 * Keyed by episode tag — "S01E01" — and not by file path, on purpose. The tag
 * is what the episode *is*; the path is where this viewer happens to keep it.
 * Move the folder, re-download the release, switch from the 720p to the 1080p
 * cut, and the resume point still applies. Episodes with no readable number
 * fall back to a "file:" key, which is the best that can be done for them.
 */
export function loadWatch() {
  return readJson(K_WATCH, {});
}

const saveWatch = (all) => writeJson(K_WATCH, all);

export function getState(tag) {
  return loadWatch()[tag] || { position: 0, duration: 0, watched: false, subFile: null, delays: {} };
}

export function patchState(tag, patch) {
  const all = loadWatch();
  const next = { ...(all[tag] || { position: 0, duration: 0, watched: false, subFile: null, delays: {} }), ...patch };
  all[tag] = next;
  saveWatch(all);
  return next;
}

// ---------- the remembered library ----------

/**
 * A plain-data shadow of the last scan: enough to draw the list, never the
 * files themselves. Drawn on load so the page is never blank while the folder
 * is being re-opened, and so a browser that cannot persist a handle can still
 * show you what you were watching before asking for the folder again.
 */
export function loadLibraryCache() {
  try {
    const raw = localStorage.getItem(K_LIB);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLibraryCache(cache) {
  writeJson(K_LIB, cache);
}

export function clearLibraryCache() {
  try {
    localStorage.removeItem(K_LIB);
  } catch {
    /* nothing to do */
  }
}

// ---------- the folder handle ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDirHandle() {
  try {
    return (await withStore('readonly', (s) => s.get(HANDLE_KEY))) || null;
  } catch {
    return null;
  }
}

export async function saveDirHandle(handle) {
  try {
    await withStore('readwrite', (s) => s.put(handle, HANDLE_KEY));
  } catch {
    // Private-mode Firefox and a handful of locked-down profiles refuse
    // IndexedDB. The folder still works for this session; it just will not be
    // remembered for the next one.
  }
}

export async function forgetDirHandle() {
  try {
    await withStore('readwrite', (s) => s.delete(HANDLE_KEY));
  } catch {
    /* nothing to do */
  }
}
