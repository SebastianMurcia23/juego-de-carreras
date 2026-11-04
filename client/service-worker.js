const CACHE = 'road-rumble-shell-v5';
const SHELL = ['/', '/join/preview', '/css/style.css?v=9', '/manifest.webmanifest',
  '/js/main.js?v=10', '/js/player.js?v=4', '/js/controller.js?v=16'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
