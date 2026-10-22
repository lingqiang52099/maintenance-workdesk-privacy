const CACHE_NAME = 'maintenance-workbench-pwa-1.5.5';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=1.5.5',
  './ui-interactions.js?v=1.5.5',
  './app.bundle.js?v=1.5.5',
  './manifest.json',
  './icon-1024.png',
  './industrial-bg.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('maintenance-workbench-pwa-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && request.url.includes(self.location.pathname.replace('service-worker.js', ''))) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
