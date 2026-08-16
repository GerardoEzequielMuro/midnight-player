# QA sweep — midnight-player

Read-only verification pass. No source, CSS, HTML or docs were modified. Server at
`localhost:8730` was left running and untouched. Findings are ordered by severity, with
**confirmed** (reproduced) separated from **suspicions** (read from code only).

---

## Cleanup you need to do first

My malformed-body probes against the API wrote garbage into `cache/state.json` — that is
finding C2 below, and the pollution is real, not simulated. Three keys to remove by hand:

```
prefs:                    "0": 1, "1": 2, "2": 3
subOverrides:             "undefined", "C:/nope.srt"
episodes.a8dff5cf2733.delays:  "0":"b", "1":"o", "2":"o", "3":"m"
```

None of them affect playback (the delay keys are looked up by track id, and no real track is
named `0`), but they will sit in the file forever. Deleting `cache/state.json` also works if you
don't mind losing watch positions.

---

## Confirmed defects

### C1 — HIGH — `npm start -- --port N "D:\Series"` refuses to start

`server/lib/config.js:34-41`

```js
const cliRoots = argv.filter((a) => !a.startsWith('-'));
if (cliRoots.length) cfg.roots = cliRoots;
```

`8731` does not start with `-`, so the port *value* is swallowed into `cliRoots` and resolved as
a library folder. `validateConfig` then rejects it and `server/index.js:18-22` exits 1.

Reproduced:

```
loadConfig(['--port','8731','D:\Series'])
  => port 8731
  => roots ["C:\Users\gerar\midnight-player\8731", "D:\Series"]
  => problems ["Folder does not exist: C:\Users\gerar\midnight-player\8731"]
  => process.exit(1)
```

This is the exact invocation documented in the README config table
(`npm start -- --port 8731 "D:\Series"`). The server never comes up, and the error message
points at a folder the user never typed. `--port=8731` works fine, so a friend who clones the
repo and copies the documented form is stuck on an error that reads like their own mistake.

Fix: drop the flag's value from `cliRoots` when the `--port N` (space) form is used.

### C2 — MEDIUM — unvalidated POST bodies are written straight into `cache/state.json`

`server/routes/api.js:177-187` (`subprefs`), `:261-267` (`prefs`), `:269-274` (`attach`)

No body is type-checked before being spread into persisted state. All of these returned **200**:

| Request | What landed in `state.json` |
|---|---|
| `POST /api/prefs -d '[1,2,3]'` | `prefs: {"0":1,"1":2,"2":3, …}` |
| `POST /api/episode/:id/subprefs -d '{"delays":"boom"}'` | `delays: {"0":"b","1":"o","2":"o","3":"m", …}` |
| `POST /api/attach` (empty body) | `subOverrides: {"undefined": null}` |
| `POST /api/prefs -d 'not json'` | nothing — 200 OK, silently a no-op |

The string spread is the mechanism: `{ ...(prev.delays||{}), ...(body.delays||{}) }` with
`body.delays` a string spreads it per character.

Consequence beyond the litter: a non-numeric delay stored against a *real* track id is read by
`web/subs.js:121` as `(now - this.delays[slot]) / this.scales[slot]` → `NaN` → `activeCues`
matches nothing → that track renders blank, permanently, with no way to fix it from the UI. The
same applies to `scales: 0`, which `subs.js:56` guards but `subprefs` does not.

The last row is separate: `readJson` (`api.js:300-309`) catches the parse error and returns `{}`,
so malformed JSON is reported as success.

### C3 — MEDIUM — `/embedded/:index` returns 500 for a client mistake

`server/routes/api.js:172`

```js
return json(res, { error: err.message, code: err.code || null }, err.code === 'BITMAP' ? 422 : 500);
```

Only the bitmap case carries a `code`. A nonexistent stream index throws a plain `Error`, so:

```
GET /api/episode/a8dff5cf2733/embedded/999  -> 500 {"error":"no subtitle track at stream 999"}
GET /api/episode/a8dff5cf2733/embedded/abc  -> 500 {"error":"no subtitle track at stream abc"}
```

The *identical* underlying error routed through `align` returns 422 (`api.js:203`), so the two
endpoints disagree about whose fault it is. 500 tells any client, proxy or log scraper that the
server broke, when the request was simply wrong.

### C4 — MEDIUM — `hasCachedVector` checks a filename nothing writes

`server/lib/align/vad.js:215` vs `:40`

```js
// vad.js:215
return fs.existsSync(path.join(cfg.cacheDir, 'vad', `${ep.id}.bin`));
// vad.js:40
const cacheFile = path.join(cfg.cacheDir, 'vad', `${ep.id}.f32`);
```

`.bin` versus `.f32`. Confirmed against the live cache: 21 `.f32` files and 3 stale `.bin` files
left over from an older format, so the check happens to return true for exactly three episodes
by accident and false for every other one.

Consequence is confined to the initial stage label (`align/index.js:35`): alignment reports
"reading audio" even when the vector is cached and the result is about to be instant. Cosmetic,
but it is a dead check that reads as if it works.

### C5 — MEDIUM — a filename with no title before the episode marker parses as nothing

`server/lib/parseName.js:88-89`

```js
const title = cleanTitle(stripJunk(target.slice(0, m.index)));
if (!title) continue;
```

Every pattern requires non-empty text *before* the match, and only `path.basename` is ever
consulted (`parseName.js:46`) — the containing folder is never used. Reproduced:

```
S01E01.mkv   -> season null, episode null, confidence 0, pattern 'none', title "S01E01"
```

So the extremely common `Show Name/Season 1/S01E01.mkv` layout produces a library where every
episode has no season, no episode number, and a title of `S01E01` — unsorted, unmatched, and
grouped under a garbage series key. The library here doesn't hit it because every file carries
the show name, but a friend cloning the repo very plausibly does.

Related, lower impact, from the same run: `Show.Part.2.of.6.mkv` → episode 6 (the last number
wins), `Ep 3 - Show name.mkv` → title `"Ep"`, `Show.101.mkv` → episode 101. All land at
confidence 0.4 and are flagged as guesses, which is the honest behaviour.

### C6 — LOW — unbounded file-handle concurrency when parsing subtitles

`server/lib/scan.js:102`

```js
const subs = await Promise.all(found.subs.map(async (file) => { … }));
```

The video path deliberately uses `mapLimit(found.videos, 4, …)` (`scan.js:73`); the subtitle path
does not, and each iteration does a `stat` plus a full `readFile` plus decode. `config.json` here
points `subtitleRoots` at `C:/Users/gerar/Downloads`, which is exactly the folder that
accumulates thousands of files. At a few thousand subtitles this opens them all in one tick and
risks `EMFILE`. Not reproduced — only 74 subtitle files present.

### C7 — LOW — a file vanishing mid-scan takes down the whole library

`server/lib/scan.js:74` and `:104`

`walk` is defensive about unreadable directories (`scan.js:20-23`), but the `fs.stat` calls that
follow are not wrapped. `walk` collects every path first, so any file deleted between the walk
and the stat rejects the entire `scanLibrary` promise, `ensureScan` propagates it, and
`GET /api/library` returns 500. It recovers on the next request (`scanning` is cleared in
`finally` and `raw` stays null), but a Downloads folder is precisely where files move and get
deleted while the server is running. Read from code, not reproduced.

### C8 — LOW — static-file guard uses a bare string prefix

`server/index.js:37-38`

```js
const file = path.resolve(WEB_DIR, rel);
if (!file.startsWith(WEB_DIR)) return res.writeHead(403).end('forbidden');
```

Verified directly:

```
path.resolve(WEB_DIR, '../webz/secret.txt')
  -> C:\Users\gerar\midnight-player\webz\secret.txt   guard passes: true
path.resolve(WEB_DIR, '../../etc/passwd')
  -> C:\Users\gerar\etc\passwd                        guard passes: false
```

Escape is confined to sibling directories of `web/` whose names begin with `web`, none of which
exist today, and the server binds `127.0.0.1` only — so this is not exploitable as shipped. It is
still a one-character fix: compare against `WEB_DIR + path.sep`.

Every traversal I actually sent over HTTP was correctly rejected (`/../package.json` 404,
`/..%2Fpackage.json` 403, `/%2e%2e/config.json` 404, `/../../../../Windows/win.ini` 404).

### C9 — LOW — `GET align?track=<garbage>` returns 200 instead of 404

`server/routes/api.js:226`. The GET branch never validates the track, so
`GET /api/episode/:id/align?track=garbage` returns `200 {"status":{"state":"idle"}}` while
`POST` with the same track correctly returns `404 {"error":"unknown track"}`. A polling client
cannot distinguish "no job yet" from "that track does not exist" and will poll forever.

### C10 — LOW — `N` after a rescan jumps to the first episode of the library

`web/app.js`, `nextEpisode()` and `prefetchNext()`, both via `order.indexOf(current)`.

`publicEpisode` (`api.js:69`) builds fresh objects on every `/api/library` call, and
`renderLibrary` rebuilds `order` from them. After pressing Rescan, `current` still points at an
object from the *previous* response, so `indexOf` returns `-1` and `order[-1 + 1]` is `order[0]`.
Pressing `N` — or finishing an episode, which calls `nextEpisode()` — opens the first episode in
the library instead of the next one. `prefetchNext` has the same bug and prefetches episode 0.
Matching by `ep.id` rather than object identity fixes both. Read from code.

### C11 — LOW — `V` cycles into disabled bitmap tracks

`web/app.js`, `cycleTrack()` builds its candidate list from `[...sel.options].map(o => o.value)`,
which includes the `disabled` bitmap entries that `buildTrackList` deliberately renders as
unavailable. Selecting one requests `/embedded/:index`, gets a 422, shows "Could not load that
track", and `persistSubPrefs()` still saves it as the chosen track — so it is restored on the
next open. The dropdown blocks these correctly; only the keyboard path does not.

### C12 — LOW — shortcuts fire while Ctrl is held

`web/app.js` keydown handler has no `ctrlKey`/`metaKey` guard. Ctrl+F triggers fullscreen
alongside the browser's find bar, Ctrl+N triggers next-episode alongside a new window, Ctrl+B
collapses the sidebar, and so on.

---

## Suspicions (read from code, not reproduced)

- **No preemption of a running remux.** `playback.js:129-148`. `prepare(…, {priority:true})`
  only reorders the *queue*; it cannot interrupt the job holding the single slot. A background
  prefetch that lands on a `transcode` plan (libx264 over a full episode) leaves the episode the
  user just clicked showing "waiting for another file to finish…" for the entire transcode. The
  cap of one is well argued in the comment, but priority is only half of what that argument
  needs. Related: `playback.js:104` `if (job.state !== 'queued') continue; // cancelled while
  waiting` is dead code — nothing ever sets a cancelled state.
- **`statusFor` reports `queuedAhead: -1` for a running job** (`playback.js:122`) because
  `queue.indexOf` runs against a job already shifted off the queue.
- **`cacheFileFor` has no content key** (`playback.js:81-84`): episode id is a hash of the *path*
  only, plus audio index. Replace an episode with a different encode at the same path and the
  stale remux is served indefinitely until `cache/` is cleared. The README does say `cache/` is
  safe to delete, so this is a papercut rather than a trap.
- **`vad.js:43`** `new Float32Array(cached.buffer, cached.byteOffset, cached.length / 4)` assumes
  a 4-byte-aligned `byteOffset`. `fs.readFile` returns unpooled buffers at these sizes so it holds
  in practice; if it ever didn't, the `RangeError` is caught by the surrounding `try` and the
  audio is silently re-decoded rather than failing.
- **`web/app.js` `startPlayback` poll handle.** Two `open()` calls interleaving around the
  `await api(...)` can leave the module-level `poll` pointing at the wrong interval, leaking the
  other one. Both intervals guard on `current !== ep`, so the visible damage is a stray poll
  rather than wrong playback.
- **`/api/sub/:id` returns 500** (`api.js:252`) when the file was deleted after the scan. 404 or
  410 would be the honest code.

---

## Checked and fine

- **`npm test`** — 32 assertions across parseName, subtitle parsing/encoding, alignment and
  retiming. All pass, exit code 0.
- **Range requests** — 12 probes against `/api/episode/:id/stream`, all correct. `206` with an
  accurate `Content-Range` and `Content-Length` for `bytes=0-99`, `100-199`, `0-`, `-500`, and a
  clamped `0-999999999999`. `416` with `Content-Range: bytes */504363939` for an out-of-range
  start, `-0`, a reversed range, non-numeric bounds, a multi-range request, a bare `bytes=`, and a
  malformed header. `Accept-Ranges` present on every response. This is the part of the system
  most likely to be subtly wrong and it isn't.
- **The remux queue does not wedge on failure.** Tested directly against a throwaway cache dir:
  three jobs pointed at nonexistent files all errored, the queue drained, a fourth job queued
  *after* the failures still ran, and re-preparing an errored job retried it correctly. `startJob`
  returns a `.catch()`-ed promise, so `pump()`'s `finally` always releases the slot. The specific
  risk in the brief is not present.
- **Error paths that are right:** unknown episode `404` (bare, `/status`, `/stream`), unknown
  subtitle `404`, `align` with no `track` `400`, POST `align` with an unknown track `404`,
  `emb:999` and `emb:abc` `422`, bitmap tracks `422`, `prepare`/`stream` on an unprobeable file
  `422`, `/stream` before preparation `409` with the status attached, unknown endpoint `404`.
  Nothing I sent produced an unhandled rejection or crashed the process.
- **`npm run setup` is correct.** Only `ffmpeg-static` downloads its binary from an install
  script; `ffprobe-static` ships prebuilt binaries for all platforms inside its tarball, so
  covering only the former is right. `checkBinaries` (`ffmpeg.js:26-37`) fails at boot with the
  exact fix command.
- **`.gitignore`** correctly excludes `config.json` and `cache/`. The `*.srt` / `*.vtt` / `*.ass`
  rules do *not* break a fresh clone's `npm test`, because `make-fixtures.mjs` regenerates every
  fixture the suite asserts on before the suite runs.
- **No personal or machine-specific data in the committed surface.** `config.example.json` and
  `README.md` are clean; the real Downloads paths live only in `config.json`, which is ignored.
- **Subtitle sanitisation** (`common.js:32-38`) escapes first and re-admits only `<i> <b> <u>
  <br>`, so cue text reaching `innerHTML` in `subs.js:123` is inert. The frontend escapes
  filenames and reasons through `esc()` before rendering them.

## Housekeeping, not defects

- `test/render.png` — 555 KB screenshot, not gitignored, referenced by nothing.
- `test/fixtures/media/Test Show S01E01.mkv` — 602 KB, referenced by nothing (grep across
  `test/`, `tools/`, `server/` returns zero hits), and excluded by `*.mkv` anyway.
- `test/parse.test.mjs` — a print-only script with no assertions, not run by `npm test`. It
  covers three cases the real suite does not assert (`E01`, `ep10 finale`, `S3.EP04`); I ran it
  and all three parse correctly, so nothing is hiding there.
- `test/tune-vad.mjs` and `test/verify-offsets.mjs` call `loadConfig([])` and so need the
  gitignored `config.json` plus a real library. Fine as dev tools, but they fail immediately on a
  fresh clone; both document themselves as measurement harnesses.
