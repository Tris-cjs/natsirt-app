# OrBeat PWA — installable everywhere

This folder is the full OrBeat web app (build 267). Host it on any
HTTPS static host and it installs on every device with no store and no Mac:

| Device | How to install |
|---|---|
| iPhone / iPad | Safari → open the URL → **Share** → **Add to Home Screen** → **Add** |
| Android | Chrome → open the URL → **Install app** / menu ⋮ → **Add to Home screen** |
| Windows / Mac / Chromebook | Chrome or Edge → install icon in the address bar |

OrBeat is a PWA: the home-screen icon opens it fullscreen, offline-capable,
with the exact same UI as the Android APK.

## Hosting (pick one)

**GitHub Pages** — create a repo, upload these files to `main`, then
Settings → Pages → Source: Deploy from a branch → `main` / root. The site
lives at `https://<username>.github.io/<repo>/`. The app's relative paths
work at any repo path, so a regular repo site is fine.

**Cloudflare Pages / Netlify / Vercel** — drag this folder in, or point the
project at this directory. Free tiers are plenty.

## Notes

- **HTTPS is required** for installs: iOS and Chrome refuse to register the
  service worker over plain HTTP (a LAN IP like `http://192.168.x.x` will
  open the app but never install).
- Audio resolution on iOS/browser uses the engine's public fallbacks
  (Piped instances, direct YouTube). The Android APK's on-device relay
  (`127.0.0.1:8787`) only exists in the APK; in the browser the engine
  falls back automatically.
- `update.json` + `engine.js` etc. let installed apps self-update. Point
  `public/update.js → DEFAULT_URL` at this folder's `update.json` URL and
  rebuild so fresh installs stay current.
- Re-publish after every release:

  ```bash
  node scripts/bump-version.mjs && npm run sync
  cd android && ./gradlew assembleRelease        # optional (APK)
  cd .. && node scripts/publish-pwa.mjs
  ```

  Then upload the new `pwa-out/` contents to your host.
