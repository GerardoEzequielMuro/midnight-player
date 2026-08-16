/**
 * The Drive media proxy.
 *
 * A <video> element cannot send an Authorization header, and Drive will not
 * hand over a file without one. The alternatives are both bad: a signed public
 * link would mean a server, and downloading the whole file into a blob would
 * cost 400 MB of memory and kill seeking. So this worker sits in the middle.
 *
 *   <video src="./drive-media/<fileId>?size=<bytes>">
 *        │  ordinary ranged requests, made by the browser as it plays
 *        ▼
 *   this worker  ──►  drive/v3/files/<id>?alt=media   with Bearer <token>
 *        │                                            and the same Range
 *        ◄── 206 + Content-Range, streamed straight through
 *
 * The browser therefore does its normal range dance and seeking works
 * natively, which is the entire point.
 *
 * The token
 * ---------
 * It is held in one variable and is never written anywhere. A service worker
 * can be stopped at any moment and restarted with its memory wiped, so this
 * one does not assume it still has a token: when it finds none it asks its
 * clients for one and waits a few seconds for an answer. Same when Drive
 * rejects the one it has — it asks for a fresh one and retries exactly once.
 *
 * Everything that is not the virtual media path is left completely alone: no
 * respondWith, no caching, no interception. The local-folder player behaves as
 * if this file did not exist.
 */

const MEDIA_PATH = 'drive-media/';
const DRIVE_MEDIA = 'https://www.googleapis.com/drive/v3/files/';
const TOKEN_WAIT_MS = 6000;

/** In memory only. Never stored. */
let token = null;

/** The one outstanding "does anybody have a token?" question, if any. */
let pending = null;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'drive-token') {
    token = data.token || null;
    settlePending(token);
    event.ports?.[0]?.postMessage({ ok: true, hasToken: !!token });
  } else if (data.type === 'drive-token-clear') {
    token = null;
    settlePending(null);
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (data.type === 'drive-ping') {
    event.ports?.[0]?.postMessage({ ok: true, hasToken: !!token });
  }
});

function settlePending(value) {
  if (!pending) return;
  const resolve = pending.resolve;
  pending = null;
  resolve(value);
}

/**
 * Ask every open tab for the token. `reason` tells the page whether its last
 * answer was simply forgotten by a restarted worker ('missing') or actively
 * rejected by Drive ('stale'), because only the second one needs renewing.
 */
function askClients(reason) {
  if (pending) return pending.promise;

  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const timer = setTimeout(() => settlePending(null), TOKEN_WAIT_MS);
  pending = { promise, resolve: (v) => { clearTimeout(timer); resolve(v); } };

  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    if (!clients.length) return settlePending(null);
    for (const client of clients) client.postMessage({ type: 'drive-token-request', reason });
  });

  return promise;
}

async function tell(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

// ---------- the interception ----------

/** The directory this worker was registered in — the player's own folder. */
const scopeDir = new URL('./', self.location.href).pathname;
const mediaPrefix = scopeDir + MEDIA_PATH;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Anything that is not our virtual path is not ours to touch.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(mediaPrefix)) return;

  let fileId = '';
  try {
    fileId = decodeURIComponent(url.pathname.slice(mediaPrefix.length));
  } catch {
    fileId = url.pathname.slice(mediaPrefix.length);
  }
  const size = Number(url.searchParams.get('size')) || 0;
  event.respondWith(proxy(event.request, fileId, size));
});

async function proxy(request, fileId, size) {
  if (!fileId) return problem(400, 'La dirección no trae el identificador del archivo de Drive.', fileId);

  let key = token || (await askClients('missing'));
  if (!key) {
    return problem(401, 'El reproductor no está conectado a Google Drive. Vuelve a conectar y prueba de nuevo.', fileId);
  }

  let upstream;
  try {
    upstream = await callDrive(fileId, request, key);
  } catch (err) {
    return problem(502, `No se pudo contactar con Google Drive: ${err.message || err}`, fileId);
  }

  // An hour-old token, or one dropped on the way. One renewal, one retry.
  if (upstream.status === 401) {
    token = null;
    const fresh = await askClients('stale');
    if (fresh) {
      key = fresh;
      try {
        upstream = await callDrive(fileId, request, key);
      } catch (err) {
        return problem(502, `No se pudo contactar con Google Drive: ${err.message || err}`, fileId);
      }
    }
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return problem(
      upstream.status,
      upstream.status === 401
        ? 'Google Drive rechazó la sesión. Vuelve a conectar tu cuenta.'
        : 'Tu cuenta no tiene permiso para leer ese archivo en Drive.',
      fileId
    );
  }
  if (upstream.status === 404) {
    return problem(404, 'Ese archivo ya no está en Drive, o se le quitó el acceso.', fileId);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return problem(upstream.status, `Google Drive respondió ${upstream.status} al pedir el video.`, fileId);
  }

  return relay(upstream, request, size);
}

function callDrive(fileId, request, key) {
  const url = `${DRIVE_MEDIA}${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const headers = new Headers({ Authorization: `Bearer ${key}` });

  // The whole reason this works: the browser's own Range goes upstream
  // untouched, so Drive answers with exactly the slice that was asked for.
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  return fetch(url, { method: 'GET', headers, credentials: 'omit', cache: 'no-store' });
}

/**
 * Upstream's answer, handed to the video element.
 *
 * The body is passed as a stream, never buffered. The headers have to be
 * rebuilt rather than forwarded: this is a cross-origin response, so the only
 * headers readable here are the CORS-safelisted ones. Content-Length and
 * Content-Type survive that filter; Content-Range and Accept-Ranges do not,
 * and those are precisely the two a seekable video needs — hence the
 * reconstruction below, using the file size the page put in the URL.
 */
function relay(upstream, request, size) {
  const headers = new Headers();

  const type = upstream.headers.get('Content-Type');
  headers.set('Content-Type', type && !type.startsWith('application/json') ? type : 'video/mp4');

  const length = upstream.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);

  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');

  let contentRange = upstream.headers.get('Content-Range');
  if (!contentRange && upstream.status === 206) {
    contentRange = buildContentRange(request.headers.get('Range'), length, size);
  }
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * "bytes 0-1048575/734003200", worked out from what was asked for and how much
 * came back. Without the total the video element can start playing but cannot
 * seek, so the size travels in the URL for the times Drive's own header is
 * filtered out by CORS.
 */
function buildContentRange(range, length, size) {
  const bytes = Number(length);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;

  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  const total = size > 0 ? String(size) : '*';

  let start = 0;
  if (m) {
    if (m[1]) start = Number(m[1]);
    // "bytes=-500" — the last 500 bytes, which is only locatable with a total.
    else if (m[2] && size > 0) start = Math.max(0, size - Number(m[2]));
  }
  return `bytes ${start}-${start + bytes - 1}/${total}`;
}

/**
 * A failure the page can actually read. The video element will only ever
 * report "network error", so the sentence goes out by postMessage as well and
 * app.js shows it on the failure screen.
 */
function problem(status, message, fileId) {
  tell({ type: 'drive-media-error', status, message, fileId });
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
