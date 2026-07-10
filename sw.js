/* GeoTag service worker — offline app shell + runtime map-tile cache.
   Bump CACHE_VERSION whenever any precached asset changes. */
"use strict";

const CACHE_VERSION = "geotag-v11";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const TILE_CACHE = CACHE_VERSION + "-tiles";
const TILE_MAX = 300; // cap stored map tiles

// App shell — everything needed to open the app with no network.
const SHELL_ASSETS = [
  ".",
  "index.html",
  "manifest.webmanifest",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-shadow.png",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
  "vendor/exifr/full.umd.js",
  "vendor/html2canvas/html2canvas.min.js",
  "vendor/heic2any/heic2any.min.js",
  "vendor/docx/docx.iife.js",
  "vendor/fonts/ibm-plex.css",
  "vendor/fonts/ibm-plex-mono-400.woff2",
  "vendor/fonts/ibm-plex-mono-500.woff2",
  "vendor/fonts/ibm-plex-mono-600.woff2",
  "vendor/fonts/ibm-plex-sans-400.woff2",
  "vendor/fonts/ibm-plex-sans-500.woff2",
  "vendor/fonts/ibm-plex-sans-600.woff2",
  "vendor/fonts/ibm-plex-sans-700.woff2",
  "vendor/fonts/ibm-plex-sans-cond-600.woff2",
  "vendor/fonts/ibm-plex-sans-cond-700.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon-180.png",
  "icons/favicon.svg",
  "icons/favicon-32.png"
];

const TILE_HOSTS = [
  "tile.openstreetmap.org",
  "server.arcgisonline.com",
  "tile.opentopomap.org"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // only touch our own versioned caches — other apps on this origin
          // (or future GeoTag features) must not lose their storage
          .filter((k) => k.startsWith("geotag-") && k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isTile(url) {
  return TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

// Trim the tile cache to TILE_MAX entries (oldest first).
async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_MAX) return;
  for (let i = 0; i < keys.length - TILE_MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Map tiles: stale-while-revalidate into a capped cache so previously
  // viewed areas keep working offline. Responses are kept as-is (CORS) so
  // html2canvas export stays untainted.
  if (isTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            cache.put(req, res.clone()).then(trimTileCache).catch(() => {});
          }
          return res;
        }).catch(() => null);
        return cached || network || fetch(req);
      })
    );
    return;
  }

  // Nominatim reverse geocode and any other cross-origin GET: pass through
  // (the app already degrades gracefully when this is unavailable).
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a new index.html reaches installed users
  // even when sw.js itself didn't change (the v2→multi-photo trap). The cached
  // shell covers offline, HTTP errors (mid-deploy 404/503) and slow links — a
  // short race keeps launch snappy on 1-bar connections.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      let netRes = null;
      const network = fetch(req).then((res) => {
        netRes = res;
        if (res && res.ok) {
          const copy = res.clone();
          // one normalized key — query-string variants must not pile up copies
          caches.open(SHELL_CACHE).then((c) => c.put("index.html", copy)).catch(() => {});
          return res;
        }
        return null; // error page → prefer the cached shell
      }).catch(() => null);

      const winner = await Promise.race([
        network,
        new Promise((r) => setTimeout(() => r("timeout"), 3500))
      ]);
      if (winner && winner !== "timeout") return winner;

      // "index.html" first: it is the entry the network path keeps fresh
      const cached = (await caches.match("index.html")) || (await caches.match(req));
      if (cached) return cached;
      return (await network) || netRes || Response.error();
    })());
    return;
  }

  // Same-origin app shell (scripts, styles, fonts, icons): cache-first with a
  // network fallback; versioned by CACHE_VERSION bumps.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("index.html");
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
