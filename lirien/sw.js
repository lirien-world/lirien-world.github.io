// Lirien Reader — Service Worker
//
// Caches the heavy reader assets (bgs, music, story json) per-URL,
// keyed by content hash. The hash lives in the URL query string
// (`?h=abc123`) generated from assets_manifest.json: when the asset's
// bytes change, the URL changes, so a stale cache entry is naturally
// orphaned and the new URL gets a fresh fetch.
//
// Why this exists (vs the prior ASSET_VERSION sledgehammer):
//   - ASSET_VERSION invalidated EVERY asset URL on any bump (one byte
//     of CSS → ~460 MB of re-download).
//   - Per-asset hashes invalidate only the files whose bytes changed.
//   - SW cache survives across sessions and across the freshness-check
//     reload, so a returning reader gets every scene they've already
//     seen for free.
//
// Caching policy:
//   - Cache-first for asset URLs that match shouldCache().
//   - Network-first with cached fallback for the reader shell
//     (/lirien/, index.html, JS/CSS, asset manifest) so an installed
//     PWA can launch while offline instead of failing before app code
//     runs.
//   - Network-only (pass-through) for everything else — including
//     unrelated requests. Shell updates still ship through the
//     freshness-check path because network-first refreshes the cache
//     whenever online.
//   - The cache is never auto-evicted by the SW. The browser may evict
//     under storage pressure (especially iOS Safari); the page handles
//     re-sync on next online boot.
//
// Lifecycle:
//   install   → skipWaiting (replace any older worker immediately)
//   activate  → clients.claim + prune caches with non-current names
//   fetch     → cache-first for cacheable; passthrough otherwise
//   message   → "purge" / "preloadAll" / "getCacheState" (Phase 2 API)
//
// Cache invalidation:
//   Per-asset: handled automatically via the hash in the URL.
//   Global wipe: page sends { type: "purge" } message, SW deletes cache.
//
// Bump CACHE_NAME only when the SW's caching shape changes (e.g.,
// switching strategies, splitting caches). Asset content updates do
// NOT require a bump — they're handled by URL change.

const CACHE_NAME = "lirien-reader-v1";
const SHELL_URLS = [
	"/lirien/",
	"/lirien/index.html",
	"/lirien/style.css",
	"/lirien/analytics.js",
	"/lirien/ink.js",
	"/lirien/main.js",
	"/lirien/assets_manifest.json",
	"/lirien/sw.js",
	"/spiral_stone.png",
];

// What we cache. shouldCache() is the single authority — both the
// fetch handler and the message handlers consult it.
const CACHEABLE_EXT_RE = /\.(png|jpg|jpeg|webp|gif|svg|m4a|mp3|ogg|wav)(\?.*)?$/i;
const CACHEABLE_JSON = new Set([
	"/lirien/story.json",
	"/lirien/story_es.json",
	"/lirien/shimmer_anchors.json",
]);

function shouldCache(url) {
	const u = new URL(url);
	if (u.origin !== self.location.origin) return false;
	if (!u.pathname.startsWith("/lirien/")) return false;
	if (CACHEABLE_EXT_RE.test(u.pathname)) return true;
	if (CACHEABLE_JSON.has(u.pathname)) return true;
	return false;
}

function isShellRequest(url) {
	const u = new URL(url);
	if (u.origin !== self.location.origin) return false;
	if (u.pathname === "/lirien" || u.pathname === "/lirien/") return true;
	return SHELL_URLS.includes(u.pathname);
}

self.addEventListener("install", (ev) => {
	// Take effect immediately, no waiting for old tabs to close.
	ev.waitUntil(precacheShell());
	self.skipWaiting();
});

self.addEventListener("activate", (ev) => {
	ev.waitUntil((async () => {
		// Drop any caches from prior SW schemas; keeps storage tidy
		// across CACHE_NAME bumps.
		const names = await caches.keys();
		await Promise.all(
			names
				.filter((n) => n !== CACHE_NAME && n.startsWith("lirien-reader-"))
				.map((n) => caches.delete(n))
		);
		await self.clients.claim();
	})());
});

self.addEventListener("fetch", (ev) => {
	const req = ev.request;
	if (req.method !== "GET") return;
	if (req.mode === "navigate" || isShellRequest(req.url)) {
		ev.respondWith(networkFirstShell(req));
		return;
	}
	if (!shouldCache(req.url)) return;
	ev.respondWith(cacheFirst(req));
});

async function precacheShell() {
	const cache = await caches.open(CACHE_NAME);
	await Promise.all(SHELL_URLS.map(async (url) => {
		try {
			const response = await fetch(url, { cache: "no-cache" });
			if (response && response.ok && response.status === 200) {
				await cache.put(url, response.clone());
			}
		} catch (e) {
			// Install must not fail just because one shell request was
			// interrupted. Runtime networkFirstShell still fills gaps.
		}
	}));
}

async function networkFirstShell(request) {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response && response.ok && response.status === 200) {
			cache.put(request, response.clone());
			if (request.mode === "navigate") cache.put("/lirien/", response.clone());
		}
		return response;
	} catch (err) {
		const cached = await cache.match(request, { ignoreSearch: true });
		if (cached) return cached;
		if (request.mode === "navigate") {
			const fallback = await cache.match("/lirien/", { ignoreSearch: true })
				|| await cache.match("/lirien/index.html", { ignoreSearch: true });
			if (fallback) return fallback;
		}
		throw err;
	}
}

async function cacheFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;
	try {
		const response = await fetch(request);
		// Only cache full successful responses. Partial (206), redirects,
		// and errors all bypass — those shouldn't poison the cache.
		if (response && response.ok && response.status === 200) {
			cache.put(request, response.clone());
		}
		return response;
	} catch (err) {
		// Offline + cold cache for this URL. Try a query-stripped match
		// (in case the asset was cached under a different hash earlier
		// in this device's history — better stale than broken).
		const fallback = await cache.match(request, { ignoreSearch: true });
		if (fallback) return fallback;
		throw err;
	}
}

// ----- message API (Phase 2 scaffolding) -----
//
// The page communicates with the SW via postMessage. Each message
// has a `type` and optional payload; replies are sent back to the
// originating client.

self.addEventListener("message", (ev) => {
	const data = ev.data || {};
	// Page side sends a MessageChannel port via ev.ports[0] for
	// request/reply. Falls back to broadcasting on ev.source so older
	// fire-and-forget callers (or echoes-style purge events) still work.
	const port = (ev.ports && ev.ports[0]) || null;
	const reply = (msg) => {
		if (port) { try { port.postMessage(msg); } catch (_) { /* port closed */ } }
		else if (ev.source) ev.source.postMessage(msg);
	};

	if (data.type === "purge") {
		ev.waitUntil((async () => {
			await caches.delete(CACHE_NAME);
			reply({ type: "purged" });
		})());
		return;
	}

	if (data.type === "getCacheState") {
		// Called with { type, manifest: <assets_manifest.json> }.
		// Replies with { type:"cacheState", cached:[paths], missing:[paths] }
		// — paths RELATIVE to /lirien/. Phase 2 settings UI uses this
		// to surface "all good" vs "12 assets need re-download".
		ev.waitUntil((async () => {
			const assets = (data.manifest && data.manifest.assets) || {};
			const cache = await caches.open(CACHE_NAME);
			const cached = [];
			const missing = [];
			for (const path of Object.keys(assets)) {
				const url = "/lirien/" + path + "?h=" + assets[path].hash;
				const hit = await cache.match(url);
				(hit ? cached : missing).push(path);
			}
			reply({ type: "cacheState", cached, missing });
		})());
		return;
	}

	if (data.type === "preloadAll") {
		// Phase 2 entry point: download every asset for the user's
		// chosen quality into the cache. Caller sends:
		//   { type, manifest, qualityFilter, batchSize? }
		// qualityFilter: "high" | "standard" — controls which bg variant
		//   is downloaded (PNG or WebP). Music and JSON are downloaded
		//   regardless. Other extensions are skipped.
		// Reports progress via:
		//   { type:"preloadProgress", done, total, doneBytes, totalBytes }
		// Ends with:
		//   { type:"preloadComplete", failed:[paths] }
		// Cancellation: subsequent { type:"preloadCancel" } message
		// flips a flag the loop checks between batches.
		ev.waitUntil(runPreload(data, port));
		return;
	}

	if (data.type === "preloadCancel") {
		preloadCancelled = true;
		return;
	}
});

// ----- preload state -----

let preloadCancelled = false;

function pathExtension(path) {
	const i = path.lastIndexOf(".");
	return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

function shouldPreloadPath(path, qualityFilter) {
	const ext = pathExtension(path);
	if (ext === "m4a" || ext === "json") return true;
	if (ext === "png")  return qualityFilter === "high";
	if (ext === "webp") return qualityFilter === "standard";
	return false;
}

async function runPreload(data, port) {
	preloadCancelled = false;
	const reply = (msg) => { try { port && port.postMessage(msg); } catch (_) {} };

	const manifest = data.manifest || {};
	const assets = manifest.assets || {};
	const qualityFilter = data.qualityFilter || "high";
	const batchSize = Math.max(1, Math.min(12, data.batchSize || 6));

	// Build the work list: [(path, hash, size), ...] filtered by quality.
	const tasks = [];
	let totalBytes = 0;
	for (const path of Object.keys(assets)) {
		if (!shouldPreloadPath(path, qualityFilter)) continue;
		const entry = assets[path];
		tasks.push({
			path,
			url: "/lirien/" + path + "?h=" + entry.hash,
			size: entry.size || 0,
		});
		totalBytes += entry.size || 0;
	}

	const total = tasks.length;
	const cache = await caches.open(CACHE_NAME);
	let done = 0;
	let doneBytes = 0;
	const failed = [];

	// Initial progress so the UI shows the right denominator immediately.
	reply({ type: "preloadProgress", done, total, doneBytes, totalBytes });

	// Process in batches. Each batch fires N concurrent fetches and
	// awaits them all before moving to the next batch. Keeps a lid on
	// connection count without serializing — cuts wall time roughly
	// proportional to batchSize on cold runs.
	for (let i = 0; i < tasks.length; i += batchSize) {
		if (preloadCancelled) {
			reply({ type: "preloadComplete", failed, cancelled: true });
			return;
		}
		const slice = tasks.slice(i, i + batchSize);
		await Promise.all(slice.map(async (t) => {
			try {
				const existing = await cache.match(t.url);
				if (existing) {
					// Already cached (e.g., from prior lazy fetch). Skip.
					done += 1;
					doneBytes += t.size;
					reply({ type: "preloadProgress", done, total, doneBytes, totalBytes });
					return;
				}
				const req = new Request(t.url, { cache: "default" });
				const res = await fetch(req);
				if (res && res.ok && res.status === 200) {
					await cache.put(req, res.clone());
				} else {
					failed.push(t.path);
				}
			} catch (e) {
				failed.push(t.path);
			} finally {
				done += 1;
				doneBytes += t.size;
				reply({ type: "preloadProgress", done, total, doneBytes, totalBytes });
			}
		}));
	}

	reply({ type: "preloadComplete", failed, cancelled: false });
}
