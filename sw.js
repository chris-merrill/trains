// Offline support for airport wifi. Three strategies, by request type:
//   navigations   -> network-first with a short timeout, cache fallback
//   schedule data -> network-first with timeout, cache fallback
//   static assets -> cache-first
// Bump CACHE to invalidate everything on the next deploy.
const CACHE = 'transit-v12';
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/fonts/barlow-condensed-500.woff2', '/fonts/barlow-condensed-600.woff2',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];
const DATA_PATH = '/gtfs_data.json';
// Captive portals and airport wifi can hold a connection open for ages.
// Past this, a cached copy beats a spinner.
const NAV_TIMEOUT_MS = 3500;

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

// The app may cache-bust with ?t=<now>; strip it so every fetch hits one entry.
function dataKey() {
  return new Request(DATA_PATH);
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(req).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

async function networkFirst(req, key, timeoutMs) {
  const cache = await caches.open(CACHE);
  try {
    const res = timeoutMs ? await fetchWithTimeout(req, timeoutMs) : await fetch(req);
    if (res && res.ok) {
      cache.put(key || req, res.clone());
      return res;
    }
    // Server errors and captive-portal junk: prefer a known-good cached copy.
    const hit = await cache.match(key || req) || await caches.match(key || req);
    return hit || res;
  } catch (err) {
    const hit = await cache.match(key || req) || await caches.match(key || req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req) || await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(
      networkFirst(req, new Request('/index.html'), NAV_TIMEOUT_MS)
        .catch(() => caches.match('/index.html'))
        .then(r => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname === DATA_PATH) {
    e.respondWith(
      networkFirst(req, dataKey(), NAV_TIMEOUT_MS * 2)
        .catch(() => caches.match(dataKey()))
        .then(r => r || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  e.respondWith(
    cacheFirst(req)
      .catch(() => caches.match(req))
      .then(r => r || new Response('', { status: 504 }))
  );
});
