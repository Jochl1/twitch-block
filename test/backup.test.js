// Stage 2 (docs/START.md §3): a backup copy fills the break; the requests for it; the worker trying player types.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const noAdsFilter = require('../src/filter.js');
const noAdsWorker = require('../src/hook.js');
const f = noAdsFilter();

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = Date.UTC(2026, 9, 31, 12, 0, 0);
const MAIN = 'https://edge.example/v1/playlist/main.m3u8';
const BACKUP = 'https://edge.example/v1/playlist/backup.m3u8';

/** The stream's own playlist from `first`: "c" content, "a" an ad; segment n starts at BASE + 2n s. */
function main(first, kinds) {
  let b = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
  for (let i = 0; i < kinds.length; i++) {
    const n = first + i;
    b += `#EXT-X-PROGRAM-DATE-TIME:${new Date(BASE + n * 2000).toISOString()}\n`;
    b += kinds[i] === 'a' ? `#EXTINF:2.000,Amazon|${n}\n` : '#EXTINF:2.000,live\n';
    b += `m${n}.ts\n`;
  }
  return b;
}

/** The backup copy of the same moments, numbered its own way (n + 5000), ads where `kinds` says. */
function backup(first, count, kinds = '') {
  let b = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first + 5000}\n#EXT-X-MAP:URI="binit.mp4"\n`;
  for (let i = 0; i < count; i++) {
    const n = first + i;
    b += `#EXT-X-PROGRAM-DATE-TIME:${new Date(BASE + n * 2000).toISOString()}\n`;
    b += kinds[i] === 'a' ? `#EXTINF:2.000,Amazon|${n}\n` : '#EXTINF:2.000,live\n';
    b += `b${n}.ts\n`;
  }
  return b;
}

const segments = (text) => text.split('\n').filter((l) => l && l[0] !== '#').map((l) => l.slice(l.lastIndexOf('/') + 1)).join(',');
const sequence = (text) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1]);
const count = (text, part) => text.split(part).length - 1;

test('session: a break filled from the backup copy, then the stream itself again; numbers only go up', () => {
  const s = f.createSession();
  s.playlist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n${MAIN}\n`,'https://usher.ttvnw.net/api/v2/channel/hls/somebody.m3u8?sig=x');
  const step = (text, b) => {
    const info = s.info(text, MAIN);
    return { info, out: s.playlist(text, MAIN, info.wantsBackup && b ? { text: b, url: BACKUP } : undefined) };
  };

  const before = step(main(100, 'cccccccccc'));
  assert.equal(before.info.login, 'somebody');
  assert.equal(before.info.height, 720);
  assert.ok(!before.info.wantsBackup);
  assert.equal(segments(before.out.text), 'm100.ts,m101.ts,m102.ts,m103.ts,m104.ts,m105.ts,m106.ts,m107.ts,m108.ts,m109.ts');

  // The break starts: the backup's segments from where the stream's own content ended.
  const start = step(main(104, 'ccccccaaaa'), backup(104, 10));
  assert.ok(start.info.wantsBackup);
  assert.equal(segments(start.out.text), 'b110.ts,b111.ts,b112.ts,b113.ts');
  assert.equal(sequence(start.out.text), 110);
  assert.equal(count(start.out.text, '#EXT-X-DISCONTINUITY\n'), 1);
  assert.ok(start.out.text.includes('#EXT-X-MAP:URI="https://edge.example/v1/playlist/binit.mp4"'), 'the backup\'s init segment, absolute');
  assert.deepEqual(start.out.events, [{ type: 'noads:break', on: true, seconds: null, backup: true }]);
  assert.ok(start.out.inBreak);

  const during = step(main(108, 'ccaaaaaaaa'), backup(108, 10));
  assert.equal(segments(during.out.text), 'b110.ts,b111.ts,b112.ts,b113.ts,b114.ts,b115.ts,b116.ts,b117.ts');
  assert.equal(sequence(during.out.text), 110);
  assert.deepEqual(during.out.events, []);

  // Content again: the backup goes on until the stream's own content reaches past it.
  const ending = step(main(112, 'aaaaaacccc'), backup(112, 10));
  assert.ok(ending.info.wantsBackup, 'still in the break as far as the stream knows');
  assert.equal(segments(ending.out.text), 'b112.ts,b113.ts,b114.ts,b115.ts,b116.ts,b117.ts,b118.ts,b119.ts,b120.ts,b121.ts');
  assert.ok(ending.out.text.includes('#EXT-X-DISCONTINUITY-SEQUENCE:1\n'), 'the cut into the backup left the window');
  assert.deepEqual(ending.out.events, [{ type: 'noads:break', on: false, seconds: null, backup: false }]);

  const after = step(main(116, 'aacccccccc'), backup(116, 10));
  assert.ok(!after.info.wantsBackup);
  assert.equal(segments(after.out.text), 'm122.ts,m123.ts,m124.ts,m125.ts', 'what the backup showed already is left out');
  assert.equal(sequence(after.out.text), 122);
  assert.ok(after.out.text.indexOf('#EXT-X-DISCONTINUITY\n') < after.out.text.indexOf('m122.ts'));
  assert.ok(!after.out.text.includes('binit'));

  const seqs = [before, start, during, ending, after].map((x) => sequence(x.out.text));
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'MEDIA-SEQUENCE never goes back');
});

test('session: a backup with ads of its own is not used; the card shows', () => {
  const s = f.createSession();
  s.playlist(main(100, 'cccccc'), MAIN);
  const out = s.playlist(main(100, 'ccccaa'), MAIN, { text: backup(100, 6, 'ccccaa'), url: BACKUP });
  assert.ok(out.backupHadAds);
  assert.equal(segments(out.text), 'm100.ts,m101.ts,m102.ts,m103.ts');
  assert.deepEqual(out.events, [{ type: 'noads:break', on: true, seconds: null, backup: false }]);
  const info = s.info(main(100, 'cccccc'), MAIN);
  assert.equal(info.login, null, 'no master seen: no channel, no backup');
});

test('requests: the token query, its answer, usher, the closest variant, the channel', () => {
  const req = f.tokenRequest('pgl', 'embed');
  assert.equal(req.url, 'https://gql.twitch.tv/gql');
  assert.equal(req.headers['Client-ID'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
  const body = JSON.parse(req.body);
  assert.equal(body.operationName, 'PlaybackAccessToken');
  assert.deepEqual(body.variables, { isLive: true, login: 'pgl', isVod: false, vodID: '', playerType: 'embed', platform: 'site' });

  const token = f.readToken(JSON.parse(fixture('gql_token.json')));
  assert.equal(token.signature, '0000000000000000000000000000000000000000');
  assert.ok(token.value.includes('"player_type":"embed"'));
  assert.equal(f.readToken({ data: { streamPlaybackAccessToken: null } }), null);
  assert.equal(f.readToken({ errors: [{ message: 'PersistedQueryNotFound' }] }), null);

  const usher = new URL(f.usherUrl('pgl', token, 42));
  assert.equal(usher.origin + usher.pathname, 'https://usher.ttvnw.net/api/v2/channel/hls/pgl.m3u8');
  assert.equal(usher.searchParams.get('sig'), token.signature);
  assert.equal(usher.searchParams.get('token'), token.value);
  assert.equal(usher.searchParams.get('p'), '42');
  assert.equal(usher.searchParams.get('supported_codecs'), 'h264');

  const master = fixture('usher_master.m3u8');
  const variants = f.parseMaster(master, 'https://usher.ttvnw.net/x.m3u8');
  const name = (url) => variants.find((v) => v.url === url).height;
  assert.equal(name(f.pickVariant(master, 'https://usher.ttvnw.net/x.m3u8', { height: 720, bandwidth: 3000000 })), 720);
  assert.equal(name(f.pickVariant(master, 'https://usher.ttvnw.net/x.m3u8', { height: 1440 })), 1080);
  assert.equal(name(f.pickVariant(master, 'https://usher.ttvnw.net/x.m3u8', {})), 1080, 'unknown: the best');
  assert.ok(variants.some((v) => v.audioOnly) && !variants.filter((v) => v.audioOnly).some((v) => v.height));

  assert.equal(f.channelOf('https://usher.ttvnw.net/api/v2/channel/hls/MortenRoyale.m3u8?sig=1'), 'mortenroyale');
  assert.equal(f.channelOf('https://usher.ttvnw.net/vod/v2/123.m3u8'), null);
});

test('worker: in a break it fetches a token, usher and the backup; a backup with ads gives way to the next player type', async () => {
  const requests = [];
  let reload = 0;
  const posted = [];
  const scope = {
    postMessage: (m) => posted.push(m),
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      requests.push(url);
      let body = null;
      if (url === 'https://gql.twitch.tv/gql') {
        const type = JSON.parse(init.body).variables.playerType;
        body = JSON.stringify({ data: { streamPlaybackAccessToken: { signature: 's', value: `{"player_type":"${type}"}` } } });
      } else if (url.startsWith('https://usher.ttvnw.net/api/v2/channel/hls/somebody.m3u8?platform=web')) {
        const type = JSON.parse(new URL(url).searchParams.get('token')).player_type;
        body = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=852x480\nhttps://edge.example/v1/playlist/${type}.m3u8\n`;
      } else if (url === 'https://usher.ttvnw.net/api/v2/channel/hls/somebody.m3u8?sig=main') {
        body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nhttps://edge.example/v1/playlist/main.m3u8\n';
      } else if (url === MAIN) {
        body = [main(100, 'cccccc'), main(102, 'ccccaa'), main(104, 'ccaaaa')][reload++];
      } else if (url === 'https://edge.example/v1/playlist/embed.m3u8') {
        body = backup(102, 6, 'ccccaa');
      } else if (url === 'https://edge.example/v1/playlist/popout.m3u8') {
        body = backup(104, 6);
      }
      const response = new Response(body ?? 'nope', { status: body == null ? 404 : 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    },
  };
  const quiet = { info() {}, warn() {} };
  new Function('self', 'console', `(${noAdsWorker.toString()})(${noAdsFilter.toString()}, self);`)(scope, quiet);

  await (await scope.fetch('https://usher.ttvnw.net/api/v2/channel/hls/somebody.m3u8?sig=main')).text();
  assert.equal(segments(await (await scope.fetch(MAIN)).text()), 'm100.ts,m101.ts,m102.ts,m103.ts,m104.ts,m105.ts');

  const withAds = await (await scope.fetch(MAIN)).text();
  assert.equal(segments(withAds), 'm102.ts,m103.ts,m104.ts,m105.ts', 'embed has ads too: the stream without its ads');
  assert.deepEqual(posted, [{ type: 'noads:break', on: true, seconds: null, backup: false }]);

  const filled = await (await scope.fetch(MAIN)).text();
  assert.equal(segments(filled), 'b106.ts,b107.ts,b108.ts,b109.ts', 'popout fills the break');
  assert.deepEqual(posted.at(-1), { type: 'noads:break', on: true, seconds: null, backup: true });
  assert.equal(requests.filter((u) => u === 'https://gql.twitch.tv/gql').length, 2, 'one token per player type');
});
