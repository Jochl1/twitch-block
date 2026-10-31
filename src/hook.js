// Page world (docs/START.md §2.2): replaces window.Worker so Twitch's player worker starts with our fetch wrapper,
// which runs filter.js on every media playlist the player loads. Break messages from the worker go to overlay.js.

/**
 * Runs first inside Twitch's player worker: wraps its fetch. Self-contained (its source goes into the worker as
 * text): it uses only its arguments and the worker's own globals.
 */
function noAdsWorker(makeFilter, scope) {
  'use strict';
  const session = makeFilter().createSession();
  const nativeFetch = scope.fetch.bind(scope);

  function urlOf(input) {
    try {
      return new URL(typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input));
    } catch (e) {
      return null;
    }
  }

  scope.fetch = async function fetch(input, init) {
    const response = await nativeFetch(input, init);
    const url = urlOf(input);
    if (!url || !url.pathname.endsWith('.m3u8') || !response.ok) return response;
    try {
      const text = await response.clone().text();
      const out = session.playlist(text, response.url || url.href);
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
