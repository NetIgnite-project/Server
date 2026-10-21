// NetIgnite service worker: makes the dashboard installable as an app (PWA). It caches nothing but
// an offline page, because the dashboard always needs its server: API requests and WebSockets are
// never intercepted, only page loads that fail without a connection.
const CACHE = "netignite-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
