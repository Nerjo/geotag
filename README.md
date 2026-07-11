# GeoTag · Field Handoff

GeoTag is an installable static web app that turns field photos into
recipient-ready location records. It reads photos and EXIF in the browser,
supports manual or device-supplied locations, and exports attributed report
images plus structured handoff data.

## Trust model

**Local coordinates is the default.** In that mode, photos, EXIF, captions,
and coordinates stay in browser memory. GeoTag makes no automatic map or
address request; explicitly opening or sharing a location link can transmit the
coordinates to the chosen destination.

**Online map and address is a session-only opt-in.** Before enabling it, GeoTag
names each configured provider and explains what leaves the device. The checked-
in build enables user-driven OpenStreetMap Standard tiles and deliberately
disables reverse geocoding until a deployment supplies an approved, centrally
rate-limited service. Public tiles are not copied into Cache Storage.

Removing a record or choosing **Clear all** cancels its queued work and releases
generated output. **Clear offline map data** removes GeoTag-owned legacy map
caches; provider-controlled browser HTTP-cache entries follow their response
headers and browser site-data controls.

## Field workflow

- Choose existing photos, take a new photo, drag files in, or share a photo to
  the installed PWA.
- Process at most two images concurrently, with file/count/pixel limits,
  bounded previews, lazy HEIC conversion, lazy maps, cancellation, and progress.
- Use EXIF GPS, paste coordinates, or explicitly request current device
  location when a photo has no GPS.
- Correct coordinates by keyboard or draggable pin, record a reason, compare
  original and adjusted values, and reset to the source location.
- Build PNG reports containing a generic record ID, source file, capture time
  and timezone status, accuracy, displacement, provider, app/build version,
  navigation URL, scannable QR code, and complete caption text.
- Share the image together with plain coordinates and a `geo:` or configured
  internal navigation link.
- Export all reports as ZIP, PDF, or Word, and records as CSV, JSON, or GeoJSON.

Online report maps wait for Leaflet tile completion/error events, visibly mark
incomplete output, and print provider attribution into the PNG.

## Run locally

Node.js 22 or newer is required for the development checks.

```bash
npm ci
npm run build
npx playwright install chromium
npm run ci
```

For manual use, serve the repository root over HTTP or HTTPS. The Playwright
suite includes its own static test server. Service workers do not run from
`file://` URLs.

## Deploy

The application remains static. Configure providers in `app/config.js`, update
the CSP allowlist in `_headers`, and follow
[`docs/PROVIDER_CONFIGURATION.md`](docs/PROVIDER_CONFIGURATION.md). The public
Nominatim service is not a production default.

`npm run build` generates `sw-assets.js` from content hashes and copies only
deployable assets into `dist/site`. A new worker
installs into a content-addressed cache and waits; installed users see an update
prompt and explicitly reload into one internally consistent shell. Activation
deletes only GeoTag-prefixed superseded caches.

See the [design and architecture](docs/DESIGN_AND_ARCHITECTURE.md) and
[release checklist](docs/RELEASE_CHECKLIST.md). The checked-in hosting headers,
CI, tagged-release workflow, dependency notices, and SPDX SBOM form the release
baseline.

## Layout

```text
index.html                  semantic app shell and dialogs
app/config.js               deploy-time privacy/provider configuration
app/runtime.js              queues, coordinate and export primitives
app/editor.js               photo editor module
app/main.js                 intake, records, maps, reports and UI orchestration
app/register-sw.js          update-available/reload flow
app/styles.css              responsive and accessible presentation
sw.js / sw-assets.js        service worker and generated shell revision
tests/                      unit, desktop and mobile browser tests + fixture
scripts/                    manifest, static-trust and SBOM generators
_headers                    production CSP, privacy and cache headers
dist/site/                  generated static deployment artifact (ignored)
```

Security reports should follow [SECURITY.md](SECURITY.md). The project is
currently proprietary; third-party components retain their upstream licenses as
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
