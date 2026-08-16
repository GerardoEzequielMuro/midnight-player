/**
 * Make every episode ready to watch without touching the interface.
 *
 * For each episode it picks the best subtitle track in the language you want,
 * works out the correction it needs, and stores that against the episode — so
 * the track is already selected and already in sync when you press play.
 *
 *   node tools/autosync.mjs            # measure and report, change nothing
 *   node tools/autosync.mjs --write    # store the corrections
 *   node tools/autosync.mjs --lang eng
 *
 * Corrections are stored as two numbers in the app's own state, exactly as if
 * you had pressed Align and then Apply yourself. No subtitle file is written
 * to or altered. The server must be running.
 */
const BASE = process.env.PLAYER_URL || 'http://localhost:8730';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const langIdx = args.indexOf('--lang');
const WANT = langIdx >= 0 ? args[langIdx + 1] : 'spa';

const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) =>
  (await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tagOf = (ep) => `S${String(ep.season ?? 0).padStart(2, '0')}E${String(ep.episode ?? 0).padStart(2, '0')}`;

let library;
try {
  library = await get('/api/library');
} catch {
  console.error(`Could not reach the player at ${BASE}. Start it with: npm start`);
  process.exit(1);
}

const episodes = library.series
  .flatMap((s) => s.seasons.flatMap((se) => se.episodes))
  .filter((e) => !e.error)
  .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

console.log(`${episodes.length} playable episodes, looking for "${WANT}" subtitles\n`);

// ---- pass one: measure ----------------------------------------------------

const plan = [];
for (const ep of episodes) {
  const candidates = ep.subs.filter((s) => s.lang === WANT);
  if (!candidates.length) {
    plan.push({ ep, kind: 'none' });
    continue;
  }

  // A retimed file was mapped onto this exact release, so it needs no
  // correction at all. Prefer it over anything that has to be aligned.
  const retimed = candidates.find((s) => /\.retimed\./i.test(s.file));
  if (retimed) {
    plan.push({ ep, kind: 'ready', track: retimed, offset: 0, ratio: 1 });
    continue;
  }

  const track = candidates[0];
  process.stdout.write(`\r  measuring ${tagOf(ep)}...   `);
  await post(`/api/episode/${ep.id}/align?track=${track.id}`);

  let result = null;
  for (let i = 0; i < 60; i++) {
    const s = await get(`/api/episode/${ep.id}/align?track=${track.id}`);
    if (s.status?.state === 'done') { result = s.status.result; break; }
    if (s.status?.state === 'error') break;
    await sleep(500);
  }

  if (!result) {
    plan.push({ ep, kind: 'unmeasurable', track });
    continue;
  }

  // Apply what is trustworthy. "Uncertain" counts only when the two methods
  // independently agreed — corroboration, not a lone convincing peak.
  const trusted = result.verdict === 'good' || (result.verdict === 'uncertain' && result.corroborated != null);
  plan.push({ ep, kind: trusted ? 'aligned' : 'unsure', track, ...result });
}
process.stdout.write('\r'.padEnd(40) + '\r');

// ---- pass two: sanity-check each season against itself ---------------------

/*
 * A season is usually one release with one problem, so its episodes should need
 * roughly the same correction. Where they do, that agreement is evidence, and
 * an episode disagreeing with all its neighbours is suspect however convincing
 * its own peak looked.
 *
 * This only fires when a season is genuinely consistent, and only ever demotes
 * an already-uncertain result. A confident measurement is never overruled by
 * its neighbours.
 */
const bySeason = new Map();
for (const item of plan) {
  if (item.kind !== 'aligned') continue;
  const key = item.ep.season ?? 0;
  if (!bySeason.has(key)) bySeason.set(key, []);
  bySeason.get(key).push(item.offset);
}

const consensus = new Map();
for (const [season, offsets] of bySeason) {
  if (offsets.length < 4) continue;
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const agreeing = offsets.filter((v) => Math.abs(v - median) <= 5).length;
  if (agreeing / offsets.length >= 0.6) consensus.set(season, median);
}

for (const item of plan) {
  if (item.kind !== 'aligned' || item.verdict === 'good') continue;
  const median = consensus.get(item.ep.season ?? 0);
  if (median == null) continue;
  if (Math.abs(item.offset - median) > 5) {
    item.kind = 'unsure';
    item.outlier = median;
  }
}

// ---- report and apply -----------------------------------------------------

console.log('ep       track                     correction            source');
const counts = { ready: 0, aligned: 0, unsure: 0, unmeasurable: 0, none: 0 };

for (const item of plan) {
  const tag = tagOf(item.ep);
  counts[item.kind]++;

  if (item.kind === 'none') {
    console.log(`${tag}   ${`(no ${WANT} track)`.padEnd(25)} ${'—'.padEnd(21)} —`);
    continue;
  }

  const name = short(item.track.file);
  if (item.kind === 'ready') {
    console.log(`${tag}   ${name.padEnd(25)} ${'none needed'.padEnd(21)} retimed file`);
  } else if (item.kind === 'unmeasurable') {
    console.log(`${tag}   ${name.padEnd(25)} ${'could not measure'.padEnd(21)} —`);
  } else {
    const desc = `${item.offset >= 0 ? '+' : ''}${item.offset.toFixed(2)}s${item.ratio !== 1 ? ` x${item.ratio.toFixed(4)}` : ''}`;
    const why = item.outlier != null
      ? `disagrees with the season (${item.outlier.toFixed(1)}s) — left alone`
      : item.kind === 'unsure'
        ? `${item.verdict} — left alone`
        : `${item.verdict} (${item.engine})`;
    console.log(`${tag}   ${name.padEnd(25)} ${(item.kind === 'unsure' ? desc + ' ?' : desc).padEnd(21)} ${why}`);
  }

  if (!WRITE) continue;

  if (item.kind === 'ready' || item.kind === 'aligned') {
    await post(`/api/episode/${item.ep.id}/subprefs`, {
      subTrack: item.track.id,
      delays: { [item.track.id]: item.offset },
      scales: { [item.track.id]: item.ratio },
    });
  } else if (item.track) {
    // Select the track anyway so it is one keypress away, just uncorrected.
    await post(`/api/episode/${item.ep.id}/subprefs`, { subTrack: item.track.id });
  }
}

console.log(
  `\n${counts.ready} already correct, ${counts.aligned} corrected automatically, ` +
    `${counts.unsure + counts.unmeasurable} need a look, ${counts.none} without a ${WANT} track`
);
if (!WRITE) console.log('\nreport only — nothing stored. Add --write to apply.');

function short(file) {
  const m = file.match(/S\d{2}E\d{2}[^.]*/i);
  const name = m ? m[0] : file;
  return name.length > 24 ? `${name.slice(0, 21)}...` : name;
}
