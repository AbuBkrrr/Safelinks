// Minimal service worker. Its only job is to make the app installable
// (Chrome/Android require a registered SW with a fetch handler before it
// will show an install prompt). It does NOT cache API responses or app
// data — vouchers, sessions, router status, etc. must always be live —
// so this is a plain network passthrough, not an offline mode.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
