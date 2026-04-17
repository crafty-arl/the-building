// Stub service worker. Exists only so Chromium considers the app installable
// and fires `beforeinstallprompt`. No caching, no offline — requests fall
// through to the network exactly as they would without the SW.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Empty handler is the minimum needed to satisfy installability.
});
