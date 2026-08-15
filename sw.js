/* OrBeat Mobile — service worker
 *
 * - App shell (HTML/CSS/JS/fonts/icons) is precached → the UI opens offline.
 * - Album art (i.ytimg.com) is cached stale-while-revalidate → fast + offline-ish.
 * - YouTube API calls and googlevideo audio are NEVER cached (stream URLs
 *   expire and are huge).
 */
'use strict';

const CACHE = 'orbeat-mobile-v59'; // v22: OrBeat logo rebrand (orange palette) — bump CACHE whenever a shell asset like logo.png changes, since it has no ?v= cache-buster
const SHELL = [
  './',
  './index.html',
  './style.css?v=262',
  './app.js?v=262',
  './engine.js?v=262',
  './manifest.json',
  './logo.png',
  './fonts/SpotifyMix-Regular.woff2',
  './fonts/SpotifyMix-Bold.woff2',
  './fonts/SpotifyMix-Extrabold.woff2',
  './fonts/Inter-Variable.woff2',
  './fonts/Montserrat-Variable.woff2',
  './fonts/Sora-Variable.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}) // some shell file may be missing in dev — never break install
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never touch streaming/API traffic.
  if (url.hostname.includes('googlevideo.com')) return;
  if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be')) return;
  if (req.method !== 'GET') return;

  // Album art: stale-while-revalidate.
  if (url.hostname === 'i.ytimg.com') {
    e.respondWith(
      caches.open('orbeat-images').then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Same-origin navigation: network-first, offline shell fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin static assets: cache-first with background refresh.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
