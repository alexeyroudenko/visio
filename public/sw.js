/**
 * visio service worker — offline shell + runtime caching.
 *
 * Plain JS in `public/` so it ships to the dist root and gets the widest
 * possible scope ("/"). Chrome only fires `beforeinstallprompt` for a worker
 * with a real (non-empty) fetch handler, so the caching below is both the
 * offline story and the price of admission for the install prompt.
 */

const SHELL_CACHE = "visio-shell-v1";
const ASSET_CACHE = "visio-assets-v1";
const KNOWN_CACHES = [SHELL_CACHE, ASSET_CACHE];

/** Hashed Vite output is immutable, so it never needs revalidating. */
const IMMUTABLE_PATH = /\/assets\/[^/]+\.[0-9a-z]{8,}\./i;

/** Media is streamed with Range requests the Cache API can't serve. */
const MEDIA_PATH = /\.(mp3|mp4|webm|wav|ogg|m4a|mov)$/i;

/** Old builds leave orphaned hashed files behind; keep the cache bounded. */
const ASSET_CACHE_LIMIT = 120;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["./", "./manifest.json"]))
      // A cold cache must never block activation — the fetch handler falls
      // back to the network anyway.
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !KNOWN_CACHES.includes(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has("range") || MEDIA_PATH.test(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationFirst(request));
    return;
  }

  if (IMMUTABLE_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

/** HTML must follow deploys, so the network wins whenever it answers. */
async function navigationFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put("./", response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) ?? (await cache.match("./"));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(cache, ASSET_CACHE_LIMIT);
  }
  return response;
}

/** Unhashed public files (fonts, presets, stills) — instant, but self-healing. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        await trimCache(cache, ASSET_CACHE_LIMIT);
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  return Response.error();
}

/** Cache keys keep insertion order, so the oldest entries drop out first. */
async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
