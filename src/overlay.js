// Page world (docs/START.md §2.5): the "Ad break" card over the player while a break is cut out, from the
// 'noads:break' events hook.js passes on from the worker.
(function overlay() {
  'use strict';
  if (typeof window === 'undefined' || window.noAdsOverlay) return;
  Object.defineProperty(window, 'noAdsOverlay', { value: true });

  // Twitch's own ad UI keys off the date ranges we remove; should it show anyway, it stays hidden.
  const style = document.createElement('style');
  style.textContent = `
    [data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"] { display: none !important; }
    .noads-card {
      position: absolute; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
      pointer-events: none; background: rgba(14, 14, 16, 0.72); font: 600 15px/1.4 Inter, Roobert, "Helvetica Neue", Arial, sans-serif;
    }
    .noads-card > div {
      padding: 14px 20px; border-radius: 8px; background: rgba(24, 24, 27, 0.92); color: #efeff1; text-align: center;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    .noads-card small { display: block; margin-top: 4px; font-weight: 400; color: #adadb8; }
  `;
  (document.head || document.documentElement).appendChild(style);

  let card = null;
  let timer = null;
  let endsAt = null;

  /** The biggest video on the page: the player the break is in. */
  function player() {
    let best = null;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const r = video.getBoundingClientRect();
      if (r.width * r.height > bestArea) {
        best = video;
        bestArea = r.width * r.height;
      }
    }
    return best;
  }

  function render() {
    if (!card) return;
    const left = endsAt == null ? null : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    card.querySelector('small').textContent = left == null ? '' : left > 0 ? `about ${left} s left` : 'any moment now';
  }

  function show(seconds) {
    endsAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
    const video = player();
    const host = video && video.parentElement;
    if (!host) return;
    if (!card || card.parentElement !== host) {
      hide();
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      card = document.createElement('div');
      card.className = 'noads-card';
      card.innerHTML = '<div>Ad break: the stream goes on after it<small></small></div>';
      host.appendChild(card);
    }
    render();
    if (!timer) timer = setInterval(render, 1000);
  }

  function hide() {
    if (timer) clearInterval(timer);
    timer = null;
    if (card) card.remove();
    card = null;
  }

  window.addEventListener('noads:break', (event) => {
    const detail = event.detail || {};
    if (detail.on) show(detail.seconds);
    else hide();
  });
})();
