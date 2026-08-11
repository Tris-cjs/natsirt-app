/* Natsirt Mobile — brain.js
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

  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      return p && typeof p === 'object' && p.artists ? p : { artists: {} };
    } catch { return { artists: {} }; }
  }
  const saveProfile = (p) => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* full */ } };

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

  const loadSignals = () => {
    try { const m = JSON.parse(localStorage.getItem(SIGNAL_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  };
  const saveSignals = (m) => {
    try {
      let entries = Object.entries(m);
      if (entries.length > SIGNAL_MAX) {
        entries.sort((a, b) => ((b[1].played || 0) + (b[1].skipped || 0)) - ((a[1].played || 0) + (a[1].skipped || 0)));
        m = Object.fromEntries(entries.slice(0, SIGNAL_MAX));
      }
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
      return affinity(artist) + ss;
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
    'lofi girl': ['lofi'], 'chilledcow': ['lofi'], 'idevice': ['lofi'],
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
    'metal': ['metal mix', 'best metal songs'],
    'country': ['country hits playlist', 'best country songs mix'],
    'k-pop': ['k-pop hits playlist', 'best k-pop songs'],
    'opm': ['opm hits playlist', 'best opm songs', 'pinoy rock mix'],
    'pop rock': ['pop rock mix', 'best pop rock songs'],
    'acoustic': ['acoustic mix', 'acoustic songs playlist'],
    'funk': ['funk mix', 'best funk songs'],
    'psychedelic': ['psychedelic rock mix'], 'progressive': ['progressive rock mix'],
    'grunge': ['grunge mix', '90s grunge hits'], 'nu metal': ['nu metal mix'],
    'jazz': ['jazz playlist', 'best jazz songs'], 'instrumental': ['instrumental music mix'],
  };

  const GENRE_KEY = 'natsirt_brain_genres'; // learned artist→genre clusters
  const loadLearned = () => {
    try { const m = JSON.parse(localStorage.getItem(GENRE_KEY)); return m && typeof m === 'object' ? m : {}; }
    catch { return {}; }
  };
  const saveLearned = (m) => { try { localStorage.setItem(GENRE_KEY, JSON.stringify(m)); } catch { /* full */ } };

  const normArtist = (a) => String(a || '').toLowerCase().trim();

  function genresFor(artist) {
    const n = normArtist(artist);
    if (ARTIST_GENRES[n]) return ARTIST_GENRES[n];
    return loadLearned()[n] || null;
  }

  // LEARN related artists from a search: when the query matches a KNOWN
  // artist, every distinct artist in YouTube's results is treated as related
  // and inherits the cluster's genres. This is YouTube's own relevance data
  // (collabs + similar acts surface in an artist's results) — a cheap,
  // robust stand-in for a fragile channel-browse "related artists" endpoint.
  function learnFromSearch(query, tracks) {
    const q = normArtist(query);
    if (!tracks || !tracks.length || !ARTIST_GENRES[q]) return;
    const srcGenres = ARTIST_GENRES[q];
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
    genresFor, learnFromSearch, genreProfile, genreQueries,
    // search skip learning
    noteExposed, notePlayed, flushSkips, searchScore,
    __test: { count, outcomes: () => outcomes.map((o) => o.k) },
  };
})();
