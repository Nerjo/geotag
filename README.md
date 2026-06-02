# GeoTag · Offline Field Inspection Mapper

A standalone, installable app (PWA) that reads geotagged photos on-device and exports inspection report images without uploading photos, sending coordinates, loading third-party map tiles, or using address lookup.

This branch is the no-leak duplicate of the original app. It keeps the field workflow, but replaces online maps and reverse geocoding with an offline coordinate panel.

- Drop JPG / PNG / HEIC / HEIF photos and read EXIF/GPS locally in the browser.
- View decimal latitude/longitude, DMS coordinates, altitude, heading, capture time, and camera model.
- Edit coordinates manually when source GPS is inaccurate.
- Edit heading and caption before export.
- Build one local report image per photo with the photo, offline coordinate panel, coordinates, heading, caption, and adjustment note where applicable.
- Copy or download the generated PNG locally.
- Install as a PWA and open the app offline after first load.

## What this branch intentionally removed

This branch removes all features that send location data outside the browser:

- No OpenStreetMap, Esri, or OpenTopoMap tile requests.
- No Nominatim reverse-geocode requests.
- No Google Maps, Apple Maps, or OpenStreetMap outbound links.
- No Web Share button.
- No coordinate values in downloaded filenames.
- No service-worker map tile cache.

The only network traffic required is loading the site files from your own host. After the app shell is cached by the service worker, the app can open offline.

## Run locally

A PWA needs to be served over HTTP because service workers do not run from `file://`. From the repo root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Project layout

```text
index.html              App shell + offline-only app logic
manifest.webmanifest    PWA metadata
sw.js                   Service worker for offline app shell only
_headers                Netlify/browser security headers
vendor/                 Vendored offline-capable libraries and fonts
icons/                  App icons
```

## Deployment note

On Netlify, deploy this branch as a separate site or branch deploy if you want to keep the original online-map version available. Use password protection if inspection locations are sensitive.

## Updating

Bump `CACHE_VERSION` in `sw.js` whenever any precached asset changes so installed clients pick up the new version.
