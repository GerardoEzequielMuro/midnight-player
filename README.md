# midnight-player

A local video player for watching series with subtitles. It runs on your own machine — a small
Node server plus a web page it serves. Nothing is uploaded anywhere, and there is no account,
no cloud, and no telemetry.

Point it at a folder of episodes and subtitle files, open `localhost` in your browser, and watch.

It exists because the browser alone can't do this: reading a folder off disk, extracting subtitle
tracks embedded in an MKV, repacking containers Chrome refuses to open, and analysing audio to
line up out-of-sync subtitles all need a real process running locally. That process is ffmpeg.

## Requirements

- Node 18 or newer
- Nothing else. ffmpeg and ffprobe are installed as npm packages.

## Install

```bash
git clone <this repo>
cd midnight-player
npm install
npm run setup     # see note below — don't skip it
```

**Why `npm run setup`:** the `ffmpeg-static` package downloads its binary from a package install
script. npm 11 blocks install scripts by default, so `npm install` can finish successfully and
still leave you with no ffmpeg on disk. `npm run setup` downloads it. If you skip it, the server
refuses to start and tells you this again.

## Run

The quickest way, no config file needed:

```bash
npm start -- "D:\Series"
```

Or copy `config.example.json` to `config.json` and edit it, then just `npm start`.
Then open <http://localhost:8730>.

### Configuration

| Key | What it does |
|---|---|
| `roots` | Folders scanned for video **and** subtitle files, recursively. |
| `subtitleRoots` | Extra folders scanned for subtitles only. Use this when your subs sit somewhere else, like a Downloads folder. |
| `port` | Default `8730`. |
| `cacheDir` | Where repacked video, scan results and watch state live. Safe to delete. |
| `seriesAliases` | Groups of titles that mean the same show. Needed when your videos and your subtitles are named differently — see below. |
| `preferredAudioLang` | ISO-639-2 code of the audio track to auto-select when a file has several, so you stay on the original language instead of a dub. Default `jpn`. |
| `--port N` | Command-line only, overrides the configured port: `npm start -- --port 8731 "D:\Series"`. |
| `assumeHevcSupport` | Set `true` if your browser plays HEVC/H.265, to skip a slow re-encode. |

## How it plays MKV

Browsers can't play the Matroska container, so files are repacked to MP4 the first time you open
an episode. Which route it takes is shown in the interface while you watch:

- **direct play** — the file was already browser-friendly, nothing was touched.
- **remuxed** — the container was rewritten with `-c copy`. No re-encoding, so no quality loss and
  almost no CPU. On an SSD this takes a couple of seconds for a 500 MB episode.
- **transcoded** — the video codec itself isn't playable, so it's being re-encoded. This is slow
  and it will heat up your machine. It's flagged in the interface for exactly that reason.

The result is cached as a normal file, which is what makes seeking instant: the browser gets real
HTTP Range requests against a finished file rather than a live stream, because you cannot seek
inside a pipe. The next episode is prepared in the background while you watch the current one.

Cached files are roughly the size of the originals. Delete `cache/` whenever you want them back.

## Matching subtitles to episodes

Matching on filename doesn't survive contact with a real collection. Subtitles usually live in a
different folder, under a different title, from a different release. So episodes and subtitles are
both parsed into `(series, season, episode)` and matched on that, in three tiers:

1. Same series, season and episode.
2. Same season and episode, different series name, and exactly one episode in the whole library
   could be meant.
3. Anything else is listed as **unmatched**, with the reason. It is never forced onto an episode.

Filenames like `S01E04`, `1x04`, `Season 2 Ep01`, `ep04` and a bare `04` are all understood, and
release noise (`1080p`, `x264`, `1280x720`, years, `[eng]`) is stripped first so it can't be
mistaken for an episode number. When a subtitle names no season and the show has more than one,
season 1 is assumed and the match is flagged as a guess rather than presented as fact.

If two names for the same show should be treated as one, put them in `seriesAliases`.

## Keyboard

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | 5 seconds |
| `Shift`+`←` `→` | 10 seconds |
| `,` `.` | subtitle delay, 0.25 s steps |
| `Shift`+`,` `.` | delay, 1 s steps |
| `Alt`+`,` `.` | delay, 0.05 s steps |
| `0` | reset delay |
| `V` | next subtitle track (`Shift`+`V` for the second track) |
| `/` | search the dialogue |
| `F` | fullscreen |
| `N` | next episode |
| `B` | show/hide the library panel |
| `↑` `↓` | volume |
| `M` | mute |
| `W` | mark the episode watched or unwatched |
| `?` | the panel listing all of these |

Alignment has no keyboard shortcut. It is reached through the **Align** button in the control
bar.

## Subtitles

SRT, WebVTT and ASS/SSA are supported. Subtitles are drawn as an overlay rather than
handed to a `<track>` element, which is what allows two tracks at once, a delay you can
change while playing, and styling the browser does not otherwise expose. Switching tracks
never touches the video, so playback does not stop.

**Encoding.** Subtitle files declare no encoding and many are not UTF-8, which is what turns
accented characters into rubbish. A byte-order mark is trusted first, then a strict UTF-8
decode, then statistical detection. Detection between the single-byte Latin encodings is
deliberately biased toward Windows-1252: they are identical below 0x80, so the detector
separates them on letter frequencies that need far more text than a subtitle file has. On a
real file it scored ISO-8859-2 at 0.95000042 against Windows-1252 at 0.95000000 — a tie
decided by floating-point noise, and enough to turn "años" into "ańos". Multi-byte encodings
like Shift-JIS have real structural signatures and their detection is trusted as-is.

**Delay** is adjustable in 0.05, 0.25 and 1 second steps, always visible, and remembered per
episode *and* per track — so a track you have already lined up stays lined up.

**A second track** can be shown at the same time, at the top of the frame in a lighter
italic style, for comparing translations.

**Tracks inside the video** are extracted with ffmpeg the first time you select them, then
cached and treated exactly like an external file. Two families of embedded subtitle exist and
only one can be used: text tracks (SubRip, ASS/SSA, mov_text) are extracted, while bitmap
tracks (PGS from Blu-ray, VobSub from DVD, DVB) are *pictures* of text — one image per cue —
and reading them needs OCR. Those are listed in the menu as unavailable with the reason, so a
track you can see in VLC is never silently missing here.

**Language is detected from the text, not the filename.** Filenames lie: a real file used
while building this is named `...en-es-419.srt` and contains no English at all. Writing system
is checked first, then function words. A track inside an MKV with no language tag gets
relabelled once its cues are read.

**Search** filters the dialogue of the current track and jumps to the moment a line is
spoken.

Size, colour, background opacity, vertical position and outline are adjustable and remembered.

## Audio tracks

When a file carries more than one audio track a selector appears, labelled by language, codec
and channel count. The default is the track matching `preferredAudioLang`, so a file with an
English dub first and the Japanese original second still starts in Japanese.

Switching audio means a different remuxed file, since a plain `<video>` element cannot reliably
switch audio tracks inside one MP4. Each track is cached separately and playback resumes at the
same moment, so the switch costs one short prepare the first time and nothing after that.

## Automatic alignment

A subtitle downloaded for a different release of the same episode is usually out of sync, and two
different faults are behind that. One is a constant offset: the file starts a few seconds late or
early because the release carries a different recap or logo. That is fixed by a single number. The
other is progressive drift, where the subtitle starts fine and is seconds out by the end. That one
comes from PAL speed-up — 24fps film run at 25fps plays 4% faster — and it needs the times
*scaled*, not shifted.

The **Align** button in the control bar works out both:

1. ffmpeg decodes the audio to 16 kHz mono, band-passed to 300–3400 Hz, the speech band.
2. Energy per 10 ms frame decides speech or silence.
3. The same binary shape is built from the subtitle cue times.
4. The two are cross-correlated via FFT, and the peak gives the offset.
5. That is repeated for each candidate time-scale ratio, and the best combination wins.
6. The result is reported with a confidence, not just a number.

Three implementation details decide whether any of this works.

**Both vectors are zero-meaned before correlating.** Raw binary correlation is maximised by
whatever shift overlaps the most ones, which drags the answer toward densely-speaking stretches
regardless of whether anything actually lines up.

**The score is divided by the product of the vector norms.** Each candidate ratio resamples the
subtitle vector and changes how much "on" time it contains, so raw peak heights are not comparable
between ratios without this.

**Confidence is peak *prominence*, not peak height** — how far the best peak stands above the
next-best shift. A subtitle matching nothing still produces its highest value somewhere.

**Voice detection was tuned by measurement, not taste.** A single global threshold marked 73% of
this show as speech, because its scenes run over constant kitchen ambience and music, and a
near-constant vector has no shape for the correlation to lock onto. It was replaced with a *local*
noise floor, measured per 5-second block and interpolated, with the margin above it chosen so that
speech lands under 35% of runtime. Measured against subtitle tracks whose correct answer was known
in advance, offset accuracy was unchanged at around 0.1 s, but average peak prominence rose from
2.04 to 4.72. The tuning harness is `test/tune-vad.mjs`.

**The subtitle track muxed into the MKV is ground truth.** It was timed against that exact cut, so
its correct alignment is known: zero offset, no scaling. That is what the detector was tuned
against, and at playback time it doubles as a *reference track* — aligning one subtitle against
another compares two precise records of when people speak, rather than comparing a precise record
against an inference drawn from loudness. Both the audio and the reference method are computed, and
the more isolated peak wins.

**Confidence is calibrated conservatively.** Alignments known to be correct land at prominence 2.1
to 3.1; alignments later shown wrong by an independent brute-force overlap search sat at 1.05 to
1.40. An earlier, looser calibration reported a 51-second error as "good", which is the worst
failure available here: it silently ruins a subtitle the viewer then has to fix by hand without
knowing why. The bar now sits above where wrong answers were observed. The cost is that some
correct alignments are reported as merely uncertain, and that is the right trade, since an
uncertain verdict still shows the numbers and lets you apply them deliberately.

**The original file is never modified.** The correction is stored as two numbers, an offset and a
scale, in the local state file, and applied at playback time. That holds whichever engine produced
it.

**External tools are used if you have them.** `ffsubsync` and `alass` are detected at startup and
used in place of the built-in method, and the interface says which engine ran. Neither is installed
on this machine, so the built-in method is what runs here. Because those tools write a corrected
subtitle file rather than returning numbers, their output is compared against the original by a
least-squares fit to recover the same (scale, offset) pair, so there is one representation
everywhere.

**Two methods must agree.** Since both the audio and the reference method are computed anyway,
their answers are compared. When they differ by more than a second and a half at least one of them
is wrong and there is no way to tell which, so the verdict is capped no matter how convincing the
winner looked alone. This is not hypothetical: on one episode the audio method returned -0.01s and
the reference method -51.25s, and that reference peak was isolated enough to pass as "good" on its
own terms. It was wrong. Agreement counts in the other direction too — landing within half a second
of each other is not something two wrong answers do easily, so it moves the verdict up one level,
and one level only. Corroboration means the offset is probably right, not that the peak was strong.

## Subtitle retiming

Alignment can only recover a shift and a stretch. That is enough for most badly-timed subtitles,
but not for the case where a good human translation was made for a release that differs from yours
scene by scene — a longer recap here, a trimmed credit roll there. No single shift and stretch
exists for that, so alignment reports "poor", which is honest and leaves you no better off.

There is a way out when you also have a subtitle in the same language as a correctly-timed track,
from the same release as the translation. That file acts as a bridge:

    bridge (release timing, language A) ── same release ── target (release timing, language B)
      │
      │ matched on text — same language, so this is reliable
      ▼
    reference (correct timing for your video, language A)

Matching the bridge against the reference on text gives anchor points between the two timelines.
Interpolating between the anchors gives a piecewise map, which can express the per-scene
differences that one offset and one ratio cannot. Applying that map to the target retimes the
translation without altering a single word of it.

```bash
npm run retime                       # dry run: reports what it would do
npm run retime -- --write            # write the retimed files
npm run retime -- --episode S01E02   # limit it to one episode
```

The reference is any subtitle known to be correctly timed for the video. A text track muxed into
the file is preferred, since it was authored for that exact cut. Failing that, a subtitle sitting
in the same folder under the same name as the video is used, because it shipped with the release.
That fallback matters for MP4 episodes, which rarely carry subtitle tracks and would otherwise be
skipped entirely. External subtitle files are then grouped by release — same name apart from the
language tag — and a group is usable when it holds one file in the reference's language and one in
another.

Details that decide whether the result is trustworthy:

**Text is compared with a Dice coefficient over character bigrams**, which is robust for lines
that are near-identical rather than exactly equal.

**Matching is Needleman-Wunsch sequence alignment, not nearest-neighbour**, because cues have to
pair up *in order*. A line repeated later in the episode would otherwise match an earlier one and
produce a time map that runs backwards.

**Anchors that contradict their neighbours are dropped.** Time must move forward on both sides. A
single bad match left in place bends the map around it and drags every nearby cue out of position.

**The bridge and the target are checked for a shared timeline** — the same cue count, and an
average start-time difference under 0.5 s — and the pair is skipped when they disagree, rather
than producing confidently wrong output.

**The original files are never modified.** Output is a new file named `<original>.retimed.srt`
next to the original, picked up on the next library scan.

Measured on the real library of 20 episodes: 13 had the bridge file available and all 13 retimed
cleanly. That was checked independently by measuring how much each retimed track overlaps the
known-correct track embedded in the video. Overlap rose from a range of 0.31–0.66 before to
0.83–0.98 after, and 13 of 13 improved.

## What is remembered

State is written to `cache/state.json` and survives a reload:

- playback position per episode, resumed when you open it again
- watched state, set with `W` or by clicking the tick in the sidebar, and set automatically at 90%
  of runtime rather than at the very end, because most people stop during the credits and never
  reach the end of the file
- subtitle track, delay and time scale, per episode *and* per track
- subtitle styling: size, colour, background opacity, vertical position, outline
- volume, mute, and whether the library panel is collapsed

Playback position is also flushed with `sendBeacon` when the tab closes and when it is hidden, so
the last few seconds before you close the tab are not lost — which is exactly the part you need
when you come back.

The control bar carries a volume slider alongside the `↑`, `↓` and `M` shortcuts, and there is a
buffering indicator, because a stalled video with no indicator is indistinguishable from a broken
one. The mouse cursor hides along with the controls. `?` lists all 17 shortcuts.

### When there is no bridge file

The text route needs a subtitle in the same language as a correctly-timed track, from the same
release as the translation. When that is missing, the retimer falls back to pairing cues on
*timing* instead of wording: two translations of an episode place their cues at the same moments,
because the actors speak when they speak, so cues can be matched on position alone.

It is the coarser of the two. Measured against the correctly-timed track on a real library, the
text route reaches an overlap of 0.83 to 0.98, while the timing route reaches 0.42 to 0.79 — a
clear improvement on doing nothing, and it still produces a piecewise correction, which is the
thing a single offset cannot express. The text route is always preferred where a bridge exists.

## Getting a whole library ready at once

`npm run autosync` measures every episode and stores the correction its subtitles need, so the
right track is already selected and already in sync when you press play. Add `--write` to apply
what it reports, and `-- --lang eng` to work on a language other than Spanish. It stores the same
two numbers the Align button does; no subtitle file is written to or altered.

It applies a correction only when the measurement is trustworthy: either a confident result, or
an uncertain one that both methods independently agreed on. Everything else is reported and left
alone, with the track still pre-selected so it is one keypress away.

It also checks each season against itself. A season is usually one release with one problem, so
its episodes should need roughly the same correction. Where they do, an episode that disagrees
with all of its neighbours is treated as suspect however convincing its own peak looked — on a
real season where nine episodes needed about a second, the tenth measured thirty-seven and was
correctly held back. The check only fires when a season is genuinely consistent, and it never
overrules a confident measurement.

## Testing

```bash
npm test
```

Generates fixtures — Windows-1252, UTF-8 BOM, Shift-JIS, a deliberately malformed SRT, a VTT
with NOTE blocks and cue settings, an ASS with override tags and vector drawings — and
asserts the parsers handle them, alongside the filename-parsing cases.

`test/align.test.mjs` runs 13 assertions against synthetic data where the answer is known by
construction: constant offsets from -30 s to +60 s, PAL speed-up and slow-down, drift and offset
combined, the sign convention in both directions, tolerance to deliberately degraded voice
detection (18% of speech frames dropped, 6% of silence frames flipped on), and — the one that
matters most — that subtitles from an unrelated episode are reported as unreliable rather than
given a confident wrong answer. All 13 pass.

`test/retime.test.mjs` runs 10 assertions against a synthetic case built to be difficult: each act
of the episode displaced by a different amount, 41.75 s of spread end to end, and cues missing from
one side. It checks that the correct timing is reconstructed to within 0.000 s, that matches stay
strictly in order, that the translation text is left untouched, that the output is valid SRT which
round-trips through the parser, and — the one that matters most — that subtitles from an unrelated
show produce almost no matches at all.

`npm test` runs all three suites.

## Status

Built in stages. Working now:

- [x] **1** — library scan, subtitle matching, playback with working seek
- [x] **2** — external subtitles: encoding detection, track selector, delay, dual tracks, search
- [x] **3** — embedded subtitle track extraction, audio track selector
- [x] **4** — automatic alignment against the audio
- [x] **5** — persistence and interface polish

All five stages are complete. Subtitle retiming was added afterwards, beyond the original plan.

## Licence

MIT. Bundled ffmpeg binaries carry their own licences, included in `node_modules/ffmpeg-static`.
