// Twitch's stitched ads out of a media playlist (docs/START.md §2.3, §2.4): Lumen's TwitchAds and HlsSplicer in JS.
// Pure: text in, text out; no DOM, no network, no clocks. Self-contained, because hook.js puts this function's own
// source (noAdsFilter.toString()) into Twitch's player worker: nothing outside its body may be used.
function noAdsFilter() {
  'use strict';

  /** Numbers kept this far behind the oldest segment seen are forgotten. */
  const KEEP = 400;
  /** Streams (one per master playlist) remembered at once. */
  const MAX_STREAMS = 8;

  const lines = (text) => text.replace(/\r\n?/g, '\n').split('\n');

  const isMaster = (text) => text.includes('#EXT-X-STREAM-INF');

  /** An ISO date as ms, UTC when it names no zone; null when unreadable. */
  function parseDate(text) {
    if (text == null) return null;
    const t = Date.parse(/(Z|[+-]\d\d(:?\d\d)?)$/i.test(text) ? text : text + 'Z');
    return Number.isNaN(t) ? null : t;
  }

  function parseNumber(text) {
    if (text == null || text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  /** An attribute list (`A="x,y",B=3`) by name, quotes removed. */
  function parseAttributes(list) {
    const result = {};
    let i = 0;
    while (i < list.length) {
      const eq = list.indexOf('=', i);
      if (eq < 0) break;
      const name = list.slice(i, eq).trim();
      i = eq + 1;
      let value;
      if (list[i] === '"') {
        let close = list.indexOf('"', i + 1);
        if (close < 0) close = list.length;
        value = list.slice(i + 1, close);
        i = close + 1;
      } else {
        let comma = list.indexOf(',', i);
        if (comma < 0) comma = list.length;
        value = list.slice(i, comma);
        i = comma;
      }
      if (name) result[name] = value;
      const next = list.indexOf(',', i);
      if (next < 0) break;
      i = next + 1;
    }
    return result;
  }

  function dateRange(line, attributes) {
    const get = (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null);
    return {
      line,
      attributes,
      get,
      start: parseDate(get('START-DATE')),
      end: parseDate(get('END-DATE')),
      duration: parseNumber(get('DURATION')),
      plannedDuration: parseNumber(get('PLANNED-DURATION')),
    };
  }

  /**
   * Whether a moment (ms) lies inside a date range: up to END-DATE, else START-DATE + DURATION (else
   * PLANNED-DURATION), else from the start on (streamlink's is_date_in_daterange). False when either is unknown.
   */
  function rangeContains(range, t) {
    if (t == null || range.start == null) return false;
    if (range.end != null) return range.start <= t && t < range.end;
    const length = range.duration >= 0 ? range.duration : range.plannedDuration >= 0 ? range.plannedDuration : null;
    if (length != null) return range.start <= t && t < range.start + length * 1000;
    return range.start <= t;
  }

  /** Where a range ends (ms), or null when it is open. */
  function rangeEnd(range) {
    if (range.start == null) return null;
    if (range.end != null) return range.end;
    const length = range.duration >= 0 ? range.duration : range.plannedDuration >= 0 ? range.plannedDuration : null;
    return length == null ? null : range.start + length * 1000;
  }

  /** A media playlist taken apart. Never throws: what it doesn't know it keeps as it is. */
  function parseMedia(text) {
    const header = [];
    const segments = [];
    const dateRanges = [];
    let pending = [];
    let mediaSequence = 0;
    let ended = false;
    let map = null;
    let key = null;
    let title = null;
    let duration = 0;
    let discontinuity = false;
    let date = null;
    let carried = null;

    for (const raw of lines(text)) {
      const line = raw.trim();
      if (!line) continue;
      if (line[0] !== '#') {
        const start = date ?? carried;
        segments.push({ sequence: mediaSequence + segments.length, tags: pending, uri: line, duration, title, date: start, map, key, discontinuity });
        carried = start == null ? null : start + duration * 1000;
        pending = [];
        title = null;
        duration = 0;
        discontinuity = false;
        date = null;
        continue;
      }
      const colon = line.indexOf(':');
      const tag = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1);
      switch (tag) {
        case '#EXT-X-MEDIA-SEQUENCE': {
          const n = parseInt(value, 10);
          mediaSequence = Number.isNaN(n) ? 0 : n;
          break;
        }
        case '#EXT-X-DISCONTINUITY-SEQUENCE':
          break;
        case '#EXT-X-DATERANGE':
          dateRanges.push(dateRange(line, parseAttributes(value)));
          break;
        case '#EXT-X-MAP':
          map = line;
          break;
        case '#EXT-X-KEY':
          key = line;
          break;
        case '#EXT-X-DISCONTINUITY':
          discontinuity = true;
          break;
        case '#EXT-X-ENDLIST':
          ended = true;
          break;
        case '#EXT-X-PROGRAM-DATE-TIME':
          date = parseDate(value);
          pending.push(line);
          break;
        case '#EXTINF': {
          const comma = value.indexOf(',');
          duration = parseNumber(comma >= 0 ? value.slice(0, comma) : value) ?? 0;
          title = comma >= 0 && comma < value.length - 1 ? value.slice(comma + 1) : null;
          pending.push(line);
          break;
        }
        default:
          // Before any segment tag, a playlist-level tag; after one, the next segment's.
          if (segments.length === 0 && pending.length === 0 && !discontinuity) header.push(line);
          else pending.push(line);
      }
    }
    return { header, mediaSequence, segments, dateRanges, trailer: pending, ended };
  }

  /** A date range that marks stitched ads. */
  const isAdRange = (range) => range.get('CLASS') === 'twitch-stitched-ad' || (range.get('ID') || '').startsWith('stitched-ad-');

  const isPrefetch = (line) => line.startsWith('#EXT-X-TWITCH-PREFETCH');

  /**
   * Which segments of a Twitch media playlist are ads, by streamlink's rules as of 2026-10-31 (plugins/twitch.py,
   * _is_segment_ad and _is_daterange_ad). `ads` holds source numbers; `inBreak`: the newest segment is an ad (or there
   * are no segments but an ad range); `breakAhead`: an ad range reaches past the newest segment (its prefetch hints
   * may point at ads).
   */
  function scan(text) {
    const playlist = parseMedia(text);
    const ranges = playlist.dateRanges.filter(isAdRange);
    const ads = new Set();
    for (const s of playlist.segments) {
      if ((s.title != null && s.title.includes('Amazon')) || ranges.some((r) => rangeContains(r, s.date))) ads.add(s.sequence);
    }
    const last = playlist.segments[playlist.segments.length - 1];
    const inBreak = last ? ads.has(last.sequence) : ranges.length > 0;
    let breakAhead = false;
    if (last && last.date != null) {
      const lastEnd = last.date + last.duration * 1000;
      breakAhead = ranges.some((r) => r.start != null && (rangeEnd(r) == null || rangeEnd(r) > lastEnd));
    }
    // The break's length and id from the newest ad range.
    const range = ranges[ranges.length - 1];
    let breakSeconds = null;
    let breakId = null;
    if (range) {
      breakSeconds = parseNumber(range.get('X-TV-TWITCH-AD-POD-FILLED-DURATION')) ?? range.duration;
      breakId = range.get('X-TV-TWITCH-AD-COMMERCIAL-ID') ?? range.get('X-TV-TWITCH-AD-ROLL-TYPE') ?? range.get('ID');
    }
    return { playlist, ads, isAd: (s) => ads.has(s.sequence), inBreak, breakAhead, breakSeconds, breakId };
  }

  const absolute = (uri, base) => new URL(uri, base).href;

  /** A tag's `URI="…"` made absolute. */
  const rewriteUri = (line, base) => line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${absolute(uri, base)}"`);

  /** The address a playlist is known by: without its query. */
  function pathKey(url) {
    const u = new URL(url);
    return u.origin + u.pathname;
  }

  /**
   * Cuts segments out of one live stream's media playlists without breaking them for the player: kept segments get
   * numbers of their own, contiguous and the same on every reload and in every variant; a cut is marked with a
   * discontinuity, counted once it leaves the window. No clock.
   */
  function createSplicer() {
    // Source number → { out: own number, cut: a cut came before it }. Inserted in rising order.
    const numbers = new Map();
    const served = new Map();
    let newestSource = null;
    let newestOut = 0;
    let forgottenCuts = 0;

    function forget(playlist) {
      if (playlist.segments.length === 0) return;
      const below = playlist.segments[0].sequence - KEEP;
      for (const [source, v] of numbers) {
        if (source >= below) break;
        if (v.cut) forgottenCuts++;
        numbers.delete(source);
      }
    }

    /**
     * The playlist without the segments `drop` picks and the date ranges `options.dropRange` picks; trailing lines
     * (prefetch hints) only where `options.keepTrailer` says so (all when not given).
     */
    function splice(playlist, url, drop, options = {}) {
      const key = pathKey(url);
      const kept = [];
      let dropped = 0;
      for (const segment of playlist.segments) {
        if (drop(segment)) {
          dropped++;
          continue;
        }
        const known = numbers.get(segment.sequence);
        if (known) {
          kept.push({ segment, out: known.out, cut: known.cut });
          continue;
        }
        // Older than what was numbered already (a variant whose window starts earlier): it can't be placed.
        if (newestSource != null && segment.sequence < newestSource) {
          dropped++;
          continue;
        }
        const out = newestSource == null ? segment.sequence : newestOut + 1;
        const cut = newestSource != null && segment.sequence !== newestSource + 1;
        numbers.set(segment.sequence, { out, cut });
        newestSource = segment.sequence;
        newestOut = out;
        kept.push({ segment, out, cut });
      }
      forget(playlist);

      const first = kept.length > 0 ? kept[0].out : newestSource == null ? playlist.mediaSequence : newestOut + 1;
      let cutsBefore = forgottenCuts;
      for (const v of numbers.values()) if (v.cut && v.out < first) cutsBefore++;
      const newest = kept.length > 0 ? kept[kept.length - 1].out : null;
      const fresh = newest != null && (!served.has(key) || newest > served.get(key));
      const text = write(playlist, url, kept, first, cutsBefore, options);
      return { text, kept: kept.length, dropped, fresh, key, newest };
    }

    /** The cut was answered: the next answer for that address is fresh only with something newer. */
    function markServed(cut) {
      if (cut.newest == null) return;
      if (!served.has(cut.key) || cut.newest > served.get(cut.key)) served.set(cut.key, cut.newest);
    }

    return { splice, served: markServed };
  }

  function write(playlist, url, kept, first, cutsBefore, options) {
    const out = [];
    for (const line of playlist.header) {
      // Twitch's own copy of the media sequence follows ours, so the two never disagree.
      out.push(line.startsWith('#EXT-X-TWITCH-LIVE-SEQUENCE:') ? '#EXT-X-TWITCH-LIVE-SEQUENCE:' + first : line);
    }
    out.push('#EXT-X-MEDIA-SEQUENCE:' + first);
    if (cutsBefore > 0) out.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + cutsBefore);
    for (const range of playlist.dateRanges) if (!options.dropRange || !options.dropRange(range)) out.push(range.line);
    let map = null;
    let key = null;
    for (const { segment, cut } of kept) {
      if (cut) out.push('#EXT-X-DISCONTINUITY');
      if (segment.map != null && segment.map !== map) {
        out.push(rewriteUri(segment.map, url));
        map = segment.map;
      }
      if (segment.key != null && segment.key !== key) {
        out.push(rewriteUri(segment.key, url));
        key = segment.key;
      }
      for (const tag of segment.tags) out.push(tag);
      out.push(absolute(segment.uri, url));
    }
    for (const line of playlist.trailer) {
      if (options.keepTrailer && !options.keepTrailer(line)) continue;
      out.push(isPrefetch(line) ? '#EXT-X-TWITCH-PREFETCH:' + absolute(line.slice(line.indexOf(':') + 1), url) : line);
    }
    if (playlist.ended) out.push('#EXT-X-ENDLIST');
    return out.join('\n') + '\n';
  }

  /**
   * Everything one player worker fetches: each master playlist starts a stream whose variants share one splicer;
   * each media playlist comes out without its ads. Tracks breaks like Lumen's TwitchAdFilter. Never throws: on any
   * error the text as fetched.
   *
   * playlist(text, url) → { text, kind: 'master' | 'media' | 'other' | 'error', inBreak, events, logs }
   *   events: worker → page messages ({ type: 'noads:break', on, seconds }); logs: lines for the console.
   */
  function createSession() {
    const streams = new Map(); // a variant's path key → its stream
    const seen = new Set();

    function newStream() {
      return { splicer: createSplicer(), seenAds: new Set(), breakSegments: 0, breakSeconds: 0, breakTold: null, inBreak: false, vodTold: false };
    }

    function remember(key, stream) {
      streams.delete(key);
      streams.set(key, stream);
      const owners = new Set(streams.values());
      if (owners.size <= MAX_STREAMS) return;
      const oldest = streams.values().next().value;
      for (const [k, s] of streams) if (s === oldest) streams.delete(k);
    }

    function master(text, url) {
      const stream = newStream();
      for (const line of lines(text)) {
        const l = line.trim();
        if (!l) continue;
        if (l[0] !== '#') remember(pathKey(absolute(l, url)), stream);
        else if (l.startsWith('#EXT-X-MEDIA:')) {
          const m = /URI="([^"]*)"/.exec(l);
          if (m) remember(pathKey(absolute(m[1], url)), stream);
        }
      }
    }

    function media(text, url, logs, events) {
      const key = pathKey(url);
      let stream = streams.get(key);
      if (!stream) {
        stream = newStream();
        remember(key, stream);
      }
      const s = scan(text);
      const dropPrefetch = s.inBreak || s.breakAhead;
      const cut = stream.splicer.splice(s.playlist, url, s.isAd, {
        dropRange: isAdRange,
        keepTrailer: (line) => !(dropPrefetch && isPrefetch(line)),
      });
      stream.splicer.served(cut);
      // An ended playlist (a VOD) is whole: never "in a break", even when it ends on ads.
      if (s.playlist.ended) {
        if (!stream.vodTold && s.ads.size > 0) {
          stream.vodTold = true;
          logs.push(`vod: ${s.ads.size} ad segments dropped`);
        }
        return { text: cut.text, inBreak: false };
      }
      track(stream, s, cut, logs, events);
      return { text: cut.text, inBreak: s.inBreak || (stream.inBreak && cut.kept === 0) };
    }

    /** Counts the break's dropped segments; tells when one starts and when content comes back after it. */
    function track(stream, s, cut, logs, events) {
      for (const seg of s.playlist.segments) {
        if (!s.isAd(seg) || stream.seenAds.has(seg.sequence)) continue;
        stream.seenAds.add(seg.sequence);
        stream.breakSegments++;
        stream.breakSeconds += seg.duration;
      }
      if (stream.seenAds.size > 2000) {
        for (const n of stream.seenAds) if (n < s.playlist.mediaSequence) stream.seenAds.delete(n);
      }
      if (s.breakSeconds != null) stream.breakTold = s.breakSeconds;
      if (s.inBreak && !stream.inBreak) {
        stream.inBreak = true;
        logs.push('ad break');
        events.push({ type: 'noads:break', on: true, seconds: s.breakSeconds });
      } else if (!s.inBreak && (stream.inBreak || stream.breakSegments > 0) && cut.fresh) {
        // Also a short break that came and went between two reloads.
        const wasOn = stream.inBreak;
        stream.inBreak = false;
        const seconds = stream.breakTold ?? stream.breakSeconds;
        logs.push(`ad break ${Math.ceil(seconds)} s, ${stream.breakSegments} segments dropped`);
        if (wasOn) events.push({ type: 'noads:break', on: false, seconds: null });
        stream.breakSegments = 0;
        stream.breakSeconds = 0;
        stream.breakTold = null;
      }
    }

    function playlist(text, url) {
      const logs = [];
      const events = [];
      try {
        if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) return { text, kind: 'other', inBreak: false, events, logs };
        const kind = isMaster(text) ? 'master' : 'media';
        const key = pathKey(url);
        if (!seen.has(key)) {
          seen.add(key);
          if (seen.size > 200) seen.delete(seen.values().next().value);
          logs.push(`${kind} ${url}`);
        }
        if (kind === 'master') {
          master(text, url);
          return { text, kind, inBreak: false, events, logs };
        }
        const done = media(text, url, logs, events);
        return { text: done.text, kind, inBreak: done.inBreak, events, logs };
      } catch (e) {
        // Never break playback over the filter: the playlist as fetched.
        logs.push(`playlist filter failed (${(e && e.name) || 'error'}): unfiltered`);
        return { text, kind: 'error', inBreak: false, events, logs };
      }
    }

    return { playlist };
  }

  return { parseMedia, parseAttributes, parseDate, dateRange, rangeContains, isAdRange, isMaster, scan, createSplicer, createSession };
}

if (typeof module === 'object' && module && module.exports) module.exports = noAdsFilter;
