// Lirien Jukebox — Service Worker
//
// Caching policy: cache-as-you-go, do not delete.
//
// - Every audio (.m4a, .mp3, .ogg, .wav), image (.png, .jpg, .webp),
//   and JSON manifest fetched through this SW gets stored in the
//   "lirien-jukebox" cache. Subsequent requests for the same URL
//   serve from cache without hitting the network.
// - We do NOT preemptively populate the cache. The main page's
//   prefetch logic (next-2 tracks) drives what's pulled. The SW
//   just persists whatever flows through.
// - Cache is NEVER auto-evicted. The whole point of this SW is
//   "if the user has heard a track, they don't have to download
//   it again, ever — even across days."
// - HTML / JS / CSS bypass the SW (network-first via implicit
//   fetch passthrough) so updates ship without users having to
//   force-refresh.
//
// Cache invalidation:
//
//   ?clear-cache (or ?nocache) on the main page URL → page sends a
//   message to this SW which deletes the cache and unregisters
//   itself. Next page load gets a fresh SW. Users / we use this
//   when audio or images get re-encoded and the URL didn't change.
//
// SW lifecycle:
//
//   install      → take effect immediately (skipWaiting)
//   activate     → claim all clients (no reload required)
//   fetch        → cache-first for asset URLs; passthrough for HTML
//   message      → handle "purge" command from page

const CACHE_NAME = "lirien-jukebox-v2";

// URL patterns we cache. Keep this conservative — anything not
// matched here goes straight to network (and through Cloudflare's
// regular caching).
const CACHEABLE_RE = /\.(m4a|mp3|ogg|wav|png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i;
const CACHEABLE_PATH_RE = /\/(?:lirien\/(?:music|atmosphere)|echoes|jukebox)\//;

function shouldCache(url){
	const u = new URL(url);
	if (u.origin !== self.location.origin) return false;
	if (CACHEABLE_RE.test(u.pathname)) return true;
	// jukebox manifest files (tracks.json, music_progression.json)
	if (CACHEABLE_PATH_RE.test(u.pathname) && u.pathname.endsWith(".json")) return true;
	return false;
}

self.addEventListener("install", (ev) => {
	// Activate as soon as installed — replaces any older worker.
	self.skipWaiting();
});

self.addEventListener("activate", (ev) => {
	ev.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (ev) => {
	const req = ev.request;
	if (req.method !== "GET") return;
	if (!shouldCache(req.url)) return;
	ev.respondWith(cacheFirst(req));
});

async function cacheFirst(request){
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;
	try {
		const response = await fetch(request);
		// Only cache successful, complete responses.
		if (response && response.ok && response.status === 200){
			cache.put(request, response.clone());
		}
		return response;
	} catch (err) {
		// Network failure — if we have a cached fallback under any
		// flavor of the same path (e.g. with/without query string),
		// serve it. Otherwise let the failure propagate.
		const fallback = await cache.match(request, { ignoreSearch: true });
		if (fallback) return fallback;
		throw err;
	}
}

self.addEventListener("message", (ev) => {
	const data = ev.data || {};
	if (data.type === "purge"){
		ev.waitUntil((async () => {
			await caches.delete(CACHE_NAME);
			// Reply so the page can confirm and reload.
			if (ev.source) ev.source.postMessage({ type: "purged" });
		})());
	}
});
