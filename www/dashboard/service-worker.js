'use strict';

// Deliberately does no caching - this dashboard only makes sense with a live connection to the
// adapter, so "offline" data would just be stale/wrong. The fetch handler exists only because
// Chrome's install-ability check for the "Add to Home Screen" / "Install app" prompt requires one.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
