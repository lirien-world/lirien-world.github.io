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
// - The app shell itself is network-first with cached fallback so
//   an installed PWA can launch while offline. Updates still ship
//   normally whenever the device is online.
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
//   message      → handle purge / cache-state / preload commands

const CACHE_NAME = "lirien-jukebox-v18";
const SHELL_URLS = [
	"/echoes/",
	"/echoes/index.html",
	"/echoes/tracks.json",
	"/echoes/music_progression.json",
	"/echoes/assets_manifest.json",
	"/echoes/spiral.png",
	"/echoes/icon-192-v3.png",
	"/echoes/icon-512-v3.png",
	"/echoes/sw.js",
];

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

function isShellRequest(url){
	const u = new URL(url);
	if (u.origin !== self.location.origin) return false;
	if (u.pathname === "/echoes" || u.pathname === "/echoes/") return true;
	return SHELL_URLS.includes(u.pathname);
}

self.addEventListener("install", (ev) => {
	// Activate as soon as installed — replaces any older worker.
	ev.waitUntil(precacheShell());
	self.skipWaiting();
});

self.addEventListener("activate", (ev) => {
	ev.waitUntil((async () => {
		await migrateLegacyCaches();
		await self.clients.claim();
	})());
});

self.addEventListener("fetch", (ev) => {
	const req = ev.request;
	if (req.method !== "GET") return;
	if (req.mode === "navigate" || isShellRequest(req.url)){
		ev.respondWith(networkFirstShell(req));
		return;
	}
	if (!shouldCache(req.url)) return;
	ev.respondWith(cacheFirst(req));
});

async function precacheShell(){
	const cache = await caches.open(CACHE_NAME);
	await Promise.all(SHELL_URLS.map(async (url) => {
		try {
			const response = await fetch(url, { cache: "no-cache" });
			if (response && response.ok && response.status === 200){
				await cache.put(url, response.clone());
			}
		} catch (err) {
			// Do not fail install; runtime fetches fill any misses.
		}
	}));
}

async function migrateLegacyCaches(){
	const names = await caches.keys();
	const legacyNames = names.filter((name) => (
		name !== CACHE_NAME && /^lirien-jukebox-v\d+$/.test(name)
	));
	if (!legacyNames.length) return;
	const target = await caches.open(CACHE_NAME);
	for (const legacyName of legacyNames) {
		const legacy = await caches.open(legacyName);
		const requests = await legacy.keys();
		for (const request of requests) {
			if (await target.match(request, { ignoreSearch: false })) continue;
			const response = await legacy.match(request);
			if (response) await target.put(request, response.clone());
		}
		await caches.delete(legacyName);
	}
}

async function networkFirstShell(request){
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response && response.ok && response.status === 200){
			cache.put(request, response.clone());
			if (request.mode === "navigate") cache.put("/echoes/", response.clone());
		}
		return response;
	} catch (err) {
		const cached = await cache.match(request, { ignoreSearch: true });
		if (cached) return cached;
		if (request.mode === "navigate"){
			const fallback = await cache.match("/echoes/", { ignoreSearch: true })
				|| await cache.match("/echoes/index.html", { ignoreSearch: true });
			if (fallback) return fallback;
		}
		throw err;
	}
}

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
	const port = (ev.ports && ev.ports[0]) || null;
	const reply = (msg) => {
		if (port) { try { port.postMessage(msg); } catch (_) {} }
		else if (ev.source) ev.source.postMessage(msg);
	};
	if (data.type === "purge"){
		ev.waitUntil((async () => {
			await caches.delete(CACHE_NAME);
			// Reply so the page can confirm and reload.
			reply({ type: "purged" });
		})());
		return;
	}
	if (data.type === "getCacheState"){
		ev.waitUntil((async () => {
			const cache = await caches.open(CACHE_NAME);
			const cached = [];
			const missing = [];
			for (const item of normalizeItems(data.items)) {
				const hit = await cache.match(item.url, { ignoreSearch: false })
					|| await cache.match(item.url, { ignoreSearch: true });
				(hit ? cached : missing).push(item.url);
			}
			reply({ type: "cacheState", cached, missing });
		})());
		return;
	}
	if (data.type === "preloadAll"){
		ev.waitUntil(runPreload(data, port));
		return;
	}
	if (data.type === "preloadCancel"){
		preloadCancelled = true;
	}
});

let preloadCancelled = false;

function normalizeItems(items){
	if (!Array.isArray(items)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of items) {
		const url = raw && raw.url;
		if (!url) continue;
		let href;
		try { href = new URL(url, self.location.origin).href; }
		catch (e) { continue; }
		if (seen.has(href)) continue;
		seen.add(href);
		out.push({ url: href, size: Number(raw.size) || 0 });
	}
	return out;
}

async function runPreload(data, port){
	preloadCancelled = false;
	const reply = (msg) => { try { port && port.postMessage(msg); } catch (_) {} };
	const items = normalizeItems(data.items);
	const cache = await caches.open(CACHE_NAME);
	const total = items.length;
	const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
	let done = 0;
	let doneBytes = 0;
	const failed = [];
	reply({ type: "preloadProgress", done, total, doneBytes, totalBytes });
	for (const item of items) {
		if (preloadCancelled) {
			reply({ type: "preloadComplete", failed, cancelled: true });
			return;
		}
		try {
			const existing = await cache.match(item.url, { ignoreSearch: false })
				|| await cache.match(item.url, { ignoreSearch: true });
			if (!existing) {
				const req = new Request(item.url, { cache: "default" });
				const response = await fetch(req);
				if (response && response.ok && response.status === 200) {
					await cache.put(req, response.clone());
				} else {
					failed.push(item.url);
				}
			}
		} catch (err) {
			failed.push(item.url);
		} finally {
			done += 1;
			doneBytes += item.size || 0;
			reply({ type: "preloadProgress", done, total, doneBytes, totalBytes });
		}
	}
	reply({ type: "preloadComplete", failed, cancelled: false });
}
