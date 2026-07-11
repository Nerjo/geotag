# GeoTag design and architecture

**Release baseline:** v0.2 Trust

**Last updated:** 11 July 2026

**Runtime:** static HTML, CSS and JavaScript PWA

## 1. Product purpose

GeoTag turns a field photo and a location into a durable handoff record for the
person who must find that place later. The product optimizes for truthful
provenance, privacy, report reliability, offline app-shell availability, and a
short field workflow. A backend and a broad account system are intentionally
out of scope.

The recipient receives both a visual report and machine-readable data. A record
is still useful without online maps: the local report panel, coordinates, and
navigation link remain available.

## 2. Privacy modes

| Mode | Default | Network behavior | Report map |
|---|---:|---|---|
| Local coordinates | Yes | No automatic map or geocoder request | Local coordinate panel |
| Online map and address | No; session-only consent | Requests only to disclosed, configured providers | Provider map with attribution |

The online consent dialog names the provider, endpoint, and transmitted data.
Switching back to local mode cancels queued geocoding, removes Leaflet maps, and
stops further provider work. Removing a card cancels its processing/geocoding
signals and revokes its object URLs. **Clear all** removes cards, queued work,
the most recent generated report reference, and staged share-target data.

GeoTag never copies third-party tiles into Cache Storage. A browser may retain
responses in its ordinary HTTP cache according to provider headers. The UI
states that this browser-managed data must be removed through browser site-data
controls. **Clear offline map data** removes only GeoTag-owned legacy map caches.

## 3. Network egress

The checked-in configuration has this egress surface:

| Destination | Trigger | Data | Retention in GeoTag Cache Storage |
|---|---|---|---:|
| `tile.openstreetmap.org` | User confirms online mode and a located card becomes visible | Tile coordinates, IP address, origin referrer | None |
| Reverse geocoder | Disabled until deployment configures one | Exact latitude/longitude and standard request metadata | None |
| Navigation sites | User activates a map link | Exact latitude/longitude | None |

Deployments should replace public services with approved internal services when
policy or scale requires it. Reverse geocoding must be centrally rate-limited;
a per-browser queue is not a substitute for an application-wide limit. Provider
configuration lives in `app/config.js`, while allowed origins live in `_headers`.
Both files require review together.

## 4. Data lifecycle

1. The file enters from a picker, camera capture, drag/drop, or PWA share target.
2. A two-item queue converts HEIC only when needed, creates a bounded preview,
   validates pixel limits, and reads EXIF from the untouched source file.
3. Photo and derived image data live in browser memory through Blob/object URLs.
4. Location comes from EXIF, manual decimal coordinates, or an explicit browser
   geolocation request.
5. Maps are created lazily near the viewport and only in online mode.
6. Report/structured exports are generated locally and handed to browser
   download, clipboard, or Web Share APIs.
7. Removing or clearing records aborts work and releases local references.

Share-target photos are temporarily staged in the GeoTag-owned
`geotag-share-v1` Cache Storage cache because a service worker must bridge the
POST share into the app. The item is deleted immediately after import and is
also cleared by **Clear all**; unclaimed entries expire after 15 minutes.

## 5. Location provenance

Every record uses a non-coordinate ID of the form
`GT-YYYYMMDD-####-RANDOM`. The filename is based on that ID, never on exact
coordinates.

The record preserves:

- source filename and generic record ID;
- capture timestamp plus recorded timezone offset, or an explicit
  “not recorded” state;
- original and current coordinates;
- location source (EXIF, manual entry, or current device location);
- horizontal uncertainty when available and conservative coordinate display
  precision when it is not;
- displacement distance and a required adjustment reason;
- caption without silent line truncation;
- provider, app version, build revision, and recipient navigation URL.

Keyboard coordinate fields provide the equivalent of dragging the online pin.
Reset restores the source location and clears the adjustment state.

## 6. Report reliability and provider compliance

Report generation creates a dedicated off-screen Leaflet map. It listens for
tile `load`, `tileload`, and `tileerror` events and applies a bounded timeout.
A map is complete only when the layer finishes, at least one tile loaded, no
tile failed, and the timeout did not fire.

The report always draws configured provider attribution into the map panel,
including the error fallback. Incomplete output receives a visible warning in
the PNG and a live warning in the creator interface. The public OpenStreetMap
configuration uses the canonical HTTPS tile endpoint, visible attribution, a
normal browser referrer, and provider-controlled HTTP caching. Offline tile
download or prefetch is prohibited by design.

Local reports replace the map with a coordinate panel and explicitly state that
no map or address request was sent.

## 7. Recipient journey and export formats

A single report can be copied, downloaded, or shared with companion text that
contains the record ID, coordinates, uncertainty, and a `geo:` or configured
internal URL. The same URL is printed and encoded as a locally generated QR code
in the report; no QR service receives the location.

Batch output includes:

- PNG report bundle in ZIP, with CSV, JSON, and GeoJSON records;
- combined PDF;
- Word document, with or without captions;
- standalone CSV, JSON, or GeoJSON.

All output is generated in the browser. No export service receives a photo or
coordinate.

## 8. Accessibility and mobile behavior

The report, privacy consent, and editor are native `<dialog>` elements. Native
modal behavior provides focus containment; explicit code restores focus to the
trigger. Inputs have labels, statuses are live regions, and errors use alert
semantics. All interactive controls have visible `:focus-visible` rings and
44-pixel minimum targets. Coordinate correction is keyboard operable.

Color tokens pass the 4.5:1 normal-text contrast gate checked by
`scripts/check-static.mjs`. Reduced-motion preferences disable decorative
transition and scrolling motion. Desktop and Pixel-sized Chromium projects run
the critical privacy/handoff workflow.

## 9. Application structure

```text
index.html             semantic shell; no inline script or style blocks
app/config.js          deploy-time limits and provider definitions
app/runtime.js         task queue, coordinate, ZIP/PDF and structured exports
app/editor.js          crop, perspective and markup editor
app/main.js            record, map, privacy, intake and report orchestration
app/register-sw.js     update discovery, prompt and explicit activation
app/styles.css         layout, contrast, focus and responsive behavior
sw.js                  shell recovery, share target and owned-cache lifecycle
sw-assets.js           generated build ID and precache asset list
```

Libraries and fonts remain vendored so the app shell can open offline without a
CDN. HEIC support is loaded on demand. `script-src 'self'` is enforced through
the checked-in host headers; Leaflet still requires its documented inline style
allowance.

## 10. Service-worker update protocol

`npm run build` hashes application assets plus `sw.js`, writes the build ID, and
generates the shell asset list, then creates an allowlisted `dist/site` static
artifact. Each build installs into
`geotag-shell-<build-id>`. The waiting worker does not call `skipWaiting`
automatically.

The currently active worker serves its own cached `index.html` and assets as one
consistent shell. When a new worker finishes installing, the app displays an
update prompt. The user chooses reload, the waiting worker activates, the page
reloads, and the new cache becomes authoritative. Activation deletes only old
GeoTag shell and legacy map caches; unrelated origin caches are untouched.

## 11. Repository and release controls

- `npm run ci` runs static trust assertions, manifest freshness, unit tests, and
  desktop/mobile Playwright tests.
- GitHub Actions gates pull requests and `main`; tagged builds repeat the gate
  and publish the SPDX SBOM.
- `_headers` supplies CSP, permissions, referrer, framing, MIME and cache rules
  for the checked-in Cloudflare Workers Static Assets deployment.
- `SECURITY.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
  `sbom.spdx.json` define security and dependency provenance.
- `docs/RELEASE_CHECKLIST.md` requires an installed-app upgrade test and
  deployment verification.

Repository administrators must still enable the checked-in CI workflow as a
required status check on protected `main`, require review, and block force push
and deletion. That server-side rule cannot be represented by files alone.

## 12. Planned boundary

The v0.2 baseline implements Trust, Handoff, and initial Scale controls without
adding a backend. The remaining deployment-specific decision is selection and
operation of approved internal map/geocoding services. Accessibility
certification and provider-contract review remain release activities, not claims
made by the code alone.
