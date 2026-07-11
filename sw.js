/* GeoTag service worker: content-addressed shell recovery and share target. */
"use strict";

importScripts("sw-assets.js", "app/config.js");

const CACHE_PREFIX = "geotag-shell-";
const SHELL_CACHE = CACHE_PREFIX + self.GEOTAG_BUILD_ID;
const SHARE_CACHE = "geotag-share-v1";
const SHELL_ASSETS = self.GEOTAG_SHELL_ASSETS || [];
const SHARE_RETENTION_MS = 15 * 60 * 1000;

async function purgeExpiredSharedPhotos() {
  const cache = await caches.open(SHARE_CACHE);
  const requests = await cache.keys();
  await Promise.all(requests.map(async request => {
    const response = await cache.match(request);
    const stagedAt = Number(response && response.headers.get("X-GeoTag-Staged-At"));
    if (!stagedAt || Date.now() - stagedAt > SHARE_RETENTION_MS) await cache.delete(request);
  }));
}

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(
    SHELL_ASSETS.map(asset => new Request(new URL(asset, self.registration.scope), { cache: "reload" }))
  )));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        // Delete every superseded GeoTag-owned cache while preserving the
        // current shell and short-lived share-target bridge. Never touch a
        // cache owned by another application on the same origin.
        .filter(key => key.startsWith("geotag-") && key !== SHELL_CACHE && key !== SHARE_CACHE)
        .map(key => caches.delete(key))
    )).then(() => purgeExpiredSharedPhotos()).then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (!event.data) return;
  if (event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data.type === "CLEAR_MAP_DATA") {
    event.waitUntil(caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith("geotag-") && /(tile|map)/i.test(key)).map(key => caches.delete(key))
    )));
  }
  if (event.data.type === "CLEAR_PRIVATE_DATA") {
    event.waitUntil(caches.keys().then(keys => Promise.all(
      keys.filter(key => (
        (key.startsWith("geotag-") && /(tile|map)/i.test(key)) || key === SHARE_CACHE
      )).map(key => caches.delete(key))
    )));
  }
});

async function receiveSharedPhoto(request) {
  await purgeExpiredSharedPhotos();
  const form = await request.formData();
  const file = form.get("photos");
  if (!(file instanceof File)) return Response.redirect(new URL("./?share-error=missing", self.registration.scope), 303);
  const token = self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : Date.now().toString(36);
  const url = new URL("shared/" + token, self.registration.scope);
  const headers = new Headers({
    "Content-Type": file.type || "application/octet-stream",
    "X-GeoTag-Filename": encodeURIComponent(file.name || "shared-photo.jpg"),
    "X-GeoTag-Staged-At": String(Date.now()),
    "Cache-Control": "no-store"
  });
  const cache = await caches.open(SHARE_CACHE);
  await cache.put(url, new Response(file, { headers }));
  return Response.redirect(new URL("./?share-target=" + encodeURIComponent(token), self.registration.scope), 303);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  if (request.method === "POST" && url.origin === self.location.origin && /\/share-target\/?$/.test(url.pathname)) {
    event.respondWith(receiveSharedPhoto(request));
    return;
  }
  if (request.method !== "GET") return;

  // Third-party map/geocoder traffic is never copied into Cache Storage.
  // The browser remains free to honour provider HTTP cache headers normally.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes("/shared/")) {
    event.respondWith(caches.open(SHARE_CACHE).then(cache => cache.match(request)).then(response => response || new Response("", { status: 404 })));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      // Keep one internally consistent shell while a newer worker waits for
      // the user's explicit reload. The new worker owns a different cache.
      const cache = await caches.open(SHELL_CACHE);
      const indexUrl = new URL("index.html", self.registration.scope);
      const cached = await cache.match(indexUrl);
      if (cached) return cached;
      const response = await fetch(request);
      if (response && response.ok) await cache.put(indexUrl, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith(caches.open(SHELL_CACHE).then(cache => cache.match(request).then(cached => cached || fetch(request).then(response => {
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }))));
});
