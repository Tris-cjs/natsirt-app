# natsirt-app

Private Android application project. Keep this repo's description neutral.

## Repository contents

| File | Purpose |
|---|---|
| `Natsirt-v69.apk` | Release build |
| `index.html` | Minimal site page |
| `update.json` + `engine.js` `brain.js` `app.js` `style.css` | Self-update bundle (installed apps replace their web assets from this) |

## Hosting

1. Create a new GitHub repository (`natsirt-app`).
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

Re-host this folder on any static host and repoint the update URL inside the app.
Keep a copy of this folder somewhere safe.
