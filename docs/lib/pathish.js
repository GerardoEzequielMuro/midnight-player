/**
 * The three things node:path was used for, for a page that has no node.
 *
 * Paths here are the relative paths the File System Access API and
 * webkitRelativePath hand back, so both separators have to be accepted: the
 * browser gives forward slashes, but a name typed by a person may not.
 */

export function basename(p, ext) {
  const b = String(p).split(/[\/]/).filter(Boolean).pop() || '';
  if (ext && b.length > ext.length && b.toLowerCase().endsWith(ext.toLowerCase())) {
    return b.slice(0, -ext.length);
  }
  return b;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

export function dirname(p) {
  const parts = String(p).split(/[\/]/).filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** Name with its extension removed — the form every match in here is made on. */
export const stem = (p) => basename(p, extname(p));
