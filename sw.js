// PlayWithTV service worker: makes the app installable and keeps the shell
// and last channel list available when the network is flaky.
const VERSION = 'pwtv-v2';
const SHELL = [
  '/',
  '/assets/app.css',
  '/assets/app.js',
  '/manifest.webmanifest',
  '/icons/logo.png',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never touch video streams or third-party requests
  if (url.origin !== location.origin) return;

  // App pages and the channel list: network first, cached copy as fallback
  if (req.mode === 'navigate' || url.pathname === '/api/playlist') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req.mode === 'navigate' ? '/' : req)),
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
