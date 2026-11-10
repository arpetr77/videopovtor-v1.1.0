// Service Worker: кэширует все файлы приложения (cache-first), чтобы оно работало без интернета.
// При выходе новой версии ИЗМЕНИТЕ CACHE_VERSION — старый кэш удалится, новый заполнится.

const CACHE_VERSION = 'videopovtor-v1.1.1';

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'main.js',
  'camera.js',
  'recorder.js',
  'commands.js',
  'store.js',
  'player.js',
  'outputs.js',
  'settings.js',
  'ui.js',
  'display.html',
  'protocol.js',
  'signaling.js',
  'transport.js',
  'phone-session.js',
  'external-output.js',
  'dialog.js',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
