# Security policy

## Supported versions

Security fixes are applied to the latest tagged `0.2.x` release and to `main`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or privacy leak. Use
GitHub's private vulnerability-reporting flow under **Security → Advisories →
New draft security advisory**:

https://github.com/Nerjo/geotag/security/advisories/new

Include reproduction steps, affected browser/device, the build identifier shown
in the GeoTag header, and whether any coordinates or photo data left the device.
The maintainer should acknowledge a report within five business days.

## Security boundaries

- Directly selected photos and EXIF stay in browser memory. PWA share-target
  photos are staged in a GeoTag-owned cache for at most 15 minutes, deleted on
  import, and cleared by **Clear all**.
- Local coordinates mode is the default and makes no automatic map/geocoder
  request. Explicit navigation/share actions can transmit coordinates to the
  user-selected destination.
- Online providers are configured in `app/config.js` and require explicit,
  session-only consent.
- Provider endpoints and `_headers` CSP allowlists must be reviewed together.
- Public OpenStreetMap tiles are never copied into Cache Storage.
