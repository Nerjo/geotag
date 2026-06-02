/* GeoTag Offline service worker — offline app shell only.
   This build does not cache third-party map tiles and blocks cross-origin fetches. */
"use strict";

const CACHE_VERSION = "geotag-offline-v1";
const SHELL_CACHE = CACHE_VERSION + "-shell";

const SHELL_ASSETS = [
  ".",
  "index.html",
  "manifest.webmanifest",
  "vendor/exifr/full.umd.js",
  "vendor/heic2any/heic2any.min.js",
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("geotag-") && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (url.origin !== self.location.origin) {
    event.respondWith(new Response("External network requests are blocked in this offline-only build.", {
      status: 403,
      statusText: "Forbidden",
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    }));
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("index.html");
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
