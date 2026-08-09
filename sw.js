// Offline support for airport wifi. Three strategies, by request type:
//   navigations   -> network-first, cache fallback (deploys land fast, offline still opens)
//   schedule data -> network-first, cache fallback (fresh when possible, usable when not)
//   everything else (icons, the Tailwind CDN bundle) -> cache-first
// Bump CACHE to invalidate everything on the next deploy.
const CACHE = 'transit-v3';
const SHELL = ['/', '/index.html', '/manifest.json', '/apple-touch-icon.png'];
const DATA_PATH = '/gtfs_data.json';

self.addEventListener('install', (e) => {
  // addAll fails the whole install if any single entry 404s, so add individually.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app cache-busts with ?t=<now>; strip it so every fetch doesn't miss.
function dataKey() {
  return new Request(DATA_PATH);
}

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque (cross-origin, no-cors) responses are still worth storing — that is
  // how the Tailwind bundle survives going offline.
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(
      networkFirst(req, new Request('/index.html'))
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname === DATA_PATH) {
    e.respondWith(networkFirst(req, dataKey()));
    return;
  }

  e.respondWith(cacheFirst(req).catch(() => caches.match(req)));
});
