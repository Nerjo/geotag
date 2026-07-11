# Provider configuration

GeoTag defaults to **Local coordinates**. Online mode is an explicit,
session-only opt-in and reads its provider definitions from `app/config.js`.
Supply deployment values before `npm run build` so the generated shell revision
and CSP review cover the exact configuration being shipped.

## Production requirements

1. Prefer approved internal tile and reverse-geocoding services.
2. Record the provider label, exact transmitted fields, attribution, maximum
   zoom, and whether its terms permit Cache Storage/offline use.
3. Keep `allowOfflineCache: false` unless the provider contract explicitly
   permits offline storage. GeoTag's service worker does not cache third-party
   tiles by default.
4. Use a centrally rate-limited address endpoint. The public Nominatim endpoint
   is intentionally not built into the client because its one-request-per-second
   limit applies across the whole application.
5. Add every configured origin to `_headers` under both `img-src` (tiles) and
   `connect-src` (geocoding), then test the deployed CSP.
6. Preserve visible attribution in the interactive map and report image.

The checked-in OpenStreetMap Standard configuration uses the canonical
`https://tile.openstreetmap.org/{z}/{x}/{y}.png` endpoint for user-driven
interactive views, sends a normal browser referrer, and relies only on the
browser's provider-controlled HTTP cache.
