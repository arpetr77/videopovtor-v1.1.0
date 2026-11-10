// Service Worker: кэширует все файлы приложения (cache-first), чтобы оно работало без интернета.
// При выходе новой версии ИЗМЕНИТЕ CACHE_VERSION — старый кэш удалится, новый заполнится.

const CACHE_VERSION = 'videopovtor-v1.1.0';

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/camera.js',
  'js/recorder.js',
  'js/commands.js',
  'js/store.js',
  'js/player.js',
  'js/outputs.js',
  'js/settings.js',
  'js/ui.js',
  'display.html',
  'js/external/protocol.js',
  'js/external/signaling.js',
  'js/external/transport.js',
  'js/external/phone-session.js',
  'js/external/external-output.js',
  'js/external/dialog.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
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
