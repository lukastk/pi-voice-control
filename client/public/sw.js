/**
 * Minimal service worker so the PWA is installable on Android Chrome.
 *
 * Phase 7 doesn't ship offline caching — every fetch passes through. The
 * service worker exists primarily to satisfy the install criteria; deeper
 * caching can come later (the app talks to a tightly-coupled local server,
 * so heavy caching would mostly serve stale UI).
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // pass-through; default network behaviour
});
