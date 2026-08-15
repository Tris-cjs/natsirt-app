/* OrBeat Mobile — engine.js
 *
 * The client-side music engine. No server on the phone, no API keys.
 *
 * Sources, in order of preference:
 *   1. RELAYS — your Cloudflare Workers (recommended). YouTube blocks browser
 *      requests with an Origin header, but the relays call YouTube server-side
 *      (no Origin) and return CORS-open JSON. Multiple relays are supported
 *      for redundancy: each call tries the healthy relays in turn, a relay
 *      that starts getting throttled is marked down for a while (circuit
 *      breaker), and load is rotated across the healthy ones.
 *   2. PIPED  — the api.piped.private.coffee public instance (search + chart
 *      work; audio can be bot-blocked on their servers — treated as flaky).
 *   3. innertube direct — only usable in non-browser contexts; fails with a
 *      clear message in browsers.
 *
 * Configure relays from the app: library drawer → "Relay URLs" → paste one or
 * more URLs (comma-separated) → Save. Or bake a default into RELAY_BAKED.
 */
'use strict';

window.MusicEngine = (() => {
  // ── configuration ────────────────────────────────────────────────────────
  // The app is purely ON-DEVICE: the baked-in relay is the loopback server
  // (RelayServer.java, http://127.0.0.1:8787) that resolves and streams audio
  // from the phone's OWN IP — no PC, no Tailscale, no Worker needed. Extra
  // relays can still be added manually at any time (Library → Relay URLs);
  // they just aren't baked in anymore.
  const RELAY_BAKED = 'http://127.0.0.1:8787';

  // Cloudflare Worker relay (relay/worker.js) — the browser/iOS path. The
  // Android APK carries its own loopback relay; a browser or PWA (iPhone,
  // iPad, desktop) has no loopback server, so this Worker is a baked-in
  // relay there. It reliably serves search/chart (server-side calls have no
  // Origin header, so YouTube's browser bot-check never triggers) and its
  // /stream is a best-effort audio source — YouTube bot-checks the player
  // API for SOME datacenter egress IPs, and a blocked stream falls back to
  // Piped automatically via reportStreamFailure. Deploy relay/worker.js
  // (dash.cloudflare.com → Workers & Pages → Create Worker → paste → Save
  // and deploy), then paste the https://<name>.workers.dev URL here and
  // rebuild. A placeholder (contains __YOUR_) is treated as unset.
  const RELAY_WORKER = 'https://orbeat-relay.tristancajes.workers.dev';
  const workerConfigured = () => !RELAY_WORKER.includes('__YOUR_');

  // PC-resident relay exposed over HTTPS via Cloudflare Tunnel
  // (cloudflared). The PC's yt-dlp relay has a residential IP — the only
  // reliably unblocked audio path — and the tunnel makes it reachable as
  // HTTPS so browsers/PWAs (which refuse plain-HTTP mixed content) can use
  // it for search/chart AND audio. TEMP: quick-tunnel hostnames rotate on
  // every cloudflared restart — swap in a named-tunnel URL
  // (https://relay.<your-domain> with a Cloudflare DNS route) for a
  // permanent address.
  const RELAY_TUNNEL = 'https://waters-biggest-dylan-constitution.trycloudflare.com';
  const tunnelConfigured = () => !RELAY_TUNNEL.includes('__YOUR_');


  // Public Piped instances, tried in order and rotated past on failure.
  // These are volunteer-run and flaky (search usually works, audio /streams
  // less so) — they're only the no-relay fallback; a configured relay is
  // always tried first and is the reliable path.
  const PIPEDS = [
    'https://api.piped.private.coffee',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://piped-api.lunar.icu',
    'https://api.piped.yt',
  ];
  const YT = 'https://www.youtube.com/youtubei/v1';
  const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // public key every youtube.com page embeds

  // ── Client rotation (anti-bot) ────────────────────────────────────────────
  // Multiple clients + user-agents to rotate past YouTube's bot-detection.
  const CLIENT_WEB = { clientName: 'WEB', clientVersion: '2.20240701.00.00', hl: 'en', gl: 'US' };
  const CLIENT_WEB_ALT = { clientName: 'WEB', clientVersion: '2.20250601.00.00', hl: 'en', gl: 'US' };
  const CLIENT_ANDROID = { clientName: 'ANDROID', clientVersion: '20.08.35', androidSdkVersion: 34, hl: 'en', gl: 'US' };
  const CLIENT_ANDROID_ALT = { clientName: 'ANDROID', clientVersion: '19.45.36', androidSdkVersion: 33, hl: 'en', gl: 'US' };
  const CLIENT_IOS = { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone14,3', hl: 'en', gl: 'US' };
  const CLIENT_TV = { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en', gl: 'US' };
  const CLIENT_WEB_REMIX = { clientName: 'WEB_REMIX', clientVersion: '1.20240701.01.01', hl: 'en', gl: 'US' };

  // Rotating user-agents to dodge bot-detection headers.
  const UA_ROTATION = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
  ];
  let uaIdx = 0;

  // Identity rotation state, persisted across restarts: if YouTube flags one
  // UA/client combo, the guard rotates it, and a fresh app launch must NOT
  // resume with the flagged identity — it picks up where the rotation left
  // off. playerStart rotates the order PLAYER_CLIENTS is tried in.
  let playerStart = 0;
  function saveGuardState() {
    try { localStorage.setItem('natsirt_guard', JSON.stringify({ ua: uaIdx, pc: playerStart })); } catch { /* ignore */ }
  }

  // An error tagged .blocked means YouTube's bot-check rejected the request
  // (403/401) — distinct from a network hiccup, which must NOT trigger an
  // identity rotation.
  function blockedError(msg) {
    const e = new Error(msg);
    e.blocked = true;
    return e;
  }

  // Player clients for /player endpoint: try in order until one succeeds.
  const PLAYER_CLIENTS = [
    CLIENT_IOS, CLIENT_ANDROID, CLIENT_ANDROID_ALT, CLIENT_TV,
    { clientName: 'ANDROID_VR', clientVersion: '1.65.10', androidSdkVersion: 28, hl: 'en', gl: 'US' },
    { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250601.00.00', hl: 'en', gl: 'US' },
  ];

  // Restore the persisted rotation AFTER PLAYER_CLIENTS exists (hoisting the
  // restore above would throw a TDZ ReferenceError and silently keep defaults).
  try {
    const saved = JSON.parse(localStorage.getItem('natsirt_guard') || '{}');
    if (Number.isFinite(saved.ua)) uaIdx = saved.ua % UA_ROTATION.length;
    if (Number.isFinite(saved.pc)) playerStart = saved.pc % PLAYER_CLIENTS.length;
  } catch { /* first run — defaults */ }

  const TOP100 = [
    'PL4fGSI1pDJn6O1LS0XSdF3RyO0Rq_LDeI',
    'PL4fGSI1pDJn6O8M6IcL2W-QMqWF4Zz10L',
  ];

  /* ------------------------------ relay registry ------------------------------ */

  let RELAYS = [];
  const relayHealth = new Map(); // url -> { fails, downUntil, lastGood }

  // Pure ordering for the baked relay defaults (testable via __test).
  //   • The on-device loopback relay always comes FIRST when present — it's
  //     the Android APK's own server.
  //   • The additional baked relays (tunnel, then Cloudflare Worker) sit
  //     right behind it in the Android app and are the FIRST baked relays in
  //     a browser/PWA, where no loopback server exists.
  //   • User-saved relays (from setRelays / saved list) follow the baked
  //     defaults; duplicates collapse.
  function orderBaked(list, baked) {
    const out = [...new Set(list)];
    if (RELAY_BAKED && !out.includes(RELAY_BAKED)) out.unshift(RELAY_BAKED);
    // Insert the baked relays as one ordered BLOCK right after the loopback
    // relay (splicing one-by-one would reverse their order).
    // Never let a placeholder URL (contains __YOUR_) reach the list — the
    // baked constants gate on it too, but a caller passing one straight in
    // (tests, future code) must not poison RELAYS with a dead URL.
    const insert = (baked || []).filter((b) => b && !b.includes('__YOUR_') && !out.includes(b));
    if (!insert.length) return out;
    const at = out.indexOf(RELAY_BAKED);
    if (at >= 0) out.splice(at + 1, 0, ...insert);
    else out.unshift(...insert);
    return out;
  }

  function loadRelays() {
    const list = [];
    try {
      const raw = localStorage.getItem('natsirt_relays');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const u of parsed) if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) list.push(u.trim().replace(/\/+$/, ''));
        }
      }
    } catch { /* ignore */ }
    try {
      const legacy = localStorage.getItem('natsirt_relay');
      if (legacy && /^https?:\/\//.test(legacy.trim())) list.push(legacy.trim().replace(/\/+$/, ''));
    } catch { /* ignore */ }
    // The tunnel + Worker relays sit right behind the on-device relay in the
    // Android app (loopback first) and are the FIRST baked relays in a
    // browser/PWA, where no loopback server exists. User-saved relays always
    // win; the baked defaults fill the gaps.
    const baked = [];
    if (tunnelConfigured()) baked.push(RELAY_TUNNEL);
    if (workerConfigured()) baked.push(RELAY_WORKER);
    RELAYS = orderBaked(list, baked);
  }
  loadRelays();

  function relayHealthy(url) {
    const h = relayHealth.get(url);
    if (h) return h.downUntil < Date.now();
    // No in-memory record (fresh boot): ask the Brain — its source health is
    // persisted, so a relay that failed last session stays down this session
    // until its cooldown expires instead of being re-tried first.
    return !(window.Brain && Brain.sourceHealthy && !Brain.sourceHealthy(url));
  }
  function markRelayOk(url) {
    relayHealth.set(url, { fails: 0, downUntil: 0, lastGood: Date.now() });
    if (window.Brain && Brain.noteSourceOutcome) Brain.noteSourceOutcome(url, true);
  }
  function markRelayDown(url, opts = {}) {
    const h = relayHealth.get(url) || { fails: 0, downUntil: 0 };
    h.fails++;
    // opts.short is used for per-video stream failures: the relay is usually
    // fine (the VIDEO failed), so cool down briefly — 5s → 10s → 20s — and
    // come back for the next track instead of blacking it out for the full
    // search/chart backoff.
    const base = opts.short ? 5000 : 15000;
    h.downUntil = Date.now() + Math.min(120000, base * Math.pow(2, h.fails - 1)); // 5/15s → 10/30s → … → 2min cap
    relayHealth.set(url, h);
    if (window.Brain && Brain.noteSourceOutcome) Brain.noteSourceOutcome(url, false, { short: opts.short });
  }

  // setRelays(raw) — accept a comma/newline-separated list of worker URLs.
  function setRelays(raw) {
    const urls = String(raw || '')
      .split(/[\n,]+/)
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter((s) => /^https?:\/\//.test(s));
    try { localStorage.setItem('natsirt_relays', JSON.stringify([...new Set(urls)])); } catch { /* ignore */ }
    try { localStorage.removeItem('natsirt_relay'); } catch { /* ignore */ }
    loadRelays();
    return RELAYS.length;
  }

  // Try fn() against every healthy relay, marking health as we go. Throws if
  // every relay failed — the caller falls through to the next source (Piped /
  // innertube).
  let rrIdx = 0;
  async function withRelays(fn) {
    const healthy = RELAYS.filter(relayHealthy);
    if (!healthy.length) throw new Error(SOURCE_ERR);
    // The on-device relay (loopback) is this install's own server — always try
    // it FIRST for search/chart too, so the app is self-contained; the other
    // relays (PC LAN / Tailscale / Worker) are fallbacks. Among the rest, the
    // Brain orders by learned health (most-recently-good first) instead of
    // blind round-robin, so a relay that kept succeeding is tried before a
    // flaky one.
    let order;
    const local = healthy.find((u) => /127\.0\.0\.1|localhost/.test(u));
    if (local) {
      order = [local, ...(window.Brain && Brain.suggestSourceOrder
        ? Brain.suggestSourceOrder(healthy.filter((u) => u !== local))
        : healthy.filter((u) => u !== local))];
    } else {
      const start = (rrIdx = (rrIdx + 1) % healthy.length);
      order = (window.Brain && Brain.suggestSourceOrder
        ? Brain.suggestSourceOrder(healthy)
        : healthy.slice(start).concat(healthy.slice(0, start)));
    }
    let lastErr;
    for (const relay of order) {
      try {
        const v = await fn(relay);
        markRelayOk(relay);
        // The relay answered (HTTP 200 + JSON) but produced zero items — the
        // relay is healthy, so this is a FORMAT signal: YouTube changed the
        // response shape and the parser no longer finds tracks. Not a dead
        // relay, so don't cool it down — just flag the breakage.
        if (Array.isArray(v) && v.length === 0) {
          if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('format', relay);
          lastErr = new Error(SOURCE_ERR);
          continue;
        }
        return v;
      } catch (e) {
        markRelayDown(relay);
        lastErr = e;
      }
    }
    throw lastErr || new Error(SOURCE_ERR);
  }

  // The relay whose stream endpoint the <audio> element should follow.
  // The on-device relay (loopback) is always preferred when healthy — it
  // resolves from this phone's own IP with zero external dependencies. Next
  // come the PC relays (http:// — LAN or Tailscale, backed by yt-dlp). In a
  // browser/PWA there is no loopback or LAN relay, so the Cloudflare Worker
  // (https://) is used as the streaming relay — its /stream can be
  // bot-blocked on flagged datacenter egress IPs, and a blocked stream trips
  // reportStreamFailure → short backoff → the Piped fallback, so it never
  // hard-stalls a track.
  // Order a candidate list best-first for STREAMING: the Brain's learned
  // health (most-recently-good first) beats blind round-robin, so a relay
  // that kept streaming (e.g. the PC tunnel, residential IP) is always tried
  // before a flaky one (e.g. a datacenter Worker whose /stream is
  // intermittently bot-blocked). Falls back to round-robin without the Brain.
  function streamOrder(cands) {
    if (!cands.length) return cands;
    // The tunnel (RELAY_TUNNEL, a residential-IP PC relay behind Cloudflare
    // Tunnel) is the RELIABLE streaming path — YouTube's player API streams
    // from residential IPs but bot-checks most datacenter egress IPs. When a
    // tunnel is baked in and healthy, it ALWAYS leads the streaming order;
    // the Cloudflare Worker (and any other relay) is a backup, never the
    // first pick, because its /stream can 502 mid-session. Learned Brain
    // health then refines the rest of the order.
    if (tunnelConfigured()) {
      const t = cands.filter((u) => u === RELAY_TUNNEL);
      const rest = cands.filter((u) => u !== RELAY_TUNNEL);
      if (t.length) return t.concat(streamOrderRest(rest));
    }
    return streamOrderRest(cands);
  }
  function streamOrderRest(cands) {
    if (window.Brain && Brain.suggestSourceOrder) return Brain.suggestSourceOrder(cands);
    if (!cands.length) return cands;
    const start = (rrIdx = (rrIdx + 1) % cands.length);
    return cands.slice(start).concat(cands.slice(0, start));
  }

  function preferredRelay() {
    const healthy = RELAYS.filter(relayHealthy);
    if (!healthy.length) return RELAYS[0] || '';
    // On-device relay first: self-contained, works with the PC off.
    const local = healthy.find((u) => /127\.0\.0\.1|localhost/.test(u));
    if (local) return local;
    // Then the PC relays (LAN or Tailscale) — residential IPs, so they stream
    // reliably; prefer the one that's been streaming best.
    const lan = healthy.filter((u) => /^http:\/\//.test(u) && !/127\.0\.0\.1|localhost/.test(u));
    if (lan.length) return streamOrder(lan)[0];
    // Browser/PWA: no loopback or LAN relay exists — use any remaining
    // healthy relay (the tunnel / Worker), best-known first.
    const rest = healthy.filter((u) => !/127\.0\.0\.1|localhost/.test(u));
    if (rest.length) return streamOrder(rest)[0];
    return RELAYS[0] || '';
  }

  /* ------------------------------ tiny cache ------------------------------ */

  const memo = new Map();
  function memoGet(key, ttlMs) {
    const hit = memo.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    memo.delete(key);
    return undefined;
  }
  function memoSet(key, value, ttlMs) {
    memo.set(key, { value, exp: Date.now() + ttlMs });
    if (memo.size > 200) {
      const now = Date.now();
      for (const [k, v] of memo) if (v.exp < now) memo.delete(k);
    }
  }

  const pending = new Map();
  function once(key, fn) {
    if (pending.has(key)) return pending.get(key);
    const p = fn().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  /* ------------------------------ persistent stream cache (fast restarts) ------------------------------ */

  // googlevideo URLs stay valid ~6h; relay stream endpoints are stable while
  // the relay is up. Keeping resolved URLs in localStorage means a track you
  // played or preloaded seconds ago — even across an app restart — starts
  // from the cached URL instead of re-resolving through YouTube again.
  const STREAM_TTL = 3 * 60 * 60 * 1000;
  let streamCache = {};
  try {
    const raw = localStorage.getItem('natsirt_stream_cache');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') streamCache = parsed;
    }
  } catch { /* ignore */ }

  // Stream-cache keys are TIER-tagged (videoId#tier): the same video resolves
  // to a different URL per quality tier, and a tier switch must never reuse a
  // cached URL from another tier.
  const streamCacheKey = (videoId) => `${videoId}#${streamTier()}`;
  function streamCacheGet(videoId) {
    const k = streamCacheKey(videoId);
    const hit = streamCache[k];
    if (hit && hit.exp > Date.now()) return hit.out;
    delete streamCache[k];
    return null;
  }
  function streamCacheSet(videoId, out) {
    // Never persist on-device relay URLs: they share the phone's bot-blocked
    // IP and are re-resolved per process anyway — a stale one across restarts
    // is only a liability.
    if (out && out.viaRelay && /127\.0\.0\.1|localhost/.test(out.relay || '')) return;
    streamCache[streamCacheKey(videoId)] = { out, exp: Date.now() + STREAM_TTL };
    try {
      // Prune stale entries while we're here (keeps the key small).
      const now = Date.now();
      for (const k of Object.keys(streamCache)) if (streamCache[k].exp < now) delete streamCache[k];
      localStorage.setItem('natsirt_stream_cache', JSON.stringify(streamCache));
    } catch { /* quota/private-mode — the cache is best-effort */ }
  }
  function streamCacheDel(videoId) {
    const k = streamCacheKey(videoId);
    if (!streamCache[k]) return;
    delete streamCache[k];
    try { localStorage.setItem('natsirt_stream_cache', JSON.stringify(streamCache)); } catch { /* ignore */ }
  }

  /* ------------------------------ generic HTTP ------------------------------ */

  const NET_ERR = 'Can\'t reach the music source — check your internet connection and try again.';
  const SOURCE_ERR = 'The music source is having trouble right now — try again in a moment.';

  // A browser/WebView can't tell *why* a cross-origin request failed (CORS
  // blocks, dead DNS, no network all surface as the same TypeError). Turn that
  // cryptic "Failed to fetch" into a message that says what to do about it.
  function friendlyError(e) {
    if (!e) return new Error(SOURCE_ERR);
    if (e && e.isFriendly) return e;
    const msg = String(e.message || e.name || '');
    if (/failed to fetch|networkerror|network error|load failed|net::|timeout|timed out|abort/i.test(msg)) {
      const err = new Error(`${NET_ERR} If it keeps failing, set up a relay (Library → Relay URLs) for reliable playback.`);
      err.isFriendly = true;
      return err;
    }
    return e instanceof Error ? e : new Error(msg || SOURCE_ERR);
  }

  // fetch() with a timeout — a hung source must not stall the fallback chain.
  async function fetchT(url, opts = {}, timeoutMs = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // Read a response body with its own deadline. fetchT's timeout only covers
  // the headers — a relay that sends headers then stalls the body (common
  // with a blackholed dead-PC relay) would otherwise hang res.json() forever
  // and wedge the whole politeness queue. Returns null on timeout/parse fail.
  async function readBody(res, timeoutMs = 8000) {
    let timer;
    try {
      return await Promise.race([
        res.json(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out reading response')), timeoutMs); }),
      ]);
    } catch { return null; } finally { clearTimeout(timer); }
  }

  /* ------------------------------ politeness pacing ------------------------------ */

  // YouTube's bot-check flags bursty request patterns, and the app legitimately
  // fires many calls at once (home rows + stream pre-warms). Every outbound
  // YouTube-facing request passes through paced(): at most maxConcurrent() in
  // flight, with a new call starting no sooner than gap() after the previous
  // one started — so a cold open trickles instead of bursting. gap() and
  // maxConcurrent() come from the Brain: a fixed polite minimum when clean, a
  // wider gap after YouTube pushes back (blocks/failures) and during stress
  // mode. Cached results never reach here (they return before the network
  // call), so repeat visits stay instant; only the first cold load pays the
  // spread.
  const PACE_MS = 300; // fallback if Brain is unavailable
  const PACE_MAX_CONCURRENT = 2;
  const brainGap = () => (window.Brain && Brain.gap ? Brain.gap() : PACE_MS);
  const brainMaxC = () => (window.Brain && Brain.maxConcurrent ? Brain.maxConcurrent() : PACE_MAX_CONCURRENT);
  let paceLastStart = 0;
  let paceActive = 0;
  async function paced(fn) {
    for (;;) {
      const wait = Math.max(0, brainGap() - (Date.now() - paceLastStart));
      if (wait === 0 && paceActive < brainMaxC()) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    paceLastStart = Date.now();
    paceActive++;
    try {
      return await fn();
    } finally {
      paceActive--;
    }
  }

  // A REMOTE relay (Cloudflare Tunnel to the PC / Cloudflare Worker / LAN
  // box) resolves against YouTube from ITS OWN IP — not this phone's — so its
  // calls must NOT ride the politeness queue: the queue exists to keep THIS
  // device's IP under YouTube's radar (direct innertube/piped + the on-device
  // loopback relay all share this phone's IP). Gating remote-relay calls on
  // the same 900ms gap would serialize a cold open's ~15 home requests and
  // make the first search wait behind the whole queue (measured: 26s). Only
  // the loopback relay (this phone's own server, same IP) stays paced.
  function remoteRelayOf(url) {
    return RELAYS.find((u) => url.startsWith(u) && !/127\.0\.0\.1|localhost/.test(u));
  }

  async function getJson(url, { retries = 1, timeout = 12000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Remote-relay calls skip the politeness queue (see remoteRelayOf);
        // everything else (direct innertube, piped, the on-device loopback
        // relay) rides it. Each outcome feeds the Brain so pacing adapts to
        // what YouTube is actually doing.
        const res = await (remoteRelayOf(url)
          ? fetchT(url, { credentials: 'omit' }, timeout)
          : paced(() => fetchT(url, { credentials: 'omit' }, timeout)));
        if (res.status === 403 || res.status === 401) {
          if (window.Brain) {
            Brain.recordOutcome('block');
            if (Brain.noteBreakage) Brain.noteBreakage('block', url);
          }
          throw blockedError('The source blocked this request — try again in a moment.');
        }
        if (!res.ok) {
          if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('error', url);
          throw new Error(`Source responded with HTTP ${res.status}`);
        }
        const data = await readBody(res);
        if (!data) throw new Error('Unreadable response from the source.');
        if (data.error) {
          if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('error', url);
          throw new Error(data.error);
        }
        if (window.Brain) Brain.recordOutcome('ok');
        return data;
      } catch (e) {
        lastErr = friendlyError(e);
        if (window.Brain && !e.blocked) {
          Brain.recordOutcome('fail');
          // A fetch-level failure (DNS/TLS/drop) is a NETWORK miss for that
          // source — not a block, not a format change.
          if (Brain.noteBreakage && !e.blocked && !e.isFriendly) Brain.noteBreakage('network', url);
        }
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /* ------------------------------ parsing ------------------------------ */

  function walk(obj, fn) {
    if (!obj || typeof obj !== 'object') return;
    fn(obj);
    for (const k of Object.keys(obj)) walk(obj[k], fn);
  }

  const runsText = (t) => (t && t.runs ? t.runs.map((r) => r.text).join('') : (t && t.simpleText) || '');

  function parseDuration(str) {
    const s = String(str || '').trim();
    if (!s) return 0;
    const parts = s.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  const thumb = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  // Plain YouTube playlist rows carry "Channel • 2.3M views" (or
  // "Shakira and 2 more") as their byline — strip that junk so the artist
  // is the real name, never a channel name or view count.
  function cleanArtist(a) {
    return String(a || '')
      .replace(/\s*•\s*[\d.,]+[KMB]?\s*views?$/i, '')  // "Channel • 2.3M views" → "Channel"
      .replace(/\s+and\s+\d+\s+more$/i, '')            // "Shakira and 2 more" → "Shakira"
      .trim();
  }

  function toTrack(videoId, name, artist, duration) {
    return {
      id: `yt:${videoId}`,
      name: String(name || 'Untitled').trim(),
      artist: cleanArtist(artist) || 'Unknown artist',
      album: '',
      duration: Number(duration) || 0,
      cover: thumb(videoId),
      videoId,
      source: 'youtube',
      license: '',
    };
  }

  // ── YouTube Music song rows ────────────────────────────────────────────────
  // musicResponsiveListItemRenderer is how YouTube Music renders search results:
  // the videoId lives in playlistItemData.videoId (NOT on the renderer), the
  // artist and duration share flexColumns[1] ("Song" • "artist" or "Song" •
  // "3:22" as separate runs), and the real album art is in the thumbnail.
  // `fallbackArtist` covers rows inside an artist "top result" card, which only
  // show the duration and inherit the card's title as the artist.
  const flexCol = (flex, i) => flex[i] && flex[i].musicResponsiveListItemFlexColumnRenderer;
  const flexRuns = (flex, i) => {
    const col = flexCol(flex, i);
    const text = col && col.text;
    return (text && text.runs) || null;
  };
  const flexText2 = (flex, i) => {
    const runs = flexRuns(flex, i);
    if (runs) return runs.map((r) => r.text || '').join('');
    const col = flexCol(flex, i);
    return (col && col.text && col.text.simpleText) || '';
  };

  // Parse one YouTube Music row. Returns a track or null (non-song rows —
  // albums/artists have no playlistItemData).
  function parseMusicRow(m, fallbackArtist) {
    const pid = m.playlistItemData;
    const id = (pid && pid.videoId) || m.videoId;
    if (!id) return null;
    const flex = m.flexColumns || [];
    const name = flexText2(flex, 0);
    if (!name) return null;
    // YouTube Music prefixes each row's subtitle with its result type: "Song"
    // for real songs, "Video"/"Episode"/"Playlist"/"Artist" for the non-song
    // rows the Songs filter still surfaces (trailers, podcasts, compilations).
    // Drop everything that isn't a song.
    const runs = flexRuns(flex, 1) || [];
    const firstToken = runs.length ? String(runs[0].text || '').trim() : '';
    if (firstToken && /^(video|episode|playlist|artist|podcast|mix|album)$/i.test(firstToken)) return null;
    let artist = '';
    let duration = 0;
    for (const run of runs) {
      const t = String(run.text || '').trim();
      if (!t || t === '•' || t === 'Song' || t === 'Album') continue;
      if (/^\d+:\d{2}(:\d{2})?$/.test(t)) { duration = parseDuration(t); continue; }
      artist += (artist ? ' ' : '') + t;
    }
    if (!artist) artist = fallbackArtist || '';
    const track = toTrack(id, name, artist || 'Unknown artist', duration);
    // Real album art (yt3.googleusercontent.com) when the thumbnail isn't the
    // circle-cropped artist avatar.
    try {
      const th = m.thumbnail && m.thumbnail.musicThumbnailRenderer && m.thumbnail.musicThumbnailRenderer.thumbnail;
      const crop = m.thumbnail && m.thumbnail.musicThumbnailRenderer && m.thumbnail.musicThumbnailRenderer.thumbnailCrop;
      if (th && th.thumbnails && th.thumbnails.length && crop !== 'MUSIC_THUMBNAIL_CROP_CIRCLE') {
        track.cover = th.thumbnails[th.thumbnails.length - 1].url;
      }
    } catch { /* keep the default video thumbnail */ }
    return track;
  }

  // Walk a search/browse response collecting video rows AND YouTube Music song
  // rows. Tracks the enclosing artist card (musicCardShelfRenderer) so its rows
  // get the artist name even though they only show a duration.
  function collectMusicTracks(data) {
    const seen = new Map();
    const addTrack = (t) => { if (t && !seen.has(t.id)) seen.set(t.id, t); };
    const walkCtx = (obj, cardArtist) => {
      if (!obj || typeof obj !== 'object') return;
      // Artist "top result" card — its title is the artist for the songs inside.
      if (obj.musicCardShelfRenderer) {
        const card = obj.musicCardShelfRenderer;
        const title = (card.title && (card.title.runs ? card.title.runs.map((r) => r.text).join('') : card.title.simpleText)) || '';
        walkCtx(card.contents, title || cardArtist);
        return;
      }
      const v = obj.videoRenderer || obj.gridVideoRenderer;
      if (v && v.videoId) {
        addTrack(toTrack(String(v.videoId), runsText(v.title), runsText(v.ownerText) || runsText(v.shortBylineText), parseDuration(runsText(v.lengthText))));
        return;
      }
      if (obj.playlistVideoRenderer) {
        const p = obj.playlistVideoRenderer;
        if (p.videoId) addTrack(toTrack(String(p.videoId), runsText(p.title), runsText(p.shortBylineText), parseDuration(runsText(p.lengthText))));
        return;
      }
      if (obj.musicResponsiveListItemRenderer) {
        addTrack(parseMusicRow(obj.musicResponsiveListItemRenderer, cardArtist));
        return;
      }
      for (const k of Object.keys(obj)) walkCtx(obj[k], cardArtist);
    };
    walkCtx(data.contents || data, '');
    return [...seen.values()].filter((t) => t.name && t.name !== 'Untitled');
  }

  function parseSearch(data) {
    return collectMusicTracks(data);
  }

  function parsePlaylist(data) {
    return collectMusicTracks(data);
  }

  // Piped search/playlist items: { url: "/watch?v=...", title, uploaderName, duration, type }
  function parsePipedItems(data) {
    const items = (data && data.items) || (data && data.relatedStreams) || [];
    const seen = new Map();
    for (const it of items) {
      if (!it || it.type !== 'stream') continue;
      const m = /(?:watch\?v=|shorts\/)([A-Za-z0-9_-]{5,})/.exec(it.url || '');
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.set(id, toTrack(id, it.title, it.uploaderName, Number(it.duration) || 0));
    }
    return [...seen.values()];
  }

  // Streaming quality tiers — the same itag sets the relays use. Every tier
  // is audio-only (never muxed video+audio); they trade audio size against
  // resilience: 141 = 256kbps AAC, 251 = 160kbps opus, 140 = 128kbps AAC
  // (great quality at HALF the size of 141), 139/249 = ~48kbps opus
  // (smallest — plays smoothly on the weakest connections).
  // AAC/MP4 (141/140/139) is preferred over Opus/WebM (251/250/249) at every
  // tier: iOS Safari's MSE and <audio> cannot decode WebM/Opus, so a webm
  // pick fails iPhone playback. Opus stays as a last-resort fallback.
  const ITAG_HIGH = [141, 140, 251, 250, 249, 599, 600, 139];
  const ITAG_STANDARD = [140, 141, 251, 250, 249, 599, 600, 139];
  const ITAG_LOW = [139, 249, 250, 140, 251, 141, 599, 600];
  const QUALITY_ITAGS = { high: ITAG_HIGH, standard: ITAG_STANDARD, low: ITAG_LOW };
  const QUALITY_KEY = 'natsirt_stream_quality';
  const QUALITY_OPTIONS = ['auto', 'high', 'standard', 'low'];
  const TIER_ORDER = ['high', 'standard', 'low'];

  // 'auto' (default) adapts to the LIVE connection: the tier starts from the
  // connection's effectiveType and steps down (or back up) from the real
  // download speeds measured during playback, so a weak network gets a
  // smaller stream it can actually keep up with. Manual tiers pin the format
  // choice. Everything quality-dependent — the relay URL (&q=), the stream
  // caches and the MSE buffer windows — keys off streamTier(), so changing
  // the setting takes effect on the next track.
  // TIER_ORDER index is high=0 → standard=1 → low=2: stepping DOWN means a
  // HIGHER index (smaller stream), stepping up a lower one.
  let autoIdx = -1;          // resolved tier index in auto mode; -1 = follow the base
  let speedEstimate = 0;     // bytes/sec, EWMA of MSE chunk downloads (auto mode)
  let speedFirstAt = 0;      // when measurement began (auto tier waits for samples)
  let lastTierStep = 0;      // last time the auto tier stepped, for hysteresis

  function qualitySetting() {
    try {
      const v = localStorage.getItem(QUALITY_KEY);
      return QUALITY_OPTIONS.includes(v) ? v : 'auto';
    } catch { return 'auto'; }
  }

  function setStreamQuality(q) {
    const v = QUALITY_OPTIONS.includes(q) ? q : 'auto';
    try { localStorage.setItem(QUALITY_KEY, v); } catch { /* ignore */ }
    autoIdx = -1; // back to following the connection's base tier
    speedEstimate = 0;
    speedFirstAt = 0;
    lastTierStep = 0;
    truncCount = 0;
    truncWindowStart = 0;
    truncCushion = 0;
    dropStreamCaches(); // the old tier's cached URLs are stale now
    return v;
  }

  // The connection's base tier from effectiveType (WebViews expose it when
  // available; unknown → high, the app's previous default).
  function connectionTier() {
    try {
      const c = navigator.connection;
      const et = c && c.effectiveType;
      if (et === 'slow-2g' || et === '2g') return 'low';
      if (et === '3g') return 'standard';
    } catch { /* ignore */ }
    return 'high';
  }

  // The effective tier used by the player and relays right now.
  function streamTier() {
    const q = qualitySetting();
    if (q !== 'auto') return q;
    if (autoIdx >= 0) return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, autoIdx))];
    const base = TIER_ORDER.indexOf(connectionTier());
    return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, base))];
  }

  // Where auto mode is right now: the resolved index, or the base if it has
  // never stepped (autoIdx === -1). Stepping DOWN (slower) increments it,
  // stepping UP (faster) decrements it.
  function autoCurrentIdx() {
    return autoIdx >= 0 ? autoIdx : TIER_ORDER.indexOf(connectionTier());
  }

  // Sustained download speed the current tier needs to keep the buffer ahead
  // (~2x the format's bitrate, so a network dip can't drain it mid-chunk).
  function tierMinSpeed() {
    const bps = { high: 262000, standard: 130000, low: 50000 }[streamTier()];
    return bps * 1.8;
  }

  // Feed real chunk-download speeds from the MSE player. In auto mode this
  // drives the tier: consistently too slow → step DOWN to a smaller stream
  // (never tears down the playing track — the next resolution picks it up),
  // plenty of headroom for a long while → step back up. The EWMA smooths
  // single-chunk blips; both steps need sustained evidence.
  function noteChunkSpeed(bps) {
    if (qualitySetting() !== 'auto' || !(bps > 0)) return;
    const now = Date.now();
    speedEstimate = speedEstimate === 0 ? bps : speedEstimate * 0.7 + bps * 0.3;
    if (!speedFirstAt) speedFirstAt = now;
    // Ignore the first ~8s of samples — tiers must not flip on a cold start.
    if (now - speedFirstAt < 8000) return;
    const need = tierMinSpeed();
    const cur = autoCurrentIdx();
    // The FIRST step-down may fire right after the warm-up (react fast to a
    // genuinely weak connection — the larger buffer absorbs it); later steps
    // need 20s of hysteresis so the tier never oscillates. Step-up always
    // requires 90s+ of sustained headroom.
    if (cur < TIER_ORDER.length - 1 && speedEstimate < need * 0.7 && (lastTierStep === 0 || now - lastTierStep > 20000)) {
      autoIdx = cur + 1; // step DOWN to a smaller stream
      lastTierStep = now;
      speedEstimate = 0; // re-measure at the new tier
      dropStreamCaches();
    } else if (cur > 0 && speedEstimate > need * 2.5 && now - lastTierStep > 90000) {
      autoIdx = cur - 1; // plenty of headroom — step back UP
      lastTierStep = now;
      speedEstimate = 0;
      dropStreamCaches();
    }
  }

  // --- truncation-driven stepping ------------------------------------
  // A SHORT chunk (the CDN/relay cut mid-body — detected by the MSE player
  // when a chunk body is smaller than the requested range) is a stronger
  // signal than slow speed: the connection isn't keeping the current stream
  // alive. Repeated cuts step the tier DOWN so the next session gets a
  // smaller stream AND the more forgiving MSE buffer window (larger chunks,
  // earlier refill, deeper lookahead). Works in every quality mode:
  //   • auto — steps the resolved quality tier down (like slow speed).
  //   • manual — the user's pinned quality is respected, but the buffer
  //     window still widens via the truncation cushion (mseCfg applies it).
  let truncCount = 0;        // short chunks inside the current window
  let truncWindowStart = 0;  // when the current window began
  let truncCushion = 0;      // 0..2 — extra forgiving steps for the buffer

  function noteChunkTruncation() {
    const now = Date.now();
    if (!truncWindowStart) truncWindowStart = now;
    // Rolling 20s window: 2 cuts inside it is a pattern, not a blip.
    if (now - truncWindowStart > 20000) { truncCount = 0; truncWindowStart = now; }
    truncCount++;
    if (truncCount < 2) return;
    truncCount = 0;
    truncWindowStart = now;
    // Auto mode: step the quality tier down (same hysteresis as speed).
    if (qualitySetting() === 'auto') {
      const cur = autoCurrentIdx();
      if (cur < TIER_ORDER.length - 1 && (lastTierStep === 0 || now - lastTierStep > 20000)) {
        autoIdx = cur + 1; // step DOWN to a smaller stream
        lastTierStep = now;
        speedEstimate = 0;
        dropStreamCaches();
      }
    }
    // Always widen the buffer window for the next MSE session (the player
    // calls mseCfg() on every fresh session, so the cushion takes effect on
    // the next track — and the current session bumps its own config in
    // mseFetchChunk, so this track heals too).
    truncCushion = Math.min(2, truncCushion + 1);
  }

  function truncationCushion() { return truncCushion; }

  // Drop every cached/pending stream resolution so the next streamUrl uses
  // the current tier (cache keys are tier-tagged). Pending once() promises
  // are swept too — an in-flight resolution from the OLD tier must never be
  // handed to a new-tier caller.
  function dropStreamCaches() {
    for (const k of memo.keys()) if (k.startsWith('p:')) memo.delete(k);
    for (const k of pending.keys()) if (k.startsWith('p:')) pending.delete(k);
    streamCache = {};
    try { localStorage.setItem('natsirt_stream_cache', JSON.stringify(streamCache)); } catch { /* ignore */ }
  }

  function pickAudioFormat(adaptiveFormats) {
    const audio = (adaptiveFormats || []).filter((f) => f.url && f.mimeType && f.mimeType.startsWith('audio/'));
    if (!audio.length) return null;
    const pref = QUALITY_ITAGS[streamTier()] || ITAG_HIGH;
    for (const itag of pref) {
      const hit = audio.find((f) => Number(f.itag) === itag);
      if (hit) return hit;
    }
    // No preferred itag offered — take the HIGHEST-bitrate stream.
    return audio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  /* ------------------------------ source: relays ------------------------------ */

  // The sp param asks YouTube for the Songs filter (best-effort: some relays/
  // IPs honor it, others ignore it — the client-side musicOnly() filter is the
  // guarantee).
  const relaySearch = (relay, q, n) => getJson(`${relay}/search?q=${encodeURIComponent(q)}&limit=${n}&sp=EgWKAQI`).then((d) => d.tracks);
  const relayChart = (relay, n) => getJson(`${relay}/chart?limit=${n}`).then((d) => d.tracks);

  /* ------------------------------ source: piped ------------------------------ */

  // Try the same request against each public Piped instance; the first one
  // that returns a usable answer wins (they go up and down constantly). The
  // Brain remembers per-instance health across restarts and orders the pool
  // most-recently-good first, so a flaky volunteer instance doesn't get
  // re-tried ahead of one that keeps succeeding.
  async function withPipeds(fn) {
    let lastErr;
    const order = (window.Brain && Brain.suggestSourceOrder)
      ? Brain.suggestSourceOrder(PIPEDS)
      : PIPEDS;
    for (const inst of order) {
      try {
        const v = await fn(inst);
        if (window.Brain && Brain.noteSourceOutcome) Brain.noteSourceOutcome(inst, true);
        if (v && (typeof v !== 'object' || v.length === undefined || v.length > 0)) return v;
        // Got a usable HTTP/JSON response but ZERO items — the instance is
        // alive but returned nothing parseable. That's a format-change signal
        // (YouTube altered the response shape), not a dead instance.
        if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('format', inst);
        lastErr = new Error(SOURCE_ERR);
      } catch (e) {
        if (window.Brain && Brain.noteSourceOutcome) Brain.noteSourceOutcome(inst, false);
        lastErr = e;
      }
    }
    throw lastErr || new Error(SOURCE_ERR);
  }

  const pipedSearch = (q, n) => withPipeds((inst) =>
    getJson(`${inst}/search?q=${encodeURIComponent(q)}&filter=music_songs`, { timeout: 9000, retries: 0 })
      .then(parsePipedItems).then((t) => t.slice(0, n)));
  const pipedChart = (n) => withPipeds((inst) =>
    getJson(`${inst}/playlists/${TOP100[0]}`, { timeout: 9000, retries: 0 })
      .then(parsePipedItems).then((t) => t.slice(0, n)));
  async function pipedStreamUrl(videoId) {
    return withPipeds(async (inst) => {
      const data = await getJson(`${inst}/streams/${encodeURIComponent(videoId)}`, { timeout: 9000, retries: 0 });
      const audio = (data.audioStreams || []).filter((f) => f.url);
      if (!audio.length) throw new Error(SOURCE_ERR);
      // Fastest stream first (lowest bitrate) — same fast-load policy as the
      // innertube path above.
      const lowest = audio.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];
      return lowest.url;
    });
  }

  /* ------------------------------ source: innertube (non-browser) ------------------------------ */

  // Random visitorData: YouTube's innertube accepts an opaque visitor id in
  // the client context. Sending a fresh one per request makes every call look
  // like a brand-new anonymous visitor, so no session fingerprint ever builds
  // up to trip the bot checker. (Base64url of 18 random bytes, like the real
  // ones YouTube mints.)
  function randomVisitorData() {
    try {
      const bytes = new Uint8Array(18);
      if (crypto && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch { return ''; }
  }
  // A spread of plausible timezones — a random one per request keeps the
  // client context from ever matching a single location's pattern.
  const UTC_OFFSETS = [-480, -420, -300, -240, -180, 0, 60, 120, 330, 480, 540];

  async function innertubePost(endpoint, body, client) {
    let res;
    // Rotate the user-agent on each request to confuse bot-detection.
    const userAgent = UA_ROTATION[uaIdx = (uaIdx + 1) % UA_ROTATION.length];
    // Never mutate the shared CLIENT_* constants — build a per-request copy
    // that presents as a fresh, anonymous visitor (new visitorData + TZ).
    const reqClient = {
      ...client,
      visitorData: randomVisitorData(),
      utcOffsetMinutes: UTC_OFFSETS[Math.floor(Math.random() * UTC_OFFSETS.length)],
      clientScreen: 'WATCH',
    };
    try {
      // Route through the politeness queue: every YouTube-facing call waits
      // its turn (adaptive Brain gap, 2 max in flight) so a cold open
      // trickles instead of bursting 15-20 requests in the first seconds.
      res = await paced(() => fetchT(`${endpoint}?key=${KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Accept': 'application/json',
          'User-Agent': userAgent,
          'Origin': 'https://music.youtube.com',
          'X-YouTube-Client-Name': String(reqClient.clientName || ''),
          'X-YouTube-Client-Version': String(reqClient.clientVersion || ''),
        },
        body: JSON.stringify({
          context: {
            client: reqClient,
            thirdParty: { embedUrl: 'https://music.youtube.com' },
          },
          ...body,
        }),
        credentials: 'omit',
      }, 12000));
    } catch (e) {
      // Network-level failure (DNS, TLS, connection dropped) — NOT a bot
      // block. Feeds the Brain as a plain failure, never as a block.
      if (window.Brain) {
        Brain.recordOutcome('fail');
        if (Brain.noteSourceOutcome) Brain.noteSourceOutcome('innertube', false);
      }
      throw new Error('YouTube blocked the direct connection from this device (bot check) — or your connection dropped. Set up the free Cloudflare relay (Library → Relay URLs) for reliable playback.');
    }
    if (res.status === 403 || res.status === 401) {
      // A real bot-check rejection: widen pacing, flag this identity.
      if (window.Brain) {
        Brain.recordOutcome('block'); Brain.recordIdentity(uaIdx, false);
        if (Brain.noteSourceOutcome) Brain.noteSourceOutcome('innertube', false);
        if (Brain.noteBreakage) Brain.noteBreakage('block', 'innertube');
      }
      throw blockedError('YouTube blocked this request (bot check).');
    }
    if (!res.ok) {
      if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('error', 'innertube');
      throw new Error(`YouTube responded with HTTP ${res.status}`);
    }
    const data = await readBody(res);
    if (!data) throw new Error('Unreadable response from YouTube.');
    // Success — reward the identity that just worked and record the outcome.
    if (window.Brain) {
      Brain.recordOutcome('ok'); Brain.recordIdentity(uaIdx, true);
      if (Brain.noteSourceOutcome) Brain.noteSourceOutcome('innertube', true);
    }
    return data;
  }

  // YouTube Music's own client (WEB_REMIX) with the Songs filter — exactly how
  // music.youtube.com searches. The plain WEB client ignores the Songs filter
  // and returns every video on YouTube (trailers, podcasts, gameplay…).
  const innertubeSearch = async (q, n) => {
    const tracks = parseSearch(await innertubePost(`${YT}/search`, { query: q, params: 'EgWKAQI' }, CLIENT_WEB_REMIX)).slice(0, n);
    // Direct innertube answered but the parser found nothing — YouTube changed
    // the response shape (format breakage), the #1 thing a maintainer must
    // know about. Never a block, so no rotation — just telemetry.
    if (!tracks.length && window.Brain && Brain.noteBreakage) Brain.noteBreakage('format', 'innertube');
    return tracks;
  };
  const innertubeChart = async (n) => {
    let lastErr;
    for (const listId of TOP100) {
      try {
        const tracks = parsePlaylist(await innertubePost(`${YT}/browse`, { browseId: `VL${listId}` }, CLIENT_ANDROID)).slice(0, n);
        if (tracks.length >= 5) return tracks;
        if (window.Brain && Brain.noteBreakage) Brain.noteBreakage('format', 'innertube');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error(SOURCE_ERR);
  };
  async function innertubeStreamUrl(videoId) {
    // Try every PLAYER_CLIENTS in order with rotating UAs to bypass bot-checks.
    // The order starts at playerStart (advanced by the guard when one client
    // gets flagged) so the flagged client isn't the first tried every time.
    let lastErr;
    const rotated = PLAYER_CLIENTS.slice(playerStart).concat(PLAYER_CLIENTS.slice(0, playerStart));
    for (const client of rotated) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await innertubePost(`${YT}/player`, { videoId, contentCheckOk: true, racyCheckOk: true }, client);
          const status = data.playabilityStatus && data.playabilityStatus.status;
          if (status && status !== 'OK') {
            const reason = data.playabilityStatus.reason || 'This track is not playable.';
            if (/LOGIN_REQUIRED|age_check|age_gate/i.test(reason)) continue; // try next client
            throw new Error(reason);
          }
          const fmt = pickAudioFormat(data.streamingData && data.streamingData.adaptiveFormats);
          if (fmt) return fmt.url;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr || new Error('No playable audio found for this track.');
  }

  /* ------------------------------ periodic guard (anti-bot canary) ------------------------------ */

  // Every GUARD_MS the engine fires one cheap, paced innertube probe. Its only
  // job is to find out whether YouTube is STILL serving this IP *before* a
  // real track or row fails — a block caught early lets the engine rotate
  // identities so the user's next tap just works instead of erroring. A
  // 403/401 (an error tagged .blocked) advances the UA + player-client
  // rotation, persists it (so a restart doesn't resume the flagged identity),
  // and drops stale results so real requests re-resolve fresh. Network
  // hiccups never trigger rotation. One probe every 5 hours is invisible
  // traffic-wise (roughly 5 requests a day) and rides the same politeness
  // queue as everything else.
  const GUARD_MS = 5 * 60 * 60 * 1000; // 5 hours
  let guardTimer = null;
  let guardFailures = 0;

  // Rotate to a fresh identity after a confirmed block: flag the current UA
  // as failed, then jump to the identity with the fewest recent failures
  // (Brain memory — never back to the flagged one), start the player-client
  // order one client further along, enter Brain stress mode (wider pacing),
  // persist, and drop YouTube-dependent caches.
  function rotateIdentity() {
    if (window.Brain) {
      Brain.recordIdentity(uaIdx, false);
      uaIdx = Brain.suggestIdentityStart(UA_ROTATION.length, uaIdx);
      Brain.noteBlock();
    } else {
      uaIdx = (uaIdx + 3) % UA_ROTATION.length;
    }
    playerStart = (playerStart + 1) % PLAYER_CLIENTS.length;
    saveGuardState();
    for (const k of memo.keys()) {
      if (/^(s:|c:|trending|hot:|ph|alb:|pls:)/.test(k)) memo.delete(k);
    }
  }

  // Round-robin start so consecutive guard cycles don't always judge the same
  // relay first — a flaky relay shouldn't be the only one probed every time.
  let guardProbeIdx = 0;

  async function guardCheck() {
    // Probe the paths the app ACTUALLY uses: one minimal search through each
    // healthy relay, which resolves against YouTube from that relay's IP.
    // (Direct innertube is CORS-blocked from the WebView — "Failed to fetch"
    // — so it can never serve as a health signal here.)
    const candidates = RELAYS.filter(relayHealthy);
    if (!candidates.length) { guardFailures++; return false; }
    // Rotate the starting point each cycle, then probe every healthy relay.
    // The probes are independent, so run them in PARALLEL with a short 6s
    // timeout and no retries: a health check must complete in seconds, not
    // grind through each dead relay's 12s×2 timeout in series (the canary
    // used to take minutes when the PC relays were down).
    guardProbeIdx = guardProbeIdx % candidates.length;
    const order = candidates.slice(guardProbeIdx).concat(candidates.slice(0, guardProbeIdx));
    guardProbeIdx++;
    const results = await Promise.allSettled(order.map((relay) =>
      paced(() => getJson(`${relay}/search?q=music&limit=1&sp=EgWKAQI`, { retries: 0, timeout: 6000 }))
    ));
    const anyOk = results.some((r) => r.status === 'fulfilled' && r.value && Array.isArray(r.value.tracks));
    if (anyOk) {
      // ONE healthy relay means YouTube is still serving this app — a
      // single relay's failure is a relay problem (PC off, worker down),
      // not a YouTube-wide block, so it must NOT trigger a rotation.
      results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.tracks)) markRelayOk(order[i]); });
      guardFailures = 0;
      return true;
    }
    // Every healthy relay failed the probe — that IS a YouTube-wide block
    // (or the whole pool is genuinely down). Rotate identity, drop stale
    // results, and re-ping the pool so the next real request lands on a
    // working source. guardFailures tracks consecutive misses.
    guardFailures++;
    rotateIdentity();
    checkRelays().catch(() => {});
    return false;
  }

  // First probe a couple of minutes after launch (after the startup rows
  // settle, so it never adds to the cold-open burst), then every 5 hours.
  function startGuard() {
    if (guardTimer) return;
    setTimeout(() => { guardCheck(); }, 2 * 60 * 1000);
    guardTimer = setInterval(guardCheck, GUARD_MS);
  }
  startGuard();

  /* ------------------------------ public API ------------------------------ */

  // search(query, limit, opts) → track[] (music-only: non-music results are
  // stripped). opts.noVersions additionally drops karaoke/cover/instrumental
  // versions — used for recommendations, never for explicit user searches.
  function search(query, limit, opts = {}) {
    const q = String(query || '').trim().slice(0, 200);
    const n = Math.min(50, Math.max(1, Number(limit) || 24));
    if (!q) return Promise.resolve([]);
    return once(`s:${q}:${n}`, async () => {
      const cached = memoGet(`s:${q}:${n}`, 15 * 60 * 1000);
      if (cached) return opts.noVersions ? stripVersions(cached) : cached;
      const attempts = [];
      if (RELAYS.length) attempts.push(() => withRelays((relay) => relaySearch(relay, q, n)));
      attempts.push(() => pipedSearch(q, n));
      attempts.push(() => innertubeSearch(q, n));
      let tracks = musicOnly(await firstSuccess(attempts));
      if (opts.noVersions) tracks = stripVersions(tracks);
      if (tracks.length) memoSet(`s:${q}:${n}`, tracks, 15 * 60 * 1000);
      return tracks;
    });
  }

  // chart(limit) → track[] (YouTube Music Top 100 — kept for the desktop
  // build; the mobile Home tab now uses trending() + hotThisWeek() instead).
  function chart(limit) {
    const n = Math.min(50, Math.max(1, Number(limit) || 30));
    return once(`c:${n}`, async () => {
      const cached = memoGet(`c:${n}`, 15 * 60 * 1000);
      if (cached) return cached;
      const attempts = [];
      if (RELAYS.length) attempts.push(() => withRelays((relay) => relayChart(relay, n)));
      attempts.push(() => pipedChart(n));
      attempts.push(() => innertubeChart(n));
      const tracks = await firstSuccess(attempts);
      memoSet(`c:${n}`, tracks, 15 * 60 * 1000);
      return tracks;
    });
  }

  /* ------------------------------ music-only filtering ------------------------------ */

  // This is a MUSIC app — strip the non-music noise YouTube surfaces in
  // searches (movie trailers, podcasts, gameplay, full albums, livestreams,
  // etc.). Long videos are almost never songs: official music videos run
  // 2-8 min, and the odd 10-min-plus single is far rarer than the albums,
  // live streams and documentaries the cap removes.
  const NON_MUSIC = /(trailer|teaser|gameplay|walkthrough|let'?s play|full movie|movie scene|movie clip|film scene|podcast|episode \d|documentary|audiobook|full album|live stream|livestream|tutorial|review|reaction|show|#?shorts)/i;
  // TV/movie content that sneaks past the Songs filter as a "song" row — the
  // name is clean ("The Weeknd's Dark Secret") but the ARTIST is a show cast
  // ("American Dad! Cast"). Checked against name + artist, so legit artists
  // with "Cast" in the name (e.g. the band Cast) survive.
  const TV_CAST = /(american dad|family guy|the simpsons|simpsons|south park|spongebob|rick and morty|paw patrol|sesame street|nickelodeon|disney junior|ren & stimpy|ren and stimpy)!?\s+cast|\bcast\b.*\b(sing|song|theme|soundtrack)\b/i;
  // A cartoon/show used as the ARTIST ("Ren & Stimpy", "SpongeBob") — the
  // name may be a perfectly clean song title, so check the artist alone.
  const TV_SHOW_ARTIST = /^(ren & stimpy|ren and stimpy|spongebob|the simpsons|american dad|family guy|south park|rick and morty|paw patrol|sesame street cast|nickelodeon)$/i;
  // Entries with no parseable length can't be trusted — a 0s "Music Mix 2026"
  // is a compilation, not a song. Stricter noise rules for those.
  const NO_LENGTH_NOISE = /(mix|mega|compilation|best of|top songs|shorts)/i;
  const MAX_SONG_SEC = 15 * 60;

  // Heuristic filter: remove Indian music from recommendation rows. YouTube's
  // content mix for global queries ("top hits", "trending songs") is heavily
  // skewed toward Indian music labels (T-Series, Zee, etc.) — the app is
  // configured for Philippine / international listening, so these are stripped.
  // The list covers the major Indian labels, common artist names, and language
  // indicators. Search results are never filtered.
  const INDIAN_PATTERNS = [
    /t[- ]?series/i, /zee music/i, /saregama/i, /tips official/i, /speed records/i,
    /sony music india/i, /times music/i, /venus music/i, /shemaroo/i,
    /think music/i, /wave music/i, /bhojpuri/i, /punjabi/i, /hindi/, /tamil/, /telugu/,
    /malayalam/i, /kannada/i, /marathi/i, /gujarati/i,
    /arijit singh/i, /neha kakkar/i, /badshah/i, /diljit dosanjh/i,
    /lata mangeshkar/i, /kishore kumar/i, /mohit chauhan/i,
    /a[ .]r[ .]rahman/i, /shreya ghoshal/i, /sunidhi chauhan/i,
    /yo yo honey singh/i, /honey singh/i, /mika singh/i, /jubin nautiyal/i,
    /darshan raval/i, /b praak/i, /guru randhawa/i,
    /tulsi kumar/i, /palak muchhal/i, /akriti kakar/i,
    /sachin[ -]jigar/i, /vishal[ -]shekhar/i, /shankar[ -]ehasaan[ -]loy/i,
    /arijitsingh/i, /diljitdosanjh/i,
    /desi music/i, /desi hits/i, /indian music/i, /bollywood/i,
    /t-series/i, /zeemusiccompany/i,
  ];

  function isIndian(track) {
    const haystack = ((track.artist || '') + ' ' + (track.name || '')).toLowerCase();
    return INDIAN_PATTERNS.some((re) => re.test(haystack));
  }

  function musicOnly(tracks, opts = {}) {
    return (tracks || []).filter((t) => {
      const dur = Number(t.duration) || 0;
      const name = String(t.name || '');
      const nameArtist = `${name} ${t.artist || ''}`;
      const artist = String(t.artist || '').trim();
      if (dur > MAX_SONG_SEC) return false;
      if (NON_MUSIC.test(nameArtist)) return false;
      if (TV_CAST.test(nameArtist)) return false;
      if (artist && TV_SHOW_ARTIST.test(artist)) return false;
      if (dur === 0 && NO_LENGTH_NOISE.test(name)) return false;
      if (opts.filterIndian && isIndian(t)) return false;
      return true;
    });
  }

  // A version of a song that isn't the original (karaoke, covers, instrumentals,
  // remixes, slowed/sped-up, lyric videos…) — never what a recommendation should
  // play. Applied to recommendation rows and chart-track resolution only;
  // explicit user searches are left alone (someone searching "x karaoke" wants it).
  const VERSION_NOISE = /(karaoke|instrumental|piano cover|guitar cover|acoustic cover|cover version|\bcover(?: by| of| of the)?\b|tribute|with lyrics|lyric video|lyrics video|remix|slowed|sped up|8d audio|reverb|nightcore|mashup)/i;

  function stripVersions(tracks) {
    return (tracks || []).filter((t) => !VERSION_NOISE.test(String(t.name || '')));
  }

  // ── Trending Now ─────────────────────────────────────────────────────────
  // "What's hot right now, per YouTube" — a handful of rotating queries the
  // internet is actually searching for, merged + deduped + music-filtered.
  // Each call rotates the query order so consecutive visits feel fresh.
  const TRENDING_QUERIES = [
    'top hits this week', 'trending songs today', 'viral songs right now',
    'hottest songs this week', 'trending music playlist', 'new popular songs 2026',
  ];
  let tqIdx = 0;

  function trending(limit) {
    const n = Math.min(30, Math.max(1, Number(limit) || 12));
    return once('trending', async () => {
      const cached = memoGet('trending', 10 * 60 * 1000);
      if (cached) return cached;
      // 3 rotating queries, staggered so a burst can't trip the rate limiter.
      const start = (tqIdx = (tqIdx + 3) % TRENDING_QUERIES.length);
      const qs = [0, 1, 2].map((i) => TRENDING_QUERIES[(start + i) % TRENDING_QUERIES.length]);
      const rows = [];
      for (const q of qs) {
        try {
          rows.push(await search(q, 8, { noVersions: true }));
        } catch { /* keep the rest */ }
        await new Promise((r) => setTimeout(r, 350));
      }
      const seen = new Map();
      rows.flat().forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
      const tracks = stripVersions([...seen.values()]).slice(0, n);
      if (!tracks.length) throw new Error(SOURCE_ERR);
      memoSet('trending', tracks, 10 * 60 * 1000);
      return tracks;
    });
  }

  // ── Hot This Week (worldwide chart) ─────────────────────────────────────
  // YouTube Music's own Top 100 playlists — the same YTM source as the
  // Trending row, so every entry is a real playable track with a videoId
  // (no lazy search-resolution when tapped). country is kept for the PH
  // chart call; both feed from YTM's global/US Top 100 lists.
  async function hotThisWeek(limit, country = 'us') {
    const n = Math.min(25, Math.max(1, Number(limit) || 12));
    const key = `hot:${country}`;
    return once(key, async () => {
      const cached = memoGet(key, 10 * 60 * 1000);
      if (cached) return cached;
      // chart() fetches the YTM Top 100 (relay → Piped → innertube) and is
      // already music-only filtered at the source; re-filter defensively.
      const tracks = musicOnly(await chart(n * 2))
        .filter((t) => !isIndian(t))
        .slice(0, n);
      if (!tracks.length) throw new Error(SOURCE_ERR);
      memoSet(key, tracks, 10 * 60 * 1000);
      return tracks;
    });
  }

  // ── PH Trending ──────────────────────────────────────────────────────────
  // What the Philippines is listening to right now: Apple Music PH chart +
  // YouTube search fallback (both filtered).
  async function phTrending(limit) {
    const n = Math.min(25, Math.max(1, Number(limit) || 12));
    return once('ph', async () => {
      const cached = memoGet('ph', 10 * 60 * 1000);
      if (cached) return cached;
      const tracks = [];
      // 1. Apple Music PH chart
      try {
        const ph = await hotThisWeek(n, 'ph');
        tracks.push(...ph);
      } catch { /* fall through */ }
      // 2. YouTube PH trending search
      try {
        const yt = await search('Philippines trending songs today', 8, { noVersions: true });
        tracks.push(...yt);
      } catch { /* fall through */ }
      // 3. Dedupe + filter Indian + drop karaoke/cover versions
      const seen = new Map();
      tracks.forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
      const out = stripVersions([...seen.values()]).filter((t) => !isIndian(t)).slice(0, n);
      if (!out.length) throw new Error(SOURCE_ERR);
      memoSet('ph', out, 10 * 60 * 1000);
      return out;
    });
  }

  // Resolve a chart track (no videoId yet) to a playable YouTube track.
  // Searches several candidates and picks the best match — the top result is
  // often a karaoke/cover version of a chart hit.
  async function resolveChartTrack(track) {
    if (track.videoId) return track;
    if (!track.searchQuery) throw new Error('No playable source for this track');
    const hits = stripVersions(await search(track.searchQuery, 8, { noVersions: true }));
    if (!hits || !hits.length) throw new Error('Couldn\'t find this track on YouTube');
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const wantedName = norm(track.name);
    const wantedArtist = norm(track.artist);
    // Score: exact title match + artist match beats a near miss. A karaoke/
    // cover version is already stripped; this guards against wrong-artist hits.
    const score = (t) => {
      let s = 0;
      const n = norm(t.name);
      const a = norm(t.artist);
      if (n === wantedName) s += 3;
      else if (wantedName && (n.includes(wantedName) || wantedName.includes(n))) s += 1;
      if (a === wantedArtist) s += 2;
      else if (wantedArtist && (a.includes(wantedArtist) || wantedArtist.includes(a))) s += 1;
      return s;
    };
    hits.sort((a, b) => score(b) - score(a));
    const hit = hits[0];
    // Playback routes on source === 'youtube' + videoId — normalize it.
    return { ...track, videoId: hit.videoId, id: hit.id, source: 'youtube',
      cover: hit.cover || track.cover, duration: hit.duration || track.duration, searchQuery: '' };
  }

  // Drop cached trending/hot/PH data so the next call re-fetches (auto-update).
  function refreshTrending() { memo.delete('trending'); pending.delete('trending'); }
  function refreshHot() { memo.delete('hot'); pending.delete('hot'); }
  function refreshPH() { memo.delete('ph'); pending.delete('ph'); }

  // ── Albums ───────────────────────────────────────────────────────────────
  // Real YouTube Music albums (Albums filter) where possible — each card opens
  // an overlay filled with the album's actual tracklist. Falls back to
  // artist-grouping only when no real album cards come back.

  // The Albums filter that actually returns album cards ("Album • Artist •
  // Year" rows with an MPRE browseId). The older EgWKAQIQAA variant is flaky.
  const ALBUM_FILTER = 'EgWKAQIQAQE';

  // First MPRE browseId reachable inside an album row (it nests in the title's
  // text run or the "Go to album" menu item, NOT on the renderer itself).
  function findAlbumBrowseId(obj) {
    let found = '';
    (function go(x) {
      if (found || !x || typeof x !== 'object') return;
      const nav = x.navigationEndpoint && x.navigationEndpoint.browseEndpoint;
      if (nav && /^MPRE/.test(nav.browseId)) { found = nav.browseId; return; }
      for (const k of Object.keys(x)) go(x[k]);
    })(obj);
    return found;
  }

  function parseAlbums(data) {
    const out = [];
    walk(data.contents || data, (o) => {
      const m = o.musicResponsiveListItemRenderer;
      if (!m || m.playlistItemData) return; // skip song rows
      const flex = m.flexColumns || [];
      const col = (i) => flex[i] && flex[i].musicResponsiveListItemFlexColumnRenderer && flex[i].musicResponsiveListItemFlexColumnRenderer.text;
      const title = runsText(col(0));
      if (!title) return;
      // col1 reads "Album • Artist • Year" — pull the artist + year apart.
      const sub = runsText(col(1));
      const yearMatch = /\b(19|20)\d{2}\b/.exec(sub);
      const artist = sub.replace(/^Album\s*•\s*/i, '').replace(/\s*•\s*(19|20)\d{2}\s*$/, '').trim() || 'Unknown artist';
      let cover = '';
      const thumb = m.thumbnail && m.thumbnail.musicThumbnailRenderer && m.thumbnail.musicThumbnailRenderer.thumbnail;
      if (thumb && thumb.thumbnails && thumb.thumbnails.length) cover = thumb.thumbnails[thumb.thumbnails.length - 1].url;
      const browseId = findAlbumBrowseId(m);
      if (!browseId) return;
      out.push({
        id: `album:${browseId}`,
        name: title,
        artist: artist || 'Unknown artist',
        cover,
        browseId,
        year: yearMatch ? Number(yearMatch[0]) : 0,
        trackCount: 0,
        source: 'album',
      });
    });
    return out;
  }

  async function albumSearch(query, limit) {
    const q = String(query || '').trim().slice(0, 200);
    const n = Math.min(20, Math.max(1, Number(limit) || 8));
    if (!q) return [];
    return once(`alb:${q}:${n}`, async () => {
      const cached = memoGet(`alb:${q}:${n}`, 10 * 60 * 1000);
      if (cached) return cached;
      let albums = [];
      // 1. Real album cards (Albums filter, WEB_REMIX client).
      try {
        albums = await firstSuccess([
          () => withRelays((relay) => getJson(`${relay}/search?q=${encodeURIComponent(q)}&mode=albums&limit=${n}`).then((d) => d.albums)),
          async () => parseAlbums(await innertubePost(`${YT}/search`, { query: q, params: ALBUM_FILTER }, CLIENT_WEB_REMIX)).slice(0, n),
        ]);
      } catch { /* fall through to grouping */ }
      albums = (albums || []).filter((a) => a && a.browseId);
      // 2. Fallback: group song-search results by artist (pseudo-albums).
      if (albums.length < Math.min(3, n)) {
        try {
          const tracks = stripVersions(musicOnly(await firstSuccess([
            () => withRelays((relay) => relaySearch(relay, q, n * 2)),
            () => innertubeSearch(q, n),
          ])));
          const seen = new Map();
          tracks.forEach((t) => {
            const a = (t.artist || 'Unknown artist').trim();
            if (!seen.has(a)) {
              seen.set(a, { name: t.name, artist: a, cover: t.cover || '', browseId: '', year: 0, trackCount: 0, source: 'album', _artistQuery: a });
            } else if (!seen.get(a).cover && t.cover) {
              seen.get(a).cover = t.cover;
            }
          });
          const grouped = [...seen.values()].slice(0, n);
          // Prefer real albums; pad with pseudo-albums only if real ones are few.
          if (albums.length < Math.min(3, n)) {
            albums = grouped.slice(0, n);
          }
        } catch { /* keep whatever real albums we got */ }
      }
      if (!albums.length) throw new Error(SOURCE_ERR);
      memoSet(`alb:${q}:${n}`, albums, 10 * 60 * 1000);
      return albums;
    });
  }

  // Some album browse responses ship rows with an EMPTY artist column
  // (flexColumns[1].text is {}), so the only artist in the row is the
  // play-button accessibility label: "Play Gasoline - The Weeknd".
  // Extract it as a fallback.
  function albumRowArtist(m) {
    try {
      const ov = m.overlay && m.overlay.musicItemThumbnailOverlayRenderer;
      const pb = ov && ov.content && ov.content.musicPlayButtonRenderer;
      const ad = pb && pb.accessibilityPlayData && pb.accessibilityPlayData.accessibilityData;
      const label = ad && ad.label;
      if (!label) return '';
      const s = String(label).replace(/^(Play|Pause)\s+/i, '');
      const parts = s.split(' - ');
      return parts.length > 1 ? parts[parts.length - 1].trim() : '';
    } catch { return ''; }
  }

  // Parse an album/playlist browse (WEB_REMIX) — rows have the videoId in
  // playlistItemData, the artist in flexColumns[1] runs, and the duration in
  // fixedColumns[0] (NOT flexColumns[2]).
  function parseAlbumTracks(data) {
    const seen = new Map();
    walk(data.contents || data, (o) => {
      const m = o.musicResponsiveListItemRenderer;
      if (!m) return;
      const pid = m.playlistItemData;
      const id = (pid && pid.videoId) || m.videoId;
      if (!id || seen.has(id)) return;
      const flex = m.flexColumns || [];
      const name = flexText2(flex, 0);
      if (!name) return;
      // Artist: flexColumns[1] runs ("Song" • "artist" or just "artist").
      const runs = flexRuns(flex, 1) || [];
      let artist = '';
      for (const run of runs) {
        const t = String(run.text || '').trim();
        if (!t || t === '•' || t === 'Song' || t === 'Album' || t === 'Artist') continue;
        if (/^\d+:\d{2}(:\d{2})?$/.test(t)) continue; // a duration run is not the artist
        artist += (artist ? ' ' : '') + t;
      }
      if (!artist) artist = albumRowArtist(m);
      // Duration: fixedColumns[0] ("3:45" as text).
      let duration = 0;
      try {
        const fc = m.fixedColumns && m.fixedColumns[0] && m.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
        const ft = fc && fc.text;
        const dt = (ft && (ft.runs ? ft.runs.map((r) => r.text).join('') : ft.simpleText)) || '';
        if (/^\d+:\d{2}(:\d{2})?$/.test(dt.trim())) duration = parseDuration(dt);
      } catch { /* duration stays 0 */ }
      const track = toTrack(id, name, artist || 'Unknown artist', duration);
      // Album art from the row thumbnail.
      try {
        const th = m.thumbnail && m.thumbnail.musicThumbnailRenderer && m.thumbnail.musicThumbnailRenderer.thumbnail;
        if (th && th.thumbnails && th.thumbnails.length) track.cover = th.thumbnails[th.thumbnails.length - 1].url;
      } catch { /* keep default */ }
      seen.set(id, track);
    });
    return [...seen.values()].filter((t) => t.name && t.name !== 'Untitled');
  }

  // Pull the next-page continuation token out of a browse response
  // (continuationContents.<shelf>Continuation.continuations[0].nextContinuationData).
  function findContinuation(data) {
    let out = null;
    walk(data, (o) => {
      if (out || !o || typeof o !== 'object') return;
      const nd = o.nextContinuationData || o.reloadContinuationData;
      if (nd && typeof nd.continuation === 'string') {
        out = { token: nd.continuation, ctp: nd.clickTrackingParams || '' };
      }
    });
    return out;
  }

  async function albumTracks(artist, browseId) {
    const id = String(browseId || '').trim();
    const artistQ = String(artist || '').trim();
    const key = id || `artist:${artistQ}`;
    if (!key) throw new Error('No album or artist info');
    return once(`alb:${key}`, async () => {
      const cached = memoGet(`alb:${key}`, 30 * 60 * 1000);
      if (cached) return cached;
      let tracks = [];
      // Real browseId (from a genuine YouTube Music album). Album ids (MPRE)
      // 500 with the ANDROID client — the relays and the direct fallback both
      // browse them via WEB_REMIX.
      if (id) {
        let relayTracks = [];
        try {
          if (RELAYS.length) {
            try {
              // Ask for up to 500 — upgraded relays paginate to deliver the
              // FULL album/playlist; older ones still cap at 50 (the direct
              // paginated fetch below fills the gap).
              const data = await withRelays((relay) => getJson(`${relay}/chart?browseId=${encodeURIComponent(id)}&limit=500`, { timeout: 10000 }));
              relayTracks = data.tracks || [];
            } catch { /* fall through */ }
          }
        } catch { /* fall through to direct browse */ }
        tracks = relayTracks.slice();
        // The relay caps every browse at 50 tracks. A result in the 8-49 range
        // is a complete album (fast path — no extra fetch). But 50+ (or a tiny
        // failed result) means the real album/playlist may be longer: fetch the
        // FULL list directly and follow every continuation page, so the app
        // shows exactly what YouTube Music has (not just the first 50). The
        // direct list (canonical album order) wins; relay-only tracks fill gaps.
        if (relayTracks.length >= 50 || relayTracks.length < 8) {
          try {
            let data = await innertubePost(`${YT}/browse`, { browseId: id }, CLIENT_WEB_REMIX);
            const direct = parseAlbumTracks(data);
            for (let page = 0; page < 12 && direct.length < 400; page++) {
              const cont = findContinuation(data);
              if (!cont) break;
              data = await innertubePost(`${YT}/browse`, { continuation: cont.token, clickTrackingParams: cont.ctp }, CLIENT_WEB_REMIX);
              const more = parseAlbumTracks(data);
              if (!more.length) break;
              direct.push(...more);
            }
            if (direct.length) {
              const seenIds = new Set();
              tracks = direct.concat(relayTracks).filter((t) => (seenIds.has(t.id) ? false : (seenIds.add(t.id), true)));
            }
          } catch { /* keep the relay result */ }
        }
      }
      // Fallback for pseudo-albums / failed browses: search the artist name
      // for more tracks (versions like karaoke/cover are stripped).
      if (!tracks.length && artistQ && artistQ !== 'Unknown artist') {
        try {
          tracks = stripVersions(musicOnly(await firstSuccess([
            () => withRelays((relay) => relaySearch(relay, artistQ, 16)),
            () => innertubeSearch(artistQ, 16),
          ])));
        } catch { /* nothing */ }
      }
      if (!tracks.length) throw new Error(SOURCE_ERR);
      memoSet(`alb:${key}`, tracks, 30 * 60 * 1000);
      return tracks;
    });
  }

  /* ------------------------------ playlists (YouTube Playlists as Albums) ------------------------------ */

  // YT Music search filter that returns ONLY playlist rows.
  const PLAYLIST_FILTER = 'EgWKAQIIA2oKEAoQCRADEAA%3D';

  // First playlist (VL…) browseId reachable inside a playlist row (nests in
  // the title's navigationEndpoint, like album browseIds do).
  function findPlaylistBrowseId(obj) {
    let found = '';
    (function go(x) {
      if (found || !x || typeof x !== 'object') return;
      const nav = x.navigationEndpoint && x.navigationEndpoint.browseEndpoint;
      if (nav && /^VL/.test(nav.browseId)) { found = nav.browseId; return; }
      for (const k of Object.keys(x)) go(x[k]);
    })(obj);
    return found;
  }

  function parsePlaylists(data) {
    const out = [];
    walk(data.contents || data, (o) => {
      const m = o.musicResponsiveListItemRenderer;
      if (!m || m.playlistItemData) return; // skip song rows
      const flex = m.flexColumns || [];
      const col = (i) => flex[i] && flex[i].musicResponsiveListItemFlexColumnRenderer && flex[i].musicResponsiveListItemFlexColumnRenderer.text;
      const title = runsText(col(0));
      if (!title) return;
      // col1 reads "Playlist • Creator • N songs" — pull the creator name.
      const sub = runsText(col(1));
      let artist = sub.replace(/^Playlist\s*•\s*/i, '').replace(/\s*•\s*[\d,]+\s*songs?\s*$/i, '').trim() || 'OrBeat Music';
      // YouTube Music's own playlists surface the platform as the creator —
      // show our own brand instead.
      if (/^youtube\s*music$/i.test(artist)) artist = 'OrBeat Music';
      let cover = '';
      const thumb = m.thumbnail && m.thumbnail.musicThumbnailRenderer && m.thumbnail.musicThumbnailRenderer.thumbnail;
      if (thumb && thumb.thumbnails && thumb.thumbnails.length) cover = thumb.thumbnails[thumb.thumbnails.length - 1].url;
      const browseId = findPlaylistBrowseId(m);
      if (!browseId) return;
      out.push({
        id: `pl:${browseId}`,
        name: title,
        artist: artist || 'Unknown artist',
        cover,
        browseId,
        year: 0,
        trackCount: 0,
        source: 'playlist',
      });
    });
    return out;
  }

  // playlistSearch(query, limit) → playlist[] — YouTube playlists surfaced as
  // the app's "Albums" (each opens the album view and plays its track list).
  async function playlistSearch(query, limit) {
    const q = String(query || '').trim().slice(0, 200);
    const n = Math.min(20, Math.max(1, Number(limit) || 8));
    if (!q) return [];
    return once(`pls:${q}:${n}`, async () => {
      const cached = memoGet(`pls:${q}:${n}`, 10 * 60 * 1000);
      if (cached) return cached;
      let playlists = [];
      try {
        playlists = await firstSuccess([
          () => withRelays((relay) => getJson(`${relay}/search?q=${encodeURIComponent(q)}&mode=playlists&limit=${n}`).then((d) => d.playlists)),
          async () => parsePlaylists(await innertubePost(`${YT}/search`, { query: q, params: PLAYLIST_FILTER }, CLIENT_WEB_REMIX)).slice(0, n),
        ]);
      } catch { /* no playlists */ }
      playlists = (playlists || []).filter((p) => p && p.browseId);
      if (!playlists.length) throw new Error(SOURCE_ERR);
      memoSet(`pls:${q}:${n}`, playlists, 10 * 60 * 1000);
      return playlists;
    });
  }

  // streamUrl(videoId) → { url, videoId }
  async function streamUrl(videoId) {
    const id = String(videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{5,}$/.test(id)) throw new Error('Invalid video id');
    return once(`p:${id}`, async () => {
      const tier = streamTier(); // captured once per resolution
      const pkey = `p:${id}#${tier}`;
      try {
        const cached = memoGet(pkey, 3 * 60 * 60 * 1000)
          || streamCacheGet(id); // a resolution that survived an app restart
        // A cached relay URL is only usable while that relay is still healthy
        // AND is the relay this app would pick RIGHT NOW. Relay URLs are cheap
        // to rebuild (a bare URL string — the relay resolves server-side), so
        // a stale cache entry pinned to a bot-blocked relay (e.g. the on-device
        // one sharing the phone's IP) must never be reused once the preferred
        // relay changes back to a healthy LAN relay.
        if (cached) {
          if (!cached.viaRelay) return cached; // direct piped/innertube URL
          // No healthy relay at all — keep whatever we had (better than nothing).
          if (!RELAYS.some(relayHealthy)) return cached;
          // Healthy relays exist: the cached URL must point at the one we'd
          // pick NOW, or it's stale (e.g. pinned to the bot-blocked on-device
          // relay while a healthy LAN relay is available) — re-resolve.
          const preferred = preferredRelay();
          if (preferred && cached.relay === preferred && relayHealthy(cached.relay)) return cached;
        }
        // Relay: the <audio> element follows the 302 redirect itself, so the
        // "url" is simply the relay's stream endpoint. Rotate healthy relays
        // to spread load; fall through to direct sources when no relay is
        // healthy. (Stream failures are reported back via reportStreamFailure
        // so the circuit breaker also hears about them.)
        let out = null;
        if (RELAYS.some(relayHealthy)) {
          const relay = preferredRelay();
          // &q= tells the relay which quality tier to resolve (see the relay
          // sources: on-device Java relay, CF worker, PC yt-dlp relay).
          out = { url: `${relay}/stream?videoId=${encodeURIComponent(id)}&q=${tier}`, videoId: id, viaRelay: true, relay };
        } else {
          const url = await firstSuccess([
            () => pipedStreamUrl(id),
            () => innertubeStreamUrl(id),
          ]);
          out = { url, videoId: id };
        }
        memoSet(pkey, out, 3 * 60 * 60 * 1000);
        streamCacheSet(id, out); // survive restarts
        return out;
      } catch (e) {
        throw friendlyError(e);
      }
    });
  }

  // The <audio> element failed to play a URL the engine resolved. If it was a
  // relay URL, mark that relay down (feeds the circuit breaker) and drop the
  // cached URL so the next attempt re-resolves from a healthy source.
  // A stream failed to play. opts.markDown (set only after an automatic retry
  // failed too) triggers the circuit breaker — a SINGLE failure is usually a
  // stale signed URL (self-heals on re-resolution), not evidence the relay is
  // bad, so it only invalidates the cached URL. Marking the healthy LAN relay
  // down on the first miss would push playback onto the bot-blocked on-device
  // relay for the whole cooldown — the exact stall we're avoiding.
  function reportStreamFailure(videoId, opts = {}) {
    // Drop every tier variant of this video (the failure is video-specific).
    let key = null;
    for (const k of memo.keys()) {
      if (k === `p:${videoId}` || k.startsWith(`p:${videoId}#`)) { key = k; break; }
    }
    const cached = key ? memo.get(key) : undefined;
    if (opts.markDown && cached && cached.value && cached.value.viaRelay) {
      // A single bad video must NOT take the on-device relay out of rotation:
      // that's this phone's own server (the primary, PC-off path), and a track
      // failure is almost always video-specific (region lock, a stale signed
      // URL) rather than the relay being down. Marking it down pushes playback
      // onto the PC relays, which are unreachable when the PC is off. The PC
      // relays (LAN/Tailscale) still get tripped as before.
      if (!/127\.0\.0\.1|localhost/.test(cached.value.relay)) {
        markRelayDown(cached.value.relay, { short: true });
      }
    }
    for (const k of memo.keys()) if (k === `p:${videoId}` || k.startsWith(`p:${videoId}#`)) memo.delete(k);
    pending.delete(`p:${videoId}`);
    streamCacheDel(videoId);
  }

  // Drop any cached/pending resolution for a video so the next play re-resolves
  // a fresh URL (signed YouTube URLs expire; a stale one can't be replayed).
  function invalidateStream(videoId) {
    for (const k of memo.keys()) if (k === `p:${videoId}` || k.startsWith(`p:${videoId}#`)) memo.delete(k);
    pending.delete(`p:${videoId}`);
    streamCacheDel(videoId);
  }

  function warm(videoId) {
    streamUrl(videoId).catch(() => {});
    // Also ask the relay to pre-resolve the stream URL so the next /stream
    // request starts instantly instead of resolving on first tap. The tier is
    // passed so the warm fills the SAME cache key the upcoming play reads
    // (relay caches are tier-tagged — a tier-less warm would be wasted work).
    // Paced like every other YouTube-facing call when the warm hits THIS
    // phone's own IP (the on-device loopback relay / direct path) — a /warm
    // triggers a player resolve, so it must not fire unthrottled during the
    // startup burst (the trending rows used to warm ~9 tracks at once). A
    // REMOTE relay (tunnel/Worker) resolves from its own IP and skips the
    // queue, so warming the next track never waits behind home-row requests.
    if (RELAYS.some(relayHealthy)) {
      const warmUrl = `${preferredRelay()}/warm?videoId=${encodeURIComponent(videoId)}&q=${streamTier()}`;
      const fire = () => fetchT(warmUrl, { credentials: 'omit' }, 8000);
      (remoteRelayOf(warmUrl) ? fire() : paced(fire)).catch(() => {});
    }
  }

  /* ------------------------------ relay health ------------------------------ */

  async function checkRelayHealth(url) {
    try {
      const res = await fetchT(`${url}/health`, { credentials: 'omit' }, 8000);
      return res.ok;
    } catch { return false; }
  }

  // Ping every saved relay once at startup: dead URLs get marked down right
  // away so the engine falls back to mirrors instead of failing every track.
  // A relay that's unreachable AT STARTUP (e.g. the PC relay when the PC is
  // off) is kept out of the healthy pool for the whole session — the normal
  // 15s-2min backoff would let it re-enter mid-playlist and hijack streams
  // (verified on-device: dead PC relay picked for a track after its cooldown
  // expired). A restart re-checks everything, so a relay that comes back is
  // picked up on the next app launch.
  async function checkRelays() {
    await Promise.all(RELAYS.map(async (url) => {
      const ok = await checkRelayHealth(url);
      if (ok) markRelayOk(url);
      else relayHealth.set(url, { fails: 99, downUntil: Date.now() + 6 * 60 * 60 * 1000, lastGood: 0 });
    }));
  }

  // Re-ping ONE relay and mark it healthy only if it responds. The app calls
  // this after startup because the on-device relay binds its loopback socket a
  // moment after the service starts — the initial checkRelays() can race it.
  // Unlike a second full checkRelays(), this NEVER marks the relay down, so it
  // can't double the circuit-breaker backoff on a transient miss.
  async function confirmRelay(url) {
    try {
      if (await checkRelayHealth(url)) markRelayOk(url);
    } catch { /* keep the existing health state */ }
  }

  // validateRelays(raw) → { ok: [urls], bad: [urls] } — pings each URL so the
  // app can refuse to save a relay that isn't actually reachable.
  async function validateRelays(raw) {
    const urls = String(raw || '')
      .split(/[\n,]+/).map((s) => s.trim().replace(/\/+$/, ''))
      .filter((s) => /^https?:\/\//.test(s));
    const ok = [];
    const bad = [];
    for (const u of [...new Set(urls)]) {
      (await checkRelayHealth(u)) ? ok.push(u) : bad.push(u);
    }
    return { ok, bad };
  }

  async function firstSuccess(fns) {
    let lastErr;
    for (const fn of fns) {
      try {
        const v = await fn();
        if (v && v.length !== undefined ? v.length > 0 : v) return v;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error(SOURCE_ERR);
  }

  return {
    search,
    chart,
    streamUrl,
    warm,
    setRelays,
    checkRelays,
    confirmRelay,
    validateRelays,
    reportStreamFailure,
    invalidateStream,
    streamTier,
    qualitySetting,
    setStreamQuality,
    noteChunkSpeed,
    noteChunkTruncation,
    truncationCushion,
    trending,
    hotThisWeek,
    phTrending,
    albumSearch,
    albumTracks,
    playlistSearch,
    resolveChartTrack,
    refreshTrending,
    refreshHot,
    refreshPH,
    guardCheck,
    isIndianTrack: isIndian,
    getRelays: () => [...RELAYS],
    relayCount: () => RELAYS.length,
    __test: { parseSearch, parsePlaylist, parsePipedItems, pickAudioFormat, parseDuration, toTrack, setRelays, musicOnly, stripVersions, parseAlbums, parseAlbumTracks, parsePlaylists, orderBaked, loadRelays, getRelays: () => [...RELAYS], streamOrder },
  };
})();
