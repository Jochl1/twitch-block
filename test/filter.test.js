// filter.js on the fixtures (docs/START.md §6): Lumen's TwitchChecks and HlsChecks, ported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const f = require('../src/filter.js')();

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const MEDIA_URL = 'https://edge.example/v1/playlist/abc.m3u8?token=t';

/** A live media playlist from `first`: "c" content, "a" an ad (title "Amazon"), 2 s each. */
function playlist(first, kinds) {
  let b = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-MAP:URI="init.mp4"\n`;
  for (let i = 0; i < kinds.length; i++) {
    const n = first + i;
    b += `#EXT-X-PROGRAM-DATE-TIME:2026-10-31T12:00:${String((n % 30) * 2).padStart(2, '0')}.000Z\n`;
    b += kinds[i] === 'a' ? `#EXTINF:2.000,Amazon|${n}\n` : '#EXTINF:2.000,live\n';
    b += `seg${n}.mp4\n`;
  }
  return b;
}

const isAmazon = (s) => s.title != null && s.title.includes('Amazon');
const cut = (splicer, first, kinds, url = MEDIA_URL) => splicer.splice(f.parseMedia(playlist(first, kinds)), url, isAmazon);
const count = (text, part) => text.split(part).length - 1;
const segments = (text) => text.split('\n').filter((l) => l && l[0] !== '#').map((l) => l.slice(l.lastIndexOf('/') + 1)).join(',');

test('parse: a real media playlist: numbers, durations, titles, dates carried, the init segment', () => {
  const p = f.parseMedia(fixture('media_live.m3u8'));
  assert.ok(p.segments.length >= 10);
  assert.equal(p.segments[0].sequence, p.mediaSequence);
  assert.equal(p.segments[1].sequence, p.mediaSequence + 1);
  assert.ok(p.segments.every((s) => s.duration === 2 && s.title === 'live' && s.map != null && s.date != null));
  assert.equal(p.segments[1].date, p.segments[0].date + 2000);
  assert.ok(p.dateRanges.length >= 1);
  assert.ok(!p.ended);
  assert.ok(p.trailer.some((l) => l.startsWith('#EXT-X-TWITCH-PREFETCH')), 'prefetch hints are the trailer');

  const carried = f.parseMedia('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-10-31T12:00:00Z\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n');
  assert.equal(carried.segments[1].date, Date.UTC(2026, 9, 31, 12, 0, 4));
  assert.ok(carried.ended);
  assert.equal(f.parseDate('2026-10-31T12:00:00'), Date.UTC(2026, 9, 31, 12), 'no zone: UTC');
});

test('attributes: quoted values with commas, plain values', () => {
  const a = f.parseAttributes('ID="stitched-ad-1,2",CLASS="twitch-stitched-ad",DURATION=30.5,X-A=""');
  assert.equal(a.ID, 'stitched-ad-1,2');
  assert.equal(a.CLASS, 'twitch-stitched-ad');
  assert.equal(a.DURATION, '30.5');
  assert.equal(a['X-A'], '');
});

test('date range: end date, else duration, else planned duration, else open', () => {
  const r = (attrs) => f.dateRange('', f.parseAttributes(attrs));
  const t = Date.UTC(2026, 9, 31, 12, 0, 10);
  assert.ok(f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z",DURATION=30'), t));
  assert.ok(!f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z",DURATION=5'), t));
  assert.ok(!f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z",END-DATE="2026-10-31T12:00:10Z",DURATION=60'), t), 'end is exclusive and wins');
  assert.ok(f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z",PLANNED-DURATION=20'), t));
  assert.ok(f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z"'), t));
  assert.ok(!f.rangeContains(r('START-DATE="2026-10-31T12:00:11Z"'), t));
  assert.ok(!f.rangeContains(r('START-DATE="2026-10-31T12:00:00Z"'), null));
});

test('scan: no ads live; a break starting; a break ending; each rule alone', () => {
  const live = f.scan(fixture('media_live.m3u8'));
  assert.equal(live.ads.size, 0);
  assert.ok(!live.inBreak && !live.breakAhead);

  const start = f.scan(fixture('media_ad_start.m3u8'));
  const ss = start.playlist.segments;
  assert.equal(start.ads.size, 4);
  assert.ok(ss.slice(-4).every(start.isAd) && !start.isAd(ss[0]));
  assert.ok(start.inBreak);
  assert.equal(start.breakSeconds, 30);
  assert.equal(start.breakId, '4711');

  const end = f.scan(fixture('media_ad_end.m3u8'));
  const es = end.playlist.segments;
  assert.ok(es.slice(0, 4).every(end.isAd) && !es.slice(4).some(end.isAd));
  assert.ok(!end.inBreak);

  const byRange = f.scan('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-DATERANGE:ID="stitched-ad-9",START-DATE="2026-10-31T12:00:02Z",DURATION=2\n'
    + '#EXT-X-PROGRAM-DATE-TIME:2026-10-31T12:00:00Z\n#EXTINF:2,live\na.mp4\n#EXTINF:2,live\nb.mp4\n#EXTINF:2,live\nc.mp4\n');
  assert.deepEqual([...byRange.ads], [2]);
  assert.ok(!byRange.inBreak && !byRange.breakAhead);

  const byTitle = f.scan('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2,live\na.mp4\n#EXTINF:2,Amazon|x\nb.mp4\n');
  assert.deepEqual([...byTitle.ads], [6]);
  assert.ok(byTitle.inBreak);

  const ahead = f.scan('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-DATERANGE:ID="stitched-ad-9",START-DATE="2026-10-31T12:00:04Z",DURATION=30\n'
    + '#EXT-X-PROGRAM-DATE-TIME:2026-10-31T12:00:00Z\n#EXTINF:2,live\na.mp4\n#EXTINF:2,live\nb.mp4\n');
  assert.ok(!ahead.inBreak && ahead.breakAhead, 'a range starting after the newest segment: a break ahead');
});

test('splicer: kept segments numbered without gaps across reloads; a cut gets a discontinuity, counted once it leaves', () => {
  const splicer = f.createSplicer();
  const one = cut(splicer, 100, 'cccaa');
  assert.equal(segments(one.text), 'seg100.mp4,seg101.mp4,seg102.mp4');
  assert.ok(one.text.includes('#EXT-X-MEDIA-SEQUENCE:100\n'));
  assert.equal(one.dropped, 2);
  assert.ok(!one.text.includes('Amazon') && !one.text.includes('DISCONTINUITY'));
  assert.ok(one.text.includes('#EXT-X-MAP:URI="https://edge.example/v1/playlist/init.mp4"'), 'the init segment absolute');
  assert.ok(one.text.includes('https://edge.example/v1/playlist/seg100.mp4'), 'segments absolute');

  const two = cut(splicer, 102, 'caacc');
  assert.equal(segments(two.text), 'seg102.mp4,seg105.mp4,seg106.mp4');
  assert.ok(two.text.includes('#EXT-X-MEDIA-SEQUENCE:102\n'), '102 keeps its number');
  assert.equal(count(two.text, '#EXT-X-DISCONTINUITY\n'), 1);
  assert.ok(two.text.indexOf('seg102') < two.text.indexOf('#EXT-X-DISCONTINUITY\n'));
  assert.ok(two.text.indexOf('#EXT-X-DISCONTINUITY\n') < two.text.indexOf('seg105'));

  const three = cut(splicer, 105, 'ccc');
  assert.ok(three.text.includes('#EXT-X-MEDIA-SEQUENCE:103\n'), '105 is 103 now, and stays so');
  assert.ok(three.text.includes('#EXT-X-DISCONTINUITY\n') && !three.text.includes('DISCONTINUITY-SEQUENCE'), 'still in the window');
  assert.ok(three.text.includes('seg107.mp4'));

  const four = cut(splicer, 106, 'cc');
  assert.ok(four.text.includes('#EXT-X-MEDIA-SEQUENCE:104\n'));
  assert.ok(four.text.includes('#EXT-X-DISCONTINUITY-SEQUENCE:1\n'), 'the cut left the window: counted');
  assert.ok(!four.text.includes('#EXT-X-DISCONTINUITY\n'));
});

test("splicer: a variant whose window starts earlier drops what can't be placed; both share numbers", () => {
  const splicer = f.createSplicer();
  cut(splicer, 200, 'cccc');
  const other = splicer.splice(f.parseMedia(playlist(198, 'cccccc')), 'https://edge.example/v1/playlist/other.m3u8', () => false);
  assert.equal(segments(other.text), 'seg200.mp4,seg201.mp4,seg202.mp4,seg203.mp4');
  assert.ok(other.text.includes('#EXT-X-MEDIA-SEQUENCE:200\n'));
});

test("splicer: fresh only with a segment that address wasn't answered with; an empty answer keeps counting on", () => {
  const splicer = f.createSplicer();
  const first = cut(splicer, 1, 'cc');
  assert.ok(first.fresh);
  splicer.served(first);
  assert.ok(!cut(splicer, 1, 'cc').fresh, 'nothing new');
  assert.ok(!cut(splicer, 1, 'cca').fresh, 'only an ad new');
  assert.ok(cut(splicer, 1, 'ccac').fresh);
  const empty = cut(splicer, 10, 'aaa');
  assert.equal(empty.kept, 0);
  assert.ok(!empty.fresh);
  assert.ok(empty.text.includes('#EXT-X-MEDIA-SEQUENCE:4\n'), 'the next own number');
});

test('session: no ads → the same segments, nothing dropped, prefetch hints kept, not in a break', () => {
  const text = fixture('media_live.m3u8');
  const out = f.createSession().playlist(text, MEDIA_URL);
  assert.equal(out.kind, 'media');
  assert.ok(!out.inBreak);
  assert.deepEqual(out.events, []);
  const before = f.parseMedia(text);
  const after = f.parseMedia(out.text);
  assert.equal(after.mediaSequence, before.mediaSequence);
  assert.deepEqual(after.segments.map((s) => s.uri), before.segments.map((s) => s.uri));
  assert.equal(after.dateRanges.length, before.dateRanges.length);
  assert.equal(count(out.text, '#EXT-X-TWITCH-PREFETCH:'), count(text, '#EXT-X-TWITCH-PREFETCH:'));
  assert.ok(out.text.includes('#EXT-X-TWITCH-LIVE-SEQUENCE:7438\n'));
});

test('session: a break start then its end through one stream: ads gone, numbers go on, one discontinuity, told once', () => {
  const session = f.createSession();
  const first = session.playlist(fixture('media_ad_start.m3u8'), MEDIA_URL);
  assert.ok(first.inBreak);
  assert.ok(!first.text.includes('Amazon') && !first.text.includes('stitched-ad') && !first.text.includes('AD-INIT'), 'ads, their range and init segment gone');
  assert.ok(!first.text.includes('PREFETCH'));
  assert.deepEqual(first.events, [{ type: 'noads:break', on: true, seconds: 30 }]);
  assert.ok(first.logs.includes('ad break'));

  const again = session.playlist(fixture('media_ad_start.m3u8'), MEDIA_URL);
  assert.ok(again.inBreak);
  assert.deepEqual(again.events, [], 'told once');

  const end = session.playlist(fixture('media_ad_end.m3u8'), MEDIA_URL);
  assert.ok(!end.inBreak);
  assert.equal(count(end.text, '#EXT-X-DISCONTINUITY\n'), 1, 'the cut marked');
  const a = f.parseMedia(first.text);
  const b = f.parseMedia(end.text);
  assert.equal(b.mediaSequence, a.mediaSequence + a.segments.length, 'numbers go on without the ads\' gap');
  assert.ok(b.mediaSequence >= a.mediaSequence, 'never back');
  assert.ok(end.text.indexOf('#EXT-X-DISCONTINUITY\n') < end.text.indexOf('/v1/segment/CxQD'), 'before the first content');
  assert.ok(end.text.includes(`#EXT-X-TWITCH-LIVE-SEQUENCE:${b.mediaSequence}\n`));
  assert.deepEqual(end.events, [{ type: 'noads:break', on: false, seconds: null }]);
  assert.deepEqual(end.logs, ['ad break 30 s, 8 segments dropped']);
});

test('session: variants of one master share numbering; a master passes through untouched', () => {
  const session = f.createSession();
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://edge.example/v1/playlist/high.m3u8?x=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\nlow.m3u8\n';
  const m = session.playlist(master, 'https://usher.example/api/channel/hls/x.m3u8?sig=s');
  assert.equal(m.kind, 'master');
  assert.equal(m.text, master);
  session.playlist(playlist(100, 'ccaac'), 'https://edge.example/v1/playlist/high.m3u8?x=2');
  const low = session.playlist(playlist(103, 'acc'), 'https://usher.example/api/channel/hls/low.m3u8');
  assert.ok(low.text.includes('#EXT-X-MEDIA-SEQUENCE:102\n'), 'seg104 has the number the other variant gave it');

  for (const name of ['usher_master.m3u8', 'vod_master.m3u8']) {
    const text = fixture(name);
    const out = f.createSession().playlist(text, 'https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8');
    assert.equal(out.kind, 'master');
    assert.equal(out.text, text);
  }
});

test('session: a VOD with a mid-roll and post-roll: both dropped, the map absolute, ended, never a break', () => {
  const session = f.createSession();
  const url = 'https://d1m7jfoe9zdc1j.cloudfront.net/abc/chunked/index-dvr.m3u8';
  const out = session.playlist(fixture('vod_media_ads.m3u8'), url);
  assert.ok(!out.inBreak);
  assert.deepEqual(out.events, []);
  const kept = f.parseMedia(out.text);
  assert.equal(kept.segments.length, 12, 'segment 2 and the last one dropped');
  assert.ok(!out.text.includes('/2.mp4\n') && !out.text.includes('/3136.mp4') && out.text.includes('/3.mp4'));
  assert.ok(out.text.includes('#EXT-X-DISCONTINUITY') && kept.ended && !out.text.includes('stitched-ad'));
  assert.ok(out.text.includes('#EXT-X-MAP:URI="https://d1m7jfoe9zdc1j.cloudfront.net/abc/chunked/init-0.mp4"'));
  assert.ok(out.logs.includes('vod: 2 ad segments dropped'));
  assert.ok(!session.playlist(fixture('vod_media_ads.m3u8'), url).logs.some((l) => l.startsWith('vod:')), 'told once');

  const plain = f.createSession().playlist(fixture('vod_media.m3u8'), url);
  assert.equal(f.parseMedia(plain.text).segments.length, f.parseMedia(fixture('vod_media.m3u8')).segments.length);
});

test('session: garbage in → the text as it came', () => {
  const session = f.createSession();
  for (const text of ['', 'not a playlist', '<html>', '{"error":"x"}']) {
    const out = session.playlist(text, MEDIA_URL);
    assert.equal(out.text, text);
    assert.deepEqual(out.events, []);
  }
  const broken = session.playlist('#EXTM3U\n#EXTINF:2,live\nhttp://[bad\n', 'not a url');
  assert.equal(broken.text, '#EXTM3U\n#EXTINF:2,live\nhttp://[bad\n');
  assert.equal(broken.kind, 'error');
  assert.ok(broken.logs[0].startsWith('playlist filter failed'));
});
