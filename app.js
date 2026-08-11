/* Natsirt Mobile — frontend logic (vanilla JS, zero deps, 100% client-side)
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
function toast(msg, isError = false, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  const oldBtn = el.querySelector('.toast-action');
  if (oldBtn) oldBtn.remove();
  if (action && action.label && action.fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => action.fn());
    el.appendChild(b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
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
  liked: [],          // liked videos (local)
  playlists: [],      // { id, name, tracks: [] } (local)
  searching: false,
  buffering: false,
  moreLike: null,     // { artist, track } — an active "More like this" radio seed
  currentTrack: null, // the track actually playing (survives grid re-renders)
  genre: null,        // active genre chip (Home)
  homeRun: 0,         // token: bump to invalidate in-flight Home fetches
  userVol: 0.8,       // user volume (0..1) — crossfade ramps to this
  xfade: null,        // { fromEl, toEl, toIdx, timer } active crossfade
  preloadedVid: null, // videoId currently buffered on the partner element
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
const ICON_HEART_FILL = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#ff4d6d" d="M12 21s-6.7-4.3-9.3-8.1C.9 10.2 1.6 6.8 4.4 5.4 6.6 4.2 9.1 5 10.6 6.8L12 8.3l1.4-1.5c1.5-1.8 4-2.6 6.2-1.4 2.8 1.4 3.5 4.8 1.7 7.5C18.7 16.7 12 21 12 21z"/></svg>';
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
  if (isLiked(track.id)) {
    saveLiked(liked.filter((l) => l.id !== track.id));
    toast(`Removed “${track.name}” from liked videos`);
  } else {
    saveLiked([likedRecord(track), ...liked]);
    toast(`Liked “${track.name}”`);
  }
  updatePlayingCards(); // saveLiked already re-rendered the drawer; refresh hearts
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
  if (pl.tracks.some((t) => t.id === track.id)) { toast(`Already in “${pl.name}”`); return; }
  pl.tracks.push(likedRecord(track));
  savePlaylists(pls);
  toast(`Added to “${pl.name}”`);
  renderPlaylists();
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

// Song suggestions in the search dropdown. Two modes:
//   • focused + empty  → the tracks you tapped recently (jump back in)
//   • while typing     → live search results for the partial query
// The panel only appears while the search bar is focused and closes on blur.
let suggestTimer = null;
let suggestRun = 0;

function renderSuggestions(tracks) {
  const row = $('#history-row');
  const chips = $('#history-chips');
  const labelEl = $('#history-label');
  // The dropdown shows only songs — no header text (cleaner, YTM-like).
  if (labelEl) labelEl.textContent = '';
  chips.innerHTML = '';
  (tracks || []).slice(0, 8).forEach((t) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sugg';
    el.innerHTML = `
      <span class="sugg-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;noimg&quot;>♪</span>'" />` : '<span class="noimg">♪</span>'}</span>
      <span class="sugg-meta">
        <span class="sugg-name">${esc(t.name)}</span>
        <span class="sugg-artist">${esc(t.artist)}</span>
      </span>`;
    el.addEventListener('click', () => {
      $('#search-input').value = t.name;
      // Tapping a suggestion plays that exact song (smart suggestion), with the
      // whole suggestion list as the queue so Next/Prev keep you in context.
      if (window.Brain && Brain.notePlayed) Brain.notePlayed(t);
      playTrackAt(0, [t, ...(tracks || []).filter((x) => x.id !== t.id)]);
      $('#search-input').blur();
    });
    chips.appendChild(el);
  });
  const visible = state.tab === 'search' && document.activeElement === $('#search-input') && tracks && tracks.length > 0;
  row.hidden = !visible;
  $('#search-clear').hidden = !$('#search-input').value.trim();
}

// Debounced live suggestions while typing.
function refreshLiveSuggestions(q) {
  clearTimeout(suggestTimer);
  const run = ++suggestRun;
  if (!q.trim()) {
    renderSuggestions(getPlays().slice(0, 8), 'Recently played');
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const tracks = await MusicEngine.search(q.trim(), 8, { noVersions: true });
      if (run !== suggestRun || state.tab !== 'search' || document.activeElement !== $('#search-input')) return;
      // Personalize live suggestions by the same profile-aware ranking.
      const ranked = (window.Brain && Brain.rankResults) ? Brain.rankResults(tracks) : tracks;
      if (ranked && ranked.length) renderSuggestions(ranked, 'Suggestions');
      else renderSuggestions(getPlays().slice(0, 8), 'Recently played');
    } catch { /* keep whatever is showing */ }
  }, 260);
}

/* ------------------------------ tabs ------------------------------ */

// The mini player is hidden while searching so the results use the full
// window ("only the search results visible, all the way up"); it returns
// automatically on Home/Moods. A track can keep playing under search.
function refreshPlayerVisibility() {
  const show = state.tab !== 'search' && !!state.currentTrack;
  const p = $('#player');
  if (!p) return; // missing element (HTML/JS drift) must never crash
  p.hidden = !show;
  // The marquee measures real widths, so re-measure after showing (a title
  // set while the bar was hidden reports 0 width and skips the slide).
  if (show && state.currentTrack) {
    requestAnimationFrame(() => setPlayerTitle(state.currentTrack.name));
  }
}

function switchTab(tab) {
  state.tab = tab;
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const isHome = tab === 'home';
  const isMoods = tab === 'moods';
  const isSearch = tab === 'search';
  $('#genres-list').hidden = !isHome;
  $('#artists').hidden = !isHome;
  $('#trending-sec').hidden = !isHome;
  $('#hot-sec').hidden = !isHome;
  $('#ph-sec').hidden = !isHome;
  $('#albums-sec').hidden = !isHome;
  $('#recently').hidden = !isHome;
  $('#foryou').hidden = !isHome;
  $('#moods-page').hidden = !isMoods;
  $('#grid').hidden = !isSearch;
  $('#empty').hidden = !isSearch;
  $('#search-playlists').hidden = !isSearch;
  // Leaving search mode: hide the suggestions panel + close the keyboard,
  // and restore the grid class from 'search-list' back to 'grid'.
  if (!isSearch) {
    // Any exposed-but-unplayed results become skips (learn from what the
    // user saw and didn't pick before moving on).
    if (window.Brain && Brain.flushSkips) Brain.flushSkips();
    $('#history-row').hidden = true;
    $('#search-clear').hidden = true;
    if (document.activeElement === $('#search-input')) $('#search-input').blur();
    if ($('#grid').classList.contains('search-list')) $('#grid').className = 'grid';
  }
  refreshPlayerVisibility(); // hide the player while searching, restore it after
  saveSession();
  if (tab === 'home') {
    loadHome();
  } else if (tab === 'moods') {
    loadMoodsGrid();
  } else if (tab === 'search') {
    const q = $('#search-input').value.trim();
    $('#search-clear').hidden = !q;
    if (!q) showEmpty('Search any song, artist, or album — powered by Natsirt Music.');
    refreshLiveSuggestions(q);
  }
}

on('#bottom-nav', 'click', (e) => {
  const btn = e.target.closest('.nav-tab');
  if (btn) switchTab(btn.dataset.tab);
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

function coverHtml(track, cls) {
  const orig = track.cover || '';
  const src = upscaleCover(orig);
  if (src) {
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" data-orig="${esc(orig)}" onerror="if(!this.dataset.fb){this.dataset.fb='1';this.src=this.dataset.orig}else{this.outerHTML='<div class=&quot;${cls} noimg&quot;>♪</div>'}" />`;
  }
  return `<div class="${cls} noimg">♪</div>`;
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
      <div class="play-overlay">
        <button class="circle" data-act="play" title="Play">${ICON_PLAY}</button>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title" title="${esc(track.name)}">${esc(track.name)}</div>
      <div class="card-artist" title="${esc(track.artist)}">${esc(track.artist)}</div>
    </div>`;
  // Clicking the already-playing card resumes it; any other card starts its
  // track. (Pause is left to the player bar / now-playing view.)
  const cardPlay = () => {
    if (track.id === state.playingId) {
      if (curEl().paused) curEl().play().catch(() => {});
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

function renderTracks(tracks) {
  hideEmpty();
  const grid = $('#grid');
  grid.innerHTML = '';
  tracks.forEach((track) => grid.appendChild(makeCard(track, tracks)));
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
    if (btn) btn.innerHTML = isPlaying && !curEl().paused ? ICON_PAUSE : ICON_PLAY;
    const likeBtn = c.querySelector('[data-act="like"]');
    if (likeBtn) {
      const liked = isLiked(c.dataset.id);
      likeBtn.classList.toggle('liked', liked);
      likeBtn.innerHTML = liked ? ICON_HEART_FILL : ICON_HEART;
      likeBtn.title = liked ? 'Unlike' : 'Like';
    }
  });
  $$('.lib-item').forEach((li) => {
    const isPlaying = !!playing && li.dataset.id === playing;
    li.classList.toggle('playing', isPlaying);
  });
  $$('.search-item').forEach((si) => {
    si.classList.toggle('playing', !!playing && si.dataset.id === playing);
  });
  $$('#album-tracks .album-track').forEach((at) => {
    at.classList.toggle('playing', at.dataset.id === playing);
  });
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

function renderGenreTiles() {
  const row = $('#genres-row');
  row.innerHTML = '';
  GENRES.forEach((g, i) => {
    const gd = GENRE_GRADS[i % GENRE_GRADS.length];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'genre-tile';
    b.style.background = `linear-gradient(135deg, ${gd[0]}, ${gd[1]})`;
    b.innerHTML = `<span class="genre-tile-name">${esc(g)}</span>`;
    b.title = `Browse ${g} music`;
    b.addEventListener('click', () => openGenrePage(g, gd));
    row.appendChild(b);
  });
  $('#genres-list').hidden = state.tab !== 'home';
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
  row.innerHTML = '<div class="row-loading">Loading…</div>';
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
let genrePageRun = 0;
function openGenrePage(genre, grad) {
  const bd = $('#genre-backdrop');
  bd.hidden = false;
  requestAnimationFrame(() => bd.classList.add('open'));
  $('#genre-title').textContent = genre;
  $('#genre-sub').textContent = 'Finding the best tracks…';
  $('#genre-banner').style.background = `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`;
  const grid = $('#genre-grid');
  grid.innerHTML = '<div class="row-loading">Loading…</div>';
  $('#genre-empty').hidden = true;
  const run = ++genrePageRun;
  (async () => {
    try {
      // Load 20 tracks, filter out very long audios (>10min), karaoke, etc.
      let tracks = trimRecommendations(await MusicEngine.search(genre + ' music', 24, { noVersions: true }));
      // Also filter tracks >10 minutes (600s)
      tracks = tracks.filter((t) => (t.duration || 0) <= 600 && (t.duration || 0) >= 20);
      if (run !== genrePageRun) return;
      grid.innerHTML = '';
      tracks.slice(0, 20).forEach((t) => grid.appendChild(makeCard(t, tracks)));
      $('#genre-sub').textContent = `The best of ${genre} right now — ${tracks.length} songs.`;
      if (!tracks.length) { $('#genre-empty').hidden = false; $('#genre-sub').textContent = ''; }
    } catch (e) {
      if (run !== genrePageRun) return;
      grid.innerHTML = '';
      $('#genre-empty').hidden = false;
      $('#genre-empty-text').textContent = `Couldn't load: ${esc(e.message)}`;
      $('#genre-sub').textContent = '';
    }
  })();
}

function closeGenrePage() {
  const bd = $('#genre-backdrop');
  bd.classList.remove('open');
  setTimeout(() => { bd.hidden = true; }, 180);
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
  grid.innerHTML = '';
  empty.hidden = true;
  // Highlight the active chip
  $$('.mood-chip').forEach((c) => c.classList.toggle('active', c.dataset.mood === mood.name));
  const query = pickRandom(mood.seeds);
  try {
    const tracks = shuffle(trimRecommendations(await MusicEngine.search(query, 12, { noVersions: true })));
    if (run !== moodTrackRun) return;
    if (tracks.length) {
      grid.innerHTML = '';
      tracks.forEach((t) => grid.appendChild(makeCard(t, tracks)));
      sub.textContent = `“${esc(query)}” — ${tracks.length} tracks`;
    } else {
      empty.hidden = false;
      sub.textContent = `No tracks found for “${esc(query)}”.`;
    }
  } catch (e) {
    if (run !== moodTrackRun) return;
    empty.hidden = false;
    empty.querySelector('p').textContent = `Couldn't load: ${esc(e.message)}`;
    sub.textContent = '';
  }
}

/* ------------------------------ Home: trending ------------------------------ */

let trendingRun = 0;
// Trending Now — what the internet is playing right now, per YouTube. Refreshed
// automatically (10-min cache + on app resume + manual ↻).
async function loadTrending() {
  const sec = $('#trending-sec');
  const row = $('#trending-row');
  const run = ++trendingRun; // ignore stale completions
  row.innerHTML = '<div class="row-loading">Loading…</div>';
  sec.hidden = false;
  try {
    const tracks = shuffle(trimRecommendations(await MusicEngine.trending(14)));
    if (state.tab !== 'home' || run !== trendingRun) return;
    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    // Pre-warm the first few streams so the very first tap starts instantly.
    tracks.slice(0, 3).forEach((t) => { if (t.videoId) MusicEngine.warm(t.videoId); });
    state.trendingAt = Date.now();
    $('#trending-sub').textContent = 'What the internet is playing right now — refreshed automatically.';
    if (!tracks.length) row.innerHTML = '<p class="row-loading">Nothing trending right now — check back soon.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== trendingRun) return;
    row.innerHTML = `<p class="row-loading">Couldn't load trending: ${esc(e.message)}</p>`;
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
  row.innerHTML = '<div class="row-loading">Loading…</div>';
  sec.hidden = false;
  try {
    const tracks = shuffle(await MusicEngine.hotThisWeek(12));
    if (state.tab !== 'home' || run !== hotRun) return;
    row.innerHTML = '';
    tracks.forEach((t) => {
      const c = makeCard(t, tracks);
      c.classList.add('compact');
      row.appendChild(c);
    });
    // Pre-warm the first few chart streams too — instant first tap.
    tracks.slice(0, 3).forEach((t) => { if (t.videoId) MusicEngine.warm(t.videoId); });
    $('#hot-sub').textContent = 'YouTube Music’s Top 100 right now — tap any song and it plays instantly.';
    sec.hidden = state.tab !== 'home' || tracks.length === 0;
    if (!tracks.length) row.innerHTML = '<p class="row-loading">Chart unavailable right now.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== hotRun) return;
    row.innerHTML = `<p class="row-loading">Couldn't load the chart: ${esc(e.message)}</p>`;
  }
}

on('#trending-refresh', 'click', () => {
  MusicEngine.refreshTrending();
  MusicEngine.refreshHot();
  MusicEngine.refreshPH();
  loadTrending();
  loadHotThisWeek();
  loadPhTrending();
  loadAlbums();
  toast('Refreshing recommendations…');
});

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
  const stale = Date.now() - (state.trendingAt || 0) > 10 * 60 * 1000;
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
  row.innerHTML = '<div class="row-loading">Loading…</div>';
  sec.hidden = false;
  try {
    const tracks = shuffle(trimRecommendations(await MusicEngine.phTrending(12)));
    if (state.tab !== 'home' || run !== phRun) return;
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
    row.innerHTML = `<p class="row-loading">Couldn't load PH trending: ${esc(e.message)}</p>`;
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
  row.innerHTML = '<div class="row-loading">Loading…</div>';
  sec.hidden = false;
  try {
    const queries = [...ALBUM_QUERIES].sort(() => Math.random() - 0.5).slice(0, 2);
    const results = await Promise.all(
      queries.map((q) => MusicEngine.playlistSearch(q, 6).catch(() => []))
    );
    let albums = results.flat().filter((a) => a && a.browseId);
    albums = albums.filter((a) => !MusicEngine.isIndianTrack(a));
    if (state.tab !== 'home' || run !== albRun) return;
    // Shuffle for a fresh shelf each visit.
    albums = albums.sort(() => Math.random() - 0.5);
    row.innerHTML = '';
    albums.forEach((a) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'album-card';
      card.innerHTML = `
        <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=\'noimg\'>♪</span>'" />` : '<span class="noimg">♪</span>'}</span>
        <span class="album-card-name">${esc(a.name)}</span>
        <span class="album-card-artist">${esc(a.artist)}</span>
      `;
      card.addEventListener('click', () => openAlbumView(a));
      row.appendChild(card);
    });
    sec.hidden = state.tab !== 'home' || albums.length === 0;
    if (!albums.length) row.innerHTML = '<p class="row-loading">No albums found.</p>';
  } catch (e) {
    if (state.tab !== 'home' || run !== albRun) return;
    row.innerHTML = `<p class="row-loading">Couldn't load albums: ${esc(e.message)}</p>`;
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
      card.innerHTML = `
        <span class="album-card-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=\'noimg\'>♪</span>'" />` : '<span class="noimg">♪</span>'}</span>
        <span class="album-card-name">${esc(a.name)}</span>
        <span class="album-card-artist">${esc(a.artist)}</span>
      `;
      card.addEventListener('click', () => openAlbumView(a));
      row.appendChild(card);
    });
  } catch { /* playlists shelf is a nice-to-have */ }
}

on('#albums-refresh', 'click', () => { MusicEngine.refreshTrending(); MusicEngine.refreshHot(); MusicEngine.refreshPH(); loadAlbums(); toast('Refreshing albums…'); });

// Album view — opens an overlay showing the album's tracks.
function openAlbumView(album) {
  // For fallback albums (no real browseId), use the artist name as the
  // "album" label so the overlay looks right with artist-search results.
  const albumName = album.browseId ? album.name : album.artist;
  const albumArtist = album.artist;
  // Playlists are the app's "Albums" — label them as playlists, not albums.
  const typeLabel = album.source === 'playlist' ? 'Playlist' : 'Album';
  $('#album-backdrop').hidden = false;
  requestAnimationFrame(() => $('#album-backdrop').classList.add('open'));
  $('#album-art').innerHTML = album.cover
    ? `<img src="${esc(album.cover)}" alt="" onerror="this.outerHTML='<div class=\'noimg\'>♪</div>'" />`
    : '<div class="noimg">♪</div>';
  $('#album-name').textContent = albumName;
  $('#album-artist').textContent = albumArtist;
  const label = album.browseId ? (album.year ? `${album.year}${album.trackCount ? ` • ${album.trackCount} songs` : ''}` : (album.trackCount ? `${album.trackCount} songs` : '')) : 'Popular tracks';
  $('#album-meta2').textContent = label;
  const src = $('#album-view').querySelector('.np-source');
  if (src) src.textContent = typeLabel;
  loadAlbumTracks(album.browseId || '', album._artistQuery || album.artist);
}

function closeAlbumView() {
  $('#album-backdrop').classList.remove('open');
  setTimeout(() => { $('#album-backdrop').hidden = true; }, 180);
}

on('#album-close', 'click', closeAlbumView);

async function loadAlbumTracks(browseId, artistFallback) {
  const list = $('#album-tracks');
  list.innerHTML = '<div class="row-loading">Loading tracks…</div>';
  try {
    const tracks = await MusicEngine.albumTracks(artistFallback || '', browseId);
    list.innerHTML = '';
    tracks.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'album-track';
      el.dataset.id = t.id;
      const isPlaying = state.playingId === t.id;
      el.innerHTML = `
        <span class="t-cover">${coverHtml(t, 't-cover-img')}</span>
        <div class="t-info">
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-artist">${esc(t.artist)}</div>
        </div>`;
      el.addEventListener('click', () => {
        // Highlight immediately on click
        $$('#album-tracks .album-track').forEach((at) => at.classList.remove('playing'));
        el.classList.add('playing');
        playTrackAt(i, tracks);
      });
      list.appendChild(el);
    });
    if (!tracks.length) list.innerHTML = '<div class="row-loading">No tracks found.</div>';
  } catch (e) {
    list.innerHTML = `<div class="row-loading">Couldn't load tracks: ${esc(e.message)}</div>`;
  }
}

// Smart recommendations are app behavior, not a panel: when a queue ends the
// app keeps playing related music (see maybeExtendQueue / nextTrack), and the
// For You row above refreshes itself as you listen.

function loadHome() {
  state.homeRun++;
  renderGenreTiles();
  renderRecently();
  renderLiked();
  renderPlaylists();
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
    // Learn related artists / genres from this search (co-occurrence).
    if (window.Brain && Brain.learnFromSearch) Brain.learnFromSearch(query, tracks);
    if (ranked && ranked.length) renderSearchResults(ranked);
    else showEmpty(`No results for “${esc(query)}”.`);
  } catch (e) {
    if (state.tab === 'search') showEmpty(`Search failed: ${esc(e.message)}`);
  } finally {
    state.searching = false;
  }
}

// Render search results: a list view (song rows) side by side with playlist
// cards. The grid-id element is still used for the list layout.
function renderSearchResults(tracks) {
  state.queue = tracks;
  state.index = -1;
  hideEmpty();
  // Expose this list to the Brain: the previous list's unplayed artists are
  // counted as skips (learn from what the user scrolled past), and the new
  // list becomes the current exposure set.
  if (window.Brain && Brain.noteExposed) Brain.noteExposed(tracks);
  const grid = $('#grid');
  grid.innerHTML = '';
  grid.className = 'search-list'; // switch to list layout
  tracks.slice(0, 25).forEach((track, i) => {
    const el = document.createElement('div');
    el.className = 'search-item';
    el.dataset.id = track.id;
    const isPlaying = state.playingId === track.id;
    el.innerHTML = `
      <span class="si-cover">${coverHtml(track, 'si-img')}</span>
      <span class="si-num">${i + 1}</span>
      <div class="si-info">
        <div class="si-name">${esc(track.name)}</div>
        <div class="si-artist">${esc(track.artist)}</div>
      </div>
      <span class="si-dur">${fmtDur(track.duration)}</span>
    `;
    el.addEventListener('click', () => {
      // Positive search signal: the user picked this artist from the results.
      if (window.Brain && Brain.notePlayed) Brain.notePlayed(track);
      playTrackAt(i, tracks);
    });
    grid.appendChild(el);
  });
  // Restore grid class to normal when switching away from search
}

// Search lives in the bottom nav: focusing/typing enters search mode, and the
// suggestions panel shows only while the bar is focused — it closes on blur.
// Tapping the icon/padding around the input focuses it too.
on('#nav-search', 'click', (e) => {
  if (!e.target.closest('input')) $('#search-input').focus();
});
on('#search-input', 'focus', () => {
  if (state.tab !== 'search') switchTab('search');
  refreshLiveSuggestions($('#search-input').value.trim());
});
on('#search-input', 'input', (e) => {
  if (state.tab !== 'search') switchTab('search');
  $('#search-clear').hidden = !e.target.value.trim();
  refreshLiveSuggestions(e.target.value.trim());
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
  $('#history-row').hidden = true;
  $('#search-clear').hidden = !$('#search-input').value.trim();
});

// Simple × button: clears the bar, keeps focus so suggestions re-open.
on('#search-clear', 'click', () => {
  const input = $('#search-input');
  input.value = '';
  $('#search-clear').hidden = true;
  input.focus();
  refreshLiveSuggestions('');
  if (state.tab === 'search') showEmpty('Search any song, artist, or album — powered by Natsirt Music.');
});


/* ------------------------------ Recently Played (home tab) ------------------------------ */

function renderRecently() {
  const sec = $('#recently');
  if (!sec) return;
  const plays = getPlays().slice(0, 10);
  const row = $('#recently-row');
  row.innerHTML = '';
  plays.forEach((p) => {
    const c = makeCard(p, plays);
    c.classList.add('compact');
    row.appendChild(c);
  });
  sec.hidden = state.tab !== 'home' || plays.length === 0;
}

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
          ? `${genreLabel} — refreshed as you play.`
          : (topArtist
              ? `Because you've been listening to ${topArtist} — refreshed as you play.`
              : 'Based on your recent searches — refreshed as you play.'));
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
const MSE_CFG = {
  CHUNK_SEC: 12,       // bytes per refill chunk ≈ 12s of audio
  FIRST_CHUNK_SEC: 15, // the very first chunk covers 0 → 15s
  REFILL_AHEAD: 6,     // fetch more when less than this much is buffered ahead
  MAX_AHEAD: 15,       // never keep more than this much buffered ahead
  KEEP_BACK: 2,        // keep this much behind currentTime (tiny seek-backs)
  MIN_START_SEC: 3,    // no refill chunk begins below this offset (chunk 1 excepted)
  POLL_MS: 400,        // buffer scheduler tick
};

const mseCodec = (ct) => {
  const t = String(ct || '').toLowerCase();
  if (t.includes('mp4')) return { audio: 'audio/mp4; codecs="mp4a.40.2"', muxed: 'video/mp4; codecs="avc1.4d401e,mp4a.40.2"' };
  if (t.includes('webm')) return { audio: 'audio/webm; codecs="opus"', muxed: 'video/webm; codecs="vp9,opus"' };
  return null;
};

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

// Fetch one byte range from the stream URL and append it to the SourceBuffer.
async function mseFetchChunk(s, startByte) {
  if (s.dead) return;
  if (startByte >= s.total) { s.loadedEnd = s.total; mseMaybeEnd(s); return; }
  // Refill chunks never begin below the 3s mark (the first chunk starts at 0).
  const minStart = Math.floor(s.bps * MSE_CFG.MIN_START_SEC);
  const from = Math.max(startByte, s.chunkSeq > 0 ? minStart : 0);
  if (from >= s.total) { s.loadedEnd = s.total; mseMaybeEnd(s); return; }
  // Byte ranges must be whole numbers — a float like bytes=0-194228.69 is a
  // malformed Range header and the WebView rejects it ("Failed to fetch").
  const chunkBytes = Math.max(64 * 1024, Math.floor(s.bps * MSE_CFG.CHUNK_SEC));
  const to = Math.min(s.total - 1, Math.floor(from + chunkBytes));
  const res = await fetch(s.url, { credentials: 'omit', headers: { Range: `bytes=${from}-${to}` } });
  if (res.status === 416) { s.loadedEnd = s.total; mseMaybeEnd(s); return; }
  if (!res.ok) throw new Error(`range HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (s.dead || !s.sb) return;
  s.chunkSeq++;
  await new Promise((resolve, reject) => {
    const done = () => { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); resolve(); };
    const fail = () => { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); reject(new Error('SourceBuffer append failed')); };
    s.sb.addEventListener('updateend', done);
    s.sb.addEventListener('error', fail);
    try { s.sb.appendBuffer(buf); } catch (e) { s.sb.removeEventListener('updateend', done); s.sb.removeEventListener('error', fail); reject(e); }
  });
  s.loadedEnd = to + 1;
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
  const keepStart = Math.max(0, s.el.currentTime - MSE_CFG.KEEP_BACK);
  const keepEnd = s.el.currentTime + MSE_CFG.MAX_AHEAD;
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

// Buffer scheduler: refill when the lookahead dips below REFILL_AHEAD.
function mseSchedule(s) {
  const tick = async () => {
    if (s.dead || s.eos || !s.el._mse) return;
    mseEvict(s);
    if (s.fetching) { setTimeout(tick, MSE_CFG.POLL_MS); return; }
    const loadedSec = s.bps > 0 ? s.loadedEnd / s.bps : s.duration;
    const ahead = loadedSec - s.el.currentTime;
    if (ahead < MSE_CFG.REFILL_AHEAD && loadedSec < s.duration - 0.5) {
      s.fetching = true;
      try {
        await mseFetchChunk(s, s.loadedEnd);
        setTimeout(tick, MSE_CFG.POLL_MS);
      } catch (e) {
        // Stream hiccup (relay throttled / range 403 / CDN cap): tear down and
        // let the normal retry machinery handle it (fresh URL → fallbacks).
        mseTeardown(s.el);
        try { s.el.dispatchEvent(new Event('error')); } catch { /* ignore */ }
      } finally {
        s.fetching = false;
      }
    } else if (!s.eos) {
      setTimeout(tick, MSE_CFG.POLL_MS);
    }
  };
  setTimeout(tick, MSE_CFG.POLL_MS);
}

// Start an MSE session on `el` for `track` using `url` (the relay stream URL).
// opts: { play, seekTo } — buffers from seekTo (default 0), plays when requested,
// then keeps a strict 10-15s lookahead via byte ranges until the track ends.
async function mseStart(el, track, url, opts = {}) {
  if (!window.MediaSource || !(track.duration > 0)) throw new Error('MSE unavailable');
  mseTeardown(el);
  const s = { el, track, url, ms: null, msUrl: null, sb: null, total: 0, duration: track.duration, bps: 0, loadedEnd: 0, chunkSeq: 0, eos: false, dead: false, fetching: false };
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
  const probe = await fetch(url, { credentials: 'omit', headers: { Range: 'bytes=0-0' } });
  if (!probe.ok && probe.status !== 206) throw new Error(`stream HTTP ${probe.status}`);
  const cr = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  s.total = cr ? Number(cr[1]) : 0;
  const ct = probe.headers.get('content-type') || 'audio/mp4';
  const codecs = mseCodec(ct);
  const candidate = ct.includes('video') && codecs ? codecs.muxed : (codecs ? codecs.audio : null);
  if (!candidate || !MediaSource.isTypeSupported(candidate)) throw new Error('Unsupported stream type');
  if (!(s.total > 0)) throw new Error('Unknown stream size');
  s.type = candidate;
  s.bps = s.total / s.duration;
  const sb = ms.addSourceBuffer(candidate);
  sb.mode = 'segments';
  s.sb = sb;
  // First chunk: bytes 0 → FIRST_CHUNK_SEC (playback starts at 0).
  const startByte = Math.max(0, Math.floor((opts.seekTo || 0) * s.bps));
  await mseFetchChunk(s, startByte);
  const seekTo = Math.min(s.duration, opts.seekTo || 0);
  try { el.currentTime = seekTo; } catch { /* ignore */ }
  if (opts.play !== false) {
    setBuffering(true);
    await el.play();
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
}

async function playTrackAt(i, list) {
  if (!list) list = state.queue;
  if (i < 0 || i >= list.length) return;
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
  state.playingId = track.id;
  state.currentTrack = track;
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
      const stream = await MusicEngine.streamUrl(vid);
      // Superseded by a newer selection (user tapped another track while this
      // stream was resolving)? Stop — don't clobber their choice.
      if (state.playingId !== track.id) return;
      src = stream.url;
    } else if (track.audioUrl) {
      src = track.audioUrl; // pre-resolved source (saved/recent tracks keep one)
    } else {
      throw new Error('No playable source for this track');
    }
    const el = curEl();
    let played = false;
    // High-quality bounded-buffer path: MSE fed by byte-range requests keeps
    // only a strict 10-15s lookahead (never buffers the whole track). Falls
    // back to the plain <audio> element when MSE isn't possible.
    if (state.playingId === track.id && (track.duration || 0) > 0) {
      const seekTo = state._pendingSeek != null ? state._pendingSeek : 0;
      try {
        await mseStart(el, track, src, { play: true, seekTo });
        played = true;
      } catch (e) {
        mseTeardown(el);
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
  if (state.queue.length < 2) return;
  // Capture the queue/position NOW; the end-guard compares identity so a
  // replaced queue (new search/album list) can never load the wrong track.
  const queue = state.queue;
  const index = state.index;
  const toIdx = (index + 1) % queue.length;
  const next = queue[toIdx];
  if (!next) return;
  const toEl = otherEl();
  // Already preloaded this exact track — don't reload it.
  if (state.preloadedVid && state.preloadedVid === (next.videoId || next.id) && (toEl._mse || toEl.src)) return;
  if (next.videoId) MusicEngine.warm(next.videoId); // cache the URL even if the load below is slow
  // Fire-and-forget warm the track after next too, so skipping forward twice
  // (or the track after the crossfade) is just as instant.
  if (queue.length > 2) {
    const next2 = queue[(index + 2) % queue.length];
    if (next2 && next2.videoId) MusicEngine.warm(next2.videoId);
  }
  (async () => {
    let track = next;
    if (!track.videoId && track.searchQuery) {
      try { track = await MusicEngine.resolveChartTrack(track); queue[toIdx] = track; } catch { return; }
    }
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
        await mseStart(toEl, track, src, { play: false, seekTo: 0 });
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
  const bar = $('#seek-buffer');
  if (bar) bar.style.width = pct.toFixed(1) + '%';
  const np = $('#np-seek-buffer');
  if (np) np.style.width = pct.toFixed(1) + '%';
}

// Media listeners are bound to BOTH audio elements; only the active one
// drives the UI, which lets the 10s overlap handoff switch elements seamlessly.
function bindMedia(el) {
  el.addEventListener('progress', () => { if (el === curEl()) updateBufferBar(); });
  el.addEventListener('play', () => {
    if (el !== curEl()) return;
    $('#play-path').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z');
    $('#np-play-path').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z');
    updatePlayingCards();
    reportNowPlaying(true);
    saveSession();
  });
  el.addEventListener('pause', () => {
    if (el !== curEl() && !(state.xfade && (state.xfade.fromEl === el || state.xfade.toEl === el))) return;
    $('#play-path').setAttribute('d', 'M8 5v14l11-7z');
    $('#np-play-path').setAttribute('d', 'M8 5v14l11-7z');
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
    const v = Math.round((el.currentTime / el.duration) * 1000);
    $('#seek').value = v;
    $('#np-seek').value = v;
    $('#t-cur').textContent = fmtDur(el.currentTime);
    $('#t-total').textContent = fmtDur(el.duration);
    $('#np-t-cur').textContent = fmtDur(el.currentTime);
    $('#np-t-total').textContent = fmtDur(el.duration);
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
  el.addEventListener('waiting', () => { if (el === curEl()) setBuffering(true); });
  el.addEventListener('stalled', () => { if (el === curEl()) setBuffering(true); });
  el.addEventListener('playing', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('canplay', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('pause', () => { if (el === curEl()) setBuffering(false); });
  el.addEventListener('error', () => handleMediaError(el));
}
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
        if ((track.duration || 0) > 0) await mseStart(toEl, track, src, { play: false, seekTo: 0 });
        else toEl.src = src;
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
      const url = `${relay}/stream?videoId=${encodeURIComponent(vid)}`;
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
}
audio.addEventListener('playing', bindMediaPlayed);
audio2.addEventListener('playing', bindMediaPlayed);

/* ------------------------------ native media bridge (lock-screen controls) ------------------------------ */

// Inside the Android app, report what's playing to the on-device relay so the
// native side (NatsirtRelayService) can show lock-screen media controls with
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
  const body = {
    title: String(t.name || ''),
    artist: String(t.artist || ''),
    cover: t.cover || '',
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
  $('#player-cover').outerHTML = base
    ? `<img class="player-cover" id="player-cover" src="${esc(base)}" alt="" data-orig="${esc(fallback)}" onerror="if(!this.dataset.fb){this.dataset.fb='1';this.src=this.dataset.orig}else{this.outerHTML='<div class=&quot;player-cover noimg&quot;>♪</div>'}" />`
    : '<div class="player-cover noimg">♪</div>';
  setPlayerTitle(track.name);
  $('#player-artist').textContent = track.artist;
  $('#t-cur').textContent = '0:00';
  $('#seek').value = 0;
  const bb = $('#seek-buffer'); if (bb) bb.style.width = '0%';
  const nb = $('#np-seek-buffer'); if (nb) nb.style.width = '0%';
  updateNowPlaying();
}

// Player title: centered in the bar, and when it overflows it slides
// (marquee) so the full title is always readable. Two copies in the track +
// translateX(-50%) give a seamless loop.
let lastTitleText = null;
let lastTitleOverflow = false;
function setPlayerTitle(text) {
  const el = $('#player-title');
  if (!el) return;
  const escT = esc(String(text || '—'));
  // Measure against the meta's visible window, not el.clientWidth — once the
  // marquee class is applied el becomes width:max-content and its clientWidth
  // is the full track width, which would break the overflow check.
  const limit = (el.parentElement || el).clientWidth;
  const probe = el.querySelector('.tt');
  const overflow = probe ? probe.scrollWidth > limit + 2 : false;
  // Nothing changed (resize with the same track) — leave the DOM alone so the
  // running marquee animation doesn't restart.
  if (escT === lastTitleText && overflow === lastTitleOverflow) return;
  lastTitleText = escT;
  lastTitleOverflow = overflow;
  el.innerHTML = `<span class="tt">${escT}</span>`;
  if (overflow) {
    el.innerHTML = `<span class="tt">${escT}&nbsp;</span><span class="tt" aria-hidden="true">${escT}&nbsp;</span>`;
    el.classList.add('marquee');
    // Longer titles slide a little slower so the whole text stays readable.
    el.style.animationDuration = `${Math.max(9, Math.min(22, String(text || '—').length * 0.35))}s`;
  } else {
    el.classList.remove('marquee');
    el.style.animationDuration = '';
  }
}
window.addEventListener('resize', () => {
  if (state.currentTrack) setPlayerTitle(state.currentTrack.name);
});

// Smart recommendation as app behavior: when the queue is about to end, grow
// it with songs like the one playing (never a panel — just continuous music).
let extendRun = 0;
async function maybeExtendQueue() {
  if (state.queue.length < 3 || state.index < state.queue.length - 1) return;
  const run = ++extendRun;
  const queue = state.queue;
  const seed = queue[state.index];
  const artist = String((seed && seed.artist) || '').trim();
  if (!artist || artist === 'Unknown artist') return;
  try {
    const more = trimRecommendations(await MusicEngine.search(artist, 10, { noVersions: true }));
    if (run !== extendRun || state.queue !== queue) return; // user moved on / queue replaced
    const seen = new Set(state.queue.map((t) => t.id));
    const fresh = more.filter((t) => !seen.has(t.id)).slice(0, 8);
    if (fresh.length) {
      state.queue.push(...fresh);
      toast(`Playing more like ${artist}…`);
    }
  } catch { /* keep the queue as-is */ }
}

function nextTrack() {
  if (state.index < 0 || state.queue.length === 0) return;
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd) {
    // Grow the queue with related songs first, then advance — either onto the
    // new tracks (if any were found) or back around the original list.
    maybeExtendQueue().then(() => {
      playTrackAt((state.index + 1) % state.queue.length);
    });
  } else {
    playTrackAt(state.index + 1);
  }
}

function prevTrack() {
  if (state.index < 0 || state.queue.length === 0) return;
  playTrackAt((state.index - 1 + state.queue.length) % state.queue.length);
}

on('#btn-play', 'click', () => {
  const el = curEl();
  if (el.paused) el.play().catch(() => {});
  else el.pause();
});
on('#btn-next', 'click', nextTrack);
on('#btn-prev', 'click', prevTrack);

// Seek with MSE awareness: inside the buffered window it's a plain jump;
// outside it, clear the buffer and re-chunk from the new position.
function seekPlayerTo(sec) {
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
    mseStart(el, track, url, { play: !wasPaused, seekTo: target }).catch(() => {});
    return;
  }
  el.currentTime = target;
}

on('#seek', 'change', () => {
  if (curEl().duration) seekPlayerTo((Number($('#seek').value) / 1000) * curEl().duration);
});
on('#volume', 'input', () => {
  state.userVol = Number($('#volume').value) / 100;
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  $('#np-volume').value = $('#volume').value;
  saveSession();
});

/* ------------------------------ now playing (fullscreen) ------------------------------ */

function openNowPlaying() {
  const bd = $('#np-backdrop');
  bd.hidden = false;
  requestAnimationFrame(() => bd.classList.add('open'));
  $('#np-volume').value = $('#volume').value;
  updateNowPlaying();
  $('#np-close').focus();
}

function closeNowPlaying() {
  const bd = $('#np-backdrop');
  bd.classList.remove('open');
  setTimeout(() => { bd.hidden = true; }, 180);
}

function updateNowPlaying() {
  const bd = $('#np-backdrop');
  if (!bd || bd.hidden) return;
  const track = state.currentTrack;
  if (!track) return;
  $('#np-title').textContent = track.name;
  $('#np-artist').textContent = track.artist;
  $('#np-source').textContent = 'Natsirt Music';
  const art = $('#np-art');
  art.innerHTML = track.cover
    ? `<img src="${esc(track.cover)}" alt="" onerror="this.outerHTML='<div class=&quot;noimg&quot;>♪</div>'" />`
    : '<div class="noimg">♪</div>';
  const likeBtn = $('#np-like');
  const liked = isLiked(track.id);
  likeBtn.textContent = liked ? 'Liked' : 'Like';
  likeBtn.classList.toggle('liked', liked);
}

function togglePlay() {
  const el = curEl();
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

on('#player-track', 'click', openNowPlaying);
on('#np-close', 'click', closeNowPlaying);
on('#np-play', 'click', togglePlay);
on('#np-next', 'click', nextTrack);
on('#np-prev', 'click', prevTrack);

on('#np-seek', 'input', () => {
  $('#seek').value = $('#np-seek').value;
});
on('#np-seek', 'change', () => {
  if (curEl().duration) seekPlayerTo((Number($('#np-seek').value) / 1000) * curEl().duration);
});

on('#np-volume', 'input', () => {
  state.userVol = Number($('#np-volume').value) / 100;
  audio.volume = state.userVol;
  audio2.volume = state.userVol;
  $('#volume').value = $('#np-volume').value;
});

on('#np-like', 'click', () => {
  if (!state.currentTrack) return;
  toggleLike(state.currentTrack);
  updateNowPlaying();
});

on('#np-playlist', 'click', () => {
  if (!state.currentTrack) return;
  openPlaylistPicker(state.currentTrack, $('#np-playlist'));
});

on('#np-more', 'click', () => {
  if (!state.currentTrack) return;
  closeNowPlaying();
  moreLikeThis(state.currentTrack);
});

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

// Swipe down to dismiss (mouse + touch).
(() => {
  const bd = $('#np-backdrop');
  const panel = $('#np');
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input, button')) return;
    try { panel.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    drag = { startX: e.clientX, startY: e.clientY, dy: 0, moved: false };
    panel.classList.add('dragging');
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) > 4 && Math.abs(dy) > Math.abs(dx)) drag.moved = true;
    if (!drag.moved) return;
    drag.dy = Math.max(0, dy);
    panel.style.transform = `translateY(${drag.dy}px) scale(${Math.max(0.92, 1 - drag.dy / 1200)})`;
    bd.style.opacity = String(Math.max(0, 1 - drag.dy / 550));
  });
  const endDrag = () => {
    if (!drag) return;
    const dy = drag.dy;
    drag = null;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    bd.style.opacity = '';
    if (dy > 110) closeNowPlaying();
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
})();

/* ------------------------------ playlist picker ------------------------------ */

let pickerEl = null;
function closePicker() {
  if (pickerEl) { pickerEl.remove(); pickerEl = null; }
  document.removeEventListener('click', closePicker, true);
}
function openPlaylistPicker(track, anchor) {
  closePicker();
  const pls = getPlaylists();
  const picker = document.createElement('div');
  picker.className = 'pl-picker';
  if (!pls.length) {
    picker.innerHTML = '<div class="pl-picker-title">No playlists yet</div>';
  } else {
    picker.innerHTML = `<div class="pl-picker-title">Add to playlist</div>` + pls.map((p) => `
      <button type="button" class="pl-pick" data-pl="${esc(p.id)}">
        <span>${esc(p.name)}</span><span class="pl-count">${p.tracks.length}</span>
      </button>`).join('');
  }
  picker.innerHTML += `<button type="button" class="pl-pick new" data-act="new"><span>+ New playlist…</span></button>`;
  document.body.appendChild(picker);
  pickerEl = picker;
  const r = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth;
  picker.style.top = `${r.bottom + 6}px`;
  picker.style.left = `${Math.min(r.left, window.innerWidth - pw - 10)}px`;
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pl], [data-act="new"]');
    if (!b) return;
    if (b.dataset.act === 'new') {
      const name = window.prompt('New playlist name:');
      const pl = name && createPlaylist(name);
      if (pl) addToPlaylist(track, pl.id);
      closePicker();
      return;
    }
    addToPlaylist(track, b.dataset.pl);
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
      ${t.cover
        ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.remove()" />`
        : '<div class="lib-noimg">♪</div>'}
      <div class="meta">
        <div class="t">${esc(t.name)}</div>
        <div class="a">${esc(t.artist)}</div>
      </div>
      <div style="display:flex;gap:4px">
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
    li.innerHTML = `
      <div class="lib-noimg pl-ic">♪</div>
      <div class="meta">
        <div class="t">${esc(pl.name)}</div>
        <div class="a">${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}</div>
      </div>
      <div style="display:flex;gap:4px">
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
    li.addEventListener('dblclick', () => li.querySelector('[data-lib="play-all"]').click());
    list.appendChild(li);
    // Tracks inside the playlist (accordion).
    const tracks = document.createElement('div');
    tracks.className = 'pl-tracks';
    tracks.hidden = true;
    pl.tracks.forEach((t) => {
      const tli = document.createElement('div');
      tli.className = 'lib-item pl-track';
      tli.dataset.id = t.id;
      tli.innerHTML = `
        ${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy" onerror="this.remove()" />` : '<div class="lib-noimg">♪</div>'}
        <div class="meta"><div class="t">${esc(t.name)}</div><div class="a">${esc(t.artist)}</div></div>
        <button class="mini-btn del" data-lib="rm" title="Remove">✕</button>`;
      tli.querySelector('[data-lib="rm"]').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromPlaylist(pl.id, t.id);
      });
      tli.addEventListener('click', (e) => {
        e.stopPropagation();
        playList(pl.tracks, pl.tracks.indexOf(t));
      });
      tracks.appendChild(tli);
    });
    li.appendChild(tracks);
    li.addEventListener('click', () => { tracks.hidden = !tracks.hidden; });
    list.appendChild(li);
  });
}

function renderLibrary() {
  const count = getLiked().length + getPlaylists().length;
  const badge = $('#library-badge');
  badge.hidden = count === 0;
  badge.textContent = count;
  const empty = $('#library-empty');
  if (empty) empty.hidden = getLiked().length > 0 || getPlaylists().length > 0;
}

function openLibrary() {
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  renderLiked();
  renderPlaylists();
  renderLibrary();
  // Self-update: show the configured URL + current override state.
  const u = $('#update-url');
  if (u && window.Update) { u.value = Update.getUrl(); renderUpdateStatus(); }
}
function closeLibrary() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
}
on('#open-library', 'click', openLibrary);
on('#close-library', 'click', closeLibrary);
on('#drawer-backdrop', 'click', closeLibrary);

on('#pl-create-btn', 'click', () => {
  const input = $('#pl-name');
  const pl = createPlaylist(input.value);
  if (pl) { toast(`Created “${pl.name}”`); input.value = ''; renderLibrary(); }
  else toast('Enter a playlist name first', true);
});

/* ------------------------------ self-update ------------------------------ */

// Self-update path (public/update.js): the app can fetch a newer engine/app
// bundle from a URL the user controls and hot-swap it via reload — so a
// future YouTube breakage is fixable by pushing files, no PC/ADB needed.

// "Later" per version: once the user dismisses the banner for a given
// version, don't nag again for that same version (a newer one still shows).
const UPDATE_DISMISS_KEY = 'natsirt_update_dismissed';

function renderUpdateStatus() {
  const st = $('#update-status');
  if (!st) return;
  if (!window.Update) { st.textContent = ''; return; }
  const o = Update.status();
  const url = Update.getUrl();
  const parts = [`Built-in build ${Update.build()}`];
  if (url) parts.push(`· update URL set`);
  else parts.push('· no update URL set');
  if (o && o.newer) parts.push(`· downloaded v${o.version} will load on restart`);
  // Breakage telemetry: what the Brain has classified since the last update
  // (format×2@relay = YouTube changed the response shape, block×1 = rejected).
  // Shown here so the user (the maintainer) can see breakage without digging.
  let br = '';
  try { br = (window.Brain && Brain.breakageSummary) ? Brain.breakageSummary() : ''; } catch {}
  if (br) parts.push(`· breakage: ${br}`);
  st.textContent = parts.join(' ');
  const reset = $('#update-reset');
  if (reset) reset.hidden = !(o && o.newer);
}

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

async function checkForUpdates(manual) {
  if (!window.Update) return;
  // Manual (Library button): take the URL from the drawer input. Automatic
  // (startup): keep the stored URL — the drawer input is empty at boot, and
  // overwriting with it would wipe the configured URL on every launch.
  const input = $('#update-url');
  const url = manual ? Update.setUrl(input && input.value) : Update.getUrl();
  renderUpdateStatus();
  if (!url) {
    if (manual) toast('Enter an update URL first (Library → App updates)', true);
    return;
  }
  const btn = $('#update-check');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const r = await Update.check();
  if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  renderUpdateStatus();
  if (r.status === 'updated') {
    if (manual) {
      // Explicit tap → apply right away (the user asked for it).
      toast(`Update v${r.version} downloaded — applying…`);
      setTimeout(() => Update.apply(), 1200);
    } else {
      // Automatic check → surface the banner; let the user choose when to
      // restart (an update reloads the app mid-session).
      renderUpdateBanner();
    }
  } else if (r.status === 'current') {
    if (manual) toast(`You're on the latest (v${r.version})`);
  } else if (r.status === 'error') {
    toast(`Update check failed: ${r.error}`, true);
  } else {
    renderUpdateStatus();
  }
}

on('#update-check', 'click', () => checkForUpdates(true));
on('#update-reset', 'click', () => Update.reset());

// Auto-check shortly after launch (after the startup burst settles, so the
// ~5 file fetches never add to the cold-open spike). No longer applies
// automatically — a downloaded update shows the banner instead.
if (window.Update && Update.getUrl()) {
  setTimeout(() => checkForUpdates(false), 12000);
}

// If a previous session left a downloaded update pending, surface the banner
// immediately on launch (don't wait for the 12s auto-check).
renderUpdateBanner();
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

/* ------------------------------ pull-to-refresh ------------------------------ */

// Pulling the content down past a threshold (while already at the very top)
// refreshes the current page — Home rows, the Moods grid, or the active search.
const PTR_THRESHOLD = 72;
let ptrState = null; // { startY, pulling, dist }

function refreshCurrentView() {
  const ptr = $('#ptr');
  if (ptr) { ptr.hidden = false; $('#ptr-text').textContent = 'Refreshing…'; }
  setTimeout(() => {
    if (state.tab === 'home') loadHome();
    else if (state.tab === 'moods') loadMoodsGrid();
    else if (state.tab === 'search') {
      const q = $('#search-input').value.trim();
      if (q) runSearch(q);
    }
    setTimeout(() => { if (ptr) ptr.hidden = true; }, 900);
  }, 250);
}

(() => {
  const content = $('#content');
  if (!content) return;
  content.addEventListener('touchstart', (e) => {
    if (content.scrollTop <= 0 && e.touches.length === 1) {
      ptrState = { startY: e.touches[0].clientY, pulling: false, dist: 0 };
    } else {
      ptrState = null;
    }
  }, { passive: true });
  content.addEventListener('touchmove', (e) => {
    if (!ptrState) return;
    const dy = e.touches[0].clientY - ptrState.startY;
    if (dy > 0 && content.scrollTop <= 0) {
      ptrState.pulling = true;
      ptrState.dist = Math.min(120, dy * 0.55); // damped
      const ptr = $('#ptr');
      if (ptr) {
        ptr.hidden = false;
        $('#ptr-text').textContent = ptrState.dist >= PTR_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
      }
      content.style.transform = `translateY(${ptrState.dist}px)`;
      if (e.cancelable) e.preventDefault(); // stop rubber-band scroll
    }
  }, { passive: false });
  const endPull = () => {
    if (!ptrState || !ptrState.pulling) { ptrState = null; return; }
    const trigger = ptrState.dist >= PTR_THRESHOLD;
    content.style.transform = '';
    const ptr = $('#ptr');
    if (trigger) {
      refreshCurrentView();
    } else if (ptr) {
      ptr.hidden = true;
    }
    ptrState = null;
  };
  content.addEventListener('touchend', endPull);
  content.addEventListener('touchcancel', endPull);
})();

/* ------------------------------ service worker (PWA) ------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is a nice-to-have */ });
  });
}

/* ------------------------------ init ------------------------------ */

(async function init() {
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
  // Remember the previous session: playing track, queue, volume, tab, scroll.
  const s = readSession();
  const restored = s ? restorePlayer(s) : false;
  if (s && s.tab === 'search' && s.query) {
    $('#search-input').value = s.query;
    switchTab('search');
    runSearch(s.query); // re-run the saved search
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
