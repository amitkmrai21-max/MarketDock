const CACHE_NAME = "marketdock-shell-v2";
const APP_SHELL = [
  "/frontend/index.html",
  "/frontend/style.css",
  "/frontend/app.js",
  "/frontend/image-1.png",
  "/frontend/icon-192.png",
  "/frontend/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// Stale-while-revalidate, and only for the static app shell above. Live
// market data, AI endpoints, and anything cross-origin fall straight
// through to the network untouched (we never want a cached price/technical
// response) — the fetch handler simply returns early for those.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isAppShellAsset = url.origin === self.location.origin && APP_SHELL.includes(url.pathname);
  if (!isAppShellAsset) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
