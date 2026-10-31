// hook.js's worker code, built from the functions' own source as in the browser, against a fake worker fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const noAdsFilter = require('../src/filter.js');
const noAdsWorker = require('../src/hook.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/** A worker scope whose fetch answers `bodies[url]`; runs the worker code in it with nothing else in reach. */
function worker(bodies) {
  const posted = [];
  const scope = {
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      const response = new Response(bodies[url] ?? 'nope', { status: url in bodies ? 200 : 404, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    },
    postMessage: (m) => posted.push(m),
  };
  const code = `(${noAdsWorker.toString()})(${noAdsFilter.toString()}, self);`;
  const quiet = { info() {}, warn() {} };
  new Function('self', 'console', 'URL', 'Response', 'Headers', code)(scope, quiet, URL, Response, Headers);
  return { scope, posted };
}

test('worker: media playlists come out filtered, the break is posted; masters and others as they came', async () => {
  const master = fixture('usher_master.m3u8');
  const { scope, posted } = worker({
    'https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8?sig=1': master,
    'https://edge.example/v1/playlist/a.m3u8': fixture('media_ad_start.m3u8'),
    'https://edge.example/v1/segment/x.ts': 'binary',
    'https://edge.example/v1/playlist/garbage.m3u8': '<html>oops</html>',
  });

  assert.equal(await (await scope.fetch('https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8?sig=1')).text(), master);

  const media = await scope.fetch(new Request('https://edge.example/v1/playlist/a.m3u8'));
  const text = await media.text();
  assert.equal(media.status, 200);
  assert.equal(media.url, 'https://edge.example/v1/playlist/a.m3u8');
  assert.ok(!text.includes('Amazon') && text.startsWith('#EXTM3U'));
  assert.deepEqual(posted, [{ type: 'noads:break', on: true, seconds: 30 }]);

  assert.equal(await (await scope.fetch('https://edge.example/v1/segment/x.ts')).text(), 'binary');
  assert.equal(await (await scope.fetch('https://edge.example/v1/playlist/garbage.m3u8')).text(), '<html>oops</html>');
  assert.equal((await scope.fetch('https://edge.example/v1/playlist/missing.m3u8')).status, 404);
});
