/* OrBeat Mobile — frontend logic (vanilla JS, zero deps, 100% client-side)
 *
 * Unlike the desktop/server version, nothing here talks to a backend. All
 * search/chart/streaming go through MusicEngine (engine.js), which uses your
 * Cloudflare Worker relay(s) first (search/chart/stream), falls back to
 * public mirrors, and speaks to YouTube's innertube API directly as a last
 * resort. Liked videos, playlists, listening history, and recently played
 * live entirely in localStorage.
 */
'use strict';

/* ------------------------------ helpers ------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Bind a listener to a top-level element only if it exists — a missing
// element (HTML/JS drift) must never crash the whole app at load.
const on = (sel, evt, fn) => { const el = $(sel); if (el) el.addEventListener(evt, fn); };

const fmtDur = (s) => {
  if (!s || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
};

let toastTimer = null;
// Toasts are an extension of the mini player bar: they slide up out of its
// top edge, sit flush against it (same width, same material), keep to a
// single ellipsized line, and slide back down when the cooldown ends.
// All fullscreen views (Now Playing, Album, Playlist, Genre, Queue) are
// toast-free: nothing pops up over their art/controls. Small popovers
// (context menus, action sheets) and the Home/Search/Library screens keep
// their toasts.
let hideToastTimer = null;
// Toast dismissal: when the toast lives inside the mini player, the panel
// RETRACTS and its descending top edge eats the toast (overflow clips it) —
// no fade-out. Only the standalone floating pill (player hidden) fades out.
function hideToast() {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  clearTimeout(hideToastTimer);
  // Fullscreen panel (Now Playing): the toast strip retracts UP and the box's
  // top edge clips it away — the same eat-on-retract as the mini player, so
  // the dropdown peek always ends by being eaten, never faded.
  const hostPanel = el.closest('.np');
  if (hostPanel && hostPanel.classList.contains('toast-open')) {
    hostPanel.classList.remove('toast-open');
    hideToastTimer = setTimeout(() => {
      el.classList.remove('show');
      el.hidden = true;
      hideToastTimer = null;
    }, 460);
    return;
  }
  const pl = $('#player');
  const standalone = el.classList.contains('standalone') || el.classList.contains('fullscreen');
  if (!standalone && pl) {
    // In-panel: let the player's top edge eat the toast, then clean up once
    // the height transition (0.45s) has finished clipping it away.
    pl.classList.remove('toast-open');
    hideToastTimer = setTimeout(() => {
      el.classList.remove('show');
      el.hidden = true;
      hideToastTimer = null;
    }, 480);
    return;
  }
  // Standalone pill: fade out, then hide.
  el.classList.remove('show');
  hideToastTimer = setTimeout(() => { el.hidden = true; hideToastTimer = null; }, 320);
}

function fullscreenViewOpen() {
  return ['np-backdrop', 'album-backdrop', 'plv-backdrop', 'genre-backdrop', 'queue-backdrop']
    .some((id) => { const bd = document.getElementById(id); return !!bd && !bd.hidden; });
}

// The topmost open fullscreen overlay, if any. Fullscreen views are NOT
// toast-free anymore: the toast floats INSIDE the open panel as a pill
// (same orange look as the mini player's), so like/shuffle/repeat confirm
// the same way everywhere.
function fullscreenToastHost() {
  const ids = ['np-backdrop', 'album-backdrop', 'plv-backdrop', 'genre-backdrop', 'queue-backdrop'];
  // The TOPMOST open overlay wins: album/playlist views (z60) stack over the
  // queue (z56) and Now Playing (z50) — a fixed id order can't know which of
  // several open backdrops is actually on top, and a toast must land in the
  // view the user can see, never one hidden underneath.
  let best = null;
  let bestZ = -1;
  for (const id of ids) {
    const bd = document.getElementById(id);
    if (bd && !bd.hidden) {
      const z = Number(getComputedStyle(bd).zIndex) || 0;
      if (z >= bestZ) { bestZ = z; best = bd; }
    }
  }
  return best;
}

function toast(msg, isError = false, action = null) {
  const el = $('#toast');
  clearTimeout(hideToastTimer); // a pending hide must never yank the new toast
  const fsHost = fullscreenToastHost();
  if (fsHost) {
    // Fullscreen views. Now Playing: the toast DROPS DOWN from the box's top
    // edge as a peek (see .np-dropped in style.css) instead of floating as a
    // capsule, and is eaten on retract like the mini player's. The other
    // fullscreen views (album/playlist/genre/queue) keep the compact pill.
    const panel = fsHost.id === 'np-backdrop' ? fsHost.querySelector('.np') : null;
    el.classList.remove('standalone');
    if (panel) {
      if (el.parentElement !== panel) panel.appendChild(el);
      el.classList.remove('fullscreen');
      el.classList.add('np-dropped');
      // Park the strip ABOVE the box, then re-raise it below — the start
      // state must be painted before toast-open is added, or the peek
      // transition never runs (a rapid repeat still drops every time).
      panel.classList.remove('toast-open');
    } else {
      if (el.parentElement !== fsHost) fsHost.appendChild(el);
      el.classList.remove('np-dropped');
      el.classList.add('fullscreen');
    }
    el.classList.toggle('err', isError);
    el.textContent = '';
    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = msg;
    el.appendChild(msgSpan);
    if (action && action.label && action.fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); action.fn(); });
      el.appendChild(b);
    }
    el.classList.remove('show');
    el.hidden = false;
    void el.offsetWidth; // commit the parked/hidden state — drop + fade start here
    if (panel) panel.classList.add('toast-open');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hideToast(), 1900);
    return;
  }
  // The toast IS the top section of the mini player: the panel grows UP to
  // host it (see .toast-open in style.css — the streaming line rides up with
  // the growth). When the player is hidden (no current track) the toast is
  // moved to <body> and floats standalone above the nav. Either way it fades
  // in — no fast slide.
  const pl = $('#player');
  // No panel-specific capsule/strip class may linger here — the toast is
  // back to the player (or body) now.
  el.classList.remove('np-dropped', 'fullscreen');
  const standalone = !pl || pl.hidden;
  if (standalone) {
    // Out of the (hidden) player so it can float as a pill; a fixed-position
    // element on <body> resolves against the viewport, not the player.
    if (el.parentElement !== document.body) document.body.appendChild(el);
    el.classList.add('standalone');
  } else {
    // Back inside the player so the retracting panel can eat it on dismiss.
    if (el.parentElement !== pl) pl.appendChild(el);
    el.classList.remove('standalone');
    pl.classList.add('toast-open');
  }
  el.classList.remove('show');
  el.hidden = false;
  el.textContent = '';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  el.appendChild(msgSpan);
  el.classList.toggle('err', isError);
  if (action && action.label && action.fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', (e) => { e.stopPropagation(); action.fn(); });
    el.appendChild(b);
  }
  clearTimeout(toastTimer);
  if (!el.classList.contains('show')) {
    void el.offsetWidth; // restart the fade-in
    el.classList.add('show');
  }
  toastTimer = setTimeout(() => hideToast(), 3200);
}

/* ------------------------------ state ------------------------------ */let lastPreloadAttempt = 0; // throttle for the preload safety net (8s)

const state = {
  tab: 'home',
  queue: [],          // tracks in the current list
  index: -1,          // current track position in queue
  audio: new Audio(), // primary playback element
  audio2: new Audio(),// overlap/crossfade partner (10s gapless handoff)
  activeEl: null,     // which element is currently the "now playing" one
  playingId: null,
  mseRetries: 0,      // MSE transient-failure retries used for the current track
  mseRetryFor: null,  // playingId the mseRetries budget belongs to (auto-resets)
  liked: [],          // liked videos (local)
  playlists: [],      // { id, name, tracks: [] } (local)
  searching: false,
  buffering: false,
  moreLike: null,     // { artist, track } — an active "More like this" radio seed
  shuffle: false,     // shuffle mode
  repeat: 'off',      // 'off' | 'all' | 'one'
  sleepTimer: null,   // { remaining: seconds, interval: timer }
  currentTrack: null, // the track actually playing (survives grid re-renders)
  genre: null,        // active genre chip (Home)
  homeFilter: 'all',  // Home section filter ('all' | 'trending' | 'foryou' | 'browse')
  homeRun: 0,         // token: bump to invalidate in-flight Home fetches
  userVol: 0.8,       // user volume (0..1) — crossfade ramps to this
  xfade: null,        // { fromEl, toEl, toIdx, timer } active crossfade
  preloadedVid: null, // videoId currently buffered on the partner element
  cachedBlobUrl: null, // object URL of the cached copy currently playing
};

const audio = state.audio;
const audio2 = state.audio2;
audio.preload = 'auto';
audio2.preload = 'auto';
// Helpers: which element is playing now, and its partner.
const curEl = () => state.activeEl || audio;
const otherEl = () => (curEl() === audio ? audio2 : audio);
state.activeEl = audio;

/* ------------------------------ listening history (local) ------------------------------ */

const HIST_KEY = 'natsirt_history';
const PLAYS_KEY = 'natsirt_plays';
const LIKED_KEY = 'natsirt_liked';
const PLAYLISTS_KEY = 'natsirt_playlists';

const getHist = () => { try { const h = JSON.parse(localStorage.getItem(HIST_KEY)); return Array.isArray(h) ? h : []; } catch { return []; } };
const saveHist = (h) => localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 8)));
const getPlays = () => { try { const p = JSON.parse(localStorage.getItem(PLAYS_KEY)); return Array.isArray(p) ? p : []; } catch { return []; } };
const savePlays = (p) => localStorage.setItem(PLAYS_KEY, JSON.stringify(p.slice(0, 60)));
const getLiked = () => state.liked;
const saveLiked = (l) => { state.liked = l; localStorage.setItem(LIKED_KEY, JSON.stringify(l)); renderLiked(); renderLibrary(); };
const getPlaylists = () => state.playlists;
const savePlaylists = (p) => { state.playlists = p; localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(p)); renderPlaylists(); renderLibrary(); };

function recordSearch(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const h = getHist().filter((x) => x.toLowerCase() !== q.toLowerCase());
  h.unshift(q);
  saveHist(h);
}

function recordPlay(track) {
  if (!track || !track.id) return;
  const rec = {
    id: track.id,
    name: track.name,
    artist: track.artist,
    cover: track.cover || '',
    source: track.source || '',
    videoId: track.videoId || '',
    audioUrl: track.audioUrl || '',
    fileUrl: track.fileUrl || track.url || '',
    license: track.license || '',
    duration: track.duration || 0,
    searchQuery: track.searchQuery || '',
  };
  const plays = getPlays().filter((p) => p.id !== track.id);
  plays.unshift(rec);
  savePlays(plays);
  // Feed the Brain's listening profile (recency-weighted artist affinities)
  // so For You suggestions improve with every play.
  if (window.Brain) Brain.notePlay(track);
  // Listening to a different artist ends an active "More like this" radio.
  if (state.moreLike && track.artist && track.artist !== state.moreLike.artist) {
    state.moreLike = null;
    loadForYou();
  }
  renderRecently();
}

/* -------- liked videos + playlists (local) -------- */

const ICON_HEART = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 21s-6.7-4.3-9.3-8.1C.9 10.2 1.6 6.8 4.4 5.4 6.6 4.2 9.1 5 10.6 6.8L12 8.3l1.4-1.5c1.5-1.8 4-2.6 6.2-1.4 2.8 1.4 3.5 4.8 1.7 7.5C18.7 16.7 12 21 12 21z"/></svg>';
const ICON_HEART_FILL = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#ff6a00" d="M12 21s-6.7-4.3-9.3-8.1C.9 10.2 1.6 6.8 4.4 5.4 6.6 4.2 9.1 5 10.6 6.8L12 8.3l1.4-1.5c1.5-1.8 4-2.6 6.2-1.4 2.8 1.4 3.5 4.8 1.7 7.5C18.7 16.7 12 21 12 21z"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';

function likedRecord(track) {
  return {
    id: track.id,
    name: track.name,
    artist: track.artist,
    cover: track.cover || '',
    source: track.source || '',
    videoId: track.videoId || '',
    audioUrl: track.audioUrl || '',
    fileUrl: track.fileUrl || track.url || '',
    duration: track.duration || 0,
    searchQuery: track.searchQuery || '',
    likedAt: Date.now(),
  };
}

function isLiked(id) { return getLiked().some((l) => l.id === id); }

function toggleLike(track) {
  const liked = getLiked();
  const nowLiked = !isLiked(track.id);
  if (nowLiked) {
    saveLiked([likedRecord(track), ...liked]);
  } else {
    saveLiked(liked.filter((l) => l.id !== track.id));
  }
  // One toast everywhere — mini player, Now Playing, queue view — same
  // messages, same orange pill. In Now Playing the heart also pops.
  toast(nowLiked ? `Liked “${track.name}”` : `Removed “${track.name}” from liked videos`);
  if (npIsOpen()) popNpLike();
  updatePlayingCards(); // saveLiked already re-rendered the drawer; refresh hearts
  updateNpLike(); // the now-playing heart stays in sync from every surface
}

function createPlaylist(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const pl = { id: `pl_${Date.now()}`, name: n, tracks: [] };
  savePlaylists([...getPlaylists(), pl]);
  return pl;
}

function addToPlaylist(track, plId) {
  const pls = getPlaylists();
  const pl = pls.find((p) => p.id === plId);
  if (!pl) return;
  if (pl.tracks.some((t) => t.id === track.id)) {
    if (npIsOpen()) npFlash(`Already in “${pl.name}”`, ICON_PLUS);
    else toast(`Already in “${pl.name}”`);
    return;
  }
  pl.tracks.push(likedRecord(track));
  savePlaylists(pls);
  if (npIsOpen()) npFlash(`Added to “${pl.name}”`, ICON_PLUS);
  else toast(`Added to “${pl.name}”`);
  renderPlaylists();
}

// Add a whole album/playlist to a user playlist. Resolves the album's tracks
// (MusicEngine.albumTracks is memoized, so an already-opened album resolves
// instantly) and merges them, skipping dupes. `album.__tracks` short-circuits
// the resolve — used by the playlist view, which already has the track list.
async function addAlbumToPlaylist(album, plId) {
  const pl = getPlaylists().find((p) => p.id === plId);
  if (!pl) return;
  let tracks;
  if (album.__tracks && album.__tracks.length) {
    tracks = album.__tracks;
  } else {
    toast('Loading album tracks…');
    try {
      tracks = await MusicEngine.albumTracks(album.artist || '', album.browseId || '');
    } catch (e) {
      toast(`Couldn't load “${album.name}”: ${esc(e.message)}`, true);
      return;
    }
  }
  if (!tracks || !tracks.length) { toast(`No tracks found for “${album.name}”.`, true); return; }
  let added = 0;
  for (const t of tracks) {
    if (pl.tracks.some((x) => x.id === t.id)) continue;
    pl.tracks.push(likedRecord(t));
    added++;
  }
  savePlaylists(getPlaylists());
  toast(added ? `Added ${added} track${added === 1 ? '' : 's'} to “${pl.name}”` : `Already in “${pl.name}”`);
}

function removeFromPlaylist(plId, trackId) {
  const pls = getPlaylists();
  const pl = pls.find((p) => p.id === plId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
  savePlaylists(pls);
  renderPlaylists();
}

function deletePlaylist(plId) {
  const pls = getPlaylists().filter((p) => p.id !== plId);
  savePlaylists(pls);
  toast('Playlist deleted');
}

function playList(tracks, i) {
  if (!tracks || !tracks.length) return;
  playTrackAt(i || 0, tracks);
}

// Live suggestions in the Search tab, Spotify-style: a small set of rows
// mixing actual tracks and playlists for the partial query, playable on tap.
// Two modes:
//   • idle (empty field) → the tracks you tapped recently (jump back in)
//   • while typing       → up to 5 items: interleaved songs + playlists
// No floating dropdown anymore — the suggestions are an inline section of
// the Search tab that lives below the search bar (no focus/blur juggling).
let suggestTimer = null;
let suggestRun = 0;

// Cleanup when the search bar loses focus or the tab is left: restore the
// mini player + bottom nav and let Browse all return when the field is empty.
// The suggestions/results stay on screen — they're part of the tab now.
function hideSearchSuggestions() {
  $('#search-clear').hidden = !$('#search-input').value.trim();
  updateSearchBrowse(); // empty field → Browse all returns
  refreshPlayerVisibility(); // bring the mini player back
  const nav = $('#bottom-nav');
  if (nav) nav.hidden = false;
}

// Text-only title suggestions above the tappable songs: recent searches that
// match the typed query first, filled with top result titles. Tapping one
// fills the bar and runs that search (YouTube-style "search as" row).
function renderTitles(query, items) {
  const titlesEl = $('#history-titles');
  if (!titlesEl) return;
  titlesEl.innerHTML = '';
  const q = String(query || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const h of getHist()) {
    if (out.length >= 4) break;
    const lh = String(h || '').toLowerCase();
    if (q && !lh.includes(q)) continue;
    if (seen.has(lh)) continue;
    seen.add(lh);
    out.push(h);
  }
  for (const t of items || []) {
    if (out.length >= 4) break;
    const n = String(t && t.name || '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  out.slice(0, 4).forEach((title) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sugg sugg-title';
    el.innerHTML = `<span class="sugg-search-ic"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg></span><span class="sugg-t-name">${esc(title)}</span>`;
    el.addEventListener('click', () => {
      const input = $('#search-input');
      input.value = title;
      runSearch(title);
    });
    titlesEl.appendChild(el);
  });
  titlesEl.hidden = !out.length;
}

function renderSuggestions(items) {
  const row = $('#history-row');
  const chips = $('#history-chips');
  const labelEl = $('#history-label');
  // The idle dropdown shows recently played — label it. While typing it's
  // live search matches, so the label drops out.
  const q = $('#search-input').value.trim();
  if (labelEl) labelEl.textContent = q ? '' : 'Recently played';
  renderTitles($('#search-input').value.trim(), items);
  chips.innerHTML = '';
  (items || []).slice(0, 5).forEach((t) => {
    const isPlaylist = !!t.browseId && t.source === 'playlist';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sugg';
    el.innerHTML = `
      <span class="sugg-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</span>'" />` : `<span class="noimg logo-fallback">${LOGO_FB}</span>`}</span>
      <span class="sugg-meta">
        <span class="sugg-name">${esc(t.name)}</span>
        <span class="sugg-artist">${esc(isPlaylist ? albumCardArtist(t) : (t.artist || 'Unknown artist'))}</span>
      </span>
      <span class="sugg-kind">${isPlaylist ? 'Playlist' : 'Song'}</span>`;
    el.addEventListener('click', () => {
      if (isPlaylist) {
        // A playlist suggestion opens the full album/playlist view.
        openAlbumView(t);
      } else {
        $('#search-input').value = t.name;
        // Tapping a song suggestion plays that exact song, with the other
        // suggested songs as the queue so Next/Prev keep you in context.
        if (window.Brain && Brain.notePlayed) Brain.notePlayed(t);
        const songs = (items || []).filter((x) => x && x.id && !(x.browseId && x.source === 'playlist'));
        playTrackAt(0, [t, ...songs.filter((x) => x.id !== t.id)]);
      }
    });
    chips.appendChild(el);
  });
  // Inline section of the Search tab — visible while the tab is active,
  // regardless of focus (no more dropdown show/hide).
  row.hidden = !(state.tab === 'search' && items && items.length > 0);
  $('#search-clear').hidden = !$('#search-input').value.trim();
}

// Instantly match the partial query against LOCAL data (recently played +
// liked + offline tracks) — zero network. These paint the dropdown on the
// very first keystroke; the network fetch below replaces them with fresh
// YouTube results a moment later.
function localSuggestions(q) {
  const lq = String(q || '').trim().toLowerCase();
  if (!lq) return [];
  const seen = new Map();
  const hit = (t) => {
    if (!t || !t.name) return;
    if (seen.has(t.id)) return;
    const hay = `${t.name} ${t.artist || ''} ${t.album || ''}`.toLowerCase();
    if (!hay.includes(lq)) return;
    seen.set(t.id, t);
  };
  getPlays().forEach(hit);
  getLiked().forEach(hit);
  return [...seen.values()].slice(0, 5);
}

// Placeholder while the network fetch is in flight and nothing local matched —
// keeps the dropdown visible (no blink) until fresh results replace it.
function renderSearchingRow() {
  const row = $('#history-row');
  const titlesEl = $('#history-titles');
  const chips = $('#history-chips');
  if (titlesEl) { titlesEl.innerHTML = ''; titlesEl.hidden = true; }
  chips.innerHTML = '<button type="button" class="sugg sugg-searching" disabled><span class="sugg-meta"><span class="sugg-name" style="color:#8a8a8a">Searching…</span></span></button>';
  row.hidden = state.tab !== 'search';
}

/* ----- suggestion cache: search feels instant on repeats ----- */
// Every live-typing fetch stores its mixed payload (songs + playlists) in
// localStorage. A repeat visit to the SAME query — or any PREFIX of a query
// we've already answered ("tay" → "taylor swift"'s results) — renders with
// zero network wait, then refreshes in the background. Cap keeps storage sane.
const SUGG_KEY = 'natsirt_sugg_cache';
const SUGG_MAX = 80;
const SUGG_TTL_MS = 24 * 3600 * 1000;

function suggCacheAll() {
  try { const m = JSON.parse(localStorage.getItem(SUGG_KEY)); return m && typeof m === 'object' ? m : {}; }
  catch { return {}; }
}

function suggCacheSet(q, data) {
  try {
    const m = suggCacheAll();
    m[String(q || '').toLowerCase().trim()] = { at: Date.now(), tracks: (data.tracks || []).slice(0, 8), playlists: (data.playlists || []).slice(0, 4) };
    // Keep the most recent entries (insertion order = freshness).
    const entries = Object.entries(m).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, SUGG_MAX);
    localStorage.setItem(SUGG_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* quota — best-effort */ }
}

// Exact query match wins; otherwise a cached query that STARTS with the typed
// prefix fills in (so partial typing still gets results instantly).
function suggCacheGet(q) {
  const key = String(q || '').toLowerCase().trim();
  if (!key) return null;
  const m = suggCacheAll();
  const now = Date.now();
  const fresh = (e) => e && e.at && now - e.at < SUGG_TTL_MS && ((e.tracks && e.tracks.length) || (e.playlists && e.playlists.length));
  if (fresh(m[key])) return m[key];
  // Prefix match: the cached query must CONTAIN the typed prefix (not just
  // start with it — "weeknd hits" typing "nd hits" still lands).
  for (const k of Object.keys(m)) {
    if (k.includes(key) && fresh(m[k])) return m[k];
  }
  return null;
}

// Interleave songs and playlists (song, playlist, song, …) up to `max` —
// shared by the live path and the cache-hit path so both mix identically.
function mixSuggestions(tracks, playlists, max) {
  const songQ = [...(tracks || [])];
  const plQ = [...(playlists || [])];
  const mixed = [];
  for (let i = 0; i < max && (songQ.length || plQ.length); i++) {
    if (i % 2 === 0 && songQ.length) mixed.push(songQ.shift());
    else if (i % 2 === 1 && plQ.length) mixed.push(plQ.shift());
    else if (songQ.length) mixed.push(songQ.shift());
    else mixed.push(plQ.shift());
  }
  return mixed;
}

// Live search while typing — the whole Search tab updates as one flow, no
// dropdown: local + cached matches paint instantly on every keystroke, and the
// debounced network fetch swaps in full results — suggestions, the songs list,
// the playlists shelf and the "More on <artist>" section — together.
function refreshLiveSuggestions(q) {
  clearTimeout(suggestTimer);
  const run = ++suggestRun;
  if (!q.trim()) {
    // Empty field: recently-played suggestions only; clear stale results.
    renderSuggestions(getPlays().slice(0, 5));
    $('#grid').hidden = true;
    $('#empty').hidden = true;
    $('#search-playlists').hidden = true;
    $('#search-more').hidden = true;
    updateSearchBrowse();
    return;
  }
  // Instant layer: locally-matching tracks appear immediately; if none match,
  // a cached payload for this query (or a prefix of it) paints instantly too —
  // the tab never blinks on "Searching…" for a query we've already seen.
  const local = localSuggestions(q);
  if (local.length) renderSuggestions(local);
  else {
    const cached = suggCacheGet(q);
    const cachedMixed = cached ? mixSuggestions(cached.tracks, cached.playlists, 5) : [];
    if (cachedMixed.length) renderSuggestions(cachedMixed);
    else renderSearchingRow();
  }
  suggestTimer = setTimeout(async () => {
    try {
      // Fetch songs + matching playlists in parallel for a Spotify-style mix.
      const [tracks, playlists] = await Promise.all([
        MusicEngine.search(q.trim(), 30, { noVersions: true }).catch(() => []),
        MusicEngine.playlistSearch(q.trim(), 6).catch(() => []),
      ]);
      if (run !== suggestRun || state.tab !== 'search') return;
      // Personalize the songs by the same profile-aware ranking.
      const ranked = ((window.Brain && Brain.rankResults) ? Brain.rankResults(tracks) : tracks) || [];
      const pls = (playlists || []).filter((p) => p && p.browseId);
      // Remember this payload — the next visit (or a prefix of it) renders
      // instantly from the cache while the network refreshes.
      suggCacheSet(q.trim(), { tracks: ranked.slice(0, 8), playlists: pls.slice(0, 4) });
      // Learn related artists / genres from this search (co-occurrence).
      if (window.Brain && Brain.learnFromSearch) Brain.learnFromSearch(q.trim(), ranked);
      // The full Search tab, live: songs list + playlists shelf + More on.
      if (ranked.length) renderSearchResults(ranked);
      else showEmpty(`No results for “${esc(q.trim())}”.`);
      if (pls.length) loadSearchPlaylists(q.trim());
      renderSearchMore(ranked);
      // Suggestions: the mixed rows on top (fresh wins; fall back to local).
      const mixed = mixSuggestions(ranked, pls, 5);
      if (mixed.length) renderSuggestions(mixed);
      else {
        const local = localSuggestions(q.trim());
        if (local.length) renderSuggestions(local);
        else $('#history-row').hidden = true;
      }
    } catch {
      // Network failed — keep the local/cached matches already on screen.
      const local = localSuggestions(q.trim());
      if (!local.length) $('#history-row').hidden = true;
    }
  }, 180);
}

/* ------------------------------ tabs ------------------------------ */

// The mini player stays visible on every tab (Home, Moods, Search) while a
// track is playing — like Spotify, it never disappears during Search. It only
// hides when the session has nothing loaded yet.
function refreshPlayerVisibility() {
  // While the Now Playing box is open, the mini player is INSIDE it (the box
  // grew out of the bar) — the separate bar must stay hidden underneath.
  const npOpen = $('#np-backdrop') && !$('#np-backdrop').hidden;
  const show = !!state.currentTrack && !npOpen;
  const p = $('#player');
  if (!p) return; // missing element (HTML/JS drift) must never crash
  p.hidden = !show;
  if (show && state.currentTrack) {
    requestAnimationFrame(() => setPlayerTitle(state.currentTrack.name));
  }
  updateNowPlayingBar(); // Home-only top bar follows the same visibility rules
}

function switchTab(tab) {
  state.tab = tab;
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const isHome = tab === 'home';
  const isSearch = tab === 'search';
  const isLibrary = tab === 'library';
  $('#home-view').hidden = !isHome;
  $('#search-view').hidden = !isSearch;
  $('#library-view').hidden = !isLibrary;
  const content = $('#content');
  if (content) {
    content.dataset.tab = tab; // drives the per-page background + top fade
    content.scrollTop = 0;      // Spotify resets the scroll on tab switch
  }
  // Leaving search mode: hide the suggestions panel + close the keyboard.
  if (!isSearch) {
    // Any exposed-but-unplayed results become skips (learn from what the
    // user saw and didn't pick before moving on).
    if (window.Brain && Brain.flushSkips) Brain.flushSkips();
    $('#history-row').hidden = true;
    $('#search-clear').hidden = true;
    if (document.activeElement === $('#search-input')) $('#search-input').blur();
    // The nav can't be hidden while you're navigating tabs.
    const nav = $('#bottom-nav');
    if (nav) nav.hidden = false;
  }
  refreshPlayerVisibility();
  saveSession();
  if (isHome) {
    loadHome();
  } else if (isSearch) {
    const q = $('#search-input').value.trim();
    $('#search-clear').hidden = !q;
    if (!q) { $('#empty').hidden = true; $('#grid').hidden = true; } // the Browse-all grid owns the idle space
    refreshLiveSuggestions(q);
    renderSearchBrowse();
    updateSearchBrowse();
  } else if (isLibrary) {
    openLibrary();
  }
}

on('#bottom-nav', 'click', (e) => {
  const btn = e.target.closest('.nav-tab');
  if (!btn) return;
  switchTab(btn.dataset.tab);
  // Spotify-style: tapping the Search tab opens the keyboard right away.
  if (btn.dataset.tab === 'search') $('#search-input').focus();
});

/* ------------------------------ home filter chips ------------------------------ */

// Spotify-style Home filters (orange pill when active). Pure CSS does the
// hiding via [data-home-filter] on #content, so in-flight row loads can never
// fight the filter.
const HOME_FILTERS = ['all', 'trending', 'foryou', 'browse'];
function applyHomeFilter(f) {
  state.homeFilter = HOME_FILTERS.includes(f) ? f : 'all';
  const content = $('#content');
  if (content) content.dataset.homeFilter = state.homeFilter;
  $$('.home-chip').forEach((c) => c.classList.toggle('active', c.dataset.homeFilter === state.homeFilter));
}

on('#home-chips', 'click', (e) => {
  const chip = e.target.closest('.home-chip');
  if (chip) applyHomeFilter(chip.dataset.homeFilter);
});

/* ------------------------------ grid ------------------------------ */

function showEmpty(text, spinner = false) {
  $('#empty').hidden = false;
  $('#grid').hidden = true;
  $('#empty-text').innerHTML = spinner ? '<div class="spinner"></div>' : '';
  if (!spinner) $('#empty-text').append(text);
}

function hideEmpty() {
  $('#empty').hidden = true;
  $('#grid').hidden = false;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function licenseLabel(track) {
  // This is a music app and every card is a YouTube song — the "▶ YouTube"
  // badge was noise. Keep a badge only for real licenses (CC tracks).
  if (track.license) return track.license.replace('https://creativecommons.org/licenses/', 'CC ').replace(/\d\.\d\/?$/, '').replace(/-/g, '-').toUpperCase();
  return '';
}

// Prefer the full-resolution YouTube art (maxresdefault — the real album
// cover) over the 480px hqdefault fallback for regular video thumbnails.
function upscaleCover(url) {
  if (!url) return '';
  const m = /i\.ytimg\.com\/vi\/([A-Za-z0-9_-]+)\/(?:hqdefault|mqdefault|sddefault)\.jpg/.exec(url);
  return m ? `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg` : url;
}

// HD art for the big fullscreen covers (Now Playing / Album / Playlist).
// Google's image CDN (lh3/yt3.googleusercontent.com) re-renders on demand:
// the covers the engine stores are only 120-544px (some auto-generated topic
// tracks ship just a 120px render), so ask for a full 1080px render — the CDN
// returns the largest available when the source itself is smaller, so this
// never regresses. YouTube thumbs get the maxresdefault treatment as before.
function upscaleArtHD(url) {
  if (!url) return '';
  const g = /=(w\d+(?:-h\d+)?|s\d+)((?:-[a-z0-9]+)*)$/.exec(url);
  if (g) return url.slice(0, g.index) + '=w1080-h1080' + g[2];
  return upscaleCover(url);
}

// OrBeat logo fallback shown wherever cover art is missing or fails to load
// (songs, albums, playlists, queue rows, library tiles).
const LOGO_FB = '<img class="logo-fb" src="./logo.png" alt="OrBeat" />';
// HTML-attribute-escaped twin for inline onerror strings.
const LOGO_FB_ATTR = '<img class=&quot;logo-fb&quot; src=&quot;/logo.png&quot; alt=&quot;OrBeat&quot;/>';

function coverHtml(track, cls) {
  const orig = track.cover || '';
  const src = upscaleCover(orig);
  if (src) {
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" data-orig="${esc(orig)}" onerror="if(!this.dataset.fb){this.dataset.fb='1';this.src=this.dataset.orig}else{this.outerHTML='<div class=&quot;${cls} noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'}" />`;
  }
  return `<div class="${cls} noimg logo-fallback">${LOGO_FB}</div>`;
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2.5c.7 4.6 3.4 7.3 8 8-4.6.7-7.3 3.4-8 8-.7-4.6-3.4-7.3-8-8 4.6-.7 7.3-3.4 8-8z"/></svg>';

// Build one track card. `list` is the track array this card belongs to.
function makeCard(track, list) {
  const liked = isLiked(track.id);
  const lic = licenseLabel(track);
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = track.id;
  card.dataset.name = track.name;
  // Direct reference to the track + its list so long-press / ctx menus work
  // even for rows that aren't in a tracked list (e.g. Home trending cards).
  card._track = track;
  card._list = list;
  card.innerHTML = `
    <div class="card-cover-wrap">
      ${coverHtml(track, 'card-cover')}
      ${lic ? `<span class="badge-license">${esc(lic)}</span>` : ''}
      <div class="eq" aria-hidden="true" hidden><span></span><span></span><span></span></div>
      <div class="cover-actions">
        <button class="cov-btn like ${liked ? 'liked' : ''}" data-act="like" title="${liked ? 'Unlike' : 'Like'}">${liked ? ICON_HEART_FILL : ICON_HEART}</button>
        <button class="cov-btn" data-act="plist" title="Add to playlist">${ICON_PLUS}</button>
        <button class="cov-btn" data-act="more" title="More like this">${ICON_MORE}</button>
      </div>
      <button class="cov-btn dl-top" data-act="dl" data-vid="${esc(track.videoId || '')}" title="Download for offline">${ICON_DL}</button>
      <div class="play-overlay">
        <button class="circle" data-act="play" title="Play">${ICON_PLAY}</button>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title" title="${esc(track.name)}">${esc(track.name)}</div>
      <div class="card-artist" title="${esc(track.artist)}">${esc(track.artist)}</div>
    </div>`;
  // Clicking the already-playing card toggles pause/resume (its icon flips
  // to a pause button while playing, so the tap must match); any other card
  // starts its track.
  const cardPlay = () => {
    if (track.id === state.playingId) {
      const el = curEl();
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      return;
    }
    playTrackAt(list.indexOf(track), list);
  };
  card.querySelector('[data-act="play"]').addEventListener('click', cardPlay);
  // Desktop double-click and touch double-tap both fire dblclick; single-click
  // already plays, so ignore the second fire to avoid restarting the song.
  card.addEventListener('dblclick', () => {
    if (state.playingId !== track.id) playTrackAt(list.indexOf(track), list);
  });
  // Mobile: the whole card is a play button (touch-first). Buttons inside
  // (like / playlist / more / play) handle their own clicks — don't double-fire.
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    cardPlay();
  });
  card.querySelector('[data-act="like"]').addEventListener('click', () => toggleLike(track));
  card.querySelector('[data-act="plist"]').addEventListener('click', (e) => openPlaylistPicker(track, e.target));
  const more = card.querySelector('[data-act="more"]');
  if (more) more.addEventListener('click', () => moreLikeThis(track));
  const dlBtn = card.querySelector('[data-act="dl"]');
  if (dlBtn) dlBtn.addEventListener('click', () => dlTrack(track, dlBtn));
  // Reflect the offline state on this fresh card immediately.
  if (dlBtn && window.OfflineCache) {
    const vid = track.videoId || '';
    if (OfflineCache.hasSync(vid)) {
      dlBtn.classList.add('done');
      dlBtn.innerHTML = ICON_DL_DONE;
      dlBtn.title = 'Saved for offline — tap to remove';
    }
  }
  return card;
}



// Strip Indian music + duplicate ids from a recommendation list (MusicEngine
// returns everything; this keeps the rows to international / PH popular music).
function trimRecommendations(tracks) {
  const seen = new Map();
  (tracks || []).forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
  return [...seen.values()].filter((t) => !MusicEngine.isIndianTrack(t));
}

// "More like this" — seed the For You row with a single artist and jump to it.
function moreLikeThis(track) {
  const artist = String(track.artist || '').trim();
  if (!artist || artist === 'Unknown artist') {
    toast('No artist info for this track', true);
    return;
  }
  state.moreLike = { artist, track: track.name };
  toast(`Finding more like ${artist}…`);
  switchTab('home');
  (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const sec = $('#foryou');
      if (!sec.hidden) {
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    toast(`Couldn't find more like ${artist} — try another track.`, true);
  })();
}

// Shimmer placeholder cards shown while a Home row / grid fetches its tracks.
// `opts.circle` → artist-avatar row; `opts.grid` → bare cards (grid parents
// lay them out); `opts.list` → track rows for the album overlay.
function skeletonRow(count = 6, opts = {}) {
  const { circle = false, grid = false, list = false } = opts;
  if (list) {
    let html = '<div class="skel-list">';
    for (let i = 0; i < count; i++) {
      html += '<div class="skel-track"><span class="skel skel-cover"></span><span class="skel skel-line"></span></div>';
    }
    return html + '</div>';
  }
  const cards = [];
  for (let i = 0; i < count; i++) {
    cards.push('<div class="skel-card"><div class="skel skel-cover"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>');
  }
  if (grid) return cards.join('');
  return `<div class="skel-row${circle ? ' circles' : ''}">${cards.join('')}</div>`;
}

// Highlight the currently-playing card + refresh like hearts.
function updatePlayingCards() {
  const playing = state.playingId;
  $$('.card').forEach((c) => {
    const isPlaying = !!playing && c.dataset.id === playing;
    c.classList.toggle('playing', isPlaying);
    const eq = c.querySelector('.eq');
    if (eq) eq.hidden = !isPlaying;
    const btn = c.querySelector('[data-act="play"]');
    if (btn) btn.innerHTML = isPlaying && (EmbedPlay.isActive() ? EmbedPlay.isPlaying() : !curEl().paused) ? ICON_PAUSE : ICON_PLAY;
    const likeBtn = c.querySelector('[data-act="like"]');
    if (likeBtn) {
      const liked = isLiked(c.dataset.id);
      likeBtn.classList.toggle('liked', liked);
      likeBtn.innerHTML = liked ? ICON_HEART_FILL : ICON_HEART;
      likeBtn.title = liked ? 'Unlike' : 'Like';
    }
    // The playing card's title scrolls as a slow marquee; others stay static.
    syncRowMarquee(c.querySelector('.card-title'), c.dataset.name || '', isPlaying);
  });
  $$('.lib-item').forEach((li) => {
    const isPlaying = !!playing && li.dataset.id === playing;
    li.classList.toggle('playing', isPlaying);
    const eq = li.querySelector('.lib-cover .eq');
    if (eq) eq.hidden = !isPlaying;
    const nm = li.querySelector('.meta .t');
    syncRowMarquee(nm, li.dataset.name || (nm ? nm.textContent : '') || '', isPlaying);
  });
  $$('.queue-item').forEach((qi) => {
    const isPlaying = !!playing && qi.dataset.id === playing;
    qi.classList.toggle('playing', isPlaying);
    const eq = qi.querySelector('.eq');
    if (eq) eq.hidden = !isPlaying;
    const nm = qi.querySelector('.queue-item-title');
    syncRowMarquee(nm, qi.dataset.name || (nm ? nm.textContent : '') || '', isPlaying);
  });
  $$('.search-item').forEach((si) => {
    const isPlaying = !!playing && si.dataset.id === playing;
    si.classList.toggle('playing', isPlaying);
    const nm = si.querySelector('.si-name');
    syncRowMarquee(nm, si.dataset.name || (nm ? nm.textContent : '') || '', isPlaying);
  });
  $$('.rec-card').forEach((rc) => {
    const isPlaying = !!playing && rc.dataset.id === playing;
    rc.classList.toggle('playing', isPlaying);
    const nm = rc.querySelector('.rec-name');
    syncRowMarquee(nm, rc.dataset.name || (nm ? nm.textContent : '') || '', isPlaying);
  });
  $$('#album-tracks .album-track, #plv-tracks .album-track').forEach((at) => {
    const isPlaying = !!playing && at.dataset.id === playing;
    at.classList.toggle('playing', isPlaying);
    const eq = at.querySelector('.eq');
    if (eq) eq.hidden = !isPlaying;
    const nm = at.querySelector('.t-name');
    syncRowMarquee(nm, at.dataset.name || (nm ? nm.textContent : '') || '', isPlaying);
  });
  if (window.OfflineCache) refreshDownloadButtons();
  // If the Queue page is open, keep its Now Playing / Next Up split in sync
  // when the track changes (next/prev/auto-advance/reorder). Guarded by the
  // playing id so play/pause/like toggles don't re-render the whole list.
  const qbd = $('#queue-backdrop');
  if (qbd && !qbd.hidden && state.playingId !== lastQueueRenderedId) {
    lastQueueRenderedId = state.playingId;
    renderQueue();
  }
}

/* ------------------------------ Home: moods + genres ------------------------------ */

const MOODS = [
  { name: 'Chill', grad: ['#0f5132', '#0a2a1c'], seeds: ['chill lofi mix', 'lofi beats to relax', 'cozy chill playlist'] },
  { name: 'Focus', grad: ['#1d4ed8', '#0f2b7a'], seeds: ['deep focus music', 'study beats instrumental', 'ambient concentration'] },
  { name: 'Workout', grad: ['#ea580c', '#7c2d12'], seeds: ['workout music mix', 'gym motivation songs', 'high energy workout'] },
  { name: 'Party', grad: ['#9333ea', '#4c1d95'], seeds: ['party hits mix', 'dance party playlist', 'club bangers'] },
  { name: 'Night drive', grad: ['#0e7490', '#164e63'], seeds: ['night drive music', 'synthwave mix', 'late night city pop'] },
  { name: 'Sad hours', grad: ['#475569', '#1e293b'], seeds: ['sad songs playlist', 'emotional ballads', 'breakup songs'] },
  { name: 'Feel good', grad: ['#ca8a04', '#713f12'], seeds: ['happy upbeat songs', 'feel good hits', 'summer vibes'] },
  { name: 'Sleep', grad: ['#334155', '#0f172a'], seeds: ['sleep music', 'calm piano for sleep', 'relaxing sleep sounds'] },
];

const GENRES = ['Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Latin', 'Jazz', 'Classical', 'Country', 'Metal', 'Indie', 'Afrobeat'];

const GENRE_GRADS = [
  ['#f72585', '#b5179e'], // Pop
  ['#e63946', '#9d0208'], // Rock
  ['#ff9e00', '#ff4d00'], // Hip-Hop
  ['#7209b7', '#3a0ca3'], // R&B
  ['#00b4d8', '#0077b6'], // Electronic
  ['#ffd166', '#f4845f'], // Latin
  ['#06d6a0', '#118ab2'], // Jazz
  ['#e9c46a', '#8a5a44'], // Classical
  ['#bc6c25', '#7f4f24'], // Country
  ['#6c757d', '#212529'], // Metal
  ['#84cc16', '#166534'], // Indie
  ['#fca311', '#c1121f'], // Afrobeat
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Idle Search screen: Spotify-style 2-column "Browse all" genre grid. Built
// once; taps open the full genre page (same tiles as Home).
let searchBrowseBuilt = false;
function renderSearchBrowse() {
  const grid = $('#browse-grid');
  if (!grid || searchBrowseBuilt) return;
  searchBrowseBuilt = true;
  GENRES.forEach((g, i) => {
    const gd = GENRE_GRADS[i % GENRE_GRADS.length];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'genre-tile';
    b.style.background = `linear-gradient(135deg, ${gd[0]}, ${gd[1]})`;
    b.innerHTML = `<span class="genre-tile-name">${esc(g)}</span>`;
    b.title = `Browse ${g} music`;
    b.addEventListener('click', () => openGenrePage(g, gd));
    grid.appendChild(b);
  });
}

// Show the Browse-all grid only when the Search tab is idle (empty field).
// Typing swaps it out for the inline suggestions + results.
function updateSearchBrowse() {
  const br = $('#search-browse');
  if (!br) return;
  const input = $('#search-input');
  br.hidden = !(state.tab === 'search' && !input.value.trim());
}

// The biggest artists right now across YouTube, Spotify and Apple Music charts.
// The Artists shelf shuffles this list every visit so it always feels fresh,
// while staying curated to genuinely popular acts (not random uploaders).
const POPULAR_ARTISTS = [
  'Taylor Swift', 'The Weeknd', 'Drake', 'Bad Bunny', 'Ed Sheeran', 'Adele',
  'Beyoncé', 'Rihanna', 'Eminem', 'BTS', 'Ariana Grande', 'Justin Bieber',
  'Bruno Mars', 'Billie Eilish', 'Harry Styles', 'Dua Lipa', 'Post Malone',
  'SZA', 'Travis Scott', 'Kendrick Lamar', 'Olivia Rodrigo', 'Sabrina Carpenter',
  'Coldplay', 'Imagine Dragons', 'Maroon 5', 'Katy Perry', 'Lady Gaga',
  'Doja Cat', 'Nicki Minaj', 'Cardi B', 'Lil Nas X', 'Shawn Mendes',
  'Miley Cyrus', 'Blackpink', 'J Balvin', 'Shakira', 'Karol G', 'Rauw Alejandro',
  'Zach Bryan', 'Morgan Wallen', 'Luke Combs', 'AC/DC', 'Queen', 'Linkin Park',
  'Eraserheads', 'Ben&Ben', 'Moira Dela Torre', 'Sarah Geronimo', 'Zack Tabudlo',
];

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

async function loadArtists() {
  const sec = $('#artists');
  const row = $('#artists-row');
  row.innerHTML = skeletonRow(8, { circle: true });
  const run = state.homeRun; // ignore completions from a previous Home visit
  try {
    // Pick 10 random top artists, resolve each one's top track for the avatar.
    const chosen = shuffle(POPULAR_ARTISTS).slice(0, 10);
    const results = await Promise.all(
      chosen.map((name) => MusicEngine.search(name, 3, { noVersions: true }).catch(() => []))
    );
    if (state.tab !== 'home' || run !== state.homeRun) return;
    row.innerHTML = '';
    let added = 0;
    results.forEach((tracks, idx) => {
      const artist = chosen[idx];
      const t = (tracks || []).find((x) => x.cover) || (tracks || [])[0];
      if (!t) return;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'artist-item';
      el.title = `Search ${artist}`;
      el.innerHTML = `<span class="artist-ava">${coverHtml(t, 'artist-img')}</span><span class="artist-name">${esc(artist)}</span>`;
      el.addEventListener('click', () => {
        switchTab('search');
        $('#search-input').value = artist;
        runSearch(artist);
      });
      row.appendChild(el);
      added++;
    });
    sec.hidden = state.tab !== 'home' || added === 0;
  } catch {
    sec.hidden = true;
  }
}

// Genre page — tapping a genre tile opens a full page with that genre's
// suggested songs (no more inline row on Home).
// One playlist card for the genre page's 2-column grid — opens the album view.
function genrePlCard(a) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'album-card';
  card.dataset.id = a.id || '';
  card._album = a; // direct album reference for long-press
  card.innerHTML = `
    <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</span>'" />` : `<span class="noimg logo-fallback">${LOGO_FB}</span>`}</span>
    <span class="album-card-name">${esc(a.name)}</span>
    <span class="album-card-artist">${esc(albumCardArtist(a))}</span>`;
  card.addEventListener('click', () => openAlbumView(a));
  return card;
}

let genrePageRun = 0;
function openGenrePage(genre, grad) {
  morphOpenOverlay($('#genre-backdrop')); // grows out of the mini bar, same as Now Playing
  $('#genre-title').textContent = genre;
  $('#genre-sub').textContent = 'Finding the best tracks…';
  // Full-height top fade in the genre's colors, melting into the base —
  // the Home-header treatment, tinted per genre.
  $('#genre-banner').style.background = `linear-gradient(180deg, ${grad[0]} 0%, ${grad[1]} 52%, rgba(18,18,18,0) 100%)`;
  // Tint the header band with the tile's colors (style.css reads --g1/--g2).
  $('#genre-view').style.setProperty('--g1', grad[0]);
  $('#genre-view').style.setProperty('--g2', grad[1]);
  const plGrid = $('#genre-playlists');
  const trList = $('#genre-tracks');
  $('#genre-pl-sec').hidden = false;
  $('#genre-songs-sec').hidden = false;
  $('#genre-empty').hidden = true;
  const run = ++genrePageRun;

  // Cache-first paint: a genre you already visited renders instantly from the
  // row cache while the fresh copy refreshes in the background.
  const cachedPl = rowCacheGet('genre_pl_' + genre);
  const cachedSongs = rowCacheGet('genre_songs_' + genre);
  plGrid.innerHTML = cachedPl && cachedPl.length ? '' : skeletonRow(4, { grid: true });
  trList.innerHTML = cachedSongs && cachedSongs.length ? '' : skeletonRow(6, { list: true });
  if (cachedPl && cachedPl.length) cachedPl.forEach((a) => plGrid.appendChild(genrePlCard(a)));
  if (cachedSongs && cachedSongs.length) {
    cachedSongs.slice(0, 30).forEach((t, i) => trList.appendChild(albumRowEl(t, i, cachedSongs, false, '')));
    $('#genre-sub').textContent = `The best of ${genre} right now — ${cachedSongs.length} songs.`;
  }

  // Playlists and songs load INDEPENDENTLY and each section paints the moment
  // its own data lands — a slow playlist search never holds up the songs (and
  // vice versa). Queries are kept lean so the Brain's request pacing doesn't
  // serialize them into a 30-second stall.

  // 12h cadence: a fresh cached set stays until the epoch turns over. Only
  // re-fetch in the background when there's nothing cached for THIS window.
  const plCached = !!(cachedPl && cachedPl.length);
  const songsCached = !!(cachedSongs && cachedSongs.length);

  // 1) Playlists — 2-column grid. Just ONE query + a famous-artist seed.
  (async () => {
    if (plCached) return; // this window's set is already on screen
    let playlists = [];
    try {
      const plQueries = [genre + ' playlist'];
      if (window.Brain && Brain.genreSeeds) {
        const gs = Brain.genreSeeds(genre, 4);
        if (gs.length) plQueries.unshift(gs[0]);
      }
      const plResults = await Promise.all(
        plQueries.slice(0, 2).map((q) => MusicEngine.playlistSearch(q, 5).catch(() => []))
      );
      const seen = new Map();
      plResults.flat().forEach((a) => {
        if (a && a.browseId && !seen.has(a.id)) seen.set(a.id, a);
      });
      playlists = [...seen.values()].slice(0, 10);
    } catch { /* playlists are a nice-to-have */ }
    if (run !== genrePageRun) return;
    plGrid.innerHTML = '';
    playlists.forEach((a) => plGrid.appendChild(genrePlCard(a)));
    if (!playlists.length) $('#genre-pl-sec').hidden = true;
    else if (playlists.length) rowCacheSet('genre_pl_' + genre, playlists);
  })();

  // 2) Songs — the Brain seeds the page with FAMOUS ARTISTS of this genre
  //    first (searching a name returns that artist's real hits, never mixes
  //    or random uploads), then curated phrases, then trending artists.
  //    Falls back to the plain label search when the Brain is unavailable.
  //    Charts back-fill guarantees at least 10 REAL hits.
  (async () => {
    if (songsCached) return; // this window's set is already on screen
    let tracks = [];
    try {
      let queries = [genre + ' music'];
      if (window.Brain && Brain.genreSeeds) {
        const gs = Brain.genreSeeds(genre, 4);
        if (gs.length) queries = gs;
      }
      const results = await Promise.all(
        queries.slice(0, 2).map((q) => MusicEngine.search(q, 12, { noVersions: true }).catch(() => []))
      );
      // trimRecommendations dedupes by id + drops Indian noise; then keep the
      // list song-like by dropping very long audios (>10min) and short clips.
      tracks = trimRecommendations(results.flat())
        .filter((t) => (t.duration || 0) <= 600 && (t.duration || 0) >= 20);
      // Famous back-fill: if the searches came up thin, pull the live charts
      // (Hot This Week Top 100 + Trending — famous songs by definition) and
      // fill the list up to at least 10 REAL hits. Artists the Brain knows
      // belong to this genre get priority; if the strict pass still can't
      // reach 10, any chart hit is accepted (famous by definition) rather
      // than leaving the page sparse. If the charts are cold/empty too, a
      // plain "<genre> hits" search fills the page last.
      if (tracks.length < 10) {
        try {
          const [hot, tr] = await Promise.all([
            MusicEngine.hotThisWeek(25).catch(() => []),
            MusicEngine.trending(25).catch(() => []),
          ]);
          let chart = trimRecommendations(hot.concat(tr))
            .filter((t) => (t.duration || 0) <= 600 && (t.duration || 0) >= 20);
          // Cold charts (first open): a hits search is the standby.
          if (chart.length < 10) {
            const hits = await MusicEngine.search(genre + ' hits', 12, { noVersions: true }).catch(() => []);
            chart = chart.concat(trimRecommendations(hits)
              .filter((t) => (t.duration || 0) <= 600 && (t.duration || 0) >= 20));
          }
          const seen = new Map(tracks.map((t) => [t.id, t]));
          const inGenre = (t) => window.Brain && Brain.artistInGenre ? Brain.artistInGenre(t.artist, genre) : true;
          // Strict pass first: genre-known artists.
          chart.filter(inGenre).forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
          // Lenient pass: any remaining chart hit to guarantee a full page.
          if (seen.size < 10) {
            chart.forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
          }
          tracks = [...seen.values()];
        } catch { /* keep the search results we already have */ }
      }
    } catch { /* fall through to whatever we already have */ }
    if (run !== genrePageRun) return;
    trList.innerHTML = '';
    tracks.slice(0, 30).forEach((t, i) => trList.appendChild(albumRowEl(t, i, tracks, false, '')));
    if (tracks.length) {
      $('#genre-songs-sec').hidden = false;
      $('#genre-sub').textContent = `The best of ${genre} right now — ${tracks.length} songs.`;
      rowCacheSet('genre_songs_' + genre, tracks);
    } else {
      $('#genre-songs-sec').hidden = true;
      $('#genre-empty').hidden = false;
      $('#genre-sub').textContent = '';
    }
  })();
}

function closeGenrePage() {
  morphCloseOverlay($('#genre-backdrop'));
}
function closeGenreInstant() {
  closeOverlay($('#genre-backdrop'), true);
}

on('#genre-close', 'click', closeGenrePage);

let moodRun = 0;
// Mood grid (Moods tab) — 2-column colorful chip grid. Tap a mood to load
// tracks for it inline, below the grid.
const MOOD_GRADS = [
  ['#0f5132', '#0a2a1c'], // Chill
  ['#1d4ed8', '#0f2b7a'], // Focus
  ['#ea580c', '#7c2d12'], // Workout
  ['#9333ea', '#4c1d95'], // Party
  ['#0e7490', '#164e63'], // Night drive
  ['#475569', '#1e293b'], // Sad hours
  ['#ca8a04', '#713f12'], // Feel good
  ['#334155', '#0f172a'], // Sleep
];

let moodGridRun = 0;
function loadMoodsGrid() {
  $('#moods-page').hidden = false;
  const grid = $('#mood-grid');
  grid.innerHTML = '';
  MOODS.forEach((mood, i) => {
    const gd = MOOD_GRADS[i % MOOD_GRADS.length];
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'mood-chip';
    c.dataset.mood = mood.name;
    c.style.background = `linear-gradient(135deg, ${gd[0]}, ${gd[1]})`;
    c.innerHTML = `<span class="mood-chip-name">${esc(mood.name)}</span><span class="mood-chip-sub">Find your vibe</span>`;
    c.addEventListener('click', () => loadMoodTracks(mood));
    grid.appendChild(c);
  });
  $('#mood-results').hidden = true;
}

let moodTrackRun = 0;
async function loadMoodTracks(mood) {
  const run = ++moodTrackRun;
  const res = $('#mood-results');
  const grid = $('#mood-results-grid');
  const title = $('#mood-results-title');
  const sub = $('#mood-results-sub');
  const empty = $('#mood-results-empty');
  res.hidden = false;
  title.textContent = mood.name;
  sub.textContent = 'Loading…';
  grid.innerHTML = skeletonRow(6, { grid: true });
  empty.hidden = true;
  // Highlight the active chip
  $$('.mood-chip').forEach((c) => c.classList.toggle('active', c.dataset.mood === mood.name));
  // The Brain seeds moods with FAMOUS ARTISTS + curated phrases for the
  // mood's genres (multi-query so a single dead search never empties the
  // page); the mood's own seeds back it up.
  let queries = [...(mood.seeds || [])];
  if (window.Brain && Brain.moodSeeds) {
    const ms = Brain.moodSeeds(mood.name, 4);
    if (ms.length) queries = ms;
  }
  try {
    const results = await Promise.all(
      queries.slice(0, 4).map((q) => MusicEngine.search(q, 10, { noVersions: true }).catch(() => []))
    );
    const seen = new Map();
    results.flat().forEach((t) => { if (!seen.has(t.id)) seen.set(t.id, t); });
    let tracks = trimRecommendations([...seen.values()]);
    // Famous back-fill: when the mood searches come up thin, pull the live
    // charts and keep the tracks whose artists the Brain knows belong to one
    // of this mood's genres — famous songs that actually fit the vibe.
    if (tracks.length < 8 && window.Brain && Brain.moodGenres && Brain.artistInGenre) {
      const moodKeys = Brain.moodGenres(mood.name);
      if (moodKeys.length) {
        try {
          const [hot, tr] = await Promise.all([
            MusicEngine.hotThisWeek(20).catch(() => []),
            MusicEngine.trending(20).catch(() => []),
          ]);
          trimRecommendations(hot.concat(tr)).forEach((t) => {
            if (seen.has(t.id)) return;
            if (!moodKeys.some((g) => Brain.artistInGenre(t.artist, g))) return;
            if ((t.duration || 0) > 600 || (t.duration || 0) < 20) return;
            seen.set(t.id, t);
          });
        } catch { /* keep what we have */ }
      }
    }
    tracks = shuffle([...seen.values()]);
    if (run !== moodTrackRun) return;
    if (tracks.length) {
      grid.innerHTML = '';
      tracks.forEach((t) => grid.appendChild(makeCard(t, tracks)));
      sub.textContent = `${mood.name} — ${tracks.length} famous tracks that match the vibe`;
    } else {
      grid.innerHTML = ''; // clear the skeleton so only the empty state shows
      empty.hidden = false;
      sub.textContent = `No tracks found for “${queries[0]}”.`;
    }
  } catch (e) {
    if (run !== moodTrackRun) return;
    grid.innerHTML = ''; // clear the skeleton so only the error shows
    empty.hidden = false;
    empty.querySelector('p').textContent = `Couldn't load: ${esc(e.message)}`;
    sub.textContent = '';
  }
}

/* ------------------------------ row cache (cold start) ------------------------------ */

// Persist the last-good Home row payloads (trending / hot / PH / albums) so a
// cold start paints real cards instantly from the previous session, then
// refreshes them in the background. Cache slots are keyed by a 12-hour epoch:
// a NEW window always fetches a fresh set of songs (never re-shows the last
// window's cards), while repeated opens within the same window stay instant.
const ROW_CACHE_TTL = 12 * 60 * 60 * 1000; // belt-and-braces guard on top of the epoch key
const ROW_EPOCH_MS = 12 * 60 * 60 * 1000;  // Home + genre content refreshes every 12h
const rowEpoch = () => Math.floor(Date.now() / ROW_EPOCH_MS);
function rowCacheGet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem('natsirt_row_' + rowEpoch() + '_' + key));
    if (raw && raw.at && Date.now() - raw.at < ROW_CACHE_TTL && Array.isArray(raw.tracks)) return raw.tracks;
  } catch { /* ignore */ }
  return null;
}
function rowCacheSet(key, tracks) {
  try { localStorage.setItem('natsirt_row_' + rowEpoch() + '_' + key, JSON.stringify({ at: Date.now(), tracks: (tracks || []).slice(0, 30) })); }
  catch { /* quota — ignore */ }
}

/* ------------------------------ home variety (no repeats) ------------------------------ */
// Home used to show the same chart cards every visit: the row cache kept the
// same payload for hours and nothing remembered what was surfaced. Now every
// card shown on Home is remembered (id → last-seen) for a day, each visit
// ROTATES the cached rows (a different slice leads), and rows dedupe against
// each other within a single load. Repeats are pushed to the END rather than
// dropped, so a row never starves while its leading cards stay fresh.
const HOME_SEEN_KEY = 'natsirt_home_seen';
const HOME_SEEN_MS = 20 * 3600 * 1000; // shown-today → not re-shown tomorrow
const HOME_ROT_KEY = 'natsirt_home_rot';

function homeSeenAll() {
  try { const m = JSON.parse(localStorage.getItem(HOME_SEEN_KEY)); return m && typeof m === 'object' ? m : {}; }
  catch { return {}; }
}
function homeMarkSeen(tracks) {
  try {
    const m = homeSeenAll();
    const t = Date.now();
    (tracks || []).forEach((x) => { if (x && x.id) m[x.id] = t; });
    const entries = Object.entries(m).filter(([, ts]) => t - Number(ts || 0) < 7 * 86400000);
    localStorage.setItem(HOME_SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage — best-effort */ }
}
// Reorder so recently-surfaced tracks go to the END (fresh ones lead). If
// almost everything was already seen, keep the original order — rows must
// never starve.
function homeVariety(tracks) {
  if (!tracks || tracks.length < 4) return tracks;
  const m = homeSeenAll();
  const now = Date.now();
  const seen = tracks.filter((t) => t && t.id && now - Number(m[t.id] || 0) < HOME_SEEN_MS);
  const fresh = tracks.filter((t) => !seen.includes(t));
  if (!seen.length) return tracks;
  if (seen.length / tracks.length > 0.7) return tracks;
  return [...fresh, ...seen];
}
// Cross-row dedup within a single Home load: ids surfaced by an earlier row
// move to the back of the next row (only when the row stays viable).
let homeRowSeen = null;
function homeStartVisit() { homeRowSeen = new Set(); }
function homeDedupRow(tracks) {
  if (!homeRowSeen || !tracks || tracks.length < 5) return tracks;
  const dups = tracks.filter((t) => t && t.id && homeRowSeen.has(t.id));
  const fresh = tracks.filter((t) => !dups.includes(t));
  if (fresh.length < 5) return tracks;
  return [...fresh, ...dups];
}
function homeMarkVisit(tracks) { (tracks || []).forEach((t) => { if (t && t.id) homeRowSeen.add(t.id); }); }
// Rotate a cached row so each visit leads with a different slice.
function homeRotate(key, arr) {
  if (!arr || arr.length < 4) return arr;
  try {
    const m = JSON.parse(localStorage.getItem(HOME_ROT_KEY)) || {};
    const i = (Number(m[key]) || 0) + 1;
    m[key] = i;
    localStorage.setItem(HOME_ROT_KEY, JSON.stringify(m));
    const cut = i % arr.length;
    return [...arr.slice(cut), ...arr.slice(0, cut)];
  } catch { return arr; }
}

// Boot splash: the OrBeat hero intro. A rotating tagline is picked per
// launch; the hero must play IN FULL (minimum display time) before it sweeps
// away — even when Home paints instantly from cache — so the intro never
// feels like a flash. hideBootSplash is called whenever Home's first row
// paints; the safety net in init() covers a total failure.
const HERO_QUOTES = [
  'Every beat finds its home.',
  'One beat ahead.',
  'Your music, your beat.',
  'Feel the pulse of every track.',
  'Let the music take the lead.',
  'The beat that orbits you.',
];
{
  const q = $('#hero-quote');
  if (q) q.textContent = HERO_QUOTES[Math.floor(Math.random() * HERO_QUOTES.length)];
}
const BOOT_HERO_MS = 2800; // the full hero animation runs ~2.3s; hold a touch more
const bootT0 = (performance && performance.timeOrigin) ? performance.timeOrigin + performance.now() : Date.now();
function hideBootSplash() {
  const s = $('#boot-splash');
  if (!s || s.dataset.done) return;
  const elapsed = Date.now() - bootT0;
  if (elapsed < BOOT_HERO_MS) {
    // Home painted early — let the hero finish its reveal first.
    setTimeout(hideBootSplash, BOOT_HERO_MS - elapsed);
    return;
  }
  s.dataset.done = '1';
  s.classList.add('done');
  setTimeout(() => { s.hidden = true; }, 750); // hero-exit (0.55s) + fade lag
}

/* ------------------------------ Home: trending ------------------------------ */

let trendingRun = 0;
// Trending Now — what the internet is playing right now, per YouTube. Refreshed
// automatically (10-min cache + on app resume + manual ↻).
async function loadTrending() {
  const sec = $('#trending-sec');
  const row = $('#trending-row');
  const run = ++trendingRun; // ignore stale completions
  sec.hidden = false;
  // 12h refresh cadence: a fresh cached set IS the row until the epoch turns
  // over — no network re-fetch on every visit (that's what kept repeating the
  // same songs). Rotate the cached view (fresh slice leads) + push repeats.
  const cached = rowCacheGet('trending');
  if (cached && cached.length) {
    const view = homeVariety(homeDedupRow(homeRotate('trending', cached)));
    row.innerHTML = '';
    view.forEach((t) => {
      const c = makeCard(t, view);
      c.classList.add('compact');
      row.appendChild(c);
    });
    hideBootSplash();
    state.trendingAt = Date.now();
    return;
  }
  row.innerHTML = skeletonRow(6);
  try {
    let tracks = shuffle(trimRecommendations(await MusicEngine.trending(14)));
    if (state.tab !== 'home' || run !== trendingRun) return;
    // No repeats: push this visit's earlier rows' cards to the back and
    // remember what surfaced (fresh leads next visit too).
    tracks = homeVariety(homeDedupRow(tracks));
    homeMarkVisit(tracks);
    homeMarkSeen(tracks);
    // Learn from the internet: feed the live trending artists to the Brain so
    // genre pages + recommendations can surface what's CURRENT right now.
    if (window.Brain && Brain.learnTrending) Brain.learnTrending(tracks);
    rowCacheSet('trending', tracks);
    hideBootSplash();
    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    // Pre-warm the first few streams so the very first tap starts instantly.
    tracks.slice(0, 3).forEach((t) => { if (t.videoId) MusicEngine.warm(t.videoId); });
    state.trendingAt = Date.now();
    if (!tracks.length) row.innerHTML = '<p class="row-loading">Nothing trending right now — check back soon.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== trendingRun) return;
    if (!cached || !cached.length) row.innerHTML = `<p class="row-loading">Couldn't load trending: ${esc(e.message)}</p>`;
  }
}

let hotRun = 0;
// Hot This Week — YouTube Music's Top 100 chart (same YTM source as the
// Trending row). Every entry is a real YTM track with a videoId, so tapping
// a card plays instantly.
async function loadHotThisWeek() {
  const sec = $('#hot-sec');
  const row = $('#hot-row');
  const run = ++hotRun;
  sec.hidden = false;
  // 12h cadence: cached set is authoritative until the epoch turns over.
  const cached = rowCacheGet('hot');
  if (cached && cached.length) {
    const view = homeVariety(homeDedupRow(homeRotate('hot', cached)));
    row.innerHTML = '';
    view.forEach((t) => {
      const c = makeCard(t, view);
      c.classList.add('compact');
      row.appendChild(c);
    });
    hideBootSplash();
    return;
  }
  row.innerHTML = skeletonRow(6);
  try {
    let tracks = shuffle(await MusicEngine.hotThisWeek(12));
    if (state.tab !== 'home' || run !== hotRun) return;
    tracks = homeVariety(homeDedupRow(tracks));
    homeMarkVisit(tracks);
    homeMarkSeen(tracks);
    // Hot This Week is live chart data too — the Brain learns from it.
    if (window.Brain && Brain.learnTrending) Brain.learnTrending(tracks);
    rowCacheSet('hot', tracks);
    hideBootSplash();
    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    // Pre-warm the first few chart streams too — instant first tap.
    tracks.slice(0, 3).forEach((t) => { if (t.videoId) MusicEngine.warm(t.videoId); });
    sec.hidden = state.tab !== 'home' || tracks.length === 0;
    if (!tracks.length) row.innerHTML = '<p class="row-loading">Chart unavailable right now.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== hotRun) return;
    if (!cached || !cached.length) row.innerHTML = `<p class="row-loading">Couldn't load the chart: ${esc(e.message)}</p>`;
  }
}

// Auto-update: refresh the trending rows when the app comes back to the
// foreground or sits open past the 10-minute freshness window.
// Auto-update recommendation rows when stale. Never refresh while
// backgrounded — a background session should make zero YouTube-facing
// requests beyond the guard's single 5-hour probe. NOTE: the WebView never
// sees visibilitychange in this app — KeepAliveWebView swallows the
// window-visibility drop so audio keeps playing — so document.hidden can't
// signal backgrounding. The only reliable signal is Capacitor's document
// 'pause'/'resume' events (activity lifecycle, fired regardless of
// keepRunning). The interval below then catches up the moment the app
// returns to the foreground.
let appBackgrounded = false;
document.addEventListener('pause', () => { appBackgrounded = true; });
document.addEventListener('resume', () => {
  appBackgrounded = false;
  refreshStaleRows(); // stale rows refresh immediately on return
});

function refreshStaleRows() {
  if (appBackgrounded) return;
  if (state.tab !== 'home') return;
  // The Home refresh cadence is 12h: rows stay as-loaded for the whole
  // session and only re-fetch when a new 12h window has started.
  const stale = Date.now() - (state.trendingAt || 0) > ROW_EPOCH_MS;
  if (stale) { loadTrending(); loadHotThisWeek(); loadPhTrending(); loadAlbums(); }
}
setInterval(refreshStaleRows, 5 * 60 * 1000);
// Belt-and-braces: if a device ever does deliver visibilitychange, refresh
// on return-to-visible (refreshStaleRows is a no-op when rows are fresh).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshStaleRows();
});

// ── PH Trending ────────────────────────────────────────────────────────────
let phRun = 0;
async function loadPhTrending() {
  const sec = $('#ph-sec');
  const row = $('#ph-row');
  const run = ++phRun;
  sec.hidden = false;
  // 12h cadence: cached set is authoritative until the epoch turns over.
  const cached = rowCacheGet('ph');
  if (cached && cached.length) {
    const view = homeVariety(homeDedupRow(homeRotate('ph', cached)));
    row.innerHTML = '';
    view.forEach((t) => {
      const c = makeCard(t, view);
      c.classList.add('compact');
      row.appendChild(c);
    });
    return;
  }
  row.innerHTML = skeletonRow(6);
  try {
    let tracks = shuffle(trimRecommendations(await MusicEngine.phTrending(12)));
    if (state.tab !== 'home' || run !== phRun) return;
    tracks = homeVariety(homeDedupRow(tracks));
    homeMarkVisit(tracks);
    homeMarkSeen(tracks);
    rowCacheSet('ph', tracks);
    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    // Pre-warm the first few PH streams too.
    tracks.slice(0, 3).forEach((t) => { if (t.videoId) MusicEngine.warm(t.videoId); });
    sec.hidden = state.tab !== 'home' || tracks.length === 0;
    if (!tracks.length) row.innerHTML = '<p class="row-loading">PH chart unavailable right now.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== phRun) return;
    if (!cached || !cached.length) row.innerHTML = `<p class="row-loading">Couldn't load PH trending: ${esc(e.message)}</p>`;
  }
}

// ── Albums ─────────────────────────────────────────────────────────────────
// Albums are YouTube Playlists: every row is a real, playable playlist (the
// YouTube "Playlist" feature), randomly picked from a rotating set of queries
// so the shelf feels fresh. Playlists are also searchable from Search mode.
let albRun = 0;
const ALBUM_QUERIES = [
  'top hits playlist', 'trending music playlist', 'best of pop playlist',
  'new music 2026 playlist', 'hottest songs playlist', 'party hits playlist',
  'workout music playlist', 'chill vibes playlist', 'top international hits',
  'philippines top hits playlist', 'rnb hits playlist', 'rock classics playlist',
];

async function loadAlbums() {
  const sec = $('#albums-sec');
  const row = $('#albums-row');
  const run = ++albRun;
  sec.hidden = false;
  // 12h cadence: a cached set is authoritative until the epoch turns over.
  const cached = rowCacheGet('albums');
  if (cached && cached.length) {
    const view = homeVariety(homeDedupRow(homeRotate('albums', cached)));
    row.innerHTML = '';
    view.forEach((a) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'album-card';
      card.dataset.id = a.id || '';
      // Direct album reference so long-press opens the album menu.
      card._album = a;
      card.innerHTML = `
        <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</span>'" />` : `<span class="noimg logo-fallback">${LOGO_FB}</span>`}</span>
        <span class="album-card-name">${esc(a.name)}</span>
        <span class="album-card-artist">${esc(albumCardArtist(a))}</span>
      `;
      card.addEventListener('click', () => openAlbumView(a));
      row.appendChild(card);
    });
    sec.hidden = state.tab !== 'home' || view.length === 0;
    return;
  }
  row.innerHTML = skeletonRow(4);
  try {
    const queries = [...ALBUM_QUERIES].sort(() => Math.random() - 0.5).slice(0, 2);
    const results = await Promise.all(
      queries.map((q) => MusicEngine.playlistSearch(q, 6).catch(() => []))
    );
    let albums = results.flat().filter((a) => a && a.browseId);
    albums = albums.filter((a) => !MusicEngine.isIndianTrack(a));
    if (state.tab !== 'home' || run !== albRun) return;
    // Shuffle for a fresh shelf each visit, then rotate + dedupe like the
    // song rows so the same playlists don't lead twice.
    albums = albums.sort(() => Math.random() - 0.5);
    albums = homeVariety(homeDedupRow(homeRotate('albums', albums)));
    homeMarkVisit(albums);
    homeMarkSeen(albums);
    rowCacheSet('albums', albums);
    row.innerHTML = '';
    albums.forEach((a) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'album-card';
      card.dataset.id = a.id || '';
      // Direct album reference so long-press opens the album menu.
      card._album = a;
      card.innerHTML = `
        <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</span>'" />` : `<span class="noimg logo-fallback">${LOGO_FB}</span>`}</span>
        <span class="album-card-name">${esc(a.name)}</span>
        <span class="album-card-artist">${esc(albumCardArtist(a))}</span>
      `;
      card.addEventListener('click', () => openAlbumView(a));
      row.appendChild(card);
    });
    sec.hidden = state.tab !== 'home' || albums.length === 0;
    if (!albums.length) row.innerHTML = '<p class="row-loading">No albums found.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== albRun) return;
    if (!cached || !cached.length) row.innerHTML = `<p class="row-loading">Couldn't load albums: ${esc(e.message)}</p>`;
  }
}

// Search-mode playlist shelf — when a search also matches playlists, show them
// as album cards above the song grid so playlists are fully searchable.
async function loadSearchPlaylists(query) {
  const row = $('#search-playlists');
  if (!row) return;
  row.hidden = true;
  row.innerHTML = '';
  try {
    const playlists = (await MusicEngine.playlistSearch(query, 6).catch(() => []))
      .filter((a) => a && a.browseId && !MusicEngine.isIndianTrack(a));
    if (!playlists.length || state.tab !== 'search') return;
    row.hidden = false;
    const h = document.createElement('div');
    h.className = 'section-head';
    h.innerHTML = '<h2 class="section-title">Playlists</h2><p class="section-sub">Tap to open & play.</p>';
    row.appendChild(h);
    playlists.forEach((a) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'album-card';
      card.dataset.id = a.id || '';
      // Direct album reference so long-press opens the album menu.
      card._album = a;
      card.innerHTML = `
        <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</span>'" />` : `<span class="noimg logo-fallback">${LOGO_FB}</span>`}</span>
        <span class="album-card-name">${esc(a.name)}</span>
        <span class="album-card-artist">${esc(albumCardArtist(a))}</span>
      `;
      card.addEventListener('click', () => openAlbumView(a));
      row.appendChild(card);
    });
  } catch { /* playlists shelf is a nice-to-have */ }
}

// Card subtitle for the Albums shelf + search playlists: playlists carry the
// creator channel in `artist` — surface our brand instead, never a YouTube
// channel name (albums keep their real artist).
function albumCardArtist(a) {
  const isPl = a.source === 'playlist' || /^(VL|PL)/.test(String(a.browseId || ''));
  return isPl ? 'OrBeat Playlist' : (a.artist || '');
}

// Album view — opens an overlay showing the album's tracks.
function openAlbumView(album) {
  // For fallback albums (no real browseId), use the artist name as the
  // "album" label so the overlay looks right with artist-search results.
  const albumName = album.browseId ? album.name : album.artist;
  const albumArtist = album.artist;
  // Playlists are the app's "Albums" — label them as playlists, not albums.
  // Detect by source OR by browseId shape (YouTube Music playlists start with
  // VL, plain YouTube playlists with PL; only real albums are MPRE).
  const isPlaylist = album.source === 'playlist' || /^(VL|PL)/.test(String(album.browseId || ''));
  const typeLabel = isPlaylist ? 'Playlist' : 'Album';
  const artEl = $('#album-art');
  // HD art, same crisp-cover treatment as Now Playing: Google-CDN covers are
  // bumped to a 1080px render, YouTube thumbs to maxresdefault, with a
  // graceful fallback to the original thumbnail.
  const albumOrig = album.cover || '';
  const albumImg = albumOrig ? upscaleArtHD(albumOrig) : '';
  artEl.innerHTML = albumImg
    ? `<img src="${esc(albumImg)}" alt="" data-orig="${esc(albumOrig)}" onerror="if(this.src!==this.dataset.orig){this.src=this.dataset.orig}else{this.outerHTML='<div class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'}" />`
    : `<div class="noimg logo-fallback">${LOGO_FB}</div>`;
  // Cover entrance, re-triggered on every open (same as the Now Playing art).
  artEl.classList.remove('album-art-in');
  void artEl.offsetWidth;
  artEl.classList.add('album-art-in');
  // Paint the whole page from the art's colors, like the Now Playing screen.
  // (Blob-fetched sampling — see artToGradient — so the canvas never taints.)
  artToGradient(albumImg || album.cover, $('#album-glow'));
  currentAlbumView = album; // for the "Add to playlist" action in the header
  $('#album-name').textContent = albumName;
  if (isPlaylist) {
    // Playlists get the OrBeat brand, never a YouTube channel name or views.
    $('#album-artist').textContent = 'OrBeat Playlist';
    $('#album-meta2').textContent = album.trackCount ? `${album.trackCount} songs` : '';
  } else {
    $('#album-artist').textContent = albumArtist;
    const label = album.browseId ? (album.year ? `${album.year}${album.trackCount ? ` • ${album.trackCount} songs` : ''}` : (album.trackCount ? `${album.trackCount} songs` : '')) : 'Popular tracks';
    $('#album-meta2').textContent = label;
  }
  const src = $('#album-view').querySelector('.np-source');
  if (src) src.textContent = typeLabel;
  loadAlbumTracks(album.browseId || '', album._artistQuery || album.artist, isPlaylist, albumArtist);
  // Shared-element open: the whole album page grows out of the mini player
  // bar, and the cover travels from the mini cover — same as Now Playing.
  morphOpenOverlay($('#album-backdrop'), { cover: artEl });
}

function closeAlbumView() {
  morphCloseOverlay($('#album-backdrop'));
}
function closeAlbumViewInstant() {
  closeOverlay($('#album-backdrop'), true);
}

on('#album-close', 'click', closeAlbumView);

// Tracks of the currently open album — the orange play-all button starts here.
let albumTracksList = null;
let currentAlbumView = null; // the album object the overlay is showing

// Album/playlist/Up-Next lists render in pages — a fast first paint with the
// rest appended as you scroll (big albums/queues no longer block the UI).
const LIST_PAGE = 15;   // album + playlist rows per scroll


// One album/playlist track row (also used by the genre song list).
function albumRowEl(t, i, tracks, isPlaylist, albumArtist, opts = {}) {
  const el = document.createElement('div');
  el.className = 'album-track';
  el.dataset.id = t.id;
  el.dataset.name = t.name;
  const isPlaying = state.playingId === t.id;
  // Plain YouTube playlist rows carry the channel as the byline — brand
  // them with the OrBeat name instead of a channel + view count. Strip
  // any "• 2.3M views" / "and 2 more" junk first so even rows from an
  // un-updated relay (or the cache) still match the channel.
  let rowArtist = t.artist || 'Unknown artist';
  if (isPlaylist && rowArtist) {
    const base = rowArtist
      .replace(/\s*•\s*[\d.,]+[KMB]?\s*views?$/i, '')
      .replace(/\s+and\s+\d+\s+more$/i, '')
      .trim();
    if (base && albumArtist && base.toLowerCase() === String(albumArtist).trim().toLowerCase()) {
      rowArtist = 'OrBeat Playlist';
    }
  }
  el.innerHTML = `
    <span class="t-cover">${coverHtml(t, 't-cover-img')}
        <div class="eq" aria-hidden="true"${isPlaying ? '' : ' hidden'}><span></span><span></span><span></span></div>
      </span>
      <div class="t-info">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-artist">${esc(rowArtist)}</div>
      </div>
      ${t.duration ? `<span class="t-dur">${fmtDur(t.duration)}</span>` : ''}
      ${opts.dl === false ? '' : `<button class="row-dl" data-rm="dl" data-vid="${esc(t.videoId || '')}" title="Download for offline" aria-label="Download ${esc(t.name)}">${ICON_DL}</button>`}
      <button class="row-more" data-rm="ctx" title="More options" aria-label="More options for ${esc(t.name)}">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>
      </button>
      ${opts.remove ? `<button class="mini-btn del plv-rm" data-plv="rm" title="Remove from playlist" aria-label="Remove from playlist">
        <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>
      </button>` : ''}`;
  // ⋮ opens the same long-press context menu (the row affordance).
  const more = el.querySelector('[data-rm="ctx"]');
  if (more) more.addEventListener('click', (e) => { e.stopPropagation(); ctxOpen(t, el); });
  // Download icon per row — toggle save/remove just like the card buttons
  // (album/playlist song lists opt out via opts.dl: false; the batch
  // download lives in the header).
  const dlBtn = el.querySelector('[data-rm="dl"]');
  if (dlBtn) {
    if (window.OfflineCache && OfflineCache.hasSync(t.videoId || '')) {
      dlBtn.classList.add('done');
      dlBtn.innerHTML = ICON_DL_DONE;
      dlBtn.title = 'Saved for offline — tap to remove';
    }
    dlBtn.addEventListener('click', (e) => { e.stopPropagation(); dlTrack(t, dlBtn); });
  }
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-plv="rm"], [data-rm="ctx"], [data-rm="dl"]')) return; // buttons, not a tap
    if (window.Brain && Brain.notePlayed) Brain.notePlayed(t);
    playTrackAt(i, tracks);
    updatePlayingCards(); // green title + EQ on the row now playing
  });
  return el;
}

// --- album view: 15 rows now, 15 more as you scroll ---
let albumPageState = { tracks: null, shown: 0, isPlaylist: false, albumArtist: '' };
function renderAlbumPage() {
  const st = albumPageState;
  if (!st.tracks || st.shown >= st.tracks.length) return;
  const list = $('#album-tracks');
  const next = Math.min(st.shown + LIST_PAGE, st.tracks.length);
  // Paged rows slot in BEFORE the trailing "More on artist" section, so it
  // stays pinned at the end of the track list.
  const moreEl = list.querySelector('.album-more');
  for (let i = st.shown; i < next; i++) {
    const row = albumRowEl(st.tracks[i], i, st.tracks, st.isPlaylist, st.albumArtist, { dl: false });
    if (moreEl) list.insertBefore(row, moreEl);
    else list.appendChild(row);
  }
  st.shown = next;
}
// Keep filling while the rendered rows don't overflow the container yet —
// otherwise a first page that fits on screen could never reveal the rest.
function albumAutoFill() {
  const list = $('#album-tracks');
  const st = albumPageState;
  // Only fill when the container is actually laid out (clientHeight > 0) —
  // a hidden overlay reads 0/0 and would otherwise render the whole album
  // into the DOM for nothing.
  if (!st.tracks || !list.clientHeight) return;
  let guard = 0;
  while (list.scrollHeight <= list.clientHeight + 160 && st.shown < st.tracks.length && guard++ < 50) renderAlbumPage();
}
$('#album-tracks').addEventListener('scroll', () => {
  const list = $('#album-tracks');
  const st = albumPageState;
  if (st.tracks && list.scrollTop + list.clientHeight >= list.scrollHeight - 160) renderAlbumPage();
}, { passive: true });

async function loadAlbumTracks(browseId, artistFallback, isPlaylist, albumArtist) {
  const list = $('#album-tracks');
  list.innerHTML = skeletonRow(6, { list: true });
  albumTracksList = null;
  albumPageState = { tracks: null, shown: 0, isPlaylist, albumArtist };
  try {
    const tracks = await MusicEngine.albumTracks(artistFallback || '', browseId);
    albumTracksList = tracks;
    list.innerHTML = '';
    if (!tracks.length) { list.innerHTML = '<div class="row-loading">No tracks found.</div>'; return; }
    albumPageState = { tracks, shown: 0, isPlaylist, albumArtist };
    renderAlbumPage();
    albumAutoFill();
    // "More on <artist>" — suggested albums + songs after the last track.
    const first = tracks.find((t) => t && t.artist && t.artist !== 'Unknown artist');
    renderAlbumMore(list, (first && first.artist) || albumArtist, tracks);
  } catch (e) {
    list.innerHTML = `<div class="row-loading">Couldn't load tracks: ${esc(e.message)}</div>`;
  }
}

/* --- "More on <artist>" — suggested albums + songs at the end of every
   album / playlist track list. Appended INSIDE the scroll container so it
   appears after the last track; paged rows are inserted before it. --- */
let albumMoreRun = 0;
function renderAlbumMore(list, artist, existingTracks) {
  if (!list) return;
  list.querySelectorAll('.album-more').forEach((el) => el.remove());
  const display = String(artist || '').trim();
  if (!display || display === 'Unknown artist') return;
  const sec = document.createElement('div');
  sec.className = 'album-more';
  sec.innerHTML = `
    <h3 class="genre-sec-title">More on ${esc(display)}</h3>
    <div class="hrow album-more-pl" data-role="pl"></div>
    <p class="row-loading" data-role="loading">Finding more…</p>
    <div class="hrow album-more-songs" data-role="songs"></div>`;
  list.appendChild(sec);
  const plRow = sec.querySelector('[data-role="pl"]');
  const songsRow = sec.querySelector('[data-role="songs"]');
  const loading = sec.querySelector('[data-role="loading"]');
  const run = ++albumMoreRun;
  const existing = new Set((existingTracks || []).map((t) => t && t.id));
  (async () => {
    // Albums (playlists matching the artist) + the artist's songs in parallel.
    const [pls, songs] = await Promise.all([
      MusicEngine.playlistSearch(display, 4).catch(() => []),
      MusicEngine.search(display, 8, { noVersions: true }).catch(() => []),
    ]);
    if (run !== albumMoreRun || !sec.isConnected) return;
    loading.hidden = true;
    const albums = (pls || []).filter((a) => a && a.browseId && !MusicEngine.isIndianTrack(a));
    if (albums.length) {
      plRow.innerHTML = '';
      albums.forEach((a) => { const c = genrePlCard(a); c.classList.add('compact'); plRow.appendChild(c); });
    } else {
      plRow.remove();
    }
    // Songs: drop anything already in this album, keep it to a varied 8.
    const fresh = (songs || []).filter((t) => t && t.id && !existing.has(t.id));
    if (fresh.length) {
      songsRow.innerHTML = '';
      fresh.slice(0, 8).forEach((t) => { const c = makeCard(t, fresh); c.classList.add('compact'); songsRow.appendChild(c); });
    } else {
      songsRow.remove();
    }
    if (!albums.length && !fresh.length) sec.remove(); // nothing found — drop it
  })();
}

on('#album-play-all', 'click', () => {
  if (!albumTracksList || !albumTracksList.length) { toast('Album still loading…'); return; }
  playTrackAt(0, albumTracksList);
  updatePlayingCards();
});

// Album header "+" — add the whole album to a user playlist.
on('#album-add-pl', 'click', () => {
  if (!currentAlbumView) return;
  openPlaylistPicker({ __album: currentAlbumView }, $('#album-add-pl'));
});

// Batch download — queue every playable track of the album/playlist.
function downloadAlbumTracks(tracks, label) {
  const playable = (tracks || []).filter((t) => t && vidOf(t));
  if (!playable.length) { toast(`Nothing in this ${label} can be saved`, true); return; }
  const missing = (tracks || []).length - playable.length;
  toast(`Downloading ${label} — ${playable.length} track${playable.length === 1 ? '' : 's'}${missing ? ` (${missing} skipped)` : ''}…`);
  playable.forEach((t) => enqueueDownload(t));
}

on('#album-dl', 'click', () => {
  if (!albumTracksList || !albumTracksList.length) { toast('Album still loading…', true); return; }
  downloadAlbumTracks(albumTracksList, 'album');
});

/* ------------------------------ playlist view (fullscreen) ------------------------------ */

// Tracks of the currently open playlist page — the orange play-all button
// starts here, and library rows open this page instead of the inline accordion.
let plvTracksList = null;
let plvPlaylistId = null;

function openPlaylistView(pl) {
  plvPlaylistId = pl.id;
  const artEl = $('#plv-art');
  const cover = pl.tracks.length ? (pl.tracks[0].cover || '') : '';
  const coverHD = upscaleArtHD(cover);
  artEl.innerHTML = coverHD
    ? `<img src="${esc(coverHD)}" alt="" onerror="this.outerHTML='<div class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'" />`
    : `<div class="noimg plv-noimg logo-fallback">${LOGO_FB}</div>`;
  // Cover entrance, re-triggered on every open (same as the album page).
  artEl.classList.remove('album-art-in');
  void artEl.offsetWidth;
  artEl.classList.add('album-art-in');
  // Paint the whole page from the playlist's cover art (orange fallback when
  // the playlist is empty or its first track has no art).
  artToGradient(cover, $('#plv-glow'));
  $('#plv-name').textContent = pl.name;
  const n = pl.tracks.length;
  $('#plv-meta2').textContent = `${n} song${n === 1 ? '' : 's'}`;
  plvTracksList = pl.tracks;
  renderPlaylistTracks();
  // "More on <artist>" — suggested albums + songs after the last track.
  const first = pl.tracks.find((t) => t && t.artist && t.artist !== 'Unknown artist');
  if (first) renderAlbumMore($('#plv-tracks'), first.artist, pl.tracks);
  // Shared-element open: the playlist page grows out of the mini player bar
  // with its cover traveling from the mini cover — same as Now Playing.
  morphOpenOverlay($('#plv-backdrop'), { cover: artEl });
}

function closePlaylistView() {
  morphCloseOverlay($('#plv-backdrop'));
}
function closePlaylistViewInstant() {
  closeOverlay($('#plv-backdrop'), true);
}

on('#plv-close', 'click', closePlaylistView);

// --- playlist view: 15 rows now, 15 more as you scroll ---
let plvPageState = { tracks: null, shown: 0 };
function renderPlvPage() {
  const st = plvPageState;
  if (!st.tracks || st.shown >= st.tracks.length) return;
  const list = $('#plv-tracks');
  const next = Math.min(st.shown + LIST_PAGE, st.tracks.length);
  const moreEl = list.querySelector('.album-more');
  for (let i = st.shown; i < next; i++) {
    const row = albumRowEl(st.tracks[i], i, st.tracks, false, '', { remove: true, dl: false });
    if (moreEl) list.insertBefore(row, moreEl);
    else list.appendChild(row);
  }
  st.shown = next;
}
function plvAutoFill() {
  const list = $('#plv-tracks');
  const st = plvPageState;
  if (!st.tracks || !list.clientHeight) return;
  let guard = 0;
  while (list.scrollHeight <= list.clientHeight + 160 && st.shown < st.tracks.length && guard++ < 50) renderPlvPage();
}
// After a track is removed, re-render and keep the view roughly where the
// user was instead of snapping back to the top.
function plvScrollToIndex(idx) {
  const list = $('#plv-tracks');
  const st = plvPageState;
  // Clamp: removing the last track leaves no row at `idx` — land at the new
  // last row instead of snapping to the top.
  const target = Math.max(0, Math.min(idx, (st.tracks ? st.tracks.length : 0) - 1));
  let guard = 0;
  while (st.tracks && st.shown <= target && st.shown < st.tracks.length && guard++ < 50) renderPlvPage();
  const row = list.children[target];
  if (row) list.scrollTop = Math.max(0, row.offsetTop - 60);
}
$('#plv-tracks').addEventListener('scroll', () => {
  const list = $('#plv-tracks');
  const st = plvPageState;
  if (st.tracks && list.scrollTop + list.clientHeight >= list.scrollHeight - 160) renderPlvPage();
}, { passive: true });

function renderPlaylistTracks() {
  const list = $('#plv-tracks');
  const tracks = plvTracksList || [];
  list.innerHTML = '';
  if (!tracks.length) {
    list.innerHTML = '<div class="row-loading">This playlist is empty.<br>Add songs from any track&rsquo;s ⋮ menu.</div>';
    plvPageState = { tracks: null, shown: 0 };
    return;
  }
  plvPageState = { tracks, shown: 0 };
  renderPlvPage();
  plvAutoFill();
}

on('#plv-play-all', 'click', () => {
  if (!plvTracksList || !plvTracksList.length) { toast('This playlist is empty', true); return; }
  playTrackAt(0, plvTracksList);
  updatePlayingCards();
});

// Playlist header "+" — add the whole playlist into another user playlist.
on('#plv-add-pl', 'click', () => {
  if (!plvTracksList || !plvTracksList.length) { toast('This playlist is empty', true); return; }
  const name = $('#plv-name').textContent || 'playlist';
  openPlaylistPicker({ __album: { name, __tracks: plvTracksList } }, $('#plv-add-pl'));
});

// Playlist header download — batch-download the whole playlist.
on('#plv-dl', 'click', () => {
  if (!plvTracksList || !plvTracksList.length) { toast('This playlist is empty', true); return; }
  downloadAlbumTracks(plvTracksList, 'playlist');
});

// Remove a track from the open playlist (delegated — rows re-render after).
on('#plv-tracks', 'click', (e) => {
  const btn = e.target.closest('[data-plv="rm"]');
  if (!btn) return;
  const row = btn.closest('.album-track');
  if (!row) return;
  const pls = getPlaylists();
  const pl = pls.find((p) => p.id === plvPlaylistId);
  if (!pl) return;
  const t = pl.tracks.find((x) => x.id === row.dataset.id);
  if (!t) return;
  e.stopPropagation();
  const rmIdx = pl.tracks.indexOf(t);
  removeFromPlaylist(pl.id, t.id);
  plvTracksList = pl.tracks;
  renderPlaylistTracks();
  updatePlayingCards();
  const n = pl.tracks.length;
  $('#plv-meta2').textContent = `${n} song${n === 1 ? '' : 's'}`;
  if (rmIdx >= 0) plvScrollToIndex(rmIdx); // keep the view near the removed row
});

// Smart recommendations are app behavior, not a panel: when a queue ends the
// app keeps playing related music (see maybeExtendQueue / nextTrack), and the
// For You row above refreshes itself as you listen.

// Custom name shown in the Home greeting ("Good morning, John"). Editable on
// Home (pencil) and in the Library → Your name. Persisted locally.
const NAME_KEY = 'natsirt_name';
const getUserName = () => { try { return String(localStorage.getItem(NAME_KEY) || '').trim(); } catch { return ''; } };
function setUserName(name) {
  const n = String(name || '').trim();
  try {
    if (n) localStorage.setItem(NAME_KEY, n);
    else localStorage.removeItem(NAME_KEY);
  } catch { /* private mode — ignore */ }
  setGreeting();
  renderLibraryName();
}

// Time-of-day greeting (Spotify's "Good morning / afternoon / evening"), with
// the user's custom name appended — "Good morning, John!". The name is
// edited only in the Library → Your name; no edit button on the greeting.
function setGreeting() {
  const el = $('#home-greeting');
  if (!el) return;
  const h = new Date().getHours();
  const g = (h < 5 || h >= 21) ? 'Good night'
    : h < 12 ? 'Good morning'
    : h < 17 ? 'Good afternoon'
    : 'Good evening';
  const name = getUserName();
  el.innerHTML = name ? `${g}<span class="greet-name">, ${esc(name)}!</span>` : g;
  el.hidden = state.tab !== 'home';
}

function loadHome() {
  state.homeRun++;
  setGreeting();
  // NOTE: the Home filter persists across tab switches (Spotify-like). It
  // only resets when the app restarts (state.homeFilter defaults to 'all').
  homeStartVisit(); // cross-row dedup: no track in two rows this visit
  renderRecently();
  loadMoodsGrid(); // the Moods tiles now live in Home's Browse section
  // Stagger the network rows instead of firing them all at once: on a cold
  // open the home screen used to launch 15-20 YouTube calls in the first
  // seconds (rows + warm preloads) — exactly the burst a bot-checker flags.
  // Each row now starts ~450ms after the previous one, and the engine's
  // politeness queue paces the underlying calls on top of that.
  const rowDelay = (ms) => new Promise((r) => setTimeout(r, ms));
  // Announce the upcoming home-row batch to the Brain so its anticipatory
  // governor spaces the ~15 requests gently from the start.
  if (window.Brain && Brain.noteIntent) Brain.noteIntent('browse');
  (async () => {
    loadTrending();
    await rowDelay(450);
    loadHotThisWeek();
    await rowDelay(450);
    loadPhTrending();
    await rowDelay(450);
    loadAlbums();
    await rowDelay(450);
    loadArtists();
    await rowDelay(450);
    loadForYou();
  })();
}

/* ------------------------------ search ------------------------------ */

async function runSearch(query) {
  recordSearch(query);
  state.searching = true;
  showEmpty(`Searching for “${esc(query)}”…`, true);
  if (window.Brain && Brain.noteIntent) Brain.noteIntent('search');
  loadSearchPlaylists(query); // playlists shelf above the grid (fire-and-forget)
  try {
    const tracks = await MusicEngine.search(query, 30);
    if (state.tab !== 'search') return;
    // Personalize: surface the artists the user actually listens to.
    const ranked = (window.Brain && Brain.rankResults) ? Brain.rankResults(tracks) : tracks;
    // Remember the results — repeating this query (or typing a prefix of it)
    // renders instantly from the suggestion cache while the network refreshes.
    suggCacheSet(query, { tracks: ranked.slice(0, 8) });
    // Learn related artists / genres from this search (co-occurrence).
    if (window.Brain && Brain.learnFromSearch) Brain.learnFromSearch(query, tracks);
    if (ranked && ranked.length) {
      renderSearchResults(ranked);
      renderSearchMore(ranked);
      updatePlayingCards(); // marquee the playing row in the fresh results
    } else showEmpty(`No results for “${esc(query)}”.`);
  } catch (e) {
    if (state.tab === 'search') showEmpty(`Search failed: ${esc(e.message)}`);
  } finally {
    state.searching = false;
  }
}

// The results list is stashed here (not read back from state.queue) because
// the global queue gets replaced whenever another source plays — opening an
// album from the playlists shelf or "More like this" swaps state.queue, so
// resolving taps through it would play the wrong track (or nothing).
let searchResultsTracks = null;

// Render search results: Spotify's song-row list. Play is delegated to ONE
// listener on the grid (bound once below), so re-renders can never leave a
// row unplayable — the fix for taps that used to do nothing after typing.
// NOTE: state.queue/state.index are deliberately NOT touched here — they
// belong to the SESSION that's playing right now. Replacing them while a
// track is playing (typing in Search renders results live) would hijack
// next/prev/crossfade/ended: the current song would end into a search result
// instead of the next album track. Taps resolve through searchResultsTracks
// and playTrackAt() swaps the queue the moment a result is actually played.
function renderSearchResults(tracks) {
  searchResultsTracks = tracks;
  hideEmpty();
  // Expose this list to the Brain: the previous list's unplayed artists are
  // counted as skips (learn from what the user scrolled past), and the new
  // list becomes the current exposure set.
  if (window.Brain && Brain.noteExposed) Brain.noteExposed(tracks);
  const grid = $('#grid');
  grid.hidden = false;
  grid.className = 'search-list'; // switch to list layout
  grid.innerHTML = tracks.slice(0, 25).map((track, i) => `
    <div class="search-item" data-idx="${i}" data-id="${esc(track.id)}" data-name="${esc(track.name)}">
      <span class="si-cover">${coverHtml(track, 'si-img')}</span>
      <div class="si-info">
        <div class="si-name">${esc(track.name)}</div>
        <div class="si-artist">${track.artist ? 'Song • ' + esc(track.artist) : ''}</div>
      </div>
      <span class="si-dur">${fmtDur(track.duration)}</span>
    </div>`).join('');
}

/* --- "More on <artist>" — suggested albums + songs at the end of the
   search results, seeded from the top result's artist. Same treatment as
   the album/playlist pages' More on section. --- */
let searchMoreRun = 0;
function renderSearchMore(tracks) {
  const sec = $('#search-more');
  if (!sec) return;
  const list = (tracks || []).filter((t) => t && t.id);
  const first = list.find((t) => t && t.artist && t.artist !== 'Unknown artist');
  if (!first) { sec.hidden = true; return; }
  const artist = String(first.artist).trim();
  const run = ++searchMoreRun;
  const titleEl = $('#search-more-title');
  if (titleEl) titleEl.textContent = `More on ${artist}`;
  // The rows may have been removed when a previous search found nothing —
  // recreate them so each render starts clean.
  let plRow = $('#search-more-pl');
  let songsRow = $('#search-more-songs');
  if (!plRow) { plRow = document.createElement('div'); plRow.className = 'hrow search-more-pl'; plRow.id = 'search-more-pl'; sec.appendChild(plRow); }
  if (!songsRow) { songsRow = document.createElement('div'); songsRow.className = 'hrow search-more-songs'; songsRow.id = 'search-more-songs'; sec.appendChild(songsRow); }
  plRow.innerHTML = '<p class="row-loading">Finding more…</p>';
  songsRow.innerHTML = '';
  sec.hidden = false;
  const existing = new Set(list.map((t) => t.id));
  (async () => {
    // Albums (playlists matching the artist) + the artist's songs in parallel.
    const [pls, songs] = await Promise.all([
      MusicEngine.playlistSearch(artist, 4).catch(() => []),
      MusicEngine.search(artist, 8, { noVersions: true }).catch(() => []),
    ]);
    if (run !== searchMoreRun || sec.hidden) return;
    const albums = (pls || []).filter((a) => a && a.browseId && !MusicEngine.isIndianTrack(a));
    if (albums.length) {
      plRow.innerHTML = '';
      albums.forEach((a) => { const c = genrePlCard(a); c.classList.add('compact'); plRow.appendChild(c); });
    } else if (plRow.parentNode === sec) plRow.remove();
    const fresh = (songs || []).filter((t) => t && t.id && !existing.has(t.id));
    if (fresh.length) {
      songsRow.innerHTML = '';
      fresh.slice(0, 6).forEach((t) => { const c = makeCard(t, fresh); c.classList.add('compact'); songsRow.appendChild(c); });
    } else if (songsRow.parentNode === sec) songsRow.remove();
    if (plRow.parentNode !== sec && songsRow.parentNode !== sec) sec.hidden = true;
  })();
}

// Delegated tap-to-play on the results list — one listener, bound once.
on('#grid', 'click', (e) => {
  if (state.tab !== 'search') return;
  const item = e.target.closest('.search-item');
  if (!item || item.dataset.idx === undefined) return;
  const idx = Number(item.dataset.idx);
  const tracks = searchResultsTracks;
  const track = tracks && tracks[idx];
  if (!track) return;
  // Positive search signal: the user picked this track from the results.
  if (window.Brain && Brain.notePlayed) Brain.notePlayed(track);
  playTrackAt(idx, tracks);
});

// Search lives in the bottom nav: focusing/typing enters search mode, and the
// suggestions panel shows only while the bar is focused — it closes on blur.
// Tapping the icon/padding around the input focuses it too.
on('#nav-search', 'click', (e) => {
  if (!e.target.closest('input')) $('#search-input').focus();
});
on('#search-input', 'focus', () => {
  if (state.tab !== 'search') switchTab('search');
  refreshLiveSuggestions($('#search-input').value.trim());
  updateSearchBrowse();
  // While typing, BOTH stay up: the bottom nav (so the user can still switch
  // tabs) and the mini player (so playback stays visible). Normal visibility
  // rules keep the mini player on screen whenever a track is loaded; blur
  // (see hideSearchSuggestions) restores anything that was tucked away.
  refreshPlayerVisibility();
});
on('#search-input', 'input', (e) => {
  if (state.tab !== 'search') switchTab('search');
  $('#search-clear').hidden = !e.target.value.trim();
  refreshLiveSuggestions(e.target.value.trim());
  updateSearchBrowse();
});
on('#search-input', 'keydown', (e) => {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (q) {
      runSearch(q);
      e.target.blur(); // done typing — close the suggestions panel + keyboard
    }
  }
});
on('#search-input', 'blur', () => {
  // Suggestions/results are inline sections of the tab — they stay on
  // screen. Blur only restores the mini player + nav and lets Browse all
  // return when the field is empty.
  hideSearchSuggestions();
});

// Simple × button: clears the bar, keeps focus so suggestions re-open.
on('#search-clear', 'click', () => {
  const input = $('#search-input');
  input.value = '';
  $('#search-clear').hidden = true;
  input.focus();
  refreshLiveSuggestions('');
  updateSearchBrowse();
  // Clear any stale results so only the suggestions/browse space remains.
  $('#grid').hidden = true;
});


/* ------------------------------ Recently Played (home tab) ------------------------------ */

// Recently Played — a single-column list (like search results), not tiles.
// Long-pressing a row opens the track menu (with a "remove from history" item).
let recentTracksList = [];
// Recently Played — a horizontal shelf, 4 compact cards per swipe (scroll-snap
// pages). The full list stays swipeable so nothing is hidden.
function renderRecently() {
  const sec = $('#recently');
  if (!sec) return;
  const plays = getPlays().slice(0, 10);
  recentTracksList = plays;
  const row = $('#recently-row');
  row.innerHTML = plays.map((p) => `
    <div class="rec-card" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
      <span class="rec-cover">${coverHtml(p, 'rec-img')}</span>
      <span class="rec-name">${esc(p.name)}</span>
      <span class="rec-artist">${esc(p.artist || '')}</span>
    </div>`).join('');
  sec.hidden = state.tab !== 'home' || plays.length === 0;
}

on('#recently-row', 'click', (e) => {
  const item = e.target.closest('.rec-card');
  if (!item || !item.dataset.id) return;
  const track = recentTracksList.find((x) => x && x.id === item.dataset.id);
  if (track) playTrackAt(recentTracksList.indexOf(track), recentTracksList);
});

/* ------------------------------ For You ------------------------------ */

async function loadForYou() {
  if (state.tab !== 'home') return; // Home-only section — never fight tab visibility
  const more = state.moreLike;
  const plays = getPlays();
  const hist = getHist();
  if (!more && !plays.length && !hist.length) { $('#foryou').hidden = true; return; }
  $('#foryou-reset').hidden = !more;

  let seeds;
  const artistCount = {};
  if (more) {
    seeds = [more.artist];
  } else {
    plays.forEach((p) => {
      const a = String(p.artist || '').trim();
      if (a && a !== 'Unknown artist') artistCount[a] = (artistCount[a] || 0) + 1;
    });
    // The Brain picks seeds from the listening profile: recency-weighted
    // affinities + the last played artist + rediscovery candidates — plus
    // genre queries derived from the same taste (the genres the user
    // actually listens to, learned from artist→genre knowledge).
    if (window.Brain && Brain.suggestSeeds) {
      seeds = Brain.suggestSeeds(3);
      const gq = (Brain.genreQueries && Brain.genreQueries(2)) || [];
      gq.forEach((q) => { if (!seeds.includes(q)) seeds.push(q); });
      // What's CURRENT: a trending artist/query mixes freshness into For You
      // (always appended — the trending memory is a freshness layer, not a
      // gap-filler, so it must fire even when the profile has plenty of seeds).
      if (Brain.trendingQueries) {
        (Brain.trendingQueries(1) || []).forEach((q) => { if (!seeds.includes(q)) seeds.push(q); });
      }
    } else {
      seeds = Object.entries(artistCount)
        .sort((a, b) => b[1] - a[1])
        .map((e) => e[0])
        .slice(0, 3);
    }
    for (const q of hist) {
      if (seeds.length >= 4) break;
      if (!seeds.includes(q)) seeds.push(q);
    }
    // No history yet — fall back to random top artists so For You is never empty.
    if (!seeds.length) seeds = shuffle(POPULAR_ARTISTS).slice(0, 4);
  }
  if (!seeds.length) { $('#foryou').hidden = true; return; }

  const row = $('#foryou-row');
  const sub = $('#foryou-sub');
  row.innerHTML = skeletonRow(6);
  try {
    const results = await Promise.all(
      seeds.map((q) => MusicEngine.search(q, 8, { noVersions: true }).catch(() => null))
    );
    // Learn related artists from the seed searches — genre clustering grows
    // from YouTube's own relevance data every time For You refreshes.
    if (window.Brain && Brain.learnFromSearch) {
      results.forEach((r, idx) => { if (r && r.length) Brain.learnFromSearch(seeds[idx], r); });
    }
    if (state.tab !== 'home') return; // user left Home while fetching — don't reveal For You elsewhere
    const seen = new Map();
    results.forEach((r, idx) => {
      (r || []).forEach((t) => {
        if (!seen.has(t.id)) seen.set(t.id, { ...t, __seed: seeds[idx] });
      });
    });
    let tracks = shuffle(trimRecommendations([...seen.values()]));
    if (!tracks.length) {
      if (more) {
        row.innerHTML = '';
        sub.textContent = `No results for more like ${more.artist} right now.`;
        $('#foryou').hidden = false;
        return;
      }
      $('#foryou').hidden = true;
      return;
    }

    const playedArtists = new Set(Object.keys(artistCount));
    const score = (t) => {
      let s = 0;
      // Strong boost when the Brain knows the artist (recency-weighted
      // affinity), plain boost for any played artist, seed match on top.
      if (window.Brain && Brain.affinity) {
        const a = Brain.affinity(t.artist);
        if (a > 0) s += 1 + Math.min(a, 3);
        else if (playedArtists.has(t.artist)) s += 2;
      } else if (playedArtists.has(t.artist)) {
        s += 2;
      }
      if (t.artist === t.__seed) s += 1;
      return s;
    };
    tracks.sort((a, b) => score(b) - score(a));

    // Never re-suggest tracks the user already played — the old row only
    // deduped against the grid, so favorites kept resurfacing.
    const playedIds = (window.Brain && Brain.recentlyPlayedIds)
      ? new Set(Brain.recentlyPlayedIds())
      : new Set(plays.map((p) => p.id));
    const fresh = tracks.filter((t) => !playedIds.has(t.id));
    if (fresh.length >= 3) tracks = fresh;

    const gridIds = new Set($$('#grid .card').map((c) => c.dataset.id));
    const deduped = tracks.filter((t) => !gridIds.has(t.id));
    tracks = (deduped.length >= 3 ? deduped : tracks).slice(0, 12);
    if (!tracks.length) { $('#foryou').hidden = true; return; }
    // Cross-row dedup: no repeats from the chart rows already shown this visit.
    tracks = homeVariety(homeDedupRow(tracks));
    homeMarkVisit(tracks);

    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    const topArtist = Object.keys(artistCount)[0];
    // Make the genre mix VISIBLE: the top genres from the Brain's listening
    // profile (by affinity weight), so the row isn't just silently seeded
    // with genre searches.
    let genreLabel = '';
    if (!more && window.Brain && Brain.genreProfile) {
      const g = Brain.genreProfile().slice(0, 3).map((e) => e[0]);
      if (g.length) genreLabel = `Based on your genre${g.length === 1 ? '' : 's'}: ${g.join(', ')}`;
    }
    sub.textContent = more
      ? `More like ${more.artist} — based on “${more.track}”.`
      : (genreLabel
          ? `${genreLabel}.`
          : (topArtist
              ? `Because you've been listening to ${topArtist}.`
              : 'Based on your recent searches.'));
    $('#foryou').hidden = false;
  } catch {
    if (more) {
      row.innerHTML = '';
      sub.textContent = `Couldn't load more like ${more.artist} right now.`;
      $('#foryou').hidden = false;
    } else {
      $('#foryou').hidden = true;
    }
  }
}

on('#foryou-reset', 'click', () => {
  state.moreLike = null;
  loadForYou();
});

/* ------------------------------ offline track cache (IndexedDB) ------------------------------ */

// Full-track offline caching: only tracks you explicitly download (the card /
// now-playing download buttons) are saved to IndexedDB — nothing is cached
// automatically. Saved tracks replay from the local copy from then on: instant
// starts, zero buffering, and full playback with NO signal. A 1GB cap keeps
// storage sane; the least-recently-played tracks are evicted automatically.
// Manual downloads jump the queue, and the Library drawer shows every saved
// track with sizes + delete.
//
// Cached copies are served as object-URL blobs to a plain <audio> element:
// blobs are fully seekable, need no MSE, and play muxed or audio-only alike —
// exactly the path the app already uses for CDN-capped tracks.
const CACHE_CAP = 1024 * 1024 * 1024; // 1 GB — evict LRU past this

const OfflineCache = {
  db: null,
  cachedIds: new Set(), // sync mirror of what's cached (UI + skip checks)
  _dlQueue: [],         // { track, btn }
  _dlActive: false,
  _dlVid: null,         // videoId currently downloading (button states)

  init() {
    return new Promise((resolve) => {
      if (!window.indexedDB) { resolve(); return; }
      const req = indexedDB.open('natsirt_tracks', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'videoId' });
      };
      req.onsuccess = () => {
        this.db = req.result;
        // Populate the sync id mirror for cheap UI / skip checks.
        try {
          const tx = this.db.transaction('tracks', 'readonly');
          const cur = tx.objectStore('tracks').openKeyCursor();
          cur.onsuccess = () => { const c = cur.result; if (c) { this.cachedIds.add(String(c.key)); c.continue(); } };
        } catch { /* ignore */ }
        resolve();
      };
      req.onerror = () => resolve(); // storage unavailable — cache disabled
    });
  },

  hasSync(videoId) { return !!videoId && this.cachedIds.has(String(videoId)); },

  get(videoId) {
    if (!this.db || !videoId) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('tracks', 'readonly');
        const req = tx.objectStore('tracks').get(String(videoId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  },

  put(videoId, rec) {
    if (!this.db || !videoId) return Promise.resolve();
    rec.videoId = String(videoId);
    rec.lastPlayed = Date.now();
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').put(rec);
        tx.oncomplete = () => {
          this.cachedIds.add(String(videoId));
          this.evictLru(); // keep the total under the cap
          resolve();
        };
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  },

  remove(videoId) {
    if (!this.db || !videoId) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').delete(String(videoId));
        // Mirror updated only on success — a failed tx must not claim "removed".
        tx.oncomplete = () => { this.cachedIds.delete(String(videoId)); resolve(); };
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  },

  // Refresh lastPlayed so a beloved track isn't the LRU eviction victim.
  // Throttled: the record carries a multi-MB blob, so a replay within 5
  // minutes never rewrites it to disk (pass the lastPlayed read during play).
  touch(videoId, lastPlayed) {
    if (!this.db || !this.cachedIds.has(String(videoId))) return;
    if (lastPlayed && Date.now() - lastPlayed < 5 * 60 * 1000) return;
    try {
      const tx = this.db.transaction('tracks', 'readwrite');
      const st = tx.objectStore('tracks');
      const req = st.get(String(videoId));
      req.onsuccess = () => { const r = req.result; if (r) { r.lastPlayed = Date.now(); st.put(r); } };
    } catch { /* ignore */ }
  },

  list() {
    if (!this.db) return Promise.resolve([]);
    return new Promise((resolve) => {
      const out = [];
      try {
        const tx = this.db.transaction('tracks', 'readonly');
        const cur = tx.objectStore('tracks').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            const v = c.value;
            out.push({ videoId: v.videoId, name: v.name, artist: v.artist, cover: v.cover, duration: v.duration, size: v.size, cachedAt: v.cachedAt, lastPlayed: v.lastPlayed });
            c.continue();
          } else resolve(out);
        };
        cur.onerror = () => resolve(out);
      } catch { resolve(out); }
    });
  },

  totalSize(list) { return (list || []).reduce((s, r) => s + (Number(r.size) || 0), 0); },

  async evictLru() {
    if (!this.db) return;
    const list = await this.list();
    let total = this.totalSize(list);
    if (total <= CACHE_CAP) return;
    list.sort((a, b) => (a.lastPlayed || a.cachedAt || 0) - (b.lastPlayed || b.cachedAt || 0));
    for (const r of list) {
      if (total <= CACHE_CAP) break;
      await this.remove(r.videoId);
      total -= (Number(r.size) || 0);
    }
  },

  clear() {
    this.cachedIds.clear();
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  },
};

// Expose for the window.OfflineCache guards across the app (a top-level const
// is NOT a window property).
window.OfflineCache = OfflineCache;

/* -------- full-track downloader -------- */

const ICON_DL = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 16l-5-5 1.4-1.4 2.6 2.6V3h2v9.2l2.6-2.6L17 11l-5 5zM5 19h14v2H5z"/></svg>';
const ICON_DL_DONE = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
const ICON_DL_SPIN = '<span class="dl-spin" aria-hidden="true"></span>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vidOf = (t) => (t && t.videoId) || (t && t.id && t.id.startsWith('yt:') ? t.id.slice(3) : '') || '';

// Fetch the complete track into a Blob. Tries the audio-only stream first
// (smaller files); if it's capped (403 / whole-file 200), restarts from the
// range-capable muxed stream (muxedStreamUrl — the same fallback the MSE
// player uses; cached copies play fine through plain <audio>).
async function fetchTrackBlob(track, onProgress) {
  const vid = vidOf(track);
  if (!vid) throw new Error('No video id for this track');
  const stream = await MusicEngine.streamUrl(vid);
  let url = stream.url;
  let mime = 'audio/mp4';
  let total = 0;
  let switched = false;
  // Every request rides a deadline — a hung relay must fail the download,
  // never wedge the download queue forever (same policy as the engine's
  // fetchT/readBody guards).
  const CHUNK_TIMEOUT = 30000;
  const fetchChunk = async (u, range) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT);
    try {
      return await fetch(u, { credentials: 'omit', signal: ctl.signal, headers: { Range: range } });
    } finally { clearTimeout(t); }
  };
  const probe = async (u) => {
    const res = await fetchChunk(u, 'bytes=0-0');
    const cr = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
    return { total: cr ? Number(cr[1]) : 0, ct: res.headers.get('content-type') || '', status: res.status };
  };
  let p = await probe(url);
  if (p.status === 200 || p.status === 403 || p.status === 416 || !p.ct.startsWith('audio/')) {
    url = muxedStreamUrl(stream.url);
    p = await probe(url);
    switched = true;
  }
  total = p.total;
  mime = p.ct || 'audio/mp4';
  if (!(total > 0)) throw new Error('Couldn\'t determine track size');
  const CHUNK = 512 * 1024;
  const parts = [];
  let pos = 0;
  while (pos < total) {
    // While the app is struggling to stream, hold off — the music comes first.
    while (state.buffering && pos > 0) { await sleep(1500); }
    const to = Math.min(total - 1, pos + CHUNK - 1);
    const res = await fetchChunk(url, `bytes=${pos}-${to}`);
    if (!switched && (res.status === 403 || res.status === 404 || res.status === 200)) {
      // Audio-only capped (403) or the relay answered the whole-file muxed
      // stream (200) — restart the download from the range-capable muxed URL.
      url = muxedStreamUrl(stream.url);
      p = await probe(url);
      if (!(p.total > 0)) throw new Error('Couldn\'t determine track size');
      total = p.total;
      mime = p.ct || 'audio/mp4';
      pos = 0;
      parts.length = 0;
      switched = true;
      continue;
    }
    if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A zero-length chunk means the stream stopped early — cache nothing, or
    // a truncated copy would play to a premature end.
    if (!buf.byteLength) throw new Error('Stream ended early');
    parts.push(buf);
    pos += buf.byteLength;
    if (onProgress) onProgress(Math.min(99, Math.round((pos / total) * 100)));
    // Gentle pacing: a pause between chunks so background downloads never
    // starve the live stream sharing the same connection.
    await sleep(1200);
  }
  // size = actual downloaded bytes (pos === total on a clean run).
  return { blob: new Blob(parts, { type: mime }), size: pos, mime };
}

// Queue a track for download (sequential worker — one download at a time).
// Only manual requests (the card / now-playing download buttons) enqueue here.
function enqueueDownload(track, { btn = null } = {}) {
  const vid = vidOf(track);
  if (!vid || !window.indexedDB || !OfflineCache.db) {
    toast('Offline downloads aren\'t available on this device', true);
    return;
  }
  if (OfflineCache.hasSync(vid) || OfflineCache._dlVid === vid) {
    toast(OfflineCache.hasSync(vid) ? 'Already saved for offline' : 'Already downloading');
    return;
  }
  if (OfflineCache._dlQueue.some((q) => vidOf(q.track) === vid)) {
    toast('Queued for download');
    return;
  }
  const item = { track, btn };
  OfflineCache._dlQueue.unshift(item); // a fresh request jumps the queue
  refreshDownloadButtons();
  pumpDownloads();
}

async function pumpDownloads() {
  if (OfflineCache._dlActive || !OfflineCache._dlQueue.length || !OfflineCache.db) return;
  OfflineCache._dlActive = true;
  while (OfflineCache._dlQueue.length) {
    const item = OfflineCache._dlQueue.shift();
    const vid = vidOf(item.track);
    if (!vid || OfflineCache.hasSync(vid)) continue;
    OfflineCache._dlVid = vid;
    refreshDownloadButtons();
    try {
      toast(`Downloading “${item.track.name}”…`);
      const { blob, size, mime } = await fetchTrackBlob(item.track, (pct) => {
        if (item.btn) { item.btn.classList.add('busy'); item.btn.title = `Downloading… ${pct}%`; }
      });
      await OfflineCache.put(vid, {
        videoId: vid, blob, size, mime,
        name: item.track.name || 'Unknown', artist: item.track.artist || '',
        cover: item.track.cover || '', duration: item.track.duration || 0,
        cachedAt: Date.now(), lastPlayed: Date.now(),
      });
      toast(`Saved “${item.track.name}” for offline`);
    } catch (e) {
      toast(`Download failed: ${esc(e.message)}`, true);
    } finally {
      OfflineCache._dlVid = null;
      refreshDownloadButtons();
      renderDownloads();
    }
  }
  OfflineCache._dlActive = false;
}

// Reflect download state on every visible download button.
function refreshDownloadButtons() {
  $$('.cov-btn[data-act="dl"]').forEach((b) => {
    const vid = b.dataset.vid || (state.currentTrack ? vidOf(state.currentTrack) : '');
    const downloading = OfflineCache._dlVid === vid;
    const done = OfflineCache.hasSync(vid);
    b.classList.toggle('busy', downloading);
    b.classList.toggle('done', done);
    b.innerHTML = downloading ? ICON_DL_SPIN : (done ? ICON_DL_DONE : ICON_DL);
    b.title = done ? 'Saved for offline — tap to remove' : (downloading ? 'Downloading…' : 'Download for offline');
  });
  // Album/playlist row download icons too.
  $$('.row-dl').forEach((b) => {
    const vid = b.dataset.vid || '';
    const downloading = OfflineCache._dlVid === vid;
    const done = OfflineCache.hasSync(vid);
    b.classList.toggle('busy', downloading);
    b.classList.toggle('done', done);
    b.innerHTML = downloading ? ICON_DL_SPIN : (done ? ICON_DL_DONE : ICON_DL);
    b.title = done ? 'Saved for offline — tap to remove' : (downloading ? 'Downloading…' : 'Download for offline');
  });
}

// Manual download from a card or the now-playing view. Tapping an already-
// saved track removes it.
function dlTrack(track, btn) {
  const vid = vidOf(track);
  if (!vid) { toast('This track can\'t be saved', true); return; }
  if (OfflineCache.hasSync(vid)) {
    OfflineCache.remove(vid).then(() => {
      refreshDownloadButtons();
      renderDownloads();
      toast('Removed from offline downloads');
    });
    return;
  }
  enqueueDownload(track, { btn: btn || null });
}

// Render the Library drawer's Downloads section (count, total size, list).
function renderDownloads() {
  const list = $('#downloads-list');
  if (!list) return;
  OfflineCache.list().then((recs) => {
    const summary = $('#dl-summary');
    if (summary) {
      const mb = (OfflineCache.totalSize(recs) / (1024 * 1024)).toFixed(1);
      summary.textContent = recs.length ? `${recs.length} track${recs.length === 1 ? '' : 's'} • ${mb} MB` : '';
    }
    const clear = $('#dl-clear');
    if (clear) clear.hidden = recs.length === 0;
    list.innerHTML = '';
    if (!recs.length) {
      const li = document.createElement('li');
      li.className = 'lib-item';
      li.innerHTML = '<div class="meta"><div class="t" style="font-weight:500">No offline downloads yet.</div><div class="a">Tap the download icon on any song to save it — nothing saves automatically.</div></div>';
      list.appendChild(li);
      return;
    }
    recs.sort((a, b) => (b.lastPlayed || b.cachedAt || 0) - (a.lastPlayed || a.cachedAt || 0));
    recs.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'lib-item';
      li.dataset.id = r.videoId;
      const mb = ((r.size || 0) / (1024 * 1024)).toFixed(1);
      li.innerHTML = `
        ${r.cover
          ? `<img src="${esc(r.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;lib-noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'" />`
          : `<div class="lib-noimg logo-fallback">${LOGO_FB}</div>`}
        <div class="meta">
          <div class="t">${esc(r.name)}</div>
          <div class="a">${esc(r.artist)} • ${mb} MB</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="mini-btn" data-dl="play" title="Play">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="mini-btn del" data-dl="del" title="Delete download">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>`;
      li.querySelector('[data-dl="play"]').addEventListener('click', () => {
        playTrackAt(0, [{ ...r, id: `yt:${r.videoId}`, source: 'youtube' }]);
      });
      li.querySelector('[data-dl="del"]').addEventListener('click', () => {
        OfflineCache.remove(r.videoId).then(() => {
          renderDownloads();
          refreshDownloadButtons();
          toast(`Removed “${r.name}” from downloads`);
        });
      });
      list.appendChild(li);
    });
  });
}

on('#dl-clear', 'click', () => {
  OfflineCache.clear().then(() => {
    renderDownloads();
    refreshDownloadButtons();
    toast('Cleared all offline downloads');
  });
});

/* ------------------------------ MSE bounded-buffer playback ------------------------------ */

// High-quality, data-frugal playback: instead of handing the whole track to
// <audio> (the browser buffers as much as it wants), the app plays through a
// MediaSource fed by EXCLUSIVE byte-range requests from the high-quality
// stream URL. Only a strict 10-15s lookahead window is ever buffered:
//   • first chunk: bytes 0 → 15s (playback starts at 0)
//   • refill: when less than ~6s remains buffered ahead, fetch the next ~12s
//     range (never starting below the 3s mark, except the very first chunk)
//   • evict: buffered data beyond 15s ahead (and before 2s behind) is dropped
//   • seek: outside the window → clear + re-chunk from the new position
// The stream URL still goes through the relay (Range-aware), so no whole-track
// download ever happens and the seek line shows the real short buffer.
// Adaptive buffer windows per streaming tier. The whole point is smooth,
// uninterrupted playback: on a FAST connection a strict short lookahead is
// data-frugal (never downloads the whole track), while on a SLOW connection
// the player buffers far more so playback glides through network dips
// instead of stalling. The tier comes from MusicEngine (Auto adapts to the
// live connection; High/Standard/Low pin it). The config is captured per
// session (s.cfg) so a tier change never mutates a running session's window.
// CHUNK_TIMEOUT bounds every byte-range fetch (ms) — a relay that accepts the
// connection but never answers must abort instead of freezing the refill loop.
// The refill thresholds keep a generous cushion (refill starts at REFILL_AHEAD
// and tops out at MAX_AHEAD) so a slow chunk download can't drain the buffer
// into an audible pause; the tighter poll keeps refills snappy after a success.
const MSE_CFG_FAST = { CHUNK_SEC: 12, FIRST_CHUNK_SEC: 15, REFILL_AHEAD: 10, MAX_AHEAD: 25, KEEP_BACK: 2, MIN_START_SEC: 3, POLL_MS: 250, CHUNK_RETRIES: 1, CHUNK_TIMEOUT: 10000 };
const MSE_CFG_STANDARD = { CHUNK_SEC: 20, FIRST_CHUNK_SEC: 30, REFILL_AHEAD: 30, MAX_AHEAD: 70, KEEP_BACK: 2, MIN_START_SEC: 3, POLL_MS: 200, CHUNK_RETRIES: 2, CHUNK_TIMEOUT: 12000 };
const MSE_CFG_SLOW = { CHUNK_SEC: 30, FIRST_CHUNK_SEC: 45, REFILL_AHEAD: 60, MAX_AHEAD: 130, KEEP_BACK: 2, MIN_START_SEC: 3, POLL_MS: 200, CHUNK_RETRIES: 3, CHUNK_TIMEOUT: 15000 };
function mseCfg() {
  const tier = (window.MusicEngine && MusicEngine.streamTier) ? MusicEngine.streamTier() : 'high';
  let cfg = tier === 'low' ? MSE_CFG_SLOW : tier === 'standard' ? MSE_CFG_STANDARD : MSE_CFG_FAST;
  // Truncation cushion: repeated mid-chunk cuts widen the buffer window one
  // step beyond the tier's default (FAST → STANDARD → SLOW), so slow cellular
  // keeps a more forgiving lookahead even when the quality tier is pinned.
  const cushion = (window.MusicEngine && MusicEngine.truncationCushion) ? (MusicEngine.truncationCushion() || 0) : 0;
  if (cushion > 0) {
    const chain = [MSE_CFG_FAST, MSE_CFG_STANDARD, MSE_CFG_SLOW];
    const idx = chain.indexOf(cfg);
    if (idx >= 0) cfg = chain[Math.min(chain.length - 1, idx + cushion)];
  }
  return cfg;
}

const mseCodec = (ct) => {
  const t = String(ct || '').toLowerCase();
  // Audio-only codecs only — the app never streams video.
  if (t.includes('mp4')) return { audio: 'audio/mp4; codecs="mp4a.40.2"' };
  if (t.includes('webm')) return { audio: 'audio/webm; codecs="opus"' };
  return null;
};

// CDN-cap detection. YouTube's anonymous audio-only URLs are hard-capped at
// ~1MB on many edge nodes (verified on-device: even fresh signed URLs 403 any
// byte range past the cap). A stream whose served total is implausibly small
// for the track's real duration can never play end-to-end — the player must
// escape to the relay's full-length MUXED stream instead of stalling at the
// cap or ending the song early. 6000 B/s ≈ the smallest real audio-only
// format (48kbps opus); anything below that for the whole track is capped.
const MSE_MIN_BPS = 6000;
function mseCapped(s) {
  return !!s && s.total > 0 && Number.isFinite(s.duration) && s.duration > 0
    && s.total < s.duration * MSE_MIN_BPS;
}

// Cap status per stream URL, learned by the deep probe once per session so
// repeat plays of the same track (same URL) skip the extra round-trip. The
// relay signs URLs that are stable per video+tier, so the URL is a safe key.
const mseCapCache = new Map(); // url -> boolean (true = capped → muxed)
function mseCapKnown(url) { return mseCapCache.has(url) ? mseCapCache.get(url) : null; }
function mseCapRemember(url, capped) {
  if (mseCapCache.size > 200) mseCapCache.clear(); // keep the map bounded
  mseCapCache.set(url, capped);
}

// Abort any running MSE session on an element and free its MediaSource.
function mseTeardown(el) {
  const s = el && el._mse;
  if (!s) return;
  s.dead = true;
  try { if (s.ms && s.ms.readyState === 'open') s.ms.endOfStream(); } catch { /* ignore */ }
  try { if (s.msUrl) URL.revokeObjectURL(s.msUrl); } catch { /* ignore */ }
  try { el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
  el._mse = null;
  if (state.mse === s) state.mse = null;
}

// Append a buffer to the SourceBuffer, resolving on updateend (or rejecting on
// an error). Used for init segments and media chunks alike.
function mseAppend(s, buf) {
  return new Promise((resolve, reject) => {
    const done = () => { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); resolve(); };
    const fail = () => { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); reject(new Error('SourceBuffer append failed')); };
    s.sb.addEventListener('updateend', done);
    s.sb.addEventListener('error', fail);
    try { s.sb.appendBuffer(buf); } catch (e) { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); reject(e); }
  });
}

// Fetch one byte range from the stream URL and append it to the SourceBuffer.
// Every fetch is bounded by CHUNK_TIMEOUT: a relay/CDN socket that accepts the
// connection but never answers would otherwise leave s.fetching stuck true and
// freeze the whole refill loop — the #1 cause of the "stalls and needs an app
// restart" bug. On timeout the fetch rejects and the scheduler's recovery
// chain (chunk retry → fresh URL → plain <audio>) takes over.
async function mseFetchChunk(s, startByte) {
  if (s.dead) return;
  if (startByte >= s.total) {
    // A capped audio-only URL (CDN ~1MB limit) ends the file way before the
    // track does — ending the session here would end the SONG early (the
    // "sudden stop"). Escape to the full-length muxed stream instead.
    if (mseCapped(s)) throw new Error('Muxed stream (capped)');
    s.loadedEnd = s.total; mseMaybeEnd(s); return;
  }
  // Refill chunks never begin below the 3s mark (the first chunk starts at 0).
  const minStart = Math.floor(s.bps * s.cfg.MIN_START_SEC);
  const from = Math.max(startByte, s.chunkSeq > 0 ? minStart : 0);
  if (from >= s.total) {
    if (mseCapped(s)) throw new Error('Muxed stream (capped)');
    s.loadedEnd = s.total; mseMaybeEnd(s); return;
  }
  // Byte ranges must be whole numbers — a float like bytes=0-194228.69 is a
  // malformed Range header and the WebView rejects it ("Failed to fetch").
  // The FIRST chunk is bigger than the steady-state chunks (FIRST_CHUNK_SEC
  // vs CHUNK_SEC) so a fresh session starts with a deep initial cushion —
  // the very first boundary is the one a slow connection drains fastest.
  const firstSecs = s.chunkSeq === 0 ? (s.cfg.FIRST_CHUNK_SEC || s.cfg.CHUNK_SEC) : s.cfg.CHUNK_SEC;
  const chunkBytes = Math.max(64 * 1024, Math.floor(s.bps * firstSecs));
  const to = Math.min(s.total - 1, Math.floor(from + chunkBytes));
  const t0 = Date.now();
  const ctl = new AbortController();
  s.fetchCtl = ctl; // the stall-kick can abort an in-flight chunk
  s.lastFetchStart = t0;
  const timer = setTimeout(() => ctl.abort(), s.cfg.CHUNK_TIMEOUT);
  let res;
  try {
    res = await fetch(s.url, { credentials: 'omit', signal: ctl.signal, headers: { Range: `bytes=${from}-${to}` } });
  } catch (e) {
    // AbortError means the timeout/stall-kick fired — a transient network
    // hang, retried by the scheduler exactly like any other chunk failure.
    throw new Error(String((e && e.name) || '') === 'AbortError' ? 'chunk timeout' : (e && e.message) || 'chunk fetch failed');
  } finally {
    clearTimeout(timer);
    s.fetchCtl = null;
  }
  if (res.status === 416) {
    // Past the cap (Range Not Satisfiable) is the classic capped-URL
    // signature — the audio-only file simply ends here. Escape to muxed.
    if (mseCapped(s)) throw new Error('Muxed stream (capped)');
    s.loadedEnd = s.total; mseMaybeEnd(s); return;
  }
  if (res.status === 200) {
    // A 200 (not 206) answer to a byte-range request means the relay fell back
    // to its whole-file muxed stream — the audio-only URL is CDN-capped past
    // ~1MB. Abort without downloading the whole muxed file; the refill catch
    // hands off to the plain <audio> element, which plays it directly.
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch { /* ignore */ }
    throw new Error('Muxed whole-file fallback');
  }
  // 403/5xx past the cap on a capped session is the same story — a fresh
  // audio-only URL is capped again, so don't burn retries on it.
  if (!res.ok) {
    if (mseCapped(s)) throw new Error('Muxed stream (capped)');
    throw new Error(`range HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  if (s.dead || !s.sb) return;
  // Feed the real download speed to MusicEngine — in Auto quality mode it
  // steps the streaming tier up/down from exactly this data.
  const dt = Date.now() - t0;
  if (dt > 40 && window.MusicEngine && MusicEngine.noteChunkSpeed) {
    MusicEngine.noteChunkSpeed(buf.byteLength / (dt / 1000));
  }
  s.chunkSeq++;
  s.chunkRetries = 0; // a success clears the retry budget for this range
  await mseAppend(s, buf);
  // Track the REAL appended end, never the requested range end. A truncated
  // body (relay/CDN hiccup mid-chunk on cellular; the relay streams whatever
  // arrived and closes) must NOT advance loadedEnd past the actual data — the
  // next chunk would start over a hole, the SourceBuffer can't tile, and
  // playback stalls exactly where the gap begins (the "stuck at 00:31" bug).
  // Starting the next fetch at the true end keeps the buffer contiguous and
  // self-heals a short read with NO retry/teardown.
  const expected = to - from + 1;
  s.loadedEnd = from + buf.byteLength;
  if (buf.byteLength < expected) {
    // Diagnose short reads; the scheduler refills from the real end next poll.
    console.warn(`[mse] short chunk: wanted ${expected} B, got ${buf.byteLength} B (from ${from})`);
    // A mid-chunk cut is a strong signal the current stream is too big for
    // the connection: step the streaming tier down (repeated cuts), and
    // widen THIS session's buffer window immediately — a bigger chunk + an
    // earlier refill make the next cut survivable instead of a stall.
    if (window.MusicEngine && MusicEngine.noteChunkTruncation) {
      try { MusicEngine.noteChunkTruncation(); } catch { /* never break playback */ }
    }
    const chain = [MSE_CFG_FAST, MSE_CFG_STANDARD, MSE_CFG_SLOW];
    const idx = chain.indexOf(s.cfg);
    if (idx >= 0 && idx < chain.length - 1) s.cfg = chain[idx + 1];
  }
  if (buf.byteLength === 0) {
    // The server answered with an empty body — loadedEnd made no progress, so
    // the next poll would re-fetch the SAME range forever and freeze the
    // scheduler. Treat it as a failure so the retry chain (fresh URL → plain
    // audio) takes over instead of a silent stall.
    throw new Error('empty chunk');
  }
  if (s.loadedEnd >= s.total) mseMaybeEnd(s);
}

function mseMaybeEnd(s) {
  if (s.eos || s.dead || !s.ms) return;
  s.eos = true;
  try { if (s.ms.readyState === 'open') s.ms.endOfStream(); } catch { /* ignore */ }
}

// Keep the buffered window strict: drop data behind KEEP_BACK and beyond MAX_AHEAD.
function mseEvict(s) {
  if (!s.sb || s.sb.updating || !s.el || !s.el.buffered) return;
  const keepStart = Math.max(0, s.el.currentTime - s.cfg.KEEP_BACK);
  const keepEnd = s.el.currentTime + s.cfg.MAX_AHEAD;
  try {
    for (let i = 0; i < s.sb.buffered.length; i++) {
      const r = s.sb.buffered.start(i);
      const e = s.sb.buffered.end(i);
      if (e <= keepStart || r >= keepEnd) continue;
      if (r < keepStart) s.sb.remove(r, Math.min(e, keepStart));
      if (e > keepEnd) s.sb.remove(Math.max(r, keepEnd), e);
    }
  } catch { /* ignore */ }
}

// Pin a plain <audio> fallback to the relay's MUXED (video+audio) stream: the
// on-device relay then routes EVERY media-stack range request straight to the
// muxed CDN URL — which serves proper 206 range responses (seekable), instead
// of re-hitting the CDN-capped audio-only URL. Other relays ignore the param.
// Only relay stream endpoints understand it — a direct piped/innertube URL
// must never get a bogus query param tacked on.
function muxedStreamUrl(url) {
  if (!url || !url.includes('/stream')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'muxed=1';
}

/* ------------------------------ embed fallback (no relay needed) ------------------------------ */

// LAST-RESORT playback path: when every relay + direct source fails (PC off,
// tunnel down, Worker bot-blocked — verified: the whole fallback chain dies
// on an iPhone when none of them answer), play through YouTube's OWN embed
// player. A hidden iframe asks YouTube to play the video directly — YouTube
// serves the audio itself, so NO relay, tunnel, Worker, or PC is involved.
// Verified on the live site: the embed autoplays, keeps playing while hidden,
// and needs nothing but YouTube being reachable.
//
// Trade-offs vs the relay path (why it's last-resort): it's the VIDEO player
// hidden off-screen (YouTube may throttle fully-invisible embeds — we keep it
// 1px-opacity + off-screen, which plays fine in testing), seeking is coarser
// (no MSE byte ranges), there's no crossfade/preload, and iOS Safari pauses
// audio when the phone locks or the tab backgrounds (same as any web audio).
const EmbedPlay = (() => {
  let apiReady = false;
  let player = null;       // YT.Player instance
  let container = null;    // the hidden <div> the player lives in
  let playing = false;     // currently playing through the embed
  let current = null;      // { track, videoId, dur } playing now
  let poll = null;         // seek-line pump while playing
  let pending = null;      // onStateChange queue while loading

  // Load the IFrame API once; resolves when window.YT is usable.
  function loadAPI() {
    if (apiReady) return Promise.resolve();
    if (loadAPI._p) return loadAPI._p;
    loadAPI._p = new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      // The API calls window.onYouTubeIframeAPIReady when loaded. Stash any
      // existing handler (other code) and chain ours.
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        apiReady = true;
        if (prev) prev();
        resolve();
      };
      document.head.appendChild(tag);
    });
    return loadAPI._p;
  }

  // Create the hidden player lazily (only when first needed).
  function ensurePlayer() {
    return loadAPI().then(() => new Promise((resolve) => {
      if (player) return resolve(player);
      container = document.createElement('div');
      container.id = 'embed-player';
      container.style.cssText = 'position:fixed;left:-9999px;top:0;width:240px;height:180px;opacity:0.01;z-index:-1;pointer-events:none';
      document.body.appendChild(container);
      player = new YT.Player('embed-player', {
        width: '240', height: '180',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, controls: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => resolve(player),
          onStateChange: (e) => handleState(e.data),
          onError: () => {},
        },
      });
    }));
  }

  function handleState(code) {
    // YT states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    const vidNow = (() => { try { return player && player.getVideoData ? player.getVideoData().video_id : ''; } catch { return ''; } })();
    if (code === 1) {
      playing = true;
      setBuffering(false);
      updatePlayIcon(true);
      if (current && current.track) recordPlay(current.track);
      startPoll();
      // A play() was waiting for this video to actually start.
      if (pending && pending.want === vidNow) { const p = pending; pending = null; p.resolve(); }
    } else if (code === 2) {
      playing = false;
      updatePlayIcon(false);
      stopPoll();
    } else if (code === 3) {
      setBuffering(true);
    } else if (code === 0) {
      playing = false;
      updatePlayIcon(false);
      stopPoll();
      // A stale 'ended' from the PREVIOUS video (we just switched) must not
      // advance the queue — only advance when the CURRENT embed video ended.
      if (!vidNow || (current && vidNow !== current.videoId)) return;
      nextTrack();
    }
  }

  // Pump the seek line + time labels while embed is playing (no timeupdate
  // events from a hidden iframe — poll getCurrentTime instead).
  function startPoll() {
    stopPoll();
    poll = setInterval(() => {
      if (!player || !playing || !current) return;
      try {
        const t = player.getCurrentTime() || 0;
        const d = player.getDuration() || current.dur || 0;
        if (d > 0) {
          const v = Math.round((t / d) * 1000);
          if (!npSeekScrubbing) { $('#seek').value = v; $('#np-seek').value = v; }
          $('#t-cur').textContent = fmtDur(t);
          $('#t-total').textContent = fmtDur(d);
          $('#np-t-cur').textContent = fmtDur(t);
          $('#np-t-total').textContent = fmtDur(d);
          const pct = Math.min(100, (t / d) * 100);
          const nsf = $('#np-seek-fill');
          if (nsf) nsf.style.transform = `translateY(-50%) scaleX(${(pct / 100).toFixed(4)})`;
          const mpf = $('#mini-progress-fill');
          if (mpf) mpf.style.transform = `scaleX(${(t / d).toFixed(4)})`;
          const npf = $('#np-progress-fill');
          if (npf) npf.style.transform = `scaleX(${(t / d).toFixed(4)})`;
        }
      } catch { /* player mid-load */ }
    }, 500);
  }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  // Play a track through the embed. Resolves when it actually starts.
  function play(track) {
    const vid = track.videoId || (String(track.id || '').startsWith('yt:') ? String(track.id).slice(3) : '');
    if (!vid) return Promise.reject(new Error('No video id for embed'));
    current = { track, videoId: vid, dur: track.duration || 0 };
    setBuffering(true);
    updatePlayIcon(false);
    return ensurePlayer().then(() => new Promise((resolve, reject) => {
      pending = { resolve, reject, want: vid };
      try {
        player.loadVideoById(vid);
        player.setVolume(Math.round((state.userVol || 0.8) * 100));
        player.playVideo();
      } catch (e) {
        if (pending) pending = null;
        reject(e);
      }
      // Safety: if the video never starts within 15s, give up so the app can
      // show a real error instead of buffering forever.
      setTimeout(() => {
        if (pending) { const p = pending; pending = null; p.reject(new Error('Embed timed out')); }
      }, 15000);
    }));
  }

  function isPlaying() { return playing; }
  function isActive() { return !!player && !!current; }
  function pause() { try { if (player) player.pauseVideo(); playing = false; updatePlayIcon(false); } catch { /* ignore */ } }
  function resume() { try { if (player) player.playVideo(); playing = true; updatePlayIcon(true); } catch { /* ignore */ } }
  function seekTo(sec) { try { if (player) player.seekTo(sec, true); } catch { /* ignore */ } }
  function currentTime() { try { return player ? (player.getCurrentTime() || 0) : 0; } catch { return 0; } }
  function duration() { try { return player ? (player.getDuration() || (current && current.dur) || 0) : 0; } catch { return (current && current.dur) || 0; } }
  // Full stop: unload the video, clear state, remove the player (fresh start
  // next time — the API stays loaded, only the instance is freed).
  function stop() {
    stopPoll();
    playing = false;
    current = null;
    pending = null;
    try { if (player && player.destroy) player.destroy(); } catch { /* ignore */ }
    player = null;
    if (container && container.parentNode) container.parentNode.removeChild(container);
    container = null;
  }
  function setVolume(v) { try { if (player) player.setVolume(Math.round(v * 100)); } catch { /* ignore */ } }

  return { play, pause, resume, seekTo, stop, isActive, isPlaying, currentTime, duration, setVolume };
})();

// Shared LAST-RESORT: when the relay/direct chain has failed (PC off, tunnel
// down, Worker bot-blocked), try the embed player for this track. Returns
// true if it started. Called from the stream-resolve catch, the <audio>
// load path, and handleMediaError's exhausted retries.
async function tryEmbedFallback(track) {
  if (!track || track.source !== 'youtube') return false;
  if (state.playingId !== track.id) return false;
  if (EmbedPlay.isActive()) return true; // already playing through embed
  try {
    await EmbedPlay.play(track);
    recordPlay(track);
    return true;
  } catch { return false; }
}

// Seek a plain <audio> element once it CAN be seeked. The muxed-fallback
// stream only becomes seekable after the media stack parses the init (moov at
// the file tail) — before that, seekable is empty and setting currentTime
// makes this WebView RELOAD FROM 0 (the bug). Apply immediately when the
// range is already seekable, otherwise poll briefly and apply as soon as it
// is. Never resets playback — the seek either lands or is quietly dropped.
function seekAudioQueued(el, target, timeoutMs = 8000) {
  if (!el || !Number.isFinite(target) || target < 0) return;
  // Generation token: a newer queued seek (or a fresh session on this element)
  // invalidates any older poller still running, so overlapping slider events
  // never fight over the playhead.
  const token = (el._seekTok = (el._seekTok || 0) + 1);
  const apply = () => {
    try {
      // Only the latest queued seek may land, and only while this element is
      // still the active player (a track change / crossfade swap must not get
      // yanked to a stale position).
      if (el._seekTok !== token || el !== curEl()) return false;
      if (el.seekable && el.seekable.length > 0) {
        const last = el.seekable.length - 1;
        const start = el.seekable.start(0);
        const end = el.seekable.end(last);
        // A degenerate [0,0] range means the stream is NOT range-capable —
        // clamping `target > end` to end=0 would RESTART the track from 0.
        // Only honor real ranges (end > start) and otherwise keep polling.
        if (end > start) {
          if (target >= start && target <= end) { el.currentTime = target; return true; }
          if (target > end) { el.currentTime = end; return true; }
        }
      }
    } catch { /* ignore */ }
    return false;
  };
  if (apply()) return;
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (apply() || Date.now() - t0 > timeoutMs) clearInterval(timer);
  }, 250);
}

// Hand the ACTIVE MSE session off to the plain <audio> element at the current
// position. Used when MSE truly can't continue: the relay answered the
// whole-file muxed stream (CDN-capped audio-only URL — plain audio decodes
// muxed MP4s, MSE can't), or the MSE retry for a transient blip failed.
// forceMuxed pins the element to the muxed stream (seekable ranges); plain
// keeps the lighter audio-only URL for genuinely uncapped tracks.
function mseHandoff(s, forceMuxed = false) {
  const el = s.el;
  const pos = el.currentTime;
  mseTeardown(el);
  const src = forceMuxed ? muxedStreamUrl(s.url) : s.url;
  try { el.src = src; el.load(); } catch { /* ignore */ }
  setBuffering(true);
  el.play().catch(() => { /* plain-audio error listener takes over */ });
  // A direct currentTime set on the freshly-loaded stream would restart from 0
  // (empty seekable) — queue it so the handoff lands where playback was.
  seekAudioQueued(el, pos);
}

// Retry the ACTIVE MSE session once with a fresh signed URL so a brief network
// blip doesn't permanently drop the strict 10-15s bounded buffer. Invalidates
// the stream (the relay signs a new URL — fresh URLs are often uncapped) and
// restarts MSE from the current position. Returns true if a new session is
// running; false if the retry couldn't start (caller hands off to plain audio).
async function mseRetryOnce(s) {
  const track = s.track;
  const vid = track && (track.videoId || String(track.id || '').replace('yt:', ''));
  if (!vid || !window.MusicEngine || s.dead || state.mse !== s) return false;
  try {
    const raw = s.el.currentTime;
    const pos = (Number.isFinite(raw) && raw > 0) ? Math.min(s.duration || 0, raw) : 0;
    // Re-buffering MSE from byte 0 up to a late position downloads MORE than
    // the plain <audio> fallback (which streams only the remainder) — past the
    // halfway point, hand off instead of re-buffering.
    if ((track.duration || 0) > 0 && pos > (track.duration / 2)) return false;
    MusicEngine.invalidateStream(vid);
    const stream = await MusicEngine.streamUrl(vid);
    if (state.playingId !== track.id || state.mse !== s || s.dead) return false;
    // mseStart tears the old session down and starts its own scheduler.
    await mseStart(s.el, track, stream.url, { play: true, seekTo: pos });
    return true;
  } catch (e) {
    // A fresh URL that is ALSO CDN-capped hands the relay's muxed stream to
    // mseStart, which can't parse it — callers pin the handoff to the muxed
    // (range-capable) stream instead of the capped audio-only URL.
    return String((e && e.message) || '').includes('Muxed') ? 'muxed' : false;
  }
}

// Buffer scheduler: refill when the lookahead dips below REFILL_AHEAD.
function mseSchedule(s) {
  const tick = async () => {
    if (s.dead || s.eos || !s.el._mse) return;
    mseEvict(s);
    if (s.fetching) { setTimeout(tick, s.cfg.POLL_MS); return; }
    // Real buffered audio time from the SourceBuffer — NOT bytes/bps. The
    // bytes→seconds estimate is skewed by the init segment and a VBR intro,
    // so it OVERESTIMATES the lookahead and the first boundary drains early
    // (the "00:31 stall"). The SourceBuffer knows the exact decoded time;
    // fall back to the estimate only before any data lands.
    let loadedSec = s.duration;
    try {
      if (s.sb && s.sb.buffered && s.sb.buffered.length) {
        loadedSec = s.sb.buffered.end(s.sb.buffered.length - 1);
      } else if (s.bps > 0) {
        loadedSec = s.loadedEnd / s.bps;
      }
    } catch { loadedSec = s.bps > 0 ? s.loadedEnd / s.bps : s.duration; }
    const ahead = loadedSec - s.el.currentTime;
    if (ahead < s.cfg.REFILL_AHEAD && loadedSec < s.duration - 0.5) {
      s.fetching = true;
      try {
        await mseFetchChunk(s, s.loadedEnd);
        setTimeout(tick, s.cfg.POLL_MS);
      } catch (e) {
        // Classify the failure:
        //   • CDN cap — the audio-only URL is hard-capped at ~1MB on many edge
        //     nodes: the relay answered the whole-file muxed stream (HTTP 200
        //     to a byte-range request), the served total is implausibly small
        //     for the track's real duration, or a range past the cap 403/416'd.
        //     MSE can never finish a capped file — hand off to the FULL-LENGTH
        //     muxed stream NOW. No retries: a fresh audio-only URL is capped
        //     again, so re-resolving would only add pauses.
        //   • Transient — network blip, relay 5xx/throttle, append hiccup.
        //     Retry the SAME chunk a couple of times after a short backoff
        //     first: a teardown (mseRetryOnce) is itself a guaranteed stall,
        //     so a blip that self-heals must never reach it. Only after the
        //     per-chunk budget is spent do we re-resolve the stream once
        //     (bounded per track) and, failing that, hand off to plain audio.
        const msg = String((e && e.message) || '');
        const capped = mseCapped(s) || msg.includes('Muxed');
        const isActive = state.mse === s;
        if (isActive && capped) {
          // Drop the capped URL so the next track re-resolves fresh.
          const vid = s.track && (s.track.videoId || String(s.track.id || '').replace('yt:', ''));
          if (vid && window.MusicEngine && MusicEngine.invalidateStream) MusicEngine.invalidateStream(vid);
          mseHandoff(s, true); // pin to the range-capable muxed stream
          return;
        }
        if (isActive && (s.chunkRetries || 0) < (s.cfg.CHUNK_RETRIES || 1)) {
          s.chunkRetries = (s.chunkRetries || 0) + 1;
          await new Promise((r) => setTimeout(r, 600 * s.chunkRetries));
          if (s.dead) return;
          setTimeout(tick, 120);
          return;
        }
        if (isActive) {
          // Fresh retry budget whenever a new track becomes current.
          if (state.mseRetryFor !== state.playingId) {
            state.mseRetryFor = state.playingId;
            state.mseRetries = 0;
          }
          if ((state.mseRetries || 0) < 2) {
            state.mseRetries = (state.mseRetries || 0) + 1;
            const retry = await mseRetryOnce(s);
            if (retry === true) return; // new session's scheduler takes over
            // Retry failed. If the user switched tracks OR started a fresh
            // session (seek) during the await, the element now belongs to that
            // new playback — back off and let it play. On the SAME session,
            // hand off to plain <audio>. A 'muxed' retry result means the
            // fresh URL was ALSO CDN-capped — pin the handoff to the
            // range-capable muxed stream so seeks keep working.
            if (state.playingId !== s.track.id || state.mse !== s) return;
            mseHandoff(s, retry === 'muxed');
            return;
          }
          mseHandoff(s, false);
        } else {
          mseTeardown(s.el);
        }
      } finally {
        s.fetching = false;
      }
    } else if (!s.eos) {
      setTimeout(tick, s.cfg.POLL_MS);
    }
  };
  setTimeout(tick, s.cfg.POLL_MS);
}

// Start an MSE session on `el` for `track` using `url` (the relay stream URL).
// opts: { play, seekTo } — buffers from seekTo (default 0), plays when requested,
// then keeps a strict 10-15s lookahead via byte ranges until the track ends.
async function mseStart(el, track, url, opts = {}) {
  if (!window.MediaSource || !(track.duration > 0)) throw new Error('MSE unavailable');
  mseTeardown(el);
  const s = { el, track, url, ms: null, msUrl: null, sb: null, total: 0, duration: track.duration, bps: 0, loadedEnd: 0, chunkSeq: 0, chunkRetries: 0, eos: false, dead: false, fetching: false, cfg: mseCfg() };
  el._mse = s;
  const ms = new MediaSource();
  s.ms = ms;
  s.msUrl = URL.createObjectURL(ms);
  el.src = s.msUrl;
  await new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', resolve, { once: true });
    ms.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
  });
  // Probe 1 byte to learn the total size + container type (the relay passes
  // Range through to the CDN, so Content-Range / Content-Type come back).
  // Bounded like every other fetch — a hung relay must fail fast here so
  // playTrackAt falls back to plain <audio> instead of hanging the start.
  const pctl = new AbortController();
  const ptimer = setTimeout(() => pctl.abort(), 10000);
  let probe;
  try {
    probe = await fetch(url, { credentials: 'omit', signal: pctl.signal, headers: { Range: 'bytes=0-0' } });
  } catch {
    throw new Error('stream probe timed out');
  } finally {
    clearTimeout(ptimer);
  }
  if (!probe.ok && probe.status !== 206) throw new Error(`stream HTTP ${probe.status}`);
  const cr = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  s.total = cr ? Number(cr[1]) : 0;
  // CDN-CAP PROBE: the bytes=0-0 answer reports the LOGICAL total (e.g. 2.8MB),
  // but googlevideo hard-caps many audio-only URLs at ~512KB-1MB (verified
  // on-device: fresh signed URLs still 403/416 past the cap). MSE would play
  // fine until a refill chunk crosses the cap, then hit the whole-file 200
  // fallback MID-TRACK — the handoff that PAUSES playback (the "00:31 stall").
  // Probe the LAST byte: a healthy URL answers 206; a capped one answers
  // 416/403/200. Detect it NOW so capped tracks start on the full-length
  // muxed stream instead of stalling at the boundary. The result is cached
  // per URL, so only the first play of each track pays the extra probe.
  const capKnown = mseCapKnown(url);
  if (capKnown !== null) {
    if (capKnown) throw new Error('Muxed stream (capped)');
  } else if (s.total > 1) {
    const lastByte = s.total - 1;
    const pctl2 = new AbortController();
    const ptimer2 = setTimeout(() => pctl2.abort(), 10000);
    let probe2;
    try {
      probe2 = await fetch(url, { credentials: 'omit', signal: pctl2.signal, headers: { Range: `bytes=${lastByte}-${lastByte}` } });
    } catch {
      // The last-byte probe hanging on an otherwise-answering URL is the cap
      // signature too (server accepts then stalls) — take the muxed path. The
      // 'Muxed' marker matters: playTrackAt's catch keys off it to switch the
      // fallback src to the full-length muxed stream.
      mseCapRemember(url, true);
      throw new Error('Muxed stream (capped, probe timeout)');
    } finally {
      clearTimeout(ptimer2);
    }
    if (probe2.status !== 206) {
      try { if (probe2.body && probe2.body.cancel) probe2.body.cancel(); } catch { /* ignore */ }
      mseCapRemember(url, true);
      throw new Error('Muxed stream (capped)');
    }
    mseCapRemember(url, false);
  }
  const ct = probe.headers.get('content-type') || 'audio/mp4';
  // CDN-capped audio-only URL (served total far smaller than the track's real
  // duration): MSE could only ever play the capped fragment, then end the
  // song early. Throw 'Muxed' so the caller falls back to the full-length
  // muxed stream via plain <audio> — before any audio plays.
  if (mseCapped(s)) throw new Error('Muxed stream (capped)');
  // Muxed video+audio streams can't feed MSE: YouTube's progressive MP4s keep
  // the moov box at the END of the file, so appending byte ranges from byte 0
  // yields no init segment (sbBufferedRanges stays 0, playback never starts).
  // The plain <audio> fallback in playTrackAt handles them just fine.
  if (ct.includes('video')) throw new Error('Muxed stream');
  const codecs = mseCodec(ct);
  const candidate = codecs ? codecs.audio : null;
  if (!candidate || !MediaSource.isTypeSupported(candidate)) throw new Error('Unsupported stream type');
  if (!(s.total > 0)) throw new Error('Muxed stream (unknown size)'); // 200 whole-file answer — treat as capped
  s.type = candidate;
  s.bps = s.total / s.duration;
  const sb = ms.addSourceBuffer(candidate);
  sb.mode = 'segments';
  s.sb = sb;
  // First chunk(s). A fresh session starting at 0 fetches bytes 0 →
  // FIRST_CHUNK_SEC, which carries the init segment. A MID-TRACK session start
  // (seek outside the window / MSE retry) needs the init segment (moov / EBML
  // header — always at byte 0) BEFORE any mid-file data, or the SourceBuffer
  // can't decode it. Append a bounded init window (bytes 0 → 256 KB) first,
  // then chunk CONTIGUOUSLY from the init window end — this WebView's MSE
  // rejects appends that don't tile onto the existing buffered data (a gap
  // fails with a SourceBuffer error). The seek position lands inside the
  // buffer once the scheduler refills up to it.
  const startByte = Math.max(0, Math.floor((opts.seekTo || 0) * s.bps));
  if (startByte > 0) {
    const initEnd = Math.min(s.total, 256 * 1024);
    const ictl = new AbortController();
    const itimer = setTimeout(() => ictl.abort(), 10000);
    let initRes;
    try {
      initRes = await fetch(s.url, { credentials: 'omit', signal: ictl.signal, headers: { Range: `bytes=0-${initEnd - 1}` } });
    } catch {
      throw new Error('stream init timed out');
    } finally {
      clearTimeout(itimer);
    }
    if (initRes.status === 200) {
      try { if (initRes.body && initRes.body.cancel) initRes.body.cancel(); } catch { /* ignore */ }
      throw new Error('Muxed whole-file fallback');
    }
    if (!initRes.ok && initRes.status !== 416) throw new Error(`stream init HTTP ${initRes.status}`);
    if (initRes.ok) {
      const initBuf = await initRes.arrayBuffer();
      if (!s.dead && s.sb) await mseAppend(s, initBuf);
      // Same rule as mseFetchChunk: advance by the ACTUAL init bytes so the
      // follow-up chunk tiles contiguously even on a short init body.
      s.loadedEnd = Math.max(s.loadedEnd, initBuf.byteLength);
    }
    await mseFetchChunk(s, s.loadedEnd);
    // Appends must tile contiguously, so the only way to reach a mid-track
    // target is to refill forward from the start. Do it here (bounded) so the
    // target is INSIDE the buffer before currentTime is set — seeking to an
    // unbuffered time makes this WebView abort play() with "interrupted by a
    // new load request".
    let guard = 0;
    while (s.loadedEnd < startByte && guard < 16) {
      await mseFetchChunk(s, s.loadedEnd);
      guard++;
    }
  } else {
    await mseFetchChunk(s, startByte);
  }
  const seekTo = Math.min(s.duration, opts.seekTo || 0);
  try { el.currentTime = seekTo; } catch { /* ignore */ }
  if (opts.play !== false) {
    setBuffering(true);
    try { await el.play(); } catch {
      // A first play() can be aborted while the media pipeline settles after a
      // seek; one quick retry covers it. If it fails again it propagates and
      // the caller falls back to plain <audio>.
      await new Promise((r) => setTimeout(r, 250));
      await el.play();
    }
  }
  if (state.playingId === track.id) state.mse = s; // only the active session
  mseSchedule(s);
  return s;
}

/* ------------------------------ playback ------------------------------ */

// Playback failure action — retry the current track with a fresh stream.
// (The relay list is baked into the app now; there's no user-facing box.)
function retryTrack() {
  if (state.currentTrack) playTrackAt(state.index, state.queue);
}

// Cancel any in-flight crossfade and put both elements back to the user volume.
function cancelCrossfade() {
  if (state.xfade) {
    clearInterval(state.xfade.timer);
    const { toEl, fromEl } = state.xfade;
    state.xfade = null;
    try { toEl.pause(); mseTeardown(toEl); toEl.volume = state.userVol; } catch { /* ignore */ }
    try { fromEl.volume = state.userVol; } catch { /* ignore */ }
  }
  mseTeardown(audio);
  mseTeardown(audio2);
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  audio.pause();
  audio2.pause();
  state.activeEl = audio;
  state.preloadedVid = null; // partner element was reset — preload again on next play
  // A stale cached-copy blob URL must not linger across tracks.
  if (state.cachedBlobUrl) { try { URL.revokeObjectURL(state.cachedBlobUrl); } catch { /* ignore */ } state.cachedBlobUrl = null; }
}

// Playful one-liner flashed on every song selection — a random pick keeps it
// fresh. Skipped on cold-start session restore (no toast while the app boots).
const PLAY_TOASTS = [
  'Boom! Track locked.',
  'Now we’re rolling!',
  'Turn it up!',
  'Absolute banger selected.',
  'Vibe set.',
  'Setting the mood…',
  'Smooth sound incoming.',
  'Relaxing flow activated.',
  'Chef’s kiss choice!',
  'Your ears will thank you.',
  'Excellent taste!',
  'Earworm incoming!',
  'In perfect harmony.',
  'Beat locked in.',
  'Rhythm set!',
  'Ride the wave!',
  'Great pick!',
  'Vibe locked!',
  'Jam activated!',
  'Perfect pick!',
  'Main character energy set.',
  'Certified hit queued.',
  'No skips allowed!',
  'Valid choice.',
  'Next up: Greatness.',
  'Queued up smooth.',
  'Sliding into the queue.',
  'Next track, top tier.',
  'Fueling your flow!',
  'Soundtrack to your day!',
  'Powering up the player.',
  'Ready to inspire!',
];

async function playTrackAt(i, list) {
  if (!list) list = state.queue;
  if (i < 0 || i >= list.length) return;
  const prevIdx = state.index;
  const prevQueue = state.queue;
  // A leftover _pendingSeek from a failed session restore must not jump the
  // next track the user plays (the restore path keeps it via _restoring).
  if (!state._restoring) state._pendingSeek = null;
  // Announce the coming burst (stream resolve + warm + next-track preload)
  // so the Brain's anticipatory governor spaces it before it starts.
  if (window.Brain && Brain.noteIntent) Brain.noteIntent('play');
  cancelCrossfade(); // a new manual selection always restarts cleanly
  let track = list[i];
  // Chart tracks (Hot This Week) have no videoId yet — resolve them to a
  // playable YouTube track on first tap, then swap it into the list so
  // repeat taps and next/prev are instant.
  if (!track.videoId && track.searchQuery) {
    try {
      track = await MusicEngine.resolveChartTrack(track);
      list[i] = track;
    } catch (e) {
      toast(`Couldn't play “${track.name}”: ${esc(e.message)}`, true);
      return;
    }
  }
  state.queue = list;
  state.index = i;
  // A NEW queue replaced the old one (new album/playlist): the shuffle order
  // belongs to the old queue — drop it so it rebuilds for the new one.
  if (list !== prevQueue) shuffleOrder = null;
  state.playingId = track.id;
  state.currentTrack = track;
  // Random playful toast on every song selection (skip the boot-time
  // session restore — no flash while the app is coming up).
  if (!state._restoring) toast(pickRandom(PLAY_TOASTS));
  // Track-change direction — drives the Now Playing slide animation
  // (next → slides left, prev → slides right). Consumed by updateNowPlaying;
  // a restart of the same track (repeat-one / >3s prev) yields 0 = no slide.
  npSlideDir = i > prevIdx ? -1 : i < prevIdx ? 1 : 0;
  // Continuous cover slide when Now Playing is open: ghost the old cover and
  // let the new one take over (npDragFrom = where a swipe left the cover).
  if (npIsOpen() && npSlideDir !== 0) playNpSlideTransition(npSlideDir, npDragFrom);
  npDragFrom = 0;
  // Proactive Up Next: if this list is about to run dry, the AI starts
  // curating right away (runExtend tops up when 6 remain) instead of waiting
  // for the very last track — Up Next never shows an empty list.
  if (list.length - i - 1 <= 6) maybeExtendQueue();
  updatePlayingCards();
  // Show the player first — the title marquee measures real widths, so the
  // bar must be visible before its layout is measured. (In Search mode it
  // stays hidden by design: refreshPlayerVisibility hides it there.)
  refreshPlayerVisibility();
  updatePlayerUI(track);
  reportNowPlaying(true);
  saveSession();

  let mediaLoadAttempted = false; // true once the URL is handed to <audio>
  try {
    let src;
    if (track.source === 'youtube') {
      const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
      if (!vid) throw new Error('No video id for this track');
      // Already in embed mode (the relay chain is dead this session — PC off
      // etc.)? Stay in it: retrying the dead chain adds seconds per track.
      // The embed plays straight from YouTube, so next/prev keep working.
      if (EmbedPlay.isActive()) {
        await EmbedPlay.play(track);
        recordPlay(track);
        return;
      }
      // Offline-first: a saved copy plays from a blob URL — instant start,
      // fully seekable, immune to network. Only the network path resolves a
      // stream URL.
      const cached = (window.OfflineCache && OfflineCache.db) ? await OfflineCache.get(vid) : null;
      // Superseded by a newer selection (user tapped another track while this
      // stream was resolving)? Stop — don't clobber their choice.
      if (state.playingId !== track.id) return;
      if (cached && cached.blob) {
        if (state.cachedBlobUrl) { try { URL.revokeObjectURL(state.cachedBlobUrl); } catch { /* ignore */ } }
        state.cachedBlobUrl = URL.createObjectURL(cached.blob);
        src = state.cachedBlobUrl;
        OfflineCache.touch(vid, cached.lastPlayed); // keep it from being the LRU eviction victim
      } else {
        const stream = await MusicEngine.streamUrl(vid);
        if (state.playingId !== track.id) return;
        src = stream.url;
      }
    } else if (track.audioUrl) {
      src = track.audioUrl; // pre-resolved source (saved/recent tracks keep one)
    } else {
      throw new Error('No playable source for this track');
    }
    const el = curEl();
    let played = false;
    // Cached copies are served as fully-seekable blob URLs to plain <audio>
    // (blobs need no MSE); everything else uses the high-quality bounded-
    // buffer path: MSE fed by byte-range requests keeps only a strict short
    // lookahead (never buffers the whole track). Falls back to the plain
    // <audio> element when MSE isn't possible.
    if (state.playingId === track.id && (track.duration || 0) > 0 && !String(src).startsWith('blob:')) {
      const seekTo = state._pendingSeek != null ? state._pendingSeek : 0;
      try {
        await mseStart(el, track, src, { play: true, seekTo });
        played = true;
      } catch (e) {
        mseTeardown(el);
        const errMsg = String((e && e.message) || '');
        // CDN-capped audio-only URL: MSE can't finish it (the cap ends the
        // file early). The plain <audio> fallback below must use the relay's
        // full-length MUXED stream — the capped audio-only URL would only
        // replay the capped fragment and stop again.
        if (errMsg.includes('Muxed')) src = muxedStreamUrl(src);
        // 'Unsupported stream type' = the relay answered WebM/Opus and this
        // platform's MSE can't decode it (iOS Safari: MSE supports fragmented
        // MP4/AAC only). Re-point the plain <audio> fallback at the relay's
        // muxed MP4 stream — its AAC audio track decodes on iOS. This is the
        // safety net when a relay still hands out a webm answer (e.g. a track
        // whose only audio format is Opus).
        if (errMsg.includes('Unsupported stream type')) src = muxedStreamUrl(src);
        // Fresh URL on the retry — a stale signed URL self-heals.
        if (!state._restoring) MusicEngine.reportStreamFailure(track.videoId || '', {});
      }
    }
    if (!played) {
      el.src = src;
      setBuffering(true);
      mediaLoadAttempted = true;
      await el.play();
    }
    recordPlay(track);
    preloadNextTrack(); // buffer the next song early, whatever the source
  } catch (e) {
    setBuffering(false);
    // Session resume: the WebView may block autoplay on a cold start (no user
    // gesture yet). Swallow that one — the player bar is ready, one tap away.
    if (state._restoring) { state._restoring = false; return; }
    // LAST RESORT before ANY failure toast: every relay and direct source
    // failed (PC off, tunnel down, Worker bot-blocked) — play through
    // YouTube's own hidden embed player, no relay involved.
    if (await tryEmbedFallback(track)) return;
    // If the URL already reached the <audio> element, the failure came from
    // the media load itself — Chromium rejects play() there with messages like
    // "Failed to fetch". The audio 'error' listener handles those (retry once,
    // then a clear message + Retry action) — don't double-toast here.
    if (mediaLoadAttempted) return;
    const msg = String((e && e.message) || 'Unknown error');
    toast(`Playback failed: ${msg}`, true, { label: 'Retry', fn: retryTrack });
  }
}

// Prepare the next track for a gapless handoff BEFORE the current one ends:
// resolve its stream URL and hand it to the partner element, which sits
// paused and buffers in the background. When the 10s overlap window arrives,
// the next track is already buffered — play() starts instantly, so the
// crossfade connects even on slow/bot-checked streams.
function preloadNextTrack() {
  // Embed mode can't crossfade/preload a hidden iframe — next/prev just
  // load the next video on demand. Skip the preload entirely.
  if (EmbedPlay.isActive()) return;
  if (state.queue.length < 2) return;
  // Repeat-one replays the current track — there is no next track to preload
  // (warming one would just burn a YouTube request for nothing).
  if (state.repeat === 'one') return;
  // Capture the queue/position NOW; the end-guard compares identity so a
  // replaced queue (new search/album list) can never load the wrong track.
  const queue = state.queue;
  const index = state.index;
  // Repeat-off at the end of the queue: the next track is chosen by
  // nextTrack()'s extension logic (recommendations), not a wrap — nothing
  // to preload here either.
  if (state.repeat !== 'all' && index >= queue.length - 1) return;
  const toIdx = (index + 1) % queue.length;
  const next = queue[toIdx];
  if (!next) return;
  const toEl = otherEl();
  // Already preloaded this exact track — don't reload it.
  if (state.preloadedVid && state.preloadedVid === (next.videoId || next.id) && (toEl._mse || toEl.src)) return;
  // Cached tracks start instantly from a blob — no need to resolve/warm them.
  const nextCached = !!(window.OfflineCache && OfflineCache.hasSync(next.videoId));
  if (!nextCached && next.videoId) MusicEngine.warm(next.videoId); // cache the URL even if the load below is slow
  // Fire-and-forget warm the track after next too, so skipping forward twice
  // (or the track after the crossfade) is just as instant.
  if (queue.length > 2 && !nextCached) {
    const next2 = queue[(index + 2) % queue.length];
    if (next2 && next2.videoId && !(window.OfflineCache && OfflineCache.hasSync(next2.videoId))) MusicEngine.warm(next2.videoId);
  }
  (async () => {
    let track = next;
    if (!track.videoId && track.searchQuery) {
      try { track = await MusicEngine.resolveChartTrack(track); queue[toIdx] = track; } catch { return; }
    }
    // Cached — the crossfade handoff is instant from the blob, no preload.
    if (window.OfflineCache && OfflineCache.hasSync(track.videoId)) return;
    let src = '';
    if (track.source === 'youtube' && track.videoId) {
      try { src = (await MusicEngine.streamUrl(track.videoId)).url; } catch { return; }
    } else if (track.audioUrl) {
      src = track.audioUrl;
    } else { return; }
    // User moved on / queue was replaced while we were resolving — don't
    // clobber the new state or load the wrong track onto the partner.
    if (state.queue !== queue || state.index !== index || state.playingId !== state.currentTrack?.id) return;
    if (state.preloadedVid === (track.videoId || track.id) && toEl.src) return;
    try {
      if (state.preloadedVid === (track.videoId || track.id) && toEl._mse) return;
      mseTeardown(toEl);
      if ((track.duration || 0) > 0) {
        // MSE preload: buffer the first chunk (paused, silent) — the crossfade
        // then just fades the volumes, no URL resolution at handoff time.
        try {
          await mseStart(toEl, track, src, { play: false, seekTo: 0 });
        } catch (e) {
          // Capped audio-only URL — MSE can't preload it; preload the
          // full-length muxed stream on the plain element instead so the
          // crossfade still has a buffered partner.
          if (String((e && e.message) || '').includes('Muxed')) {
            toEl.src = muxedStreamUrl(src);
            toEl.load();
          } else {
            throw e;
          }
        }
      } else {
        toEl.src = src;
        toEl.load();
      }
      toEl.volume = 0; // silent until the fade begins
      state.preloadedVid = track.videoId || track.id;
    } catch { mseTeardown(toEl); }
  })();
}

// The old "Buffering…" text indicator is gone — streamed progress shows on
// the seek line instead. Keep the state flag (harmless), touch no UI.
function setBuffering(on) {
  state.buffering = on;
}

// Fill the seek line's buffered range (what's been streamed so far). The
// audio element downloads progressively, so this grows as the track plays.
function updateBufferBar() {
  const el = curEl();
  const dur = el.duration;
  const pct = (dur && el.buffered && el.buffered.length)
    ? Math.min(100, (el.buffered.end(el.buffered.length - 1) / dur) * 100)
    : 0;
  const sx = (pct / 100).toFixed(4);
  // GPU-composited scaleX instead of width — layout-free, smooth on slow phones.
  const bar = $('#seek-buffer');
  if (bar) bar.style.transform = `translateY(-50%) scaleX(${sx})`;
  const np = $('#np-seek-buffer');
  if (np) np.style.transform = `translateY(-50%) scaleX(${sx})`;
}

// Media listeners are bound to BOTH audio elements; only the active one
// drives the UI, which lets the 10s overlap handoff switch elements seamlessly.
function bindMedia(el) {
  el.addEventListener('progress', () => { if (el === curEl()) updateBufferBar(); });
  // Fast stall recovery for the plain <audio> path (MSE self-heals via its
  // scheduler). A stalled source has no automatic recovery except the slow
  // 12s watchdog — so after ~5s with no progress, reload with a fresh URL
  // (bounded, escalated to the full-length muxed stream on the second
  // reload for CDN-capped audio-only URLs). The watchdog stays as backstop.
  el.addEventListener('stalled', () => {
    if (el !== curEl() || el.paused || !state.currentTrack || el._mse) return;
    const t = state.currentTrack;
    const vid = t.videoId || String(t.id || '').replace('yt:', '');
    const budget = (el._stallReloads = (el._stallReloads || 0) + 1);
    // Budget exhausted on a genuinely dead source — let the watchdog + error
    // path take over; don't flash buffering UI forever.
    if (budget > 2 || !vid || !window.MusicEngine || !MusicEngine.invalidateStream) return;
    setBuffering(true);
    setTimeout(() => {
      if (el !== curEl() || el.paused || el._mse || budget !== el._stallReloads) return;
      const pos = Number.isFinite(el.currentTime) && el.currentTime > 0 ? el.currentTime : 0;
      MusicEngine.invalidateStream(vid);
      (async () => {
        try {
          const stream = await MusicEngine.streamUrl(vid);
          if (el !== curEl() || el.paused) return;
          // Second stall on the same track = the audio-only URL is almost
          // certainly CDN-capped — pin to the full-length muxed stream.
          const src = budget >= 2 ? muxedStreamUrl(stream.url) : stream.url;
          el.src = src;
          el.load();
          if (pos > 0) seekAudioQueued(el, pos);
          setBuffering(true);
          el.play().catch(() => { /* error listener takes over */ });
        } catch { /* leave the error listener to handle it */ }
      })();
    }, 5000);
  });
  el.addEventListener('play', () => {
    if (el !== curEl()) return;
    $('#play-path').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z');
    $('#np-play-path').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z');
    const art = $('#np-art');
    if (art) art.classList.add('live');
    updatePlayingCards();
    reportNowPlaying(true);
    saveSession();
  });
  el.addEventListener('pause', () => {
    if (el !== curEl() && !(state.xfade && (state.xfade.fromEl === el || state.xfade.toEl === el))) return;
    $('#play-path').setAttribute('d', 'M8 5v14l11-7z');
    $('#np-play-path').setAttribute('d', 'M8 5v14l11-7z');
    const art = $('#np-art');
    if (art) art.classList.remove('live');
    updatePlayingCards();
    reportNowPlaying(true);
    saveSession();
  });
  el.addEventListener('ended', () => {
    // A crossfade is running and THIS element (the outgoing one) just ended:
    // hand over to the already-playing next track.
    if (state.xfade && state.xfade.fromEl === el) { finalizeCrossfade(); return; }
    if (el !== curEl()) return;
    nextTrack();
  });
  el.addEventListener('timeupdate', () => {
    if (el !== curEl()) return;
    if (!el.duration) return;
    // While the user is SCRUBBING, never overwrite the seek input's value —
    // the thumb must follow the finger, not the playhead (the old code reset
    // the slider every ~250ms, so slow real-finger drags appeared to "not
    // work"). The input handler paints the fill/time from the drag position.
    if (!npSeekScrubbing) {
      const v = Math.round((el.currentTime / el.duration) * 1000);
      $('#seek').value = v;
      $('#np-seek').value = v;
      $('#t-cur').textContent = fmtDur(el.currentTime);
      $('#t-total').textContent = fmtDur(el.duration);
      $('#np-t-cur').textContent = fmtDur(el.currentTime);
      $('#np-t-total').textContent = fmtDur(el.duration);
    }
    // Spotify-style: paint the played portion of the seek line white. The
    // input itself is a tall transparent hit area — the fill lives on its own
    // thin div below it.
    const pct = Math.min(100, (el.currentTime / el.duration) * 100);
    const frac = (el.currentTime / el.duration).toFixed(4);
    const nsf = $('#np-seek-fill');
    if (nsf) nsf.style.transform = `translateY(-50%) scaleX(${(pct / 100).toFixed(4)})`;
    // Update mini progress bar (Spotify-style thin white line)
    const mpf = $('#mini-progress-fill');
    if (mpf) mpf.style.transform = `scaleX(${frac})`;
    // The same streaming line rides the expanded box's top edge.
    const npf = $('#np-progress-fill');
    if (npf) npf.style.transform = `scaleX(${frac})`;
    updateBufferBar();
    reportNowPlaying();
    saveSession(); // throttled inside
    // Safety net: if the next track hasn't been preloaded yet (first attempt
    // hit a slow relay), kick it off again once we're inside the last 45s —
    // throttled to 8s so a failing relay isn't hammered on every tick.
    if (!state.preloadedVid && el.duration - el.currentTime < 45) {
      const now = Date.now();
      if (now - lastPreloadAttempt > 8000) {
        lastPreloadAttempt = now;
        preloadNextTrack();
      }
    }
    maybeStartCrossfade();
  });
  el.addEventListener('loadedmetadata', () => {
    if (el !== curEl()) return;
    $('#t-total').textContent = fmtDur(el.duration);
    $('#np-t-total').textContent = fmtDur(el.duration);
    // Session restore: jump to where the listener left off.
    if (state._pendingSeek != null) {
      try { el.currentTime = Math.max(0, Math.min(state._pendingSeek, el.duration || state._pendingSeek)); } catch { /* ignore */ }
      state._pendingSeek = null;
    }
    reportNowPlaying(true);
  });
  el.addEventListener('waiting', () => {
    if (el !== curEl()) return;
    setBuffering(true);
    mseKick(el); // abort a stuck refill fetch so the recovery chain runs
  });
  el.addEventListener('stalled', () => {
    if (el !== curEl()) return;
    setBuffering(true);
    mseKick(el);
  });
  el.addEventListener('playing', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('canplay', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('pause', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('error', () => handleMediaError(el));
}

// Stall recovery: if the active element is waiting/stalled while an MSE session
// is running and a chunk fetch is in flight, abort it. The abort rejects that
// fetch, and the scheduler's catch path retries the chunk, re-resolves the
// stream once, then hands off to plain <audio> — instead of sitting frozen
// until the app is restarted. Only the element's OWN stuck fetch is aborted;
// a healthy scheduler with plenty buffered is left alone.
function mseKick(el) {
  const s = el && el._mse;
  if (!s || s.dead || !s.fetching || !s.fetchCtl) return;
  // "Stuck" = the fetch has run at least half its timeout budget with no
  // data. That scales with the tier (slow chunks legitimately take a few
  // seconds), so a healthy-but-slow download is never aborted.
  const stuck = Date.now() - s.lastFetchStart > Math.max(4000, (s.cfg.CHUNK_TIMEOUT || 10000) / 2);
  if (stuck) {
    try { s.fetchCtl.abort(); } catch { /* ignore */ }
  }
}

// Silent-freeze watchdog. The "waiting"/"stalled" events don't always fire —
// a dead relay can leave the element parked with currentTime frozen and no
// events at all (the classic "I had to restart the app" stall). Every few
// seconds, if the active element is supposedly playing but its position hasn't
// advanced, kick recovery:
//   • MSE — abort a refill fetch that is actually STUCK (same half-timeout
//     age check as mseKick) so the retry → fresh URL → plain-audio chain runs.
//   • Plain <audio> — a long freeze (12s+) with no error event is a hung
//     source. Re-resolve the URL and reload in place, resuming at the frozen
//     position, WITHOUT tripping the relay circuit breaker (reportStreamFailure
//     is reserved for real stream errors — a blip isn't a relay failure).
let lastWatchdogPos = -1;
let lastWatchdogAt = 0;
setInterval(() => {
  const el = curEl();
  if (!el || el.paused || !el.src || !state.currentTrack) { lastWatchdogPos = -1; return; }
  const pos = el.currentTime;
  const now = Date.now();
  if (lastWatchdogPos >= 0 && pos === lastWatchdogPos) {
    if (now - lastWatchdogAt > 5000) {
      const s = el._mse;
      if (s && !s.dead) {
        if (s.fetching && s.fetchCtl) {
          const stuck = now - s.lastFetchStart > Math.max(4000, (s.cfg.CHUNK_TIMEOUT || 10000) / 2);
          if (stuck) {
            try { s.fetchCtl.abort(); } catch { /* ignore */ }
          }
        }
      } else if (!s && !el.error && now - lastWatchdogAt > 12000) {
        // Hung plain-audio source — reload with a fresh URL, resume in place.
        const track = state.currentTrack;
        const vid = track && (track.videoId || String(track.id || '').replace('yt:', ''));
        if (vid && window.MusicEngine) {
          const frozenPos = Number.isFinite(pos) && pos > 0 ? pos : 0;
          MusicEngine.invalidateStream(vid);
          (async () => {
            try {
              const stream = await MusicEngine.streamUrl(vid);
              if (state.playingId !== state.currentTrack?.id || curEl() !== el) return;
              el.src = stream.url;
              el.load();
              if (frozenPos > 0) seekAudioQueued(el, frozenPos);
              el.play().catch(() => { /* error listener takes over */ });
            } catch { /* leave the error listener to handle it */ }
          })();
        }
      }
      lastWatchdogAt = now; // don't re-fire every tick — give recovery time
    }
  } else {
    lastWatchdogPos = pos;
    lastWatchdogAt = now;
  }
}, 3000);
bindMedia(audio);
bindMedia(audio2);

// 10-second overlap: when the current track has ~10s left, start the next one
// on the partner element and fade across, so playback is continuous.
const XFADE_WINDOW = 10; // seconds before the end to begin the overlap
function maybeStartCrossfade() {
  if (state.xfade || state.queue.length < 2 || state._restoring) return;
  const el = curEl();
  if (!el.duration || !isFinite(el.duration)) return;
  const remain = el.duration - el.currentTime;
  if (remain > XFADE_WINDOW || remain <= 0.5) return;
  // Repeat-one replays the SAME track — never crossfade to the next one.
  if (state.repeat === 'one') return;
  // Repeat-off at the end of the queue: don't wrap around to track 0 — the
  // 'ended' path tops the queue up with recommendations (or stops) instead.
  if (state.repeat !== 'all' && state.index >= state.queue.length - 1) return;
  const toIdx = (state.index + 1) % state.queue.length;
  const next = state.queue[toIdx];
  if (!next) return;
  const toEl = otherEl();
  const fromEl = el;
  state.xfade = { fromEl, toEl, toIdx, timer: null };
  (async () => {
    let track = next;
    if (!track.videoId && track.searchQuery) {
      try { track = await MusicEngine.resolveChartTrack(track); state.queue[toIdx] = track; } catch { state.xfade = null; return; }
    }
    const preloaded = state.preloadedVid === (track.videoId || track.id) && toEl._mse && !toEl._mse.dead;
    let src = '';
    // Fast path: the partner element already buffered this exact track during
    // preloadNextTrack() — skip URL resolution entirely, just fade it in.
    if (!preloaded) {
      if (track.source === 'youtube' && track.videoId) {
        try { src = (await MusicEngine.streamUrl(track.videoId)).url; } catch { state.xfade = null; return; }
      } else if (track.audioUrl) {
        src = track.audioUrl;
      } else { state.xfade = null; return; }
    }
    if (!state.xfade || curEl() !== fromEl || state.playingId !== state.currentTrack?.id) { state.xfade = null; return; }
    try {
      if (!preloaded) {
        mseTeardown(toEl);
        if ((track.duration || 0) > 0) {
          try {
            await mseStart(toEl, track, src, { play: false, seekTo: 0 });
          } catch (e) {
            // Capped audio-only URL — the muxed stream is the full-length
            // source for the plain element.
            if (String((e && e.message) || '').includes('Muxed')) {
              toEl.src = muxedStreamUrl(src);
              toEl.load();
            } else {
              throw e;
            }
          }
        } else {
          toEl.src = src;
        }
      }
      toEl.volume = 0;
      await toEl.play();
    } catch { state.xfade = null; return; }
    if (!state.xfade) return;
    // Ramp across the remaining window: fade out the current, fade in the next.
    const steps = 20;
    let step = 0;
    state.xfade.timer = setInterval(() => {
      step++;
      const p = Math.min(1, step / steps);
      if (!state.xfade) { clearInterval(state.xfade.timer); return; }
      try { fromEl.volume = Math.max(0, state.userVol * (1 - p)); } catch { /* ignore */ }
      try { toEl.volume = Math.max(0, state.userVol * p); } catch { /* ignore */ }
      if (step >= steps) clearInterval(state.xfade.timer);
    }, (XFADE_WINDOW * 1000) / steps);
  })();
}

// The outgoing element ended mid-crossfade — the next track is already playing
// on the partner element, so just promote it to the active one.
function finalizeCrossfade() {
  const xf = state.xfade;
  if (!xf) return;
  if (xf.timer) clearInterval(xf.timer);
  state.xfade = null;
  const next = state.queue[xf.toIdx];
  if (!next) { nextTrack(); return; }
  state.index = xf.toIdx;
  state.currentTrack = next;
  state.playingId = next.id;
  state.activeEl = xf.toEl;
  xf.toEl.volume = state.userVol;
  updatePlayerUI(next);
  updatePlayingCards();
  reportNowPlaying(true);
  saveSession();
  recordPlay(next);
  preloadNextTrack();
  // Free the old element for the next handoff.
  try { xf.fromEl.pause(); mseTeardown(xf.fromEl); xf.fromEl.volume = state.userVol; } catch { /* ignore */ }
}

// Last-resort playback: some WebViews block the <audio> element from loading
// http:// media while the page itself is https (mixed content) — yet fetch()
// to the same relay works fine. Buffer the stream with fetch() and play it
// as a blob URL, which sidesteps every mixed-content/CORS media restriction.
async function playRelayViaFetch(track) {
  if (state.playingId !== track.id) return;
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  const relays = (MusicEngine.getRelays() || []).filter((u) => /^https?:\/\//.test(u));
  if (!vid || !relays.length) return;
  // Try every relay in turn: the first may be a dead local relay (PC off) —
  // the Cloudflare worker keeps playing when that happens. Each attempt is
  // bounded by a timeout so a hung relay (dead PC on a foreign network) can't
  // stall the whole fallback. The on-device relay (127.0.0.1) first — it
  // streams full tracks from the phone's own IP with no PC involved — then the
  // PC LAN/Tailscale relays, then the Worker.
  let order = relays;
  const local = relays.filter((u) => /127\.0\.0\.1|localhost/.test(u));
  if (local.length) order = [...local, ...relays.filter((u) => !local.includes(u))];
  let lastErr = null;
  for (const relay of order) {
    if (state.playingId !== track.id) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      // The fetch path buffers the WHOLE stream as a blob — the audio-only
      // URL is CDN-capped (~1MB) on many edges, so its blob would play only
      // the capped fragment and end the song early. Always fetch the
      // full-length muxed stream here (last-resort path; size-bounded below).
      const url = `${relay}/stream?videoId=${encodeURIComponent(vid)}&muxed=1`;
      const res = await fetch(url, { credentials: 'omit', signal: ctl.signal });
      if (!res.ok) throw new Error(`the relay responded HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      if (total > 25 * 1024 * 1024) throw new Error('this track is too long for buffered playback');
      const blob = await res.blob();
      if (state.playingId !== track.id) return; // user moved on while buffering
      const blobUrl = URL.createObjectURL(blob);
      if (state._prevBlobUrl) URL.revokeObjectURL(state._prevBlobUrl);
      state._prevBlobUrl = blobUrl;
      const el = curEl();
      mseTeardown(el);
      el.src = blobUrl;
      setBuffering(true);
      await el.play();
      recordPlay(track);
      return;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  if (state.playingId === track.id) {
    const msg = lastErr ? lastErr.message : 'all relays failed';
    toast(`Playback failed: ${msg}`, true, { label: 'Retry', fn: retryTrack });
  }
}

// --- media failure handling: automatic retries, then a clear message ---
// Bound to BOTH audio elements (in bindMedia) so the crossfade handoff can't
// leave audio2 with no error handling.
const mediaRetries = new Map(); // videoId -> automatic retries already used
function handleMediaError(el) {
  setBuffering(false);
  const track = state.currentTrack;
  if (!track) return;
  // Stale error from an aborted load (user already moved to another track)?
  // Don't report/retry the wrong track.
  if (state.playingId !== track.id) return;
  // The embed fallback took over this track (relay chain dead) — the audio
  // element's own error/retry loop must stand down, not fight the embed.
  if (EmbedPlay.isActive() && EmbedPlay.currentTime() >= 0) return;
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  if (vid) {
    const used = mediaRetries.get(vid) || 0;
    // First miss: just drop the stale URL — a fresh resolution usually fixes
    // it, and marking the healthy LAN relay down would push playback onto the
    // bot-blocked on-device relay for the whole cooldown. Only after the retry
    // also fails do we trip the circuit breaker (markDown=true).
    MusicEngine.reportStreamFailure(vid, { markDown: used >= 1 });
    if (used < 1) {
      // Retry 1: fresh stream URL — signed YouTube URLs expire and relays can
      // be throttled mid-track, so a fresh source often just works.
      // Retry silently — the seek line's buffered fill shows progress.
      mediaRetries.set(vid, used + 1);
      MusicEngine.invalidateStream(vid);
      playTrackAt(state.index, state.queue);
      return;
    }
    if (used < 2) {
      // Retry 2: direct <audio> loading failed twice — buffer the stream via
      // fetch() (which works even where media is mixed-content-blocked).
      // Silent fallback — buffer the stream via fetch() and play the blob.
      mediaRetries.set(vid, used + 1);
      playRelayViaFetch(track);
      return;
    }
  }
  const code = el.error ? el.error.code : 0;
  const msg = code === 2
    ? 'Playback failed: the audio server couldn\'t be reached — check your connection.'
    : (code === 4 ? 'Playback failed: no supported audio format for this track.' : 'Playback failed: the stream couldn\'t load.');
  toast(msg, true, { label: 'Retry', fn: retryTrack });
}
function clearMediaRetry(track) {
  if (track) mediaRetries.delete(track.videoId || '');
}
function bindMediaPlayed() {
  clearMediaRetry(state.currentTrack);
  setBuffering(false);
  // A 'playing' event proves the source is healthy again — reset the stall
  // reload budget and any capped-URL suspicion.
  audio._stallReloads = 0;
  audio2._stallReloads = 0;
}
audio.addEventListener('playing', bindMediaPlayed);
audio2.addEventListener('playing', bindMediaPlayed);

/* ------------------------------ native media bridge (lock-screen controls) ------------------------------ */

// Inside the Android app, report what's playing to the on-device relay so the
// native side (OrBeatRelayService) can show lock-screen media controls with
// the song title, artist, artwork and play/pause/next/prev. Every call is
// fire-and-forget — a missing relay must never break playback.
const NATIVE_MEDIA = /Android/i.test(navigator.userAgent);
let lastMediaReport = 0;
function reportNowPlaying(force = false) {
  if (!NATIVE_MEDIA) return;
  const t = state.currentTrack;
  if (!t) return;
  const now = Date.now();
  if (!force && now - lastMediaReport < 10000) return; // position heartbeat
  lastMediaReport = now;
  // Lock-screen artwork should be the HD cover, not the 120/480px thumb the
  // engine stores: ytimg thumbs get maxresdefault, Google-CDN covers get the
  // 1080px render (the CDN returns the largest available when smaller).
  const hdCover = upscaleCover(upscaleArtHD(t.cover || ''));
  const body = {
    title: String(t.name || ''),
    artist: String(t.artist || ''),
    cover: hdCover,
    videoId: t.videoId || '',
    playing: !curEl().paused && !!curEl().src,
    position: Math.floor(curEl().currentTime || 0),
    duration: Math.floor(curEl().duration || t.duration || 0),
  };
  fetch('http://127.0.0.1:8787/nowplaying', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
  }).catch(() => {});
}

// Lock-screen / media-button commands arrive here, dispatched by the native
// relay service via evaluateJavascript (same-process WebView).
window.__np = {
  control(cmd) {
    if (cmd === 'play') { if (curEl().paused) curEl().play().catch(() => {}); }
    else if (cmd === 'pause') { if (!curEl().paused) curEl().pause(); }
    else if (cmd === 'next') nextTrack();
    else if (cmd === 'prev') prevTrack();
  },
  seekTo(sec) {
    if (Number.isFinite(sec)) seekPlayerTo(sec); // MSE-aware (re-chunks outside the buffer)
  },
};

function updatePlayerUI(track) {
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  const base = track.cover ? upscaleCover(track.cover) : (vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '');
  const fallback = track.cover || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
  // #player-cover can be missing if a previous track's cover failed to load
  // and its onerror replaced it with a placeholder — never crash the track
  // change on that; (re)create a fresh cover element instead.
  let oldCover = $('#player-cover');
  if (!oldCover) {
    oldCover = document.createElement('div');
    oldCover.id = 'player-cover';
    oldCover.className = 'mini-cover';
    const holder = $('#player .mini-row');
    if (holder && holder.firstChild) holder.insertBefore(oldCover, holder.firstChild);
    else if (holder) holder.appendChild(oldCover);
  }
  if (base) {
    const img = document.createElement('img');
    img.className = 'mini-cover';
    img.id = 'player-cover';
    img.src = base;
    img.alt = '';
    img.dataset.orig = fallback;
    img.onerror = function() {
      if (!this.dataset.fb) { this.dataset.fb = '1'; this.src = this.dataset.orig; }
      // Keep the id on the placeholder so the next updatePlayerUI finds it.
      else { this.outerHTML = '<div class="mini-cover noimg logo-fallback" id="player-cover">' + LOGO_FB + '</div>'; }
    };
    oldCover.replaceWith(img);
  } else {
    const div = document.createElement('div');
    div.className = 'mini-cover noimg logo-fallback';
    div.id = 'player-cover';
    div.innerHTML = LOGO_FB;
    oldCover.replaceWith(div);
  }
  setPlayerTitle(track.name);
  $('#player-artist').textContent = track.artist;
  $('#t-cur').textContent = '0:00';
  $('#seek').value = 0;
  const bb = $('#seek-buffer'); if (bb) bb.style.transform = 'translateY(-50%) scaleX(0)';
  const nb = $('#np-seek-buffer'); if (nb) nb.style.transform = 'translateY(-50%) scaleX(0)';
  const nf = $('#np-seek-fill'); if (nf) nf.style.transform = 'translateY(-50%) scaleX(0)';
  // Reset mini progress bar
  const mpf = $('#mini-progress-fill'); if (mpf) mpf.style.transform = 'scaleX(0)';
  const npf = $('#np-progress-fill'); if (npf) npf.style.transform = 'scaleX(0)';
  // Update mini like button + the in-box mini row (one box's base)
  updateMiniLike();
  updateNpMini();
  updateNowPlaying();
  updateNowPlayingBar();
  // Prime the NEXT track's HD cover in the browser cache while this one
  // plays — the next swipe/next has zero decode work at release time.
  preloadNextCover();
}

// Spotify layout: no top now-playing bar — the mini player at the bottom is
// the single now-playing surface. The #np-topbar element stays hidden.
function updateNowPlayingBar() {
  const bar = $('#np-topbar');
  if (bar) bar.hidden = true;
}

function updateMiniLike() {
  const btn = $('#mini-like');
  if (!btn || !state.currentTrack) return;
  const liked = isLiked(state.currentTrack.id);
  btn.classList.toggle('liked', liked);
  // The in-box mini row (the box's base, revealed on close) mirrors it.
  const nm = $('#np-mini-like');
  if (nm) nm.classList.toggle('liked', liked);
}

// Mirror the mini player bar's content into the in-box mini row so the
// collapsing box shows the SAME mini player — one connected box. The row is
// display-only (pointer-events:none); the interactive bar underneath takes
// over when the box closes.
function updateNpMini() {
  const nc = $('#np-mini-cover');
  if (!nc) return;
  const c = $('#player-cover');
  if (c) {
    if (c.tagName === 'IMG') {
      nc.outerHTML = `<img class="mini-cover" id="np-mini-cover" src="${c.src}" alt="" />`;
    } else {
      nc.outerHTML = `<div class="mini-cover noimg logo-fallback" id="np-mini-cover">${LOGO_FB}</div>`;
    }
  }
  const t = $('#player-title');
  const nt = $('#np-mini-title');
  if (t && nt) nt.textContent = t.dataset.mqOrig || t.textContent;
  const a = $('#player-artist');
  const na = $('#np-mini-artist');
  if (a && na) na.textContent = a.textContent;
  const lk = $('#mini-like');
  const nl = $('#np-mini-like');
  if (lk && nl) nl.classList.toggle('liked', lk.classList.contains('liked'));
}

// The Now Playing heart (Spotify-style, aligned with the title).
function updateNpLike() {
  const btn = $('#np-like');
  if (!btn || !state.currentTrack) return;
  const liked = isLiked(state.currentTrack.id);
  btn.classList.toggle('liked', liked);
  btn.title = liked ? 'Unlike' : 'Like';
  btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
}

// The Now Playing view is one of the toast-free fullscreen overlays — like /
// queue / playlist actions confirm with a subtle inline pill over the art.
function npIsOpen() {
  const np = $('#np-backdrop');
  return !!np && !np.hidden;
}

let npFlashTimer = null;
let npFlashHideTimer = null;
function npFlash(msg, iconHtml = '') {
  const el = $('#np-flash');
  if (!el) return;
  el.innerHTML = `${iconHtml}<span>${esc(msg)}</span>`;
  el.hidden = false;
  clearTimeout(npFlashTimer);
  clearTimeout(npFlashHideTimer);
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation on rapid taps
  el.classList.add('show');
  npFlashTimer = setTimeout(() => {
    el.classList.remove('show');
    npFlashHideTimer = setTimeout(() => { el.hidden = true; npFlashHideTimer = null; }, 260);
  }, 1400);
}

// Small heart bounce when the like state changes inside Now Playing.
function popNpLike() {
  const b = $('#np-like');
  if (!b) return;
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}

// Slow marquee for overflowing titles: measure the text, and when it won't
// fit, wrap it in a doubled <span> that slides through the viewport at a
// steady, readable pace (longer titles scroll a touch slower).
function applyMarquee(el, text) {
  if (!el) return;
  const s = String(text || '');
  el.dataset.mqOrig = s; // keep the raw title for a safe reset later
  el.classList.remove('marquee');
  const old = el.querySelector('.m-track');
  if (old) old.remove();
  el.textContent = s;
  // Only measure when the row is actually laid out — a hidden element reports
  // clientWidth 0 and would 'always overflow', doubling every title.
  if (!el.clientWidth) return;
  if (s && el.scrollWidth > el.clientWidth + 2) {
    const dup = document.createElement('span');
    dup.className = 'm-track';
    dup.textContent = s + '    ' + s + '    ';
    el.textContent = '';
    el.appendChild(dup);
    el.classList.add('marquee');
    el.style.setProperty('--marq-dur', `${Math.round(Math.max(8, Math.min(20, s.length / 2.5)))}s`);
  }
}

// Player title: slow marquee when the title overflows the mini bar (long
// titles scroll so the user can read the full name); short titles stay
// static. Re-measured each time the bar becomes visible (setPlayerTitle is
// called inside refreshPlayerVisibility after unhiding), so a hidden bar can
// never inject doubled text.
function setPlayerTitle(text) {
  const el = $('#player-title');
  if (!el) return;
  const s = String(text || '—');
  el.title = s;
  applyMarquee(el, s);
}

// Apply or remove the slow marquee on any row title (cards, search rows,
// album/playlist rows). Only the actually-playing row scrolls, and only while
// the audio is playing (not merely selected); the track-name guard keeps
// play/pause/like toggles from restarting the animation.
function syncRowMarquee(el, name, isPlaying) {
  if (!el) return;
  const audible = EmbedPlay.isActive() ? EmbedPlay.isPlaying() : !curEl().paused;
  if (isPlaying && audible) {
    if (el.dataset.mqName !== name) {
      el.dataset.mqName = name;
      applyMarquee(el, name);
    }
  } else {
    el.dataset.mqName = '';
    el.classList.remove('marquee');
    const m = el.querySelector('.m-track');
    if (m) m.remove();
    el.textContent = name || el.dataset.mqOrig || '';
  }
}


// Smart recommendation as app behavior: when the queue is about to end, grow
// it with songs that match the genre of what's playing — driven by the app's
// Brain (artist genres + the listener's genre profile, affinity-ranked), so
// the Up Next list is never empty and the music never just stops.
let extendRun = 0;
let extendPromise = null;

async function runExtend() {
  if (state.index < 0 || state.queue.length === 0) return false;
  // Proactive: top up well BEFORE the list can run dry (6 left, not 3), and
  // always at the very end, so Up Next never hits zero.
  const atEnd = state.index >= state.queue.length - 1;
  const nearEnd = state.index >= state.queue.length - 6;
  if (!atEnd && !nearEnd) return false;
  const run = ++extendRun;
  const queue = state.queue;
  const seed = queue[state.index] || queue[queue.length - 1];
  const artist = String((seed && seed.artist) || '').trim();
  const trackName = String((seed && seed.name) || '').trim();

  // Generous, layered seeds: current artist's genres, the listener's overall
  // genre profile, then the artist + track names — anything can fill the gap.
  const queries = [];
  if (window.Brain && Brain.genresFor && artist && artist !== 'Unknown artist') {
    const gs = Brain.genresFor(artist) || [];
    gs.slice(0, 2).forEach((g) => queries.push(`${g} mix`, `best ${g} songs`, `${g} hits`));
  }
  if (artist && artist !== 'Unknown artist') queries.push(artist);
  if (trackName) queries.push(trackName);
  if (window.Brain && Brain.genreQueries) queries.push(...Brain.genreQueries(3));
  // Trending knowledge is a freshness layer: what's hot on the internet right
  // now rides along with the context seeds (it's appended BEFORE the 4-query
  // cap below, so it always has a slot in the fetch window).
  if (window.Brain && Brain.trendingQueries) {
    queries.unshift(...Brain.trendingQueries(1));
  }
  if (!queries.length) return false;

  try {
    const results = await Promise.all(
      queries.slice(0, 4).map((q) => MusicEngine.search(q, 14, { noVersions: true }).catch(() => []))
    );
    if (run !== extendRun || state.queue !== queue) return false; // user moved on / queue replaced
    let more = trimRecommendations(results.flat());
    // The Brain ranks by listening affinity — favorites surface first.
    if (window.Brain && Brain.rankResults) more = Brain.rankResults(more);
    const seen = new Set(state.queue.map((t) => t.id));
    const fresh = more.filter((t) => !seen.has(t.id) && !(window.Brain && Brain.isPlayed && Brain.isPlayed(t.id)));
    let picked = fresh.slice(0, 14);
    // Chart fallback: if the searches came back empty or everything was
    // already played, pull fresh tracks from the trending/hot rows — they're
    // cached on Home and always have music, so Up Next genuinely never dries.
    if (!picked.length) {
      try {
        const [tr, hot] = await Promise.all([
          MusicEngine.trending(16).catch(() => []),
          MusicEngine.hotThisWeek(16).catch(() => []),
        ]);
        if (run !== extendRun || state.queue !== queue) return false;
        const more2 = trimRecommendations(tr.concat(hot));
        if (window.Brain && Brain.rankResults) more2.forEach((t) => t && (t.__rank = 0));
        picked = more2.filter((t) => !seen.has(t.id) && !(window.Brain && Brain.isPlayed && Brain.isPlayed(t.id))).slice(0, 10);
      } catch { /* truly offline — nothing left */ }
    }
    if (!picked.length) return false;
    // Flag AI-topped tracks so the queue panel can group them under a
    // "Recommendations" hint (the flag travels with the track objects).
    picked.forEach((t) => { t.__rec = true; });
    state.queue.push(...picked);
    const label = String(queries[0] || artist || 'similar').replace(/ mix$| hits$| songs$/i, '');
    toast(`Playing more ${label}…`);
    updateNowPlayingBar(); // queue grew — refresh the up-next badge
    if (!$('#queue-backdrop').hidden && !queueDragActive) renderQueue(); // show the Recommendations hint live
    return true;
  } catch { return false; }
}

function maybeExtendQueue() {
  if (extendPromise) return extendPromise; // one extension in flight at a time
  extendPromise = runExtend().finally(() => { extendPromise = null; });
  return extendPromise;
}

function nextTrack() {
  if (state.index < 0 || state.queue.length === 0) return;
  // Repeat-one: replay the current track
  if (state.repeat === 'one') {
    playTrackAt(state.index);
    return;
  }
  // Shuffle: smart pick — avoids the current track, same-artist runs, and
  // recently played tracks (falls back to random on tiny/uniform queues).
  if (state.shuffle && state.queue.length > 1) {
    playTrackAt(smartShufflePick());
    return;
  }
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd && state.repeat === 'all') {
    // Repeat-all: wrap the queue back to the start — no extension, the
    // playlist loops as-is.
    playTrackAt(0);
    return;
  }
  if (atEnd) {
    // Never just stop at the end of an album/playlist: top the queue up with
    // genre-matched recommendations first (Brain-driven), then keep playing —
    // like a radio built on what was just playing.
    maybeExtendQueue().then((grew) => {
      if (state.index < 0 || !state.queue.length) return;
      if (grew) {
        playTrackAt(Math.min(state.index + 1, state.queue.length - 1));
        return;
      }
      // Truly nothing more (offline / fetch failed): stop gracefully.
      if (EmbedPlay.isActive()) EmbedPlay.pause();
      else { const el = curEl(); el.pause(); }
      updatePlayIcon(false);
    });
  } else {
    playTrackAt(state.index + 1);
  }
}

function prevTrack() {
  if (state.index < 0 || state.queue.length === 0) return;
  // If >3s into the track, restart instead of going back
  const t = EmbedPlay.isActive() ? EmbedPlay.currentTime() : curEl().currentTime;
  if (t > 3) {
    playTrackAt(state.index);
    return;
  }
  if (state.shuffle && state.queue.length > 1) {
    playTrackAt(smartShufflePick());
  } else {
    playTrackAt((state.index - 1 + state.queue.length) % state.queue.length);
  }
}

on('#btn-play', 'click', () => {
  const el = curEl();
  if (el.paused) el.play().catch(() => {});
  else el.pause();
});

// Seek with MSE awareness: inside the buffered window it's a plain jump;
// outside it, clear the buffer and re-chunk from the new position.
function seekPlayerTo(sec) {
  // Embed mode: the hidden YouTube player seeks itself.
  if (EmbedPlay.isActive()) { EmbedPlay.seekTo(sec); return; }
  const el = curEl();
  if (!el.duration) return;
  const target = Math.min(el.duration, Math.max(0, sec));
  if (el._mse) {
    let inside = false;
    try { for (let i = 0; i < el.buffered.length; i++) if (target >= el.buffered.start(i) && target < el.buffered.end(i)) inside = true; } catch { /* ignore */ }
    if (inside) { el.currentTime = target; return; }
    const s = el._mse;
    const track = s.track, url = s.url;
    const wasPaused = el.paused;
    mseTeardown(el);
    mseStart(el, track, url, { play: !wasPaused, seekTo: target }).catch(() => {
      // Mid-track MSE restart failed — usually because the audio-only URL is
      // CDN-capped past ~1MB and the relay serves the muxed stream (which MSE
      // can't parse). Fall back to plain <audio> on the MUXED stream — the
      // relay serves it as real 206 range responses, so the seek lands.
      try { mseTeardown(el); } catch { /* ignore */ }
      const murl = muxedStreamUrl(url);
      try { el.src = murl; el.load(); } catch { /* ignore */ }
      if (!wasPaused) el.play().catch(() => { /* error listener takes over */ });
      seekAudioQueued(el, target);
    });
    return;
  }
  // Plain <audio> path. The muxed-fallback stream is range-capable but only
  // seekable once the init is parsed — a direct set on an empty seekable
  // range makes this WebView reload from 0. Queue the seek instead.
  // If the stream is entirely NON-seekable (seekable collapsed to [0,0] — the
  // relay served the muxed whole-file 200 without Accept-Ranges when the
  // audio URL was CDN-capped), a queued seek would silently drop. Re-point
  // the element at the muxed=1 stream, which the relay serves with real 206
  // range responses, so the seek can land.
  const sk = el.seekable;
  // Only re-point once the element has actually loaded (readyState >= 1): a
  // healthy stream reports a real seekable range as soon as metadata parses,
  // while a whole-file 200 stays [0,0] even after fully buffering.
  const notRangeable = el.readyState >= 1 && (!sk || !sk.length || sk.end(sk.length - 1) <= sk.start(0));
  if (notRangeable && el.src && el.src.includes('/stream')) {
    const murl = muxedStreamUrl(el.src);
    if (murl !== el.src) {
      try {
        const wasPaused = el.paused;
        el.src = murl;
        el.load();
        if (!wasPaused) el.play().catch(() => { /* error listener takes over */ });
      } catch { /* error listener takes over */ }
    }
  }
  seekAudioQueued(el, target);
}

on('#seek', 'change', () => {
  const d = EmbedPlay.isActive() ? EmbedPlay.duration() : curEl().duration;
  if (d) seekPlayerTo((Number($('#seek').value) / 1000) * d);
});
on('#volume', 'input', () => {
  state.userVol = Number($('#volume').value) / 100;
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  if (EmbedPlay.isActive()) EmbedPlay.setVolume(state.userVol);
  $('#np-volume').value = $('#volume').value;
  saveSession();
});

/* ------------------------------ now playing (fullscreen) ------------------------------ */

// Re-open an overlay cleanly: strip any leftover `.closing` state (a quick
// close→reopen while the closing animation still runs would otherwise hold
// the sheet invisible via the animation's fill), then show + animate in.
function openOverlay(bd) {
  if (!bd) return;
  bd.classList.remove('closing');
  bd.style.transform = '';
  bd.style.opacity = '';
  const panel = bd.querySelector('.np');
  if (panel) {
    panel.classList.remove('closing');
    panel.style.transform = '';
    panel.style.opacity = '';
    // Belt-and-braces: a stale hidden from a previous close must never leave
    // the reopen showing a blank sheet (the blank-Now-Playing bug).
    panel.hidden = false;
  }
  bd.hidden = false;
  requestAnimationFrame(() => bd.classList.add('open'));
  hideToast(); // fullscreen views are toast-free — clear anything visible
}

// Shared-element open: the mini player's small cover morphs into the big
// Now Playing cover (same layer — the mini player keeps running underneath,
// just covered). The panel's swoosh is suppressed (morph-open) and only the
// art travels: translate + scale from the mini cover's rect to its final
// centered position; the rest of the content fades up after it.
let npMorphTimer = null;
let npMiniBarRect = null; // the mini player bar's rect while the box is open
let npMiniCoverRect = null; // the mini player cover's rect while the box is open

function openNowPlaying() {
  const bd = $('#np-backdrop');
  if (!bd) return;
  // The box grows out of the MINI PLAYER BAR (its whole footprint: 8px side
  // insets, bottom at nav+8), and the cover inside travels from the small
  // cover's rect. Capture both rects BEFORE the bar is hidden by the box.
  const bar = $('#player');
  const barRect = (bar && !bar.hidden && bar.offsetHeight) ? bar.getBoundingClientRect() : null;
  const mini = $('#player-cover');
  const miniRect = mini && mini.offsetWidth ? mini.getBoundingClientRect() : null;
  npMiniBarRect = barRect;
  npMiniCoverRect = miniRect;
  // Tag the backdrop BEFORE openOverlay adds `.open` so the swoosh never
  // starts; morph-open keeps the panel static and drives the art instead.
  if (barRect) bd.classList.add('morph-open');
  // Each open starts with the About sheet in its compact (collapsed) state.
  const boxEl = $('#np');
  if (boxEl) boxEl.classList.remove('np-expanded');
  openOverlay(bd);
  $('#np-volume').value = $('#volume').value;
  updateNowPlaying();
  refreshNpTier();
  $('#np-close').focus();
  // The box IS the expanded mini player — hide the separate bar underneath.
  if (bar) bar.hidden = true;
  if (barRect) {
    const art = $('#np-art');
    // The whole box starts as the mini player bar's exact footprint (same
    // width, 64px tall, bottom at the nav) and expands all the way up — the
    // Now Playing lives inside the grown mini player box. The cover inside
    // travels to its big position in sync.
    const panel = bd.querySelector('.np');
    if (panel) {
      const pr = panel.getBoundingClientRect();
      const sx = Math.max(0.05, barRect.width / Math.max(1, pr.width));
      const sy = Math.max(0.05, barRect.height / Math.max(1, pr.height));
      panel.style.transformOrigin = '50% 100%';
      panel.style.transition = 'none';
      panel.style.transform = `scale(${sx}, ${sy})`;
      void panel.offsetWidth; // commit the start state
      panel.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.9, 0.3, 1)';
      panel.style.transform = 'scale(1, 1)';
    }
    if (art) {
      // Kill any entrance/breathe animation that would fight the inline
      // morph transform (updateNowPlaying adds np-art-in on a plain open).
      art.classList.remove('np-art-in', 'np-slide-left', 'np-slide-right', 'live');
      art.style.animation = 'none';
      const artRect = art.getBoundingClientRect();
      if (artRect.width > 0) {
        const s = miniRect.width / artRect.width;
        const dx = (miniRect.left + miniRect.width / 2) - (artRect.left + artRect.width / 2);
        const dy = (miniRect.top + miniRect.height / 2) - (artRect.top + artRect.height / 2);
        art.style.transformOrigin = 'center center';
        art.style.transition = 'none';
        art.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
        void art.offsetWidth; // commit the start state
        art.style.transition = 'transform 0.55s cubic-bezier(0.2, 0.9, 0.3, 1)';
        art.style.transform = 'translate(0, 0) scale(1)';
      }
    }
    clearTimeout(npMorphTimer);
    npMorphTimer = setTimeout(() => {
      if (art) {
        art.style.transition = '';
        art.style.transform = '';
        art.style.animation = '';
      }
      if (panel) {
        panel.style.transition = '';
        panel.style.transform = '';
      }
      bd.classList.remove('morph-open');
      // morph-open was what suppressed the entrance swoosh — with it gone,
      // np-in would fire a SECOND slide-up. Mark the panel settled so the
      // swoosh stays suppressed for the rest of this open.
      if (panel) panel.classList.add('np-settled');
    }, 620);
  }
}

// Shared slide-down close animation for every overlay. Adds a `.closing`
// class that reverses the entrance (the panel slides down and fades), and
// only hides the element once the animation finished (or a safety timeout,
// in case animationend never fires).
function closeWithAnim(el, ms = 340, keepVisible = false) {
  if (!el || el.hidden) return;
  el.classList.remove('open');
  el.classList.add('closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(t);
    el.classList.remove('closing');
    el.style.transform = '';
    el.style.opacity = '';
    // The backdrop owns visibility for fullscreen overlays — a panel closed
    // with keepVisible stays unhidden so a reopen shows it immediately.
    if (!keepVisible) el.hidden = true;
    // The Now Playing box grew out of the mini player — once the backdrop is
    // gone the bar comes back (refreshPlayerVisibility keeps it hidden while
    // the box is open).
    if (el.id === 'np-backdrop') refreshPlayerVisibility();
  };
  const t = setTimeout(finish, ms);
  el.addEventListener('animationend', (e) => { if (e.target === el) finish(); }, { once: true });
}

// The backdrop slides down with its `.np` panel, so close reads as a single
// downward motion.
function closeOverlay(bd, instant = false) {
  if (!bd) return;
  if (instant) {
    // A momentum pull-to-close already threw the sheet off-screen — hide
    // immediately with NO further animation (no quick re-slide, no fade).
    if (bd.id === 'np-backdrop') npPeekStop();
    bd.classList.remove('open', 'closing');
    bd.hidden = true;
    // The box is gone — the mini player bar it grew out of comes back.
    refreshPlayerVisibility();
    const panel = bd.querySelector('.np');
    if (panel) {
      panel.classList.remove('closing', 'dragging', 'np-settled');
      panel.style.transition = '';
      panel.style.transform = '';
      panel.style.opacity = '';
    }
    const flash = $('#np-flash');
    if (flash) { flash.classList.remove('show'); flash.hidden = true; }
    return;
  }
  closeWithAnim(bd);
  // The panel only animates the slide — hiding the backdrop hides it too, and
  // keeping the panel visible means a quick reopen never shows a blank sheet.
  const panel = bd && bd.querySelector('.np');
  if (panel) {
    // A morph-open marked the panel settled to stop the double slide-up.
    // Clear it on close so the next open animates normally again. The
    // dropdown toast strip resets too — a stale toast-open must never make
    // the next toast skip its drop.
    panel.classList.remove('np-settled', 'toast-open');
    closeWithAnim(panel, 360, true);
  }
  // Reset the inline Now Playing feedback pill so a quick reopen never shows
  // a stale flash from the previous visit.
  const flash = $('#np-flash');
  if (flash) { flash.classList.remove('show'); flash.hidden = true; }
}

// The retract morph's shared math — the literal REVERSE of the opening grow.
// The whole box scales about its BOTTOM edge (origin 50% 100%) down to the
// mini player bar's exact footprint, so the TOP edge comes down and the box
// itself becomes the mini player; the art inside travels back from big to
// the mini cover (uniform scale about its center + carry onto the mini cover
// center). These are the SAME values the opening morph starts FROM, so the
// close is the exact reverse of the open. Returns null when there's nothing
// to morph into. Used by BOTH the tap-outside close and the swipe-down
// eat-close so both paths retract identically.
function npRetractParams() {
  const panel = $('#np');
  if (!panel) return null;
  // Use the LAYOUT size (offsetWidth/offsetHeight), NOT getBoundingClientRect:
  // during a close the panel carries a scale transform, so the rect would be
  // the mid-collapse (already-shrunken) size — that would make sy recompute as
  // barH/shrunkenH and feed back into the next move, sticking the box at
  // ~30% height on slow drags (a feedback loop: sy -> 0.09/sy, stable at
  // sy = sqrt(0.09) = 0.3). Layout size is immune to the transform. Also
  // NO getBoundingClientRect at all here — offset reads are layout-cheap and
  // this runs once per close, not per drag frame.
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  if (pw <= 0 || ph <= 0) return null;
  const barRect = npMiniBarRect;
  // Box scale about the bottom edge: bar footprint vs full box size.
  const sx = Math.max(0.05, barRect ? barRect.width / pw : 0.94);
  const sy = Math.max(0.05, barRect ? barRect.height / ph : 0.09);
  return { sx, sy };
}

// Counter-scale for the in-box mini player row during a close: the box
// collapses about its bottom edge (scale 1, sy) while the mini row scales by
// the inverse about its own bottom-center (which is the box's bottom-center),
// so the row stays EXACTLY fixed on screen and fills the collapsing box's
// 64px base — the box becomes the mini player. Pure transform writes, no
// layout reads — 30fps-friendly. The Now Playing CONTENT is NOT counter-
// scaled anymore: it fades out fast at the start of the collapse (while the
// box is still ~90% tall, so nothing visibly squashes), and a big content
// layer is never held in sync — the drag stays cheap on weak phones.
function npMiniCounterTransform(sy, transition = '') {
  const mini = $('#np-mini');
  if (!mini) return;
  const inv = sy > 0.05 ? 1 / sy : 20;
  mini.style.transition = transition;
  mini.style.transformOrigin = '50% 100%';
  mini.style.transform = `scale(1, ${inv.toFixed(4)})`;
}

// Reset the in-box mini row back to identity (no transform, no transition).
function npMiniReset(transition = '') {
  const mini = $('#np-mini');
  if (!mini) return;
  mini.style.transition = transition;
  mini.style.transform = '';
  mini.style.transformOrigin = '';
}

// Reverse shared-element close: the big cover shrinks back to the mini
// player's cover rect while the backdrop fades, so the whole interaction
// reads as one window expanding and contracting. Falls back to the plain
// slide-down if the mini player isn't visible (no track / hidden bar).
let npMorphCloseTimer = null;
function closeNowPlaying() {
  // A close morph is already running (surface-press pointerup + the browser's
  // synthesized click both land close together) — never start a second one.
  if (npMorphCloseTimer) return;
  closeNpAi(); // the AI sheet belongs to the box — it leaves with it
  npPeekStop(); // never leave a preview stream playing behind a closed box
  const bd = $('#np-backdrop');
  // The box shrinks back into the mini player bar: show the bar first so it
  // catches the shrink exactly (same footprint: 8px insets, bottom at nav+8),
  // then scale the box down onto it.
  const bar = $('#player');
  if (bar) bar.hidden = false;
  const art = $('#np-art');
  // No mini cover to morph into — hide instantly (the box just disappears,
  // never a slide-down).
  if (!bd || bd.hidden || !art) { closeOverlay(bd, true); return; }
  bd.classList.add('morph-open'); // hold the panel static during the morph
  // STAGED CONNECTED close (the reverse of the opening grow, no cut):
  //  1) np-closing fades ALL Now Playing contents (title, art, seek, controls,
  //     queue) OUT fast — the content stays in place and fades while the box
  //     is still nearly full height, so nothing visibly squashes;
  //  2) the BOX collapses about its BOTTOM edge while the in-box mini row is
  //     counter-scaled — it stays fixed and fills the shrinking base, so the
  //     box literally becomes the mini player;
  //  3) the box's glass morphs to the mini bar's look (same tone + radius)
  //     as it lands on the bar beneath (shown at full opacity the whole
  //     time) — one connected box, the bar never disappears or re-appears.
  // GPU-composited transforms + a couple of cheap color/radius tweens — 30fps.
  const panel = bd.querySelector('.np');
  const p = npRetractParams();
  if (!panel || !p) { closeOverlay(bd, true); return; }
  const { sx, sy } = p;
  art.classList.remove('np-art-in', 'np-slide-left', 'np-slide-right', 'live');
  art.style.animation = 'none';
  panel.classList.add('np-closing'); // fades contents; drops blur for the GPU scale
  panel.style.transformOrigin = '50% 100%';
  panel.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1), background-color 0.4s ease 0.08s, border-radius 0.4s ease 0.08s';
  panel.style.transform = `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  // The glass becomes the mini bar's glass — identical tone + radius — so the
  // box IS the bar when it lands (the bar underneath is the same look).
  panel.style.background = 'rgba(28, 28, 30, 0.55)';
  panel.style.borderRadius = '16px';
  // The in-box mini row stays fixed and fills the base; clear any inline
  // opacity left by a previous drag so the CSS (np-closing) fade-in applies.
  const body = $('#np-body');
  if (body) body.style.opacity = '';
  const mini = $('#np-mini');
  if (mini) mini.style.opacity = '';
  npMiniCounterTransform(sy, 'transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.25s ease 0.16s');
  clearTimeout(npMorphCloseTimer);
  npMorphCloseTimer = setTimeout(() => {
    npMorphCloseTimer = null;
    panel.classList.remove('np-closing');
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.transformOrigin = '';
    panel.style.background = '';
    panel.style.borderRadius = '';
    art.style.transition = '';
    art.style.transform = '';
    art.style.animation = '';
    if (body) body.style.opacity = '';
    if (mini) mini.style.opacity = '';
    npMiniReset();
    bd.classList.remove('morph-open');
    closeOverlay(bd, true); // instant hide after the retract finishes
  }, 520);
}

// Instant hide used after a momentum pull-to-close finishes its throw.
function closeNowPlayingInstant() {
  closeNpAi();
  npPeekStop();
  closeOverlay($('#np-backdrop'), true);
}

/* ============================ generic overlay morph ============================
   Every fullscreen overlay (album, playlist, genre, queue) now opens and
   closes with the SAME shared-element animation as Now Playing: the panel
   grows out of the mini player bar's footprint (or a same-shape bottom strip
   when nothing is playing yet), and the drag-down close eats the panel back
   into that footprint — never a plain slide. All per-frame work is pure
   transform/opacity writes from cached geometry — 30fps-safe on weak phones. */

// The anchor footprint every overlay grows from / collapses into: the mini
// player bar (8px side insets, ~64px tall, sitting on the nav). When the bar
// is hidden (no track yet) a same-shape bottom strip stands in, so the
// animation is identical regardless of playback state.
function morphAnchorRect() {
  const bar = $('#player');
  if (bar && !bar.hidden && bar.offsetHeight) return bar.getBoundingClientRect();
  const nav = $('#bottom-nav');
  const navH = (nav && nav.offsetHeight) || 64;
  const w = window.innerWidth, h = window.innerHeight;
  return { left: 8, top: h - navH - 8 - 64, width: w - 16, height: 64, right: w - 8, bottom: h - navH - 8 };
}

// The mini player cover's rect — the source an overlay's header cover art
// travels from (mirrors the Now Playing open). null when the bar is hidden.
function morphCoverAnchor() {
  const mini = $('#player-cover');
  return (mini && mini.offsetWidth) ? mini.getBoundingClientRect() : null;
}

// Scale factors from the anchor footprint to the panel's LAYOUT size
// (offsetWidth/offsetHeight — immune to a mid-drag scale transform, so the
// drag never feeds back into its own math). null when the panel has no size.
function morphScaleFrom(src, panel) {
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  if (pw <= 0 || ph <= 0 || !src) return null;
  return {
    sx: Math.max(0.05, src.width / pw),
    sy: Math.max(0.05, src.height / ph),
  };
}

// The anchor each backdrop grew out of, kept so the close (button or drag)
// collapses back into the EXACT same footprint.
const morphAnchorStore = new WeakMap();

// Per-backdrop cleanup timers (stored ON the backdrop): a close → quick-
// reopen of the same overlay must cancel the leftover close timer, or it
// would hide the freshly-opened panel mid-grow.

// Shared-element OPEN for any overlay: the panel starts as the anchor
// footprint and grows up; an optional cover element (album/playlist art)
// travels from the mini player cover to its final position in sync. Exactly
// the Now Playing grow, made generic.
function morphOpenOverlay(bd, opts = {}) {
  const panel = bd && bd.querySelector('.np');
  if (!bd || !panel) return;
  // Cancel a leftover close morph of this same backdrop, and strip whatever
  // the close left behind — the reopen must start from a clean panel.
  if (bd._morphCloseTimer) { clearTimeout(bd._morphCloseTimer); bd._morphCloseTimer = null; }
  panel.classList.remove('np-closing', 'dragging');
  panel.style.transition = '';
  panel.style.transform = '';
  panel.style.transformOrigin = '';
  panel.style.background = '';
  panel.style.borderRadius = '';
  Array.from(panel.children).forEach((el) => { el.style.transition = ''; el.style.opacity = ''; });
  const src = opts.source || morphAnchorRect();
  morphAnchorStore.set(bd, src);
  // Suppress the entrance swoosh BEFORE openOverlay adds `.open`.
  bd.classList.add('morph-open');
  openOverlay(bd);
  const art = opts.cover;
  if (art) {
    art.classList.remove('album-art-in', 'np-art-in', 'np-slide-left', 'np-slide-right', 'live');
    art.style.animation = 'none';
  }
  const pr = panel.getBoundingClientRect();
  const sx = Math.max(0.05, src.width / Math.max(1, pr.width));
  const sy = Math.max(0.05, src.height / Math.max(1, pr.height));
  panel.style.transformOrigin = '50% 100%';
  panel.style.transition = 'none';
  panel.style.transform = `scale(${sx}, ${sy})`;
  void panel.offsetWidth; // commit the start state
  panel.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.9, 0.3, 1)';
  panel.style.transform = 'scale(1, 1)';
  if (art) {
    const artRect = art.getBoundingClientRect(); // squashed layout — the start
    const miniRect = morphCoverAnchor();
    if (miniRect && artRect.width > 0) {
      const s = miniRect.width / artRect.width;
      const dx = (miniRect.left + miniRect.width / 2) - (artRect.left + artRect.width / 2);
      const dy = (miniRect.top + miniRect.height / 2) - (artRect.top + artRect.height / 2);
      art.style.transformOrigin = 'center center';
      art.style.transition = 'none';
      art.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
      void art.offsetWidth;
      art.style.transition = 'transform 0.55s cubic-bezier(0.2, 0.9, 0.3, 1)';
      art.style.transform = 'translate(0, 0) scale(1)';
    }
  }
  clearTimeout(bd._morphOpenTimer);
  bd._morphOpenTimer = setTimeout(() => {
    bd._morphOpenTimer = null;
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.transformOrigin = '';
    if (art) {
      art.style.transition = '';
      art.style.transform = '';
      art.style.animation = '';
    }
    bd.classList.remove('morph-open');
    if (panel) panel.classList.add('np-settled'); // swoosh stays off for this open
  }, 620);
}

// Shared-element CLOSE for any overlay: the reverse of the grow. The mini bar
// is revealed underneath again, the content fades out fast (CSS), and the
// panel collapses back into the anchor footprint. Ends with an instant hide —
// never a slide-down.
function morphCloseOverlay(bd) {
  const panel = bd && bd.querySelector('.np');
  if (!bd || bd.hidden || !panel) { closeOverlay(bd, true); return; }
  if (bd._morphCloseTimer) return; // a close is already morphing — no double-run
  // A grow is still settling on this backdrop — the close takes over from it.
  if (bd._morphOpenTimer) { clearTimeout(bd._morphOpenTimer); bd._morphOpenTimer = null; }
  const src = morphAnchorStore.get(bd) || morphAnchorRect();
  const s = morphScaleFrom(src, panel);
  if (!s) { closeOverlay(bd, true); return; }
  // The box collapses onto the bar — show it first (but never while the Now
  // Playing box is open on top; its own close manages the bar).
  const bar = $('#player');
  const npOpen = !$('#np-backdrop').hidden;
  if (bar && !npOpen) bar.hidden = false;
  bd.classList.add('morph-open'); // hold the panel static during the collapse
  panel.classList.add('np-closing'); // CSS fades the overlay's content out fast
  panel.style.transformOrigin = '50% 100%';
  panel.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1), background-color 0.4s ease 0.08s, border-radius 0.4s ease 0.08s';
  panel.style.transform = `scale(${s.sx.toFixed(4)}, ${s.sy.toFixed(4)})`;
  // The glass becomes the mini bar's glass — identical tone + radius — so the
  // panel IS the bar when it lands.
  panel.style.background = 'rgba(28, 28, 30, 0.55)';
  panel.style.borderRadius = '16px';
  clearTimeout(bd._morphCloseTimer);
  bd._morphCloseTimer = setTimeout(() => {
    bd._morphCloseTimer = null;
    panel.classList.remove('np-closing');
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.transformOrigin = '';
    panel.style.background = '';
    panel.style.borderRadius = '';
    bd.classList.remove('morph-open');
    closeOverlay(bd, true); // instant hide after the retract finishes
  }, 520);
}

// The eat-close target used by a drag that passed its threshold: finish the
// collapse from wherever the finger left it, then hide instantly. Pure
// transform writes from the CACHED scale — no layout reads.
function morphEatClose(panel, bd, src) {
  const s = morphScaleFrom(src, panel);
  if (!s) { closeOverlay(bd, true); return; }
  const kids = Array.from(panel.children);
  panel.classList.add('np-closing');
  panel.style.transformOrigin = '50% 100%';
  panel.style.transition = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.3, 1), background-color 0.3s ease 0.06s, border-radius 0.3s ease 0.06s';
  panel.style.transform = `scale(${s.sx.toFixed(4)}, ${s.sy.toFixed(4)})`;
  panel.style.background = 'rgba(28, 28, 30, 0.55)';
  panel.style.borderRadius = '16px';
  setTimeout(() => {
    panel.classList.remove('np-closing', 'dragging');
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.transformOrigin = '';
    panel.style.background = '';
    panel.style.borderRadius = '';
    kids.forEach((el) => { el.style.transition = ''; el.style.opacity = ''; });
    bd.classList.remove('morph-open');
    closeOverlay(bd, true);
  }, 400);
}

// Drag-to-close for any overlay, with the Now Playing eat effect: pulling
// down scales the panel about its bottom edge toward the anchor footprint
// while the content fades out; past the threshold (or a downward flick) the
// collapse completes and the overlay hides — the panel becomes the mini bar.
// Scrolling wins while the scroll container isn't at its top.
function setupMorphDrag(panel, scrollEl, closeFn) {
  if (!panel) return;
  const bd = panel.closest('.np-backdrop');
  let startY = 0, lastY = 0, lastT = 0, dy = 0, vel = 0, pulling = false;
  let geo = null; // cached { src, sx, sy, content } — read ONCE per drag

  const onStart = (e) => {
    // Track EVERY touch (even on buttons — the genre page's playlist cards
    // are buttons, and pulling down from one must still close). A plain tap
    // stays a tap: the drag only engages once the finger clearly moves
    // down, and preventDefault is only called then, so the button's click
    // still fires for taps.
    startY = lastY = e.touches[0].clientY;
    lastT = performance.now();
    dy = 0; vel = 0; pulling = false;
    const src = morphAnchorStore.get(bd) || morphAnchorRect();
    const s = morphScaleFrom(src, panel);
    if (s) {
      geo = { src, sx: s.sx, sy: s.sy, content: Array.from(panel.children) };
      geo.content.forEach((el) => { el.style.transition = 'none'; });
    } else geo = null;
  };
  panel.addEventListener('touchstart', onStart, { passive: true });

  const onMove = (e) => {
    if (startY === 0) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    dy = y - startY;
    // Dragging up, or the list is scrolled down — native scroll wins.
    if (dy <= 0 || (scrollEl && scrollEl.scrollTop > 0)) { startY = y; lastY = y; lastT = now; dy = 0; vel = 0; pulling = false; return; }
    // Small dead-zone: a finger resting on a button isn't a drag yet — the
    // tap still clicks. Once the pull is real, the drag owns the gesture.
    if (!pulling && dy < 12) return;
    pulling = true;
    const dt = Math.max(1, now - lastT);
    vel = vel * 0.6 + ((y - lastY) / dt) * 0.4;
    lastY = y; lastT = now;
    e.preventDefault();
    panel.classList.add('dragging');
    const prog = Math.min(1, (dy * 0.7) / 300);
    if (geo) {
      const sy = 1 - (1 - geo.sy) * prog;
      const sx = 1 - (1 - geo.sx) * prog;
      panel.style.transformOrigin = '50% 100%';
      panel.style.transform = `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      // Content fades out fast (~10% collapse) so nothing visibly squashes.
      const f = Math.max(0, Math.min(1, (prog - 0.08) / 0.3));
      const o = (1 - f).toFixed(3);
      geo.content.forEach((el) => { el.style.opacity = o; });
    } else {
      panel.style.transform = `translateY(${Math.round(dy * 0.7)}px)`;
    }
  };
  panel.addEventListener('touchmove', onMove, { passive: false });

  const settle = () => {
    panel.classList.remove('dragging');
    const shouldClose = dy > 100 || vel > 0.55;
    if (!shouldClose) {
      // Snap back up — restore the full panel.
      panel.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
      panel.style.transform = '';
      if (geo) geo.content.forEach((el) => { el.style.transition = 'opacity 0.2s ease'; el.style.opacity = ''; });
      setTimeout(() => {
        if (!pulling) {
          panel.style.transition = '';
          if (geo) geo.content.forEach((el) => { el.style.transition = ''; el.style.opacity = ''; });
        }
      }, 320);
      return;
    }
    if (geo) {
      // Eat-complete: finish the collapse into the anchor, then hide.
      morphEatClose(panel, bd, geo.src);
      return;
    }
    // Fallback (no cached geometry): throw the sheet off with momentum.
    const drop = Math.min(Math.max(panel.offsetHeight, 480), 1400);
    const remaining = Math.max(0, drop - Math.round(dy * 0.7));
    const dur = Math.max(0.16, Math.min(0.6, remaining / Math.max(vel * 1000, 900)));
    panel.style.transition = `transform ${dur}s cubic-bezier(0.4, 0, 0.2, 1)`;
    panel.style.transform = `translateY(${drop}px)`;
    setTimeout(() => {
      if (!pulling) {
        panel.style.transition = '';
        panel.style.transform = '';
        closeFn();
      }
    }, dur * 1000 + 40);
  };

  const end = () => {
    if (!pulling) {
      startY = 0;
      if (geo) geo.content.forEach((el) => { el.style.transition = ''; el.style.opacity = ''; });
      return;
    }
    pulling = false;
    startY = 0;
    settle();
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}

// Direction of the last track change inside Now Playing: -1 = forward (next /
// swipe-left), +1 = backward (prev / swipe-right), 0 = no directional slide
// (open, restart, direct card tap in place). Set by playTrackAt.
let npSlideDir = 0;

// Streaming adaptation chip — mirrors the engine's live stream tier and
// truncation cushion so users can SEE the app adapting to the connection.
// Tier: 'high' | 'standard' | 'low' (resolved; manual pins show as-is, auto
// shows the resolved tier). Cushion: 0..2 — >0 lights the orange dot.
let lastTierText = '';
let lastTierCushion = false;
function refreshNpTier() {
  const txt = $('#np-tier-text');
  const chip = $('#np-tier');
  if (!txt || !chip || !window.MusicEngine) return;
  let tier = 'high', cushion = 0, mode = 'Auto';
  try {
    if (MusicEngine.qualitySetting && MusicEngine.qualitySetting() !== 'auto') mode = 'Pinned';
    if (MusicEngine.streamTier) tier = MusicEngine.streamTier() || 'high';
    if (MusicEngine.truncationCushion) cushion = MusicEngine.truncationCushion() || 0;
  } catch { /* engine not ready */ }
  const label = { high: 'High', standard: 'Standard', low: 'Low' }[tier] || tier;
  const text = `${mode} · ${label}`;
  if (text !== lastTierText) { txt.textContent = text; lastTierText = text; }
  const on = cushion > 0;
  if (on !== lastTierCushion) { chip.classList.toggle('cushion', on); lastTierCushion = on; }
}

// Poll the chip while the Now Playing box is open — the tier can step mid-
// session (speed + truncation signals), so a light 2s tick keeps it live
// without any per-frame cost.
setInterval(() => {
  const bd = $('#np-backdrop');
  if (bd && !bd.hidden) refreshNpTier();
}, 2000);

function updateNowPlaying() {
  const dir = npSlideDir;
  npSlideDir = 0;
  const bd = $('#np-backdrop');
  if (!bd || bd.hidden) return;
  const track = state.currentTrack;
  if (!track) return;
  refreshNpTier();
  refreshNpAi(); // the assistant follows the playing song
  applyMarquee($('#np-title'), track.name);
  $('#np-artist').textContent = track.artist;
  const art = $('#np-art');
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  // HD art for the big cover: Google-CDN covers get bumped to a 1080px
  // render, YouTube thumbs to maxresdefault — crisp on a fullscreen phone,
  // falling back to the original thumbnail if the hi-res one isn't served.
  const origCover = track.cover || '';
  const imgSrc = (origCover ? upscaleArtHD(origCover) : '') || (vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '');
  // Clear the old cover but KEEP a slide ghost if one is mid-flight — it's
  // the previous track's cover sliding out inside the frame (see
  // playNpSlideTransition) and must not be wiped by the re-render.
  [...art.children].forEach((c) => { if (!c.classList.contains('np-art-ghost')) c.remove(); });
  if (imgSrc) {
    const img = document.createElement('img');
    img.src = imgSrc;
    img.alt = '';
    img.dataset.orig = origCover;
    // maxresdefault 404s for some videos — fall back to the original
    // thumbnail, then the OrBeat logo as a last resort.
    img.onerror = function() {
      if (this.dataset.orig && this.src !== this.dataset.orig) { this.src = this.dataset.orig; return; }
      this.outerHTML = '<div class="noimg logo-fallback">' + LOGO_FB + '</div>';
    };
    art.appendChild(img);
  } else {
    const noimg = document.createElement('div');
    noimg.className = 'noimg logo-fallback';
    noimg.innerHTML = LOGO_FB;
    art.appendChild(noimg);
  }
  // Color wash from the album art's colors (blob-sampled so cross-origin
  // art never taints the canvas).
  artToGradient(imgSrc, $('.np-glow'));
  // Cover motion on a track change. Two paths, both pure translation (no
  // fade): a touch swipe / next / prev runs the CONTINUOUS slide (the ghosted
  // old cover leaves while the new one enters — npPendingSlide), everything
  // else (open, restart, card tap in place) uses the scale-in entrance.
  const pending = npPendingSlide;
  npPendingSlide = null;
  art.classList.remove('np-art-in', 'np-slide-left', 'np-slide-right', 'live');
  // The sliding element is the inner row — .np-info itself is just the clip
  // (overflow:hidden) that keeps the old/next title layers from overlapping.
  const info = $('.np-info-row');
  if (pending) {
    // The old cover + title were ghosted by playNpSlideTransition and are
    // sliding out toward dir*W on their own (inside the static art frame).
    // The NEW content fades UP in place with the same fast fade as the
    // collapse close — no transform slide, so the ghosts' exit motion is
    // never disturbed. The new cover's decode + color-sampling + queue
    // re-render all happen while the art is (almost) invisible, and the
    // composited opacity fade keeps running on the GPU even if the main
    // thread hiccups — the swipe never stutters.
    // NOTE: np-dragging is deliberately NOT added here — its CSS kills the
    // transition (transition:none !important), which would snap the fade.
    art.style.transition = 'none';
    art.style.transform = ''; // snap back to rest while invisible (a released
    art.style.opacity = '0';  //  swipe left a translateX(dx) on the art)
    void art.offsetWidth; // commit the invisible state
    art.style.transition = 'opacity 0.24s ease 0.1s';
    art.style.opacity = '1';
    if (info) {
      info.style.transition = 'none';
      info.style.transform = '';
      info.style.opacity = '0';
      void info.offsetWidth;
      info.style.transition = 'opacity 0.24s ease 0.1s';
      info.style.opacity = '1';
    }
    // Give the ghosts (old cover + title) time to finish their exit before
    // clearing the inline fades.
    const settle = Math.max(360, pending.ghostMs || 360) + 60;
    setTimeout(() => {
      art.style.transition = '';
      art.style.transform = '';
      art.style.opacity = '';
      if (info) { info.style.transition = ''; info.style.transform = ''; info.style.opacity = ''; }
    }, settle);
  } else {
    // No inline transform may survive a track change (a cancelled swipe or a
    // >3s restart leaves one) — always reset before the entrance.
    art.style.transition = '';
    art.style.transform = '';
    if (info) { info.style.transition = ''; info.style.transform = ''; }
    if (dir) {
      // Non-touch next/prev: smooth directional slide, fade-free.
      art.classList.add(dir < 0 ? 'np-slide-left' : 'np-slide-right');
      if (info) {
        info.classList.remove('np-slide-left', 'np-slide-right');
        void info.offsetWidth;
        info.classList.add(dir < 0 ? 'np-slide-left' : 'np-slide-right');
      }
    } else {
      art.classList.add('np-art-in');
      if (EmbedPlay.isActive() ? EmbedPlay.isPlaying() : !curEl().paused) art.classList.add('live');
    }
  }
  // Update like buttons (mini player + now-playing heart)
  const liked = isLiked(track.id);
  const miniLike = $('#mini-like');
  if (miniLike) miniLike.classList.toggle('liked', liked);
  updateNpLike();
  if (window.OfflineCache) refreshDownloadButtons();
}

// Paint a backdrop from an image's colors — three vertical samples
// (top/mid/bottom) become a full-screen gradient, Spotify-style. Used by the
// Now Playing screen (default target .np-glow) and the album page (#album-glow).
function applyNpGradient(img, target) {
  const glow = target || $('.np-glow');
  if (!glow) return;
  const fallback = 'linear-gradient(180deg, rgba(255,106,0,0.22), rgba(255,106,0,0.06) 45%, transparent 78%)';
  if (!img || !img.complete || !img.naturalWidth) {
    if (img) img.onload = () => applyNpGradient(img, target);
    glow.style.background = fallback;
    return;
  }
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    c.width = 3; c.height = 3;
    ctx.drawImage(img, 0, 0, 3, 3);
    const d = ctx.getImageData(0, 0, 3, 3).data;
    const at = (x, y) => `${d[(y * 3 + x) * 4]},${d[(y * 3 + x) * 4 + 1]},${d[(y * 3 + x) * 4 + 2]}`;
    const top = at(1, 0), mid = at(1, 1), bot = at(1, 2);
    glow.style.background = `linear-gradient(180deg, rgba(${top},0.5) 0%, rgba(${mid},0.22) 38%, rgba(${bot},0.10) 58%, transparent 66%)`;
  } catch { glow.style.background = fallback; }
}

// Sample an art URL's colors WITHOUT canvas tainting: a cross-origin <img>
// (no crossOrigin attr) always taints the canvas even on CORS-friendly hosts,
// so getImageData throws and the gradient silently stays green. Fetching the
// art as a blob gives a same-origin URL — sampling always works, and a failed
// fetch simply keeps the CSS fallback gradient.
//
// A per-target generation counter guards against races: rapid track/album
// switches make the old fetch resolve last, which would overpaint the new
// track's backdrop with stale colors. Each call bumps the generation for its
// target, and the onload only paints if it's still the latest.
const gradRun = new WeakMap(); // target element -> latest generation id

async function artToGradient(src, target) {
  // A missing glow element must never crash the open — WeakMap keys can't be
  // null, so guard before the generation read.
  if (!src || !target) return;
  const gen = (gradRun.get(target) || 0) + 1;
  gradRun.set(target, gen);
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (gradRun.get(target) === gen) applyNpGradient(img, target);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  } catch { /* keep the fallback gradient */ }
}

function togglePlay() {
  // Embed mode: the hidden YouTube player owns playback, not <audio>.
  if (EmbedPlay.isActive()) {
    if (EmbedPlay.isPlaying()) EmbedPlay.pause();
    else EmbedPlay.resume();
    return;
  }
  const el = curEl();
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

function updatePlayIcon(playing) {
  const d = playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M8 5v14l11-7z';
  const pp = $('#play-path');
  const npp = $('#np-play-path');
  const nmp = $('#np-mini-play-path'); // in-box mini row mirror
  if (pp) pp.setAttribute('d', d);
  if (npp) npp.setAttribute('d', d);
  if (nmp) nmp.setAttribute('d', d);
  // The now-playing cover breathes while audio is actually playing.
  const art = $('#np-art');
  if (art) art.classList.toggle('live', playing);
}

/* --- mini player → now playing (one window) --- */
// Tap anywhere on the mini player bar (except the like/play buttons) expands
// it into the full Now Playing view — the cover morphs to its big position.
// Swipe UP on the bar does the same (velocity-free threshold swipe). HOLDING
// the bar (~400ms) instead grows its TOP portion open and reveals the NEXT
// track live (mini-player peek) — releasing after the peek plays that track.
// The buttons keep their own handlers; clicks on them never bubble to open.
let miniSwipeStart = null;
let miniSuppressClick = false; // a swipe/peek that acted eats the click
let npHoldTimer = null;         // mini-player hold → peek
let miniPeeked = false;         // the hold became a peek (release commits)
on('#player', 'click', (e) => {
  if (e.target.closest('button')) return;
  if (miniSuppressClick) { miniSuppressClick = false; return; }
  openNowPlaying();
});
// Swipe-up gesture + hold-to-peek on the mini player: a quick upward drag
// (ignoring button starts) expands the player. Threshold 45px; the pull must
// be mostly vertical (|dx| < 40) so horizontal drags elsewhere aren't
// hijacked. A STILL finger held ~400ms starts the peek (expand top portion +
// preview the next track) — releasing after that commits to the next track.
on('#player', 'pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  if (e.target.closest('button')) return;
  miniSwipeStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
  clearTimeout(npHoldTimer);
  miniPeeked = false;
  npHoldTimer = setTimeout(() => {
    if (!miniSwipeStart || miniSwipeStart.id !== e.pointerId) return;
    if (npPeekStart()) miniPeeked = true; // the top portion grows + audio
  }, 400);
});
on('#player', 'pointermove', (e) => {
  if (!miniSwipeStart || e.pointerId !== miniSwipeStart.id) return;
  const dy = miniSwipeStart.y - e.clientY; // positive = swiping up
  // Any meaningful movement cancels the hold-to-peek (it must be a STILL hold).
  if (Math.abs(e.clientX - miniSwipeStart.x) > 8 || Math.abs(e.clientY - miniSwipeStart.y) > 8) {
    clearTimeout(npHoldTimer);
    if (miniPeeked) { miniPeeked = false; npPeekStop(); }
  }
  if (dy > 45 && Math.abs(e.clientX - miniSwipeStart.x) < 40) {
    miniSwipeStart = null;
    clearTimeout(npHoldTimer);
    if (miniPeeked) { miniPeeked = false; npPeekStop(); }
    miniSuppressClick = true;
    openNowPlaying();
  }
});
on('#player', 'pointerup', (e) => {
  if (!miniSwipeStart || e.pointerId !== miniSwipeStart.id) return;
  miniSwipeStart = null;
  clearTimeout(npHoldTimer);
  if (miniPeeked) {
    // The hold became a live peek — release COMMITS to the next track.
    miniPeeked = false;
    const idx = npPeek ? npPeek.idx : -1;
    npPeekStop();
    miniSuppressClick = true; // eat the click so it doesn't open Now Playing
    if (idx >= 0 && idx < state.queue.length) playTrackAt(idx);
  }
});
on('#player', 'pointercancel', (e) => {
  if (miniSwipeStart && e.pointerId === miniSwipeStart.id) {
    miniSwipeStart = null;
    clearTimeout(npHoldTimer);
    if (miniPeeked) { miniPeeked = false; npPeekStop(); }
  }
});
// The mini player is a gesture surface (tap = open, hold = peek) — a press
// must NEVER open text selection / copy / callout. Belt-and-suspenders on
// top of user-select:none in CSS.
on('#player', 'selectstart', (e) => e.preventDefault());
on('#player', 'contextmenu', (e) => e.preventDefault());
on('#np-queue-btn', 'click', openQueue);

// --- "About this song" — the always-visible info sheet in Now Playing -----
// Explains the playing track (ChatGPT if an OpenAI key is set, else Cyanite
// music-DNA if a key is set, else Wikipedia, else local profile knowledge) —
// never touches YouTube, so it rides no politeness queue and is always
// instant to appear. Answers are cached per track, so repeat views are
// instant too.
let npAiTrackId = null; // track whose answer is shown (stale answers never paint)
let npAiBusy = false;
// The sheet is permanently visible inside Now Playing; these are kept as
// idempotent no-ops so older call sites (close path, track change) still work.
function openNpAi() { askNpAi(); }
function closeNpAi() { npAiBusy = false; }
// The bottom fade above the volume shows only while the description has more
// content below the sheet's edge (scrollable overflow). Re-checked whenever
// the text, the sheet size (expand/collapse) or the scroll position change.
function updateNpAiClip() {
  // The description scrolls in its own area (.np-ai-scroll) under the fixed
  // header row — measure THAT for overflow so the fade shows only while
  // there's actually more text below the volume line.
  const panel = $('.np-ai-scroll') || $('#np-ai');
  if (!panel) return;
  const more = Math.max(0, panel.scrollHeight - panel.scrollTop - panel.clientHeight);
  panel.classList.toggle('clipped', more > 6);
}
async function askNpAi() {
  const panel = $('#np-ai');
  const body = $('#np-ai-body');
  const src = $('#np-ai-src');
  if (!panel || !body || panel.hidden) return;
  const track = state.currentTrack;
  if (!track || !window.Brain || !Brain.explainSong) {
    body.textContent = 'No song playing yet — press play on any track.';
    body.classList.remove('loading');
    if (src) src.textContent = '';
    updateNpAiClip();
    return;
  }
  const id = track.id;
  npAiTrackId = id;
  if (npAiBusy) return;
  npAiBusy = true;
  body.textContent = 'Loading Trivia…';
  body.classList.add('loading');
  if (src) src.textContent = '';
  try {
    const ans = await Brain.explainSong(track);
    if (npAiTrackId !== id || panel.hidden) return; // stale / closed — drop
    // Older cached answers were plain strings; new ones are { text, source }.
    const text = (ans && typeof ans === 'object') ? (ans.text || '') : String(ans || '');
    body.textContent = text;
    body.classList.remove('loading');
    // Every source — Wikipedia, ChatGPT, Cyanite, or local Brain knowledge —
    // is credited the same way: one consistent brand line.
    if (src) src.textContent = 'Powered by OrBeat';
    updateNpAiClip();
  } catch {
    if (npAiTrackId !== id || panel.hidden) return;
    body.textContent = 'Could not fetch song info right now. Check your connection and try again.';
    body.classList.remove('loading');
    updateNpAiClip();
  } finally {
    npAiBusy = false;
    // The track changed mid-ask: the answer above was dropped as stale — ask
    // again so the sheet never sits on old text.
    if (npAiTrackId !== id && !panel.hidden) askNpAi();
  }
}
// Refresh on track change so the sheet never describes the wrong song.
function refreshNpAi() {
  if ($('#np-ai') && !$('#np-ai').hidden) askNpAi();
}
// About-this-song sheet: expand/collapse. The orange chevron (V) sits at the
// bottom-center of the sheet, above the volume line. Tapping it expands the
// sheet so the description gets the full readable height — the cover, title
// and controls are pushed up and shrink to make room. Tapping it again (now
// pointing up) OR tapping the description text collapses back to the normal
// Now Playing layout.
let npExpandRun = 0;
// 30fps expand/collapse: the layout SNAPS to the target (art shrinks, rows
// below shift, sheet grows) and a FLIP pins every moved element back to its
// old position, then animates them home with pure transform transitions
// (see .np.animating). Zero per-frame layout reads or writes — only the
// compositor interpolates, so the push-up stays smooth on weak phones.
function npAiSetExpanded(on) {
  const box = $('#np');
  if (!box) return;
  const art = $('#np-art');
  const moving = ['.np-info', '.np-seek', '.np-tier', '.np-controls']
    .map((sel) => document.querySelector(sel)).filter(Boolean);
  const run = ++npExpandRun;
  // 1. Measure BEFORE the layout snaps.
  const before = art ? art.getBoundingClientRect() : null;
  const beforeTops = moving.map((el) => el.getBoundingClientRect().top);
  box.classList.toggle('np-expanded', !!on);
  // 2. After: the layout already moved — compute each element's delta.
  const after = art ? art.getBoundingClientRect() : null;
  if (art && before && after && before.width > 0 && after.width > 0) {
    const s = before.width / after.width;              // size change (expand: >1)
    const all = [art, ...moving];
    box.classList.add('animating');
    all.forEach((el) => { el.style.transition = 'none'; });
    // 3. Invert: pin each element where the user saw it. The art is scaled
    //    about its center — nudge it by half the height delta so the center
    //    stays put, not the top edge.
    const artDy = (before.top - after.top) + (before.height - after.height) / 2;
    art.style.transform = `translateY(${artDy}px) scale(${s})`;
    moving.forEach((el, i) => {
      const dy = beforeTops[i] - el.getBoundingClientRect().top;
      el.style.transform = `translateY(${dy}px)`;
    });
    void art.offsetWidth; // 4. Commit the snap-back instantly (one reflow)
    all.forEach((el) => { el.style.transition = ''; });
    // 5. Play: animate to the final layout position — pure transform tween.
    art.style.transform = 'scale(1)';
    moving.forEach((el) => { el.style.transform = ''; });
    // Clean up inline styles after the tween (token-guarded so a rapid
    // re-toggle can never wipe a newer run).
    setTimeout(() => {
      if (run !== npExpandRun) return;
      box.classList.remove('animating');
      all.forEach((el) => { el.style.transform = ''; el.style.transition = ''; });
    }, 430);
  }
  // The sheet's height changed — re-check whether the fade is still needed.
  requestAnimationFrame(updateNpAiClip);
}
// Re-check the fade as the description scrolls (passive — no layout thrash;
// scrollTop/clientHeight reads are cheap and only run on actual scrolls).
{
  const panel = $('#np-ai');
  if (panel) panel.addEventListener('scroll', updateNpAiClip, { passive: true });
}
on('#np-ai-more', 'click', (e) => {
  e.stopPropagation();
  const box = $('#np');
  if (box) npAiSetExpanded(!box.classList.contains('np-expanded'));
});
// Tapping the description ALSO expands (same as the orange V arrow); tapping
// it again collapses back to the normal Now Playing layout.
on('#np-ai-body', 'click', () => {
  const box = $('#np');
  npAiSetExpanded(!(box && box.classList.contains('np-expanded')));
});
on('#np-ai-src', 'click', () => {
  const box = $('#np');
  npAiSetExpanded(!(box && box.classList.contains('np-expanded')));
});
on('#np-close', 'click', closeNowPlaying);
on('#np-close-x', 'click', closeNowPlaying);
// Tap the TRANSPARENT backdrop outside the box (including the nav-tab strip
// visible below it) to eat-close Now Playing back into the mini player bar.
// Clicks inside the box itself never close — the box is the window, only the
// empty space around it acts as the dismiss target.
on('#np-backdrop', 'click', (e) => {
  if (e.target.closest('.np')) return; // taps inside the box don't close
  closeNowPlaying();
});
// Tap the box SURFACE (anything that isn't a control, the art swipe zone, or
// the Up Next list) to eat-close Now Playing back into the mini player bar.
// Drags are left to their own gestures (pull-to-close, queue scroll, art
// swipes) and never close.
let npSurfaceTap = null; // { x, y, id, moved }
const npSurfaceEl = $('#np');
if (npSurfaceEl) {
  npSurfaceEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // #toast too: the dropdown strip lives inside the box — a tap on it must
    // never read as a tap on the surface and close Now Playing.
    if (e.target.closest('button, input, #np-art, #np-ai, #toast')) return;
    npSurfaceTap = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  });
  npSurfaceEl.addEventListener('pointermove', (e) => {
    if (!npSurfaceTap || e.pointerId !== npSurfaceTap.id) return;
    if (Math.abs(e.clientX - npSurfaceTap.x) > 8 || Math.abs(e.clientY - npSurfaceTap.y) > 8) {
      npSurfaceTap.moved = true;
    }
  });
  const npSurfaceEnd = (e) => {
    if (!npSurfaceTap || e.pointerId !== npSurfaceTap.id) return;
    const tap = npSurfaceTap;
    npSurfaceTap = null;
    if (tap.moved) return; // drag — its own gesture owns it
    closeNowPlaying();
  };
  npSurfaceEl.addEventListener('pointerup', npSurfaceEnd);
  npSurfaceEl.addEventListener('pointercancel', npSurfaceEnd);
}

// --- Mini-player peek: LIVE mini-preview of the next track --------------
// HOLDING the mini player grows its top portion open (.player.peek-open) and
// reveals the NEXT track live (card + low-volume audio). Releasing after the
// peek commits to that track; a quick tap still opens Now Playing.
let npPeek = null; // { idx, audio }

// The queue index nextTrack() would play right now — mirrors nextTrack's
// decision tree (repeat-one, smart shuffle, repeat-all wrap, linear next).
// -1 means there is no playable next (queue end, no repeat) — no peek.
function npPeekNextIndex() {
  if (state.index < 0 || !state.queue.length) return -1;
  if (state.repeat === 'one') return state.index;
  if (state.shuffle && state.queue.length > 1) return smartShufflePick();
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd && state.repeat === 'all') return 0;
  if (atEnd) return -1;
  return state.index + 1;
}

// Preload the NEXT track's HD cover while the current one plays, so a swipe /
// next at release time has ZERO decode work — the browser already fetched,
// decoded and cached it, and the same URL is used by updateNowPlaying, so
// the swap reads straight from cache. Mirrors the next-track decision tree
// (repeat-one, smart shuffle, repeat-all wrap, linear next) via npPeekNextIndex.
// Best-effort: if the actual next differs (e.g. shuffle re-picks), the on-
// demand decode still works, it just misses the preload.
const preloadedCovers = new Set();
function preloadNextCover() {
  const idx = npPeekNextIndex();
  if (idx < 0 || !state.queue.length || !state.currentTrack) return;
  const track = state.queue[idx];
  if (!track || track.id === state.currentTrack.id) return;
  const key = track.id;
  if (preloadedCovers.has(key)) return; // already preloaded once this session
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  // EXACTLY the same URL updateNowPlaying uses for the big cover, so the
  // preload and the display hit the same browser cache entry.
  const origCover = track.cover || '';
  const imgSrc = (origCover ? upscaleArtHD(origCover) : '') || (vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '');
  if (!imgSrc) return;
  preloadedCovers.add(key);
  // Keep the set bounded — a long session shouldn't grow it forever. The
  // browser cache still holds the decoded images; the set only dedupes calls.
  if (preloadedCovers.size > 40) preloadedCovers.clear();
  const img = new Image();
  img.src = imgSrc;
  // A failed preload (e.g. maxresdefault 404s) shouldn't block a retry later.
  img.onerror = () => preloadedCovers.delete(key);
}

// Show the peek card (in the mini player's grown top portion) + start the
// low-volume audio preview. Returns true if a peek actually started (there
// was a next track to show).
function npPeekStart() {
  const idx = npPeekNextIndex();
  if (idx < 0) return false;
  const track = state.queue[idx];
  if (!track) return false;
  npPeek = { idx, audio: null };
  const pl = $('#player');
  // A toast and the peek share the panel's grown top area — drop any toast
  // first so the peek owns the space.
  const toastEl = $('#toast');
  if (toastEl && !toastEl.hidden) hideToast();
  if (pl) pl.classList.add('peek-open'); // the mini player's top portion grows
  const card = $('#mini-peek');
  if (card) { card.hidden = false; card.classList.remove('hide'); card.classList.add('show'); }
  // Cover (with the OrBeat logo fallback, like every other art slot).
  const cover = $('#mini-peek-cover');
  const vid = track.videoId || (track.id && track.id.startsWith('yt:') ? track.id.slice(3) : '');
  const src = track.cover || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
  if (cover) {
    cover.innerHTML = '';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.onerror = function() { this.outerHTML = '<div class="noimg logo-fallback">' + LOGO_FB + '</div>'; };
      cover.appendChild(img);
    } else {
      const noimg = document.createElement('div');
      noimg.className = 'noimg logo-fallback';
      noimg.innerHTML = LOGO_FB;
      cover.appendChild(noimg);
    }
  }
  const t = $('#mini-peek-title'); if (t) t.textContent = track.name || '—';
  const a = $('#mini-peek-artist'); if (a) a.textContent = track.artist || '';
  // Live audio preview at low volume — the same stream URL the player would
  // use, on a throwaway element so the real playback machinery is untouched.
  if (track.videoId && window.MusicEngine) {
    MusicEngine.streamUrl(track.videoId)
      .then((s) => {
        if (!npPeek || npPeek.idx !== idx || !s || !s.url) return;
        const el = new Audio();
        el.volume = 0.3;
        el.src = s.url;
        el.play().catch(() => { /* preview is best-effort */ });
        npPeek.audio = el;
      })
      .catch(() => { /* no stream — visual peek only */ });
  }
  return true;
}

let npPeekHideTimer = null;
// Tear down the peek (card + audio + player growth) — safe to call anytime,
// even mid-resolve.
function npPeekStop() {
  clearTimeout(npHoldTimer);
  clearTimeout(npPeekHideTimer);
  if (npPeek && npPeek.audio) {
    try { npPeek.audio.pause(); npPeek.audio.src = ''; } catch { /* ignore */ }
  }
  npPeek = null;
  const pl = $('#player');
  if (pl) pl.classList.remove('peek-open'); // the panel retracts (0.45s)
  const card = $('#mini-peek');
  if (card) {
    if (card.classList.contains('show')) {
      // Push-down dismiss: the up-next card slides DOWN into the mini-row
      // area while the panel retracts, so the current song below takes its
      // place (no instant vanish). Kept in the DOM so the retracting top
      // edge eats it (overflow clips), then cleaned up.
      card.classList.remove('show');
      card.classList.add('hide');
      npPeekHideTimer = setTimeout(() => {
        card.classList.remove('hide');
        card.hidden = true;
      }, 330);
    } else {
      card.classList.remove('hide');
      card.hidden = true;
    }
  }
}
on('#np-play', 'click', togglePlay);
// Now Playing heart: like/unlike the current track (matches the menu action).
on('#np-like', 'click', () => {
  if (!state.currentTrack) return;
  toggleLike(state.currentTrack);
  updateNpLike();
});
on('#mini-like', 'click', () => {
  if (!state.currentTrack) return;
  toggleLike(state.currentTrack);
  updateMiniLike();
});
on('#np-next', 'click', nextTrack);
on('#np-prev', 'click', prevTrack);

// Scrubbing guard: while the finger is on the seek bar, the timeupdate
// handler leaves the input value alone so the thumb follows the drag.
let npSeekScrubbing = false;
on('#np-seek', 'pointerdown', () => { npSeekScrubbing = true; });
on('#np-seek', 'pointerup', () => { npSeekScrubbing = false; });
on('#np-seek', 'pointercancel', () => { npSeekScrubbing = false; });
on('#np-seek', 'input', () => {
  $('#seek').value = $('#np-seek').value;
  // Live-preview the fill + elapsed time from the drag position.
  const el = curEl();
  if (el && el.duration) {
    const frac = Number($('#np-seek').value) / 1000;
    const nsf = $('#np-seek-fill');
    if (nsf) nsf.style.transform = `translateY(-50%) scaleX(${Math.min(1, Math.max(0, frac)).toFixed(4)})`;
    $('#np-t-cur').textContent = fmtDur(frac * el.duration);
  }
});
on('#np-seek', 'change', () => {
  npSeekScrubbing = false;
  const d = EmbedPlay.isActive() ? EmbedPlay.duration() : curEl().duration;
  if (d) seekPlayerTo((Number($('#np-seek').value) / 1000) * d);
});

/* --- Now Playing: touch-driven cover slide (drag-linked, velocity fling) --- */
// The cover (and title/artist) follows the finger horizontally as you drag;
// releasing decides by TOUCH SPEED — a fast flick commits the slide (even
// over a short distance), a slow release past ~35% of the cover commits too,
// anything else springs back. The whole motion is pure translation: no fade.
let npDrag = null;      // active drag { startX, startY, lastX, lastT, dx, v, axis, id }
let npDragFrom = 0;     // drag offset handed to playTrackAt for the slide start
let npPendingSlide = null; // { dir, from } — continuous-slide state for updateNowPlaying

// Mirror the drag offset onto the cover and the title/artist row so the
// motion feels physical.
function npSetDragTransform(dx) {
  const art = $('#np-art');
  const info = $('.np-info-row');
  // Drop the entrance/breathe classes so nothing can fight the finger, and
  // they won't replay when a cancelled drag springs back.
  if (art) {
    art.classList.add('np-dragging');
    art.classList.remove('np-art-in', 'live');
    art.style.transform = `translateX(${dx}px)`;
  }
  if (info) {
    info.classList.add('np-dragging');
    info.classList.remove('np-slide-left', 'np-slide-right');
    info.style.transform = `translateX(${dx}px)`;
  }
}

// A swipe that didn't commit springs everything back to rest.
function npSpringBack() {
  const restore = (el, ms) => {
    if (!el) return;
    el.classList.remove('np-dragging');
    el.style.transition = `transform ${ms}s cubic-bezier(0.22, 1.2, 0.36, 1)`;
    el.style.transform = 'translateX(0)';
    setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, ms * 1000 + 60);
  };
  restore($('#np-art'), 0.45);
  restore($('.np-info-row'), 0.45);
}

// Continuous cover transition for a track change inside Now Playing: the OLD
// cover is ghosted INSIDE the art frame (clipped by its overflow:hidden) and
// keeps sliding out from where the touch left it, while updateNowPlaying
// brings the new cover in from the opposite side — one continuous motion,
// pure translation, no fade. `dir` -1 = next, +1 = prev.
function playNpSlideTransition(dir, from = 0) {
  const art = $('#np-art');
  if (!art) return;
  const W = art.offsetWidth || 320;
  // MARQUEE: the old cover and the new cover travel at the SAME pixel speed,
  // like one continuous ribbon. The new cover always crosses the full width
  // (360ms); the ghost's remaining distance is (W - |from|), so its duration
  // is proportional — a far drag finishes fast, a near drag takes the full
  // time, and both reach their ends together. Direction is whatever the
  // swipe chose: left → next slides in from the right, right → prev from the
  // left, always the full width ("absolute distance").
  const ghostMs = Math.max(140, Math.round(360 * (W - Math.abs(from)) / W));
  const ghost = document.createElement('div');
  ghost.className = 'np-art-ghost';
  ghost.innerHTML = art.innerHTML; // the OLD cover markup
  ghost.style.transform = `translateX(${from}px)`;
  art.appendChild(ghost);
  requestAnimationFrame(() => {
    // The old content slides out AND fades out fast (same fast fade as the
    // collapse) — the swap underneath is masked, so the swipe never stutters.
    ghost.style.transition = `transform ${ghostMs}ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.16s ease`;
    ghost.style.transform = `translateX(${dir * W}px)`;
    ghost.style.opacity = '0';
  });
  setTimeout(() => ghost.remove(), ghostMs + 80);
  // Ghost the OLD title/artist row too: the info clip keeps a copy of the
  // current track's title sliding out (from where the finger left it) while
  // updateNowPlaying slides the next track's title in from the opposite side
  // — the title change is one continuous motion, never a hard cut.
  const clip = $('#np').querySelector('.np-info');
  const row = clip && clip.querySelector('.np-info-row');
  if (clip && row) {
    clip.querySelectorAll('.np-info-ghost').forEach((g) => g.remove());
    const iGhost = document.createElement('div');
    iGhost.className = 'np-info-ghost';
    const clone = row.cloneNode(true);
    // No duplicate ids (like heart, title) while the ghost is in the DOM.
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    iGhost.appendChild(clone);
    iGhost.style.transform = `translateX(${from}px)`;
    clip.appendChild(iGhost);
    requestAnimationFrame(() => {
      iGhost.style.transition = `transform ${ghostMs}ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.16s ease`;
      iGhost.style.transform = `translateX(${dir * W}px)`;
      iGhost.style.opacity = '0';
    });
    setTimeout(() => iGhost.remove(), ghostMs + 80);
  }
  npPendingSlide = { dir, from, ghostMs };
}

// Swipe-to-change triggers ONLY on the cover photo — a horizontal drag that
// starts anywhere else in Now Playing (info row, seek, controls, Up Next,
// volume…) is left to its own gesture (scroll, buttons). The listeners live
// on the art frame; touch pointer-capture keeps them following the finger
// even after it leaves the cover.
const npArtEl = $('#np-art');
if (npArtEl) {
  npArtEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('button, input')) return; // nothing inside, but stay safe
    npDrag = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastT: performance.now(), dx: 0, v: 0, axis: 0, id: e.pointerId };
  });
  npArtEl.addEventListener('pointermove', (e) => {
    if (!npDrag || e.pointerId !== npDrag.id) return;
    const dx = e.clientX - npDrag.startX;
    const dy = e.clientY - npDrag.startY;
    // Lock the gesture to an axis once intent is clear; vertical drags are
    // left to the page's native scroll.
    if (!npDrag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      npDrag.axis = Math.abs(dx) >= Math.abs(dy) ? 1 : -1;
      if (npDrag.axis < 0) { npDrag = null; return; }
    }
    const now = performance.now();
    const dt = Math.max(1, now - npDrag.lastT);
    const inst = (e.clientX - npDrag.lastX) / dt;
    npDrag.v = npDrag.v * 0.65 + inst * 0.35; // smoothed velocity, px/ms
    npDrag.lastX = e.clientX;
    npDrag.lastT = now;
    npDrag.dx = dx;
    npSetDragTransform(dx);
  });
  const npDragEnd = (e) => {
    if (!npDrag || (e.pointerId !== undefined && e.pointerId !== npDrag.id)) return;
    const { dx, v } = npDrag;
    const dragDx = dx;
    npDrag = null;
    const art = $('#np-art');
    const W = art ? art.offsetWidth : 320;
    const vel = Math.abs(v);
    // Commit by touch SPEED first; a slow drag needs real distance.
    const commit = vel > 0.35 || (Math.abs(dx) > W * 0.35 && vel > 0.12);
    if (commit) {
      const dir = (vel > 0.35) ? (v < 0 ? -1 : 1) : (dx < 0 ? -1 : 1);
      npDragFrom = dragDx;
      if (dir < 0) nextTrack(); else prevTrack();
    } else {
      npSpringBack();
    }
  };
  npArtEl.addEventListener('pointerup', npDragEnd);
  npArtEl.addEventListener('pointercancel', npDragEnd);
}

on('#np-volume', 'input', () => {
  state.userVol = Number($('#np-volume').value) / 100;
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  if (EmbedPlay.isActive()) EmbedPlay.setVolume(state.userVol);
  $('#volume').value = $('#np-volume').value;
});

/* ------------------------------ track context menu (long-press) ------------------------------ */
// Spotify-style: long-press a track card, album row, search row, or queue row
// to get Like / Add to playlist / Download / More like this / Sleep timer.
// The old 5-button row on Now Playing is gone — all of it lives here now.

const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3 10.6 10.6 16.9 4.3z"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12.3 2.1a9.6 9.6 0 1 0 9.6 9.6c-4.6 1-8.5-2.9-7.5-7.5a9.7 9.7 0 0 0-2.1-2.1z"/></svg>';
const ICON_QUEUE = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 6h13v2H3zm0 5h13v2H3zm0 5h9v2H3zm15.5 0L22 19l-3.5 3v-2.5H16v-1h2.5z"/></svg>';

// "Add to queue" (Spotify-style): appends the track to the session queue and
// confirms inline inside Now Playing, or with a toast everywhere else.
function addToQueue(track) {
  if (!track) return;
  state.queue.push(track);
  renderQueue();    // refresh the queue panel if it's open
  if (npIsOpen()) npFlash('Added to queue', ICON_QUEUE);
  else toast(`“${track.name}” added to queue`);
}

let ctxTrack = null;
let ctxRow = null;
let ctxSuppressClickUntil = 0;
let longPressTimer = null;
let longPressRow = null;
let longPressStart = { x: 0, y: 0 };

function trackFromRow(row) {
  // Cards carry a direct reference to their track (Home rows, search grids,
  // rec shelf…) — nothing to look up.
  if (row && row._track) return row._track;
  const id = row && row.dataset.id;
  if (!id) return null;
  for (const list of [state.queue, searchResultsTracks, albumTracksList, plvTracksList, recentTracksList]) {
    if (!Array.isArray(list)) continue;
    const t = list.find((x) => x && x.id === id);
    if (t) return t;
  }
  return null;
}

function ctxAddItem(list, label, icon, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctx-item';
  b.innerHTML = `${icon}<span>${esc(label)}</span>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  list.appendChild(b);
}

function ctxOpen(track, fromRow) {
  ctxTrack = track;
  ctxRow = fromRow || null;
  ctxSuppressClickUntil = Date.now() + 450; // swallow the click the long-press releases
  const title = $('#ctx-title');
  title.innerHTML = `<span class="ctx-t">${esc(track.name)}</span><span class="ctx-a">${esc(track.artist || '')}</span>`;
  const list = $('#ctx-list');
  list.innerHTML = '';
  const liked = isLiked(track.id);
  ctxAddItem(list, liked ? 'Remove from Liked Songs' : 'Like', liked ? ICON_HEART_FILL : ICON_HEART, () => {
    toggleLike(track);
    ctxClose();
  });
  ctxAddItem(list, 'Add to playlist', ICON_PLUS, () => {
    ctxClose();
    // Anchor to the long-pressed row — never the (now hiding) panel, whose
    // bottom edge sits at the viewport bottom and would push the picker
    // off-screen.
    openPlaylistPicker(track, ctxRow || $('#ctx-panel'));
  });
  ctxAddItem(list, 'More like this', ICON_MORE, () => {
    ctxClose();
    moreLikeThis(track);
  });
  ctxAddItem(list, 'Add to queue', ICON_QUEUE, () => {
    ctxClose();
    addToQueue(track);
  });
  const vid = vidOf(track);
  const downloaded = vid && window.OfflineCache && OfflineCache.hasSync(vid);
  ctxAddItem(list, downloaded ? 'Remove download' : 'Download', ICON_DL, () => {
    ctxClose();
    dlTrack(track, null);
  });
  if (ctxRow && ctxRow.closest('.recent-list')) {
    ctxAddItem(list, 'Remove from Recently Played', ICON_X, () => {
      savePlays(getPlays().filter((p) => p.id !== track.id));
      renderRecently();
      ctxClose();
      toast('Removed from Recently Played');
    });
  }
  ctxAddItem(list, 'Sleep timer', ICON_MOON, () => {
    ctxClose();
    toggleSleepPanel();
  });
  const bd = $('#ctx-backdrop');
  const panel = $('#ctx-panel');
  bd.classList.remove('closing');
  panel.classList.remove('closing');
  bd.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => { bd.classList.add('open'); panel.classList.add('open'); });
}

// Context menu for album/playlist cards (long-press on the Albums shelf or
// the Search playlists). Actions that apply to a whole album, not a track.
function ctxOpenAlbum(album, fromRow) {
  ctxRow = fromRow || null;
  ctxSuppressClickUntil = Date.now() + 450;
  const title = $('#ctx-title');
  title.innerHTML = `<span class="ctx-t">${esc(album.name)}</span><span class="ctx-a">${esc(album.artist || 'Album')}</span>`;
  const list = $('#ctx-list');
  list.innerHTML = '';
  ctxAddItem(list, 'Play', ICON_PLAY, () => {
    ctxClose();
    openAlbumView(album);
    // Auto-play the first track once the album's tracks finish loading.
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (albumTracksList && albumTracksList.length) {
        clearInterval(poll);
        playTrackAt(0, albumTracksList);
        updatePlayingCards();
      } else if (Date.now() - t0 > 10000) {
        clearInterval(poll);
      }
    }, 250);
  });
  ctxAddItem(list, 'Add to playlist', ICON_PLUS, () => {
    ctxClose();
    openPlaylistPicker({ __album: album }, ctxRow || $('#ctx-panel'));
  });
  ctxAddItem(list, 'More like this', ICON_MORE, () => {
    ctxClose();
    moreLikeThis({ name: album.name, artist: album.artist });
  });
  ctxAddItem(list, 'Sleep timer', ICON_MOON, () => { ctxClose(); toggleSleepPanel(); });
  const bd = $('#ctx-backdrop');
  const panel = $('#ctx-panel');
  bd.classList.remove('closing');
  panel.classList.remove('closing');
  bd.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => { bd.classList.add('open'); panel.classList.add('open'); });
}

function ctxClose() {
  // Drop the suppression state too — otherwise a backdrop tap followed by a
  // quick tap on the same row inside the window would eat a legit play tap.
  ctxSuppressClickUntil = 0;
  ctxRow = null;
  // The backdrop has no fade — it stays solid until the sheet's 0.32s
  // slide-down finishes, then hides with it.
  closeWithAnim($('#ctx-backdrop'), 360);
  closeWithAnim($('#ctx-panel'), 360);
}

on('#ctx-backdrop', 'click', ctxClose);

// The click a long-press releases on pointerup must not also play the track.
document.addEventListener('click', (e) => {
  if (Date.now() < ctxSuppressClickUntil && ctxRow && ctxRow.contains(e.target)) {
    ctxSuppressClickUntil = 0;
    ctxRow = null;
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (longPressRow) {
    longPressRow.classList.remove('lpress'); // release the press feedback
    longPressRow = null;
  }
}

const LONG_PRESS_MS = 480;
const CTX_ROW_SEL = '.card, .search-item, .album-track, .rec-card, .album-card, .queue-item:not(.playing)';

// A long-press on a card/row fires the context menu. The row gets a quick
// "pulse" (scale up + brighten, see .lpress-fire) so the press visibly
// confirms before the menu slides up — Spotify-style feedback.
function fireLongPress(row) {
  row.classList.remove('lpress');
  row.classList.add('lpress-fire');
  setTimeout(() => row.classList.remove('lpress-fire'), 400);
  // Album/playlist cards get the album menu; every other row the track menu.
  const album = row._album;
  if (album) {
    if (navigator.vibrate) navigator.vibrate(12);
    ctxOpenAlbum(album, row);
    return;
  }
  const track = trackFromRow(row);
  if (track) {
    if (navigator.vibrate) navigator.vibrate(12);
    ctxOpen(track, row);
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const row = e.target.closest(CTX_ROW_SEL);
  if (!row || e.target.closest('[data-grip]')) return; // grip drags never open the menu
  row.classList.add('lpress'); // immediate press feedback: scale down + dim
  longPressRow = row;
  longPressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => fireLongPress(row), LONG_PRESS_MS);
});

document.addEventListener('pointermove', (e) => {
  if (!longPressRow) return;
  if (Math.abs(e.clientX - longPressStart.x) > 12 || Math.abs(e.clientY - longPressStart.y) > 12) cancelLongPress();
});

document.addEventListener('pointerup', cancelLongPress);
document.addEventListener('pointercancel', cancelLongPress);

// Desktop parity: right-click opens the same menu (with the pulse animation).
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest(CTX_ROW_SEL);
  if (!row) return;
  e.preventDefault();
  row.classList.add('lpress-fire');
  setTimeout(() => row.classList.remove('lpress-fire'), 400);
  if (row._album) { ctxOpenAlbum(row._album, row); return; }
  const track = trackFromRow(row);
  if (track) ctxOpen(track, row);
});

/* ------------------------------ shuffle / repeat ------------------------------ */

function updateShuffleUI() {
  // Only the Now Playing shuffle button exists in the UI (#np-shuffle).
  const b = $('#np-shuffle');
  if (b) b.classList.toggle('active', state.shuffle);
  try { localStorage.setItem('natsirt_shuffle', JSON.stringify(state.shuffle)); } catch {}
}

function updateRepeatUI() {
  // Only the Now Playing repeat button exists in the UI (#np-repeat).
  const b = $('#np-repeat');
  if (b) {
    b.classList.toggle('active', state.repeat !== 'off');
    // Show a '1' badge for repeat-one (anchored by .mode-btn's position).
    const existing = b.querySelector('.repeat-one-badge');
    if (existing) existing.remove();
    if (state.repeat === 'one') {
      const badge = document.createElement('span');
      badge.className = 'repeat-one-badge';
      badge.textContent = '1';
      b.appendChild(badge);
    }
  }
  try { localStorage.setItem('natsirt_repeat', JSON.stringify(state.repeat)); } catch {}
}

/* --- smart shuffle --- */
// Smart shuffle plays a STABLE order for the session (Spotify-style): the
// order is built once when shuffle turns on (or the queue/current track
// changes), then followed track-by-track, wrapping at the end. Building
// de-correlates same-artist runs so back-to-back artists are rare when the
// queue offers variety. Because the order is stable, the Up Next list can
// show the REAL next tracks (npUpcoming follows the same order).
let shuffleHistory = []; // track ids played recently (used when rebuilding)
let shuffleOrder = null; // queue indices in play order while shuffling

// Fisher-Yates + same-artist de-correlation (a few greedy passes of swapping
// an adjacent same-artist pair with a later different-artist track).
function buildShuffleOrder() {
  const n = state.queue.length;
  const idxs = [];
  for (let i = 0; i < n; i++) idxs.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n - 1; i++) {
      const a = state.queue[idxs[i]];
      const b = state.queue[idxs[i + 1]];
      if (a && b && a.artist && a.artist === b.artist) {
        for (let k = i + 2; k < n; k++) {
          const c = state.queue[idxs[k]];
          if (c && (!c.artist || c.artist !== a.artist)) {
            [idxs[i + 1], idxs[k]] = [idxs[k], idxs[i + 1]];
            break;
          }
        }
      }
    }
  }
  return idxs;
}

// Rebuild the order whenever it's missing or stale (queue size changed, or
// the current track isn't in it — e.g. a new list was loaded).
function ensureShuffleOrder() {
  if (!state.shuffle) return;
  const n = state.queue.length;
  if (!shuffleOrder || shuffleOrder.length !== n || !shuffleOrder.includes(state.index)) {
    shuffleOrder = buildShuffleOrder();
    shuffleHistory = []; // fresh session history for the new order
  }
}

// The queue index that plays next while shuffling — the entry AFTER the
// current one in the stable order (wraps at the end).
function smartShufflePick() {
  const n = state.queue.length;
  if (n <= 1) return state.index;
  ensureShuffleOrder();
  const pos = shuffleOrder.indexOf(state.index);
  if (pos < 0) {
    shuffleOrder = buildShuffleOrder();
    shuffleHistory = [];
    return shuffleOrder[0];
  }
  return shuffleOrder[(pos + 1) % n];
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  shuffleOrder = null; // shuffle off discards the order; on = fresh rebuild
  if (state.shuffle) shuffleHistory = [];
  updateShuffleUI();
  toast(state.shuffle ? 'Smart shuffle on' : 'Shuffle off');
}

on('#np-shuffle', 'click', toggleShuffle);
on('#np-repeat', 'click', cycleRepeat);

function cycleRepeat() {
  const modes = ['off', 'all', 'one'];
  const i = modes.indexOf(state.repeat);
  state.repeat = modes[(i + 1) % modes.length];
  updateRepeatUI();
  const labels = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' };
  toast(labels[state.repeat]);
}

// Restore persisted shuffle/repeat
try {
  const s = JSON.parse(localStorage.getItem('natsirt_shuffle') || 'false');
  if (typeof s === 'boolean') state.shuffle = s;
  const r = JSON.parse(localStorage.getItem('natsirt_repeat') || '"off"');
  if (['off', 'all', 'one'].includes(r)) state.repeat = r;
} catch {}
updateShuffleUI();
updateRepeatUI();

/* ------------------------------ sleep timer ------------------------------ */

let sleepIntervalId = null;

function toggleSleepPanel() {
  const panel = $('#sleep-panel');
  if (panel.hidden) {
    panel.hidden = false;
    updateSleepCountdown();
  } else {
    // Slide down smoothly (no fade) instead of vanishing instantly.
    closeWithAnim(panel, 360);
  }
}

function updateSleepCountdown() {
  const el = $('#sleep-countdown');
  if (!el) return;
  if (state.sleepTimer) {
    el.hidden = false;
    const mins = Math.ceil(state.sleepTimer.remaining / 60);
    el.textContent = `Fading out in ${mins} min`;
  } else {
    el.hidden = true;
  }
}

$$('#sleep-panel .sleep-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const mins = Number(btn.dataset.minutes);
    clearSleepTimer();
    if (mins === -1) {
      toast('Sleep timer off');
    } else {
      state.sleepTimer = { remaining: mins * 60 };
      sleepIntervalId = setInterval(() => {
        state.sleepTimer.remaining--;
        updateSleepCountdown();
        if (state.sleepTimer.remaining <= 0) {
          clearSleepTimer();
          fadeOutAndPause();
        }
      }, 1000);
      toast(`Sleep in ${mins} min`);
    }
    updateSleepCountdown();
    $('#sleep-panel').hidden = true;
  });
});

function clearSleepTimer() {
  if (sleepIntervalId) { clearInterval(sleepIntervalId); sleepIntervalId = null; }
  state.sleepTimer = null;
  updateSleepCountdown();
}

function fadeOutAndPause() {
  const el = curEl();
  const startVol = el.volume;
  const steps = 20;
  let step = 0;
  const fade = setInterval(() => {
    step++;
    el.volume = Math.max(0, startVol * (1 - step / steps));
    if (step >= steps) {
      clearInterval(fade);
      el.pause();
      updatePlayIcon(false);
      el.volume = state.userVol;
      toast('Sleep timer — paused');
    }
  }, 150);
}

// Close sleep panel when tapping outside
document.addEventListener('click', (e) => {
  const panel = $('#sleep-panel');
  if (!panel || panel.hidden) return;
  if (!panel.contains(e.target)) {
    panel.hidden = true;
  }
});

/* ------------------------------ queue view ------------------------------ */


on('#queue-close', 'click', closeQueue);

function openQueue() {
  morphOpenOverlay($('#queue-backdrop')); // grows out of the mini bar, same as Now Playing
  // Fullscreen backdrop painted from the current track's art, same as the
  // Now Playing screen (blob-sampled so cross-origin art never taints).
  const track = state.currentTrack;
  if (track && track.cover) artToGradient(track.cover, $('#queue-glow'));
  renderQueue();
}
function closeQueue() {
  morphCloseOverlay($('#queue-backdrop'));
}
function closeQueueInstant() {
  closeOverlay($('#queue-backdrop'), true);
}

function renderQueue() {
  const nowEl = $('#queue-now');
  const upEl = $('#queue-up');
  const emptyEl = $('#queue-empty');
  const upLabel = $('#queue-up-label');
  const countEl = $('#queue-count');
  lastQueueRenderedId = state.playingId;
  nowEl.innerHTML = '';
  upEl.innerHTML = '';

  if (!state.queue.length) {
    emptyEl.hidden = false;
    upLabel.hidden = true;
    countEl.textContent = '';
    return;
  }
  emptyEl.hidden = true;
  countEl.textContent = state.queue.length === 1 ? '1 song' : `${state.queue.length} songs`;

  // Now playing (delay 0 — no entrance stagger for the active row)
  if (state.currentTrack) {
    const item = createQueueItem(state.currentTrack, state.index, true, 0);
    nowEl.appendChild(item);
  }

  // Up next — staggered entrance, like the Home rows. Tracks the AI topped
  // the queue up with are grouped under a "Recommendations" label; when the
  // whole list is AI-picked, that label replaces the plain "Next Up".
  const upcoming = state.queue.slice(state.index + 1);
  if (upcoming.length) {
    const recCount = upcoming.filter((t) => t.__rec).length;
    upLabel.hidden = recCount === upcoming.length;
    let recLabelAdded = false;
    upcoming.forEach((t, i) => {
      if (t.__rec && !recLabelAdded) {
        recLabelAdded = true;
        const lab = document.createElement('div');
        lab.className = 'queue-rec-label';
        lab.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2.5c.7 4.6 3.4 7.3 8 8-4.6.7-7.3 3.4-8 8-.7-4.6-3.4-7.3-8-8 4.6-.7 7.3-3.4 8-8z"/></svg>Recommendations';
        upEl.appendChild(lab);
      }
      const item = createQueueItem(t, state.index + 1 + i, false, Math.min(i, 12) * 35);
      upEl.appendChild(item);
    });
  } else {
    upLabel.hidden = true;
  }
}

// The synthesized click the browser fires right after pointerup (renderQueue()
// inside onUp rebuilds the list synchronously, so it can land on a fresh row)
// must not also trigger playTrackAt. The suppression is one-shot and
// self-clearing: the first click after a drag is swallowed, any later click
// passes — so a fast user who drags and immediately taps another row is not
// silently robbed of that tap.
let queueDragSuppressUntil = 0;
// True while a reorder drag is in flight — a live re-render (e.g. the AI
// topping the queue up) must not rebuild the list mid-drag and drop the row.
let queueDragActive = false;

// Last playing-id the open Queue page was rendered for — avoids full list
// re-renders on play/pause/like toggles that don't change the track.
let lastQueueRenderedId = null;

function createQueueItem(track, idx, playing, delay = 0) {
  const el = document.createElement('div');
  el.className = 'queue-item' + (playing ? ' playing' : '');
  el.dataset.id = track.id;
  el.dataset.idx = idx;
  if (delay) el.style.animationDelay = `${delay}ms`;
  el.innerHTML = `
    <div class="queue-item-cover">
      ${track.cover
        ? `<img src="${esc(track.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'" />`
        : `<div class="noimg logo-fallback">${LOGO_FB}</div>`}
      <div class="eq" aria-hidden="true"${playing ? '' : ' hidden'}><span></span><span></span><span></span></div>
    </div>
    <div class="queue-item-info">
      <div class="queue-item-title">${esc(track.name)}</div>
      <div class="queue-item-artist">${esc(track.artist)}</div>
    </div>
    ${track.duration ? `<span class="queue-item-dur">${fmtDur(track.duration)}</span>` : ''}`;
  el.addEventListener('click', (e) => {
    if (Date.now() < queueDragSuppressUntil) { queueDragSuppressUntil = 0; return; }
    playTrackAt(idx); // playTrackAt → updatePlayingCards re-renders the queue
  });
  return el;
}

// Drag-to-reorder the whole queue (Now Playing row + Next Up rows are one
// continuous list). Pointer-based (touch + mouse): PRESS AND HOLD any row
// (~230ms without moving) to pick it up — it then FLOATS exactly under the
// finger (1:1 tracking). The other rows COLLIDE with the held one: they
// slide aside (smooth transform transitions) to open a gap at the drop
// slot. Releasing without dragging falls back to the context menu, so the
// long-press gesture keeps both behaviors.
function setupQueueReorder() {
  const panel = $('#queue-panel');
  if (!panel) return;
  let dragEl = null;
  let grabDX = 0, grabDY = 0;
  let grabDX0 = 0, grabDY0 = 0;
  let rowH = 0;
  let targetSlot = 0;
  let armed = false;   // the hold completed (long-press) — next move lifts
  let lifted = false;  // the row is out of flow and floating under the finger
  let armTimer = null;
  let pointerId = 0;
  const baseRects = new Map(); // others' layout rects captured at lift (stable)

  const nowRows = () => [...(document.querySelectorAll('#queue-now .queue-item'))];
  const upRows = () => [...(document.querySelectorAll('#queue-up .queue-item'))];
  const combined = () => [...nowRows(), ...upRows()];

  // Clear every sibling's collision shift (transforms are inline; the class
  // only supplies the smooth transition).
  const clearShift = () => {
    combined().forEach((el) => { el._qShifted = false; el.classList.remove('q-shift'); el.style.transform = ''; });
  };

  // Lift the row out of flow and capture the others' post-collapse rects.
  const lift = (e) => {
    lifted = true;
    queueDragActive = true;
    const w = dragEl.offsetWidth;
    const rect = dragEl._pressRect || dragEl.getBoundingClientRect(); // on-screen rect
    dragEl.style.width = `${w}px`;
    dragEl.classList.remove('q-armed');
    dragEl.classList.add('dragging'); // position: fixed → out of flow
    // The queue panel's open animation leaves a transform fill, so
    // position:fixed resolves against the PANEL, not the viewport. Work
    // entirely in panel coordinates: anchor the row at its panel-relative
    // rect, then translate by the finger's panel-relative delta — no origin
    // correction needed, the row tracks the finger 1:1.
    const pr = panel.getBoundingClientRect();
    dragEl.style.left = `${rect.left - pr.left}px`;
    dragEl.style.top = `${rect.top - pr.top}px`;
    grabDX = (dragEl._pressX != null ? dragEl._pressX : e.clientX) - rect.left;
    grabDY = (dragEl._pressY != null ? dragEl._pressY : e.clientY) - rect.top;
    rowH = rect.height || 48;
    // Force layout (rect read) AFTER the row left the flow, so the others'
    // rects are their stable collapsed positions for the whole drag.
    baseRects.clear();
    combined().forEach((r) => { if (r !== dragEl) baseRects.set(r, r.getBoundingClientRect()); });
    dragEl.style.transform = `translate(${e.clientX - grabDX - rect.left}px, ${e.clientY - grabDY - rect.top}px) scale(1.04)`;
  };

  const onMove = (e) => {
    if (!dragEl) return;
    if (!armed) {
      // Moved before the hold completed — a tap or a scroll, not a reorder.
      if (Math.abs(e.clientX - grabDX0) > 10 || Math.abs(e.clientY - grabDY0) > 10) {
        clearTimeout(armTimer);
        dragEl.classList.remove('q-armed');
        dragEl = null;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      }
      return;
    }
    if (!lifted) lift(e);
    e.preventDefault(); // block native scroll while the row floats
    // 1:1 float — the row stays glued to the finger.
    const r = dragEl._pressRect || dragEl.getBoundingClientRect();
    dragEl.style.transform = `translate(${e.clientX - grabDX - r.left}px, ${e.clientY - grabDY - r.top}px) scale(1.04)`;
    // Collision: the drop slot is how many other rows' midpoints are above
    // the finger; every row at/after the slot slides down one row height to
    // open a gap exactly where the held row hovers.
    let s = 0;
    const y = e.clientY;
    for (const row of combined()) {
      if (row === dragEl) continue;
      const r = baseRects.get(row);
      if (r && y > r.top + r.height / 2) s++;
    }
    targetSlot = s;
    // Only touch siblings whose state CHANGED this frame (tracked on the
    // element) — a long queue stops producing redundant style writes, and
    // every write here is a transform, so the whole collision stays
    // compositor-only: no layout, no reflow, smooth at the GPU rate.
    let i = 0;
    for (const row of combined()) {
      if (row === dragEl) continue;
      const on = i >= s;
      if (on !== row._qShifted) {
        row._qShifted = on;
        row.classList.toggle('q-shift', on);
        row.style.transform = on ? `translateY(${rowH}px)` : '';
      }
      i++;
    }
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    clearTimeout(armTimer);
    if (!dragEl) { armed = false; lifted = false; return; }
    if (armed && !lifted) {
      // Held still then released without dragging — nothing to do. In the
      // queue ONLY, long-press means "pick up to reorder", so no context
      // menu (Like / Add to playlist / Download) opens from a hold here;
      // other pages keep their long-press menus untouched.
      dragEl.classList.remove('q-armed', 'dragging');
      clearShift();
      dragEl = null; armed = false; lifted = false;
      return;
    }
    if (lifted) {
      // Persist the new order: the held row sits at targetSlot among the
      // others (their DOM order never changed during the drag).
      const others = combined().filter((el) => el !== dragEl);
      const s = Math.max(0, Math.min(targetSlot, others.length));
      const order = [...others.slice(0, s), dragEl, ...others.slice(s)];
      const newQueue = order.map((el) => state.queue[Number(el.dataset.idx)]);
      const curId = state.currentTrack && state.currentTrack.id;
      state.queue = newQueue;
      const ni = curId ? newQueue.findIndex((t) => t && t.id === curId) : -1;
      if (ni >= 0) state.index = ni; // the current track stays current wherever it lands
      shuffleOrder = null; // the manual order is now the play order
      queueDragSuppressUntil = Date.now() + 350; // swallow the synthesized click
      renderQueue();
    } else {
      dragEl.classList.remove('dragging');
    }
    clearShift();
    queueDragActive = false;
    dragEl = null; armed = false; lifted = false;
  };

  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const item = e.target.closest('.queue-item');
    if (!item) return;
    dragEl = item;
    pointerId = e.pointerId;
    grabDX0 = e.clientX;
    grabDY0 = e.clientY;
    // Where the user grabbed the row — kept for the lift so the float
    // anchors to the position the user actually saw (mid-animation rows
    // settle while the hold is in progress).
    item._pressRect = item.getBoundingClientRect();
    item._pressX = e.clientX;
    item._pressY = e.clientY;
    armed = false;
    lifted = false;
    // Long-press (230ms, still) picks the row up. The document context-menu
    // long-press (480ms) is cancelled at that point so it never fires mid-hold.
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = true;
      if (navigator.vibrate) navigator.vibrate(10);
      if (typeof cancelLongPress === 'function') cancelLongPress();
      item.classList.add('q-armed'); // subtle lift preview so the hold is visible
      if (item.setPointerCapture) { try { item.setPointerCapture(pointerId); } catch { /* ignore */ } }
    }, 230);
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

// Keyboard: Esc closes, Space toggles, arrows skip (while the overlay is open).
document.addEventListener('keydown', (e) => {
  const bd = $('#np-backdrop');
  if (bd.hidden) return;
  if (e.key === 'Escape') { closeNowPlaying(); return; }
  const inInput = e.target && e.target.closest ? !!e.target.closest('input, button') : false;
  if (inInput) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') nextTrack();
  else if (e.key === 'ArrowLeft') prevTrack();
});

// The Now Playing box collapses into the mini player bar's footprint on
// eat-close: the bar is 64px tall over the box's ~711px, so MIN_SY is the
// final scaleY that lands the box exactly on the bar (bar height / box
// height, computed lazily in case the box's height ever changes).
let MIN_SY = 0.09;
let MIN_SY_SET = false;

// Pull down to close — both the now-playing view and the album/playlist view.
// The gesture only engages when the view's scroll container is at the very top
// (scrollTop === 0): pulling down then translates the sheet and closes it past
// a threshold, while the list can still be scrolled normally at any other
// position. Uses touch events (not pointer capture) so the native scroll of
// the Up Next / track lists is never hijacked.
//
// Close is a plain drop: no fade, and the drop's speed follows the finger — a
// slow pull closes slowly, a fast flick throws the sheet down with momentum.
// With shrink:true (Now Playing) the panel instead EATS into the mini player
// bar's footprint while dragging — the bar swallows the box, never a slide.
function setupPullToClose(panel, scrollEl, closeFn, shrink = false) {
  if (!panel) return;
  // The real scroll container wins: the Now Playing description now scrolls
  // in its own area (.np-ai-scroll) under the fixed trivia header. When that
  // element is present it must be the one guarding pull-to-close (a stale
  // #np-ai reference would read scrollTop 0 and let a mid-description pull
  // eat the box). Fall back to the passed element only when absent.
  const inner = panel.querySelector('.np-ai-scroll');
  if (inner) scrollEl = inner;
  const bd = panel.closest('.np-backdrop');
  // Lazily pin MIN_SY to the real bar/box ratio the first time the box opens.
  if (shrink && !MIN_SY_SET) {
    const bar = $('#player');
    const bh = bar && bar.offsetHeight ? bar.offsetHeight : 64;
    const ph = panel.offsetHeight ? panel.offsetHeight : 711;
    MIN_SY = Math.max(0.05, Math.min(0.15, bh / ph));
    MIN_SY_SET = true;
  }
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let dy = 0;
  let vel = 0;
  let pulling = false;
  // Cached collapse target for the shrink (Now Playing) drag: the box's mini
  // scale (sx, sy) plus refs to the content body and in-box mini row. ALL
  // layout reads happen ONCE per drag (in onStart), NEVER per touchmove —
  // reading offsetWidth/offsetHeight every move forces a synchronous layout
  // pass per frame and stutters a quick scroll. Moves stay pure GPU writes.
  let shrinkGeo = null;

  const onStart = (e) => {
    if (e.target.closest('input, button')) return;
    startY = lastY = e.touches[0].clientY;
    lastT = performance.now();
    dy = 0;
    vel = 0;
    pulling = false;
    if (shrink) {
      // Kill any entrance / slide animation on the art so the inline rules
      // rule (no CSS animation fight) during the drag.
      const art = $('#np-art');
      if (art) {
        art.classList.remove('np-art-in', 'np-slide-left', 'np-slide-right', 'live');
        art.style.animation = 'none';
      }
      // Cache the collapse target ONCE (one layout read per drag start) and
      // prep the body/mini transitions so per-move updates never re-write
      // them. The body fades out + the mini fades in during the drag.
      const body = $('#np-body');
      const mini = $('#np-mini');
      shrinkGeo = npRetractParams();
      if (shrinkGeo) { shrinkGeo.body = body; shrinkGeo.mini = mini; }
      if (body) body.style.transition = 'none';
      if (mini) mini.style.transition = 'none';
    }
  };
  panel.addEventListener('touchstart', onStart, { passive: true });

  const onMove = (e) => {
    if (startY === 0) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    dy = y - startY;
    // Dragging up, or the list is scrolled down — let native scroll handle it.
    if (dy <= 0 || (scrollEl && scrollEl.scrollTop > 0)) { startY = y; lastY = y; lastT = now; dy = 0; vel = 0; pulling = false; return; }
    pulling = true;
    // Velocity in px/ms, smoothed so a jittery finger doesn't misread as a flick.
    const dt = Math.max(1, now - lastT);
    vel = vel * 0.6 + ((y - lastY) / dt) * 0.4;
    lastY = y;
    lastT = now;
    e.preventDefault(); // stop the browser's overscroll bounce
    panel.classList.add('dragging');
    if (shrink) {
      // EAT-close: the box's TOP EDGE comes down as the finger scrolls — the
      // whole box scales about its BOTTOM edge toward the mini player bar's
      // footprint. The Now Playing content STAYS in place and fades OUT fast
      // (crossfade), while the in-box mini row fades IN counter-scaled — the
      // box eats the content and becomes the mini player. Per-frame work is
      // PURE opacity/transform writes from the cached target — no layout
      // reads, no big counter-scaled layer — so a quick drag stays GPU
      // composited (30fps on weak phones).
      const g = shrinkGeo;
      const prog = Math.min(1, (dy * 0.7) / 300);
      if (g) {
        const sy = 1 - (1 - g.sy) * prog;
        const inv = sy > 0.05 ? 1 / sy : 20;
        panel.style.transformOrigin = '50% 100%';
        panel.style.transform = `scale(${(1 - (1 - g.sx) * prog).toFixed(4)}, ${sy.toFixed(4)})`;
        // Crossfade: content fades out from ~10% collapse, mini row fades in
        // (counter-scaled, stays fixed) — the box's base becomes the mini
        // player while the top is still collapsing.
        const f = Math.max(0, Math.min(1, (prog - 0.08) / 0.3));
        if (g.body) g.body.style.opacity = (1 - f).toFixed(3);
        if (g.mini) {
          g.mini.style.transformOrigin = '50% 100%';
          g.mini.style.transform = `scale(1, ${inv.toFixed(4)})`;
          g.mini.style.opacity = f.toFixed(3);
        }
      } else {
        panel.style.transformOrigin = '50% 100%';
        const sy = Math.max(MIN_SY, 1 - (dy * 0.7) / 300);
        panel.style.transform = `scale(1, ${sy.toFixed(4)})`;
      }
    } else {
      panel.style.transform = `translateY(${Math.round(dy * 0.7)}px)`;
    }
  };
  panel.addEventListener('touchmove', onMove, { passive: false });

  const settle = () => {
    panel.classList.remove('dragging');
    const cur = Math.round(dy * 0.7);
    // Past the threshold, or a genuine downward flick — throw the sheet off
    // with the finger's momentum: the drop time shrinks as speed grows.
    const shouldClose = dy > 100 || vel > 0.55;
    if (!shouldClose) {
      // Snap back up, same speed regardless — no fade, just a settle. The
      // content + mini crossfade restores to full Now Playing with it.
      const body = $('#np-body');
      const mini = $('#np-mini');
      panel.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
      panel.style.transform = '';
      if (body) { body.style.transition = 'opacity 0.2s ease'; body.style.opacity = ''; }
      npMiniReset('transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease');
      if (mini) mini.style.opacity = '';
      setTimeout(() => {
        if (!pulling) {
          panel.style.transition = '';
          if (body) { body.style.transition = ''; body.style.opacity = ''; }
          npMiniReset();
          if (mini) mini.style.opacity = '';
        }
      }, 320);
      return;
    }
    if (shrink) {
      // EAT-complete: the same STAGED CONNECTED close as the tap-outside
      // path — the Now Playing contents fade OUT in place, the box finishes
      // collapsing into the mini player footprint while the content stays
      // fixed (counter-scaled), and the box's glass fades away revealing
      // the mini player bar (shown at full opacity the whole time — it IS
      // the collapsed box, so it never disappears). No cut, no pop.
      const p = npRetractParams();
      if (p) {
        panel.classList.add('np-closing'); // fades contents; drops blur for the GPU scale
        panel.style.transition = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.3, 1), background-color 0.3s ease 0.06s, border-radius 0.3s ease 0.06s';
        panel.style.transformOrigin = '50% 100%';
        panel.style.transform = `scale(${p.sx.toFixed(4)}, ${p.sy.toFixed(4)})`;
        panel.style.background = 'rgba(28, 28, 30, 0.55)'; // glass becomes the bar's glass
        panel.style.borderRadius = '16px';
        const body = $('#np-body');
        const mini = $('#np-mini');
        if (body) body.style.opacity = ''; // CSS np-closing fades the content
        if (mini) mini.style.opacity = ''; // CSS np-closing fades the mini in
        npMiniCounterTransform(p.sy, 'transform 0.34s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.25s ease 0.16s');
      } else {
        panel.style.transition = 'transform 0.34s cubic-bezier(0.2, 0.9, 0.3, 1)';
        panel.style.transform = `scale(1, ${MIN_SY})`;
      }
      setTimeout(() => {
        if (!pulling) {
          panel.classList.remove('np-closing');
          panel.style.transition = '';
          panel.style.transform = '';
          panel.style.transformOrigin = '';
          panel.style.background = '';
          panel.style.borderRadius = '';
          const body = $('#np-body');
          const mini = $('#np-mini');
          if (body) body.style.opacity = '';
          if (mini) mini.style.opacity = '';
          npMiniReset();
          const art = $('#np-art');
          if (art) {
            art.style.transition = '';
            art.style.transform = '';
            art.style.transformOrigin = '';
          }
          closeFn();
        }
      }, 400);
      return;
    }
    const drop = Math.min(Math.max(panel.offsetHeight, 480), 1400);
    const remaining = Math.max(0, drop - cur);
    // Duration ∝ remaining distance / throw speed, clamped to feel natural.
    const dur = Math.max(0.16, Math.min(0.6, remaining / Math.max(vel * 1000, 900)));
    panel.style.transition = `transform ${dur}s cubic-bezier(0.4, 0, 0.2, 1)`;
    panel.style.transform = `translateY(${drop}px)`;
    setTimeout(() => {
      if (!pulling) {
        panel.style.transition = '';
        panel.style.transform = '';
        closeFn();
      }
    }, dur * 1000 + 40);
  };

  const end = () => {
    if (!pulling) {
      // A tap/cancel, not a drag — clear the prep that onStart did (body /
      // mini transitions would otherwise stick as 'none').
      startY = 0;
      const body = $('#np-body');
      if (body) { body.style.transition = ''; body.style.opacity = ''; }
      npMiniReset();
      return;
    }
    pulling = false;
    startY = 0;
    settle();
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}

// Now-playing: the Up Next queue list is the scroll container. The box EATS
// into the mini player bar on close (shrink) — never slides down.
setupPullToClose($('#np'), $('.np-ai-scroll') || $('#np-ai'), closeNowPlayingInstant, true);
// Album / playlist / queue / genre: drag-down closes with the SAME eat
// effect as Now Playing — the panel collapses into the mini bar footprint
// while the content fades, never a plain slide. The scroll container wins
// while it isn't at its top (album/playlist track lists, the queue's Up Next
// list; the genre page scrolls as a whole, so its panel is its own scroll
// container).
setupMorphDrag($('#album-view'), $('#album-tracks'), closeAlbumViewInstant);
setupMorphDrag($('#plv-view'), $('#plv-tracks'), closePlaylistViewInstant);
setupMorphDrag($('#queue-panel'), $('#queue-up'), closeQueueInstant);
setupMorphDrag($('#genre-view'), $('#genre-view'), closeGenreInstant);
// Queue page: grip-and-drag reorders the Next Up list.
setupQueueReorder();

// Desktop trivia portal mover: move the .np-ai node into a fixed portal on wide screens
(function setupDesktopTriviaPortal(){
  const portalId = 'desktop-trivia-portal';
  const npAiId = 'np-ai';
  function move() {
    const portal = document.getElementById(portalId);
    const npAi = document.getElementById(npAiId);
    const bd = document.getElementById('np-backdrop');
    if (!portal || !npAi) return;
    const mq = window.matchMedia('(min-width: 900px)');
    try {
      if (mq.matches) {
        if (portal.contains(npAi)) return;
        portal.hidden = false; portal.setAttribute('aria-hidden', 'false');
        portal.appendChild(npAi);
      } else {
        // Move back into the Now Playing panel when narrow
        const panel = bd ? bd.querySelector('.np') : null;
        if (panel && !panel.contains(npAi)) {
          // prefer inserting before any .np-ai-fade placeholder if present
          const fade = panel.querySelector('.np-ai-fade');
          if (fade) panel.insertBefore(npAi, fade);
          else panel.appendChild(npAi);
        }
        portal.hidden = true; portal.setAttribute('aria-hidden', 'true');
      }
    } catch (e) { /* best-effort only */ }
    if (typeof updateNpAiClip === 'function') { try { updateNpAiClip(); } catch (e) {} }
  }
  window.addEventListener('resize', move);
  document.addEventListener('visibilitychange', move);
  document.addEventListener('DOMContentLoaded', move);
  setTimeout(move, 350);
})();

/* ------------------------------ playlist picker ------------------------------ */

let pickerEl = null;
function closePicker() {
  if (pickerEl) { pickerEl.remove(); pickerEl = null; }
  document.removeEventListener('click', closePicker, true);
}
function openPlaylistPicker(target, anchor) {
  closePicker();
  // target is a track OR { __album } — albums add their whole track list.
  const isAlbum = !!(target && target.__album);
  const pls = getPlaylists();
  const picker = document.createElement('div');
  picker.className = 'pl-picker';
  if (!pls.length) {
    picker.innerHTML = '<div class="pl-picker-title">No playlists yet</div>';
  } else {
    picker.innerHTML = `<div class="pl-picker-title">${isAlbum ? 'Add album to playlist' : 'Add to playlist'}</div>` + pls.map((p) => `
      <button type="button" class="pl-pick" data-pl="${esc(p.id)}">
        <span>${esc(p.name)}</span><span class="pl-count">${p.tracks.length}</span>
      </button>`).join('');
  }
  picker.innerHTML += `<button type="button" class="pl-pick new" data-act="new"><span>+ New playlist…</span></button>`;
  document.body.appendChild(picker);
  pickerEl = picker;
  const r = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth;
  const ph = picker.offsetHeight;
  // Flip above the row when there isn't room below (bottom-of-screen rows).
  const below = r.bottom + 6;
  const top = below + ph > window.innerHeight && r.top - ph - 6 > 0 ? r.top - ph - 6 : below;
  picker.style.top = `${top}px`;
  picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pw - 10))}px`;
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pl], [data-act="new"]');
    if (!b) return;
    if (b.dataset.act === 'new') {
      const name = window.prompt('New playlist name:');
      const pl = name && createPlaylist(name);
      if (pl) {
        if (isAlbum) addAlbumToPlaylist(target.__album, pl.id);
        else addToPlaylist(target, pl.id);
      }
      closePicker();
      return;
    }
    if (isAlbum) addAlbumToPlaylist(target.__album, b.dataset.pl);
    else addToPlaylist(target, b.dataset.pl);
    closePicker();
  });
  setTimeout(() => document.addEventListener('click', closePicker, true), 0);
}

/* ------------------------------ drawer: liked + playlists ------------------------------ */

function renderLiked() {
  const list = $('#liked-list');
  const liked = getLiked();
  list.innerHTML = '';
  liked.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'lib-item';
    li.dataset.id = t.id;
    li.innerHTML = `
      <div class="lib-cover">
        ${t.cover
          ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;lib-noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'" />`
          : `<div class="lib-noimg logo-fallback">${LOGO_FB}</div>`}
        <div class="eq" aria-hidden="true" hidden><span></span><span></span><span></span></div>
      </div>
      <div class="meta">
        <div class="t">${esc(t.name)}</div>
        <div class="a">${esc(t.artist)}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="mini-btn" data-lib="play" title="Play">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="mini-btn del" data-lib="unlike" title="Unlike">${ICON_HEART_FILL}</button>
      </div>`;
    li.querySelector('[data-lib="play"]').addEventListener('click', () => {
      playList(liked, liked.indexOf(t));
    });
    li.querySelector('[data-lib="unlike"]').addEventListener('click', () => toggleLike(t));
    list.appendChild(li);
  });
}

function renderPlaylists() {
  const list = $('#playlists-list');
  const pls = getPlaylists();
  list.innerHTML = '';
  pls.forEach((pl) => {
    const li = document.createElement('li');
    li.className = 'lib-item pl';
    li.dataset.id = pl.id;
    // Cover: first track's art if available, else the orange playlist tile.
    const cover = pl.tracks.length ? (pl.tracks[0].cover || '') : '';
    li.innerHTML = `
      <div class="lib-cover pl-ic">
        ${cover
          ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;lib-noimg logo-fallback&quot;>${LOGO_FB_ATTR}</div>'" />`
          : `<div class="lib-noimg logo-fallback">${LOGO_FB}</div>`}
      </div>
      <div class="meta">
        <div class="t">${esc(pl.name)}</div>
        <div class="a">${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="mini-btn" data-lib="play-all" title="Play all">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="mini-btn del" data-lib="del" title="Delete playlist">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>
        </button>
      </div>`;
    li.querySelector('[data-lib="play-all"]').addEventListener('click', (e) => { e.stopPropagation(); playList(pl.tracks, 0); });
    li.querySelector('[data-lib="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlaylist(pl.id);
    });
    // Tapping the row opens the fullscreen playlist page (Spotify-style).
    li.addEventListener('click', () => openPlaylistView(pl));
    list.appendChild(li);
  });
}

function renderLibrary() {
  const count = getLiked().length + getPlaylists().length;
  const badge = $('#library-badge');
  if (badge) { badge.hidden = count === 0; badge.textContent = count; }
  const empty = $('#library-empty');
  if (empty) empty.hidden = getLiked().length > 0 || getPlaylists().length > 0;
}

// Library → "Your name" — prefill the input with the current greeting name.
function renderLibraryName() {
  const input = $('#lib-name-input');
  if (input) input.value = getUserName();
}

// Keep the name input visible above the keyboard while typing. The Android
// WebView uses adjustResize, so the layout viewport already shrinks when the
// keyboard opens — but the input sits near the bottom of the Library page and
// can end up scrolled out of the visible area. Scroll it into view on focus
// and re-center it whenever the keyboard resizes the visual viewport.
let nameKbRAF = 0;
function keepNameInputVisible(smooth = false) {
  cancelAnimationFrame(nameKbRAF);
  nameKbRAF = requestAnimationFrame(() => {
    const input = $('#lib-name-input');
    if (!input || document.activeElement !== input) return;
    // Center the input in the visible (keyboard-shrunk) viewport. 'auto' for
    // the resize/typing cases so repeated events never jitter; 'smooth' only
    // on focus for a gentle settle.
    input.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  });
}
on('#lib-name-input', 'focus', () => keepNameInputVisible(true));
on('#lib-name-input', 'input', () => keepNameInputVisible(false));
if (window.visualViewport) {
  // Fire on the visual viewport resize too: some keyboards animate in
  // (visualViewport.height shrinks over a few frames), and only the final
  // resize has the input fully clear of the keys.
  window.visualViewport.addEventListener('resize', () => {
    if (document.activeElement === $('#lib-name-input')) keepNameInputVisible();
  });
}

on('#lib-name-save', 'click', () => {
  const v = $('#lib-name-input') ? $('#lib-name-input').value : '';
  setUserName(v);
  toast(v.trim() ? `Name set to “${v.trim()}”` : 'Name cleared');
});

function openLibrary() {
  renderLiked();
  renderPlaylists();
  renderLibrary();
  renderLibraryName();
  renderDownloads();
  renderInstallEntry();
  renderUpdatesSection();
}

// Library is a full tab now — no drawer. openLibrary() lives in switchTab.

on('#pl-open-btn', 'click', () => {
  $('#pl-sheet').hidden = false;
  $('#pl-sheet-backdrop').hidden = false;
  setTimeout(() => $('#pl-name').focus(), 120);
});

on('#pl-sheet-backdrop', 'click', () => {
  $('#pl-sheet').hidden = true;
  $('#pl-sheet-backdrop').hidden = true;
});

on('#pl-create-btn', 'click', () => {
  const input = $('#pl-name');
  const pl = createPlaylist(input.value);
  if (pl) {
    toast(`Created “${pl.name}”`);
    input.value = '';
    renderLibrary();
    $('#pl-sheet').hidden = true;
    $('#pl-sheet-backdrop').hidden = true;
  }
  else toast('Enter a playlist name first', true);
});

// Library filter chips (Playlists / Liked / Downloads) — Spotify-style.
on('#library-chips', 'click', (e) => {
  const chip = e.target.closest('[data-lib-filter]');
  if (!chip) return;
  const f = chip.dataset.libFilter;
  $$('#library-chips [data-lib-filter]').forEach((c) => c.classList.toggle('active', c.dataset.libFilter === f));
  $('#lib-playlists-wrap').hidden = f !== 'playlists';
  $('#lib-liked-wrap').hidden = f !== 'liked';
  $('#lib-downloads-wrap').hidden = f !== 'downloads';
});

/* ------------------------------ self-update ------------------------------ */

// Self-update path (public/update.js): the app can fetch a newer engine/app
// bundle from a URL the user controls and hot-swap it via reload — so a
// future YouTube breakage is fixable by pushing files, no PC/ADB needed.

// "Later" per version: once the user dismisses the banner for a given
// version, don't nag again for that same version (a newer one still shows).
const UPDATE_DISMISS_KEY = 'natsirt_update_dismissed';

// The in-app banner: shows when a newer bundle has been downloaded and is
// waiting to apply — so users never have to open Library to find an update.
// Hidden when current, when no URL is set, or when this version was already
// dismissed with "Later".
function renderUpdateBanner() {
  const banner = $('#update-banner');
  if (!banner) return;
  if (!window.Update) { banner.hidden = true; return; }
  const o = Update.status();
  if (!o || !o.newer) { banner.hidden = true; return; }
  // We're already running this version (applied an override earlier this
  // session) — don't nag about an update that's already live.
  const runningVer = Number(document.documentElement.getAttribute('data-override-version') || 0);
  if (o.version === runningVer) { banner.hidden = true; return; }
  let dismissed = 0;
  try { dismissed = Number(localStorage.getItem(UPDATE_DISMISS_KEY) || 0) || 0; } catch {}
  if (o.version <= dismissed) { banner.hidden = true; return; }
  const text = $('#update-banner-text');
  if (text) text.textContent = `Update v${o.version} is ready — restart to apply`;
  banner.hidden = false;
}

on('#update-banner-apply', 'click', () => {
  if (!window.Update) return;
  toast('Applying update…');
  setTimeout(() => Update.apply(), 400);
});
on('#update-banner-later', 'click', () => {
  const o = window.Update && Update.status();
  if (o && o.version) {
    try { localStorage.setItem(UPDATE_DISMISS_KEY, String(o.version)); } catch {}
  }
  const banner = $('#update-banner');
  if (banner) banner.hidden = true;
});

// Automatic check only now (the Library section is gone) — a downloaded
// update surfaces the banner and lets the user choose when to restart.
async function checkForUpdates() {
  if (!window.Update || !Update.getUrl()) return;
  const r = await Update.check();
  if (r.status === 'updated') renderUpdateBanner();
  renderUpdatesSection();
}

/* ------------------------------ Library: App updates section ------------------------------ */

// The Library's persistent "App updates" entry: shows the running build and
// an "Update now" button when a newer version is available (the same bundle
// the top banner offers — this is the always-findable place to check).
function renderUpdatesSection() {
  const note = $('#updates-note');
  const btn = $('#updates-btn');
  const status = $('#updates-status');
  if (!note || !btn || !status) return;
  const cur = (() => {
    const m = document.querySelector('meta[name="orbeat-build"]');
    return (m && Number(m.content)) || 0;
  })();
  if (!window.Update || !Update.getUrl()) {
    note.textContent = `Build ${cur}`;
    status.textContent = 'Self-updates are off for this install.';
    btn.hidden = true;
    return;
  }
  const o = Update.status(); // a downloaded (not yet applied) bundle
  note.textContent = `Build ${cur}${o && o.version ? ` → v${o.version} available` : ''}`;
  if (o && o.newer) {
    btn.hidden = false;
    btn.textContent = `Update now (v${o.version})`;
    status.textContent = 'Downloaded — tap to restart and apply.';
    return;
  }
  // No downloaded bundle (yet): the button runs a fresh check, so it doubles
  // as a manual "Check for updates" for the persistent entry.
  btn.hidden = false;
  btn.textContent = 'Check for updates';
  status.textContent = '';
}

on('#updates-btn', 'click', async () => {
  const btn = $('#updates-btn');
  const status = $('#updates-status');
  if (!window.Update || !Update.getUrl()) return;
  if (Update.status() && Update.status().newer) {
    // A newer bundle is already downloaded — apply it (matches the banner).
    toast('Applying update…');
    setTimeout(() => Update.apply(), 400);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Checking…';
  if (status) status.textContent = '';
  const r = await Update.check();
  btn.disabled = false;
  if (r.status === 'updated') {
    renderUpdateBanner();
    renderUpdatesSection();
    toast(`v${r.version} downloaded — tap Update now to apply`);
  } else if (r.status === 'current') {
    if (status) status.textContent = 'You\'re up to date.';
    btn.textContent = 'Check for updates';
  } else if (r.status === 'disabled') {
    if (status) status.textContent = 'Self-updates are off for this install.';
    btn.hidden = true;
  } else {
    if (status) status.textContent = 'Couldn\'t check: ' + (r.error || 'unknown error');
    btn.textContent = 'Try again';
  }
});

// Auto-check shortly after launch (after the startup burst settles, so the
// ~5 file fetches never add to the cold-open spike). No longer applies
// automatically — a downloaded update shows the banner instead.
if (window.Update && Update.getUrl()) {
  setTimeout(() => checkForUpdates(), 12000);
}

// If a previous session left a downloaded update pending, surface the banner
// immediately on launch (don't wait for the 12s auto-check).
renderUpdateBanner();
renderUpdatesSection();
on('#pl-name', 'keydown', (e) => {
  if (e.key === 'Enter') $('#pl-create-btn').click();
});

/* ------------------------------ session: remember where you left off ------------------------------ */

// The app remembers the last session (tab, playing track, queue position,
// listen time, volume, scroll) in localStorage, so closing and reopening it
// picks up right where you stopped.
const SESSION_KEY = 'natsirt_session';
let lastSessionSave = 0;

function saveSession() {
  // During session restore, the restored state is still being applied — never
  // let playTrackAt's internal saveSession clobber the saved resume position.
  if (state._restoring) return;
  const now = Date.now();
  if (now - lastSessionSave < 2000) return; // throttled
  lastSessionSave = now;
  const track = state.currentTrack;
  if (!track) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 1,
      ts: now,
      tab: state.tab,
      query: state.tab === 'search' ? ($('#search-input').value || '').trim() : '',
      scrollY: window.scrollY || 0,
      queue: state.queue.slice(0, 60),
      index: state.index,
      currentTime: curEl().currentTime || 0,
      playing: !curEl().paused && !!curEl().src,
      volume: state.userVol || curEl().volume || 0.8,
    }));
  } catch { /* storage full/private — ignore */ }
}

let scrollSaveTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveSession, 400);
}, { passive: true });

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!s || !Array.isArray(s.queue) || !s.queue.length) return null;
    if (Date.now() - (s.ts || 0) > 12 * 3600 * 1000) return null; // stale
    if (s.index == null || s.index < 0 || s.index >= s.queue.length) return null;
    return s;
  } catch { return null; }
}

// Restore the player (and nothing else) from a saved session. Returns true if
// a track was restored; the caller decides which tab to open.
function restorePlayer(s) {
  const track = s.queue[s.index];
  if (!track) return false;
  state.queue = s.queue;
  state.index = s.index;
  shuffleOrder = null; // session restore loads a fresh queue
  state.currentTrack = track;
  state.playingId = track.id;
  state.userVol = Math.min(1, Math.max(0, Number(s.volume) || 0.8));
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  $('#volume').value = String(Math.round(state.userVol * 100));
  $('#np-volume').value = $('#volume').value;
  // Show the player first — the title marquee measures real widths. (Stays
  // hidden in Search mode: refreshPlayerVisibility handles visibility.)
  refreshPlayerVisibility();
  updatePlayerUI(track);
  if (s.playing) {
    // Resume playing from where it stopped (WebView may block autoplay on
    // cold start — then the player bar sits ready, one tap from playing).
    state._pendingSeek = s.currentTime || 0;
    state._restoring = true;
    playTrackAt(s.index, s.queue).catch(() => {});
    setTimeout(() => { state._restoring = false; }, 4000);
  } else if (track.videoId || track.audioUrl) {
    // Show the track paused at the saved position.
    state._pendingSeek = s.currentTime || 0;
    const tryRestore = async () => {
      try {
        let src;
        if (track.videoId) src = (await MusicEngine.streamUrl(track.videoId)).url;
        else if (track.audioUrl) src = track.audioUrl;
        else return;
        if (state.currentTrack !== track) return;
        const el = curEl();
        if ((track.duration || 0) > 0) {
          try { await mseStart(el, track, src, { play: false, seekTo: s.currentTime || 0 }); return; } catch { mseTeardown(el); }
        }
        el.src = src;
      } catch { /* leave the player bar visible, no source */ }
    };
    tryRestore();
  }
  return true;
}

/* ------------------------------ service worker (PWA) ------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Relative registration: the app must install from ANY host path, not
    // just the domain root (e.g. GitHub Pages serves from /<repo>/).
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell is a nice-to-have */ });
  });
}

/* ------------------------------ install app (PWA) ------------------------------ */

// "Install OrBeat" — Library → Install app.
//   • Android Chrome fires beforeinstallprompt → show a native install button.
//   • iOS Safari has no install prompt → show Share → Add to Home Screen steps.
//   • Already installed (standalone) → the entry hides itself.
let deferredPrompt = null;

const isIOSDevice = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+ reports as Mac

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  navigator.standalone === true;

function openInstallSheet() {
  const steps = $('#install-steps');
  if (steps) steps.innerHTML = installStepsHtml();
  $('#install-sheet').hidden = false;
  $('#install-backdrop').hidden = false;
}

on('#install-backdrop', 'click', () => {
  $('#install-sheet').hidden = true;
  $('#install-backdrop').hidden = true;
});

on('#install-done', 'click', () => {
  $('#install-sheet').hidden = true;
  $('#install-backdrop').hidden = true;
});

function installStepsHtml() {
  if (isIOSDevice()) {
    return `
      <ol class="install-ol">
        <li>In Safari, tap the <b>Share</b> button <span class="install-glyph">⤴</span> in the toolbar.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. OrBeat appears on your Home Screen and opens fullscreen, like a native app.</li>
      </ol>`;
  }
  return `
    <ol class="install-ol">
      <li>Open this page in <b>Chrome</b> (or your browser's menu <b>⋮</b>).</li>
      <li>Tap <b>Add to Home screen</b> / <b>Install app</b>.</li>
      <li>Confirm — OrBeat installs like any other app.</li>
    </ol>`;
}

function renderInstallEntry() {
  const sec = $('#install-sec');
  if (!sec) return;
  if (isStandalone()) { sec.hidden = true; return; } // already installed
  sec.hidden = false;
  const btn = $('#install-btn');
  const note = $('#install-note');
  if (deferredPrompt) {
    // Chrome/Android: the browser is ready to show a native install prompt.
    btn.textContent = 'Install app';
    if (note) note.textContent = 'Install now — no store needed';
    btn.onclick = async () => {
      const p = deferredPrompt;
      deferredPrompt = null;
      try {
        p.prompt();
        await p.userChoice;
      } catch { /* dismissed or not supported — re-render clears the prompt */ }
      renderInstallEntry();
    };
  } else if (isIOSDevice()) {
    btn.textContent = 'How to install';
    if (note) note.textContent = 'iPhone / iPad';
    btn.onclick = openInstallSheet;
  } else {
    btn.textContent = 'How to install';
    if (note) note.textContent = '';
    btn.onclick = openInstallSheet;
  }
}

// Chrome/Android native install prompt.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  renderInstallEntry();
  renderInstallBanner();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  renderInstallEntry();
  renderInstallBanner();
  toast('OrBeat installed 🎉');
});

/* Install banner — the visible nudge at the top of Home. Shows on first
 * visits (until dismissed) for iPhone/iPad (opens the Add to Home Screen
 * steps) and for Chrome/Android (fires the native install prompt). Hides
 * once the app is installed (standalone). The Library → Install app entry
 * is the persistent home for this; the banner is just the first-visit hook. */
const INSTALL_DISMISS_KEY = 'natsirt_install_dismissed';

function renderInstallBanner() {
  const b = $('#install-banner');
  if (!b) return;
  if (isStandalone()) { b.hidden = true; return; } // already installed
  if (!deferredPrompt && !isIOSDevice()) { b.hidden = true; return; } // no install path
  try { if (localStorage.getItem(INSTALL_DISMISS_KEY)) { b.hidden = true; return; } } catch { /* ignore */ }
  b.hidden = false;
  const btn = $('#ib-install');
  const sub = b.querySelector('.ib-sub');
  if (deferredPrompt) {
    btn.textContent = 'Install';
    if (sub) sub.textContent = 'Tap Install — no app store needed';
    btn.onclick = async () => {
      const p = deferredPrompt;
      deferredPrompt = null;
      try { p.prompt(); await p.userChoice; } catch { /* dismissed or unsupported */ }
      renderInstallEntry();
      renderInstallBanner();
    };
  } else {
    btn.textContent = 'How to install';
    if (sub) sub.textContent = 'Fullscreen app on your Home Screen';
    btn.onclick = openInstallSheet;
  }
}

on('#ib-dismiss', 'click', () => {
  try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch { /* ignore */ }
  const b = $('#install-banner');
  if (b) b.hidden = true;
});

/* ------------------------------ init ------------------------------ */

(async function init() {
  // Offline track cache (IndexedDB) — populates the sync id mirror, then
  // refreshes the Downloads section and any download buttons.
  OfflineCache.init().then(() => {
    renderDownloads();
    refreshDownloadButtons();
  });
  // The relay list is baked into the app — drop any user-saved relay URLs so
  // the built-in defaults (on-device relay first) are the single source.
  try { localStorage.removeItem('natsirt_relays'); } catch { /* ignore */ }
  try { localStorage.removeItem('natsirt_relay'); } catch { /* ignore */ }
  // Load liked + playlists from localStorage.
  try {
    const l = JSON.parse(localStorage.getItem(LIKED_KEY));
    state.liked = Array.isArray(l) ? l : [];
  } catch { state.liked = []; }
  try {
    const p = JSON.parse(localStorage.getItem(PLAYLISTS_KEY));
    state.playlists = Array.isArray(p) ? p : [];
  } catch { state.playlists = []; }
  // Ping saved relays once so dead URLs are marked down immediately (the
  // engine then falls back to mirrors instead of failing every track).
  MusicEngine.checkRelays();
  // The on-device relay binds its loopback socket a moment after the app
  // service starts — the first ping above can race it. Re-confirm it a few
  // times so the app's own relay (the reliable stream path) isn't left marked
  // down, forcing every song through the Cloudflare Worker (whose /stream is
  // datacenter-bot-blocked, HTTP 502). confirmRelay only ever CLEARS a down
  // mark, so a slow bind can't escalate the circuit-breaker backoff.
  const localRelay = (MusicEngine.getRelays() || []).find((u) => /127\.0\.0\.1|localhost/.test(u));
  let localProbes = 0;
  const localPoll = setInterval(() => {
    if (localRelay) MusicEngine.confirmRelay(localRelay);
    if (++localProbes >= 4) clearInterval(localPoll);
  }, 2000);
  // Boot splash safety net: never leave the logo covering the app, even if
  // every Home row fails to load.
  setTimeout(hideBootSplash, 4500);
  // Install banner appears as the boot hero lifts (after the splash's own
  // minimum display time) so iPhone visitors see the install button first.
  setTimeout(renderInstallBanner, 3200);
  // Remember the previous session: playing track, queue, volume, tab, scroll.
  const s = readSession();
  const restored = s ? restorePlayer(s) : false;
  if (s && s.tab === 'search' && s.query) {
    $('#search-input').value = s.query;
    switchTab('search');
    runSearch(s.query); // re-run the saved search
  } else if (s && s.tab === 'library') {
    switchTab('library');
  } else {
    switchTab('home');
  }
  if (s && s.scrollY) setTimeout(() => window.scrollTo(0, s.scrollY), 150);
  // A few seconds after open, refresh trending so the row is fresh even when
  // a cached copy rendered instantly.
  if (!restored || state.tab === 'home') {
    setTimeout(() => { MusicEngine.refreshTrending(); loadTrending(); }, 5000);
  }
})();
