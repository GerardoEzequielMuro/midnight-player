import { Subtitles } from './subs.js';
import { parseSubtitle } from './lib/subtitles/index.js';
import { readTextFile } from './lib/decode.js';
import { buildLibrary, fromCache, toCache, orderOf } from './lib/library.js';
import {
  supported, hasDirectoryPicker, pickDirectory, ensurePermission,
  scanDirectory, entriesFromFileList, rootNameOf,
} from './lib/folder.js';
import {
  loadPrefs, savePrefs as writePrefs, getState, patchState,
  loadLibraryCache, saveLibraryCache,
  loadDirHandle, saveDirHandle, forgetDirHandle,
} from './lib/store.js';

/**
 * midnight-player, without the server.
 *
 * The server build asked an API for a library and streamed files back through
 * it. This one is handed a folder by the viewer and does the same work in the
 * tab: walk it, pair subtitles to video, decode and parse the subtitle files,
 * and hand the video element an object URL for a File. Nothing leaves the
 * device, and nothing needs to be running anywhere for it to work.
 *
 * The one thing that genuinely cannot be reproduced here is remuxing, so
 * containers a browser cannot decode are listed and named rather than silently
 * dropped.
 */

const $ = (sel) => document.querySelector(sel);

const el = {
  app: $('#app'),
  tree: $('#tree'),
  counts: $('#counts'),
  unmatched: $('#unmatched'),
  unmatchedWrap: $('#unmatched-wrap'),
  stage: $('#stage'),
  setup: $('#setup'),
  setupTitle: $('#setup-title'),
  setupBody: $('#setup-body'),
  setupAction: $('#setup-action'),
  setupNote: $('#setup-note'),
  setupError: $('#setup-error'),
  empty: $('#empty'),
  player: $('#player'),
  video: $('#video'),
  npTitle: $('#np-title'),
  fail: $('#fail'),
  failTitle: $('#fail-title'),
  failReason: $('#fail-reason'),
  resume: $('#resume'),
  resumeText: $('#resume-text'),
  resumeRestart: $('#resume-restart'),
  play: $('#btn-play'),
  time: $('#time'),
  scrub: $('#scrub'),
  scrubFill: $('#scrub-fill'),
  selPrimary: $('#sel-primary'),
  delayCtl: $('#delay-ctl'),
  delayVal: $('#delay-val'),
  stylePanel: $('#style-panel'),
  searchPanel: $('#search-panel'),
  searchInput: $('#search-input'),
  searchResults: $('#search-results'),
  searchCount: $('#search-count'),
  vol: $('#vol'),
  volCtl: $('#vol-ctl'),
  volIcon: $('#vol-icon'),
  helpPanel: $('#help-panel'),
  buffering: $('#buffering'),
  scrim: $('#scrim'),
  btnLibrary: $('#btn-library'),
  btnFolder: $('#btn-folder'),
  rescan: $('#rescan'),
  folderInput: $('#folder-input'),
};

const subs = new Subtitles(el.video, $('#sub-primary'));
const prefs = loadPrefs();

let titles = {};
let lib = null;        // what is on screen
let order = [];        // flat playing order, which N walks
let current = null;
let live = false;      // are the files in `lib` real, or a remembered shadow?
let rootHandle = null;
let objectUrl = null;
let pendingId = null;  // an episode asked for before the folder was open
let loadToken = 0;     // guards the async subtitle read against a fast switch

// ---------- layout ----------

/**
 * The width at which the library stops being a column and becomes a drawer over
 * the picture — kept in step with the last media query in style.css. A phone
 * held sideways is short rather than narrow, hence the second clause.
 */
const drawerMedia = matchMedia('(max-width: 600px), (max-height: 480px) and (orientation: landscape)');
const drawerMode = () => drawerMedia.matches;

function toggleSidebar(collapse) {
  const collapsed = el.app.classList.toggle('collapsed', collapse);
  // As a drawer it is a gesture, not a layout choice: remembering it would
  // decide how the desktop opens too.
  if (!drawerMode()) {
    prefs.sidebarCollapsed = collapsed;
    savePrefs();
  }
}

el.btnLibrary.addEventListener('click', () => toggleSidebar());
el.scrim.addEventListener('click', () => toggleSidebar(true));
$('#sidebar-close').addEventListener('click', () => toggleSidebar(true));

function showScreen(name) {
  el.setup.hidden = name !== 'setup';
  el.empty.hidden = name !== 'empty';
  el.player.hidden = name !== 'player';
  if (name !== 'player') el.fail.hidden = true;
}

// ---------- the setup screen ----------

// Defaulted rather than left empty: the screen in index.html is already the
// pick-a-folder screen, so its button has to work from the first paint —
// including on the run where boot() is still deciding what to say.
let setupAction = () => pickFolder();

/** One screen, one action. What changes between states is only the words. */
function showSetup({ title, body, action, note = '', onAction = null }) {
  el.setupTitle.textContent = title;
  el.setupBody.textContent = body;
  el.setupNote.textContent = note;
  el.setupNote.hidden = !note;
  el.setupError.hidden = true;
  el.setupAction.hidden = !action;
  if (action) el.setupAction.textContent = action;
  setupAction = onAction || (() => {});
  showScreen('setup');
  // On a phone the library is a drawer over the stage, so an empty one would
  // cover this screen with nothing. With episodes in it the drawer is the more
  // useful of the two and stays where it is.
  if (drawerMode() && !order.length) toggleSidebar(true);
}

function setupError(message) {
  el.setupError.textContent = message;
  el.setupError.hidden = false;
}

el.setupAction.addEventListener('click', () => setupAction());

const PRIVACY =
  'Esta página no tiene un servidor detrás. Tus videos y subtítulos se leen directamente de este dispositivo, ' +
  'se reproducen en esta pestaña y no se envían a ninguna parte: no hay adónde enviarlos.';

function setupPick() {
  showSetup({
    title: 'Elige la carpeta donde están tus episodios',
    body: PRIVACY,
    action: 'Elegir carpeta',
    note: hasDirectoryPicker
      ? 'La carpeta queda recordada, así que no vas a tener que buscarla la próxima vez.'
      : 'Este navegador no puede mantener una carpeta abierta entre visitas, así que te la va a pedir de nuevo. Lo que viste se sigue recordando.',
    onAction: pickFolder,
  });
}

/**
 * The returning-visitor case that matters. The handle is already here and the
 * folder is already known; the browser only wants a gesture before it hands the
 * files back. Showing the folder picker again would make the viewer find the
 * folder a second time for no reason, so this is one button that says Continue.
 */
function setupContinue(handle) {
  showSetup({
    title: 'Hola de nuevo',
    body: `Tu biblioteca está acá. Este navegador necesita un clic antes de volver a leer “${handle.name}”.`,
    action: 'Continue',
    note: PRIVACY,
    onAction: async () => {
      try {
        const state = await ensurePermission(handle, { prompt: true });
        if (state !== 'granted') {
          return setupError('No se dio el permiso, así que no se puede leer la carpeta. Usa Carpeta, arriba en la biblioteca, para elegirla otra vez.');
        }
        await useHandle(handle);
      } catch (err) {
        setupError(String(err.message || err));
      }
    },
  });
}

function setupRemembered() {
  showSetup({
    title: 'Tu biblioteca quedó guardada',
    body:
      'Los episodios, lo que viste y dónde lo dejaste siguen acá. Este navegador no puede retener una carpeta ' +
      'entre visitas, así que elige un episodio y te pedirá la carpeta una vez.',
    action: 'Elegir carpeta',
    note: PRIVACY,
    onAction: pickFolder,
  });
}

function setupUnsupported() {
  showSetup({
    title: 'Este navegador no puede abrir una carpeta',
    body:
      'Leer una carpeta necesita la API de acceso al sistema de archivos o un campo de carpeta, y este navegador no ' +
      'tiene ninguno de los dos, así que nada de esto va a funcionar. Un Chrome, Edge, Firefox o Safari reciente sí.',
    action: null,
  });
}

function askForFolder(reason) {
  showSetup({
    title: 'Abre la carpeta para reproducirlo',
    body: reason,
    action: 'Elegir carpeta',
    note: PRIVACY,
    onAction: pickFolder,
  });
}

// ---------- getting the folder ----------

async function pickFolder() {
  if (hasDirectoryPicker) {
    let handle;
    try {
      handle = await pickDirectory();
    } catch (err) {
      if (err?.name === 'AbortError') return; // they changed their mind
      return setupError(String(err.message || err));
    }
    await saveDirHandle(handle);
    await useHandle(handle);
    return;
  }
  el.folderInput.value = '';
  el.folderInput.click();
}

el.folderInput.addEventListener('change', async () => {
  const files = el.folderInput.files;
  if (!files || !files.length) return;
  const entries = entriesFromFileList(files);
  await useEntries(entries, rootNameOf(entries));
});

async function useHandle(handle) {
  rootHandle = handle;
  try {
    const entries = await scanDirectory(handle);
    await useEntries(entries, handle.name || '');
  } catch (err) {
    showScreen('setup');
    setupError(`No se pudo leer esa carpeta: ${err.message || err}`);
  }
}

async function useEntries(entries, folderName) {
  const built = buildLibrary(entries, titles);
  live = true;
  renderLibrary(built, folderName);
  saveLibraryCache(toCache(built, folderName));

  if (pendingId) {
    const id = pendingId;
    pendingId = null;
    if (order.find((e) => e.id === id)?.entry) return open(id);
    showScreen('setup');
    return setupError('Ese episodio no está en esta carpeta.');
  }
  // The folder is open and nothing is playing, so on a phone the list is now
  // the only thing worth looking at.
  if (drawerMode() && !current) toggleSidebar(false);
  showScreen(current ? 'player' : 'empty');
}

el.btnFolder.addEventListener('click', pickFolder);

el.rescan.addEventListener('click', async () => {
  el.rescan.textContent = 'Leyendo…';
  try {
    if (rootHandle) await useHandle(rootHandle);
    else await pickFolder();
  } finally {
    el.rescan.textContent = 'Releer';
  }
});

// ---------- library ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function subMarks(ep) {
  const n = ep.subs.length;
  if (!n) return '<span class="none">no subs</span>';
  return `${n} sub${n > 1 ? 's' : ''}`;
}

function epRow(ep) {
  const saved = getState(ep.id);
  const pct = saved.duration && saved.position ? Math.min(100, (saved.position / saved.duration) * 100) : 0;
  return (
    `<div class="ep${saved.watched ? ' watched' : ''}${current?.id === ep.id ? ' active' : ''}"` +
    ` data-id="${esc(ep.id)}" title="${esc(ep.label)} — ${esc(ep.file)}">` +
    `<span class="num">${esc(ep.tag || '')}</span>` +
    `<span class="name">${esc(ep.title)}</span>` +
    `<span class="marks">${subMarks(ep)}</span>` +
    `<span class="watch${saved.watched ? ' on' : ''}" data-watch="${esc(ep.id)}" title="Marcar como visto (W)">✓</span>` +
    '</div>' +
    (pct > 1 && pct < 97 ? `<div class="resume" style="width:calc(${pct}% - 28px)"></div>` : '')
  );
}

function renderLibrary(next, folderName) {
  lib = next;
  order = orderOf(lib);

  const bits = [`${lib.counts.episodes} episodes`, `${lib.counts.attached}/${lib.counts.subtitles} archivos de subtítulos vinculados`];
  if (!live) bits.push('folder not open');
  el.counts.textContent = bits.join(' · ');
  el.counts.title = folderName || '';
  el.app.classList.toggle('no-folder', !live);

  const html = [];
  for (const season of lib.seasons) {
    html.push(`<div class="season-title">Temporada ${season.number}</div>`);
    for (const ep of season.episodes) html.push(epRow(ep));
  }
  if (lib.loose.length) {
    html.push('<div class="season-title">Unsorted</div>');
    for (const ep of lib.loose) html.push(epRow(ep));
  }
  if (!html.length) html.push('<p class="empty-list hint">No .mp4, .m4v or .webm files were found in that folder.</p>');
  el.tree.innerHTML = html.join('');

  if (lib.unmatched.length) {
    el.unmatchedWrap.hidden = false;
    el.unmatched.innerHTML = lib.unmatched
      .map((u) => `<li>${esc(u.file)}<br><span class="why">${esc(u.reason)}</span></li>`)
      .join('');
  } else {
    el.unmatchedWrap.hidden = true;
  }

  el.tree.querySelectorAll('.ep').forEach((node) => node.addEventListener('click', () => open(node.dataset.id)));
  el.tree.querySelectorAll('.watch').forEach((node) =>
    node.addEventListener('click', (e) => {
      e.stopPropagation(); // the tick is inside the row; don't also open the episode
      const id = node.dataset.watch;
      setWatched(id, !getState(id).watched);
    })
  );
}

function setWatched(id, watched) {
  patchState(id, { watched });
  const row = el.tree.querySelector(`.ep[data-id="${CSS.escape(id)}"]`);
  row?.classList.toggle('watched', watched);
  row?.querySelector('.watch')?.classList.toggle('on', watched);
}

// ---------- opening an episode ----------

async function open(id) {
  const ep = order.find((e) => e.id === id);
  if (!ep) return;

  if (!ep.entry) {
    // A remembered library with no folder behind it. This is the one moment the
    // fallback browsers are asked for the folder — not on arrival.
    pendingId = id;
    return askForFolder(`“${ep.label}” está en tu biblioteca, pero la carpeta donde está todavía no se abrió. Elígela y empezará solo.`);
  }

  current = ep;
  el.tree.querySelectorAll('.ep').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  if (drawerMode()) toggleSidebar(true); // the drawer is covering what you just chose

  let file;
  try {
    file = await ep.entry.getFile();
  } catch (err) {
    return showFailure(ep, `No se pudo abrir el archivo: ${err.message || err}. Puede que lo hayan movido o renombrado; prueba con Releer.`);
  }

  showScreen('player');
  el.fail.hidden = true;
  el.npTitle.textContent = ep.label;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  el.video.src = objectUrl;

  const saved = getState(ep.id);
  // The tail that counts as "finished" is a share of the episode, capped: 25s
  // of credits on a 24-minute episode, but a flat 25s would make a short clip
  // impossible to resume at all.
  const tail = saved.duration ? Math.min(25, saved.duration * 0.05) : 0;
  const resumeAt = saved.position > 20 && saved.position < saved.duration - tail ? saved.position : 0;
  if (resumeAt) {
    el.video.addEventListener('loadedmetadata', () => { el.video.currentTime = resumeAt; }, { once: true });
  }
  el.video.play().catch(() => {});
  offerResume(resumeAt);
  buildTrackList(ep, saved);
}

function showFailure(ep, reason) {
  showScreen('player');
  el.fail.hidden = false;
  el.failTitle.textContent = ep.label;
  el.failReason.textContent = reason;
}

/**
 * Resuming is done, not asked about — being dropped back where you were is
 * almost always right. What is offered is the undo, for the times it is not.
 */
let resumeTimer;
function offerResume(seconds) {
  clearTimeout(resumeTimer);
  el.resume.hidden = !seconds;
  if (!seconds) return;
  el.resumeText.textContent = `Retomado en ${fmt(seconds)}`;
  resumeTimer = setTimeout(() => { el.resume.hidden = true; }, 9000);
}

el.resumeRestart.addEventListener('click', () => {
  el.video.currentTime = 0;
  el.resume.hidden = true;
  el.video.play().catch(() => {});
});

function nextEpisode() {
  if (!current) return;
  const next = order[order.indexOf(current) + 1];
  if (next) open(next.id);
}

// ---------- the subtitle track ----------

/**
 * One track per episode, chosen the way the server build chooses it: the
 * Spanish file — es-419 first — over the English one it was translated from,
 * and a file named after this exact video over anything marked ".retimed.".
 * The rest are still listed, because a wrong guess with no way to correct it is
 * worse than a menu; the menu just opens on the right entry.
 */
function buildTrackList(ep, saved) {
  el.selPrimary.innerHTML =
    '<option value="">None</option>' +
    ep.subs.map((s) => `<option value="${esc(s.path)}">${esc(s.name)}</option>`).join('');

  const remembered = ep.subs.find((s) => s.path === saved.subFile || s.name === saved.subFile);
  const pick = remembered || ep.subs[0];
  selectTrack(pick ? pick.path : '');
}

async function selectTrack(path) {
  const token = ++loadToken;
  el.selPrimary.value = path || '';
  const ep = current;
  if (!ep) return;
  const track = ep.subs.find((s) => s.path === path);

  if (!track || !track.entry) {
    subs.set(null);
    el.searchCount.textContent = track ? 'Ese archivo de subtítulos no está abierto: presiona Releer.' : '';
  } else {
    try {
      const text = await readTextFile(await track.entry.getFile());
      const cues = parseSubtitle(track.name, text);
      if (token !== loadToken) return; // a faster hand already chose something else
      subs.set(cues);
      el.searchCount.textContent = cues.length ? '' : 'Ese archivo no contiene ningún subtítulo.';
    } catch (err) {
      if (token !== loadToken) return;
      subs.set(null);
      el.searchCount.textContent = `No se pudo leer ese archivo de subtítulos: ${err.message || err}`;
    }
  }

  if (token !== loadToken) return;
  subs.setDelay(getState(ep.id).delays?.[path] || 0);
  runSearch();
  persistSubPrefs();
}

el.selPrimary.addEventListener('change', () => selectTrack(el.selPrimary.value));

function cycleTrack() {
  const values = [...el.selPrimary.options].map((o) => o.value);
  if (values.length < 2) return;
  const idx = values.indexOf(el.selPrimary.value);
  selectTrack(values[(idx + 1) % values.length]);
}

subs.onDelayChange = (value) => {
  el.delayVal.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(2)}s`;
  el.delayCtl.classList.toggle('shifted', Math.abs(value) > 0.001);
  persistSubPrefs();
};

let persistTimer;
function persistSubPrefs() {
  if (!current) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const path = el.selPrimary.value || null;
    const saved = getState(current.id);
    patchState(current.id, {
      subFile: path,
      delays: path ? { ...(saved.delays || {}), [path]: subs.delay } : saved.delays || {},
    });
  }, 400);
}

el.delayCtl.addEventListener('click', (e) => {
  const step = e.target.dataset?.step;
  if (step) subs.nudge(Number(step));
});
$('#delay-reset').addEventListener('click', () => subs.setDelay(0));

// ---------- transport ----------

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

el.play.addEventListener('click', () => (el.video.paused ? el.video.play() : el.video.pause()));
el.video.addEventListener('play', () => (el.play.textContent = 'Pausa'));
el.video.addEventListener('pause', () => (el.play.textContent = 'Reproducir'));
el.video.addEventListener('click', () => {
  if (revealTap) return (revealTap = false); // that tap was for the controls
  el.video.paused ? el.video.play() : el.video.pause();
});

el.scrub.addEventListener('click', (e) => {
  const rect = el.scrub.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  if (Number.isFinite(el.video.duration)) el.video.currentTime = ratio * el.video.duration;
});

el.video.addEventListener('timeupdate', () => {
  el.time.textContent = `${fmt(el.video.currentTime)} / ${fmt(el.video.duration)}`;
  if (Number.isFinite(el.video.duration)) {
    el.scrubFill.style.width = `${(el.video.currentTime / el.video.duration) * 100}%`;
    // Counted as watched near the end rather than only at the very end, since
    // most people stop during the credits and never reach 'ended'.
    if (current && !getState(current.id).watched && el.video.currentTime / el.video.duration > 0.9) {
      setWatched(current.id, true);
    }
  }
  saveProgress();
});

el.video.addEventListener('error', () => {
  if (!current) return;
  const codes = {
    1: 'the load was aborted',
    2: 'the file could not be read',
    3: 'the browser could not decode it',
    4: 'the browser does not support this format',
  };
  showFailure(current, `Falló la reproducción: ${codes[el.video.error?.code] || 'error desconocido'}.`);
});

let lastSave = 0;
function saveProgress(force = false) {
  if (!current) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  if (!Number.isFinite(el.video.currentTime)) return;
  patchState(current.id, {
    position: el.video.currentTime,
    duration: Number.isFinite(el.video.duration) ? el.video.duration : 0,
  });
}

el.video.addEventListener('ended', () => {
  if (!current) return;
  patchState(current.id, { position: 0, duration: el.video.duration || 0 });
  setWatched(current.id, true);
  nextEpisode();
});

/**
 * localStorage writes synchronously, so unlike the server build there is no
 * beacon to fire — but the last few seconds before the tab goes away are still
 * the ones you need when you come back, so they are flushed on the way out.
 */
function flush() {
  if (!current || !Number.isFinite(el.video.currentTime) || el.video.currentTime < 1) return;
  saveProgress(true);
}
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

// A stalled video with no indicator is indistinguishable from a broken one.
for (const ev of ['waiting', 'stalled']) el.video.addEventListener(ev, () => (el.buffering.hidden = false));
for (const ev of ['playing', 'canplay', 'seeked', 'pause']) el.video.addEventListener(ev, () => (el.buffering.hidden = true));

// ---------- search ----------

function runSearch() {
  const q = el.searchInput.value;
  const results = subs.search(q);
  if (q.trim()) el.searchCount.textContent = `${results.length} línea${results.length === 1 ? '' : 's'}`;
  el.searchResults.innerHTML = results
    .map((r) => `<li data-t="${r.time}"><span class="t">${fmt(r.time)}</span><span>${esc(r.text)}</span></li>`)
    .join('');
  el.searchResults.querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => {
      el.video.currentTime = Math.max(0, Number(li.dataset.t) - 0.4);
      el.video.play().catch(() => {});
    })
  );
}
el.searchInput.addEventListener('input', runSearch);

$('#btn-search').addEventListener('click', () => togglePanel(el.searchPanel, () => el.searchInput.focus()));
$('#btn-style').addEventListener('click', () => togglePanel(el.stylePanel));
$('#btn-help').addEventListener('click', () => togglePanel(el.helpPanel));
$('#btn-full').addEventListener('click', () => toggleFullscreen());

function togglePanel(panel, after) {
  const showing = panel.hidden;
  el.searchPanel.hidden = true;
  el.stylePanel.hidden = true;
  el.helpPanel.hidden = true;
  panel.hidden = !showing;
  if (showing && after) after();
}

function toggleFullscreen() {
  document.fullscreenElement ? document.exitFullscreen() : el.stage.requestFullscreen?.();
}

// ---------- style and session preferences ----------

const styleInputs = {
  size: $('#st-size'),
  bottom: $('#st-bottom'),
  bgOpacity: $('#st-bg'),
  color: $('#st-color'),
  outline: $('#st-outline'),
};

function applyStyleInputs() {
  subs.setStyle({
    size: Number(styleInputs.size.value),
    bottom: Number(styleInputs.bottom.value),
    bgOpacity: Number(styleInputs.bgOpacity.value),
    color: styleInputs.color.value,
    outline: styleInputs.outline.checked,
  });
  prefs.subtitleStyle = { ...subs.style };
  savePrefs();
}
for (const input of Object.values(styleInputs)) input.addEventListener('input', applyStyleInputs);

let prefsTimer;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => writePrefs(prefs), 300);
}

function applyVolume() {
  el.video.volume = prefs.volume;
  el.video.muted = prefs.muted;
  el.vol.value = prefs.volume;
  el.volCtl.classList.toggle('muted', prefs.muted || prefs.volume === 0);
}

function setVolume(v, { unmute = true } = {}) {
  prefs.volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  if (unmute && prefs.volume > 0) prefs.muted = false;
  applyVolume();
  savePrefs();
}

el.vol.addEventListener('input', () => setVolume(Number(el.vol.value)));
el.volIcon.addEventListener('click', () => {
  prefs.muted = !prefs.muted;
  applyVolume();
  savePrefs();
});

// ---------- chrome + keys ----------

let uiTimer;
let uiUntil = 0;

function showUi(hold) {
  const until = Date.now() + hold;
  // A tap is followed by a synthetic mousemove, which would otherwise cut the
  // touch reveal back down to the mouse's 2.4s. The longer claim wins.
  if (until < uiUntil) return;
  uiUntil = until;
  el.stage.classList.add('show-ui');
  el.stage.style.cursor = '';
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    uiUntil = 0;
    el.stage.classList.remove('show-ui');
    // The pointer goes with the controls. A cursor parked over the picture is
    // the one thing left on screen once everything else has faded out.
    el.stage.style.cursor = 'none';
  }, hold);
}

el.stage.addEventListener('mousemove', () => showUi(2400));

// A finger has no idle position to read, so the bar has to be summoned by a tap
// and then given long enough to actually be used.
let revealTap = false;
el.stage.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse') return;
    // A tap on a hidden bar asks for the bar. Only the next one is play/pause.
    revealTap = !el.stage.classList.contains('show-ui');
    showUi(5200);
  },
  { passive: true }
);

document.addEventListener('keydown', (e) => {
  // e.target is not always an Element (it can be the document), and Document
  // has no .matches — guard before asking, or every shortcut dies on a throw.
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const v = el.video;
  const k = e.key.toLowerCase();

  // Delay: base 0.25s, Shift for 1s, Alt for fine 0.05s. Works on "," / "."
  // and on the shifted glyphs those keys produce.
  if ([',', '<', '.', '>'].includes(e.key)) {
    e.preventDefault();
    const dir = e.key === ',' || e.key === '<' ? -1 : 1;
    const step = e.shiftKey ? 1 : e.altKey ? 0.05 : 0.25;
    return subs.nudge(dir * step);
  }

  if (k === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime += e.shiftKey ? 10 : 5; }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime -= e.shiftKey ? 10 : 5; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(prefs.volume + 0.05); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(prefs.volume - 0.05, { unmute: false }); }
  else if (k === 'm') { prefs.muted = !prefs.muted; applyVolume(); savePrefs(); }
  else if (k === 'w') { if (current) setWatched(current.id, !getState(current.id).watched); }
  else if (e.key === '?') { e.preventDefault(); togglePanel(el.helpPanel); }
  else if (k === '0') { subs.setDelay(0); }
  else if (k === 'v') { cycleTrack(); }
  else if (k === 'f') { toggleFullscreen(); }
  else if (k === 'b') { toggleSidebar(); }
  else if (k === 'n') { nextEpisode(); }
  else if (e.key === '/') { e.preventDefault(); togglePanel(el.searchPanel, () => el.searchInput.focus()); }
  else if (e.key === 'Escape') { el.searchPanel.hidden = true; el.stylePanel.hidden = true; el.helpPanel.hidden = true; }
});

// ---------- start ----------

async function loadTitles() {
  try {
    const res = await fetch(new URL('./episode-titles.json', import.meta.url));
    return res.ok ? await res.json() : {};
  } catch {
    // Without the map every episode falls back to its file name, which is a
    // plainer library rather than a broken one.
    return {};
  }
}

async function boot() {
  Object.assign(subs.style, prefs.subtitleStyle);
  styleInputs.size.value = subs.style.size;
  styleInputs.bottom.value = subs.style.bottom;
  styleInputs.bgOpacity.value = subs.style.bgOpacity;
  styleInputs.color.value = subs.style.color;
  styleInputs.outline.checked = subs.style.outline;
  subs.applyStyle();
  applyVolume();
  subs.onDelayChange(0);

  if (prefs.sidebarCollapsed && !drawerMode()) el.app.classList.add('collapsed');

  titles = await loadTitles();

  // Whatever was remembered goes up first, so a returning visitor sees their
  // episodes — titles, ticks and resume marks — while the folder is re-opened
  // behind them, and sees them at all if it never is.
  const cache = loadLibraryCache();
  const cached = fromCache(cache);
  if (cached) renderLibrary(cached, cache.folderName);

  if (!supported) return setupUnsupported();

  if (hasDirectoryPicker) {
    let handle = null;
    try {
      handle = await loadDirHandle();
    } catch {
      handle = null;
    }
    if (handle) {
      let state = 'denied';
      try {
        state = await ensurePermission(handle);
      } catch {
        state = 'denied';
      }
      if (state === 'granted') return useHandle(handle);
      // 'prompt' needs a gesture the page cannot manufacture. One button.
      if (state === 'prompt') return setupContinue(handle);
      await forgetDirHandle();
    }
    return setupPick();
  }

  // webkitdirectory: nothing about the folder survives, only the library did.
  return cached ? setupRemembered() : setupPick();
}

boot().catch((err) => {
  console.error(err);
  setupError(String(err.message || err));
});
