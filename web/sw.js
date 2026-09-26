// Keeps the status page shell available when the server is down. API calls are never
// intercepted: the page decides online/offline from whether /api/status answers.
const CACHE = "agentpipe-status-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  // Network first so updates land; cache is the fallback for when the box is offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(url.pathname === "/" || e.request.mode === "navigate" ? "/" : e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request).then((hit) => hit || new Response("offline", { status: 503 }))),
  );
});
