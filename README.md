# GeoTag · Field Inspection Mapper

A standalone, installable app (PWA) that reads a geotagged photo's GPS data
**entirely on your device**, plots the location on a map, looks up the address,
and exports a side-by-side **photo + map report image** for inspection reports.

- 📍 Drop a JPG / PNG / HEIC photo → see latitude/longitude (decimal & DMS),
  altitude, heading, capture time, and camera.
- 🗺️ Interactive Leaflet map with Street / Satellite / Topo styles.
- 🧾 One-click "Build report image" — composited photo + map with a coordinate
  caption, ready to copy, download, or share.
- 🔒 **100% local.** Photos are read in the browser and never uploaded.
  Only map tiles and the optional address lookup touch the network.
- 📴 **Works offline.** All libraries and fonts are vendored and precached by a
  service worker, so the app opens with no connection. Map tiles for previously
  viewed areas are cached too.

## Install it as an app

It's a Progressive Web App, so it installs from the browser — no app store.

- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu → *Install app* / *Add to Home Screen*.
- **Desktop (Chrome / Edge):** click the install icon in the address bar, or
  menu → *Install GeoTag…*.

Once installed it launches in its own window like a native app.

## Run locally

A PWA needs to be served over HTTP (service workers don't run from `file://`).
From the repo root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static file host works for deployment (GitHub Pages, Netlify, etc.) — just
serve the repo root over HTTPS.

## Project layout

```
index.html              App shell + all logic
manifest.webmanifest    PWA metadata (name, icons, theme)
sw.js                   Service worker (offline shell + tile cache)
vendor/                 Vendored, offline-capable libraries & fonts
  leaflet/  exifr/  html2canvas/  heic2any/  fonts/
icons/                  App icons (192 / 512 / maskable / apple-touch / favicon)
```

## Updating

Bump `CACHE_VERSION` in `sw.js` whenever any precached asset changes so clients
pick up the new version.
