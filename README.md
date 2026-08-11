# Natsirt — music player

Standalone music player that streams from the web. No account, no server, no tracking.
Each phone talks directly to the streaming service from its own connection, so there is
no shared relay to block.

## What's in this repo

| File | Purpose |
|---|---|
| `Natsirt-v58.apk` | The installable app (~1 MB) |
| `index.html` | One-page install note served as the site's home page |
| `update.json` + `engine.js` `brain.js` `app.js` `style.css` | Self-update bundle: the app checks this manifest and hot-swaps newer code without a reinstall |

## Hosting (one time, ~5 minutes)

1. Create a new GitHub repository (the live one for this app is `natsirt-app` — keep it neutral).
2. Upload the contents of this folder (the `gh-pages/` output) to the repo's `main` branch.
3. In the repo: **Settings → Pages → Source: Deploy from a branch → branch: `main` / root → Save**.
4. Wait ~1 minute; the site is live at `https://<username>.github.io/natsirt-app/`.
5. In `public/update.js` of the app source, set `DEFAULT_URL` to
   `https://<username>.github.io/natsirt-app/update.json` and rebuild — then fresh
   installs self-update with zero configuration.

## Publishing a future release

```bash
node scripts/bump-version.mjs && npm run sync          # bump + sync assets
cd android && ./gradlew assembleRelease                # build the APK
cd .. && node scripts/publish-gh-pages.mjs             # rebuild this folder
```

Then replace the repo's files with the new `gh-pages/` contents. Installed apps
pick up the new build automatically through `update.json`.

## If the site is ever taken down

Nothing uninstalls from anyone's phone. Re-host this folder on any static host
(Cloudflare Pages, Netlify, a bucket) and the only thing to repoint is the update
URL inside the app. Keep a copy of this folder somewhere safe.
