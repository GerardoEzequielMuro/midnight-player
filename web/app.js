import { Subtitles } from './subs.js';

const $ = (sel) => document.querySelector(sel);
const api = (p, opts) => fetch(`/api${p}`, opts).then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })));

const el = {
  app: $('#app'),
  tree: $('#tree'),
  counts: $('#counts'),
  unmatched: $('#unmatched'),
  unmatchedWrap: $('#unmatched-wrap'),
  stage: $('#stage'),
  empty: $('#empty'),
  player: $('#player'),
  video: $('#video'),
  npTitle: $('#np-title'),
  npMode: $('#np-mode'),
  prep: $('#prep'),
  prepTitle: $('#prep-title'),
  prepReason: $('#prep-reason'),
  prepBar: $('#prep-bar'),
  prepPct: $('#prep-pct'),
  play: $('#btn-play'),
  time: $('#time'),
  scrub: $('#scrub'),
  scrubFill: $('#scrub-fill'),
  selPrimary: $('#sel-primary'),
  selSecondary: $('#sel-secondary'),
  delayCtl: $('#delay-ctl'),
  delayVal: $('#delay-val'),
  stylePanel: $('#style-panel'),
  searchPanel: $('#search-panel'),
  searchInput: $('#search-input'),
  searchResults: $('#search-results'),
  searchCount: $('#search-count'),
  selAudio: $('#sel-audio'),
  audioCtl: $('#audio-ctl'),
  alignPanel: $('#align-panel'),
  alignRun: $('#align-run'),
  alignEngine: $('#align-engine'),
  alignProgress: $('#align-progress'),
  alignBar: $('#align-bar'),
  alignStage: $('#align-stage'),
  alignResult: $('#align-result'),
  alignVerdict: $('#align-verdict'),
  alOffset: $('#al-offset'),
  alRatio: $('#al-ratio'),
  alConf: $('#al-conf'),
  alignNote: $('#align-note'),
  alignApply: $('#align-apply'),
  alignDiscard: $('#align-discard'),
  vol: $('#vol'),
  volCtl: $('#vol-ctl'),
  volIcon: $('#vol-icon'),
  helpPanel: $('#help-panel'),
  buffering: $('#buffering'),
  scrim: $('#scrim'),
  btnLibrary: $('#btn-library'),
};

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

const subs = new Subtitles(el.video, { primary: $('#sub-primary'), secondary: $('#sub-secondary') });

let order = [];
let current = null;
let poll = null;

// ---------- library ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function epLabel(ep) {
  if (ep.episode == null) return '';
  const s = ep.season == null ? '' : `S${String(ep.season).padStart(2, '0')}`;
  return `${s}E${String(ep.episode).padStart(2, '0')}`;
}

function subMarks(ep) {
  if (ep.error) return '<span class="none">unavailable</span>';
  const n = ep.subs.length + ep.embeddedSubs.length;
  if (!n) return '<span class="none">no subs</span>';
  const guessed = ep.subs.some((s) => s.match === 'guessed' || s.inferredSeason);
  return `${n} sub${n > 1 ? 's' : ''}${guessed ? ' ?' : ''}`;
}

function renderLibrary(lib) {
  order = [];
  el.counts.textContent =
    `${lib.counts.episodes} episodes · ${lib.counts.attached}/${lib.counts.subtitles} subtitle files attached`;

  const html = [];
  for (const series of lib.series) {
    html.push(`<div class="series-title">${esc(series.title)}</div>`);
    for (const season of series.seasons) {
      if (series.seasons.length > 1 || season.number !== 1) {
        html.push(`<div class="season-title">Season ${season.number}</div>`);
      }
      for (const ep of season.episodes) html.push(epRow(ep, series.title));
    }
    if (series.loose.length) {
      html.push('<div class="season-title">Unsorted</div>');
      for (const ep of series.loose) html.push(epRow(ep, series.title));
    }
  }
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
      setWatched(node.dataset.watch, !node.classList.contains('on'));
    })
  );
}

function setWatched(id, watched) {
  const ep = order.find((e) => e.id === id);
  if (!ep) return;
  ep.saved.watched = watched;
  const row = el.tree.querySelector(`.ep[data-id="${id}"]`);
  row?.classList.toggle('watched', watched);
  row?.querySelector('.watch')?.classList.toggle('on', watched);
  api(`/episode/${id}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: ep.saved.position || 0, duration: ep.duration, watched }),
  });
}

function epRow(ep, seriesTitle) {
  order.push(ep);
  // These files carry no episode titles, so repeating the series name on every
  // row is pure noise. Show it only when it actually differs.
  const name = ep.title === seriesTitle ? '' : ep.title;
  const pct = ep.duration && ep.saved.position ? Math.min(100, (ep.saved.position / ep.duration) * 100) : 0;
  return (
    `<div class="ep${ep.saved.watched ? ' watched' : ''}" data-id="${ep.id}" title="${esc(ep.file)}">` +
    `<span class="num">${epLabel(ep)}</span>` +
    `<span class="name">${esc(name)}</span>` +
    `<span class="marks">${subMarks(ep)}</span>` +
    `<span class="watch${ep.saved.watched ? ' on' : ''}" data-watch="${ep.id}" title="Mark watched (W)">✓</span>` +
    '</div>' +
    (pct > 1 && pct < 97 ? `<div class="resume" style="width:calc(${pct}% - 28px)"></div>` : '')
  );
}

// ---------- opening an episode ----------

// Which audio stream to play. null lets the server pick, which prefers the
// original language over a dub.
let currentAudio = null;
const audioQuery = (extra) => {
  const parts = [];
  if (currentAudio != null) parts.push(`audio=${currentAudio}`);
  if (extra) parts.push(extra);
  return parts.length ? `?${parts.join('&')}` : '';
};

async function open(id) {
  const ep = order.find((e) => e.id === id);
  if (!ep) return;
  current = ep;
  currentAudio = null; // let the server choose again for a new file

  el.tree.querySelectorAll('.ep').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  el.empty.hidden = true;
  if (drawerMode()) toggleSidebar(true); // the drawer is covering what you just chose

  await startPlayback(ep, ep.saved.position || 0);
}

/**
 * Get the file ready and play it. Used both when opening an episode and when
 * switching audio track — switching audio means a different remuxed file, so it
 * goes through exactly the same prepare-then-play path, resuming where you were.
 */
async function startPlayback(ep, resumeAt) {
  clearInterval(poll);

  const { body } = await api(`/episode/${ep.id}/status${audioQuery()}`);
  if (body.error) return showPrep(ep, body.error, null);
  if (body.status.state === 'unavailable') return showPrep(ep, body.status.error, null);
  if (body.status.state === 'ready') return play(ep, body.plan, resumeAt);

  showPrep(ep, body.plan.reason, 0);
  await api(`/episode/${ep.id}/prepare${audioQuery()}`, { method: 'POST' });
  poll = setInterval(async () => {
    const { body: s } = await api(`/episode/${ep.id}/status${audioQuery()}`);
    if (current !== ep) return clearInterval(poll);
    if (s.status.state === 'error') {
      clearInterval(poll);
      return showPrep(ep, `Failed: ${s.status.error}`, null);
    }
    showPrep(ep, s.status.state === 'queued' ? 'waiting for another file to finish…' : s.plan.reason, s.status.progress);
    if (s.status.state === 'ready') {
      clearInterval(poll);
      play(ep, s.plan, resumeAt);
    }
  }, 500);
}

function showPrep(ep, reason, progress) {
  el.player.hidden = true;
  el.prep.hidden = false;
  el.prepTitle.textContent = `${epLabel(ep)} ${ep.title}`;
  el.prepReason.textContent = reason || '';
  el.prepBar.style.width = `${Math.round((progress || 0) * 100)}%`;
  el.prepPct.textContent = progress == null ? '' : `${Math.round(progress * 100)}%`;
}

let builtFor = null;

function play(ep, plan, resumeAt = 0) {
  el.prep.hidden = true;
  el.player.hidden = false;
  el.npTitle.textContent = `${epLabel(ep)} ${ep.title}`;
  el.npMode.textContent = plan.mode === 'direct' ? 'direct play' : plan.mode === 'remux' ? 'remuxed' : 'transcoded';
  el.npMode.classList.toggle('hot', plan.mode === 'transcode');

  currentAudio = plan.audioIndex ?? null;
  el.video.src = `/api/episode/${ep.id}/stream${audioQuery()}`;
  if (resumeAt > 1) {
    el.video.addEventListener('loadedmetadata', () => { el.video.currentTime = resumeAt; }, { once: true });
  }
  el.video.play().catch(() => {});

  buildAudioList(ep, plan);
  // Only when the episode itself changed: switching audio must not throw away
  // the subtitle track and delay you already chose.
  if (builtFor !== ep.id) {
    builtFor = ep.id;
    buildTrackList(ep);
  }
  prefetchNext(ep);
}

function buildAudioList(ep, plan) {
  const list = ep.audio || [];
  el.audioCtl.hidden = list.length < 2; // nothing to choose from
  if (!list.length) return;
  el.selAudio.innerHTML = list
    .map((a) => {
      const bits = [langName(a.lang), a.codec, a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels}ch`];
      if (a.title) bits.push(a.title);
      return `<option value="${a.index}">${esc(bits.join(' · '))}</option>`;
    })
    .join('');
  el.selAudio.value = String(plan.audioIndex ?? list[0].index);
}

el.selAudio.addEventListener('change', async () => {
  if (!current) return;
  const at = el.video.currentTime;
  currentAudio = Number(el.selAudio.value);
  // A different audio track means a different remuxed file, so this may pause
  // to prepare it — then picks up exactly where it left off.
  await startPlayback(current, at);
});

function prefetchNext(ep) {
  const next = order[order.indexOf(ep) + 1];
  if (next) api(`/episode/${next.id}/prepare?prefetch=1`, { method: 'POST' }).catch(() => {});
}

// ---------- subtitle tracks ----------

let tracks = [];

const LANG_NAMES = {
  eng: 'English', spa: 'Spanish', por: 'Portuguese', fra: 'French', ita: 'Italian',
  deu: 'German', nld: 'Dutch', pol: 'Polish', jpn: 'Japanese', kor: 'Korean',
  zho: 'Chinese', rus: 'Russian', ara: 'Arabic', heb: 'Hebrew', ell: 'Greek', tha: 'Thai',
};
const langName = (code) => (code ? LANG_NAMES[code] || code : 'unknown language');

function trackLabel(t) {
  const bits = [langName(t.lang)];
  bits.push(t.source === 'embedded' ? 'in video' : 'file');
  if (t.match === 'guessed') bits.push('guessed match');
  else if (t.inferredSeason) bits.push('season guessed');
  return `${bits.join(' · ')} — ${t.file}`;
}

function buildTrackList(ep) {
  tracks = [
    ...ep.subs.map((s) => ({ ...s, url: `/api/sub/${s.id}` })),
    // Bitmap tracks are images of text and cannot be shown, so they are listed
    // as unavailable rather than quietly dropped — otherwise a track visible in
    // VLC just isn't here and there's no telling why.
    ...ep.embeddedSubs.map((s) => ({
      id: `emb:${s.index}`,
      file: `track ${s.index}${s.title ? ` — ${s.title}` : ''}`,
      lang: s.lang,
      source: 'embedded',
      kind: s.kind,
      codec: s.codec,
      url: `/api/episode/${ep.id}/embedded/${s.index}`,
    })),
  ];

  const opts = () =>
    '<option value="">None</option>' +
    tracks
      .map((t) =>
        t.kind === 'bitmap'
          ? `<option value="${t.id}" disabled>${esc(`${t.file} — ${t.codec}, image-based, needs OCR`)}</option>`
          : `<option value="${t.id}">${esc(trackLabel(t))}</option>`
      )
      .join('');

  el.selPrimary.innerHTML = opts();
  el.selSecondary.innerHTML = opts();

  const usable = tracks.filter((t) => t.kind !== 'bitmap');
  const saved = ep.saved.subTrack;
  // The server says which track it considers correct for this file; falling
  // back to whatever happens to be first would land on the English source.
  const pick =
    usable.find((t) => t.id === saved) ||
    usable.find((t) => t.id === ep.preferredTrack) ||
    usable[0];
  selectTrack('primary', pick ? pick.id : '');
  selectTrack('secondary', ep.saved.secondaryTrack || '');
}

async function selectTrack(slot, trackId) {
  const sel = slot === 'primary' ? el.selPrimary : el.selSecondary;
  sel.value = trackId || '';
  const track = tracks.find((t) => t.id === trackId);
  try {
    const loaded = await subs.load(slot, track || null);
    // Tracks inside an MKV frequently carry no language tag. Once the cues are
    // parsed we know what language it is from the text itself, so relabel it
    // rather than leaving "unknown language" in the menu.
    if (loaded?.detectedLang && track && !track.lang) {
      track.lang = loaded.detectedLang;
      relabelTrack(track);
    }
  } catch (err) {
    if (slot === 'primary') {
      el.searchCount.textContent = `Could not load that track: ${err.message}`;
    }
    console.error(err);
  }
  subs.setDelay(slot, current?.saved.delays?.[trackId] || 0);
  subs.setScale(slot, current?.saved.scales?.[trackId] || 1);
  if (slot === 'primary') {
    runSearch();
    resetAlignPanel();
  }
  persistSubPrefs();
}

function relabelTrack(track) {
  for (const sel of [el.selPrimary, el.selSecondary]) {
    const opt = [...sel.options].find((o) => o.value === track.id);
    if (opt && !opt.disabled) opt.textContent = trackLabel(track);
  }
}

el.selPrimary.addEventListener('change', () => selectTrack('primary', el.selPrimary.value));
el.selSecondary.addEventListener('change', () => selectTrack('secondary', el.selSecondary.value));

subs.onDelayChange = (slot, value) => {
  if (slot !== 'primary') return;
  const scale = subs.scales.primary;
  // A time scale is invisible at the current moment but changes every later
  // cue, so it has to be shown next to the delay rather than hidden in a panel.
  const scaleText = scale === 1 ? '' : ` ×${scale.toFixed(4)}`;
  el.delayVal.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(2)}s${scaleText}`;
  el.delayCtl.classList.toggle('shifted', Math.abs(value) > 0.001 || scale !== 1);
  persistSubPrefs();
};

let persistTimer;
function persistSubPrefs() {
  if (!current) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const primaryId = el.selPrimary.value || null;
    current.saved.subTrack = primaryId;
    current.saved.secondaryTrack = el.selSecondary.value || null;
    if (primaryId) {
      current.saved.delays = { ...(current.saved.delays || {}), [primaryId]: subs.delays.primary };
    }
    if (primaryId) {
      current.saved.scales = { ...(current.saved.scales || {}), [primaryId]: subs.scales.primary };
    }
    api(`/episode/${current.id}/subprefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subTrack: primaryId,
        secondaryTrack: el.selSecondary.value || null,
        delays: primaryId ? { [primaryId]: subs.delays.primary } : {},
        scales: primaryId ? { [primaryId]: subs.scales.primary } : {},
      }),
    });
  }, 400);
}

// ---------- automatic alignment ----------

let alignPoll = null;
let pendingAlign = null;

function resetAlignPanel() {
  clearInterval(alignPoll);
  pendingAlign = null;
  el.alignResult.hidden = true;
  el.alignProgress.hidden = true;
  el.alignRun.disabled = false;
  el.alignEngine.textContent = '';
}

$('#btn-align').addEventListener('click', () => togglePanel(el.alignPanel));

el.alignRun.addEventListener('click', async () => {
  const trackId = el.selPrimary.value;
  if (!current) return;
  if (!trackId) {
    el.alignEngine.textContent = 'Choose a subtitle track first.';
    return;
  }

  resetAlignPanel();
  el.alignProgress.hidden = false;
  el.alignRun.disabled = true;
  el.alignStage.textContent = 'starting…';
  el.alignBar.style.width = '0%';

  const { body } = await api(`/episode/${current.id}/align?track=${trackId}`, { method: 'POST' });
  if (body.error) {
    el.alignProgress.hidden = true;
    el.alignRun.disabled = false;
    el.alignEngine.textContent = body.error;
    return;
  }

  alignPoll = setInterval(async () => {
    const { body: s } = await api(`/episode/${current.id}/align?track=${trackId}`);
    const st = s.status || {};
    el.alignStage.textContent = st.stage || '';
    el.alignBar.style.width = `${Math.round((st.progress || 0) * 100)}%`;

    if (st.state === 'error') {
      clearInterval(alignPoll);
      el.alignProgress.hidden = true;
      el.alignRun.disabled = false;
      el.alignEngine.textContent = `Failed: ${st.error}`;
      return;
    }
    if (st.state === 'done') {
      clearInterval(alignPoll);
      el.alignProgress.hidden = true;
      el.alignRun.disabled = false;
      showAlignResult(st.result);
    }
  }, 500);
});

/** Show the proposal. Nothing is changed until Apply is pressed. */
function showAlignResult(r) {
  pendingAlign = r;
  el.alignResult.hidden = false;
  el.alignEngine.textContent = `measured against ${r.engine === 'reference track' ? 'the subtitle track inside the video' : 'the audio'}`;

  el.alignVerdict.textContent = { good: 'Looks right', uncertain: 'Not sure', poor: 'Probably wrong' }[r.verdict] || r.verdict;
  el.alignVerdict.className = `verdict ${r.verdict}`;

  el.alOffset.textContent = `${r.offset >= 0 ? '+' : ''}${r.offset.toFixed(2)}s`;
  el.alRatio.textContent = r.ratio === 1 ? 'none' : `×${r.ratio.toFixed(5)}`;
  el.alConf.textContent = `${Math.round(r.confidence * 100)}%`;

  const notes = [];
  if (r.ratio !== 1) {
    const drift = Math.abs((r.ratio - 1) * (el.video.duration || 1500));
    notes.push(`The subtitle runs at a different speed; by the end of the episode that is about ${drift.toFixed(0)}s of drift.`);
  }
  if (r.disagreement) {
    notes.push(`The two methods disagreed by ${r.disagreement}s, so this is not trustworthy.`);
  } else if (r.verdict === 'poor') {
    notes.push('No clear match was found. Applying this will most likely make things worse.');
  } else if (r.verdict === 'uncertain') {
    notes.push('A match was found but it is not clearly better than the alternatives. Check a line or two after applying.');
  }
  el.alignNote.textContent = notes.join(' ');
}

el.alignApply.addEventListener('click', () => {
  if (!pendingAlign) return;
  subs.setDelay('primary', pendingAlign.offset);
  subs.setScale('primary', pendingAlign.ratio);
  persistSubPrefs();
  el.alignResult.hidden = true;
  pendingAlign = null;
});

el.alignDiscard.addEventListener('click', () => {
  el.alignResult.hidden = true;
  pendingAlign = null;
});

el.delayCtl.addEventListener('click', (e) => {
  const step = e.target.dataset?.step;
  if (step) subs.nudge('primary', Number(step));
});
$('#delay-reset').addEventListener('click', () => subs.setDelay('primary', 0));

// ---------- transport ----------

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

el.play.addEventListener('click', () => (el.video.paused ? el.video.play() : el.video.pause()));
el.video.addEventListener('play', () => (el.play.textContent = 'Pause'));
el.video.addEventListener('pause', () => (el.play.textContent = 'Play'));
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
    if (current && !current.saved.watched && el.video.currentTime / el.video.duration > 0.9) {
      setWatched(current.id, true);
    }
  }
  saveProgress();
});

el.video.addEventListener('error', () => {
  if (!current) return;
  const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  showPrep(current, `Playback failed: ${codes[el.video.error?.code] || 'unknown'}`, null);
});

let lastSave = 0;
function saveProgress() {
  if (!current) return;
  const now = Date.now();
  if (now - lastSave < 5000) return;
  lastSave = now;
  current.saved.position = el.video.currentTime;
  navigator.sendBeacon?.(
    `/api/episode/${current.id}/progress`,
    new Blob([JSON.stringify({ position: el.video.currentTime, duration: el.video.duration })], { type: 'application/json' })
  );
}

el.video.addEventListener('ended', () => {
  if (!current) return;
  api(`/episode/${current.id}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: 0, duration: el.video.duration, watched: true }),
  });
  nextEpisode();
});

function nextEpisode() {
  if (!current) return;
  const next = order[order.indexOf(current) + 1];
  if (next) open(next.id);
}

function cycleTrack(slot) {
  const sel = slot === 'primary' ? el.selPrimary : el.selSecondary;
  const values = [...sel.options].map((o) => o.value);
  const idx = values.indexOf(sel.value);
  selectTrack(slot, values[(idx + 1) % values.length]);
}

// ---------- search ----------

function runSearch() {
  const q = el.searchInput.value;
  const results = subs.search(q, 'primary');
  el.searchCount.textContent = q.trim() ? `${results.length} line${results.length === 1 ? '' : 's'}` : '';
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
  el.alignPanel.hidden = true;
  el.helpPanel.hidden = true;
  panel.hidden = !showing;
  if (showing && after) after();
}

function toggleFullscreen() {
  document.fullscreenElement ? document.exitFullscreen() : el.stage.requestFullscreen();
}

// ---------- style prefs ----------

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
  clearTimeout(applyStyleInputs.t);
  applyStyleInputs.t = setTimeout(() => {
    api('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitleStyle: subs.style }),
    });
  }, 500);
}
for (const input of Object.values(styleInputs)) input.addEventListener('input', applyStyleInputs);

// ---------- volume, buffering, session prefs ----------

// Everything the interface remembers between sessions that isn't tied to one
// episode. Written through one debounced call so dragging a slider doesn't
// hammer the server.
const prefs = { volume: 1, muted: false, sidebarCollapsed: false };
let prefsTimer;

function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    api('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: prefs.volume, muted: prefs.muted, sidebarCollapsed: prefs.sidebarCollapsed }),
    });
  }, 400);
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

// A stalled video with no indicator is indistinguishable from a broken one.
for (const ev of ['waiting', 'stalled']) el.video.addEventListener(ev, () => (el.buffering.hidden = false));
for (const ev of ['playing', 'canplay', 'seeked', 'pause']) el.video.addEventListener(ev, () => (el.buffering.hidden = true));

/**
 * Position is written every few seconds while playing, but the last few seconds
 * before you close the tab would otherwise be lost — which is exactly the part
 * you need when you come back. sendBeacon survives the page going away.
 */
function flushProgress() {
  if (!current || !Number.isFinite(el.video.currentTime) || el.video.currentTime < 1) return;
  current.saved.position = el.video.currentTime;
  navigator.sendBeacon?.(
    `/api/episode/${current.id}/progress`,
    new Blob([JSON.stringify({ position: el.video.currentTime, duration: el.video.duration })], { type: 'application/json' })
  );
}
window.addEventListener('pagehide', flushProgress);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushProgress());

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
    return subs.nudge('primary', dir * step);
  }

  if (k === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime += e.shiftKey ? 10 : 5; }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime -= e.shiftKey ? 10 : 5; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(prefs.volume + 0.05); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(prefs.volume - 0.05, { unmute: false }); }
  else if (k === 'm') { prefs.muted = !prefs.muted; applyVolume(); savePrefs(); }
  else if (k === 'w') { if (current) setWatched(current.id, !current.saved.watched); }
  else if (e.key === '?') { e.preventDefault(); togglePanel(el.helpPanel); }
  else if (k === '0') { subs.setDelay('primary', 0); }
  else if (k === 'v') { cycleTrack(e.shiftKey ? 'secondary' : 'primary'); }
  else if (k === 'f') { toggleFullscreen(); }
  else if (k === 'b') { toggleSidebar(); }
  else if (k === 'n') { nextEpisode(); }
  else if (e.key === '/') { e.preventDefault(); togglePanel(el.searchPanel, () => el.searchInput.focus()); }
  else if (e.key === 'Escape') { el.searchPanel.hidden = true; el.stylePanel.hidden = true; el.alignPanel.hidden = true; el.helpPanel.hidden = true; }
});

$('#rescan').addEventListener('click', async () => {
  $('#rescan').textContent = 'Scanning…';
  await api('/rescan', { method: 'POST' });
  await load();
  $('#rescan').textContent = 'Rescan';
});

async function load() {
  const { body: saved } = await api('/prefs');
  if (saved.subtitleStyle) Object.assign(subs.style, saved.subtitleStyle);
  if (typeof saved.volume === 'number') prefs.volume = saved.volume;
  if (typeof saved.muted === 'boolean') prefs.muted = saved.muted;
  if (saved.sidebarCollapsed) {
    prefs.sidebarCollapsed = true;
    // Not applied as a drawer: nothing is playing yet, so the list is the only
    // thing worth showing — and a shut drawer would open onto an empty stage.
    if (!drawerMode()) el.app.classList.add('collapsed');
  }
  applyVolume();
  styleInputs.size.value = subs.style.size;
  styleInputs.bottom.value = subs.style.bottom;
  styleInputs.bgOpacity.value = subs.style.bgOpacity;
  styleInputs.color.value = subs.style.color;
  styleInputs.outline.checked = subs.style.outline;
  subs.applyStyle();

  const { body } = await api('/library');
  renderLibrary(body);
}

load();
