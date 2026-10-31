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

  /** Seconds a segment from another source may start before the last one placed ends (clocks differ a little). */
  const OVERLAP = 0.5;

  /**
   * Cuts segments out of one live stream's media playlists without breaking them for the player: kept segments get
   * numbers of their own, contiguous and the same on every reload and in every variant; a cut is marked with a
   * discontinuity, counted once it leaves the window. No clock.
   *
   * Segments may come from more than one source (`segment.source`, default 'main': the stream's own variants, which
   * share their numbers; else a backup copy). A segment from another source than the last one placed is placed only
   * when it starts where that one ended or later (by program date), and starts a new run: earlier segments are left
   * out of the answers from then on, since what lay between them isn't in the playlist any more.
   */
  function createSplicer() {
    // Source and number ("main:7438") → { out: own number, cut: a cut came before it }. Inserted in rising order.
    const numbers = new Map();
    const served = new Map();
    const held = new Map(); // address → the last answer with segments in it
    let last = null; // the newest placed: { source, sequence, end }
    let newestOut = 0;
    let floor = -Infinity; // the own number the current run starts at
    let forgottenCuts = 0;

    function forget() {
      const below = newestOut - KEEP;
      for (const [id, v] of numbers) {
        if (v.out >= below) break;
        if (v.cut) forgottenCuts++;
        numbers.delete(id);
      }
    }

    /**
     * The playlist without the segments `drop` picks and the date ranges `options.dropRange` picks; trailing lines
     * (prefetch hints) only where `options.keepTrailer` says so (all when not given).
     */
    function splice(playlist, url, drop, options = {}) {
      const key = pathKey(url);
      let kept = [];
      let dropped = 0;
      for (const segment of playlist.segments) {
        if (drop(segment)) {
          dropped++;
          continue;
        }
        const source = segment.source || 'main';
        const id = source + ':' + segment.sequence;
        const known = numbers.get(id);
        if (known) {
          kept.push({ segment, out: known.out, cut: known.cut });
          continue;
        }
        if (last != null) {
          // Older than what was numbered already (a variant whose window starts earlier): it can't be placed.
          if (source === last.source && segment.sequence < last.sequence) {
            dropped++;
            continue;
          }
          // Another source's segment for a moment already shown.
          if (source !== last.source && segment.date != null && last.end != null && segment.date < last.end - OVERLAP * 1000) {
            dropped++;
            continue;
          }
        }
        const out = last == null ? segment.sequence : newestOut + 1;
        const cut = last != null && (source !== last.source || segment.sequence !== last.sequence + 1);
        if (last != null && source !== last.source) floor = out;
        numbers.set(id, { out, cut });
        last = { source, sequence: segment.sequence, end: segment.date == null ? null : segment.date + segment.duration * 1000 };
        newestOut = out;
        kept.push({ segment, out, cut });
      }
      forget();
      // Only the current run, in order, and only its newest stretch without a gap.
      kept = kept.filter((k) => k.out >= floor).sort((a, b) => a.out - b.out);
      let from = kept.length - 1;
      while (from > 0 && kept[from - 1].out === kept[from].out - 1) from--;
      if (from > 0) {
        dropped += from;
        kept = kept.slice(from);
      }

      const first = kept.length > 0 ? kept[0].out : last == null ? playlist.mediaSequence : newestOut + 1;
      let cutsBefore = forgottenCuts;
      for (const v of numbers.values()) if (v.cut && v.out < first) cutsBefore++;
      const newest = kept.length > 0 ? kept[kept.length - 1].out : null;
      const fresh = newest != null && (!served.has(key) || newest > served.get(key));
      // Nothing to show (a long break without a backup, or the stream's own content not yet past the backup's): the
      // last answer again. An empty live playlist reads as the stream gone, and Twitch shows its offline screen.
      if (kept.length === 0 && held.has(key)) return { text: held.get(key), kept: 0, dropped, fresh: false, key, newest: null, held: true };
      const text = write(playlist, url, kept, first, cutsBefore, options);
      if (kept.length > 0) {
        held.delete(key);
        held.set(key, text);
        if (held.size > 16) held.delete(held.keys().next().value);
      }
      return { text, kept: kept.length, dropped, fresh, key, newest, held: false };
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
      const base = segment.base || url;
      if (cut) out.push('#EXT-X-DISCONTINUITY');
      if (segment.map != null) {
        const line = rewriteUri(segment.map, base);
        if (line !== map) out.push(line);
        map = line;
      }
      if (segment.key != null) {
        const line = rewriteUri(segment.key, base);
        if (line !== key) out.push(line);
        key = line;
      }
      for (const tag of segment.tags) out.push(tag);
      out.push(absolute(segment.uri, base));
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
   * info(text, url) → { login, height, bandwidth, wantsBackup }: whether this media playlist is in a break (stage 2:
   *   the worker then fetches a backup copy's media playlist and gives it to playlist()), without changing anything.
   * playlist(text, url, backup?) → { text, kind: 'master' | 'media' | 'other' | 'error', inBreak, backupHadAds,
   *   events, logs }. backup: { text, url } of the backup copy's media playlist, used while the break lasts unless it
   *   has ads itself (backupHadAds: try another). events: worker → page messages ({ type: 'noads:break', on,
   *   seconds, backup }); logs: lines for the console.
   */
  function createSession() {
    const streams = new Map(); // a variant's path key → its stream
    const variants = new Map(); // a variant's path key → { height, bandwidth }
    const seen = new Set();

    function newStream(login) {
      return { login, splicer: createSplicer(), seenAds: new Set(), breakSegments: 0, breakSeconds: 0, breakTold: null, inBreak: false, shown: null, vodTold: false, holding: false };
    }

    function remember(key, stream) {
      streams.delete(key);
      streams.set(key, stream);
      const owners = new Set(streams.values());
      if (owners.size <= MAX_STREAMS) return;
      const oldest = streams.values().next().value;
      for (const [k, s] of streams) {
        if (s !== oldest) continue;
        streams.delete(k);
        variants.delete(k);
      }
    }

    function master(text, url) {
      const stream = newStream(channelOf(url));
      for (const v of parseMaster(text, url)) {
        remember(v.key, stream);
        variants.set(v.key, { height: v.height, bandwidth: v.bandwidth });
      }
    }

    function streamFor(url) {
      const key = pathKey(url);
      let stream = streams.get(key);
      if (!stream) {
        stream = newStream(null);
        remember(key, stream);
      }
      return stream;
    }

    function info(text, url) {
      try {
        const key = pathKey(url);
        const stream = streams.get(key);
        const variant = variants.get(key) || {};
        if (!stream || !stream.login || typeof text !== 'string' || isMaster(text)) return { login: null, wantsBackup: false };
        const s = scan(text);
        return { login: stream.login, height: variant.height ?? null, bandwidth: variant.bandwidth ?? null, wantsBackup: !s.playlist.ended && (s.inBreak || stream.inBreak) };
      } catch (e) {
        return { login: null, wantsBackup: false };
      }
    }

    function media(text, url, backup, logs, events) {
      const stream = streamFor(url);
      const s = scan(text);
      // Stage 2: the backup copy's segments while the break lasts, until the stream's own content takes over again.
      let b = null;
      let backupHadAds = false;
      if (backup && (s.inBreak || stream.inBreak) && !s.playlist.ended) {
        const bs = scan(backup.text);
        if (bs.inBreak) backupHadAds = true;
        else b = bs;
      }
      let playlist = s.playlist;
      let drop = s.isAd;
      if (b) {
        const source = 'backup:' + pathKey(backup.url);
        const backupSegments = b.playlist.segments.map((seg) => Object.assign({}, seg, { source, base: backup.url, ad: b.isAd(seg) }));
        const own = s.playlist.segments.map((seg) => Object.assign({}, seg, { ad: s.isAd(seg) }));
        // The backup's first: the stream's own content after the break is placed only from where the backup got to.
        playlist = Object.assign({}, s.playlist, { segments: backupSegments.concat(own) });
        drop = (seg) => seg.ad;
      }
      const dropPrefetch = s.inBreak || s.breakAhead;
      const cut = stream.splicer.splice(playlist, url, drop, {
        dropRange: isAdRange,
        keepTrailer: (line) => !(dropPrefetch && isPrefetch(line)),
      });
      stream.splicer.served(cut);
      if (cut.held !== stream.holding) {
        stream.holding = cut.held;
        if (cut.held) logs.push('nothing new to show: the last playlist again');
      }
      // An ended playlist (a VOD) is whole: never "in a break", even when it ends on ads.
      if (s.playlist.ended) {
        if (!stream.vodTold && s.ads.size > 0) {
          stream.vodTold = true;
          logs.push(`vod: ${s.ads.size} ad segments dropped`);
        }
        return { text: cut.text, inBreak: false, backupHadAds };
      }
      track(stream, s, cut, b != null, logs, events);
      return { text: cut.text, inBreak: s.inBreak || (stream.inBreak && cut.kept === 0), backupHadAds };
    }

    /**
     * Counts the break's dropped segments; tells when one starts, when it switches between the backup copy and the
     * card, and when content comes back after it.
     */
    function track(stream, s, cut, backupUsed, logs, events) {
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
      if (s.inBreak) {
        if (!stream.inBreak) {
          stream.inBreak = true;
          logs.push('ad break');
        }
        const shown = backupUsed ? 'backup' : 'card';
        if (shown !== stream.shown) {
          stream.shown = shown;
          logs.push(backupUsed ? 'showing the backup stream' : 'showing the card (no backup)');
          events.push({ type: 'noads:break', on: true, seconds: s.breakSeconds, backup: backupUsed });
        }
      } else if ((stream.inBreak || stream.breakSegments > 0) && cut.fresh) {
        // Also a short break that came and went between two reloads.
        stream.inBreak = false;
        const seconds = stream.breakTold ?? stream.breakSeconds;
        logs.push(`ad break ${Math.ceil(seconds)} s, ${stream.breakSegments} segments dropped`);
        if (stream.shown) events.push({ type: 'noads:break', on: false, seconds: null, backup: false });
        stream.shown = null;
        stream.breakSegments = 0;
        stream.breakSeconds = 0;
        stream.breakTold = null;
      }
    }

    function playlist(text, url, backup) {
      const logs = [];
      const events = [];
      try {
        if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) return { text, kind: 'other', inBreak: false, backupHadAds: false, events, logs };
        const kind = isMaster(text) ? 'master' : 'media';
        const key = pathKey(url);
        if (!seen.has(key)) {
          seen.add(key);
          if (seen.size > 200) seen.delete(seen.values().next().value);
          logs.push(`${kind} ${url.split('?')[0]}`);
        }
        if (kind === 'master') {
          master(text, url);
          return { text, kind, inBreak: false, backupHadAds: false, events, logs };
        }
        const done = media(text, url, backup, logs, events);
        return { text: done.text, kind, inBreak: done.inBreak, backupHadAds: done.backupHadAds, events, logs };
      } catch (e) {
        // Never break playback over the filter: the playlist as fetched.
        logs.push(`playlist filter failed (${(e && e.name) || 'error'}): unfiltered`);
        return { text, kind: 'error', inBreak: false, backupHadAds: false, events, logs };
      }
    }

    return { info, playlist };
  }

  // Stage 2 (docs/START.md §3): what the worker asks Twitch for a backup copy. The worker does the fetching.

  /** Twitch's public web client id (streamlink, Pi-Cast and Lumen use it). */
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  /** PlaybackAccessToken's persisted-query hash, from Lumen (2026-10-31); on PersistedQueryNotFound see streamlink. */
  const TOKEN_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  /** Player types asked for a backup copy, in order; which come back without ads changes over time. */
  const PLAYER_TYPES = ['embed', 'popout', 'autoplay', 'picture-by-picture'];

  /** The channel a live master playlist is for (usher's /channel/hls/<login>.m3u8), or null. */
  function channelOf(url) {
    const m = /\/channel\/hls\/([^/]+)\.m3u8$/i.exec(new URL(url).pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  /** A master playlist's variants and renditions: { url, key, height, bandwidth, audioOnly }. */
  function parseMaster(text, url) {
    const result = [];
    let inf = null;
    for (const raw of lines(text)) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-STREAM-INF:')) inf = parseAttributes(l.slice(l.indexOf(':') + 1));
      else if (l.startsWith('#EXT-X-MEDIA:')) {
        const m = /URI="([^"]*)"/.exec(l);
        if (m) result.push({ url: absolute(m[1], url), key: pathKey(absolute(m[1], url)), height: null, bandwidth: null, audioOnly: false });
      } else if (l[0] !== '#') {
        const a = inf || {};
        const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
        const href = absolute(l, url);
        result.push({
          url: href,
          key: pathKey(href),
          height: res ? Number(res[2]) : null,
          bandwidth: parseNumber(a.BANDWIDTH),
          audioOnly: !res && /audio/i.test((a['IVS-NAME'] || '') + (a['STABLE-VARIANT-ID'] || '') + (a.VIDEO || '')),
        });
        inf = null;
      }
    }
    return result;
  }

  /** The variant of a master playlist closest to `want` ({ height, bandwidth }; the best when unknown), or null. */
  function pickVariant(text, url, want = {}) {
    const all = parseMaster(text, url).filter((v) => v.bandwidth != null && !v.audioOnly);
    if (all.length === 0) return null;
    const score = (v) => [
      want.height != null && v.height != null ? Math.abs(v.height - want.height) : want.height != null ? Infinity : -(v.height ?? 0),
      want.bandwidth != null ? Math.abs(v.bandwidth - want.bandwidth) : -v.bandwidth,
    ];
    all.sort((a, b) => {
      const x = score(a);
      const y = score(b);
      return x[0] - y[0] || x[1] - y[1];
    });
    return all[0].url;
  }

  /** The signed-out PlaybackAccessToken request for a live channel with one player type. */
  function tokenRequest(login, playerType) {
    return {
      url: 'https://gql.twitch.tv/gql',
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        extensions: { persistedQuery: { version: 1, sha256Hash: TOKEN_HASH } },
        variables: { isLive: true, login, isVod: false, vodID: '', playerType, platform: 'site' },
      }),
    };
  }

  /** { signature, value } from a PlaybackAccessToken answer, or null. */
  function readToken(json) {
    const data = json && (Array.isArray(json) ? json[0] : json).data;
    const t = data && (data.streamPlaybackAccessToken || data.videoPlaybackAccessToken);
    return t && t.signature && t.value ? { signature: t.signature, value: t.value } : null;
  }

  /** usher's master playlist for a live channel with a token (Lumen's TwitchResolver.UsherUrl); p: 0–999999. */
  function usherUrl(login, token, p) {
    const q = new URLSearchParams({
      platform: 'web',
      p: String(p),
      allow_source: 'true',
      allow_audio_only: 'true',
      playlist_include_framerate: 'true',
      multigroup_video: 'true',
      supported_codecs: 'h264',
      fast_bread: 'true',
      sig: token.signature,
      token: token.value,
    });
    return `https://usher.ttvnw.net/api/v2/channel/hls/${encodeURIComponent(login)}.m3u8?${q}`;
  }

  return {
    parseMedia, parseAttributes, parseDate, dateRange, rangeContains, isAdRange, isMaster, scan, createSplicer, createSession,
    PLAYER_TYPES, channelOf, parseMaster, pickVariant, tokenRequest, readToken, usherUrl,
  };
}

if (typeof module === 'object' && module && module.exports) module.exports = noAdsFilter;
