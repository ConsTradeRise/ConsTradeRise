// ConsTradeHire Service Worker — Phase 10 PWA
const CACHE_NAME = 'constradehire-v1';
const STATIC_ASSETS = [
  '/',
  '/jobs.html',
  '/login.html',
  '/register.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
];

// Install: cache static shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - API calls → network-first (no cache)
// - Static assets → cache-first with network fallback
// - Pages → network-first with cache fallback (offline support)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and cross-origin
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // API — always network, no cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Static assets (CSS, JS, images) — cache first
  if (url.pathname.match(/\.(css|js|png|jpg|jpeg|svg|ico|woff2?)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // HTML pages — network first, fall back to cache, then offline page
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/')))
  );
});
