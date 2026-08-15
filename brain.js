/* OrBeat Mobile — brain.js
 *
 * The app's adaptive "brain", in two halves:
 *
 * 1. SECURITY GOVERNOR — drives how the engine talks to YouTube.
 *    - Adaptive pacing: a sliding window of outcomes (ok / fail / block)
 *      widens the minimum gap between YouTube-facing requests when YouTube
 *      pushes back, and tightens it back down when things stay clean. The
 *      engine consults Brain.gap() on every call instead of a fixed 300ms.
 *    - Stress mode: a confirmed block puts the engine into a conservative
 *      state (wider gap, single concurrent request) for 30 minutes instead
 *      of instantly hammering again.
 *    - Identity memory: remembers which rotating UA identities have failed
 *      recently so rotation skips freshly-flagged ones instead of blindly
 *      hopping forward.
 *
 * 2. LISTENING PROFILE — powers better recommendations.
 *    - Artist affinities weighted by recency (recent plays count more than
 *      old ones; affinity decays over ~2 weeks).
 *    - Seed selection for the For You row: top affinities + the last played
 *      artist + "rediscovery" candidates (favorites played long ago).
 *    - Recently-played dedup so For You never re-suggests what you just
 *      heard — a real gap in the old row (it only deduped against the grid).
 */
window.Brain = (() => {
  'use strict';

  const PROFILE_KEY = 'natsirt_brain_profile';
  const STATE_KEY = 'natsirt_brain_state'; // persisted security state
  const PLAYS_KEY = 'natsirt_plays'; // app.js plays store (newest first)
  const WINDOW = 60;          // outcomes kept in the sliding window
  const OUTCOME_TTL_MS = 24 * 3600 * 1000; // drop outcomes older than 24h
  const BASE_GAP = 300;       // min gap (ms) between requests when clean
  const BATCH_GAP = 550;      // gap while a known batch is in flight
  const STRESS_GAP = 1200;    // min gap during stress mode
  const BLOCK_GAP = 2500;     // min gap right after a block
  const STRESS_MS = 30 * 60 * 1000; // how long a confirmed block keeps us wary
  const RATE_LOOKBACK_MS = 30000; // rate window for burst anticipation
  const RATE_SOFT = 11;       // requests in the window → start spacing out
  const RATE_HARD = 16;       // requests in the window → push out hard
  const AFFINITY_HALF_LIFE_MS = 10 * 86400000; // affinity decays over ~2 wks

  let outcomes = [];            // { k: 'ok'|'fail'|'block', t: ts }, oldest → newest
  let lastBlockAt = 0;
  let stressUntil = 0;
  let batchUntil = 0;           // announced batch smoothing window
  let identityFails = new Map(); // uaIdx -> count of recent failures

  const now = () => Date.now();

  /* ------------------------- persistence ------------------------- */

  // Persist the security state so a flagged network STAYS conservative across
  // restarts: the sliding outcome window, the last block timestamp (which
  // drives stress mode — recomputed on load, so an old block's stress expires
  // naturally), and the identity-failure memory. The listening profile is
  // already persisted separately.
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        outcomes, lastBlockAt, identityFails: [...identityFails.entries()], savedAt: now(),
      }));
    } catch { /* storage full/unavailable — in-memory only */ }
  }

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY));
      if (!s || typeof s !== 'object') return;
      const t = now();
      if (Array.isArray(s.outcomes)) {
        outcomes = s.outcomes
          .filter((o) => o && typeof o.t === 'number' && t - o.t < OUTCOME_TTL_MS) // age out old signal
          .slice(-WINDOW);
      }
      if (typeof s.lastBlockAt === 'number') {
        lastBlockAt = s.lastBlockAt;
        // Stress mode is a fixed window AFTER a block; recomputing from the
        // persisted timestamp means a restart never freezes it open forever.
        stressUntil = lastBlockAt + STRESS_MS;
      }
      if (Array.isArray(s.identityFails)) {
        identityFails = new Map(s.identityFails.filter((e) => Array.isArray(e) && Number.isFinite(e[0])));
      }
    } catch { /* first run — defaults */ }
  }
  loadState();

  /* ------------------------- security governor ------------------------- */

  function recordOutcome(kind) {
    outcomes.push({ k: kind, t: now() });
    if (outcomes.length > WINDOW) outcomes.shift();
    if (kind === 'block') {
      lastBlockAt = now();
      stressUntil = now() + STRESS_MS;
    }
    saveState();
  }

  const recent = (n = WINDOW) => outcomes.slice(-n);
  const count = (kind, n = WINDOW) => recent(n).filter((o) => o.k === kind).length;
  const stress = () => now() < stressUntil;

  // The minimum interval between YouTube-facing request starts. Doubles per
  // recent block (capped), stays wide during stress mode, widens on a high
  // failure rate, and returns to the polite minimum when everything is clean.
  function gap() {
    const blocks = count('block', 20);
    if (blocks > 0) return Math.min(3000, BLOCK_GAP * Math.pow(2, Math.min(blocks, 3) - 1));
    if (stress()) return STRESS_GAP;
    if (count('fail', 20) >= 6) return 1000;
    // ANTICIPATION: bound the sustained rate from the trailing window of
    // actual requests. If the app has been chatty lately, push the gap out
    // BEFORE the next call starts — a burst can never re-form even if the UI
    // fires a batch, because each new request sees the rate already climbing.
    const r30 = countOutcomesIn(RATE_LOOKBACK_MS);
    if (r30 > RATE_HARD) return 1500;
    if (r30 > RATE_SOFT) return 900;
    // BATCH SMOOTHING: a known batch (home rows, play + preloads) was
    // announced via noteIntent — space its requests gently from the START
    // instead of letting them pile at the minimum gap.
    if (now() < batchUntil) return BATCH_GAP;
    return BASE_GAP;
  }

  function maxConcurrent() {
    return (count('block', 20) > 0 || stress()) ? 1 : 2;
  }

  function noteBlock() { recordOutcome('block'); }

  // Number of requests actually started in the last `ms` (outcomes carry
  // timestamps). This is the Brain's view of the app's current request rate.
  function countOutcomesIn(ms) {
    const cutoff = now() - ms;
    return outcomes.filter((o) => o.t >= cutoff).length;
  }

  // ANNOUNCE an upcoming batch so the governor can smooth it BEFORE it
  // starts. The app calls this at the moment a burst is triggered:
  //   'browse' — home rows load (~15 requests over the next several seconds)
  //   'play'   — stream resolve + warm + next-track preload (~4 requests)
  //   'search' — a full search + playlists shelf (~2 requests)
  // Without this the queue only reacts once requests are already queued; with
  // it the gap is widened up front and the batch trickles like a person.
  function noteIntent(kind) {
    const t = now();
    if (kind === 'play') batchUntil = Math.max(batchUntil, t + 5000);
    else if (kind === 'browse') batchUntil = Math.max(batchUntil, t + 12000);
    else batchUntil = Math.max(batchUntil, t + 3000);
  }

  /* ------------------------- identity memory ------------------------- */

  function recordIdentity(uaIdx, ok) {
    if (ok) { identityFails.delete(uaIdx); }
    else { identityFails.set(uaIdx, (identityFails.get(uaIdx) || 0) + 1); }
    if (identityFails.size > 12) { // keep the map bounded
      const entries = [...identityFails.entries()].sort((a, b) => b[1] - a[1]);
      identityFails = new Map(entries.slice(0, 8));
    }
    saveState();
  }

  // Pick the identity with the fewest recent failures, never the current one
  // (so rotation always actually moves), preferring zero-failure identities.
  function suggestIdentityStart(len, current) {
    let best = (current + 1) % len, bestFails = Infinity;
    for (let i = 0; i < len; i++) {
      const f = identityFails.get(i) || 0;
      if (i !== current && f < bestFails) { bestFails = f; best = i; }
    }
    return best;
  }

  /* ------------------------- source health memory ------------------------- */

  // Per-source health, persisted across restarts: the engine routes around
  // sources that have been failing (dead relays, flaky Piped instances, a
  // bot-blocked direct innertube path) and remembers which ones actually
  // work — so a source that failed last session doesn't get re-tried first
  // this session, and a source that kept succeeding gets preferred. A single
  // relay's failure is a relay problem, not a YouTube block — this memory is
  // exactly how the app tells the two apart over time.
  const SOURCES_KEY = 'natsirt_brain_sources';
  const SOURCE_COOLDOWN_BASE = 15000; // 15s → 30s → … → 2min cap (long backoff)
  const SOURCE_COOLDOWN_SHORT = 5000; // 5s → 10s → … (per-video stream misses)
  let sourceHealth = new Map(); // name -> { fails, downUntil, lastGood }

  function saveSources() {
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify([...sourceHealth.entries()]));
    } catch { /* storage full — in-memory only */ }
  }

  function loadSources() {
    try {
      const s = JSON.parse(localStorage.getItem(SOURCES_KEY));
      if (Array.isArray(s)) sourceHealth = new Map(s.filter((e) => Array.isArray(e) && typeof e[0] === 'string'));
    } catch { /* first run */ }
  }
  loadSources();

  function sourceHealthy(name) {
    const h = sourceHealth.get(name);
    return !h || h.downUntil < now();
  }

  // Record an outcome for a named source (relay URL, Piped instance, or the
  // literal 'innertube'). opts.short → shorter cooldown (a per-video stream
  // miss is usually the VIDEO, not the source).
  function noteSourceOutcome(name, ok, opts = {}) {
    if (!name) return;
    const h = sourceHealth.get(name) || { fails: 0, downUntil: 0, lastGood: 0 };
    if (ok) {
      h.fails = 0;
      h.downUntil = 0;
      h.lastGood = now();
    } else {
      h.fails++;
      const base = opts.short ? SOURCE_COOLDOWN_SHORT : SOURCE_COOLDOWN_BASE;
      h.downUntil = now() + Math.min(120000, base * Math.pow(2, h.fails - 1));
    }
    sourceHealth.set(name, h);
    saveSources();
  }

  // Order a candidate list best-first for the engine: healthy sources first
  // (most-recently-good first so the *working* one is tried first), then
  // cooling-down sources (soonest-to-recover first). Stable for ties.
  function suggestSourceOrder(names) {
    const t = now();
    const scored = (names || []).map((name, i) => {
      const h = sourceHealth.get(name);
      const down = h ? h.downUntil - t : 0;
      const lastGood = h ? h.lastGood : 0;
      return { name, i, down: down > 0, recoverAt: down, lastGood };
    });
    scored.sort((a, b) => {
      if (a.down !== b.down) return a.down ? 1 : -1;      // healthy first
      if (a.down) return a.recoverAt - b.recoverAt;        // soonest recovery first
      return b.lastGood - a.lastGood || a.i - b.i;         // most-recently-good first
    });
    return scored.map((s) => s.name);
  }

  /* ------------------------- failure classification ------------------------- */

  // Classify why a source call failed, so the engine can react differently:
  //   'block'   — YouTube rejected us (403/401/HTML challenge): rotate + stress.
  //   'format'  — we got JSON but zero usable items: YouTube changed the
  //               response shape; a parser patch is needed, no amount of
  //               rotation fixes this — it's the #1 breakage signal.
  //   'network' — connection-level failure (DNS/TLS/drop): transient, retry.
  //   'error'   — HTTP/server error from the source: try the next source.
  // kind: the caller's raw observation ('status', 'empty', 'network').
  function classifyFailure(kind, status) {
    if (kind === 'block') return 'block';
    if (kind === 'network') return 'network';
    if (kind === 'empty') return 'format';
    if (status === 403 || status === 401) return 'block';
    if (status >= 500) return 'error';
    if (status >= 400) return 'error';
    return 'ok';
  }

  /* ------------------------- breakage telemetry ------------------------- */

  // Compact, persisted record of classification-level failures, attached to
  // update checks so the maintainer can see what's breaking out in the wild
  // (e.g. "format×3@relay, block×1@innertube") — the app tells you what to
  // fix before users even message you. Capped so it stays tiny.
  const BREAKAGE_KEY = 'natsirt_brain_breakage';
  const BREAKAGE_MAX = 40;
  let breakage = []; // { kind, source, t }

  function loadBreakage() {
    try {
      const b = JSON.parse(localStorage.getItem(BREAKAGE_KEY));
      if (Array.isArray(b)) breakage = b.filter((e) => e && typeof e.kind === 'string').slice(-BREAKAGE_MAX);
    } catch { /* first run */ }
  }
  loadBreakage();

  function saveBreakage() {
    try { localStorage.setItem(BREAKAGE_KEY, JSON.stringify(breakage.slice(-BREAKAGE_MAX))); } catch { /* ignore */ }
  }

  function noteBreakage(kind, source) {
    breakage.push({ kind: String(kind || 'error'), source: String(source || ''), t: now() });
    saveBreakage();
  }

  // Compact "kind×count@source" summary, newest kind first — the telemetry
  // payload for the update server / drawer. Empty string = nothing broken.
  function breakageSummary() {
    const by = new Map(); // 'kind' or 'kind@source' -> count
    for (const b of breakage) {
      const key = b.source ? `${b.kind}@${b.source}` : b.kind;
      by.set(key, (by.get(key) || 0) + 1);
    }
    const parts = [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`);
    return parts.join(', ');
  }

  /* ------------------------- listening profile ------------------------- */

  // In-memory cache for every persisted store the decision paths read on hot
  // loops (gap() on every request, rankResults on every render, affinity per
  // track). Reading localStorage + JSON.parse on each call is the one thing
  // between the Brain and an INSTANT decision, so each store is loaded once
  // and kept in RAM; saves update the cache and persist in one step.
  const memCache = new Map(); // storeKey -> parsed object
  const cachedStore = (key, loader) => {
    if (!memCache.has(key)) memCache.set(key, loader());
    return memCache.get(key);
  };
  const persist = (key, val) => { memCache.set(key, val); return val; };

  function loadProfile() {
    return cachedStore(PROFILE_KEY, () => {
      try {
        const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
        return p && typeof p === 'object' && p.artists ? p : { artists: {} };
      } catch { return { artists: {} }; }
    });
  }
  const saveProfile = (p) => { persist(PROFILE_KEY, p); try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* full */ } };

  // Fed from app.js recordPlay() — the single funnel every play goes through.
  function notePlay(track) {
    if (!track) return;
    const a = String(track.artist || '').trim();
    if (!a || a === 'Unknown artist') return;
    const p = loadProfile();
    const cur = p.artists[a] || { c: 0, t: 0 };
    p.artists[a] = { c: (cur.c || 0) + 1, t: now() };
    saveProfile(p);
  }

  // Recency-weighted affinity: play count scaled by an exponential decay.
  function affinity(artist) {
    const p = loadProfile();
    const e = p.artists[String(artist || '')];
    if (!e) return 0;
    const days = Math.max(0, (now() - (e.t || 0)) / 86400000);
    return (e.c || 0) * (0.4 + 0.6 * Math.exp(-days * 86400000 / AFFINITY_HALF_LIFE_MS));
  }

  function topArtists(n = 4) {
    const p = loadProfile();
    return Object.keys(p.artists).sort((a, b) => affinity(b) - affinity(a)).slice(0, n);
  }

  function getPlays() {
    try { const p = JSON.parse(localStorage.getItem(PLAYS_KEY)); return Array.isArray(p) ? p : []; }
    catch { return []; }
  }

  function recentlyPlayedIds(n = 200) {
    return getPlays().slice(0, n).map((p) => p && p.id).filter(Boolean);
  }

  const isPlayed = (id) => recentlyPlayedIds().includes(id);

  // Seeds for the For You row: top affinities, the last played artist, then
  // rediscovery candidates (favorites whose last play was a while ago — a
  // fresh angle on old favorites). Never empty when there's any history.
  function suggestSeeds(n = 4) {
    const seeds = [];
    const push = (a) => { if (a && !seeds.includes(a)) seeds.push(a); };
    topArtists(4).forEach(push);
    // Reach beyond the exact artists played: the co-occurrence clusters of the
    // top affinities surface similar acts the user hasn't tried yet.
    topArtists(3).forEach((a) => { relatedArtists(a, 2).forEach(push); });
    const last = getPlays().find((p) => p && p.artist);
    if (last) push(String(last.artist).trim());
    const p = loadProfile();
    Object.entries(p.artists)
      .filter(([, e]) => now() - (e.t || 0) > 3 * 86400000)
      .sort((a, b) => (b[1].c || 0) - (a[1].c || 0))
      .forEach(([a]) => push(a));
    return seeds.slice(0, n);
  }

  /* ------------------------- search skip learning ------------------------- */

  // The Brain learns from search results the user IGNORES, not just the ones
  // they play: every rendered result list is "exposed", a play from that list
  // is a positive signal, and exposure that outlives the list (superseded by
  // a new search, or the user leaving search) counts as a skip. The per-artist
  // played/skipped ratio feeds a confidence-weighted term into rankResults, so
  // artists the user keeps picking RISE and artists they keep scrolling past
  // SINK — tightening the ranking with every session.

  const SIGNAL_KEY = 'natsirt_brain_search_signal';
  const SIGNAL_MAX = 200; // cap stored artists (keep the most-signalled)

  const loadSignals = () => cachedStore(SIGNAL_KEY, () => {
    try { const m = JSON.parse(localStorage.getItem(SIGNAL_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  });
  const saveSignals = (m) => {
    try {
      let entries = Object.entries(m);
      if (entries.length > SIGNAL_MAX) {
        entries.sort((a, b) => ((b[1].played || 0) + (b[1].skipped || 0)) - ((a[1].played || 0) + (a[1].skipped || 0)));
        m = Object.fromEntries(entries.slice(0, SIGNAL_MAX));
      }
      persist(SIGNAL_KEY, m);
      localStorage.setItem(SIGNAL_KEY, JSON.stringify(m));
    } catch { /* full */ }
  };

  let exposed = new Map(); // artist -> count currently exposed in a result list

  // Call when a result list is rendered: the previous list's unplayed
  // exposure is flushed (those became skips) and the new list is exposed.
  function noteExposed(tracks) {
    if (window.Brain) flushSkips();
    exposed = new Map();
    (Array.isArray(tracks) ? tracks : []).forEach((t) => {
      const a = normArtist(t && t.artist);
      if (a) exposed.set(a, (exposed.get(a) || 0) + 1);
    });
  }

  // Call when the user plays a track picked from the results: a positive
  // signal for that artist, and it clears their exposure (engaged, not skipped).
  function notePlayed(track) {
    const a = normArtist(track && track.artist);
    if (!a) return;
    const sig = loadSignals();
    const s = sig[a] || { played: 0, skipped: 0 };
    s.played = (s.played || 0) + 1;
    s.lastTs = now();
    sig[a] = s;
    saveSignals(sig);
    exposed.delete(a);
  }

  // Call when the user leaves search or starts a new search: every exposed
  // artist that wasn't played becomes a skip.
  function flushSkips() {
    if (!exposed.size) return;
    const sig = loadSignals();
    exposed.forEach((n, a) => {
      const s = sig[a] || { played: 0, skipped: 0 };
      s.skipped = (s.skipped || 0) + n;
      s.lastTs = now();
      sig[a] = s;
    });
    exposed = new Map();
    saveSignals(sig);
  }

  // Confidence-weighted search signal: -1 (always skipped) .. +1 (always
  // played), scaled toward 0 with few samples so one stray skip can't nuke
  // an artist. Persisted — the ranking tightens across sessions.
  function searchScore(artist) {
    const s = loadSignals()[normArtist(artist)];
    if (!s) return 0;
    const total = (s.played || 0) + (s.skipped || 0);
    if (!total) return 0;
    const confidence = Math.min(total, 8) / 8;
    return ((s.played || 0) / total - 0.5) * 2 * confidence;
  }

  // PERSONALIZED SEARCH: re-rank search results by listening profile while
  // keeping YouTube's own order as the tie-breaker (stable sort). Tracks by
  // artists the user actually listens to float up; artists they keep skipping
  // in search sink; everything else keeps its natural position. Applied to
  // both live-typing suggestions and full search results.
  function rankResults(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return tracks;
    const sig = loadSignals();
    // Genre boost: artists in the user's top-3 listening genres float above
    // the same-genre-as-everyone noise, so results match taste, not just
    // YouTube's default order.
    const profileGenres = genreProfile().slice(0, 3).map((e) => e[0]);
    const inProfile = (artist) => {
      const gs = genresFor(artist);
      return !!gs && gs.some((g) => profileGenres.includes(g));
    };
    const scoreOf = (t) => {
      const artist = String((t && t.artist) || '');
      const s = sig[normArtist(artist)];
      let ss = 0;
      if (s) {
        const total = (s.played || 0) + (s.skipped || 0);
        if (total > 0) {
          const confidence = Math.min(total, 8) / 8;
          ss = ((s.played || 0) / total - 0.5) * 2 * confidence * 1.5;
        }
      }
      return affinity(artist) + ss + (inProfile(artist) ? 0.6 : 0);
    };
    return tracks
      .map((t, i) => ({ t, i, a: scoreOf(t) }))
      .sort((x, y) => (y.a - x.a) || (x.i - y.i))
      .map((s) => s.t);
  }

  /* ------------------------- genre knowledge ------------------------- */

  // Curated artist → genre dictionary: well-known artists map to the genre
  // keywords that actually return good results on YouTube Music. This is the
  // Brain's seed knowledge; everything else is LEARNED from co-occurrence.
  const ARTIST_GENRES = {
    'daft punk': ['electronic', 'dance'], 'coldplay': ['alternative', 'indie'],
    'taylor swift': ['pop', 'country'], 'adele': ['pop', 'soul'],
    'the weeknd': ['pop', 'r&b'], 'bruno mars': ['pop', 'funk'],
    'lady gaga': ['pop', 'dance'], 'ariana grande': ['pop', 'r&b'],
    'billie eilish': ['alternative', 'pop'], 'dua lipa': ['pop', 'dance'],
    'justin bieber': ['pop', 'r&b'], 'katy perry': ['pop', 'dance'],
    'sam smith': ['pop', 'soul'], 'sia': ['pop', 'soul'],
    'one direction': ['pop'], 'maroon 5': ['pop', 'pop rock'],
    'ed sheeran': ['pop', 'acoustic'], 'imagine dragons': ['alternative', 'pop rock'],
    'eminem': ['hip hop', 'rap'], 'drake': ['hip hop', 'rap'],
    'kendrick lamar': ['hip hop', 'rap'], 'j. cole': ['hip hop', 'rap'],
    'travis scott': ['hip hop', 'rap'], 'kanye west': ['hip hop', 'rap'],
    'lil nas x': ['pop', 'hip hop'], 'post malone': ['hip hop', 'pop'],
    'tyler, the creator': ['hip hop', 'alternative'], 'childish gambino': ['hip hop', 'funk'],
    'beyoncé': ['pop', 'r&b'], 'rihanna': ['pop', 'r&b'], 'sza': ['r&b', 'soul'],
    'frank ocean': ['r&b', 'soul'], 'avicii': ['electronic', 'dance'],
    'calvin harris': ['electronic', 'dance'], 'marshmello': ['electronic', 'dance'],
    'the chainsmokers': ['electronic', 'pop'], 'kygo': ['electronic', 'chill'],
    'alan walker': ['electronic', 'chill'], 'tame impala': ['indie', 'psychedelic'],
    'arctic monkeys': ['indie', 'rock'], 'twenty one pilots': ['alternative', 'indie'],
    'radiohead': ['alternative', 'indie'], 'nirvana': ['grunge', 'rock'],
    'linkin park': ['rock', 'nu metal'], 'metallica': ['metal'],
    'the beatles': ['classic rock', 'rock'], 'queen': ['classic rock', 'rock'],
    'led zeppelin': ['classic rock', 'rock'], 'pink floyd': ['classic rock', 'progressive'],
    'morgan wallen': ['country'], 'carrie underwood': ['country'],
    'luke combs': ['country'], 'bts': ['k-pop'], 'blackpink': ['k-pop'],
    'ben&ben': ['opm', 'indie'], 'eraserheads': ['opm', 'rock'],
    'rivermaya': ['opm', 'rock'], 'parokya ni edgar': ['opm', 'rock'],
    'moira dela torre': ['opm', 'pop'], 'zack tabudlo': ['opm', 'pop'],
    'harry styles': ['pop'], 'olivia rodrigo': ['pop', 'alternative'],
    'sabrina carpenter': ['pop'], 'chappell roan': ['pop', 'alternative'],
    'camila cabello': ['pop', 'latin'], 'shawn mendes': ['pop'],
    'demi lovato': ['pop'], 'miley cyrus': ['pop', 'country'], 'selena gomez': ['pop'],
    'lana del rey': ['alternative', 'pop'], 'conan gray': ['pop'], 'abba': ['pop'],
    'michael jackson': ['pop', 'funk'], 'whitney houston': ['pop', 'soul'],
    'madonna': ['pop', 'dance'], 'britney spears': ['pop', 'dance'],
    'backstreet boys': ['pop'], '*nsync': ['pop'], 'justin timberlake': ['pop', 'r&b'],
    'one republic': ['pop', 'pop rock'], 'charlie puth': ['pop'],
    'doja cat': ['pop', 'hip hop', 'r&b'], 'the 1975': ['alternative', 'indie'],
    '50 cent': ['hip hop', 'rap'], 'snoop dogg': ['hip hop', 'rap'], 'dr. dre': ['hip hop', 'rap'],
    'tupac': ['hip hop', 'rap'], 'the notorious b.i.g.': ['hip hop', 'rap'],
    'jay-z': ['hip hop', 'rap'], 'nicki minaj': ['hip hop', 'rap'],
    'megan thee stallion': ['hip hop', 'rap'], 'cardi b': ['hip hop', 'rap'],
    'lil baby': ['hip hop', 'rap'], 'future': ['hip hop', 'rap'],
    'juice wrld': ['hip hop', 'rap'], 'lil uzi vert': ['hip hop', 'rap'],
    'playboi carti': ['hip hop', 'rap'], '21 savage': ['hip hop', 'rap'],
    'mac miller': ['hip hop', 'rap'], 'big sean': ['hip hop', 'rap'],
    'usher': ['r&b', 'pop'], 'chris brown': ['r&b', 'pop'],
    'miguel': ['r&b'], 'daniel caesar': ['r&b', 'soul'], 'giveon': ['r&b', 'soul'],
    'jhene aiko': ['r&b', 'soul'], 'summer walker': ['r&b'], 'ella mai': ['r&b', 'soul'],
    'h.e.r.': ['r&b', 'soul'], 'alicia keys': ['r&b', 'soul'], 'john legend': ['r&b', 'soul'],
    'mariah carey': ['r&b', 'pop'], 'stevie wonder': ['soul', 'funk'],
    'skrillex': ['electronic', 'dance'], 'zedd': ['electronic', 'dance'],
    'martin garrix': ['electronic', 'dance'], 'david guetta': ['electronic', 'dance'],
    'tiësto': ['electronic', 'dance'], 'alesso': ['electronic', 'dance'],
    'diplo': ['electronic', 'dance'], 'major lazer': ['electronic', 'dance'],
    'odesza': ['electronic', 'chill'], 'flume': ['electronic', 'chill'],
    'disclosure': ['electronic', 'house'], 'porter robinson': ['electronic'],
    'illenium': ['electronic', 'chill'], 'gryffin': ['electronic', 'chill'],
    'muse': ['rock', 'alternative'], 'the killers': ['alternative', 'indie'],
    'green day': ['rock', 'pop punk'], 'blink-182': ['rock', 'pop punk'],
    'foo fighters': ['rock', 'alternative'], 'red hot chili peppers': ['rock', 'funk'],
    'paramore': ['alternative', 'pop rock'], 'my chemical romance': ['rock', 'alternative'],
    'panic! at the disco': ['pop', 'pop rock'], 'fall out boy': ['pop punk', 'rock'],
    'the strokes': ['indie', 'rock'], 'two door cinema club': ['indie'],
    'foster the people': ['indie', 'alternative'], 'vance joy': ['indie', 'acoustic'],
    'hozier': ['indie', 'soul'], 'glass animals': ['indie', 'alternative'],
    'bastille': ['alternative', 'indie'], 'florence + the machine': ['alternative', 'indie'],
    'fleetwood mac': ['classic rock', 'pop rock'], 'bon jovi': ['classic rock', 'rock'],
    'journey': ['classic rock'], "guns n' roses": ['classic rock', 'rock'],
    'ac/dc': ['classic rock', 'rock'], 'the rolling stones': ['classic rock', 'rock'],
    'elvis presley': ['rock', 'pop'], 'david bowie': ['classic rock', 'alternative'],
    'the eagles': ['classic rock'], 'chris stapleton': ['country', 'soul'],
    'kane brown': ['country'], 'zach bryan': ['country'], 'darius rucker': ['country'],
    'blake shelton': ['country'], 'kenny chesney': ['country'], 'johnny cash': ['country'],
    'dolly parton': ['country', 'pop'], 'shania twain': ['country', 'pop'],
    'bad bunny': ['latin', 'reggaeton'], 'j balvin': ['latin', 'reggaeton'],
    'karol g': ['latin', 'reggaeton'], 'anuel aa': ['latin', 'reggaeton'],
    'ozuna': ['latin', 'reggaeton'], 'daddy yankee': ['latin', 'reggaeton'],
    'shakira': ['latin', 'pop'], 'maluma': ['latin', 'reggaeton'],
    'rauw alejandro': ['latin', 'reggaeton'], 'rosalía': ['latin', 'flamenco'],
    'camilo': ['latin', 'pop'], 'sebastian yatra': ['latin', 'pop'],
    'twice': ['k-pop'], 'newjeans': ['k-pop'], 'stray kids': ['k-pop'],
    'seventeen': ['k-pop'], 'exo': ['k-pop'], 'aespa': ['k-pop'],
    'itzy': ['k-pop'], 'enhypen': ['k-pop'], 'red velvet': ['k-pop'],
    'burna boy': ['afrobeat'], 'wizkid': ['afrobeat', 'reggae'], 'davido': ['afrobeat'],
    'rema': ['afrobeat'], 'tems': ['afrobeat', 'r&b'], 'asake': ['afrobeat'],
    'omah lay': ['afrobeat'], 'ayra starr': ['afrobeat', 'r&b'],
    'fireboy dml': ['afrobeat'], 'tiwa savage': ['afrobeat'],
    'arthur nery': ['opm', 'pop'], 'adie': ['opm', 'pop'], 'maki': ['opm', 'pop'],
    'juan karlos': ['opm', 'rock'], 'iv of spades': ['opm', 'indie'],
    'december avenue': ['opm', 'rock'], 'silent sanctuary': ['opm', 'rock'],
    'gloc-9': ['opm', 'hip hop'], 'shanti dope': ['opm', 'hip hop'],
    'norah jones': ['jazz', 'pop'], 'michael bublé': ['jazz', 'pop'],
    'frank sinatra': ['jazz', 'classic rock'], 'louis armstrong': ['jazz'],
    'miles davis': ['jazz'], 'billie holiday': ['jazz', 'soul'],
    'ludovico einaudi': ['classical'], 'yiruma': ['classical'],
    'lang lang': ['classical'], 'yo-yo ma': ['classical'], 'andrè rieu': ['classical'],
    'bob marley': ['reggae'], 'damian marley': ['reggae'], 'sean paul': ['reggae', 'dance'],
    'shaggy': ['reggae', 'dance'], 'tarrus riley': ['reggae'], 'koffee': ['reggae'],
    'lofi girl': ['lofi'], 'chilledcow': ['lofi'], 'idevice': ['lofi'],
  };

  // FAMOUS SONGS the Brain can search for directly — timeless, recognizable
  // hits per genre. These turn "best pop songs" into ACTUAL famous songs the
  // user knows (never random uploads or hour-long mixes). Used as the final
  // fallback layer of genreSeeds + as a spice in For You seeds.
  const FAMOUS_SONGS = {
    'pop': ['ed sheeran shape of you', 'taylor swift blank space', 'katy perry fireworks',
      'bruno mars just the way you are', 'maroon 5 sugar', 'justin bieber sorry',
      'adele rolling in the deep', 'dua lipa levitating', 'the weeknd blinding lights',
      'michael jackson billie jean', 'whitney houston i will always love you',
      'harry styles as it was', 'olivia rodrigo drivers license', 'sabrina carpenter espresso'],
    'hip hop': ['kendrick lamar humble', 'drake god\'s plan', 'eminem lose yourself',
      'juice wrld lucid dreams', 'post malone rockstar', 'cardib bodak yellow',
      'lil nas x old town road', 'travis scott sicko mode', '50 cent in da club',
      'snoop dogg drop it like it\'s hot', 'jay-z empire state of mind', 'doja cat say so'],
    'rap': ['kendrick lamar humble', 'drake god\'s plan', 'eminem lose yourself',
      '2pac california love', 'the notorious b.i.g. juicy', 'future mask off',
      'lil baby freestyle', '21 savage bank account', 'megan thee stallion savage'],
    'r&b': ['the weeknd earned it', 'sza kill bill', 'usher yeah', 'chris brown with you',
      'mariah carey we belong together', 'alicia keys if i ain\'t got you',
      'daniel caesar get you', 'giveon heartbreak anniversary', 'h.e.r. damage',
      'frank ocean thinking bout you'],
    'soul': ['adele someone like you', 'sam smith stay with me', 'john legend all of me',
      'stevie wonder superstition', 'aretha franklin respect', 'alicia keys no one',
      'billie holiday strange fruit'],
    'electronic': ['avicii wake me up', 'zedd clarity', 'marshmello alone',
      'calvin harris summer', 'the chainsmokers closer', 'kygo firestone',
      'martin garrix animals', 'david guetta titanium', 'skrillex bangarang'],
    'dance': ['avicii wake me up', 'david guetta titanium', 'calvin harris one kiss',
      'major lazer lean on', 'zedd stay the night', 'tiësto red lights',
      'the chainsmokers dont let me down', 'dua lipa physical'],
    'rock': ['queen bohemian rhapsody', 'ac/dc back in black', 'guns n\' roses sweet child o mine',
      'nirvana smells like teen spirit', 'linkin park in the end', 'coldplay viva la vida',
      'imagine dragons believer', 'green day boulevard of broken dreams',
      'foo fighters everlong', 'red hot chili peppers californication'],
    'alternative': ['radiohead creep', 'the killers mr brightside', 'arctic monkeys do i wanna know',
      'twenty one pilots stressed out', 'tame impala the less i know the better',
      'muse time is running out', 'paramore misery business', 'hozier take me to church'],
    'indie': ['arctic monkeys do i wanna know', 'tame impala borderline', 'the 1975 somebody else',
      'vance joy riptide', 'glass animals heat waves', 'foster the people pumped up kicks',
      'two door cinema club what you know'],
    'country': ['morgan wallen wasted on you', 'luke combs beautiful crazy',
      'chris stapleton tennessee whiskey', 'zach bryan something in the orange',
      'johnny cash ring of fire', 'dolly parton jolene', 'carrie underwood before he cheats',
      'kane brown heaven'],
    'latin': ['bad bunny titi me preguntó', 'shakira hips don\'t lie', 'j balvin mi gente',
      'karol g tusa', 'daddy yankee gasolina', 'maluma felices los 4', 'rauw alejandro todo de ti',
      'rosalía despechá'],
    'reggaeton': ['bad bunny titi me preguntó', 'j balvin mi gente', 'karol g bichota',
      'daddy yankee con calma', 'rauw alejandro todo de ti', 'ozuna criminal'],
    'k-pop': ['bts dynamite', 'blackpink ddu-du ddu-du', 'twice the feels',
      'newjeans hype boy', 'psy gangnam style', 'stray kids thunderous', 'exo love shot'],
    'afrobeat': ['burna boy last last', 'wizkid essence', 'davido fall', 'rema calm down',
      'asake lonely at the top', 'fireboy dml peru', 'tems free mind'],
    'opm': ['ben&ben leaves', 'eraserheads ang huling el bimbo', 'rivermaya 214',
      'parokya ni edgar harana', 'moira dela torre malaya', 'arthur nery higa',
      'juan karlos ere', 'iv of spades come inside of my heart', 'december avenue sa Ngalan ng pag-ibig'],
    'reggae': ['bob marley three little birds', 'sean paul temperature', 'shaggy it wasn\'t me',
      'damian marley welcome to jamrock', 'koffee toast', 'tarrus riley she\'s royal'],
    'jazz': ['norah jones dont know why', 'michael bublé feeling good', 'frank sinatra fly me to the moon',
      'louis armstrong what a wonderful world', 'billie holiday all of me', 'miles davis so what'],
    'classical': ['ludovico einaudi nuvole bianche', 'yiruma river flows in you',
      'beethoven fur elise', 'mozart eine kleine nachtmusik', 'vivaldi four seasons',
      'pachelbel canon in d'],
    'lofi': ['lofi girl beats to relax', 'jazzhop lofi mix', 'lofi hip hop radio', 'chill lofi study mix'],
    'chill': ['kygo firestone', 'the chainsmokers closer', 'lofi beats to relax',
      'ed sheeran perfect', 'sza snooze', 'daniel caesar japanese denim'],
  };

  // Genre tag → example search queries. The Brain turns the user's top genres
  // into real, searchable phrases for the For You row and mood-style seeds.
  const GENRE_QUERIES = {
    'pop': ['best pop songs mix', 'pop hits playlist', 'new pop music'],
    'hip hop': ['hip hop mix', 'rap hits playlist', 'best hip hop songs'],
    'rap': ['rap mix', 'best rap songs'],
    'r&b': ['r&b mix', 'best r&b songs', 'rnb hits playlist'],
    'soul': ['soul music mix', 'best soul songs'],
    'electronic': ['electronic music mix', 'electronic hits playlist'],
    'dance': ['dance hits playlist', 'best dance music mix', 'party dance playlist'],
    'chill': ['chill mix', 'chill vibes playlist'],
    'lofi': ['lofi beats to study to', 'chill lofi mix', 'lofi hip hop radio'],
    'indie': ['indie mix', 'best indie songs playlist', 'indie pop hits'],
    'alternative': ['alternative rock mix', 'best alternative songs'],
    'rock': ['rock mix', 'best rock songs playlist', 'classic rock hits'],
    'classic rock': ['classic rock mix', 'best classic rock songs'],
    'metal': ['metal mix', 'best metal songs', 'heavy metal hits'],
    'country': ['country hits playlist', 'best country songs mix'],
    'latin': ['latin hits playlist', 'best latin music mix', 'reggaeton hits'],
    'reggaeton': ['reggaeton mix', 'best reggaeton songs'],
    'classical': ['classical music playlist', 'best classical pieces', 'classical piano'],
    'afrobeat': ['afrobeat mix', 'best afrobeat songs', 'afrobeats hits'],
    'reggae': ['reggae mix', 'best reggae songs', 'reggae hits playlist'],
    'k-pop': ['k-pop hits playlist', 'best k-pop songs'],
    'opm': ['opm hits playlist', 'best opm songs', 'pinoy rock mix'],
    'pop rock': ['pop rock mix', 'best pop rock songs'],
    'acoustic': ['acoustic mix', 'acoustic songs playlist'],
    'funk': ['funk mix', 'best funk songs'],
    'psychedelic': ['psychedelic rock mix'], 'progressive': ['progressive rock mix'],
    'grunge': ['grunge mix', '90s grunge hits'], 'nu metal': ['nu metal mix'],
    'jazz': ['jazz playlist', 'best jazz songs'], 'instrumental': ['instrumental music mix'],
    'synthwave': ['synthwave mix', 'synthwave playlist'], 'ambient': ['ambient music mix'],
  };

  // Display genre name → GENRE_QUERIES key. The app's genre tiles use pretty
  // labels ("Hip-Hop", "R&B"); this normalizes them to the curated keys so
  // the Brain's genre knowledge powers every tile.
  const GENRE_KEY_ALIAS = {
    'pop': 'pop', 'rock': 'rock', 'hip-hop': 'hip hop', 'hip hop': 'hip hop', 'rap': 'rap',
    'r&b': 'r&b', 'rnb': 'r&b', 'soul': 'soul', 'electronic': 'electronic', 'dance': 'dance',
    'edm': 'electronic', 'chill': 'chill', 'lofi': 'lofi', 'lo-fi': 'lofi', 'indie': 'indie',
    'alternative': 'alternative', 'alt': 'alternative', 'classic rock': 'classic rock',
    'metal': 'metal', 'heavy metal': 'metal', 'country': 'country', 'latin': 'latin',
    'reggaeton': 'reggaeton', 'classical': 'classical', 'afrobeat': 'afrobeat', 'afrobeats': 'afrobeat',
    'reggae': 'reggae', 'k-pop': 'k-pop', 'kpop': 'k-pop', 'opm': 'opm', 'pop rock': 'pop rock',
    'acoustic': 'acoustic', 'funk': 'funk', 'jazz': 'jazz', 'instrumental': 'instrumental',
    'synthwave': 'synthwave', 'ambient': 'ambient', 'grunge': 'grunge', 'nu metal': 'nu metal',
  };

  // MOODS: which genres each app mood maps to, so the Brain can seed mood
  // pages with real, searchable phrases instead of a single random string.
  const MOOD_GENRES = {
    'chill': ['chill', 'lofi'],
    'focus': ['lofi', 'instrumental', 'ambient'],
    'workout': ['dance', 'electronic', 'hip hop'],
    'party': ['dance', 'pop', 'hip hop', 'latin'],
    'night drive': ['synthwave', 'electronic', 'chill'],
    'sad hours': ['r&b', 'soul', 'acoustic'],
    'feel good': ['pop', 'dance', 'funk'],
    'sleep': ['chill', 'instrumental', 'ambient'],
  };

  // Turn a stored lowercase artist key into its display form ("the weeknd"
  // → "The Weeknd"). Simple title-case keeps the Brain's curated names
  // presentable as real search queries.
  const titleArtist = (key) => String(key || '')
    .split(/\s+/)
    .map((w) => w ? w[0].toUpperCase() + w.slice(1) : w)
    .join(' ');

  // The FAMOUS artists the Brain knows for a genre: reverse-lookups the
  // curated artist→genre dictionary + learned co-occurrence clusters, then
  // adds any currently-trending artists of that genre. These are concrete
  // names a search reliably turns into that artist's real hits — not random
  // uploads or hour-long mixes.
  function genreArtists(genre, n = 4) {
    const key = GENRE_KEY_ALIAS[String(genre || '').toLowerCase()] || String(genre || '').toLowerCase();
    const out = [];
    const push = (a) => { const d = titleArtist(a); if (d && !out.includes(d)) out.push(d); };
    const learned = loadLearned();
    // If the Brain already knows currently-trending artists for this genre,
    // reserve one slot so the freshest names surface instead of only the
    // static dictionary (which would otherwise fill the cap for big genres).
    const trending = trendingArtists(10).filter((a) => (genresFor(a) || []).includes(key));
    const curatedCap = trending.length ? Math.max(1, n - 1) : n;
    Object.keys(ARTIST_GENRES).forEach((a) => {
      if (out.length >= curatedCap) return;
      if ((ARTIST_GENRES[a] || []).includes(key)) push(a);
    });
    Object.keys(learned).forEach((a) => {
      if (out.length >= curatedCap) return;
      if ((learned[a] || []).includes(key)) push(a);
    });
    trending.forEach((a) => { if (out.length < n) push(a); });
    return out.slice(0, n);
  }

  // Does the Brain know this artist belongs to this genre? Used to filter the
  // live charts down to a genre's FAMOUS songs (chart hits by known artists).
  function artistInGenre(artist, genre) {
    const key = GENRE_KEY_ALIAS[String(genre || '').toLowerCase()] || String(genre || '').toLowerCase();
    return ((genresFor(artist) || []).includes(key));
  }

  // The genre keys a mood maps to (for chart filtering on the Moods page).
  function moodGenres(mood) {
    return MOOD_GENRES[String(mood || '').toLowerCase()] || [];
  }

  // Curated search queries for a display genre (tile label). NEVER playlist
  // phrases first — FAMOUS ARTIST NAMES lead (searching "Taylor Swift"
  // returns her actual hits), then curated phrases, then trending artists of
  // the genre, then generic fallbacks. Multi-seed so a page is never empty.
  function genreSeeds(genre, n = 4) {
    const label = String(genre || '').trim();
    const key = GENRE_KEY_ALIAS[String(label).toLowerCase()] || String(label).toLowerCase();
    const out = [];
    const push = (q) => { if (q && !out.includes(q)) out.push(q); };
    const base = Math.max(1, n - 1); // reserve one slot for currently-trending artists
    genreArtists(genre, 2).forEach(push); // famous names FIRST
    (GENRE_QUERIES[key] || []).forEach((q) => { if (out.length < base) push(q); });
    // Real, recognizable hits ("ed sheeran shape of you") before generic mixes.
    famousSongs(genre, 2).forEach(push);
    trendingArtists(8).forEach((a) => {
      if (out.length >= n) return;
      if ((genresFor(a) || []).includes(key)) push(titleArtist(a));
    });
    if (out.length < base) push(`best ${label} songs`);
    if (out.length < base) push(`${label} hits playlist`);
    if (out.length < base) push(`trending ${label} music`);
    return out.slice(0, n);
  }

  // Curated search queries for a mood (the Moods grid). Famous artists of the
  // mood's genres lead, then curated genre phrases, then label fallbacks.
  function moodSeeds(mood, n = 4) {
    const label = String(mood || '').trim();
    const key = String(label).toLowerCase();
    const out = [];
    const push = (q) => { if (q && !out.includes(q)) out.push(q); };
    (MOOD_GENRES[key] || []).forEach((g) => genreArtists(g, 1).forEach(push));
    (MOOD_GENRES[key] || []).forEach((g) => (GENRE_QUERIES[g] || []).forEach(push));
    push(`${label} music mix`);
    push(`best ${label} songs`);
    push(`relaxing ${label} playlist`);
    return out.slice(0, n);
  }

  const GENRE_KEY = 'natsirt_brain_genres'; // learned artist→genre clusters
  const loadLearned = () => cachedStore(GENRE_KEY, () => {
    try { const m = JSON.parse(localStorage.getItem(GENRE_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  });
  const saveLearned = (m) => { persist(GENRE_KEY, m); try { localStorage.setItem(GENRE_KEY, JSON.stringify(m)); } catch { /* full */ } };

  const normArtist = (a) => String(a || '').toLowerCase().trim();

  function genresFor(artist) {
    const n = normArtist(artist);
    if (ARTIST_GENRES[n]) return ARTIST_GENRES[n];
    return loadLearned()[n] || null;
  }

  /* ------------------------- related-artist clusters ------------------------- */

  // Co-occurrence clusters: every artist search (known or learned) records
  // which OTHER artists YouTube surfaced alongside — collabs, similar acts,
  // same-scene artists. Repeated co-sightings build a weighted "if you like
  // X, try Y" graph the Brain uses to reach beyond the exact artists the
  // user has played. Persisted; stale edges age out naturally via the cap.
  const REL_KEY = 'natsirt_brain_related';
  const REL_MAX = 120;   // cap stored artists
  const REL_EDGE_MAX = 8; // max related artists kept per artist

  const loadRelated = () => cachedStore(REL_KEY, () => {
    try { const m = JSON.parse(localStorage.getItem(REL_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  });
  const saveRelated = (m) => {
    try {
      const entries = Object.entries(m)
        .sort((a, b) => Object.keys(b[1] || {}).length - Object.keys(a[1] || {}).length)
        .slice(0, REL_MAX);
      persist(REL_KEY, Object.fromEntries(entries));
      localStorage.setItem(REL_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* full */ }
  };

  // Record co-occurrence between the query artist and every distinct artist
  // in the results (only when the query resolves to a real artist).
  function learnRelated(query, tracks) {
    const q = normArtist(query);
    if (!q || !tracks || !tracks.length) return;
    const rel = loadRelated();
    let changed = false;
    (Array.isArray(tracks) ? tracks : []).forEach((t) => {
      const a = normArtist(t && t.artist);
      if (!a || a === q) return;
      const cur = rel[q] || {};
      cur[a] = (cur[a] || 0) + 1;
      rel[q] = Object.fromEntries(Object.entries(cur).sort((x, y) => y[1] - x[1]).slice(0, REL_EDGE_MAX));
      changed = true;
    });
    if (changed) saveRelated(rel);
  }

  // The n most co-occurring artists with `artist`, freshest-weighted.
  function relatedArtists(artist, n = 4) {
    const edges = loadRelated()[normArtist(artist)] || {};
    return Object.entries(edges)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([a]) => titleArtist(a));
  }

  // LEARN related artists from a search: when the query matches a KNOWN (or
  // previously-learned) artist, every distinct artist in YouTube's results is
  // treated as related — it inherits the cluster's genres AND gains a
  // co-occurrence edge back to the query artist. This is YouTube's own
  // relevance data (collabs + similar acts surface in an artist's results) —
  // a cheap, robust stand-in for a fragile channel-browse endpoint.
  function learnFromSearch(query, tracks) {
    const q = normArtist(query);
    if (!tracks || !tracks.length) return;
    const srcGenres = (ARTIST_GENRES[q] || loadLearned()[q] || []);
    learnRelated(query, tracks); // co-occurrence graph grows on every search
    if (!srcGenres.length) return;
    const learned = loadLearned();
    let changed = false;
    (Array.isArray(tracks) ? tracks : []).forEach((t) => {
      const a = normArtist(t && t.artist);
      if (!a || a === q) return;
      if (ARTIST_GENRES[a] && ARTIST_GENRES[a].some((g) => srcGenres.includes(g))) return; // already clustered
      const cur = learned[a] || [];
      const merged = [...new Set([...cur, ...srcGenres])];
      if (merged.length > cur.length) { learned[a] = merged; changed = true; }
    });
    if (changed) saveLearned(learned);
  }

  // Famous, recognizable SONG queries for a genre (the curated FAMOUS_SONGS
  // map, shuffled, deduped) — concrete hits the user will know, never
  // generic mixes. `n` max queries.
  function famousSongs(genre, n = 4) {
    const key = GENRE_KEY_ALIAS[String(genre || '').toLowerCase()] || String(genre || '').toLowerCase();
    const pool = [...(FAMOUS_SONGS[key] || [])];
    const out = [];
    while (pool.length && out.length < n) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }

  // Affinity-weighted genre histogram across the top profile artists, with
  // learned co-occurrence expanding coverage beyond the curated dictionary.
  function genreProfile() {
    const hist = {};
    topArtists(8).forEach((a) => {
      const gs = genresFor(a);
      if (!gs) return;
      const w = Math.max(affinity(a), 0.5);
      gs.forEach((g) => { hist[g] = (hist[g] || 0) + w; });
    });
    return Object.entries(hist).sort((a, b) => b[1] - a[1]);
  }

  // Real search queries for the user's top n genres — what the app seeds the
  // For You row with, so recommendations cover the GENRES the user listens to
  // (not just the exact artists). Falls back to nothing if no genre is known.
  function genreQueries(n = 2) {
    const out = [];
    for (const [g] of genreProfile()) {
      const qs = GENRE_QUERIES[g];
      if (!qs) continue;
      out.push(qs[Math.floor(Math.random() * qs.length)]);
      if (out.length >= n) break;
    }
    return out;
  }

  /* ------------------------- internet trend learning ------------------------- */

  // The Brain LEARNS what the internet is playing by watching the app's own
  // live fetches: the Trending Now row and the Hot This Week chart are real
  // YouTube/YouTube Music data (not guesses), so every refresh feeds a
  // persisted "trending artists" memory — name → first/last seen + known
  // genres. Seeds and genre pages can then surface what's CURRENT, not just
  // what the curated dictionary knew at build time. Stale artists (not seen
  // for TRENDING_TTL_MS) age out, so the memory tracks the moving trend.

  const TRENDING_KEY = 'natsirt_brain_trending';
  const TRENDING_MAX = 60;          // keep at most this many artists
  const TRENDING_TTL_MS = 21 * 86400000; // forget artists unseen for 3 weeks

  const loadTrending = () => cachedStore(TRENDING_KEY, () => {
    try { const m = JSON.parse(localStorage.getItem(TRENDING_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  });
  const saveTrending = (m) => { persist(TRENDING_KEY, m); try { localStorage.setItem(TRENDING_KEY, JSON.stringify(m)); } catch { /* full */ } };

  // Feed the memory from a live trending/chart fetch. Artists seen in the
  // wild get first-seen + genres (curated or learned), refreshing on re-sight.
  function learnTrending(tracks) {
    const t = now();
    const store = loadTrending();
    let changed = false;
    (Array.isArray(tracks) ? tracks : []).forEach((tr) => {
      const a = normArtist(tr && tr.artist);
      if (!a || a === 'unknown artist') return;
      const cur = store[a];
      if (cur) {
        const wasStale = t - (cur.t || 0) >= TRENDING_TTL_MS;
        cur.t = t;
        // Backfill genres learned AFTER first sight (e.g. learnFromSearch
        // co-occurrence) so the memory keeps improving.
        if (!cur.genres || !cur.genres.length) {
          const gs = genresFor(tr.artist);
          if (gs && gs.length) { cur.genres = gs; changed = true; }
        }
        if (wasStale) changed = true; // re-sighted a stale artist → persist refresh
        return;
      }
      const gs = genresFor(tr.artist);
      store[a] = { t, genres: gs || [] };
      changed = true;
    });
    // Age out stale artists and cap the memory.
    const entries = Object.entries(store).filter(([, e]) => t - (e.t || 0) < TRENDING_TTL_MS);
    entries.sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    const trimmed = Object.fromEntries(entries.slice(0, TRENDING_MAX));
    if (changed || Object.keys(trimmed).length !== Object.keys(store).length) saveTrending(trimmed);
  }

  // The n most recently-trending artist names, freshest first.
  function trendingArtists(n = 4) {
    const t = now();
    return Object.entries(loadTrending())
      .filter(([, e]) => t - (e.t || 0) < TRENDING_TTL_MS)
      .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
      .map(([a]) => a)
      .slice(0, n);
  }

  // Search phrases for what's trending right now: the freshest artist names
  // plus a genre query for their best-known genre — concrete, current seeds.
  function trendingQueries(n = 2) {
    const t = now();
    const store = loadTrending();
    const artists = Object.entries(store)
      .filter(([, e]) => t - (e.t || 0) < TRENDING_TTL_MS)
      .sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    const out = [];
    const push = (q) => { if (q && !out.includes(q)) out.push(q); };
    artists.forEach(([a, e]) => {
      if (out.length >= n) return;
      push(a);
      if (out.length < n && e.genres && e.genres.length) {
        const qs = GENRE_QUERIES[e.genres[0]];
        if (qs) push(qs[Math.floor(Math.random() * qs.length)]);
      }
    });
    return out.slice(0, n);
  }

  /* ------------------------- song knowledge / AI assistant ------------------------- */

  // The Brain doubles as the app's AI assistant: it explains the current
  // song with real internet knowledge. Priority:
  //   1. ChatGPT (OpenAI API, if the user added a key) — a real LLM answer.
  //   2. Cyanite.ai — music-analysis DNA (genres, moods, BPM, key, energy);
  //      the track search is keyless, the full analysis needs a key.
  //   3. Wikipedia REST API — free, keyless, no account.
  //   4. Local profile knowledge — genres + why this artist fits the user.
  // All fetches are best-effort with timeouts; a failure quietly drops to
  // the next tier so the panel always says something useful.
  const AI_KEY_STORE = 'orbeat_ai_key'; // optional ChatGPT / OpenAI API key
  const AI_CACHE = 'orbeat_ai_cache';   // per-track answers (title|artist -> text)
  const AI_CACHE_MAX = 40;
  const CYANITE_KEY_STORE = 'orbeat_cyanite_key'; // optional Cyanite.ai API key
  const CYANITE_CACHE = 'orbeat_cyanite_cache';   // per-track music-DNA (title|artist -> line)

  function aiKey() {
    try { return String(localStorage.getItem(AI_KEY_STORE) || '').trim(); } catch { return ''; }
  }
  function setAiKey(k) {
    try { localStorage.setItem(AI_KEY_STORE, String(k || '').trim()); } catch { /* ignore */ }
  }
  function cyaniteKey() {
    try { return String(localStorage.getItem(CYANITE_KEY_STORE) || '').trim(); } catch { return ''; }
  }
  function setCyaniteKey(k) {
    try { localStorage.setItem(CYANITE_KEY_STORE, String(k || '').trim()); } catch { /* ignore */ }
  }

  const aiCache = () => {
    try { const c = JSON.parse(localStorage.getItem(AI_CACHE)); return c && typeof c === 'object' ? c : {}; }
    catch { return {}; }
  };
  const aiCachePut = (k, v) => {
    try {
      const c = aiCache();
      c[k] = v;
      const keys = Object.keys(c);
      if (keys.length > AI_CACHE_MAX) {
        for (const old of keys.slice(0, keys.length - AI_CACHE_MAX)) delete c[old];
      }
      localStorage.setItem(AI_CACHE, JSON.stringify(c));
    } catch { /* ignore */ }
  };

  // Fetch with a hard timeout so a hung source never wedges the assistant.
  async function aiFetch(url, opts = {}, timeoutMs = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  }

  // Clean a YouTube-ish title for Wikipedia: strip video suffixes and the
  // "ft. feature" part so the query matches a real article title.
  const cleanWikiQuery = (s) => String(s || '')
    .replace(/\(official (music )?video.*?\)/gi, '')
    .replace(/\(official.*?\)/gi, '')
    .replace(/\(.*?lyrics?.*?\)/gi, '')
    .replace(/\b(official (music )?video|lyrics?|audio)\b.*$/gi, '')
    .replace(/\bft\.?\s+.*$/i, '')
    .replace(/\bfeat\.?\s+.*$/i, '')
    .replace(/\s+/g, ' ').trim();

  // Resolve the best page title via Wikipedia's search API (CORS-open), then
  // pull its intro from the REST summary endpoint. Tries the song+artist,
  // the song alone, then the artist — so a missing song article still lands
  // on the artist's page with real info.
  async function wikiSearch(q) {
    if (!q) return null;
    const res = await aiFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const hit = j && j.query && j.query.search && j.query.search[0];
    return hit ? hit.title : null;
  }
  async function wikiSummary(title) {
    if (!title) return null;
    const res = await aiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return (j && j.extract) ? { title: j.title || title, text: j.extract } : null;
  }
  async function wikiExplain(track) {
    const name = cleanWikiQuery(track.name);
    const artist = String(track.artist || '').trim();
    const candidates = [`${name} ${artist}`, name, artist].filter(Boolean);
    for (const c of candidates) {
      try {
        const title = await wikiSearch(c);
        const s = title ? await wikiSummary(title) : null;
        if (s) return `“${s.title}” — ${s.text}`;
      } catch { /* try next candidate */ }
    }
    return null;
  }

  // ChatGPT via the OpenAI Chat Completions API. The model is the cheap
  // gpt-4o-mini tier; the key is stored locally and never leaves the device.
  // Any OpenAI-compatible key works (sk-…).
  async function chatGptExplain(track, key) {
    const prompt = `Explain the song "${track.name}" by ${track.artist || 'unknown'}: what it's about, its genre, when it came out if known, and one interesting fact. Keep it under 6 short sentences, plain text, no markdown.`;
    const res = await aiFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 220,
        temperature: 0.5,
      }),
    }, 12000);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      && j.choices[0].message.content
      ? String(j.choices[0].message.content).trim()
      : '';
    return text || null;
  }

  // Cyanite.ai — the Brain's music-DNA source. Search is keyless (matches the
  // track in their catalog by title/artist); the full audio analysis (genres,
  // moods, BPM, key, energy) unlocks with an API key. Both steps best-effort.
  async function cyaniteSearch(name, artist) {
    const term = `${name} ${artist || ''}`.trim().slice(0, 90);
    const res = await aiFetch('https://api.cyanite.ai/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query Search($data: SpotifyTrackSearchInput!) {
          spotifyTrackSearch(data: $data) {
            items { id name artists popularity durationMs }
          }
        }`,
        variables: { data: { term, limit: 5 } },
      }),
    }, 10000);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const items = j && j.data && j.data.spotifyTrackSearch && j.data.spotifyTrackSearch.items;
    if (!items || !items.length) return null;
    // Best-match: exact title wins, then title+artist closeness.
    const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tn = n(name);
    const an = n(artist);
    let best = null;
    let bestScore = -1;
    for (const it of items) {
      let score = 0;
      if (n(it.name) === tn) score += 3;
      else if (n(it.name).includes(tn) || tn.includes(n(it.name))) score += 1;
      const ha = n((it.artists || [])[0] || '');
      if (an && ha === an) score += 2;
      else if (an && (ha.includes(an) || an.includes(ha))) score += 1;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return best || items[0];
  }

  // Pull the audio analysis for a found track id. Returns the music-DNA line
  // (genres · moods · BPM · key · energy) or null.
  async function cyaniteAnalysis(id, key) {
    if (!id || !key) return null;
    const res = await aiFetch('https://api.cyanite.ai/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: `query Analysis($id: ID!) {
          track(id: $id) {
            ... on SpotifyTrack {
              audioAnalysisV7 {
                ... on AudioAnalysisV7Finished {
                  result {
                    genreTags
                    moodTags
                    bpmPrediction { value }
                    keyPrediction { value }
                    energyLevel
                  }
                }
              }
            }
          }
        }`,
        variables: { id },
      }),
    }, 12000);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const r = j && j.data && j.data.track && j.data.track.audioAnalysisV7
      && j.data.track.audioAnalysisV7.result;
    if (!r) return null;
    const bits = [];
    const gs = Array.isArray(r.genreTags) ? r.genreTags.slice(0, 5) : [];
    if (gs.length) bits.push(`genres ${gs.join(', ')}`);
    const ms = Array.isArray(r.moodTags) ? r.moodTags.slice(0, 3) : [];
    if (ms.length) bits.push(`mood ${ms.join(', ')}`);
    if (r.bpmPrediction && r.bpmPrediction.value) bits.push(`${Math.round(r.bpmPrediction.value)} BPM`);
    if (r.keyPrediction && r.keyPrediction.value) bits.push(`key ${r.keyPrediction.value}`);
    if (r.energyLevel) bits.push(`${r.energyLevel} energy`);
    if (!bits.length) return null;
    return `Cyanite music-DNA: ${bits.join(' · ')}.`;
  }

  // Keyless track search finds the track in Cyanite's catalog; the full
  // music-DNA analysis needs an API key. Without a key, Cyanite contributes
  // nothing (the catalog name is already the track playing) so Wikipedia gets
  // its turn — the analysis is what makes Cyanite a real source.
  async function cyaniteExplain(track) {
    if (!track) return null;
    const cyKey = cyaniteKey();
    if (!cyKey) return null;
    const found = await cyaniteSearch(track.name, track.artist);
    if (!found) return null;
    return await cyaniteAnalysis(found.id, cyKey);
  }

  // Local fallback: what the Brain already knows about this artist — genres
  // from the curated + learned dictionary, and why the profile likes them.
  function localExplain(track) {
    const a = track && track.artist;
    const gs = a ? genresFor(a) : null;
    const bits = [];
    if (gs && gs.length) bits.push(`Genres: ${gs.slice(0, 3).join(', ')}.`);
    const aff = a ? affinity(a) : 0;
    if (aff > 0) bits.push(`${titleArtist(a)} is one of your regular listens (${Math.round(aff)} plays of weight).`);
    if (!bits.length && track) bits.push(`“${track.name}”${a ? ` by ${a}` : ''} — no internet details available right now, but the Brain still has it queued for you.`);
    return bits.join(' ') || null;
  }

  // Teach the Brain's genre map from Cyanite's analysis: when Cyanite says a
  // track is (say) indie-pop + melancholic, that genre knowledge is real
  // audio-analysis data — feed the artist into the learned dictionary so
  // future recommendations inherit it (same store learnFromSearch uses).
  function learnGenresFromCyanite(track, line) {
    if (!track || !line) return;
    const m = line.match(/genres ([^.]+)/);
    if (!m) return;
    const a = normArtist(track.artist);
    if (!a) return;
    const gs = m[1].split(',').map((g) => g.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    if (!gs.length) return;
    const learned = loadLearned();
    const cur = learned[a] || [];
    const merged = [...new Set([...cur, ...gs])];
    if (merged.length > cur.length) { learned[a] = merged; saveLearned(learned); }
  }

  // The assistant's main entry: a friendly explanation of a track, tiered
  // ChatGPT → Cyanite → Wikipedia → local knowledge, cached per track so
  // repeat views are instant. Never throws — always returns { text, source }
  // where source is 'chatgpt' | 'cyanite' | 'wikipedia' | 'brain' (local).
  async function explainSong(track) {
    if (!track) return { text: 'No track selected yet — press play on any song.', source: 'brain' };
    const ck = `${track.name}||${track.artist}`;
    const hit = aiCache()[ck];
    if (hit) return hit;
    const key = aiKey();
    try {
      if (key) {
        const g = await chatGptExplain(track, key);
        if (g) { const o = { text: g, source: 'chatgpt' }; aiCachePut(ck, o); return o; }
      }
      const cy = await cyaniteExplain(track);
      if (cy) {
        learnGenresFromCyanite(track, cy); // Cyanite's analysis teaches the Brain
        const o = { text: cy, source: 'cyanite' }; aiCachePut(ck, o); return o;
      }
      const w = await wikiExplain(track);
      if (w) { const o = { text: w, source: 'wikipedia' }; aiCachePut(ck, o); return o; }
    } catch { /* fall through to local */ }
    const o = { text: localExplain(track) || 'No details found for this song.', source: 'brain' };
    aiCachePut(ck, o);
    return o;
  }

  return {
    // security governor
    recordOutcome, noteBlock, gap, maxConcurrent, stress, noteIntent, countOutcomesIn,
    recordIdentity, suggestIdentityStart,
    // source health + failure classification + breakage telemetry
    sourceHealthy, noteSourceOutcome, suggestSourceOrder, classifyFailure,
    noteBreakage, breakageSummary,
    // listening profile
    notePlay, affinity, topArtists, suggestSeeds, recentlyPlayedIds, isPlayed, rankResults,
    // genre knowledge
    genresFor, learnFromSearch, genreProfile, genreQueries, genreSeeds, moodSeeds,
    genreArtists, artistInGenre, moodGenres, famousSongs, relatedArtists,
    // internet trend learning
    learnTrending, trendingArtists, trendingQueries,
    // search skip learning
    noteExposed, notePlayed, flushSkips, searchScore,
    // song knowledge / AI assistant
    explainSong, aiKey, setAiKey, cyaniteKey, setCyaniteKey,
    __test: { count, outcomes: () => outcomes.map((o) => o.k) },
  };
})();
