// Page world (docs/START.md §2.2): replaces window.Worker so Twitch's player worker starts with our fetch wrapper,
// which runs filter.js on every media playlist the player loads. Break messages from the worker go to overlay.js.

/**
 * Runs first inside Twitch's player worker: wraps its fetch. Self-contained (its source goes into the worker as
 * text): it uses only its arguments and the worker's own globals.
 */
function noAdsWorker(makeFilter, scope) {
  'use strict';
  const filter = makeFilter();
  const session = filter.createSession();
  const nativeFetch = scope.fetch.bind(scope);
  /** A backup request that takes longer than this is given up (the player waits on it). */
  const TIMEOUT_MS = 4000;

  function urlOf(input) {
    try {
      return new URL(typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input));
    } catch (e) {
      return null;
    }
  }

  async function timedFetch(url, init) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      return await nativeFetch(url, Object.assign({}, init, { signal: abort.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // Stage 2 (docs/START.md §3): per channel, during one break, the backup copy's media playlist address.
  // { next: index into PLAYER_TYPES, url, type, pending, failed }
  const backups = new Map();

  async function acquire(b, info) {
    while (b.next < filter.PLAYER_TYPES.length) {
      const type = filter.PLAYER_TYPES[b.next];
      try {
        const req = filter.tokenRequest(info.login, type);
        const answer = await timedFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
        const token = filter.readToken(await answer.json());
        if (!token) throw new Error('no token');
        const masterUrl = filter.usherUrl(info.login, token, Math.floor(Math.random() * 1000000));
        const master = await timedFetch(masterUrl);
        if (!master.ok) throw new Error('usher ' + master.status);
        const url = filter.pickVariant(await master.text(), master.url || masterUrl, info);
        if (!url) throw new Error('no variant');
        b.url = url;
        b.type = type;
        console.info(`noads: backup stream: ${type}`);
        return url;
      } catch (e) {
        console.info(`noads: backup ${type} failed (${e && e.message}): next`);
        b.next++;
      }
    }
    b.failed = true;
    console.info('noads: no backup stream for this break: the picture pauses');
    return null;
  }

  function backupUrl(info) {
    let b = backups.get(info.login);
    if (!b) {
      b = { next: 0, url: null, type: null, pending: null, failed: false };
      backups.set(info.login, b);
    }
    if (b.url || b.failed) return Promise.resolve(b.url);
    if (!b.pending) b.pending = acquire(b, info).finally(() => (b.pending = null));
    return b.pending;
  }

  /** This player type doesn't do: the next one on the next reload. */
  function reject(login, why) {
    const b = backups.get(login);
    if (!b || !b.url) return;
    console.info(`noads: backup ${b.type} ${why}: next`);
    b.url = null;
    b.next++;
  }

  /** The backup copy's media playlist for this break, or null (stage 1: the picture pauses). */
  async function backupFor(info) {
    if (!info.login) return null;
    if (!info.wantsBackup) {
      backups.delete(info.login);
      return null;
    }
    try {
      const url = await backupUrl(info);
      if (!url) return null;
      const r = await timedFetch(url);
      if (!r.ok) {
        reject(info.login, 'answered ' + r.status);
        return null;
      }
      return { text: await r.text(), url: r.url || url };
    } catch (e) {
      reject(info.login, `failed (${e && e.message})`);
      return null;
    }
  }

  scope.fetch = async function fetch(input, init) {
    const response = await nativeFetch(input, init);
    const url = urlOf(input);
    if (!url || !url.pathname.endsWith('.m3u8') || !response.ok) return response;
    try {
      const text = await response.clone().text();
      const href = response.url || url.href;
      const info = session.info(text, href);
      const backup = await backupFor(info);
      const out = session.playlist(text, href, backup);
      if (out.backupHadAds) reject(info.login, 'has ads too');
      for (const line of out.logs) console.info('noads: ' + line);
      for (const message of out.events) scope.postMessage(message);
      if (out.text === text) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      const filtered = new Response(out.text, { status: response.status, statusText: response.statusText, headers });
      Object.defineProperty(filtered, 'url', { value: response.url });
      return filtered;
    } catch (e) {
      // Never break playback over the filter: the response as fetched.
      console.warn('noads: playlist filter failed: unfiltered', e);
      return response;
    }
  };
}

(function install() {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Worker !== 'function' || typeof noAdsFilter !== 'function') return;
  if (window.Worker.noAds) return;

  const NativeWorker = window.Worker;
  const workerCode = `(${noAdsWorker.toString()})(${noAdsFilter.toString()}, self);\n`;
  const PLAYER = /wasmworker/i;

  /** Twitch's player worker script as text, or null for any other worker. */
  function playerSource(url) {
    const href = String(url);
    if (href.startsWith('blob:')) {
      // Synchronously: Twitch may revoke the blob right after `new Worker`.
      const xhr = new XMLHttpRequest();
      xhr.open('GET', href, false);
      xhr.send();
      return PLAYER.test(xhr.responseText) ? xhr.responseText : null;
    }
    if (PLAYER.test(href)) return `importScripts(${JSON.stringify(new URL(href, location.href).href)});\n`;
    return null;
  }

  class Worker extends NativeWorker {
    constructor(url, options) {
      let source = null;
      try {
        source = playerSource(url);
      } catch (e) {
        console.warn('noads: could not read worker', String(url), e);
      }
      const hooked = source != null;
      const target = hooked ? URL.createObjectURL(new Blob([workerCode, source], { type: 'text/javascript' })) : url;
      super(target, options);
      console.info(`noads: worker ${String(url)} (${hooked ? 'hooked' : 'passed'})`);
      if (!hooked) return;
      setTimeout(() => URL.revokeObjectURL(target), 10000);
      // Added before Twitch's own listeners (and its onmessage), so ours can keep them from seeing our messages.
      this.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data.type !== 'string' || !data.type.startsWith('noads:')) return;
        event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent(data.type, { detail: data }));
      });
    }
  }
  Object.defineProperty(Worker, 'noAds', { value: true });
  window.Worker = Worker;
})();

if (typeof module === 'object' && module && module.exports) module.exports = noAdsWorker;
