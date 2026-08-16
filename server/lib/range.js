import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.vtt': 'text/vtt; charset=utf-8',
};

export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/**
 * Serve a file with HTTP Range support. Without 206 responses the browser
 * refuses to seek — it can only play forward from byte 0.
 */
export async function serveFile(req, res, file, { type } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  const headers = {
    'Content-Type': type || contentType(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  // "bytes=START-END" | "bytes=START-" | "bytes=-SUFFIX"
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }).end();
    return;
  }

  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, stat.size - suffix);
    end = stat.size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }).end();
    return;
  }

  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file, { start, end });
  // Seeking aborts the previous request mid-flight; that is normal, not an error.
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
