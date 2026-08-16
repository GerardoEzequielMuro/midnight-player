import { parseName } from '../server/lib/parseName.js';
const names = [
 "Shinya.Shokudo.S01E05.720p.x264.mkv",
 "Shinya.Shokudo.S02E10.720p.x264.mkv",
 "Midnight.Diner.S02E05.2011.1080p.BluRay.x264 WiKi.en.srt",
 "Midnight.Diner.S02E10.Episode.20.1080p.NF.WEBRip.DDP2.0.x264-CLC_track3_[eng].srt",
 "Shinya Shokudo Season 2 Ep01 (1280x720 x264).srt",
 "Shinya Shokudo ep05 (1280x720 x264).srt",
 "Shinya Shokudo E01 (1280x720 x264).srt",
 "Shinya Shokudo ep10 finale (1280x720 x264).srt",
 "Shinya.Shokudou.S3.EP04.srt",
 "Some.Show.1x04.avi",
 "Some Show - 07.mkv",
 "random file with no number.mkv",
];
for (const n of names) {
  const r = parseName(n);
  console.log(
    (r.season==null?' - ':'S'+String(r.season).padStart(2,'0')) +
    (r.episode==null?'  - ':'E'+String(r.episode).padStart(2,'0')),
    String(r.confidence).padEnd(5),
    (r.pattern+'         ').slice(0,12),
    '| '+r.titleKey.padEnd(18), '| '+n);
}
