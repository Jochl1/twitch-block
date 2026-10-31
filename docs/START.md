# Twitch without ads: a browser extension for Opera GX

A personal Chromium extension (Opera GX first, any Chrome works) that keeps Twitch's ads out of the web player.
It does in the browser what the owner's other two projects already do and what works there:

- **Pi-Cast** (`F:\git\Pi-Cast`, `src/streamlink.js`) plays Twitch through streamlink, which drops the ad segments.
- **Lumen** (`F:\git\lumen`, `src/Lumen.Sources.Twitch/TwitchAds.cs`, `src/Lumen.Core/Playback/Hls.cs`) ports
  streamlink's Twitch rules to C# and rewrites each playlist before the iPhone's player sees it.

This doc is the spec. Keep it current; a disagreement between code and doc is fixed in the doc first.

## 1. How Twitch's ads work, and why removing them works

Twitch stitches ads into the stream on its server (SSAI): during a break the HLS **media playlist** lists ad segments
in place of the stream's. The ads are marked in the playlist text itself, so a filter that sees the playlist can remove
them. What streamlink, Pi-Cast and Lumen get, and what this extension gets:

- No ad is ever shown.
- During the break the picture pauses (the real stream for that stretch isn't in the playlist); it goes on when the
  break ends. We show our own "Ad break" overlay meanwhile.

Blocking ad URLs (uBlock, `declarativeNetRequest`) does nothing: the ads come from the same servers as the stream.
Hiding the purple "commercial break" screen with CSS is cosmetic only.

## 2. What to build (stage 1: remove the ads, like Lumen)

A Manifest V3 extension with **no background script and no permissions**, loaded unpacked:

```
manifest.json
src/filter.js      pure functions: scan a media playlist, splice out the ads (no DOM, no fetch, no timers)
src/hook.js        page world: replaces window.Worker, puts the fetch wrapper into Twitch's player worker
src/overlay.js     page world: the "Ad break" card over the player (gets a message from the worker)
test/*.test.js     node --test on the fixtures (no npm dependencies)
test/fixtures/     playlists copied from Lumen (section 6)
```

### 2.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "Twitch without ads",
  "version": "0.1.0",
  "content_scripts": [{
    "matches": ["https://www.twitch.tv/*", "https://m.twitch.tv/*", "https://player.twitch.tv/*"],
    "js": ["src/filter.js", "src/hook.js", "src/overlay.js"],
    "run_at": "document_start",
    "world": "MAIN",
    "all_frames": true
  }]
}
```

`"world": "MAIN"` runs the scripts in the page itself (not the isolated content-script world), which is the only
place `window.Worker` can be replaced. `document_start` runs them before Twitch's own scripts. `all_frames` covers
embeds (`player.twitch.tv` in other sites' iframes).

### 2.2 Getting at the playlists: the Worker hook (hook.js)

Twitch's web player (Amazon IVS, WebAssembly) fetches the playlists from inside a **Web Worker**, so wrapping the
page's `fetch` doesn't see them. The proven way (the TwitchAdSolutions scripts, `vaft` / `video-swap-new`):

1. Replace `window.Worker` with a subclass before Twitch creates its worker.
2. In the constructor, if the URL is Twitch's player worker (a `blob:` URL whose script loads
   `amazon-ivs-wasmworker…js` from `assets.twitch.tv`), read the worker's script text **synchronously**
   (`XMLHttpRequest` with `async = false` on the blob URL: the blob may be revoked right after `new Worker`).
3. Make a new blob: our worker code first, then Twitch's original text, and call `super(newBlobUrl, options)`.
   Any other worker URL goes through untouched.
4. Our worker code wraps the worker's `self.fetch`: for every response whose URL path ends in `.m3u8`, read the
   text; if it's a **master** playlist (contains `#EXT-X-STREAM-INF`) pass it through; if it's a **media** playlist,
   run `filter.js` on it and answer a new `Response` with the filtered text (same status and headers).
5. The worker code is a string built from the functions themselves (`fn.toString()`), so `filter.js` must stay
   self-contained: no imports, no globals besides its own.
6. The worker tells the page about breaks with `postMessage({ type: 'noads:break', on, seconds })`. The hook adds its
   own `message` listener in the constructor, before Twitch can add its listener or `onmessage`; it stops `noads:*`
   messages there (`stopImmediatePropagation`), so they never reach Twitch's code, and passes them on to `overlay.js`
   as a `CustomEvent` of the same type on `window`.

Never break playback over the filter: any exception in the wrapper answers the original response (Lumen does the same:
`playlist filter failed: unfiltered`).

Twitch changes the worker setup now and then (file names, how the blob is made). When ads come back, this is the first
place to look: log the URLs `new Worker` gets.

### 2.3 Which segments are ads (filter.js, `scan`)

streamlink's rules as of 2026-10-31 (`src/streamlink/plugins/twitch.py`, `_is_segment_ad` and `_is_daterange_ad`),
as in Lumen's `TwitchAds.Scan`:

- An **ad date range** is an `#EXT-X-DATERANGE` with `CLASS="twitch-stitched-ad"`, or an `ID` starting `stitched-ad-`.
- A segment is an **ad** when its `#EXTINF` title contains `Amazon` (e.g. `#EXTINF:2.000,Amazon|…`; normal live
  segments say `live`), **or** its `#EXT-X-PROGRAM-DATE-TIME` lies inside an ad date range.
- "Inside" (streamlink's `is_date_in_daterange`, Lumen's `HlsDateRange.Contains`): `START-DATE <= t < END-DATE`;
  without `END-DATE`, `START-DATE <= t < START-DATE + DURATION` (else `PLANNED-DURATION`); without either, `t >= START-DATE`.
  False when either date is missing.
- **In a break**: the newest segment is an ad (or there are no segments but an ad range).
- The break's length for the overlay: `X-TV-TWITCH-AD-POD-FILLED-DURATION`, else the range's `DURATION`.
  Its id: `X-TV-TWITCH-AD-COMMERCIAL-ID`, else `X-TV-TWITCH-AD-ROLL-TYPE`, else `ID`.

An example from a live playlist during a break:

```
#EXT-X-DATERANGE:ID="stitched-ad-1793447924-30",CLASS="twitch-stitched-ad",START-DATE="2026-10-31T12:00:12.474Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-COMMERCIAL-ID="4711",X-TV-TWITCH-AD-POD-FILLED-DURATION="30"
```

**Prefetch hints** (`#EXT-X-TWITCH-PREFETCH:<url>`, low latency): Lumen and streamlink drop them all. In the browser
the web player uses them for low latency, so: keep them when not in a break, drop them during a break (they'd point at
ad segments), and also while an ad date range reaches past the newest segment (a break about to start: `breakAhead`).
If ads leak at a break's start anyway, drop them always (a few seconds more delay).

### 2.4 Cutting them out (filter.js, `splice`)

Port Lumen's `HlsSplicer` (`src/Lumen.Core/Playback/Hls.cs`, lines 259–370). One splicer per stream, kept in the
worker: each master playlist the worker fetches starts a stream, and its variant (and `#EXT-X-MEDIA`) playlists share
that stream's splicer, so a quality switch sees the same numbers (as in Lumen). A media playlist whose master wasn't
seen gets a stream of its own, keyed by its URL path. The worker keeps the last 8 streams.

- Drop the ad segments (with their tags) and the ad date ranges; keep every other header line and date range.
- **Renumber**: the kept segments get their own consecutive numbers, so `#EXT-X-MEDIA-SEQUENCE` never jumps back or
  leaves a gap; a source number seen once keeps its own number on every reload.
- Write `#EXT-X-DISCONTINUITY` before the first kept segment after a cut, and `#EXT-X-DISCONTINUITY-SEQUENCE:<n>` in
  the header (cuts before the first segment shown), so the decoder resets cleanly.
- A segment older than the newest one numbered (another variant whose window starts earlier) can't be placed: drop it.
- Forget numbers more than 400 behind the oldest segment in the window.
- `#EXT-X-TWITCH-LIVE-SEQUENCE` (Twitch's copy of the media sequence) is rewritten to the new `MEDIA-SEQUENCE`, in
  case the IVS player reads it; without ads it is unchanged.
- Make segment, `#EXT-X-MAP`, `#EXT-X-KEY` and prefetch URIs absolute against the playlist URL.
- An ended playlist (`#EXT-X-ENDLIST`, a VOD) is whole: ads removed, never "in a break". Note: removing a VOD's ads
  shortens its timeline, so Twitch's own seek bar and "resume at" can be a little off; fine for stage 1.

Lumen also **holds** a reload while a break brings nothing new (AVPlayer gives up on a live playlist that stops
growing). Leave that out at first: the IVS player just waits. Add it only if the player errors during long breaks.

Unproven until tested in the browser: how the IVS player takes renumbered playlists and discontinuities. If it
misbehaves, the fallback is the simplest form: keep `MEDIA-SEQUENCE` as Twitch sent it and only delete the ad lines.

### 2.5 The overlay (overlay.js)

On `noads:break` with `on: true`, a card over the `video` element: "Ad break: the stream goes on after it" and the
seconds left (from the break's length) if known. Removed on `on: false` (content came back). Twitch's own ad UI keys
off the same date ranges, which we removed, so it shouldn't show; hide it with CSS if it does.

Log every break to the console like Lumen: `noads: ad break`, then `noads: ad break 30 s, 15 segments dropped`.

## 3. Stage 2 (optional, later): fill the break with a backup stream

Stage 1 pauses during breaks. The one step past what Lumen and Pi-Cast do is to fetch a **second, ad-free copy** of
the stream while the break lasts, as the `vaft` script does. It works sometimes, and stops whenever Twitch closes the
loophole, so it must always fall back to stage 1. In the worker, when a break starts:

1. Ask for a new signed-out access token with a different `playerType` (try `embed`, then `popout`, `autoplay`,
   `picture-by-picture`; which ones come back without ads changes over time):

   ```
   POST https://gql.twitch.tv/gql
   Client-ID: kimne78kx3ncx6brgo4mv6wki5h1ko        (Twitch's public web client id; streamlink, Pi-Cast and Lumen use it)
   Content-Type: application/json

   {"operationName":"PlaybackAccessToken",
    "extensions":{"persistedQuery":{"version":1,"sha256Hash":"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"}},
    "variables":{"isLive":true,"login":"<login>","isVod":false,"vodID":"","playerType":"embed","platform":"site"}}
   ```

   The answer's `data.streamPlaybackAccessToken` has `signature` and `value` (VODs: `isLive:false`, `isVod:true`,
   `vodID`, answer in `videoPlaybackAccessToken`). The persisted-query hash is from Lumen (2026-10-31); if Twitch
   answers `PersistedQueryNotFound`, take the current one from streamlink's `twitch.py`.

2. The master playlist (Lumen's `TwitchResolver.UsherUrl`):

   ```
   https://usher.ttvnw.net/api/v2/channel/hls/<login>.m3u8?platform=web&p=<random 0–999999>&allow_source=true
     &allow_audio_only=true&playlist_include_framerate=true&multigroup_video=true&supported_codecs=h264
     &fast_bread=true&sig=<signature>&token=<value>
   ```

   (VOD: `/vod/v2/<id>.m3u8?…&nauthsig=<signature>&nauth=<value>`.) Pick the variant closest to the one being played,
   fetch its media playlist, run `scan`: if it has no ads, splice **its** segments in (with a discontinuity at each
   switch), until the main playlist is out of the break. Backups are often only 480p.

3. A backup that has ads too: try the next `playerType`; none clean: stage 1 (pause, overlay).

How it is built (2026-10-31):

- `filter.js` stays pure: it builds the requests (`tokenRequest`, `readToken`, `usherUrl`, `pickVariant`) and does
  the splicing; `hook.js`'s worker code does the fetching (4 s timeout per request, so a hanging backup can't stall
  the player for long). The channel comes from the master playlist's URL (`/channel/hls/<login>.m3u8`); the variant
  wanted is the one being played (its height, then bandwidth, from that master).
- Per reload during a break the worker fetches the backup's media playlist and hands it to `session.playlist`. The
  splicer gives each source (`main`, `backup:<path>`) its own segment ids. A segment from another source than the last
  one placed is placed only when its program date is at or after where that one ended (0.5 s slack), and starts a new
  run: answers leave out the earlier run from then on. The backup's segments are placed before the stream's own, and
  the backup is kept until the stream's own content reaches past it, so it switches once each way.
- One token per player type per break; a backup with ads, a failing request or a failing playlist moves on to the next
  type. The worker forgets the backup when the break is over.
- With a backup playing, the overlay is only a small label ("Ad break skipped: backup stream"), not the card.
- VODs: not done (their ads are removed whole by stage 1, so there's no break to fill).

The token request goes signed out (no `Authorization`), as Lumen and Pi-Cast do.

## 4. Opera GX

- Install: `opera://extensions` → Developer mode → "Load unpacked" → the repo folder. Reload there after each change,
  then reload the Twitch tab.
- Opera supports Manifest V3 and `"world": "MAIN"` (Chromium 111+).
- Opera GX's own ad blocker works on the network level and doesn't remove Twitch's stitched ads; if it interferes,
  turn it off for twitch.tv.
- Signed in on Twitch is fine: the player uses the account's own token; the extension only filters what it fetches.
  (With Turbo or a channel sub there are no ads to remove.)

## 5. Steps

| | Step | Done when |
|---|---|---|
| 1 ✔ | `filter.js` `scan` and `splice` with node tests on the fixtures | All fixtures give the expected ad segments, sequence numbers and discontinuities (checks in section 6) |
| 2 | `hook.js`: the Worker hook, logging every `.m3u8` the worker fetches, filter off | Twitch plays normally; the console lists master and media playlist URLs |
| 3 | Filter on; overlay; break logs | A stream through a break: no ad, the card shows, the stream goes on. Save the raw playlist seen during the break as a new fixture (`test/fixtures/browser_ad_*.m3u8`) |
| 4 | VODs and embeds (`player.twitch.tv`) | A VOD with a mid-roll plays without it; an embed on another site is filtered |
| 5 | Stage 2, if wanted | A break shows the backup stream instead of the card, or falls back cleanly |

Status (2026-10-31): steps 1–3 and 5 are written and the node tests pass (`test/filter.test.js`; `test/worker.test.js`
and `test/backup.test.js` run the worker code built as in the browser against a fake `fetch`). In Opera GX: the hook
works (step 2) and a break is cut out with the card showing (step 3). Stage 2 is not yet checked in the browser. The
URL log is on (`noads: worker …`, `noads: master …`, `noads: media …`, each first sighting once, without the query,
which holds the token and the viewer's IP).

Catching a break to test: big channels run them every 15–30 minutes; a fresh start often has a pre-roll.

## 6. Fixtures and checks

Copy from `F:\git\lumen\src\Lumen.Tests\Sources\Twitch\Fixtures\`:

| File | What it is |
|---|---|
| `media_live.m3u8` | A real live media playlist, no ads (prefetch hints included) |
| `media_ad_start.m3u8` | Hand-made from a real playlist: a break starts (stitched-ad range, `Amazon` titles), newest segment an ad |
| `media_ad_end.m3u8` | The same break ending: content after the ads |
| `vod_media.m3u8` | A real VOD media playlist (fMP4, `#EXT-X-MAP`, `#EXT-X-ENDLIST`) |
| `vod_media_ads.m3u8` | That VOD with a mid-roll and a post-roll date range |
| `usher_master.m3u8`, `vod_master.m3u8` | Master playlists (must pass through untouched) |
| `gql_token.json`, `gql_vod_token.json` | Token answers (signature blanked), for stage 2's reader |

The ad playlists are hand-made with streamlink's test tags: no real break was caught from the PC. The first real
break caught in the browser (step 3) becomes the main fixture.

Checks to port from Lumen (`src/Lumen.Tests/Sources/Twitch/TwitchChecks.cs`, `src/Lumen.Tests/Decisions/HlsChecks.cs`):

- no ads in `media_live` → the playlist comes out equivalent (same segments, nothing dropped, not in a break);
- `media_ad_start` → the ad segments found, in a break, length 30 s and id `4711`, ad lines gone from the output;
- `media_ad_start` then `media_ad_end` through one splicer → `MEDIA-SEQUENCE` never goes back, one
  `#EXT-X-DISCONTINUITY` before the first content after the break, not in a break at the end;
- `vod_media_ads` → mid-roll and post-roll segments dropped, `#EXT-X-MAP` absolute, `#EXT-X-ENDLIST` kept, not a break;
- a master playlist → unchanged;
- garbage in → the wrapper answers the original text.

Run: `node --test` (Node 20+). No build step: the files load as they are.

## 7. References

- streamlink `src/streamlink/plugins/twitch.py`: `TwitchHLSStreamWorker`, `_is_segment_ad`, `_is_daterange_ad`, the GQL
  token query and usher parameters. Read the current version before changing the ad rules.
- Lumen: `src/Lumen.Sources.Twitch/TwitchAds.cs` (scan + filter), `TwitchGql.cs` (token request), `TwitchResolver.cs`
  (usher URLs, headers), `src/Lumen.Core/Playback/Hls.cs` (`HlsMediaPlaylist`, `HlsDateRange`, `HlsSplicer`).
- Pi-Cast: `src/streamlink.js` (streamlink's command line), `src/twitchLive.js` (GQL calls).
- TwitchAdSolutions (pixeltris, GitHub): `vaft` and `video-swap-new`, for the current Worker hook and stage 2's
  player types. Read for technique only; write our own code.

## 8. Working rules

- `filter.js` is pure: text in, text out, no DOM, no network, no clocks. Everything that decides lives there and is tested.
- Never break playback: on any error, the original playlist.
- No telemetry, no remote config, no servers.
- Commit freely; bundle changes.
