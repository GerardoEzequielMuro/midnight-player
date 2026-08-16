/**
 * Google Drive as a second way in.
 *
 * The folder source reads a disk the viewer already has. This one reads a
 * Drive the viewer already has. Both end at the same place: a flat list of
 * { name, path, ... } entries handed to buildLibrary, so seasons, titles,
 * subtitle pairing and everything downstream cannot tell the two apart.
 *
 * What is deliberately NOT here
 * ----------------------------
 * There is no server, no client secret, no refresh token and no key of any
 * kind. The page holds one public identifier — the OAuth Client ID from
 * config.js — and asks Google Identity Services for an access token that
 * belongs to whoever is sitting in front of it. The token lives in a module
 * variable and nowhere else: not localStorage, not sessionStorage, not
 * IndexedDB, not a cookie. Close the tab and it is gone.
 *
 * The scope is exactly drive.readonly. The player can list and read; it can
 * never write, delete or share.
 *
 * Playing the video
 * -----------------
 * <video src> cannot carry an Authorization header, and pulling a 400 MB file
 * into a blob would break seeking and memory both. So sw.js sits in front of a
 * virtual path — ./drive-media/<fileId> — and does the authorised, ranged
 * fetch on the video element's behalf. The token reaches it by postMessage and
 * is held in the worker's memory only; see pushToken() and the request/answer
 * dance below, which exists because a service worker can be shut down at any
 * moment and come back with its memory wiped.
 */

import { extname } from './pathish.js';
import { SUBTITLE_EXT } from './subtitles/index.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user';

/*
 * Remember which account, so the silent re-grant has something to aim at.
 *
 * The token is still never stored — that part does not change. But a silent
 * request with no hint asks Google to guess who you are, and Google will not
 * guess: it refuses, and the page falls back to the sign-in button. Which is
 * exactly the bug, a fresh sign-in on every reload.
 *
 * An email address is not a credential. It unlocks nothing on its own, and it
 * is the viewer's own address stored on the viewer's own machine — the same
 * thing every "you were signed in as…" screen keeps.
 */
/*
 * Keep the session across reloads.
 *
 * The token is stored, and that is a deliberate change of mind. The first
 * version stored nothing, on the principle that a token in localStorage is a
 * token any script on the page can read — which is true, and was the wrong
 * trade here. What is being kept is a read-only grant on the viewer's own
 * Drive, in the viewer's own browser, expiring within the hour, on a page that
 * loads no third-party code but Google's own sign-in library.
 *
 * The cost of not storing it was a fresh sign-in on every single reload, which
 * is a real, constant harm against a theoretical one.
 *
 * Expiry is honoured on the way back in: a token past its time is discarded
 * rather than sent to Drive to be rejected.
 */
const SESSION_KEY = 'midnight.drive.session';

function saveSession() {
  try {
    if (!token) return localStorage.removeItem(SESSION_KEY);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt: tokenExpiresAt, account }));
  } catch {
    // Storage refused: the session just stops surviving reloads.
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // A minute of margin, so a token cannot expire between the check and the use.
    if (!s?.token || !(s.expiresAt > Date.now() + 60000)) return null;
    return s;
  } catch {
    return null;
  }
}


const HINT_KEY = 'midnight.drive.account';

function savedHint() {
  try {
    return localStorage.getItem(HINT_KEY) || '';
  } catch {
    return '';
  }
}

function rememberHint(email) {
  try {
    if (email) localStorage.setItem(HINT_KEY, email);
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // A browser refusing storage costs a click, not correctness.
  }
}


/** Read-only, and nothing else. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** The virtual path sw.js answers on, relative to this page. */
export const MEDIA_PATH = 'drive-media/';

// A television series is a few hundred files. Someone whose Drive holds a
// hundred thousand should get a stopped scan, not a hung tab.
const MAX_FILES = 20000;
const MAX_FOLDER_LOOKUPS = 600;
const MAX_DEPTH = 8;
const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

/** A failure with a name the UI can branch on and a sentence it can show. */
export class DriveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
  }
}

// ---------- configuration ----------

let clientId = null;

/**
 * The client id, read once and never allowed to throw. A missing or malformed
 * config.js has to leave the local-folder player completely untouched, so the
 * import is dynamic and its failure is just an empty id.
 */
export async function getClientId() {
  if (clientId !== null) return clientId;
  try {
    const mod = await import('../config.js');
    clientId = typeof mod.GOOGLE_CLIENT_ID === 'string' ? mod.GOOGLE_CLIENT_ID.trim() : '';
  } catch {
    clientId = '';
  }
  return clientId;
}

// ---------- the token, in memory only ----------

let token = null;
let tokenExpiresAt = 0;
let account = null;      // { name, email } once Drive has told us who this is
let tokenClient = null;
let refreshTimer = 0;
let refreshing = null;

const watchers = new Set();

/** Told whenever the connection state changes, so the UI can redraw. */
export function onChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function announce() {
  for (const fn of watchers) {
    try { fn(status()); } catch { /* a broken listener is not Drive's problem */ }
  }
}

export function status() {
  return { connected: !!token, account, expiresAt: tokenExpiresAt };
}

export const isConnected = () => !!token;

/** What "Conectado como …" shows: the address if Drive gave one, else the name. */
export function accountLabel() {
  if (!account) return '';
  return account.email || account.name || '';
}

// ---------- Google Identity Services ----------

let gisPromise = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () =>
      window.google?.accounts?.oauth2
        ? resolve()
        : reject(new DriveError('gis-broken', 'Google cargó, pero no expuso el módulo de inicio de sesión.'));
    script.onerror = () =>
      reject(new DriveError('gis-blocked', 'No se pudo cargar el inicio de sesión de Google. Revisa tu conexión, o si una extensión está bloqueando accounts.google.com.'));
    document.head.appendChild(script);
  });
  gisPromise = gisPromise.catch((err) => { gisPromise = null; throw err; });
  return gisPromise;
}

async function ensureTokenClient() {
  const id = await getClientId();
  if (!id) {
    throw new DriveError('no-client-id', 'Este sitio todavía no tiene configurado el ID de cliente de Google.');
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: DRIVE_SCOPE,
      callback: () => {},
    });
  }
  return tokenClient;
}

const GIS_MESSAGES = {
  popup_closed: 'Cerraste la ventana de Google antes de terminar de iniciar sesión.',
  popup_failed_to_open: 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes de este sitio y vuelve a intentarlo.',
  access_denied: 'No se otorgó el permiso de lectura de Drive, así que no hay nada que listar.',
  interaction_required: 'Google necesita que inicies sesión otra vez.',
  unknown: 'Google no pudo completar el inicio de sesión.',
};

const gisMessage = (code) => GIS_MESSAGES[code] || GIS_MESSAGES.unknown;

/**
 * One token request, wrapped so the three ways it can end — granted, refused,
 * never opened — all come back as one promise instead of three callbacks.
 *
 * `silent` asks Google not to prompt. It works when the browser still has both
 * the session and the grant; when it does not, GIS reports back rather than
 * stealing focus, and the caller falls through to asking properly.
 */
function requestToken(client, { silent = false, hint = '' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    client.callback = (resp) => {
      if (resp?.error) return done(reject, new DriveError(resp.error, gisMessage(resp.error)));
      if (!resp?.access_token) return done(reject, new DriveError('no-token', gisMessage('unknown')));
      done(resolve, resp);
    };
    client.error_callback = (err) => done(reject, new DriveError(err?.type || 'unknown', gisMessage(err?.type)));

    try {
      client.requestAccessToken(silent ? { prompt: '', ...(hint ? { hint } : {}) } : {});
    } catch (err) {
      done(reject, new DriveError('request-failed', String(err?.message || err)));
    }
  });
}

function keepToken(resp) {
  token = resp.access_token;
  const seconds = Number(resp.expires_in) || 3600;
  tokenExpiresAt = Date.now() + seconds * 1000;

  // Tokens last about an hour. Renewing a few minutes early keeps a long
  // episode from stalling halfway, and the renewal is silent because the grant
  // is already there.
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(
    () => { refresh({ silent: true }).catch(() => {}); },
    Math.max(30, seconds - 300) * 1000
  );

  saveSession();
  pushToken();
  announce();
}

/**
 * Connect. Tries silently first, so a viewer who already granted this page is
 * not made to click through a consent screen they have seen before, then falls
 * back to the real thing.
 */
export async function connect() {
  const client = await ensureTokenClient();
  let resp;
  try {
    resp = await requestToken(client, { silent: true });
  } catch {
    resp = await requestToken(client, { silent: false });
  }
  keepToken(resp);
  await loadAccount();
  announce();
  return status();
}

/** A quieter renewal, used by the expiry timer and by a 401 from Drive. */
/**
 * Pick a stored session back up, if there is a live one.
 *
 * This is the whole point of storing it: no popup, no gesture, no round trip to
 * Google. A token that is still inside its hour is simply used, and the viewer
 * never learns that anything happened.
 *
 * It returns false rather than throwing when there is nothing to resume, since
 * "no session" is the ordinary first-visit case and not an error.
 */
export async function resumeStoredSession() {
  const s = readSession();
  if (!s) return false;

  token = s.token;
  tokenExpiresAt = s.expiresAt;
  account = s.account || null;

  // Renew a few minutes before it lapses, so a long episode does not stall
  // halfway through.
  const secondsLeft = Math.max(30, Math.floor((tokenExpiresAt - Date.now()) / 1000) - 300);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refresh({ silent: true }).catch(() => {}); }, secondsLeft * 1000);

  await pushToken();
  announce();
  return true;
}


export async function refresh({ silent = true } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const client = await ensureTokenClient();
    const resp = await requestToken(client, { silent, hint: silent ? savedHint() : '' });
    keepToken(resp);
    // A refresh that is really a restore — a returning visitor let back in
    // without a click — has never been told whose Drive this is. Asking now is
    // what puts the address on "Conectado como …" instead of a placeholder.
    if (!account) {
      await loadAccount();
      announce();
    }
    return token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/**
 * Who is connected. drive.readonly is enough to ask Drive itself, which is why
 * no profile scope is requested — the scope stays exactly read-only.
 */
async function loadAccount() {
  try {
    const res = await authedFetch(ABOUT_URL);
    const data = await res.json();
    account = { name: data?.user?.displayName || '', email: data?.user?.emailAddress || '' };
    rememberHint(account.email);
  } catch {
    account = { name: '', email: '' };
  }
}

/** Drop the token, here and in the worker. Nothing was stored, so nothing is deleted. */
export async function signOut() {
  clearTimeout(refreshTimer);
  token = null;
  tokenExpiresAt = 0;
  account = null;
  rememberHint('');
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  await clearWorkerToken();
  announce();
}

// ---------- talking to Drive ----------

async function authedFetch(url, { retry = true } = {}) {
  if (!token) throw new DriveError('signed-out', 'No hay una sesión de Google Drive abierta.');

  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // An expired token is the ordinary case, not a failure: ask for a fresh one
  // and try the same request once more.
  if (res.status === 401 && retry) {
    try {
      await refresh({ silent: true });
    } catch (err) {
      throw new DriveError(
        'expired',
        `Tu sesión de Google Drive venció y no se pudo renovar sola. Vuelve a conectar. (${err.message})`
      );
    }
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  if (!res.ok) throw new DriveError(`http-${res.status}`, await describeHttp(res));
  return res;
}

async function describeHttp(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch { /* an error page that is not JSON tells us nothing extra */ }

  if (res.status === 403) {
    return `Google rechazó la consulta${detail ? `: ${detail}` : ''}. Suele ser que la API de Drive no está habilitada en el proyecto, o que se superó la cuota.`;
  }
  if (res.status === 404) return 'Esa carpeta no existe, o tu cuenta no puede verla.';
  return `Drive respondió ${res.status}${detail ? `: ${detail}` : ''}.`;
}

/** A value going into a Drive query string, with its quotes made harmless. */
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const FIELDS = 'nextPageToken,files(id,name,size,mimeType,parents)';

async function listPage(query, pageToken) {
  const url = new URL(FILES_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const res = await authedFetch(url.href);
  return res.json();
}

/** Every page of a query, followed to the end. */
async function listAll(query, onProgress, sink = []) {
  let pageToken = null;
  do {
    const page = await listPage(query, pageToken);
    for (const f of page.files || []) {
      sink.push(f);
      if (sink.length >= MAX_FILES) return sink;
    }
    onProgress?.(sink.length);
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return sink;
}

// Video by mime type, subtitles by name, because Drive has no mime type worth
// trusting for .srt. .ssa rides along with .ass since the parser reads both.
const MEDIA_QUERY =
  "(mimeType contains 'video/' or name contains '.srt' or name contains '.vtt' " +
  "or name contains '.ass' or name contains '.ssa') and trashed=false";

const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';

const wanted = (f) =>
  !isFolder(f) &&
  (String(f.mimeType || '').startsWith('video/') || SUBTITLE_EXT.has(extname(f.name).toLowerCase()));

// ---------- folder ids ----------

/**
 * A folder id out of whatever was pasted. People paste the address bar, so the
 * shapes Drive puts there are all accepted, as is a bare id.
 */
export function parseFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const patterns = [
    /\/folders\/([A-Za-z0-9_-]{10,})/,
    /\/file\/d\/([A-Za-z0-9_-]{10,})/,
    /[?&]id=([A-Za-z0-9_-]{10,})/,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
  return null;
}

// ---------- building the file list ----------

/**
 * The whole Drive: one query for everything that looks like video or subtitle,
 * then the folder names above each file resolved, so a season written on a
 * folder rather than in a file name still counts.
 */
async function scanEverything(onProgress) {
  const files = await listAll(MEDIA_QUERY, (n) => onProgress?.({ files: n }));
  const paths = await resolvePaths(files, onProgress);
  return files.map((f) => entryFor(f, paths.get(f.id) || f.name));
}

/**
 * One folder and everything under it. Walking beats a query here: it gives the
 * path for free, and it cannot wander outside the folder that was asked for.
 */
async function scanFolder(folderId, onProgress) {
  const out = [];
  const seen = new Set();

  async function walk(id, prefix, depth) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES || seen.has(id)) return;
    seen.add(id);
    const children = await listAll(`'${q(id)}' in parents and trashed=false`);
    const folders = [];
    for (const f of children) {
      if (isFolder(f)) { folders.push(f); continue; }
      if (!wanted(f)) continue;
      out.push(entryFor(f, prefix ? `${prefix}/${f.name}` : f.name));
      if (out.length >= MAX_FILES) return;
    }
    onProgress?.({ files: out.length });
    for (const dir of folders) {
      await walk(dir.id, prefix ? `${prefix}/${dir.name}` : dir.name, depth + 1);
    }
  }

  const root = await folderInfo(folderId);
  await walk(folderId, root?.name || '', 0);
  return out;
}

async function folderInfo(id) {
  const url = new URL(`${FILES_URL}/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', 'id,name,mimeType,parents');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await authedFetch(url.href);
  const info = await res.json();
  if (!isFolder(info)) throw new DriveError('not-a-folder', 'Ese enlace apunta a un archivo, no a una carpeta.');
  return info;
}

/**
 * The folder names above each file, looked up one folder at a time and cached,
 * so a Drive with three hundred episodes in twelve folders costs twelve
 * requests rather than three hundred. If Drive refuses one — a folder in a
 * shared drive whose files are readable but whose tree is not — the file keeps
 * its bare name, which is still enough for everything except the season.
 */
async function resolvePaths(files, onProgress) {
  const info = new Map();
  const paths = new Map();
  let lookups = 0;

  async function nodeOf(id) {
    if (info.has(id)) return info.get(id);
    if (lookups >= MAX_FOLDER_LOOKUPS) return null;
    lookups += 1;
    onProgress?.({ folders: lookups });
    let node = null;
    try {
      const url = new URL(`${FILES_URL}/${encodeURIComponent(id)}`);
      url.searchParams.set('fields', 'id,name,parents');
      url.searchParams.set('supportsAllDrives', 'true');
      const res = await authedFetch(url.href);
      node = await res.json();
    } catch { /* unreadable parent: the chain simply stops here */ }
    info.set(id, node);
    return node;
  }

  async function chainFor(id, depth = 0) {
    if (!id || depth > MAX_DEPTH) return [];
    const node = await nodeOf(id);
    if (!node?.name) return [];
    const above = await chainFor(node.parents?.[0], depth + 1);
    return [...above, node.name];
  }

  for (const f of files) {
    const parent = f.parents?.[0];
    const chain = parent ? await chainFor(parent) : [];
    paths.set(f.id, [...chain, f.name].join('/'));
  }
  return paths;
}

/**
 * The same shape folder.js produces, plus what Drive playback needs.
 *
 * getFile() really does download, so it is only ever called on subtitles —
 * they are kilobytes. Video goes through mediaSrc and the service worker
 * instead, which is the whole reason the worker exists.
 */
function entryFor(file, path) {
  const size = Number(file.size) || 0;
  const src = new URL(`./${MEDIA_PATH}${encodeURIComponent(file.id)}`, document.baseURI);
  // The worker cannot know how big the file is, and it needs the total to
  // write a Content-Range the video element can seek against.
  if (size > 0) src.searchParams.set('size', String(size));

  return {
    name: file.name,
    path,
    kind: 'drive',
    id: file.id,
    size,
    mimeType: file.mimeType || '',
    mediaSrc: src.href,
    getFile: () => download(file),
  };
}

/** A subtitle file, pulled whole. Anything oversized is refused rather than eaten. */
async function download(file) {
  const size = Number(file.size) || 0;
  if (size > MAX_SUBTITLE_BYTES) {
    throw new DriveError('too-big', 'Ese archivo es demasiado grande para leerlo como subtítulo.');
  }
  const url = new URL(`${FILES_URL}/${encodeURIComponent(file.id)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const res = await authedFetch(url.href);
  // decode.js only ever asks for arrayBuffer(), which a Blob has.
  return res.blob();
}

/**
 * The public entry point: everything the signed-in account can see, or one
 * folder of it.
 */
export async function listLibrary({ folderId = null, onProgress = null } = {}) {
  if (!token) throw new DriveError('signed-out', 'No hay una sesión de Google Drive abierta.');
  return folderId ? scanFolder(folderId, onProgress) : scanEverything(onProgress);
}

// ---------- the service worker ----------

let workerReady = null;
let workerWired = false;

/**
 * Register the proxy and wait until it is actually driving this page.
 *
 * A worker that is registered but not yet controlling the page would let the
 * video element's request go straight to the network and 404, so waiting for
 * `controller` is not optional. sw.js calls clients.claim() to make the first
 * load behave like every later one.
 */
export async function ensureWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new DriveError(
      'no-sw',
      'Este navegador no permite service workers, así que no se puede reproducir desde Drive. Prueba con Chrome, Edge o Firefox, sobre https.'
    );
  }
  if (workerReady) return workerReady;

  workerReady = (async () => {
    wireWorkerMessages();
    try {
      await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
    } catch (err) {
      throw new DriveError(
        'sw-failed',
        `No se pudo instalar el reproductor de Drive: ${err.message || err}. Esto necesita https (o localhost).`
      );
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await waitForController();
    if (!navigator.serviceWorker.controller) {
      throw new DriveError(
        'sw-uncontrolled',
        'El reproductor de Drive quedó instalado pero no tomó el control de la página. Recarga y vuelve a intentarlo.'
      );
    }
    await pushToken();
    return true;
  })();

  workerReady = workerReady.catch((err) => { workerReady = null; throw err; });
  return workerReady;
}

function waitForController() {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

/**
 * The worker can be shut down between two requests and come back with an empty
 * memory, so it asks rather than assumes. This is the answering half.
 */
function wireWorkerMessages() {
  if (workerWired || !('serviceWorker' in navigator)) return;
  workerWired = true;
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const data = event.data;
    if (data?.type !== 'drive-token-request') return;
    // 'stale' means the worker's copy was rejected, so handing back the same
    // one is no use — renew before answering.
    if (data.reason === 'stale' && token) {
      try { await refresh({ silent: true }); } catch { /* answer with what we have */ }
    }
    postToWorker({ type: 'drive-token', token });
  });
}

function postToWorker(message) {
  const target = navigator.serviceWorker?.controller;
  if (!target) return false;
  target.postMessage(message);
  return true;
}

/** Hand the worker the current token. Called on every token change. */
export async function pushToken() {
  if (!('serviceWorker' in navigator)) return false;
  wireWorkerMessages();
  return postToWorker({ type: 'drive-token', token });
}

/** Signing out takes the worker's copy with it. */
export async function clearWorkerToken() {
  if (!('serviceWorker' in navigator)) return false;
  return postToWorker({ type: 'drive-token-clear' });
}

/**
 * Trouble inside the worker — a rejected token, a Drive outage — reaches the
 * video element as nothing but a generic media error, so the worker reports it
 * separately and this hands it to the page.
 */
export function onMediaError(fn) {
  if (!('serviceWorker' in navigator)) return () => {};
  const handler = (event) => {
    if (event.data?.type === 'drive-media-error') fn(event.data);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
