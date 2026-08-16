import fs from 'node:fs';
import iconv from 'iconv-lite';

fs.mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
const out = (name, data) => fs.writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), data);

const srt =
  '1\r\n' +
  '00:00:01,000 --> 00:00:03,500\r\n' +
  'Café con leche y años\r\n' +
  '\r\n' +
  '2\r\n' +
  '00:00:04,000 --> 00:00:06,000\r\n' +
  '<i>italics</i> and a\r\n' +
  'second line\r\n';

out('win1252.srt', iconv.encode(srt, 'win1252'));
out('utf8bom.srt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srt, 'utf8')]));
out('shiftjis.srt', iconv.encode('1\r\n00:00:01,000 --> 00:00:03,000\r\nこんばんは、いらっしゃい\r\n', 'shift_jis'));

// Deliberately messy SRT: no trailing blank line, a blank line inside a cue,
// a duplicated index, and LF endings mixed in.
out(
  'messy.srt',
  Buffer.from(
    '1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n1\n00:00:03,000 --> 00:00:04,000\nline one\n\nline two after a blank\n\n3\n00:00:05,000 --> 00:00:06,000\nlast, no trailing newline',
    'utf8'
  )
);

out(
  'sample.vtt',
  Buffer.from(
    'WEBVTT\n\n' +
      'NOTE this is a comment\nthat spans lines\n\n' +
      'cue-id-1\n00:01.000 --> 00:03.000 align:start position:10%\n<v Speaker>Hello there</v>\n\n' +
      '2\n00:00:04.000 --> 00:00:06.000\nSecond cue\n',
    'utf8'
  )
);

const B = '\\'; // a single backslash, kept out of the template literals below
out(
  'sample.ass',
  Buffer.from(
    '[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      `Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{${B}i1}Slanted{${B}i0} text, with a comma\n` +
      'Comment: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,should not appear\n' +
      `Dialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,{${B}p1}m 0 0 l 10 10{${B}p0}\n` +
      `Dialogue: 0,0:00:11.00,0:00:13.00,Default,,0,0,0,,Line one${B}NLine two\n` +
      `Dialogue: 0,0:00:14.00,0:00:16.00,Default,,0,0,0,,{${B}pos(320,240)${B}fad(200,200)}positioned\n`,
    'utf8'
  )
);

console.log('fixtures written');
