# Third-party notices

GeoTag runs without CDN dependencies. The following assets are checked into
`vendor/`; their exact SHA-256 checksums are recorded in `sbom.spdx.json`.
Development-only npm packages, resolved tarballs, licenses, package URLs, and
SHA-512 integrity values are also included from `package-lock.json`.

| Component | Version | Upstream | License |
|---|---:|---|---|
| Leaflet | 1.9.4 | https://github.com/Leaflet/Leaflet | BSD-2-Clause |
| exifr | vendored UMD build | https://github.com/MikeKovarik/exifr | MIT |
| html2canvas | 1.4.1 | https://github.com/niklasvh/html2canvas | MIT |
| heic-to (libheif) | 1.5.2 (CSP build) | https://github.com/hoppergee/heic-to | LGPL-3.0 |
| docx | vendored IIFE build | https://github.com/dolanmiu/docx | MIT |
| qrcode-generator | 2.0.4 | https://github.com/kazuhikoarase/qrcode-generator | MIT |
| IBM Plex fonts | vendored WOFF2 files | https://github.com/IBM/plex | OFL-1.1 |

When replacing a vendored file, review the upstream release and license, update
this table and `scripts/generate-sbom.mjs`, run `npm run sbom`, regenerate the
service-worker manifest, and complete the release checks.
