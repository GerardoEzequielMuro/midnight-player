/**
 * Getting at a folder on the viewer's own disk, by whichever of the two routes
 * this browser has.
 *
 * File System Access (Chrome, Edge) gives a directory handle that can be kept
 * in IndexedDB and re-opened on a later visit. webkitdirectory (Firefox,
 * Safari) gives a one-off snapshot of File objects and nothing that outlives
 * the page, which is why the two are kept behind one shape here and told apart
 * only where the difference actually matters.
 *
 * Both produce the same entry:  { name, path, getFile() }.
 */

export const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';

/** webkitdirectory is only real if the input element admits to the property. */
export const hasWebkitDirectory = 'webkitdirectory' in document.createElement('input');

export const supported = hasDirectoryPicker || hasWebkitDirectory;

// A television series is a few hundred files. A viewer who aims this at their
// home directory should get a stopped scan, not a hung tab.
const MAX_FILES = 20000;
const MAX_DEPTH = 8;

export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ id: 'midnight-player', mode: 'read' });
  return handle;
}

export async function ensurePermission(handle, { prompt = false } = {}) {
  if (!handle?.queryPermission) return 'granted'; // an older shape; try and let it fail loudly
  const opts = { mode: 'read' };
  const state = await handle.queryPermission(opts);
  if (state === 'granted') return 'granted';
  if (!prompt) return state;
  return handle.requestPermission(opts);
}

/**
 * Walk the folder. Hidden directories and the usual junk are skipped, and the
 * relative path is carried along because it is what the season and series are
 * inferred from when a file name alone does not say.
 */
export async function scanDirectory(handle, onProgress) {
  const out = [];

  async function walk(dir, prefix, depth) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    for await (const [name, child] of dir.entries()) {
      if (out.length >= MAX_FILES) return;
      if (name.startsWith('.')) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'file') {
        out.push({ name, path, getFile: () => child.getFile() });
        if (onProgress && out.length % 200 === 0) onProgress(out.length);
      } else if (child.kind === 'directory') {
        await walk(child, path, depth + 1);
      }
    }
  }

  await walk(handle, handle.name || '', 0);
  return out;
}

/** The webkitdirectory side: a FileList is already the whole tree, flattened. */
export function entriesFromFileList(fileList) {
  return Array.from(fileList)
    .filter((f) => !f.name.startsWith('.'))
    .map((f) => ({
      name: f.name,
      path: f.webkitRelativePath || f.name,
      getFile: async () => f,
    }));
}

/** The folder's own name, for the header — the first segment of any path. */
export function rootNameOf(entries) {
  const first = entries[0]?.path || '';
  const seg = first.split('/');
  return seg.length > 1 ? seg[0] : '';
}
