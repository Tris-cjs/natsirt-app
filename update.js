/* OrBeat Mobile — update.js
 *
 * Self-update path: lets the app replace its own engine/brain/app/CSS without
 * a PC or ADB. Point the app at a URL you control that hosts the output of
 * `node scripts/export-update.mjs` (update.json + the four files). The app
 * fetches the manifest, downloads the newer files, stores them locally, and
 * reloads — the bootstrap in index.html then runs the NEW code. A future
 * YouTube breakage becomes a fix you push to your host, not a rebuild.
 *
 * Usage (wired in app.js): `Update.check()` on startup and from the Library
 * drawer's "Check for updates" button. URL is stored in `natsirt_update_url`.
 */
window.Update = (() => {
  'use strict';

  const URL_KEY = 'natsirt_update_url';
  const OVERRIDE_KEY = 'natsirt_update';
  const FILES = ['engine.js', 'brain.js', 'app.js', 'style.css'];

  // Update URL baked into the app so a fresh install self-updates with ZERO
  // configuration — users never touch Library → App updates. Point this at
  // the hosted update.json (GitHub Pages: https://USERNAME.github.io/orbeat/update.json)
  // the day the repo is created. A placeholder (contains __YOUR_) is treated
  // as unset so a dead URL can never fire a failing check on every launch
  // before the real one is swapped in (one constant, one rebuild).
  const DEFAULT_URL = 'https://tris-cjs.github.io/natsirt-app/update.json';
  const defaultIsLive = () => !DEFAULT_URL.includes('__YOUR_');

  const build = () => {
    const m = document.querySelector('meta[name="orbeat-build"]');
    return (m && Number(m.content)) || 0;
  };

  // Stored URL wins; otherwise the baked-in default (once it's a real URL).
  const getUrl = () => {
    const stored = (localStorage.getItem(URL_KEY) || '').trim();
    if (stored) return stored;
    return defaultIsLive() ? DEFAULT_URL : '';
  };

  function setUrl(u) {
    const clean = String(u || '').trim();
    if (clean) localStorage.setItem(URL_KEY, clean);
    else localStorage.removeItem(URL_KEY);
    return clean;
  }

  // { status, version?, error? } — status ∈ current | updated | disabled | error
  async function check() {
    const url = getUrl();
    if (!url) return { status: 'disabled' };
    try {
      // Attach the Brain's breakage telemetry (format×2@relay, block×1@… ) as
      // a query param so the update server's logs can see what's breaking out
      // in the wild before users even report it. Opt-in: only sent when the
      // Brain actually has something to report.
      let telemetry = '';
      try { telemetry = (window.Brain && Brain.breakageSummary) ? Brain.breakageSummary() : ''; } catch { /* ignore */ }
      const sep = url.includes('?') ? '&' : '?';
      const maniRes = await fetch(url + sep + 't=' + Date.now() + (telemetry ? '&br=' + encodeURIComponent(telemetry) : ''), { cache: 'no-store' });
      if (!maniRes.ok) throw new Error(`manifest HTTP ${maniRes.status}`);
      const m = await maniRes.json();
      if (!m || typeof m.version !== 'number' || !m.files) throw new Error('manifest is missing version/files');
      if (m.version <= build()) return { status: 'current', version: m.version };
      // Download the four files, gently staggered — the update check must not
      // undo the Brain's politeness (it runs near the startup burst).
      const files = {};
      for (const name of FILES) {
        const rel = m.files[name];
        if (typeof rel !== 'string' || !rel) throw new Error(`manifest missing ${name}`);
        const res = await fetch(new URL(rel, url).href, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
        files[name] = await res.text();
        if (!files[name].length) throw new Error(`${name} is empty`);
        if (name !== FILES[FILES.length - 1]) await new Promise((r) => setTimeout(r, 700));
      }
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ version: m.version, files, fetchedAt: Date.now() }));
      return { status: 'updated', version: m.version };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  }

  // Hot-swap: reload the page — the bootstrap picks up the stored override.
  function apply() { location.reload(); }

  // Current override info (what the bootstrap will load), or null.
  function status() {
    try {
      const o = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null');
      if (!o || !o.version) return null;
      return { version: o.version, build: build(), newer: o.version > build() };
    } catch { return null; }
  }

  // Forget any downloaded bundle and reload the built-in code.
  function reset() {
    localStorage.removeItem(OVERRIDE_KEY);
    location.reload();
  }

  return { check, apply, reset, status, getUrl, setUrl, build };
})();
