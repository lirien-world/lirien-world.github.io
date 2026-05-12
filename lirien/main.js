// Chronicles of Lirien — runtime.
//
// Architecture: inkjs runs the story; this file orchestrates the UI
// shell. Each `# bg:` tag swaps a CSS background-image. Each `# music:`
// tag controls HTML5 Audio with crossfade. Each `# chapter:` tag
// triggers an overlay fade-in/hold/fade-out. Prose chunks reveal via
// per-character CSS animation with delayed onset based on a typing
// speed (chars/sec) and pauses at sentence-ending punctuation.

// ----- config -----

const TYPING_RATE_BASE = 22.0;        // chars/sec at multiplier=1.0
const FADE_DURATION_MS = 550;          // per-char fade-in animation length
const PAUSE_SENTENCE_MS = 600;         // . ! ?  followed by whitespace
const PAUSE_EM_DASH_MS = 400;          // —
const PAUSE_COMMA_MS = 200;            // ,
const HINT_FADE_IN_MS = 600;
const CHAPTER_FADE_IN_MS = 2500;
const CHAPTER_HOLD_MS = 4500;
const CHAPTER_FADE_OUT_MS = 2500;
const CHOICE_STAGGER_MS = 80;

const ATMOSPHERE_DIR = "atmosphere/";
const MUSIC_DIR = "music/";
// Bumped on each deploy alongside the script/style ?v= in index.html.
// Atmosphere images and music tracks aren't referenced from <link>
// tags, so without a query-param version on their URLs returning
// visitors keep getting the cached old bytes. Appending ?v=<id>
// makes the URL itself change → browser fetches as a new resource.
// ASSET_VERSION used to be the global cache-buster: bump it and the
// browser refetched every asset (because every URL changed). Now
// per-asset content hashes from assets_manifest.json handle that:
// a bg whose bytes didn't change keeps its URL → keeps its cache
// entry. ASSET_VERSION is kept only as a fallback hash for assets
// that aren't in the manifest yet (race during boot, missing entry,
// etc.) — its presence ensures we never emit a hashless URL.
const ASSET_VERSION = "20260512aa";

// Lookup table populated by loadAssetManifest() before any bg/music
// request fires. Maps "atmosphere/foo.png" → "abc1234567" (10-char
// content hash). Empty until manifest loads; bgUrl/musicUrl fall
// back to ASSET_VERSION until then.
let ASSET_HASHES = Object.create(null);

function assetHash(relPath) {
	const entry = ASSET_HASHES[relPath];
	return (entry && entry.hash) || ASSET_VERSION;
}
function bgUrl(name) {
	// imageQuality "standard" → WebP variant. WebP file may not exist
	// yet for newly-added bgs (encode_webp_variants.py hasn't been
	// run); fall back to PNG so the runtime doesn't 404.
	const wantWebP = settings && settings.imageQuality === "standard";
	const ext = wantWebP ? ".webp" : ".png";
	const rel = "atmosphere/" + name + ext;
	if (wantWebP && !ASSET_HASHES[rel]) {
		// No WebP for this bg — fall back to PNG.
		const png = "atmosphere/" + name + ".png";
		return ATMOSPHERE_DIR + name + ".png?h=" + assetHash(png);
	}
	return ATMOSPHERE_DIR + name + ext + "?h=" + assetHash(rel);
}
// Audio served as .m4a (AAC). Switched from .ogg on 2026-05-08:
// Safari's Ogg Vorbis decoder caused buffer underruns on long-form
// playback (audible pops, intermittent dropouts). AAC is Safari-
// native and equally well-supported by Chrome / Firefox / Edge /
// mobile. Files live alongside their .wav sources in assets/music/
// and are encoded by tools/convert_audio_to_m4a.sh.
function musicUrl(name) {
	const rel = "music/" + name + ".m4a";
	return MUSIC_DIR + name + ".m4a?h=" + assetHash(rel);
}

// ----- asset manifest + service worker -----
//
// Loaded once at boot, populates ASSET_HASHES so bg/music URLs carry
// the per-asset content hash. Network-only (no `?v=`) so we always
// see the latest catalog; falls back to an empty manifest if the
// fetch fails (offline first visit, or pre-deploy state without a
// manifest yet) — bgUrl/musicUrl then use ASSET_VERSION as a fallback
// and we lose per-asset invalidation for that session, but nothing
// breaks.
let ASSET_MANIFEST = null;
async function loadAssetManifest() {
	try {
		const res = await fetch("assets_manifest.json", { cache: "no-cache" });
		if (!res.ok) throw new Error("manifest fetch " + res.status);
		const m = await res.json();
		if (m && m.assets && typeof m.assets === "object") {
			ASSET_HASHES = m.assets;
			ASSET_MANIFEST = m;
		}
	} catch (e) {
		console.warn("[manifest] load failed, falling back to ASSET_VERSION:", e);
	}
}

// Registers the lirien-reader service worker. Cache-first for bgs +
// music + story.json + shimmer_anchors.json (see sw.js for the full
// rule set). Updates ship via the existing freshness-check path; the
// SW handles asset invalidation per-URL via the content-hash query
// string.
//
// Best-effort: failures (insecure context, restricted browser, opt-
// out) just mean the SW layer doesn't run — the page continues to
// work over plain HTTP via direct fetch.
function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return;
	// SW only works over https or http://localhost. Skip on insecure
	// origins so we don't generate spurious registration errors.
	const loc = self.location;
	const isSecure = loc.protocol === "https:" || loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
	if (!isSecure) return;
	// Register on next tick — we don't need to await the registration
	// promise; the SW takes over fetches once it's claimed clients.
	navigator.serviceWorker.register("sw.js", { scope: "/lirien/" })
		.then((reg) => {
			// `reg.active` is populated once the SW is fully installed
			// + activated. We don't gate anything on it — fetches that
			// happen before activation just go to the network and
			// flow into the cache on the next visit.
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track("sw_registered", {
					scope: reg.scope,
					state: reg.active ? "active" : "installing",
				});
			}
		})
		.catch((e) => console.warn("[sw] registration failed:", e));
}

// Sends a message to the active SW. Resolves to the SW's reply or
// times out after 5s (e.g., no controller yet, dead SW). Used by
// Phase 2 settings UI for cache state / preload / purge.
function postToServiceWorker(msg, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
		if (!sw) return reject(new Error("no SW controller"));
		const channel = new MessageChannel();
		const timer = setTimeout(() => reject(new Error("SW reply timeout")), timeoutMs);
		channel.port1.onmessage = (ev) => {
			clearTimeout(timer);
			resolve(ev.data);
		};
		sw.postMessage(msg, [channel.port2]);
	});
}

// ----- offline-reading mode (Phase 2 + 3) -----
//
// Drives the "Offline reading" panel in the menu drawer. Three jobs:
//   1. Pre-toggle: estimate device storage, compute manifest size for
//      the user's quality, and either start the download or recommend
//      switching to Standard quality (or refuse if neither fits).
//   2. Download: send {type:preloadAll} to the SW, render progress.
//   3. Integrity: on every boot, ask SW for cache vs manifest. Show
//      "all good" or "N missing" + silently re-sync when online.
//
// Truth lives in two places:
//   - settings.offlineMode (user intent, persisted to localStorage)
//   - SW cache contents (actual state, queried via getCacheState)
// The panel always renders from BOTH so a user who toggled it on
// then had storage evicted by iOS Safari sees the truthful "N
// missing, will re-sync" instead of a false "all good".
const offline = {
	cacheState: null,           // { cached:[paths], missing:[paths] } from SW
	preloading: false,
	preloadDone: 0,
	preloadTotal: 0,
	preloadDoneBytes: 0,
	preloadTotalBytes: 0,
	storageEstimate: null,      // { quota, usage } from navigator.storage.estimate
	preloadChannel: null,       // MessageChannel kept alive for the duration of a preload
};

function fmtMB(bytes) {
	if (!bytes || bytes < 0) return "0 MB";
	const mb = bytes / (1024 * 1024);
	return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + " MB";
}

function pathExt(path) {
	const i = path.lastIndexOf(".");
	return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

// Total bytes that would be downloaded if offline mode were enabled
// at the given image quality. Includes all music + json regardless;
// adds PNG or WebP bgs based on quality.
function computeOfflineSizeFor(quality) {
	if (!ASSET_MANIFEST || !ASSET_MANIFEST.assets) return 0;
	let bytes = 0;
	for (const [path, entry] of Object.entries(ASSET_MANIFEST.assets)) {
		const ext = pathExt(path);
		if (ext === "m4a" || ext === "json")        bytes += entry.size;
		else if (ext === "png" && quality === "high")    bytes += entry.size;
		else if (ext === "webp" && quality === "standard") bytes += entry.size;
	}
	return bytes;
}

// Bytes currently in cache for assets the manifest knows about. Sums
// the manifest sizes of paths the SW reports as cached. Falls back to
// 0 if cacheState hasn't been fetched yet.
function bytesCachedForCurrentQuality() {
	if (!offline.cacheState || !ASSET_MANIFEST) return 0;
	const cached = offline.cacheState.cached || [];
	let bytes = 0;
	for (const path of cached) {
		if (!shouldCountForQuality(path, settings.imageQuality)) continue;
		const entry = ASSET_MANIFEST.assets[path];
		if (entry) bytes += entry.size;
	}
	return bytes;
}

function shouldCountForQuality(path, quality) {
	const ext = pathExt(path);
	if (ext === "m4a" || ext === "json") return true;
	if (ext === "png")  return quality === "high";
	if (ext === "webp") return quality === "standard";
	return false;
}

function missingForCurrentQuality() {
	if (!offline.cacheState || !ASSET_MANIFEST) return 0;
	const cachedSet = new Set(offline.cacheState.cached || []);
	let n = 0;
	for (const path of Object.keys(ASSET_MANIFEST.assets)) {
		if (!shouldCountForQuality(path, settings.imageQuality)) continue;
		if (!cachedSet.has(path)) n += 1;
	}
	return n;
}

async function estimateStorage() {
	if (!navigator.storage || !navigator.storage.estimate) return null;
	try { return await navigator.storage.estimate(); }
	catch (e) { return null; }
}

async function fetchCacheState() {
	if (!ASSET_MANIFEST) return null;
	try {
		return await postToServiceWorker({ type: "getCacheState", manifest: ASSET_MANIFEST });
	} catch (e) {
		// SW not controller yet (first-load race), or message timed
		// out. Caller handles null by deferring the check.
		return null;
	}
}

function renderOfflinePanel() {
	const $panel = document.getElementById("offline-panel");
	if (!$panel) return;
	const t = (window.lirienT || ((k) => k));
	const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]));

	const need = computeOfflineSizeFor(settings.imageQuality);
	const cached = bytesCachedForCurrentQuality();
	const missing = missingForCurrentQuality();
	const available = offline.storageEstimate
		? Math.max(0, offline.storageEstimate.quota - offline.storageEstimate.usage)
		: null;

	let html = "";

	if (offline.preloading) {
		const pct = offline.preloadTotal > 0
			? Math.round(100 * offline.preloadDone / offline.preloadTotal)
			: 0;
		html += `<div class="offline-line">`
		     +    `<span class="lbl">${esc(t("lirien.offline.downloading"))}</span>`
		     +    `<span class="val">${pct}% &middot; ${esc(fmtMB(offline.preloadDoneBytes))} / ${esc(fmtMB(offline.preloadTotalBytes))}</span>`
		     + `</div>`;
		html += `<div class="offline-progress"><div class="offline-progress-bar" style="width:${pct}%"></div></div>`;
		html += `<div class="offline-actions">`
		     +    `<button class="offline-btn offline-btn--ghost" data-offline-action="cancel">${esc(t("lirien.offline.cancel"))}</button>`
		     + `</div>`;
	} else if (settings.offlineMode) {
		const allGood = missing === 0;
		const intro = allGood ? t("lirien.offline.ready") : t("lirien.offline.needs-sync");
		html += `<p class="offline-intro">${esc(intro)}</p>`;
		html += `<div class="offline-line">`
		     +    `<span class="lbl">${esc(t("lirien.offline.cached"))}</span>`
		     +    `<span class="val ${allGood ? "ok" : "warn"}">${esc(fmtMB(cached))} / ${esc(fmtMB(need))}</span>`
		     + `</div>`;
		html += `<div class="offline-actions">`;
		if (!allGood) {
			html += `<button class="offline-btn" data-offline-action="resync">${esc(t("lirien.offline.resync"))}</button>`;
		}
		html += `<button class="offline-btn offline-btn--ghost" data-offline-action="disable">${esc(t("lirien.offline.disable"))}</button>`;
		html += `</div>`;
	} else {
		html += `<p class="offline-intro">${esc(t("lirien.offline.intro"))}</p>`;
		html += `<div class="offline-line">`
		     +    `<span class="lbl">${esc(t("lirien.offline.size"))}</span>`
		     +    `<span class="val">${esc(fmtMB(need))}</span>`
		     + `</div>`;
		if (available != null) {
			const fits = available >= need;
			html += `<div class="offline-line">`
			     +    `<span class="lbl">${esc(t("lirien.offline.available"))}</span>`
			     +    `<span class="val ${fits ? "ok" : "warn"}">${esc(fmtMB(available))}</span>`
			     + `</div>`;
		}
		html += `<div class="offline-actions">`
		     +    `<button class="offline-btn" data-offline-action="enable">${esc(t("lirien.offline.enable"))}</button>`
		     + `</div>`;
	}

	$panel.innerHTML = html;
}

function bindOfflineMode() {
	const $panel = document.getElementById("offline-panel");
	if (!$panel) return;
	$panel.addEventListener("click", (ev) => {
		const btn = ev.target.closest("[data-offline-action]");
		if (!btn) return;
		const action = btn.dataset.offlineAction;
		if (action === "enable")  enableOfflineMode();
		else if (action === "disable") disableOfflineMode();
		else if (action === "resync")  startPreload();
		else if (action === "cancel")  cancelPreload();
	});
	// Initial render so the panel isn't empty when the section is opened.
	refreshOfflineState();
}

// Refreshes the data the panel reads from: navigator.storage estimate
// + SW cache state. Cheap (~50ms total). Called on bind, on enable,
// on disable, and after preload completes.
async function refreshOfflineState() {
	offline.storageEstimate = await estimateStorage();
	if (settings.offlineMode) {
		offline.cacheState = await fetchCacheState();
	}
	renderOfflinePanel();
}

async function enableOfflineMode() {
	// Need the manifest to know how big the download is.
	if (!ASSET_MANIFEST) {
		await loadAssetManifest();
		if (!ASSET_MANIFEST) return; // manifest fetch failed; bail silently
	}
	const t = (window.lirienT || ((k) => k));

	const est = offline.storageEstimate || await estimateStorage();
	offline.storageEstimate = est;
	const available = est ? (est.quota - est.usage) : Infinity;
	const need = computeOfflineSizeFor(settings.imageQuality);

	if (available < need) {
		// Doesn't fit at current quality. If we're at High AND Standard
		// would fit, recommend the switch.
		if (settings.imageQuality === "high") {
			const stdNeed = computeOfflineSizeFor("standard");
			if (available >= stdNeed) {
				const proceed = window.confirm(t("lirien.offline.try-standard"));
				if (!proceed) return;
				settings.imageQuality = "standard";
				saveSettings();
				refreshSelectionMarkers();
				if (currentBgName) {
					const name = currentBgName;
					currentBgName = "";
					swapBackground(name);
				}
			} else {
				window.alert(t("lirien.offline.cant-fit"));
				return;
			}
		} else {
			window.alert(t("lirien.offline.cant-fit"));
			return;
		}
	}

	// Ask the browser to mark our storage persistent — best-effort.
	// On Chrome this is often granted silently for installed PWAs.
	// On Safari it tends to be a no-op, but we still try.
	if (navigator.storage && navigator.storage.persist) {
		try { await navigator.storage.persist(); } catch (e) { /* ignore */ }
	}

	settings.offlineMode = true;
	saveSettings();
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track("offline_enabled", { quality: settings.imageQuality, need_mb: Math.round(need / 1048576) });
	}
	startPreload();
}

async function disableOfflineMode() {
	settings.offlineMode = false;
	saveSettings();
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track("offline_disabled", {});
	}
	// Don't purge the cache — entries are still useful as warm cache
	// for the lazy-mode path, and re-downloading later costs the user
	// bandwidth. A separate "Clear cache" action can take care of it
	// if/when users want the space back.
	await refreshOfflineState();
}

async function startPreload() {
	if (offline.preloading) return;
	if (!ASSET_MANIFEST) {
		await loadAssetManifest();
		if (!ASSET_MANIFEST) return;
	}
	const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (!sw) {
		// No controller yet — try again after a tick.
		setTimeout(startPreload, 800);
		return;
	}
	offline.preloading = true;
	offline.preloadDone = 0;
	offline.preloadTotal = 0;
	offline.preloadDoneBytes = 0;
	offline.preloadTotalBytes = 0;
	renderOfflinePanel();

	const channel = new MessageChannel();
	offline.preloadChannel = channel;
	channel.port1.onmessage = (ev) => {
		const m = ev.data;
		if (!m) return;
		if (m.type === "preloadProgress") {
			offline.preloadDone       = m.done;
			offline.preloadTotal      = m.total;
			offline.preloadDoneBytes  = m.doneBytes;
			offline.preloadTotalBytes = m.totalBytes;
			renderOfflinePanel();
		} else if (m.type === "preloadComplete") {
			offline.preloading = false;
			offline.preloadChannel = null;
			refreshOfflineState();
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track("offline_preload_complete", {
					cancelled: !!m.cancelled,
					failed: (m.failed || []).length,
				});
			}
		}
	};
	sw.postMessage({
		type: "preloadAll",
		manifest: ASSET_MANIFEST,
		qualityFilter: settings.imageQuality,
	}, [channel.port2]);
}

function cancelPreload() {
	const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (sw) sw.postMessage({ type: "preloadCancel" });
}

// Boot-time integrity check: if the user has previously enabled
// offline mode, see what's actually cached vs what the manifest
// says. If gaps exist and we're online, silently re-sync. The
// settings panel will surface the truthful state when next opened.
async function bootIntegrityCheck() {
	if (!settings.offlineMode) return;
	if (!ASSET_MANIFEST) return;  // manifest fetch failed; defer
	// Wait briefly for the SW to claim. On returning visits this is
	// usually immediate.
	const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (!sw) return;
	const state = await fetchCacheState();
	if (!state) return;
	offline.cacheState = state;
	const missing = missingForCurrentQuality();
	if (missing > 0 && navigator.onLine) {
		// Silent resync — don't pop UI, just start the preload. If the
		// user opens the panel they'll see "Downloading…" naturally.
		startPreload();
	}
}

// ----- DOM refs -----

const $bg = document.getElementById("bg");
// Dual-img bg setup for crossfade. activeBg always points at the
// element currently showing (.is-active). On a soft swap, we load
// the next scene on the OTHER element, wait for its bitmap to
// decode, then flip .is-active. On a hard `# bg-cut:` we set src
// on the active element directly with the transition disabled.
const $bgA = document.getElementById("bg-image-a");
const $bgB = document.getElementById("bg-image-b");
let activeBg = $bgA;
// Monotonic id for in-flight crossfades. If a new swap arrives
// while the previous one's incoming img is still decoding, the
// older onload handler bails on its gen-check and the newer one
// wins. Prevents a fast skip pile-up from doing the wrong flip.
let bgCrossfadeGen = 0;
const $proseContent = document.getElementById("prose-content");
const $prose = document.getElementById("prose");
const $continueHint = document.getElementById("continue-hint");
const $offlineHint = document.getElementById("offline-hint");
const $choices = document.getElementById("choices");
const $chapterTitle = document.getElementById("chapter-title");
const $menuBtn = document.getElementById("menu-btn");
const $menuPanel = document.getElementById("menu-panel");
const $drawerScrim = document.getElementById("drawer-scrim");
const $atmosphereLayer = document.getElementById("atmosphere-layer");
const $shimmerFx = document.getElementById("shimmer-fx");
// Backwards-compat aliases — most call sites and `bind*Menu` use
// these names. After the chapters + settings merge into one drawer,
// both names point at the same DOM node.
const $settingsBtn = $menuBtn;
const $settingsPanel = $menuPanel;
const $chaptersBtn = $menuBtn;
const $chaptersPanel = $menuPanel;

// Drawer open/close helpers. There's now one drawer (#menu-panel)
// holding accordion sections for Chapters / Reading speed / Text
// size / Music. Animations are CSS-driven via .is-open classes on
// both the drawer and the scrim; JS just toggles class state.
function openDrawer(drawer) {
	const target = drawer || $menuPanel;
	if (!target) return;
	target.classList.add("is-open");
	target.setAttribute("aria-hidden", "false");
	if ($drawerScrim) $drawerScrim.classList.add("is-open");
	requestAnimationFrame(() => updateDrawerFit(target));
}
function closeDrawer(drawer) {
	const target = drawer || $menuPanel;
	if (target) {
		target.classList.remove("is-open");
		target.classList.remove("has-scroll-more");
		target.setAttribute("aria-hidden", "true");
	}
	if ($drawerScrim) $drawerScrim.classList.remove("is-open");
}
function closeAllDrawers() { closeDrawer($menuPanel); }
function isDrawerOpen(drawer) {
	const target = drawer || $menuPanel;
	return target && target.classList.contains("is-open");
}
function updateDrawerScrollHint(drawer) {
	const target = drawer || $menuPanel;
	const body = target ? target.querySelector(".drawer-body") : null;
	if (!target || !body) return;
	const hasMore = body.scrollTop + body.clientHeight < body.scrollHeight - 2;
	target.classList.toggle("has-scroll-more", hasMore);
}
function updateDrawerRightsCenter(drawer) {
	const target = drawer || $menuPanel;
	const rights = target ? target.querySelector(".drawer-rights") : null;
	const text = rights ? rights.querySelector(".drawer-rights-text") : null;
	if (!target || !rights || !text) return;

	const styles = getComputedStyle(rights);
	const range = document.createRange();
	range.selectNodeContents(text);
	const rightsRect = rights.getBoundingClientRect();
	const textRect = range.getBoundingClientRect();
	const drawerRect = target.getBoundingClientRect();
	const borderTop = parseFloat(styles.borderTopWidth) || 0;
	const currentShift = pxFromCssVar(getComputedStyle(target), "--drawer-rights-text-shift");
	const topGap = textRect.top - rightsRect.top - borderTop;
	const bottomGap = drawerRect.bottom - textRect.bottom;
	const nextShift = currentShift - ((topGap - bottomGap) / 2);
	target.style.setProperty("--drawer-rights-text-shift", nextShift.toFixed(3) + "px");
	range.detach();
}
function pxFromCssVar(styles, name) {
	const raw = styles.getPropertyValue(name).trim();
	if (!raw) return 0;
	if (raw.endsWith("rem")) {
		const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		return parseFloat(raw) * rootSize;
	}
	return parseFloat(raw) || 0;
}
function clampNum(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
function verticalPadding(el) {
	const styles = getComputedStyle(el);
	return (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
}
function drawerBodyMeasuredHeight(body) {
	const children = Array.from(body.children);
	if (!children.length) return 0;
	const styles = getComputedStyle(body);
	const gap = parseFloat(styles.rowGap || styles.gap) || 0;
	return children.reduce((sum, child) => {
		const summary = child.querySelector(".drawer-section-summary");
		const sectionBody = child.querySelector(".drawer-section-body");
		if (!summary || !sectionBody || !child.classList.contains("is-open")) {
			return sum + child.getBoundingClientRect().height;
		}
		const borderBottom = parseFloat(getComputedStyle(child).borderBottomWidth) || 0;
		return sum + summary.getBoundingClientRect().height + sectionBody.scrollHeight + borderBottom;
	}, 0) +
		gap * Math.max(0, children.length - 1);
}
function updateDrawerFit(drawer, settled) {
	const target = drawer || $menuPanel;
	const body = target ? target.querySelector(".drawer-body") : null;
	if (!target || !body) return;

	const denseViewport = window.matchMedia("(max-height: 420px), (max-width: 720px)").matches;

	const openSections = body.querySelectorAll(".drawer-section.is-open").length;
	target.classList.toggle("has-open-section", openSections > 0);
	const adjustableRows = Array.from(body.querySelectorAll(
		".drawer-section-summary, .drawer-section.is-open .chapter-btn, .drawer-section.is-open .setting-row"
	));
	if (!adjustableRows.length) {
		updateDrawerScrollHint(target);
		return;
	}

	const targetBodyHeight = body.clientHeight;
	const currentPad = adjustableRows.reduce((sum, row) => sum + verticalPadding(row), 0);
	const measuredHeight = drawerBodyMeasuredHeight(body);
	const baseHeight = Math.max(0, measuredHeight - currentPad);
	const minPad = denseViewport ? (openSections > 0 ? 0.75 : 2.5) : 4;
	const maxPad = denseViewport ? 18 : (openSections === 0 ? 40 : 64);
	const fittedPad = clampNum(
		(targetBodyHeight - baseHeight) / (adjustableRows.length * 2),
		minPad,
		maxPad
	);
	const sectionPad = fittedPad;
	const optionPad = fittedPad;
	target.style.setProperty("--drawer-fit-section-vpad", sectionPad.toFixed(1) + "px");
	target.style.setProperty("--drawer-fit-option-vpad", optionPad.toFixed(1) + "px");
	updateDrawerScrollHint(target);
	updateDrawerRightsCenter(target);
	clearTimeout(target._drawerScrollHintTimer);
	target._drawerScrollHintTimer = setTimeout(() => {
		updateDrawerScrollHint(target);
		updateDrawerRightsCenter(target);
	}, 580);
}

if ($menuPanel) {
	const body = $menuPanel.querySelector(".drawer-body");
	if (body) body.addEventListener("scroll", () => updateDrawerScrollHint($menuPanel), { passive: true });
	window.addEventListener("resize", () => {
		updateDrawerFit($menuPanel);
		requestAnimationFrame(() => updateDrawerRightsCenter($menuPanel));
	});
	window.addEventListener("orientationchange", () => setTimeout(() => updateDrawerFit($menuPanel), 250));
}

// Brief glow-then-fade tap acknowledgment for chrome buttons. Same
// pattern as /echoes/: gate :hover behind (hover:hover) in CSS so
// iOS sticky-hover doesn't pin the glow on after a tap, and apply
// .tap-ack here on each click for a 1-second visual ack instead.
function ackTap(el) {
	if (!el) return;
	el.classList.remove("tap-ack");
	void el.offsetWidth;
	el.classList.add("tap-ack");
}
if ($drawerScrim) {
	$drawerScrim.addEventListener("click", () => closeAllDrawers());
}
document.addEventListener("click", (ev) => {
	const closeBtn = ev.target.closest("[data-close-drawer]");
	if (!closeBtn) return;
	const drawer = closeBtn.closest(".drawer");
	closeDrawer(drawer);
});
document.addEventListener("animationend", (ev) => {
	if (ev.animationName === "chrome-btn-tap-ack") {
		ev.target.classList.remove("tap-ack");
	}
});

// Single menu button — opens the unified drawer and refreshes the
// inner sections' state (chapter list, current selections) so the
// view is always live.
if ($menuBtn) {
	$menuBtn.addEventListener("click", () => {
		ackTap($menuBtn);
		if (isDrawerOpen($menuPanel)) {
			closeDrawer($menuPanel);
		} else {
			openDrawer($menuPanel);
			if (typeof renderChapterList === "function") renderChapterList();
			if (typeof updateReturnRecentVisibility === "function") updateReturnRecentVisibility();
			if (typeof refreshSelectionMarkers === "function") refreshSelectionMarkers();
			updateDrawerFit($menuPanel);
		}
	});

	// Rare shimmer — one pass shortly after load, then on a long
	// random schedule. Tonally: the menu icon "shimmers" the way
	// the world does, not the way a UI loops. Steve's note: "I
	// like the idea that it would do it very rarely and on a
	// random schedule just like the shimmer haha".
	const triggerShimmer = () => {
		if (document.hidden) return scheduleShimmer();   // skip while tab/PWA is backgrounded
		$menuBtn.classList.remove("is-shimmering");
		void $menuBtn.offsetWidth;                       // force reflow → animation re-fires
		$menuBtn.classList.add("is-shimmering");
	};
	const scheduleShimmer = () => {
		const min = 20 * 60 * 1000;  // 20 minutes
		const max = 38 * 60 * 1000;  // 38 minutes
		const delay = min + Math.random() * (max - min);
		setTimeout(triggerShimmer, delay);
	};
	$menuBtn.addEventListener("animationend", (ev) => {
		if (ev.animationName === "menu-btn-shimmer") {
			$menuBtn.classList.remove("is-shimmering");
			scheduleShimmer();
		}
	});
	// Initial "hi, I'm here" pulse 6-12s after load — long enough
	// for the user to settle in but short enough to teach them the
	// icon exists.
	setTimeout(triggerShimmer, 6000 + Math.random() * 6000);
}

// Accordion sections inside the drawer. Click a section's summary
// to toggle .is-open; CSS animates the body's grid-template-rows
// from 0fr to 1fr (the canonical "animate height auto" trick).
// aria-expanded stays in sync for screen readers.
document.addEventListener("click", (ev) => {
	const summary = ev.target.closest(".drawer-section-summary");
	if (!summary) return;
	const section = summary.closest(".drawer-section");
	if (!section) return;
	const open = section.classList.toggle("is-open");
	summary.setAttribute("aria-expanded", open ? "true" : "false");
	updateDrawerFit(section.closest(".drawer"));
	// On expand, "pull up" the section so its choices are visible.
	// Two failure modes the simple "scroll-header-to-top" approach hit:
	//   1. The LAST section (Music) had its expanding content clipped
	//      by drawer-foot-actions — scrolling its header to the top
	//      didn't guarantee its body fit on screen.
	//   2. requestAnimationFrame fires WHILE the grid-row animation
	//      is still mid-transition; getBoundingClientRect returned
	//      partial-expansion height, so we computed a too-shallow
	//      scroll target.
	// New behaviour:
	//   - Defer scroll until the 0.45s grid-row animation has settled,
	//     so the section's measured height is its full expanded height.
	//   - If section fits in the visible drawer-body height, bottom-
	//     align it (its choices end up just above the foot, header
	//     still visible above). If it's taller than the viewport, top-
	//     align (header visible, user scrolls down to see more).
	if (open) {
		const body = section.closest(".drawer-body");
		if (body) {
			setTimeout(() => {
				const sectionRect = section.getBoundingClientRect();
				const bodyRect = body.getBoundingClientRect();
				const viewportH = body.clientHeight;
				const sectionH = sectionRect.height;
				const sectionTopRel = sectionRect.top - bodyRect.top;
				const sectionBotRel = sectionRect.bottom - bodyRect.top;
				let target;
				if (sectionH <= viewportH) {
					// Fits — bottom-align: pulls the section up into
					// view so its choices are revealed below the header.
					target = body.scrollTop + sectionBotRel - viewportH;
				} else {
					// Too tall — top-align so the header anchors and
					// the user can scroll down to see the rest.
					target = body.scrollTop + sectionTopRel;
				}
				body.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
				updateDrawerScrollHint(section.closest(".drawer"));
			}, 470);
		}
	} else {
		setTimeout(() => updateDrawerScrollHint(section.closest(".drawer")), 470);
	}
});
const $chapterList = document.getElementById("chapter-list");
const $restartBtn = document.getElementById("restart-btn");
const $returnRecentBtn = document.getElementById("return-recent-btn");
const $titleContinue = document.getElementById("title-continue");
const $confirmDialog = document.getElementById("confirm-dialog");
const $confirmTitle = document.getElementById("confirm-title");
const $confirmMessage = document.getElementById("confirm-message");
const $confirmOk = document.getElementById("confirm-ok");
const $confirmCancel = document.getElementById("confirm-cancel");
const $installSplash = document.getElementById("install-splash");
const $installSplashContinue = document.getElementById("install-splash-continue");
const $installSplashAndroidPrompt = document.getElementById("install-splash-android-prompt");
const $titleScreen = document.getElementById("title-screen");
const $titleHint = document.getElementById("title-hint");
const $devPanel = document.getElementById("dev-panel");
const $devSearch = document.getElementById("dev-search");
const $devList = document.getElementById("dev-list");
const $devVersion = document.getElementById("dev-version");
// Timestamp of the last 3+ finger touch — used by the prose
// tap-to-advance handler to ignore the synthesized click that
// follows a multi-finger touchstart (the click would otherwise
// advance the story while the user was trying to open the dev
// panel to capture state).
let lastMultiFingerAt = 0;
const $devClose = document.getElementById("dev-close");
const $devCurrent = document.getElementById("dev-current");

// ----- settings (persisted to localStorage) -----

const SETTINGS_KEY = "lirien.settings";
const SPEED_PRESET_VERSION = 3;
// imageQuality: "high" → PNG (pristine, ~329 MB total bgs)
//               "standard" → WebP at original resolution + q90
//                            (~48 MB total, visually very close to PNG).
// Default is "high" — let pristine be the baseline, opt-in to smaller
// downloads via the menu. Phase 2 offline-toggle will recommend
// "standard" when the device's storage quota can't fit "high".
// offlineMode: user has opted in to "Offline reading" (the toggle in
// the menu drawer). When on, on every boot we do an integrity check
// against the manifest and auto-resync any missing assets while
// online. Default off — opt-in only.
const DEFAULT_SETTINGS = { speedMultiplier: 1.0, speedPresetVersion: SPEED_PRESET_VERSION, fontSize: 36, musicOn: true, imageQuality: "high", offlineMode: false };
let settings = loadSettings();
applyFontSize();

function loadSettings() {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
		const savedSpeedVersion = parsed.speedPresetVersion || 1;
		if (savedSpeedVersion < SPEED_PRESET_VERSION) {
			const migrated = migrateSpeedPreset(parsed.speedMultiplier, savedSpeedVersion);
			parsed.speedMultiplier = migrated;
			parsed.speedPresetVersion = SPEED_PRESET_VERSION;
			try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed)); }
			catch (e) { /* private mode etc. */ }
		}
		return parsed;
	} catch (e) {
		return { ...DEFAULT_SETTINGS };
	}
}
function migrateSpeedPreset(value, fromVersion) {
	const migrations = {
		1: [
			[0.2, 0.4],
			[0.3, 0.7],
			[0.4, 1.0],
			[0.7, 1.3],
			[1.0, 1.6]
		],
		2: [
			[0.3, 0.4],
			[0.4, 0.7],
			[0.7, 1.0],
			[1.0, 1.3],
			[1.3, 1.6]
		]
	};
	for (const [oldValue, newValue] of migrations[fromVersion] || []) {
		if (Math.abs(value - oldValue) < 0.01) return newValue;
	}
	return value;
}
function saveSettings() {
	settings.speedPresetVersion = SPEED_PRESET_VERSION;
	try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
	catch (e) { /* private mode etc. */ }
}

// Snapshot of the current reading-preference settings, flat-shaped for
// easy SQL aggregation. Used as `extras` on session_start so each
// session is tagged with the speed/size/music defaults the reader
// landed in. Calibration signal: if the distribution drifts off the
// median preset, the median is wrong.
function currentSettingsForAnalytics() {
	return {
		settings_speed: settings.speedMultiplier,
		settings_size:  settings.fontSize,
		settings_music: !!settings.musicOn
	};
}
// ----- platform detection + install splash -----
//
// PWA-style "Add to Home Screen" gives users a chrome-less full-screen
// experience and noticeably smoother performance — we detect mobile
// browser users and prompt them once.
//
// iOS has no programmatic install API; we show the share-button +
// add-to-home-screen text instructions with inline SVG glyphs so users
// recognize the actual buttons in Safari's toolbar.
//
// Android Chrome (and Chromium-based browsers) fire `beforeinstallprompt`
// when the manifest meets PWA criteria — we capture it and call
// .prompt() to show the native install dialog (much higher conversion
// than text instructions). Browsers that don't fire it (Firefox,
// Samsung Internet, etc.) fall back to text instructions.

// Splash shows on every page load (no persisted dismissal). The
// mobile-browser-without-install experience is degraded enough — leak,
// double-tap zoom, choice cramping — that we'd rather nudge users
// toward Add-to-Home-Screen each visit than respect a one-time skip
// and quietly let them have a worse session. "Maybe later" still
// works fine in-tab; reload re-shows it.
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (ev) => {
	// Stop the browser from showing its own auto-banner so we can
	// surface the prompt at our chosen moment (the splash button).
	ev.preventDefault();
	deferredInstallPrompt = ev;
	// If the splash is already up showing the text-fallback section,
	// upgrade it in-place to show the native button instead.
	if ($installSplash && !$installSplash.hidden) renderSplashPlatformSection();
});

function isStandaloneMode() {
	return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
	       window.navigator.standalone === true;
}

function isMobileDevice() {
	if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) return true;
	// Touch-first device with a smallish viewport — covers stock
	// Android browsers that don't expose "Android" in UA strings.
	if (window.matchMedia &&
	    window.matchMedia("(pointer: coarse)").matches &&
	    window.matchMedia("(max-width: 1024px)").matches) return true;
	return false;
}

function isIOSDevice() {
	return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isAndroidDevice() {
	return /Android/i.test(navigator.userAgent);
}

function maybeShowInstallSplash() {
	// Dev escape: ?show-splash forces the splash open regardless of
	// platform / standalone / dismissal state, so testing doesn't
	// require clearing localStorage. Optional value picks which
	// per-platform section to render: ?show-splash=ios|android|
	// android-text|generic. Bare ?show-splash auto-detects.
	const params = new URLSearchParams(window.location.search);
	const forceShow = params.has("show-splash");
	const forceMode = forceShow ? params.get("show-splash") : null;

	if (!forceShow) {
		if (isStandaloneMode()) return;
		if (!isMobileDevice()) return;
		// No localStorage check — splash should re-appear on every
		// page load. Within-page dismissal is in-memory only via the
		// hidden attribute; reload re-renders the splash.
	}

	renderSplashPlatformSection(forceMode);
	$installSplash.hidden = false;

	$installSplashContinue.addEventListener("click", dismissInstallSplash);
	$installSplashAndroidPrompt.addEventListener("click", triggerNativeInstall);

	if (window.lirienAnalytics) {
		const variant =
			isIOSDevice() ? "ios" :
			isAndroidDevice() ? (deferredInstallPrompt ? "android-native" : "android-text") :
			"generic";
		window.lirienAnalytics.track("splash_seen", { variant });
	}
}

// Reveals the right per-platform section and hides the others. Called
// at splash open AND when beforeinstallprompt fires later (Android
// users who tapped through quickly may see the text fallback first
// then the native button appear once the browser fires the event).
function renderSplashPlatformSection(forceMode) {
	const sections = document.querySelectorAll(".install-splash-platform");
	for (const s of sections) s.hidden = true;

	let target;
	if (forceMode === "ios")               target = "install-splash-ios";
	else if (forceMode === "android")      target = "install-splash-android-native";
	else if (forceMode === "android-text") target = "install-splash-android-text";
	else if (forceMode === "generic")      target = "install-splash-generic";
	else if (isIOSDevice())                target = "install-splash-ios";
	else if (isAndroidDevice())            target = deferredInstallPrompt ? "install-splash-android-native" : "install-splash-android-text";
	else                                   target = "install-splash-generic";

	const el = document.getElementById(target);
	if (el) el.hidden = false;
}

async function triggerNativeInstall() {
	if (!deferredInstallPrompt) return;
	const ev = deferredInstallPrompt;
	deferredInstallPrompt = null;
	if (window.lirienAnalytics) window.lirienAnalytics.track("install_prompted", {});
	let outcome = "dismissed";
	try {
		ev.prompt();
		const choice = await ev.userChoice;
		outcome = (choice && choice.outcome) || "dismissed";
	} catch (e) { /* user dismissed or browser declined */ }
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track(
			outcome === "accepted" ? "install_accepted" : "install_rejected",
			{ outcome }
		);
	}
	// Hide the splash whether they accepted or dismissed — they've
	// engaged with the install path either way, no need to re-prompt.
	// Don't go through dismissInstallSplash(): that path fires the
	// "splash_dismissed" event, which would double-count this user.
	$installSplash.hidden = true;
}

function dismissInstallSplash() {
	// In-memory only — reload re-shows the splash. We deliberately
	// don't persist a "dismissed forever" flag, since the install
	// path materially improves the mobile experience (no leaks, no
	// double-tap-zoom, no nav chrome) and we want to keep nudging.
	const wasOpen = !$installSplash.hidden;
	$installSplash.hidden = true;
	if (wasOpen && window.lirienAnalytics) {
		window.lirienAnalytics.track("splash_dismissed", {});
	}
}

function applyFontSize() {
	const px = (settings && settings.fontSize) || DEFAULT_SETTINGS.fontSize;
	document.documentElement.style.setProperty("--prose-font-size", px + "px");
}

// ----- state -----

let story = null;
let state = "loading";   // loading | title-loading | title | typing | waiting | choosing | ended
let currentReveal = null; // { skipFn } so input handler can complete a reveal
let chapterTimer = null;

// ----- bootstrap -----

let allBgNames = [];

(async function init() {
	// Detect standalone mode (Add to Home Screen) and tag the body so
	// CSS can fine-tune sizing for the chrome-less viewport.
	if (isStandaloneMode()) document.body.classList.add("is-standalone");
	// Mobile-only first-visit splash prompting Add-to-Home-Screen.
	maybeShowInstallSplash();

	// Register the service worker BEFORE we start firing asset requests
	// so it can intercept (and cache) them on first visit, not just on
	// repeat visits. Best-effort: if registration fails, asset requests
	// still resolve via plain HTTP — the SW is an optimization layer,
	// not a correctness dependency.
	registerServiceWorker();

	// Load the per-asset content-hash catalog before anything calls
	// bgUrl() or musicUrl(). Without this, those functions fall back
	// to ASSET_VERSION (the old global cache-buster) and we lose the
	// per-asset invalidation that the SW + manifest are built for.
	// Awaited so the title-Continue handler can't fire bg/music swaps
	// against an empty ASSET_HASHES table.
	await loadAssetManifest();

	bindSettingsMenu();
	bindChaptersMenu();
	bindAdvanceInput();
	bindDevMenu();
	bindOfflineMode();
	// Run integrity check after the SW has had a moment to claim
	// clients. Non-blocking: kicks off silently in the background; if
	// gaps are detected and we're online, a resync starts.
	setTimeout(bootIntegrityCheck, 1500);

	$titleContinue.addEventListener("click", () => {
		// Title-screen Continue: unlock audio (autoplay policy), dismiss
		// the title, and resume from the autosave snapshot. Falls back
		// to a fresh start if anything goes wrong.
		onFirstUserGesture();
		const saved = loadAutosave();
		if (!story || !saved) {
			state = "idle";
			dismissTitleScreen();
			advance();
			return;
		}
		try { story.state.LoadJson(saved.state); }
		catch (e) {
			console.warn("[autosave] LoadJson failed, starting fresh:", e);
			state = "idle";
			dismissTitleScreen();
			advance();
			return;
		}
		// Order matters: clearTranscript must run BEFORE applyAutosaveVisuals
		// because the latter renders the saved lastChunk into the panel.
		clearTranscript();
		applyAutosaveVisuals(saved);
		// If we restored to story-end (no more content to Continue),
		// no further atmosphere tags will ever fire. Any stale
		// atmosphere value from older save formats would linger
		// forever — Steve 2026-05-11 saw shimmer persist on the
		// last image of Ch4 from a save made before the atmosphere
		// clears landed. Force-clear here so the world quiets at
		// the end regardless of save vintage.
		if (story && !story.canContinue) setAtmosphere("");
		isExploring = false;
		state = "idle";
		if (window.lirienAnalytics) {
			window.lirienAnalytics.startSession("continue", currentSettingsForAnalytics());
			window.lirienAnalytics.setLastState("idle");
		}
		dismissTitleScreen();
		advance();
	});
	// Show the title screen immediately. The story.json fetch happens
	// in the background; until it resolves, the hint says "loading".
	// The first tap on the title screen unlocks audio and starts the
	// first chunk — which is also when any music tag finally sounds.
	state = "title-loading";
	requestAnimationFrame(() => $titleScreen.classList.add("visible"));
	try {
		// Load the language-specific compiled story. test.ink and
		// test_es.ink share knot names + tag structure exactly, so
		// state JSON migrates 1:1 between the two compiled stories.
		// The Language section in the menu drawer migrates the
		// autosave + reloads on switch (see i18n module in index.html).
		// ASSET_VERSION is appended to defeat HTTP cache: Steve hit a
		// case where switching languages mid-Ch2 left the prose in the
		// old language for several advances, and HTTP-cached story
		// bytes are the most likely cause.
		const lang = (document.documentElement && document.documentElement.lang) || "en";
		const storyFile = lang === "es" ? "story_es.json" : "story.json";
		const parsed = await fetch(storyFile + "?v=" + ASSET_VERSION).then(r => r.json());
		story = new inkjs.Story(parsed);
		// Route inkjs warnings + errors through a dedicated handler
		// instead of letting StoryException bubble to window.onerror.
		// Without this, every recoverable warning (e.g., a save state
		// pointing at a knot that's been renamed since save creation —
		// inkjs auto-recovers by approximating to root) was getting
		// captured as a fatal `error` event in analytics. Warnings
		// stay observable as a separate event type for diagnosis.
		story.onError = function (message, type) {
			const isWarning = (type && type.toString().toLowerCase().includes("warning"))
			               || (message && /WARNING/.test(message));
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track(isWarning ? "ink_warning" : "ink_error", {
					message: String(message).slice(0, 500),
					type: type ? String(type) : null,
				});
			}
			if (!isWarning) console.warn("[ink]", message);
		};
		allBgNames = extractBgNames(parsed);
		// Warm the first 2-3 bgs while the user reads the title screen,
		// so the very first chunk after Enter doesn't flash from black.
		prefetchUpcomingBgs(3);
		state = "title";
		// Swap the "loading…" text for the gold-line + "Enter" hint.
		const loadingEl = $titleHint.querySelector(".title-hint-loading");
		const readyEl = $titleHint.querySelector(".title-hint-ready");
		if (loadingEl) loadingEl.hidden = true;
		if (readyEl) readyEl.hidden = false;
		// Reveal the Continue button if there's an autosave to resume.
		// .has-continue on the parent flips Enter from gold to dark ink
		// so the gold Continue stays the primary call to action.
		const hasContinueOption = !!loadAutosave();
		if (hasContinueOption) {
			$titleContinue.hidden = false;
			$titleHint.classList.add("has-continue");
		}
		// Silent auto-resume after a freshness-driven reload — the
		// user shouldn't have to tap Continue again just because we
		// shipped an update behind their back. The PWA freshness
		// check sets sessionStorage.lirien.justAutoreloaded right
		// before location.reload(); we read + clear it here and
		// programmatically click Continue if there's an autosave to
		// pick up. Browser autoplay grace generally still applies
		// because the prior session was actively interacted with
		// seconds ago.
		try {
			const justAutoreloaded = sessionStorage.getItem("lirien.justAutoreloaded") === "1";
			if (justAutoreloaded) {
				sessionStorage.removeItem("lirien.justAutoreloaded");
				if (hasContinueOption) {
					// Defer one frame so the Continue handler binds
					// (its addEventListener is at the top of init,
					// already done by now, but rAF gives the title-
					// screen reveal a clean first paint either way).
					requestAnimationFrame(() => $titleContinue.click());
				}
			}
		} catch (e) { /* sessionStorage blocked — fall through to manual resume */ }
		// Title-seen marks the top of the install / read funnel: how many
		// people landed on the page and reached an interactive title vs
		// how many ever start a session. has_continue distinguishes
		// "first-time visitor" from "returning reader" at the same gate.
		if (window.lirienAnalytics) {
			window.lirienAnalytics.track("title_seen", {
				has_continue: hasContinueOption
			});
		}
	} catch (e) {
		showFatalError(e);
	}
})();

function dismissTitleScreen() {
	$titleScreen.classList.add("dismissed");
	// Reveal the prose surface as the title fades out — same 1.4s
	// curve, same window. The body class lets CSS keep .game opaque
	// thereafter without needing to track state per-element.
	document.body.classList.add("story-started");
	// Kick a synthetic resize event so iOS Safari recomputes dvh
	// against the current chrome state. Without this, after a
	// freshness auto-reload, the layout can render against a stale
	// viewport size, leaving a black bar at the bottom until a
	// real device rotation forces a recompute. Firing here covers
	// both the manual-Continue path and the auto-resume path.
	setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
	setTimeout(() => {
		$titleScreen.hidden = true;
		$titleScreen.classList.remove("visible", "dismissed");
	}, 1500);
}

function showFatalError(err) {
	$proseContent.innerHTML = "";
	const p = document.createElement("p");
	p.textContent = "Failed to load story: " + (err && err.message ? err.message : err);
	$proseContent.appendChild(p);
}

// ----- main story loop -----

function advance() {
	// Pull from inkjs until we either need to render text, prompt
	// choices, or end. Empty/whitespace-only chunks are skipped here
	// (just like the Godot runner used to do) so a pure-tag beat
	// doesn't strand the user.
	while (story.canContinue) {
		// Snapshot state BEFORE Continue() so chapter bookmarks land
		// at "just before the chapter started emitting." Without this,
		// the chapter:/bg:/music: tags all fire in a single Continue()
		// step and the snapshot would land after the first chunk's
		// text — meaning a jump-to-chapter would skip that chunk and
		// its bg swap. See recordChapterBookmark for the consumer.
		stateBeforeContinue = story.state.toJson();
		const text = story.Continue();
		applyTags(story.currentTags || []);
		const trimmed = (text || "").trim();
		if (trimmed.length === 0) continue;
		typeChunk(trimmed);
		// Warm the next 2-3 background images while the user reads
		// this chunk. At choice points all branches are walked, so
		// whichever path the user picks the bg is already cached.
		prefetchUpcomingBgs(3);
		// Autosave the current reading position. While exploring (jumped
		// to a chapter via the menu) this is skipped so the user's "real"
		// most-recent point stays parked until they return or restart.
		if (!isExploring) saveAutosave();
		return;
	}
	if (story.currentChoices && story.currentChoices.length > 0) {
		applyTags(story.currentTags || []);
		showChoices(story.currentChoices);
		if (!isExploring) saveAutosave();
		return;
	}
	state = "ended";
	if (window.lirienAnalytics) window.lirienAnalytics.setLastState("ended");
	hideContinueHint();
	// Story over — atmosphere quiets too. Without this, an autosave
	// captured at story-end keeps whatever atmosphere was last set
	// (potentially shimmer), and the user re-loading at the end
	// sees it forever since no further tags can fire.
	setAtmosphere("");
	// Append the notify-me prompt inline in the prose panel — the
	// highest-conversion moment in the funnel: someone just finished
	// everything written and is sitting with it. Skipped silently if
	// they've already subscribed (flag in localStorage) or if we're
	// in dev exploration mode (would clutter dev jumps).
	if (!isExploring) renderEndOfStoryPrompt();
	if (!isExploring) saveAutosave();
}

// Notify-me form rendered into the prose panel at end-of-story. POSTs
// to the same /subscribe endpoint as the landing-page form, tagged
// source:"reader-end" so we can see which surface is converting.
// One-shot: stored localStorage flag suppresses it on future end-
// state arrivals.
const NOTIFY_FLAG_KEY = "lirien.notifiedSubscribed";
function renderEndOfStoryPrompt() {
	if (!$proseContent) return;
	// Already subscribed (or already shown + dismissed) — don't ask again.
	try {
		if (localStorage.getItem(NOTIFY_FLAG_KEY) === "1") return;
	} catch (e) { /* localStorage blocked — show the form */ }
	// Defensive: if the form is already in the DOM (e.g., user
	// reached end-of-story, navigated away via dev, came back), don't
	// re-append.
	if ($proseContent.querySelector(".reader-notify-form")) return;
	const t = (window.lirienT || ((k) => k));
	const wrap = document.createElement("div");
	wrap.className = "reader-notify";
	wrap.innerHTML = `
		<p class="reader-notify-intro">${escapeHtml(t("lirien.notify.intro"))}</p>
		<form class="reader-notify-form" novalidate>
			<input
				type="email"
				class="reader-notify-input"
				autocomplete="email"
				spellcheck="false"
				required
				placeholder="${escapeHtml(t("lirien.notify.placeholder"))}"
			>
			<button type="submit" class="reader-notify-submit">${escapeHtml(t("lirien.notify.cta"))}</button>
		</form>
		<p class="reader-notify-thanks" hidden>${escapeHtml(t("lirien.notify.thanks"))}</p>
		<p class="reader-notify-error" hidden>${escapeHtml(t("lirien.notify.error"))}</p>
	`;
	$proseContent.appendChild(wrap);
	bindReaderNotifyForm(wrap);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]));
}

function bindReaderNotifyForm(wrap) {
	const form    = wrap.querySelector(".reader-notify-form");
	const input   = wrap.querySelector(".reader-notify-input");
	const submit  = wrap.querySelector(".reader-notify-submit");
	const thanks  = wrap.querySelector(".reader-notify-thanks");
	const error   = wrap.querySelector(".reader-notify-error");
	// Same endpoint as the landing page form (api.lirien.world is the
	// CF Worker — see analytics.js for the source-of-truth URL).
	const ENDPOINT = "https://api.lirien.world/subscribe";

	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		// Story input is global — stop the submit from bubbling up to
		// the prose-advance handler.
		ev.stopPropagation();
		const email = (input.value || "").trim();
		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			input.focus();
			input.setCustomValidity((window.lirienT || ((k)=>k))("lirien.notify.bad-email"));
			input.reportValidity();
			setTimeout(() => input.setCustomValidity(""), 2000);
			return;
		}
		submit.setAttribute("disabled", "");
		error.hidden = true;
		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					locale: (document.documentElement && document.documentElement.lang) || "en",
					source: "reader-end",
				}),
			});
			if (!res.ok) throw new Error("subscribe " + res.status);
			form.hidden = true;
			thanks.hidden = false;
			try { localStorage.setItem(NOTIFY_FLAG_KEY, "1"); } catch (e) { /* ignore */ }
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track("notify_subscribed", { source: "reader-end" });
			}
		} catch (e) {
			error.hidden = false;
			submit.removeAttribute("disabled");
		}
	});
}

// ----- chunk reveal (typewriter) -----

function tokenizeChunk(text) {
	// Walk the chunk and strip BBCode-style markup ([i]...[/i] for now,
	// inherited from the Godot BBCode source). Returns one record per
	// rendered character, carrying the styling flags that apply.
	const tokens = [];
	let italic = false;
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("[i]", i))   { italic = true;  i += 3; continue; }
		if (text.startsWith("[/i]", i))  { italic = false; i += 4; continue; }
		tokens.push({ ch: text[i], italic });
		i++;
	}
	return tokens;
}

function typeChunk(text) {
	state = "typing";
	if (window.lirienAnalytics) window.lirienAnalytics.setLastState("typing");
	hideContinueHint();
	$choices.classList.remove("visible");
	$choices.innerHTML = "";
	// Remember this chunk so saveAutosave can persist it as resume context.
	lastTypedChunk = text;

	// Build a paragraph with one <span class="ch"> per character. Each
	// span gets `animation-delay` = (typing time to reach that char,
	// including pauses) and `animation-duration` = FADE_DURATION_MS.
	// Result: chars become visible in sequence, fading in over the
	// fade duration, with pauses at sentence-ending punctuation.

	const paragraph = document.createElement("p");
	const rate = TYPING_RATE_BASE * (settings.speedMultiplier || 1.0);
	const msPerChar = 1000.0 / rate;
	let cursorMs = 0;
	const spans = [];
	const spanTimes = [];   // start-of-reveal cursorMs per span (for line-progress scroll)
	const tokens = tokenizeChunk(text);

	for (let i = 0; i < tokens.length; i++) {
		const { ch, italic } = tokens[i];
		const span = document.createElement("span");
		span.className = italic ? "ch i" : "ch";
		span.textContent = ch;
		span.style.animationDelay = cursorMs.toFixed(0) + "ms";
		span.style.animationDuration = FADE_DURATION_MS + "ms";
		paragraph.appendChild(span);
		spans.push(span);
		spanTimes.push(cursorMs);

		cursorMs += msPerChar;
		// Punctuation-followed-by-whitespace gets an extra pause.
		const next = tokens[i + 1] ? tokens[i + 1].ch : undefined;
		const followedByBreak = next === undefined || next === " " || next === "\n" || next === "\t";
		if (followedByBreak) {
			if (ch === "." || ch === "!" || ch === "?") cursorMs += PAUSE_SENTENCE_MS;
			else if (ch === "—") cursorMs += PAUSE_EM_DASH_MS;
			else if (ch === ",") cursorMs += PAUSE_COMMA_MS;
		}
	}

	$proseContent.appendChild(paragraph);
	scrollChunkToTop(paragraph);
	const scrollTimers = new Set();
	scheduleProgressScroll(spans, spanTimes, scrollTimers);

	const totalMs = cursorMs + FADE_DURATION_MS;
	const completionTimer = setTimeout(onChunkRevealed, totalMs);

	currentReveal = {
		paragraph,  // ← exposed so updateCharFade can skip in-flight chars
		skipFn() {
			// Skip-to-end: clear all per-char animation delays so each
			// span snaps to fully-revealed immediately. Cancel pending
			// progressive-scroll timers so they don't lurch the panel
			// around after the user has resumed control.
			clearTimeout(completionTimer);
			for (const t of scrollTimers) clearTimeout(t);
			scrollTimers.clear();
			for (const s of spans) {
				s.style.animation = "none";
				s.style.opacity = "1";
			}
			// Match natural completion's end-state scroll position:
			// bottom of the last line flush with the panel's bottom
			// inner padding edge. Without this, on a chunk taller than
			// the panel the user sees the chunk's top with its bottom
			// clipped — the progressive-scroll timers we just cancelled
			// were what would have scrolled into view.
			if (spans.length > 0) {
				const last = spans[spans.length - 1];
				const padBottom = parseInt(getComputedStyle($proseContent).paddingBottom, 10) || 0;
				const desiredScroll = Math.max(0,
					last.offsetTop + last.offsetHeight - $proseContent.clientHeight + padBottom);
				if (desiredScroll > $proseContent.scrollTop) {
					$proseContent.scrollTo({ top: desiredScroll, behavior: "auto" });
				}
			}
			onChunkRevealed();
		}
	};
}

function scheduleProgressScroll(spans, spanTimes, timers) {
	// For chunks taller than the prose panel, schedule a scroll for
	// each visual line beyond the first. The scroll fires at the time
	// the line begins to reveal, putting the line's bottom flush with
	// the panel's bottom inner padding edge — so the typing cursor
	// stays visible at the panel's lower edge as text fills downward.
	//
	// Two-stage rAF: scrollChunkToTop's scrollTo runs in the next
	// frame; we wait one more so that scrollTop has settled before
	// computing per-line offsets.
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			const padBottom = parseInt(getComputedStyle($proseContent).paddingBottom, 10) || 0;
			const panelHeight = $proseContent.clientHeight;

			let lastTop = null;
			for (let i = 0; i < spans.length; i++) {
				const top = spans[i].offsetTop;
				if (top === lastTop) continue;
				lastTop = top;

				const lineBottom = top + spans[i].offsetHeight;
				const desiredScroll = lineBottom - panelHeight + padBottom;
				if (desiredScroll <= $proseContent.scrollTop + 1) continue;

				const t = setTimeout(() => {
					if (desiredScroll > $proseContent.scrollTop) {
						// behavior:"auto" (instant). "smooth" lags ~300ms
						// while chars keep fading in below the visible
						// edge — Steve's report 2026-05-12: text flows
						// past the readable area before scroll catches up.
						$proseContent.scrollTo({ top: desiredScroll, behavior: "auto" });
					}
					timers.delete(t);
				}, spanTimes[i]);
				timers.add(t);
			}
		});
	});
}

// Per-character top-edge fade. Each .ch span's opacity is set
// based on its distance from the prose viewport's top edge —
// characters near or past the edge fade to 0; characters past
// the fade zone get full opacity. Premium "page absorbs text
// at the edge" feel; replaces the heavier overlay mask as the
// primary peek-through hider.
//
// Cost: ~1-3ms per scroll frame for a typical chunk (~100-200
// .ch spans). rAF-batched so multiple scroll events per frame
// share a single layout pass. Spans in paragraphs entirely
// past the fade zone get a single style-clear (no per-char
// rect read), so the cost scales with paragraphs INTERSECTING
// the fade zone — usually zero or one.
//
// Note on .ch lifecycle: the post-reveal optimization in
// onChunkRevealed simplifies finished chunks to plain text
// (no .ch spans remain). For those chunks the sticky-overlay
// fade is the only safety. The active chunk always has spans;
// scrolled-back-to old chunks rely on the overlay. The two
// systems compose — char-fade where available, overlay
// elsewhere.
const CHAR_FADE_PX = 36;
let charFadeRaf = 0;
function scheduleCharFade() {
	if (charFadeRaf) return;
	charFadeRaf = requestAnimationFrame(() => {
		charFadeRaf = 0;
		updateCharFade();
	});
}
function updateCharFade() {
	if (!$prose || !$proseContent) return;
	// Anchor fade to the inner scroll viewport's top edge — that's
	// where character Y positions are relative to. Using .prose's
	// outer rect would put the fade zone 14px above any actual
	// character, shrinking the effective fade band.
	const proseRect = $proseContent.getBoundingClientRect();
	const fadeTopPx = proseRect.top;
	const fadeBottomPx = fadeTopPx + CHAR_FADE_PX;
	// Don't touch chars in the currently-typing paragraph — their
	// per-character CSS fade-in animation owns their opacity until
	// reveal completes. Steve hit a regression where a fresh chunk
	// (post-clearTranscript scene change) landed in the fade band
	// at the top of an empty .prose-content, and inline style.opacity
	// set by this function overrode the CSS animation's `from: 0`
	// during the per-char animation-delay window — the whole line
	// flashed in at dim grey, then animated left-to-right to white,
	// instead of typing char-by-char from invisible.
	const inFlightParagraph = currentReveal && currentReveal.paragraph;
	const ps = $proseContent.querySelectorAll("p");
	for (const p of ps) {
		if (p === inFlightParagraph) continue;
		const pRect = p.getBoundingClientRect();
		// Paragraph entirely above fade zone — clear any opacity.
		if (pRect.bottom < fadeTopPx) {
			const dirty = p.querySelectorAll('.ch[style*="opacity"]');
			for (const s of dirty) s.style.opacity = "";
			continue;
		}
		// Paragraph entirely below fade zone — clear any opacity.
		if (pRect.top >= fadeBottomPx) {
			const dirty = p.querySelectorAll('.ch[style*="opacity"]');
			for (const s of dirty) s.style.opacity = "";
			continue;
		}
		// Paragraph intersects the fade zone — set per-span opacity.
		const spans = p.querySelectorAll(".ch");
		for (const s of spans) {
			const sRect = s.getBoundingClientRect();
			const charY = sRect.top - fadeTopPx;
			if (charY < -2) {
				s.style.opacity = "0";
			} else if (charY >= CHAR_FADE_PX) {
				if (s.style.opacity) s.style.opacity = "";
			} else {
				s.style.opacity = (Math.max(0, charY) / CHAR_FADE_PX).toFixed(2);
			}
		}
	}
}

// Manual-scroll snap. After the user stops scrolling for ~250ms,
// re-run snapScrollToWholeParagraphs so the prose settles on a
// whole-paragraph boundary even when the scroll wasn't driven by
// a chunk reveal. CSS scroll-snap covers the common path; this
// is the belt-and-suspenders. The snapInProgress guard avoids a
// feedback loop — the smooth scrollTo inside snap fires scroll
// events that would otherwise re-trigger the timer.
let proseScrollEndTimer = 0;
let snapInProgress = false;
// Toggle .is-scrolled when there's any prior content above the
// viewport. The top fade lives in a 28px zone that exactly matches
// the .prose-content padding-top — so the active chunk's first line
// always lands AT the fade's end (full opacity). The fade can fire
// aggressively because it never covers active text; it only fades
// content peeking up into the empty padding zone above the first
// line. Steve 2026-05-12: simpler than the activeChunkScrollTop
// gate, and it keeps the fade in place where it's needed.
function updateIsScrolled() {
	if ($proseContent.scrollTop > 4) $prose.classList.add("is-scrolled");
	else                             $prose.classList.remove("is-scrolled");
}
if ($proseContent) {
	$proseContent.addEventListener("scroll", () => {
		updateIsScrolled();
		// Per-character fade — actual character-level opacity based
		// on each .ch span's distance from the viewport top edge.
		// rAF-batched so consecutive scroll events coalesce into a
		// single update per frame.
		scheduleCharFade();
		// While the typewriter is active, scheduleProgressScroll owns
		// scrollTop so the newest line remains visible. The paragraph
		// snap cleanup is only for manual/waiting states; running it
		// mid-reveal can pull the view away from the current line.
		if (state === "typing") return;
		if (snapInProgress) return;
		clearTimeout(proseScrollEndTimer);
		proseScrollEndTimer = setTimeout(() => {
			snapScrollToWholeParagraphs();
		}, 60);
	}, { passive: true });
}

function onChunkRevealed() {
	// Mark the just-finished paragraph as .revealed — the CSS rule
	// for .prose-content p.revealed .ch removes the per-char fade
	// animation entirely. Without this, the animation's `forwards`
	// fill-mode pins opacity at 1 and overrides any inline opacity
	// updateCharFade() sets, so the scroll-fade band never
	// visually applies (Steve's report 2026-05-11). With the
	// animation gone, inline style.opacity from updateCharFade
	// takes effect normally.
	if (currentReveal && currentReveal.paragraph) {
		currentReveal.paragraph.classList.add("revealed");
	}
	currentReveal = null;
	state = "waiting";
	if (window.lirienAnalytics) window.lirienAnalytics.setLastState("waiting");
	// After the typing animation lands, refine the scroll so no
	// paragraph is partially clipped at the visible top edge.
	snapScrollToWholeParagraphs();
	// Set per-character fade opacity to match current scroll
	// position — covers the case where a chunk revealed but
	// the user hasn't scrolled yet (e.g. progressive-scroll
	// parked us with a paragraph straddling the top, and we
	// want char-edge fade applied immediately).
	scheduleCharFade();
	// Decide between the continue-chevron and the offline-block hint
	// based on whether the next chunk would need an uncached asset.
	presentWaitingHintForCurrentState();
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track("chunk_revealed", {
			bg: currentBgName || null,
			chapter: currentChapterName || null
		});
	}
	// Soft-wait observer: if this is the first chunk after the latest
	// bg swap, capture the moment so img.onload can compute lag_ms.
	if (bgLateState.name === currentBgName && bgLateState.chunkRevealedAt === 0) {
		bgLateState.chunkRevealedAt = performance.now();
		if (bgLateState.bgLoadedAt > 0) {
			// bg landed before the chunk finished revealing — no wait.
			bgLateState = { name: "", chunkRevealedAt: 0, bgLoadedAt: 0 };
		}
		// Else: img.onload will fire later and emit bg_late with the lag.
	}
	// Drop the per-character spans now that the chunk is fully revealed.
	// They were needed for the per-char fade animation; once everyone's
	// at opacity 1 the spans are pure DOM weight — Safari keeps each
	// one's compositing/animation state warm even after completion, and
	// across a long session that's hundreds of stale animated layers.
	// Replacing them with plain text + <em> for italics gives an
	// identical render at a fraction of the sustained cost.
	simplifyRevealedParagraph();
}

function simplifyRevealedParagraph() {
	const paragraphs = $proseContent.querySelectorAll("p");
	if (paragraphs.length === 0) return;
	const last = paragraphs[paragraphs.length - 1];
	if (!last.querySelector(".ch")) return; // already simplified

	// Walk the .ch spans, batching contiguous-italic runs into <em>
	// and contiguous-plain runs into text nodes. Result: one or two
	// nodes per paragraph instead of N spans-with-inline-styles.
	let html = "";
	let italicBuf = "";
	let plainBuf = "";
	const flushItalic = () => { if (italicBuf) { html += "<em>" + escapeHtml(italicBuf) + "</em>"; italicBuf = ""; } };
	const flushPlain  = () => { if (plainBuf)  { html += escapeHtml(plainBuf); plainBuf = ""; } };

	for (const child of last.children) {
		if (!child.classList.contains("ch")) continue;
		const ch = child.textContent;
		if (child.classList.contains("i")) { flushPlain();  italicBuf += ch; }
		else                                { flushItalic(); plainBuf  += ch; }
	}
	flushItalic();
	flushPlain();
	last.innerHTML = html;
}

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollChunkToTop(paragraph) {
	// Scroll the prose panel so the new chunk's first line sits a
	// padding-height below the top of the visible area — i.e. flush
	// with the inner padding edge, not the bare panel border. After
	// settling, the user can scroll up freely to re-read prior chunks.
	// Do not push farther down to hide the previous paragraph here:
	// if we do, a freshly-starting chunk can land inside the top fade
	// band and begin typing partially dimmed. The top fade exists
	// specifically to absorb any prior text as it exits.
	requestAnimationFrame(() => {
		const padTop = parseInt(getComputedStyle($proseContent).paddingTop, 10) || 0;
		const offset = Math.max(0, paragraph.offsetTop - padTop);
		$proseContent.scrollTo({ top: offset, behavior: "auto" });
	});
}

// After progressive-scroll lands its final position, refine the
// scrollTop so no paragraph is partially clipped at the top edge of
// the visible viewport. Each paragraph should be either FULLY
// visible or FULLY out of view — never half-visible at the top.
//
// This replaces the earlier visual-fade attempts (mask-image, sibling
// gradient overlays). Those hid the symptom but left the underlying
// scroll position wrong; the cleaner fix is to snap to a whole-
// paragraph boundary so there's nothing to hide in the first place.
//
// Tall paragraphs (taller than ~85% of the visible viewport) are
// exempt — for those, partial visibility at the top is the user's
// own scroll position mid-paragraph and snapping would lurch.
function snapScrollToWholeParagraphs() {
	const paragraphs = $proseContent.querySelectorAll("p");
	if (paragraphs.length === 0) return;
	const scrollTop = $proseContent.scrollTop;
	const viewportH = $proseContent.clientHeight;
	for (const p of paragraphs) {
		const pTop = p.offsetTop;
		const pBottom = pTop + p.offsetHeight;
		// Fully scrolled past — skip.
		if (pBottom <= scrollTop) continue;
		// First non-past paragraph isn't clipped at top — done, no
		// straddler exists.
		if (pTop >= scrollTop) return;
		// pTop < scrollTop < pBottom: this paragraph straddles the
		// viewport top. Decide whether to snap.
		// Use partial-visible-height alone: if more than half the
		// viewport is showing this paragraph, the user is mid-read
		// and snapping would lurch. Less than half = the paragraph
		// is mostly past, just its tail is leaking → snap.
		// (Earlier "tall paragraph exempt regardless" rule was wrong:
		// a 180px paragraph with only its bottom 71px visible isn't
		// being read mid-paragraph, it's leaking. Diagnostic
		// screenshot 2026-05-10 confirmed.)
		const partialHeight = pBottom - scrollTop;
		if (partialHeight > viewportH * 0.5) return;
		// Otherwise: snap DOWN so the paragraph's bottom is at the
		// viewport top (paragraph fully scrolled out). The next
		// paragraph's natural margin-top creates a clean gap before
		// the visible content.
		// behavior:"auto" (instant) rather than "smooth" so peek-
		// through is never visible for the duration of a smooth-
		// scroll animation. The user's finger has already lifted by
		// the time this fires — they'll see the snap as a single
		// crisp settling, not as a half-second slide that lets the
		// peek linger. Trade: tiny pop instead of a long peek.
		snapInProgress = true;
		$proseContent.scrollTo({ top: pBottom, behavior: "auto" });
		// Guard cleared one frame later — instant scroll completes
		// synchronously, the guard just dodges the scroll event the
		// assignment itself fires.
		setTimeout(() => { snapInProgress = false; }, 80);
		return;
	}
}

// ----- choices -----

function showChoices(choices) {
	state = "choosing";
	if (window.lirienAnalytics) window.lirienAnalytics.setLastState("choosing");
	hideContinueHint();
	$choices.innerHTML = "";
	$choices.classList.add("visible");
	// Choice-moment hold: the world quiets while the reader weighs a
	// choice. CSS rules keyed on body.is-choosing brighten the prose
	// rim and dim the bg slightly so the choice itself becomes the
	// focal point. Released in pickChoice() after the click.
	document.body.classList.add("is-choosing");
	choices.forEach((choice, i) => {
		const btn = document.createElement("button");
		btn.className = "choice";
		btn.textContent = choice.text;
		btn.style.animationDelay = (i * CHOICE_STAGGER_MS) + "ms";
		btn.addEventListener("click", () => pickChoice(i));
		$choices.appendChild(btn);
	});
}

function pickChoice(index) {
	if (state !== "choosing") return;
	if (window.lirienAnalytics) {
		// Capture the count BEFORE choosing — currentChoices is gone after.
		const total = (story && story.currentChoices) ? story.currentChoices.length : null;
		window.lirienAnalytics.track("choice_taken", {
			bg: currentBgName || null,
			chapter: currentChapterName || null,
			choice_index: index,
			choices_total: total
		});
	}
	story.ChooseChoiceIndex(index);
	$choices.classList.remove("visible");
	$choices.innerHTML = "";
	document.body.classList.remove("is-choosing");
	state = "idle";
	advance();
}

// ----- continue hint + offline gate -----
//
// The continue chevron is the "you can advance now" affordance during
// the waiting state. The offline-hint replaces it when the user is
// offline AND advancing would land on a chunk whose bg or music isn't
// in the browser's HTTP cache yet — the user would otherwise see a
// broken-image icon or silence. Only one of the two is shown at a
// time. We don't preempt — if the user has the assets cached (because
// they read this scene before, or prefetched it earlier this session),
// the offline state is invisible and they can keep reading.

let offlineBlocked = false;

function showContinueHint() {
	$continueHint.classList.add("visible");
	$offlineHint.hidden = true;
}
function hideContinueHint() {
	$continueHint.classList.remove("visible");
}

function showOfflineBlock() {
	if (!offlineBlocked && window.lirienAnalytics) {
		window.lirienAnalytics.track("offline_block", {
			bg: currentBgName || null,
			chapter: currentChapterName || null
		});
	}
	offlineBlocked = true;
	$continueHint.classList.remove("visible");
	$offlineHint.hidden = false;
}
function hideOfflineBlock() {
	offlineBlocked = false;
	$offlineHint.hidden = true;
}

// Peek the next chunk without advancing. Returns null if there's
// nothing left, otherwise { bg, music } — either may be null if the
// next chunk doesn't carry that tag.
function peekNextChunkTags() {
	if (!story || !story.canContinue) return null;
	const saved = story.state.toJson();
	let bg = null, music = null;
	try {
		story.Continue();
		for (const raw of story.currentTags || []) {
			const tag = String(raw).trim();
			if (tag.startsWith("bg-cut:"))     bg = tag.slice(7).trim();
			else if (tag.startsWith("bg:"))    bg = tag.slice(3).trim();
			else if (tag.startsWith("music:")) music = tag.slice(6).trim();
		}
	} finally {
		try { story.state.LoadJson(saved); } catch (e) { /* lost — bad */ }
	}
	return { bg, music };
}

// Async: returns true if we're offline AND the next chunk would need
// a bg or music asset that isn't already in the browser's HTTP cache.
// Uses fetch's `cache: only-if-cached` mode to authoritatively check
// the cache without going to network — so a user who read this scene
// in a previous session (and has it on disk) is correctly identified
// as "fine to advance" even though our JS state is fresh.
async function nextChunkWouldBreakOffline() {
	if (navigator.onLine !== false) return false; // navigator.onLine can be undefined; treat as online
	const next = peekNextChunkTags();
	if (!next) return false;
	if (next.bg && !(await isUrlCached(bgUrl(next.bg)))) return true;
	if (next.music
	    && !["silence", "fade_out", "dim"].includes(next.music)
	    && next.music !== currentMusicName
	    && !(await isUrlCached(musicUrl(next.music)))) return true;
	return false;
}

async function isUrlCached(url) {
	try {
		const res = await fetch(url, { cache: "only-if-cached", mode: "same-origin" });
		return res.ok;
	} catch (e) {
		return false;
	}
}

// Decide which hint to show after a chunk reveals. Default is the
// continue chevron; we only override to the offline-hint when the
// async cache check confirms the next swap would fail.
function presentWaitingHintForCurrentState() {
	if (navigator.onLine !== false) {
		// Online — chevron immediately, no async dance needed.
		showContinueHint();
		return;
	}
	// Offline — chevron tentatively, but flip to offline-hint if peek confirms.
	showContinueHint();
	nextChunkWouldBreakOffline().then(broken => {
		if (state !== "waiting") return; // user already advanced or moved on
		if (broken) showOfflineBlock();
	});
}

window.addEventListener("offline", () => {
	if (state === "waiting" && !offlineBlocked) {
		nextChunkWouldBreakOffline().then(broken => {
			if (state === "waiting" && broken) showOfflineBlock();
		});
	}
});
window.addEventListener("online", () => {
	if (offlineBlocked) {
		// Coming back online clears the block; the next user tap will
		// fetch over the network normally. Optionally re-warm prefetch
		// since whatever was waiting is presumably also next-up.
		hideOfflineBlock();
		if (state === "waiting") showContinueHint();
		if (story) prefetchUpcomingBgs(3);
	}
});

// ----- chapter title overlay -----

function clearTranscript() {
	// Match the Godot version's "fresh transcript per chapter" pattern.
	// New chapter = empty prose panel. The chapter overlay lands over
	// the cleared panel; first prose chunk types into a clean surface.
	$proseContent.innerHTML = "";
	$proseContent.scrollTop = 0;
	updateIsScrolled();
}

// Visual-only chapter overlay: parses the spec, paints it, and fades
// it in/out. No transcript clearing or bookmark recording — those are
// the caller's responsibility. Used both by the natural in-flow tag
// handler and by autosave resume (Continue / Return-to-recent), where
// recording a bookmark would land on a stale stateBeforeContinue.
// Per-chapter inner-glow tint. Soft RGBA values picked to match
// each chapter's mood without being explicit. Keyed by the chapter
// NUMBER prefix (in either language); falls back to transparent
// for unknown chapters so the rule no-ops. Steve 2026-05-11: very
// subtle — chapter identity at the perceptual edge.
const CHAPTER_TINTS = {
	// Ch1 — ash and arrival. Cool gray-violet, like the sky's
	// indecision between dawn and dusk.
	"One":   "rgba(160, 162, 178, 0.18)",
	"Uno":   "rgba(160, 162, 178, 0.18)",
	// Ch2 — Solrien's light. Warm violet-gold; the city's glow.
	"Two":   "rgba(196, 162, 220, 0.20)",
	"Dos":   "rgba(196, 162, 220, 0.20)",
	// Ch3 — the day the city breathed. Warmer amber.
	"Three": "rgba(220, 178, 110, 0.22)",
	"Tres":  "rgba(220, 178, 110, 0.22)",
	// Ch4 — the one who waits. Cooler steel-blue; patience.
	"Four":   "rgba(150, 172, 200, 0.20)",
	"Cuatro": "rgba(150, 172, 200, 0.20)",
	// Ch5 — the path beneath the silence. Pale lichen / bone-green;
	// road-memory, old stone, fog, and withheld rooms.
	"Five":  "rgba(154, 184, 150, 0.20)",
	"Cinco": "rgba(154, 184, 150, 0.20)",
};

function showChapterTitleOverlay(spec) {
	// spec is "<num> — <title>", e.g. "One — Ash and Arrival" (en)
	// or "Uno — Ceniza y Llegada" (es).
	const t = (window.lirienT || ((k) => k));
	const prefix = t("lirien.chapter.prefix");
	let numText = "";
	let titleText = spec;
	let numKey = "";  // un-uppercased, for tint lookup
	for (const sep of [" — ", " – ", " - "]) {
		if (spec.indexOf(sep) >= 0) {
			const idx = spec.indexOf(sep);
			numKey = spec.substring(0, idx).trim();
			numText = prefix + " " + numKey.toUpperCase();
			titleText = spec.substring(idx + sep.length).trim();
			break;
		}
	}
	if (numText === "") numText = prefix;

	$chapterTitle.querySelector(".chapter-number").textContent = numText;
	$chapterTitle.querySelector(".chapter-name").textContent = titleText;

	// Apply this chapter's tint to .prose's inner glow via the
	// --chapter-tint custom property. The CSS rule on .prose
	// reads it; default is transparent so unknown chapters do
	// nothing. transition: box-shadow on .prose makes the shift
	// glide rather than snap.
	const tint = CHAPTER_TINTS[numKey] || "transparent";
	document.documentElement.style.setProperty("--chapter-tint", tint);

	if (chapterTimer) clearTimeout(chapterTimer);
	$chapterTitle.classList.add("visible");
	chapterTimer = setTimeout(() => {
		$chapterTitle.classList.remove("visible");
		chapterTimer = null;
	}, CHAPTER_FADE_IN_MS + CHAPTER_HOLD_MS);
}

function showChapterTitle(spec) {
	showChapterTitleOverlay(spec);

	// Clear the prose transcript at chapter boundaries — same as the
	// Godot version's per-chapter fresh-buffer rule.
	clearTranscript();

	// Record (or update) this chapter's bookmark so the Chapters menu
	// reflects where the player has been. Idempotent on repeated visits
	// to the same chapter — see recordChapterBookmark.
	recordChapterBookmark(spec);
}

// ----- backgrounds -----

let currentBgName = "";

// Soft-wait observer. Tracks whether the bg image arrived before or
// after the chunk that triggered its swap finished revealing. We
// only emit bg_late if the load was actually a fresh network fetch
// (transferSize > 0 AND encodedBodySize > 0). Pre-cached images
// whose onload was briefly delayed by browser scheduling/decoding
// never put the reader in a "waiting on the wire" position; they
// just landed a few hundred ms later than ideal. Counting those
// would inflate the chart with non-events. We want only the cases
// where the system asked for an asset right now and it wasn't
// already available locally.
let bgLateState = { name: "", chunkRevealedAt: 0, bgLoadedAt: 0 };

function bgLoadWasFresh(url) {
	try {
		const abs = (typeof window !== "undefined" && window.URL)
			? new URL(url, window.location.href).href
			: url;
		const entries = performance.getEntriesByName(abs);
		if (!entries || entries.length === 0) return false;
		const e = entries[entries.length - 1];
		// Both byte counts > 0 means real network bytes flowed for
		// the body. transferSize=0 is cache hit, encodedBodySize=0
		// with transferSize>0 is a 304 revalidation — neither is a
		// "user waited for the asset" moment.
		return typeof e.transferSize === "number" && e.transferSize > 0
		    && typeof e.encodedBodySize === "number" && e.encodedBodySize > 0;
	} catch (_) {
		return false;
	}
}

function swapBackground(name, opts) {
	// Skip identical reassignment — defensive against rapid advance()
	// calls re-applying the same bg, which would otherwise trigger a
	// fresh decode+composite even though the visible bitmap is unchanged.
	if (name === currentBgName) return;
	const instant = !!(opts && opts.instant);
	const url = bgUrl(name);
	// Reset the soft-wait observer for this bg. Old observation drops
	// silently if the prior bg never finished loading or never had a
	// chunk reveal — both are edge-case shapes (rapid skip, end-of-story).
	bgLateState = { name, chunkRevealedAt: 0, bgLoadedAt: 0 };
	bgCrossfadeGen += 1;
	const gen = bgCrossfadeGen;

	// Always load on the OTHER img (whether soft or instant). On
	// decode-complete we either fade .is-active across (soft) or snap
	// it across with transitions disabled (instant). Loading on the
	// inactive img both paths means the active img keeps showing its
	// bitmap until the new one is fully decoded — no transparent gap.
	const target = (activeBg === $bgA) ? $bgB : $bgA;
	const outgoing = activeBg;

	// Hook load/error before assigning src so analytics can report
	// cache-hit ratio and detect failed fetches (offline, 404, etc).
	// Closing over `gen` also gates the visual crossfade flip on the
	// LATEST swap, not whatever stale request fired this onload.
	target.onload = () => {
		if (window.lirienAnalytics) window.lirienAnalytics.recordAssetLoad("bg", name, url);
		if (bgLateState.name === name) {
			bgLateState.bgLoadedAt = performance.now();
			if (bgLateState.chunkRevealedAt > 0) {
				// Only emit bg_late when the asset was actually fetched
				// fresh from the network. A pre-cached image whose
				// onload fires a few hundred ms after chunk_revealed
				// (browser scheduling, decoding, etc.) didn't put the
				// reader in a "waiting for the wire" position; the
				// previous scene's atmosphere or the prior frame was
				// already on screen when text finished, and the new
				// bg landed almost immediately after. We only count
				// genuine network waits.
				if (bgLoadWasFresh(url)) {
					const lagMs = Math.round(bgLateState.bgLoadedAt - bgLateState.chunkRevealedAt);
					if (lagMs > 0 && window.lirienAnalytics) {
						window.lirienAnalytics.track("bg_late", { bg: name, lag_ms: lagMs });
					}
				}
				bgLateState = { name: "", chunkRevealedAt: 0, bgLoadedAt: 0 };
			}
		}
		// Flip .is-active once the bitmap is decoded so the swap (fade
		// or snap) never reveals a half-painted frame. Guarded by gen
		// so a superseded swap's late onload doesn't pull the rug.
		if (gen !== bgCrossfadeGen) return;
		if (instant) {
			// Hard cut: disable the opacity transition for one frame,
			// then flip is-active. Two rAFs to re-enable so the browser
			// has committed the no-transition paint before we restore.
			target.classList.add("no-bg-transition");
			outgoing.classList.add("no-bg-transition");
			target.classList.add("is-active");
			if (outgoing !== target) outgoing.classList.remove("is-active");
			activeBg = target;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					target.classList.remove("no-bg-transition");
					outgoing.classList.remove("no-bg-transition");
				});
			});
		} else {
			// Soft crossfade: just flip classes; CSS transition handles
			// the 500ms opacity ramp on both elements simultaneously.
			target.classList.add("is-active");
			if (outgoing !== target) outgoing.classList.remove("is-active");
			activeBg = target;
		}
	};
	target.onerror = () => {
		if (window.lirienAnalytics) window.lirienAnalytics.recordAssetError("bg", name, "img onerror");
		// Failed load — drop the observation so a future swap doesn't
		// inherit a stale chunkRevealedAt.
		if (bgLateState.name === name) {
			bgLateState = { name: "", chunkRevealedAt: 0, bgLoadedAt: 0 };
		}
	};

	// Set src on the inactive img; .is-active flips inside the onload
	// handler above once decode completes. Setting img.src instead of
	// CSS background-image gives Safari a clean release-then-decode
	// lifecycle. Browsers also share the decoded bitmap between this
	// img and any prior `new Image()` preload of the same URL, so the
	// prefetch actually pays off here.
	target.src = url;

	currentBgName = name;
	// While shimmer atmosphere is active, glide the cluster to the
	// new scene's anchor point. The CSS transition on
	// .shimmer-cluster handles the smooth move.
	rePositionShimmerCluster(name);
}

// ----- music: HTML5 Audio with Web Audio gain control for crossfade ---
//
// Two HTMLAudioElement nodes; one is "active" (currently playing the
// named track), the other is dormant. On a music swap we play the
// new track on the dormant one and crossfade between them via gain
// nodes. Loop natively via element.loop (no Apple Silicon WAV bug
// since we're using OGG).
//
// Special tag values handled (matching the Godot runner's vocabulary):
//   silence     → drop active to a quiet floor without stopping
//   fade_out    → slow fade to true silence + stop (definitive endings)
//   dim         → moderate floor (track continues quietly)
//   <name>      → if same as current, restore to full volume; else
//                  crossfade to the new track

const MUSIC_VOLUME = 0.50;          // -6 dB equivalent (linear)
const MUSIC_DIM_VOLUME = 0.15;      // -16 dB
const MUSIC_QUIET_VOLUME = 0.08;    // -22 dB ("silence" floor)
const MUSIC_CROSSFADE_S = 2.0;
const MUSIC_RESTORE_FADE_S = 1.5;
const MUSIC_DIM_FADE_S = 6.0;
const MUSIC_QUIET_FADE_S = 1.5;
// Debounce window for actual track swaps (i.e. .src changes on the
// audio elements). Volume-only adjustments (silence/dim/fade_out/same-
// track) bypass this. Without it, rapid scene changes back-to-back-
// triggered .src changes mid-decode, causing audible record-scratch
// artifacts AND piling up decoded buffers in Safari's media decoder.
const MUSIC_SWAP_DEBOUNCE_MS = 300;

let audioCtx = null;
let musicA = null;
let musicB = null;
let activePlayer = null;
let currentMusicName = "";
let userGestured = false;          // first pointerup/keydown flips this true
let pendingMusicName = null;       // music tag that fired before gesture
let musicSwapTimer = null;         // pending debounced track-change timer

function ensureAudioRig() {
	if (audioCtx) return;
	const Ctor = window.AudioContext || window.webkitAudioContext;
	audioCtx = new Ctor();
	musicA = makePlayer();
	musicB = makePlayer();
	activePlayer = musicA;
}

function onFirstUserGesture() {
	// Always reasonable: resume the audio context if it isn't running.
	// iOS auto-suspends on background; running this on every tap (not
	// just the first) means any prose-panel interaction is a chance to
	// re-engage audio if it stalled. Belt-and-braces alongside the
	// visibility/focus handlers below.
	if (audioCtx && audioCtx.state !== "running") {
		const p = audioCtx.resume();
		if (p && p.catch) p.catch(() => {});
	}
	if (userGestured) {
		// Already gestured — but iOS may have rejected the original
		// audio.play() if the gesture was synthetic (e.g. the
		// programmatic Continue click that fires after a freshness-
		// driven auto-reload). Each REAL tap is another chance to
		// regain audio focus. ensureMusicPlayingForScene is idempotent
		// (does nothing if audio is already flowing) so this is
		// cheap belt-and-braces. Steve 2026-05-11: music didn't
		// resume after a fresh JS reload-in-place.
		ensureMusicPlayingForScene();
		return;
	}
	userGestured = true;
	ensureAudioRig();
	if (audioCtx.state === "suspended") audioCtx.resume();
	if (settings.musicOn && pendingMusicName) {
		const n = pendingMusicName;
		pendingMusicName = null;
		swapMusic(n);
	}
}

// When the app comes back from background (iOS standalone PWA: user
// swipes home, locks the screen, switches apps — or any browser tab
// loses focus and returns), the AudioContext gets auto-suspended by
// the system. Sometimes the audio element's src also gets dropped by
// the OS reclaiming the media decoder. Without recovery, music never
// comes back until the user force-quits.
//
// Strategy: ensureMusicPlayingForScene() is the single idempotent
// "make the right track play" entry point. It checks audio state
// and src, and re-engages swapMusic() if anything's missing. Called
// from visibility/focus/pageshow handlers, from a periodic health
// poll while music is enabled, and from the music-toggle on path.
function ensureMusicPlayingForScene() {
	if (!settings.musicOn) return;
	// pendingMusicName holds the last real track requested by ink
	// (set in swapMusic). Use it as the fallback when currentMusicName
	// has been cleared by stopAllMusic / fade_out / dim — those leave
	// pendingMusicName intact specifically so the scene's track can
	// be re-engaged on resume without walking the ink graph.
	const trackName = currentMusicName || pendingMusicName;
	if (!trackName) return;
	if (!audioCtx) return;     // first user gesture hasn't happened yet
	if (!userGestured) return; // browser autoplay policy still applies
	if (audioCtx.state !== "running") {
		const p = audioCtx.resume();
		if (p && p.then) p.then(() => ensureMusicPlayingForScene(), () => {});
		return;
	}
	const ap = activePlayer;
	if (!ap || !ap.el) {
		// No active player — re-engage from scratch via swapMusic.
		// Clear currentMusicName so swapMusic doesn't short-circuit
		// on the same-track-already-playing branch.
		currentMusicName = "";
		swapMusic(trackName);
		return;
	}
	// Active player exists but its src may have been dropped by the
	// OS (iOS reclaims media decoders aggressively when the app is
	// backgrounded). If src is empty or playback is stopped, restart.
	if (!ap.el.src || ap.el.paused || ap.el.ended) {
		currentMusicName = "";
		swapMusic(trackName);
		return;
	}
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") ensureMusicPlayingForScene();
});
// pageshow fires when the page is restored from bfcache (iOS Safari
// back-forward cache, and some standalone PWA resume paths).
window.addEventListener("pageshow", () => ensureMusicPlayingForScene());
// focus is a third belt — covers the case where the tab regains
// focus without a visibility transition (rare desktop window-manager
// edge cases).
window.addEventListener("focus", ensureMusicPlayingForScene);

// Periodic health poll — visibility/pageshow/focus catch most resume
// paths, but Steve hit a case (iPhone PWA, phone slept overnight)
// where music didn't come back even after foregrounding the app and
// reading several paragraphs. The poll is the safety net: every 8s
// while music is enabled, re-check that the active player has src
// + isn't paused, and re-engage if not. Cheap (one paused-check per
// tick) and only runs while music is on.
const MUSIC_HEALTH_POLL_MS = 8000;
let musicHealthPollId = 0;
function startMusicHealthPoll() {
	if (musicHealthPollId) return;
	musicHealthPollId = setInterval(ensureMusicPlayingForScene, MUSIC_HEALTH_POLL_MS);
}
function stopMusicHealthPoll() {
	if (!musicHealthPollId) return;
	clearInterval(musicHealthPollId);
	musicHealthPollId = 0;
}
if (settings.musicOn) startMusicHealthPoll();

function stopAllMusic() {
	// Pause both players and release their decoded buffers. Keep
	// `pendingMusicName` so toggling music back on re-engages the
	// scene's current track.
	currentMusicName = "";
	if (musicSwapTimer) { clearTimeout(musicSwapTimer); musicSwapTimer = null; }
	if (musicA) { fadeGain(musicA, 0, 0.4); setTimeout(() => releasePlayerSrc(musicA), 500); }
	if (musicB) { fadeGain(musicB, 0, 0.4); setTimeout(() => releasePlayerSrc(musicB), 500); }
}

function makePlayer() {
	// Same-origin audio — no crossOrigin set; createMediaElementSource
	// works fine for same-origin sources without CORS headers.
	const el = new Audio();
	el.loop = true;
	el.preload = "auto";
	const src = audioCtx.createMediaElementSource(el);
	const gain = audioCtx.createGain();
	gain.gain.value = 0;
	src.connect(gain).connect(audioCtx.destination);
	return { el, gain };
}

function fadeGain(player, target, durSec) {
	if (!player) return;
	const now = audioCtx.currentTime;
	player.gain.gain.cancelScheduledValues(now);
	player.gain.gain.setValueAtTime(player.gain.gain.value, now);
	player.gain.gain.linearRampToValueAtTime(target, now + Math.max(0.01, durSec));
}

function swapMusic(name) {
	// Remember any real track name regardless of mute/gesture state, so
	// "music on" later can re-engage the right track for the scene.
	if (name && name !== "silence" && name !== "fade_out" && name !== "dim") {
		pendingMusicName = name;
	}
	// Music is off in settings: drop the playback request.
	if (!settings.musicOn) return;
	// Browser autoplay policy blocks audio.play() until a real user
	// gesture has happened. The pending name will be replayed from
	// onFirstUserGesture() when a tap/key fires.
	if (!userGestured) return;
	ensureAudioRig();
	if (audioCtx.state === "suspended") audioCtx.resume();

	// Volume-only adjustments fire immediately — they don't change
	// any element's src, so they're cheap and don't risk a leak.
	if (name === "silence") {
		fadeGain(activePlayer, MUSIC_QUIET_VOLUME, MUSIC_QUIET_FADE_S);
		return;
	}
	if (name === "fade_out") {
		currentMusicName = "";
		fadeGain(activePlayer, 0, 4.0);
		setTimeout(() => releasePlayerSrc(activePlayer), 4100);
		return;
	}
	if (name === "dim") {
		fadeGain(activePlayer, MUSIC_DIM_VOLUME, MUSIC_DIM_FADE_S);
		return;
	}

	// Same track requested again: restore to full volume.
	if (name === currentMusicName) {
		if (activePlayer && !activePlayer.el.paused && activePlayer.gain.gain.value < MUSIC_VOLUME - 0.01) {
			fadeGain(activePlayer, MUSIC_VOLUME, MUSIC_RESTORE_FADE_S);
		}
		return;
	}

	// Different track. Normally debounce so rapid scene changes
	// don't trigger back-to-back .src changes on the audio elements
	// (that's what produced the audible record-scratch and ballooned
	// the media decoder). But on the FIRST swap after a fresh load
	// (currentMusicName === "" because nothing has actually played
	// yet), the debounce pushes audio.play() past iOS's user-gesture
	// autoplay window and the play silently rejects → silence on
	// reload at chapter end. Skip the debounce when there's nothing
	// to coalesce against. Steve 2026-05-11.
	if (musicSwapTimer) clearTimeout(musicSwapTimer);
	if (!currentMusicName) {
		musicSwapTimer = null;
		applyMusicTrackChange(name);
		return;
	}
	musicSwapTimer = setTimeout(() => {
		musicSwapTimer = null;
		// Use pendingMusicName in case it changed during the debounce
		// window (later request supersedes this one).
		applyMusicTrackChange(pendingMusicName);
	}, MUSIC_SWAP_DEBOUNCE_MS);
}

function applyMusicTrackChange(name) {
	if (!name || name === currentMusicName) return;
	if (!audioCtx) return;
	currentMusicName = name;
	const url = musicUrl(name);
	const outgoing = activePlayer;
	const incoming = (outgoing === musicA) ? musicB : musicA;

	// Pin incoming's gain to 0 BEFORE changing src. Without this, if
	// incoming was still ramping from a recent prior crossfade (e.g.
	// it was outgoing 1.5s ago and the 2.0s fade hasn't completed),
	// its gain is at some small-but-nonzero value when we yank the
	// src — producing an audible click as the MediaElementSource
	// emits the transition. cancelScheduledValues + setValueAtTime
	// is the only way to actually override an in-flight linearRamp.
	const now = audioCtx.currentTime;
	incoming.gain.gain.cancelScheduledValues(now);
	incoming.gain.gain.setValueAtTime(0, now);

	incoming.el.src = url;
	const playStartedAt = performance.now();
	const playPromise = incoming.el.play();
	activePlayer = incoming;

	// Gate the crossfade on play() actually resolving. If we faded
	// outgoing to 0 immediately and incoming hadn't buffered yet
	// (cold fetch on a slow connection, or on localhost via the dev
	// server when no-store defeats the preload), the user heard the
	// old track fade out, then silence for several seconds, then the
	// new track snap in at full volume. By aligning the fades to the
	// moment audio actually starts flowing, the old track holds at
	// full volume during any buffering wait — so the worst case is
	// "old track plays a beat longer" instead of "audible silence."
	const startCrossfade = () => {
		fadeGain(outgoing, 0, MUSIC_CROSSFADE_S);
		fadeGain(incoming, MUSIC_VOLUME, MUSIC_CROSSFADE_S);
		setTimeout(() => {
			if (outgoing && outgoing.el && outgoing !== activePlayer) {
				outgoing.el.pause();
				// Explicitly release the decoded buffer so Safari's media
				// decoder doesn't accumulate. Without this the outgoing
				// element holds onto its prior track until GC, and rapid
				// swaps over a session bloat the GPU/Media process.
				releasePlayerSrc(outgoing);
			}
		}, (MUSIC_CROSSFADE_S * 1000) + 100);
	};

	if (playPromise) {
		playPromise.then(() => {
			const lagMs = Math.round(performance.now() - playStartedAt);
			startCrossfade();
			if (window.lirienAnalytics) {
				window.lirienAnalytics.recordAssetLoad("music", name, url);
				// music_late mirrors bg_late: only fires when the user
				// actually waited on the wire. Below the ready threshold
				// is "instant" by user perception — counting those would
				// inflate the chart with non-events.
				if (lagMs > 100) {
					window.lirienAnalytics.track("music_late", { music: name, lag_ms: lagMs });
				}
			}
		}).catch((err) => {
			// Autoplay blocked is normal pre-gesture — outgoing keeps
			// playing in that case (we never started its fade). Real
			// errors get logged. Either way: don't crossfade into
			// silence.
			if (window.lirienAnalytics && err && err.name !== "NotAllowedError") {
				window.lirienAnalytics.recordAssetError("music", name, err.message || err.name);
			}
		});
	} else {
		// No promise (very old browsers) — fall back to the old behavior:
		// start the crossfade immediately and hope for the best. This
		// path is essentially unreachable on browsers we support.
		startCrossfade();
	}
}

// Tell the audio element to drop its current resource. The pause+
// removeAttribute+load sequence is the documented way to free a
// decoded media buffer; setting src to a new URL later will trigger
// a fresh load with no leftover state. Muting the gain first guards
// against any output click during the load() reset.
function releasePlayerSrc(player) {
	if (!player || !player.el) return;
	try {
		if (audioCtx && player.gain) {
			const now = audioCtx.currentTime;
			player.gain.gain.cancelScheduledValues(now);
			player.gain.gain.setValueAtTime(0, now);
		}
		player.el.pause();
		player.el.removeAttribute("src");
		player.el.load();
	} catch (e) { /* element may already be in error state — ignore */ }
}

// ----- tag dispatch -----

function applyTags(tags) {
	// First pass: bg/music/atmosphere/fx + capture the chapter spec
	// to handle in a second pass. Chapter handling must run AFTER
	// the other state-bearing tags so recordChapterBookmark() sees
	// the FRESH bg/music/atmosphere (the ones this knot's entry is
	// supposed to use), not the previous chapter's last-frame state.
	// Steve 2026-05-12: jumping to Chapter N was loading the previous
	// chapter's last bg because the bookmark captured currentBgName
	// before bg: had been processed in this same applyTags call.
	let pendingChapter = null;
	for (const raw of tags) {
		const tag = String(raw).trim();
		if (tag.startsWith("bg-cut:"))          swapBackground(tag.slice(7).trim(), { instant: true });
		else if (tag.startsWith("bg:"))         swapBackground(tag.slice(3).trim());
		else if (tag.startsWith("music:"))      swapMusic(tag.slice(6).trim());
		else if (tag.startsWith("chapter:"))    pendingChapter = tag.slice(8).trim();
		else if (tag.startsWith("atmosphere:")) setAtmosphere(tag.slice(11).trim());
		else if (tag.startsWith("fx:"))         fireFx(tag.slice(3).trim());
		else if (tag === "transition")          { /* TODO: shimmer dissolve */ }
		// portrait_left / portrait_right / portrait_clear can be wired
		// later when the new game adds them.
	}
	// Second pass: chapter title + bookmark, with the bookmark now
	// capturing the just-applied bg/music/atmosphere for this chapter
	// (not the trailing state from the previous chapter).
	if (pendingChapter) showChapterTitle(pendingChapter);
}

// ----- atmosphere + fx layer -----
//
// # atmosphere: <name>  → sets a sustained ambient state
//   - "ash-falling" spawns N drifting CSS-animated ash particles
//   - "clear" / "off" / "" / "none" fades the layer out and clears
// # fx: <name>          → fires a one-shot effect
//   - "shimmer" plays the .shimmer-fx pulse animation
//
// Particles are CSS-animated via per-element custom properties so
// the main thread stays free for ink/audio scheduling. Negative
// animation-delay starts each particle partway through its fall
// cycle, so the screen fills immediately rather than top-down.

let currentAtmosphere = null;

function spawnAshParticles(count) {
	if (!$atmosphereLayer) return;
	const frag = document.createDocumentFragment();
	for (let i = 0; i < count; i++) {
		const p = document.createElement("div");
		p.className = "ash-particle";
		const dur = 10 + Math.random() * 9;
		p.style.setProperty("--x",       `${Math.random() * 100}%`);
		// Bumped 3-7px (was 2-5) and brighter halo so they actually
		// register against the dark prose background. Echoes-like
		// presence without going full snowstorm.
		p.style.setProperty("--size",    `${(3 + Math.random() * 4).toFixed(1)}px`);
		p.style.setProperty("--opacity", (0.45 + Math.random() * 0.40).toFixed(2));
		p.style.setProperty("--dur",     `${dur.toFixed(1)}s`);
		// Negative delay → particle is already partway through its
		// fall cycle on first paint, screen fills instantly.
		p.style.setProperty("--delay",   `-${(Math.random() * dur).toFixed(1)}s`);
		// Small horizontal drift so particles read as ASH (slightly
		// fluttering) rather than rain (perfectly vertical).
		p.style.setProperty("--drift",   `${((Math.random() - 0.5) * 30).toFixed(0)}px`);
		// Larger halo — gives each particle a soft glow rather than
		// a hard pixel, the same trick echoes motes use.
		p.style.setProperty("--glow",    `${(4 + Math.random() * 5).toFixed(1)}px`);
		frag.appendChild(p);
	}
	$atmosphereLayer.appendChild(frag);
}

// Light motes — chapter 2's "small motes of light drifted upward
// from the ground". Fewer than ash (40 vs 70), each more
// substantial: bigger size, brighter halo, slower-rising, with
// stronger horizontal drift so they sway as they ascend. Mote
// elements use the same animation-delay trick to fill the screen
// instantly rather than spending the full cycle warming up.
// Sparse pale motes for # atmosphere: dream. Fewer than light-motes
// (8-12 vs 40), drifting more slowly (24-34s vs 14-24s), with a wider
// drift radius — they wander across larger distances over their
// lifetime, reinforcing the "different rules of air" feel. Distinct
// from light-motes (which rise) and shimmer (which spirals): dream
// motes meander.
function spawnDreamMotes(count) {
	if (!$atmosphereLayer) return;
	const frag = document.createDocumentFragment();
	for (let i = 0; i < count; i++) {
		const p = document.createElement("div");
		p.className = "dream-mote";
		const dur = 24 + Math.random() * 10;
		p.style.setProperty("--x",        `${10 + Math.random() * 80}%`);
		p.style.setProperty("--y",        `${20 + Math.random() * 50}%`);
		p.style.setProperty("--size",     `${(4 + Math.random() * 4).toFixed(1)}px`);
		p.style.setProperty("--dur",      `${dur.toFixed(1)}s`);
		// Negative delay so each mote starts at a random point in its
		// drift cycle — otherwise all 10 motes would fade in/out in
		// sync, which reads as mechanical.
		p.style.setProperty("--delay",    `-${(Math.random() * dur).toFixed(1)}s`);
		// Drift vector: per-mote x/y delta in pixels over half the cycle.
		// Range chosen so motes wander noticeably but stay roughly in
		// their "zone" — they don't fly across the whole screen.
		p.style.setProperty("--drift-x",  `${((Math.random() - 0.5) * 90).toFixed(0)}px`);
		p.style.setProperty("--drift-y",  `${((Math.random() - 0.5) * 40 - 6).toFixed(0)}px`);
		frag.appendChild(p);
	}
	$atmosphereLayer.appendChild(frag);
}

function spawnLightMotes(count) {
	if (!$atmosphereLayer) return;
	const frag = document.createDocumentFragment();
	for (let i = 0; i < count; i++) {
		const p = document.createElement("div");
		p.className = "light-mote";
		const dur = 14 + Math.random() * 10;
		p.style.setProperty("--x",       `${Math.random() * 100}%`);
		// Bumped to echoes-mote sizing: 5-9px size with 8-14px halo.
		// Each mote is a clear, present "presence" (manuscript:
		// "small motes of light drifted upward from the ground,
		// slow and without urgency").
		p.style.setProperty("--size",    `${(5 + Math.random() * 4).toFixed(1)}px`);
		p.style.setProperty("--opacity", (0.55 + Math.random() * 0.40).toFixed(2));
		p.style.setProperty("--dur",     `${dur.toFixed(1)}s`);
		p.style.setProperty("--delay",   `-${(Math.random() * dur).toFixed(1)}s`);
		p.style.setProperty("--drift",   `${((Math.random() - 0.5) * 60).toFixed(0)}px`);
		p.style.setProperty("--glow",    `${(8 + Math.random() * 6).toFixed(1)}px`);
		frag.appendChild(p);
	}
	$atmosphereLayer.appendChild(frag);
}

// Shimmer-presence particles — sparkly gold, each spirals outward
// from its own random anchor, ~60 of them at varied radii / speeds
// / start angles so the swarm doesn't feel like a metronome. The
// outward spiral matches Lirien's spiral-shaped magic system. Used
// for the "shimmer is in the air" atmosphere (NOT the one-shot
// flash, which is fireFx("shimmer") / $shimmerFx).
// Anchor lookup populated at boot from /lirien/shimmer_anchors.json.
// Each entry: { x: 0-100, y: 0-100 } where x/y are percentages of
// the bg image's natural size. Used to position the shimmer cluster
// at the brightest point of each scene rather than a random spot.
// Regenerate with: python3 tools/shimmer_anchors.py
let SHIMMER_ANCHORS = {};
fetch("shimmer_anchors.json?v=" + ASSET_VERSION)
	.then(r => r.ok ? r.json() : null)
	.then(d => { if (d) SHIMMER_ANCHORS = d; })
	.catch(() => { /* missing manifest — fall back to centered cluster */ });

function shimmerAnchorFor(bgName) {
	const a = SHIMMER_ANCHORS[bgName];
	if (a && typeof a.x === "number" && typeof a.y === "number") return a;
	// Fallback: roughly centered, upper half. Light randomization
	// so consecutive shimmer scenes don't pin to the exact same
	// spot when there's no manifest entry.
	return {
		x: 28 + Math.random() * 40,  // 28-68%
		y: 30 + Math.random() * 25,  // 30-55%
	};
}

let $shimmerCluster = null;  // current cluster element (or null)

// Shimmer glyph — one shape only. Steve 2026-05-11: the earlier
// mix read as snowflakes; sticking to a single four-point star
// keeps the look consistent with fairy-dust rather than wintery.
const SHIMMER_GLYPH = "✦";

// Synchronized motion params for the HEAD-ON SPIRAL view.
// Each mote spawns at the cluster center and spirals OUTWARD CCW
// over its lifetime, fading as it reaches the outer edge.
// Steve 2026-05-11 polish: bumped spiral-dur 14s → 22s and count
// 22 → 36 to slow rotation AND tighten the visible arm. At the
// previous 14s × 3 revs the rotation was too brisk (~4.7s/rev);
// now each revolution takes ~7.3s. Higher count + tighter max-r
// range means ~12 particles per revolution following the same
// arm closely — the spiral reads as a continuous curve rather
// than discrete sparkles.
//
//   • spiral-dur 22s         → slow lazy expansion
//   • CSS keyframe: -1080deg → 3 full revolutions per life
//   • per-particle max-r     → 65-95px (tighter than 60-100)
//   • count 36               → ~12 particles per revolution
// Lifetime / rotation speed dialed in over several passes — final
// per Steve 2026-05-11: 64s lifetime = ~21s per revolution
// (3 revs per life). Reads as a true lazy drift rather than a
// deliberate spin; the eye registers the spiral shape from the
// distribution of particles along the arm, not from any single
// particle's motion across a frame.
const SHIMMER_SPIRAL_DUR = 64;  // seconds — center→edge lifetime

// When the bg changes WHILE shimmer is the active atmosphere, glide
// the existing cluster to the new scene's anchor rather than killing
// + respawning. CSS transition on .shimmer-cluster's left/top
// (5s ease-in-out) handles the smooth drift.
//
// Set left/top DIRECTLY (not via CSS custom-property indirection).
// CSS transitions on `left`/`top` only reliably trigger from direct
// value changes; custom-property changes that flow through var()
// don't always animate across engines. Steve 2026-05-11: previous
// via-var setup was reading as a jerky snap.
function rePositionShimmerCluster(bgName) {
	if (!$shimmerCluster) return;
	if (currentAtmosphere !== "shimmer") return;
	const a = shimmerAnchorFor(bgName);
	$shimmerCluster.style.left = a.x.toFixed(1) + "%";
	$shimmerCluster.style.top  = a.y.toFixed(1) + "%";
}

function spawnShimmerParticles(count) {
	if (!$atmosphereLayer) return;
	// Single localized cluster — Steve's "dust devil" mental model.
	// All particles share a single anchor; the swarm is a clump
	// not a screen-wide ambient. Composition gives the spiral
	// motion: the wrapper "rises" (translateY + opacity in/out)
	// while the inner dot orbits the wrapper's origin.
	const cluster = document.createElement("div");
	cluster.className = "shimmer-cluster";
	// Position the cluster at the brightest spot of the current
	// bg (from shimmer_anchors.json) so the fairy dust appears
	// where the scene's light naturally pools. Falls back to a
	// reasonable centered-upper position if no manifest entry.
	const anchor = shimmerAnchorFor(currentBgName);
	cluster.style.left = anchor.x.toFixed(1) + "%";
	cluster.style.top  = anchor.y.toFixed(1) + "%";
	$shimmerCluster = cluster;
	// Phase-slot size for jitter: ~1/3 of the spacing between
	// consecutive particles. Breaks exact lockstep while keeping
	// the spiral path coherent.
	const jitterFrac = 0.33 / count;
	for (let i = 0; i < count; i++) {
		// Phase position 0..1 — distributes each particle along the
		// shared spiral-life cycle. Jitter breaks exact lockstep so
		// neighbours don't trace the same path at the same offset.
		const jitter = (Math.random() - 0.5) * jitterFrac * 2;
		const phase = (i / count + jitter + 1) % 1;
		// Span carries the star glyph and runs both animations
		// (spiral lifecycle + twinkle color shift).
		const d = document.createElement("span");
		d.className = "shimmer-dot";
		d.textContent = SHIMMER_GLYPH;
		// Glyph font-size 10-17px — slightly smaller than the
		// previous 13-22 range. Steve 2026-05-11: "slightly
		// smaller will make it less distracting." Screen blend
		// keeps them visible at this reduced size.
		d.style.setProperty("--size",           (10 + Math.random() * 7).toFixed(1) + "px");
		d.style.setProperty("--glow",           (8 + Math.random() * 7).toFixed(1) + "px");
		// Per-particle max-r 65-95px (tighter than the previous
		// 60-100 range) so all particles trace closely-matching
		// spiral arms — the eye reads them as one continuous
		// curve rather than a fuzzy cloud.
		d.style.setProperty("--max-r",          (65 + Math.random() * 30).toFixed(0) + "px");
		// Peak opacity varies — some are dim ghosts, some catch
		// the light fully. Visual depth, again.
		d.style.setProperty("--peak-opacity",   (0.65 + Math.random() * 0.30).toFixed(2));
		// Spiral lifecycle: each particle spawns at center,
		// spirals out CCW, fades at edge. Shared duration; the
		// phase-distributed (+ jittered) delay places each at a
		// different point along the spiral.
		d.style.setProperty("--spiral-dur",     SHIMMER_SPIRAL_DUR + "s");
		d.style.setProperty("--spiral-delay",   "-" + (phase * SHIMMER_SPIRAL_DUR).toFixed(2) + "s");
		// Twinkle: color only (not opacity — the spiral animation
		// owns opacity for the lifecycle). 1.8-4s per cycle on a
		// random per-particle schedule.
		const twinkleDur = 1.8 + Math.random() * 2.2;
		d.style.setProperty("--twinkle-dur",    twinkleDur.toFixed(1) + "s");
		d.style.setProperty("--twinkle-delay",  "-" + (Math.random() * twinkleDur).toFixed(1) + "s");
		cluster.appendChild(d);
	}
	$atmosphereLayer.appendChild(cluster);
}

// Monotonically-increasing token used to guard async atmosphere
// transitions. If another setAtmosphere() runs before the previous
// fade completes, the pending callback bails.
let atmosphereGen = 0;
// Fade-out duration in ms — matches .atmosphere-layer's 3.5s CSS
// transition plus a 100ms grace before swapping the DOM.
const ATMOSPHERE_FADE_MS = 3600;

function spawnAtmosphereFor(name) {
	if (name === "ash-falling")      spawnAshParticles(70);
	else if (name === "light-motes") spawnLightMotes(40);
	else if (name === "shimmer")     spawnShimmerParticles(36);
	else if (name === "dream")       spawnDreamMotes(10);
}

function setAtmosphere(name) {
	if (!$atmosphereLayer) return;
	name = (name || "").trim();
	const shouldClear = !name || name === "clear" || name === "off" || name === "none";
	const targetName = shouldClear ? null : name;
	if (targetName === currentAtmosphere) return;

	atmosphereGen++;
	const myGen = atmosphereGen;
	const wasAt = currentAtmosphere;
	currentAtmosphere = targetName;

	// body.is-dream drives page-wide visual treatment for the
	// # atmosphere: dream beats (bg hue-rotate + saturate + breathing
	// + vignette overlay). CSS handles the fade in/out via 2.5s
	// transitions, so just toggle the class — no JS animation needed.
	if (targetName === "dream") document.body.classList.add("is-dream");
	else document.body.classList.remove("is-dream");

	const swap = () => {
		if (myGen !== atmosphereGen) return;  // superseded
		$atmosphereLayer.innerHTML = "";
		if (targetName) {
			spawnAtmosphereFor(targetName);
			// rAF gives the freshly-appended particles a frame to
			// start their per-element animations before we trigger
			// the layer-level fade-in.
			requestAnimationFrame(() => {
				if (myGen !== atmosphereGen) return;
				$atmosphereLayer.classList.add("is-active");
			});
		}
	};

	if (wasAt) {
		// There was an atmosphere — fade it OUT first, then swap.
		// The CSS opacity transition (3.5s) handles the fade; the
		// timeout matches plus a 100ms grace. Steve 2026-05-11:
		// "It's never really gone in the worldlore, just sometimes
		// makes itself visible" — transitions should fade, not snap.
		$atmosphereLayer.classList.remove("is-active");
		$shimmerCluster = null;
		setTimeout(swap, ATMOSPHERE_FADE_MS);
	} else {
		// First atmosphere of the session — no out-phase needed.
		// Spawn immediately so the user sees the effect right away
		// (the CSS opacity transition handles the fade-IN to full
		// visibility).
		$shimmerCluster = null;
		swap();
	}
}

const $resonanceFx = document.getElementById("resonance-fx");
const $proseEl     = document.getElementById("prose");

function fireFx(name) {
	name = (name || "").trim();
	if (name === "shimmer" && $shimmerFx) {
		// One-shot gold ripple (existing). Manuscript: # fx: shimmer
		// at moments where the world literally shimmers (Ch1
		// displacement, horizon recognition, glyph awakening).
		$shimmerFx.classList.remove("is-firing");
		void $shimmerFx.offsetWidth;
		$shimmerFx.classList.add("is-firing");
	} else if (name === "resonance" && $resonanceFx) {
		// One-shot warm halo expanding outward, anchored at the
		// current shimmer cluster (if active) or screen center.
		// Manuscript: # fx: resonance for the glyph-recognition
		// beats — palm warming when the stump's spiral answers,
		// the pool absorbing the name, etc.
		const cx = $shimmerCluster ? $shimmerCluster.style.left || "50%" : "50%";
		const cy = $shimmerCluster ? $shimmerCluster.style.top  || "50%" : "50%";
		$resonanceFx.style.left = cx;
		$resonanceFx.style.top  = cy;
		$resonanceFx.classList.remove("is-firing");
		void $resonanceFx.offsetWidth;
		$resonanceFx.classList.add("is-firing");
	} else if (name === "hollow" && $proseEl) {
		// One-shot heartbeat thump on the prose panel — Aerin's
		// hollow under the ribs, briefly literalized. Used very
		// sparingly: 3-4 manuscript moments where the hollow is
		// named directly.
		$proseEl.classList.remove("is-hollow-pulsing");
		void $proseEl.offsetWidth;
		$proseEl.classList.add("is-hollow-pulsing");
	}
}

if ($shimmerFx) {
	$shimmerFx.addEventListener("animationend", (ev) => {
		if (ev.animationName === "shimmer-pulse") {
			$shimmerFx.classList.remove("is-firing");
		}
	});
}
if ($resonanceFx) {
	$resonanceFx.addEventListener("animationend", (ev) => {
		if (ev.animationName === "resonance-pulse") {
			$resonanceFx.classList.remove("is-firing");
		}
	});
}
if ($proseEl) {
	$proseEl.addEventListener("animationend", (ev) => {
		if (ev.animationName === "hollow-pulse") {
			$proseEl.classList.remove("is-hollow-pulsing");
		}
	});
}

// ----- input: tap-to-advance / skip ------

function bindAdvanceInput() {
	// Tap on the prose panel (anywhere not on a choice button or the
	// settings menu) advances. During typing it skips to the end of
	// the chunk; during waiting it advances to the next chunk.
	const handler = (ev) => {
		// First gesture unlocks audio and replays any queued music tag.
		// Do this before any early returns so opening settings or
		// tapping a choice still satisfies browser autoplay policy.
		onFirstUserGesture();

		// Ignore taps that originate from a choice button, the menu
		// button or its slide-out drawer, the title's Continue, dev
		// panel, etc. Buttons handle their own click events.
		// Steve 2026-05-11: legacy `.settings-panel` / `.chapters-panel`
		// selectors are dead — those got merged into `.drawer` /
		// `.menu-drawer`. Without `.drawer` in the exclusion list,
		// every tap inside the slide-out menu (e.g. picking a chapter,
		// changing image quality) was also firing the prose-advance.
		if (ev.target.closest(".choice")) return;
		if (ev.target.closest(".menu-btn") || ev.target.closest(".drawer")) return;
		if (ev.target.closest(".settings-btn") || ev.target.closest(".settings-panel")) return;
		if (ev.target.closest(".chapters-btn") || ev.target.closest(".chapters-panel")) return;
		if (ev.target.closest(".drawer-scrim")) return;
		if (ev.target.closest(".title-continue")) return;
		if (ev.target.closest(".confirm-dialog")) return;
		if (ev.target.closest(".install-splash")) return;
		// End-of-story notify-me prompt is rendered inside .prose-content
		// but its inputs/buttons should not trigger advance().
		if (ev.target.closest(".reader-notify")) return;
		// Dev menu open OR a 3-finger tap just fired → don't advance.
		// Without this, opening the dev panel via 3-finger tap also
		// advanced the story (touchstart → toggleDevPanel, then the
		// synthesized click hit the prose tap-handler), which made
		// it impossible to capture the on-screen state Steve wanted
		// to report. The dev panel itself swallows clicks inside it.
		if ($devPanel && !$devPanel.hidden) return;
		if (ev.target.closest(".dev-panel")) return;
		if (Date.now() - lastMultiFingerAt < 600) return;

		// Title screen: first tap dismisses + starts the story. Taps
		// during "title-loading" are ignored (story.json not parsed
		// yet); they still unlock audio via onFirstUserGesture above.
		// When an autosave exists, the title shows only the gold
		// Continue button — taps elsewhere are ignored so a stray
		// tap can't clobber the autosave with a fresh playthrough.
		// (Restart-from-beginning lives in the chapters menu.)
		if (state === "title") {
			if ($titleHint.classList.contains("has-continue")) return;
			state = "idle";
			if (window.lirienAnalytics) {
				window.lirienAnalytics.startSession("fresh", currentSettingsForAnalytics());
				window.lirienAnalytics.setLastState("idle");
			}
			dismissTitleScreen();
			advance();
			return;
		}
		if (state === "title-loading") return;

		if (state === "typing" && currentReveal) {
			currentReveal.skipFn();
			return;
		}
		if (state === "waiting") {
			// If offline AND the next chunk would land on an uncached
			// asset, swallow the tap. The offline-hint is already up;
			// the user just has to wait for connection.
			if (offlineBlocked) return;
			state = "idle";
			hideContinueHint();
			advance();
		}
	};
	// `pointerup` fires for both touch and mouse, exactly once per
	// release. No iOS dual-event mess to debounce.
	document.addEventListener("pointerup", handler);

	// Keyboard advance: Space / Enter
	document.addEventListener("keydown", (ev) => {
		if (ev.code === "Space" || ev.code === "Enter") {
			handler(ev);
			ev.preventDefault();
		}
	});
}

// ----- settings menu -----

function bindSettingsMenu() {
	for (const btn of $settingsPanel.querySelectorAll(".speed-btn")) {
		btn.addEventListener("click", () => {
			const m = parseFloat(btn.dataset.multiplier);
			if (Number.isFinite(m) && m !== settings.speedMultiplier) {
				settings.speedMultiplier = m;
				saveSettings();
				refreshSelectionMarkers();
				if (window.lirienAnalytics) {
					window.lirienAnalytics.track("setting_changed", { key: "speed", value: m });
				}
			}
		});
	}
	for (const btn of $settingsPanel.querySelectorAll(".size-btn")) {
		btn.addEventListener("click", () => {
			const px = parseInt(btn.dataset.size, 10);
			if (Number.isFinite(px) && px !== settings.fontSize) {
				settings.fontSize = px;
				saveSettings();
				applyFontSize();
				refreshSelectionMarkers();
				if (window.lirienAnalytics) {
					window.lirienAnalytics.track("setting_changed", { key: "size", value: px });
				}
			}
		});
	}
	for (const btn of $settingsPanel.querySelectorAll(".music-btn")) {
		btn.addEventListener("click", () => {
			const want = btn.dataset.music === "on";
			if (want === settings.musicOn) return;
			settings.musicOn = want;
			saveSettings();
			refreshSelectionMarkers();
			if (!want) {
				stopAllMusic();
				stopMusicHealthPoll();
			} else {
				// Toggle on: fire ensureMusicPlayingForScene immediately
				// (no waiting for the next 8s poll tick) so the user
				// hears music as soon as they flip the switch. Also
				// kick the periodic health poll so future sleep/wake
				// cycles auto-recover.
				ensureMusicPlayingForScene();
				startMusicHealthPoll();
			}
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track("setting_changed", { key: "music", value: want });
			}
		});
	}
	for (const btn of $settingsPanel.querySelectorAll(".quality-btn")) {
		btn.addEventListener("click", () => {
			const want = btn.dataset.quality;
			if (want !== "high" && want !== "standard") return;
			if (want === settings.imageQuality) return;
			settings.imageQuality = want;
			saveSettings();
			refreshSelectionMarkers();
			// Reload the currently-visible bg in the new format. We
			// stash + clear currentBgName so swapBackground() doesn't
			// short-circuit on the "same name" guard, then rewrite the
			// URL via bgUrl() which now reads the new setting.
			if (currentBgName) {
				const name = currentBgName;
				currentBgName = "";
				swapBackground(name);
			}
			if (window.lirienAnalytics) {
				window.lirienAnalytics.track("setting_changed", { key: "image_quality", value: want });
			}
		});
	}
	refreshSelectionMarkers();
}

// ----- chapters menu -----
//
// Empty shell for now — the chapter list is populated when save/restore
// is wired up. Restart-from-beginning is functional today since it
// just resets the inkjs state and re-runs the start.

function bindChaptersMenu() {
	$restartBtn.addEventListener("click", () => {
		const t = (window.lirienT || ((k) => k));
		showConfirm({
			title: t("lirien.confirm.restart.title"),
			message: t("lirien.confirm.restart.message"),
			confirmLabel: t("lirien.confirm.restart.action"),
			cancelLabel: t("lirien.confirm.cancel"),
		}, () => {
			closeDrawer($chaptersPanel);
			restartFromBeginning();
		});
	});

	$returnRecentBtn.addEventListener("click", () => {
		closeDrawer($chaptersPanel);
		returnToMostRecent();
	});
}

// ----- autosave (persisted to localStorage) -----
//
// Stores a JSON snapshot of inkjs state at the user's most-recent
// natural-progression point. Updated by advance() unless we're in
// exploration mode (jumped to a chapter via the menu). Consumed by
// the title-screen Continue button and the in-panel "Return to
// most recent point" button.

function loadAutosave() {
	try {
		const raw = localStorage.getItem(AUTOSAVE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		// Backwards compat: earlier versions stored only the state JSON
		// string. Treat that as a stateless-of-visuals save.
		if (typeof parsed === "string") {
			return { state: parsed, bg: "", music: "", chapter: "", lastChunk: "" };
		}
		// Older object-shape saves may lack lastChunk; default to "".
		if (typeof parsed.lastChunk !== "string") parsed.lastChunk = "";
		return parsed;
	} catch (e) { return null; }
}

function saveAutosave() {
	if (!story) return;
	try {
		// State alone doesn't capture the visible bg/music — those are
		// set by tags on past Continue() calls and won't re-fire on
		// resume. Persist them explicitly so a Continue/Return shows
		// the correct atmosphere instead of inheriting whatever the
		// user was looking at last (e.g. an exploration chapter).
		// lastChunk gives the resume an anchor of text so the panel
		// isn't blank at end-of-story.
		const blob = {
			state: story.state.toJson(),
			bg: currentBgName,
			music: currentMusicName,
			chapter: currentChapterName,
			atmosphere: currentAtmosphere,
			lastChunk: lastTypedChunk,
		};
		localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(blob));
	} catch (e) { /* quota / private mode — drop silently */ }
}

// Paint a chunk into the prose panel without the typewriter animation.
// Used on resume so the reader sees their last paragraph immediately
// as anchored context. [i]/[/i] markers in the source become <em>.
function renderInstantChunk(text) {
	if (!text) return;
	const paragraph = document.createElement("p");
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\[i\]/g, "<em>")
		.replace(/\[\/i\]/g, "</em>");
	paragraph.innerHTML = escaped;
	$proseContent.appendChild(paragraph);
}

// Centralized restoration so Continue (title screen) and Return-to-recent
// (chapters panel) handle the bg/music/chapter rehydration the same way.
// Fades the chapter title overlay in/out as a visual anchor — without
// it the prose just snaps in mid-text with no sense of where you are.
// Caller is responsible for clearTranscript BEFORE calling this; the
// lastChunk render below depends on a clean prose panel.
function applyAutosaveVisuals(saved) {
	if (!saved) return;
	// Restore is not a transition — the reader was already here. Use
	// an instant cut so the scene snaps into place instead of fading
	// in from blank (which reads as a real bg change). Soft crossfade
	// is reserved for narrative-time `# bg:` tags.
	if (saved.bg)    swapBackground(saved.bg, { instant: true });
	if (saved.music) swapMusic(saved.music);
	if (saved.chapter) {
		currentChapterName = saved.chapter;
		showChapterTitleOverlay(saved.chapter);
	}
	// Atmosphere — set by # atmosphere: tags during narrative flow,
	// doesn't re-fire on resume because LoadJson skips intermediate
	// tags. Without this, a reader who'd seen ash falling came back
	// to a clean (no-particle) viewport. Restore the persisted
	// state so the world keeps its texture across sessions.
	if (saved.atmosphere) setAtmosphere(saved.atmosphere);
	if (saved.lastChunk) {
		// Restore the last paragraph the user saw so they have anchored
		// context. advance() will append the next chunk below if there
		// is one; if not (end-of-story), this is the only text shown.
		renderInstantChunk(saved.lastChunk);
		lastTypedChunk = saved.lastChunk;
	}
}

function clearAutosave() {
	try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
}

function updateReturnRecentVisibility() {
	// Only show the "Return to most recent point" button when there's
	// actually somewhere to return to AND we're currently exploring.
	const hasAutosave = !!loadAutosave();
	$returnRecentBtn.hidden = !(hasAutosave && isExploring);
}

function returnToMostRecent() {
	const saved = loadAutosave();
	if (!story || !saved) return;
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track("chapter_jump", {
			from_bg: currentBgName || null,
			to_chapter: saved.chapter || null,
			source: "return"
		});
	}
	try { story.state.LoadJson(saved.state); }
	catch (e) { console.warn("[autosave] LoadJson failed:", e); return; }
	if (currentReveal && currentReveal.skipFn) currentReveal.skipFn();
	currentReveal = null;
	$choices.innerHTML = "";
	$choices.classList.remove("visible");
	hideContinueHint();
	clearTranscript();
	applyAutosaveVisuals(saved);
	isExploring = false;
	state = "idle";
	advance();
}

// ----- styled confirm dialog -----
//
// Used in place of native confirm() so the destructive prompts match
// the rest of the UI. Single-use modal; rebinds handlers per call so
// the wiring stays self-contained.

function showConfirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel" }, onConfirm) {
	$confirmTitle.textContent = title;
	$confirmMessage.textContent = message;
	$confirmOk.textContent = confirmLabel;
	$confirmCancel.textContent = cancelLabel;
	$confirmDialog.hidden = false;

	const cleanup = () => {
		$confirmDialog.hidden = true;
		$confirmOk.removeEventListener("click", handleOk);
		$confirmCancel.removeEventListener("click", handleCancel);
		document.removeEventListener("keydown", handleKey);
	};
	const handleOk = () => { cleanup(); onConfirm(); };
	const handleCancel = () => { cleanup(); };
	const handleKey = (ev) => {
		if (ev.key === "Escape") { ev.preventDefault(); handleCancel(); }
		else if (ev.key === "Enter") { ev.preventDefault(); handleOk(); }
	};
	$confirmOk.addEventListener("click", handleOk);
	$confirmCancel.addEventListener("click", handleCancel);
	document.addEventListener("keydown", handleKey);
	$confirmOk.focus();
}

// ----- chapter bookmarks (persisted to localStorage) -----
//
// Each bookmark is { name, state }. Name is the chapter spec from the
// chapter: tag (e.g. "One — Ash and Arrival"). State is the inkjs JSON
// snapshot captured the moment that tag was processed, so jumping to
// the bookmark replays the story from just after the chapter break.
//
// Bookmarks are deduped by name: re-encountering a chapter overwrites
// its state with the latest visit's snapshot. That keeps the list
// short and matches "where I last entered chapter X" semantics.

const CHAPTERS_KEY = "lirien.chapters";
const AUTOSAVE_KEY = "lirien.save";

// ----- save schema migration -----
//
// Schema 2 retroactively prefixes all Chapter 1 and Chapter 2 ink
// knot names and bg keys with `chXX_` so they match the convention
// Chapter 3 will be born with. Old saves persisted under schema 1
// reference the un-prefixed names; without migration they would fail
// to restore against the renamed story.json. Migration walks the
// inkjs state JSON and rewrites every dotted-path segment that
// matches the rename map, plus rewrites the outer `bg` field on
// `lirien.save`. Runs once at module load, then writes the new
// schema version key so we never re-migrate. Whole block can be
// deleted once the reader population has been on schema 2 for a
// while — kept here because deleting too early breaks anyone whose
// laptop has been closed for a few weeks.
const SAVE_SCHEMA_VERSION = 2;
const SCHEMA_VERSION_KEY = "lirien.schemaVersion";

const OLD_TO_NEW_NAME = Object.freeze({
	// --- Ch1 knots ---
	"notice_hands":               "ch01_notice_hands",
	"notice_trees":               "ch01_notice_trees",
	"the_displacement":           "ch01_the_displacement",
	"let_move":                   "ch01_let_move",
	"stop_first":                 "ch01_stop_first",
	"the_charcoal":               "ch01_the_charcoal",
	"door_handle":                "ch01_door_handle",
	"door_spiral":                "ch01_door_spiral",
	"the_recognition":            "ch01_the_recognition",
	// --- Ch2 knots ---
	"chapter_two_start":          "ch02_chapter_two_start",
	"stump_reach":                "ch02_stump_reach",
	"stump_study":                "ch02_stump_study",
	"after_stump":                "ch02_after_stump",
	"pool_say":                   "ch02_pool_say",
	"pool_hold":                  "ch02_pool_hold",
	"after_pool":                 "ch02_after_pool",
	"bridge_reason":              "ch02_bridge_reason",
	"bridge_step":                "ch02_bridge_step",
	"after_bridge":               "ch02_after_bridge",
	// --- Ch1 bgs ---
	"aerin_awakens":              "ch01_aerin_awakens",
	"waking":                     "ch01_waking",
	"ash_hollow_panorama":        "ch01_ash_hollow_panorama",
	"hands_inventory":            "ch01_hands_inventory",
	"standing_in_hollow":         "ch01_standing_in_hollow",
	"walking_north":              "ch01_walking_north",
	"walking_examining_hands":    "ch01_walking_examining_hands",
	"fallen_tree_touch":          "ch01_fallen_tree_touch",
	"displacement":               "ch01_displacement",
	"displacement_aftermath":     "ch01_displacement_aftermath",
	"approaching_ring":           "ch01_approaching_ring",
	"charcoal_and_parchment":     "ch01_charcoal_and_parchment",
	"reading_parchment":          "ch01_reading_parchment",
	"hollow_acknowledged":        "ch01_hollow_acknowledged",
	"forehead_to_parchment":      "ch01_forehead_to_parchment",
	"writing_six_words":          "ch01_writing_six_words",
	"parchment_six_words":        "ch01_parchment_six_words",
	"dream_corridor":             "ch01_dream_corridor",
	"handle_door_recognition":    "ch01_handle_door_recognition",
	"spiral_door_almost_touch":   "ch01_spiral_door_almost_touch",
	"presence_chamber":           "ch01_presence_chamber",
	"waking_after_dream":         "ch01_waking_after_dream",
	"aerin_hand_with_glyph_v2":   "ch01_aerin_hand_with_glyph_v2",
	"aerin_glyph_awakened":       "ch01_aerin_glyph_awakened",
	"approach_to_solrien":        "ch01_approach_to_solrien",
	"footprints_glimmer":         "ch01_footprints_glimmer",
	// --- Ch2 bgs ---
	"walk_in_approach":           "ch02_walk_in_approach",
	"stump_spiral":                "ch02_stump_spiral",
	"hills_reveal_gap":           "ch02_hills_reveal_gap",
	"first_sight_solrien":        "ch02_first_sight_solrien",
	"threshold_stones":           "ch02_threshold_stones",
	"threshold_inside":           "ch02_threshold_inside",
	"walking_solrien_streets":    "ch02_walking_solrien_streets",
	"wall_of_glyphs":             "ch02_wall_of_glyphs",
	"wall_recognition_close":     "ch02_wall_recognition_close",
	"pool_arrival":               "ch02_pool_arrival",
	"pool_name":                  "ch02_pool_name",
	"pool_memory_flash":          "ch02_pool_memory_flash",
	"elian_arrives_pool":         "ch02_elian_arrives_pool",
	"walking_with_elian":         "ch02_walking_with_elian",
	"bridge_threads":             "ch02_bridge_threads",
	"bridge_words_too_heavy":     "ch02_bridge_words_too_heavy",
	"plaza_of_motes":             "ch02_plaza_of_motes",
	"map_room_alone":             "ch02_map_room_alone",
	"map_room_thistle":           "ch02_map_room_thistle",
	"archive_establishing":       "ch02_archive_establishing",
	"archive_ink_explosion":      "ch02_archive_ink_explosion",
	"archive_stops_reaching":     "ch02_archive_stops_reaching",
	"archive_plinth_wisdom":      "ch02_archive_plinth_wisdom",
	"archive_we_remember_you":    "ch02_archive_we_remember_you",
	"leaving_archive":            "ch02_leaving_archive",
	"aerin_room_solrien":         "ch02_aerin_room_solrien",
	"aerin_sleeping_room":        "ch02_aerin_sleeping_room",
});

// Inkjs path strings are dotted: "knot.stitch.index" or "knot.0.5".
// Indices are pure numerics, knot/stitch names are identifiers; we
// only rewrite segments that exactly match a key in the map. Indices
// can't collide with names because identifiers can't be all-numeric.
function migrateRenameDottedPath(s) {
	if (typeof s !== "string" || !s) return s;
	const parts = s.split(".");
	for (let i = 0; i < parts.length; i++) {
		if (OLD_TO_NEW_NAME[parts[i]]) parts[i] = OLD_TO_NEW_NAME[parts[i]];
	}
	return parts.join(".");
}

// Walks an inkjs state object tree in place. Path-bearing string
// fields are rewritten by name; visitCounts/turnIndices have their
// keys rewritten because those are also dotted paths into the story.
function migrateInkStateInPlace(node) {
	if (!node) return;
	if (Array.isArray(node)) {
		for (const child of node) migrateInkStateInPlace(child);
		return;
	}
	if (typeof node !== "object") return;
	if (typeof node.cPath === "string")                node.cPath = migrateRenameDottedPath(node.cPath);
	if (typeof node.previousContentObject === "string") node.previousContentObject = migrateRenameDottedPath(node.previousContentObject);
	if (typeof node.targetPath === "string")            node.targetPath = migrateRenameDottedPath(node.targetPath);
	if (node.visitCounts && typeof node.visitCounts === "object") {
		const updated = {};
		for (const k of Object.keys(node.visitCounts)) updated[migrateRenameDottedPath(k)] = node.visitCounts[k];
		node.visitCounts = updated;
	}
	if (node.turnIndices && typeof node.turnIndices === "object") {
		const updated = {};
		for (const k of Object.keys(node.turnIndices)) updated[migrateRenameDottedPath(k)] = node.turnIndices[k];
		node.turnIndices = updated;
	}
	for (const key of Object.keys(node)) {
		const v = node[key];
		if (v !== null && typeof v === "object") migrateInkStateInPlace(v);
	}
}

function migrateInkStateJson(stateJson) {
	if (typeof stateJson !== "string" || !stateJson) return stateJson;
	let parsed;
	try { parsed = JSON.parse(stateJson); } catch (e) { return stateJson; }
	migrateInkStateInPlace(parsed);
	return JSON.stringify(parsed);
}

// One-shot migration of all persisted state. Idempotent — guarded by
// SCHEMA_VERSION_KEY so re-runs are no-ops. If anything throws, we
// drop the saves rather than crash the title screen on next load.
function maybeRunSchemaMigration() {
	let stored = 1;
	try {
		const raw = localStorage.getItem(SCHEMA_VERSION_KEY);
		if (raw) stored = parseInt(raw, 10) || 1;
	} catch (e) { return; }
	if (stored >= SAVE_SCHEMA_VERSION) return;

	try {
		// Autosave: outer wrapper has a `bg` field that needs renaming;
		// inner `state` is the inkjs JSON.
		const rawSave = localStorage.getItem(AUTOSAVE_KEY);
		if (rawSave) {
			const parsed = JSON.parse(rawSave);
			if (typeof parsed === "string") {
				// Legacy string-only save: just an inkjs JSON blob.
				const wrapped = { state: migrateInkStateJson(parsed), bg: "", music: "", chapter: "", lastChunk: "" };
				localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(wrapped));
			} else if (parsed && typeof parsed === "object") {
				if (parsed.bg && OLD_TO_NEW_NAME[parsed.bg]) parsed.bg = OLD_TO_NEW_NAME[parsed.bg];
				if (parsed.state) parsed.state = migrateInkStateJson(parsed.state);
				localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(parsed));
			}
		}

		// Chapter bookmarks: array of { name, state }. `name` is display
		// text from the chapter: tag and is unaffected; `state` is inkjs.
		const rawBookmarks = localStorage.getItem(CHAPTERS_KEY);
		if (rawBookmarks) {
			const arr = JSON.parse(rawBookmarks);
			if (Array.isArray(arr)) {
				for (const b of arr) {
					if (b && typeof b === "object" && b.state) {
						b.state = migrateInkStateJson(b.state);
					}
				}
				localStorage.setItem(CHAPTERS_KEY, JSON.stringify(arr));
			}
		}

		localStorage.setItem(SCHEMA_VERSION_KEY, String(SAVE_SCHEMA_VERSION));
	} catch (e) {
		// Last resort: clear what we couldn't migrate so the title
		// screen doesn't crash trying to restore broken state.
		console.warn("save migration failed; clearing old saves", e);
		try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
		try { localStorage.removeItem(CHAPTERS_KEY); } catch (_) {}
		try { localStorage.setItem(SCHEMA_VERSION_KEY, String(SAVE_SCHEMA_VERSION)); } catch (_) {}
	}
}

maybeRunSchemaMigration();

let chapterBookmarks = loadChapterBookmarks();
let currentChapterName = "";
// Updated in advance() before each Continue(). recordChapterBookmark
// uses this so the bookmark snapshot lands at "just before the chapter
// started emitting" rather than "just after the first chunk emitted."
let stateBeforeContinue = null;
// The most recent chunk text that typeChunk rendered. Persisted with
// the autosave so that resume can paint it back into the prose panel
// — gives the reader anchored context (especially at end-of-story
// where advance() produces no further chunk).
let lastTypedChunk = "";
// Set true when the user jumps to a chapter via the menu. While true,
// advance() does NOT update the autosave — the user's real most-recent
// point stays parked so they can return to it. Cleared on
// restartFromBeginning, returnToMostRecent, and title-screen Continue.
let isExploring = false;

function loadChapterBookmarks() {
	try {
		const raw = localStorage.getItem(CHAPTERS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (e) {
		return [];
	}
}

function saveChapterBookmarks() {
	try { localStorage.setItem(CHAPTERS_KEY, JSON.stringify(chapterBookmarks)); }
	catch (e) { /* quota / private mode — drop silently */ }
}

function recordChapterBookmark(spec) {
	if (!story) return;
	// Use the pre-Continue snapshot so a jump-to-chapter starts BEFORE
	// the chapter:/bg:/music: tags fire — that way Continue() re-emits
	// all of them naturally and the first chunk renders with its bg
	// and music, not just the text.
	const stateJson = stateBeforeContinue;
	if (!stateJson) return;
	// Capture the FULL visual state at bookmark time. Per Steve
	// 2026-05-11: "the system needs to know the current state of
	// things — what effect is active at this moment, is the
	// shimmer there or gone — on reload you don't pass through
	// the file sequentially." Chapter knots that don't have an
	// explicit # atmosphere tag at their entry would otherwise
	// leave the cluster in whatever state it was in pre-jump
	// (or unset on a cold reload), which would be wrong.
	const bookmark = {
		name: spec,
		state: stateJson,
		bg: currentBgName || "",
		music: currentMusicName || "",
		atmosphere: currentAtmosphere || "",
	};
	const idx = chapterBookmarks.findIndex(b => b.name === spec);
	if (idx >= 0) chapterBookmarks[idx] = bookmark;
	else chapterBookmarks.push(bookmark);
	currentChapterName = spec;
	saveChapterBookmarks();
	renderChapterList();
}

// Hook called by the inline i18n module after applyLang. Re-renders
// any content that's built at runtime via lirienT() — chapter list
// (rebuilt from saved bookmarks each time), and the current-
// selection markers on the speed/size/music rows. Without this,
// the bug Steve hit on /echoes/ also bites here: language flips
// but dynamically-rendered drawer content stays in the previous
// language until the next user action.
window.lirienRefreshDynamicLabels = function () {
	if ($chaptersPanel && !$chaptersPanel.hidden && typeof renderChapterList === "function") {
		renderChapterList();
	}
	if (typeof refreshSelectionMarkers === "function") {
		refreshSelectionMarkers();
	}
};

function renderChapterList() {
	$chapterList.innerHTML = "";
	if (chapterBookmarks.length === 0) {
		const empty = document.createElement("div");
		empty.className = "chapter-empty";
		empty.textContent = (window.lirienT || ((k) => k))("lirien.chapter.empty");
		$chapterList.appendChild(empty);
		return;
	}
	for (const b of chapterBookmarks) {
		const btn = document.createElement("button");
		btn.className = "chapter-btn";
		if (b.name === currentChapterName) btn.classList.add("current");
		btn.textContent = b.name;
		btn.addEventListener("click", () => {
			$chaptersPanel.hidden = true;
			jumpToChapter(b);
		});
		$chapterList.appendChild(btn);
	}
}

function jumpToChapter(bookmark) {
	if (!story) return;
	if (window.lirienAnalytics) {
		window.lirienAnalytics.track("chapter_jump", {
			from_bg: currentBgName || null,
			to_chapter: bookmark.name || null,
			source: "menu"
		});
	}
	try { story.state.LoadJson(bookmark.state); }
	catch (e) { console.warn("[chapters] LoadJson failed:", e); return; }
	if (currentReveal && currentReveal.skipFn) currentReveal.skipFn();
	currentReveal = null;
	$choices.innerHTML = "";
	$choices.classList.remove("visible");
	hideContinueHint();
	clearTranscript();
	// Apply the visual state captured at bookmark time BEFORE
	// advancing. The bookmark state is pre-Continue, so the next
	// advance() will re-fire whatever # bg / # music / # atmosphere
	// tags live at the chapter knot's entry — but if the chapter
	// knot doesn't carry an explicit # atmosphere tag (true for Ch3
	// and Ch4), it'd leave the cluster in whatever state it was in
	// pre-jump. Pre-applying from the bookmark prevents that drift.
	// Older bookmarks without these fields fall back to no-op
	// branches (?: "" short-circuits in the setters).
	if (bookmark.bg)         swapBackground(bookmark.bg);
	if (bookmark.music)      swapMusic(bookmark.music);
	if (bookmark.atmosphere) setAtmosphere(bookmark.atmosphere);
	// Enter exploration mode — autosave is now frozen at the user's
	// real most-recent point so they can return to it. The chapters
	// panel will surface a "Return to most recent point" button until
	// they leave exploration mode (return, restart, or title Continue).
	isExploring = true;
	state = "idle";
	// Don't manually call showChapterTitle here — the bookmark state
	// is from BEFORE the chapter: tag fires, so advance()'s next
	// Continue() will naturally re-emit the chapter/bg/music tags
	// (which idempotently re-set what we just applied) and fire
	// showChapterTitle.
	advance();
}

function restartFromBeginning() {
	if (!story) return;
	try { story.ResetState(); } catch (e) { console.warn("ResetState failed", e); return; }
	// Cancel any in-flight reveal timers so they don't fire after the
	// restart and trigger a stray continue-hint or scroll on the new chunk.
	if (currentReveal && currentReveal.skipFn) currentReveal.skipFn();
	currentReveal = null;
	clearTranscript();
	$choices.innerHTML = "";
	$choices.classList.remove("visible");
	hideContinueHint();
	// Clean slate: autosave gone, all chapter bookmarks gone,
	// exploration mode off.
	clearAutosave();
	chapterBookmarks = [];
	currentChapterName = "";
	saveChapterBookmarks();
	renderChapterList();
	isExploring = false;
	state = "idle";
	advance();
}

function refreshSelectionMarkers() {
	for (const btn of $settingsPanel.querySelectorAll(".speed-btn")) {
		const m = parseFloat(btn.dataset.multiplier);
		btn.classList.toggle("current", Math.abs(m - settings.speedMultiplier) < 0.01);
	}
	for (const btn of $settingsPanel.querySelectorAll(".size-btn")) {
		const px = parseInt(btn.dataset.size, 10);
		btn.classList.toggle("current", px === settings.fontSize);
	}
	for (const btn of $settingsPanel.querySelectorAll(".music-btn")) {
		const want = btn.dataset.music === "on";
		btn.classList.toggle("current", want === !!settings.musicOn);
	}
	for (const btn of $settingsPanel.querySelectorAll(".quality-btn")) {
		btn.classList.toggle("current", btn.dataset.quality === settings.imageQuality);
	}
}

// ----- bg image preload (lookahead through choice branches) ---------
//
// Snapshots state, walks the inkjs story forward up to N unique bg
// tags, restores. At choice points all branches are explored so a
// player who taps either choice finds the bg already in browser
// cache. `<img>.src = url` is enough to start a fetch — no need to
// keep the image around; the HTTP cache holds it. Calls are cheap
// after the first since duplicate URLs short-circuit at the browser.

const preloadedBgs = new Set();
const preloadedMusic = new Set();

function preloadImage(url) {
	if (preloadedBgs.has(url)) return;
	preloadedBgs.add(url);
	const img = new Image();
	img.src = url;
}

// Music prefetch via fetch() rather than a hidden <audio>: avoids
// occupying a decoder slot for a track that may not actually play
// for several minutes, while still warming the HTTP cache so the
// real swapMusic() pulls from cache and the audio element starts
// instantly. The "popping sounds" Steve hears come from src-set
// occurring while the file is still being fetched on a slow
// network — pre-warming eliminates that case.
function preloadMusic(url) {
	if (preloadedMusic.has(url)) return;
	preloadedMusic.add(url);
	try {
		fetch(url, { credentials: "omit", priority: "low" }).catch(() => {});
	} catch (e) { /* fetch with priority not supported — fall through */ }
}

function prefetchUpcomingBgs(maxBgs) {
	if (!story) return;
	// Skip the walk entirely once all bgs are already preloaded — at
	// that point the toJson/LoadJson/Continue dance is pure CPU work
	// for no benefit. allBgNames comes from extractBgNames at startup,
	// so we have a known ceiling. (Each preloadedBgs entry is the full
	// versioned URL; the count is what we're matching against.)
	if (allBgNames.length > 0 && preloadedBgs.size >= allBgNames.length) return;
	const seen = new Set();
	// Music swaps less often than bgs, so a single look-ahead is
	// usually enough to cover the next track change. Stop after we've
	// found one upcoming music name that differs from what's playing.
	const musicSeen = new Set();
	const MAX_MUSIC_LOOKAHEAD = 2;

	let savedState;
	try {
		savedState = story.state.toJson();
	} catch (e) { return; }

	const walk = () => {
		while (story.canContinue && seen.size < maxBgs) {
			story.Continue();
			const tags = story.currentTags || [];
			for (const raw of tags) {
				const tag = String(raw).trim();
				if (tag.startsWith("bg:") || tag.startsWith("bg-cut:")) {
					const name = tag.startsWith("bg-cut:") ? tag.slice(7).trim() : tag.slice(3).trim();
					if (name) seen.add(name);
					if (seen.size >= maxBgs) return;
				} else if (tag.startsWith("music:") && musicSeen.size < MAX_MUSIC_LOOKAHEAD) {
					const name = tag.slice(6).trim();
					// Skip pure directives (silence/dim/fade_out) that
					// don't load any new file. Skip the track that's
					// already playing — its bytes are already local.
					if (name && name !== "silence" && name !== "dim" && name !== "fade_out"
					    && name !== currentMusicName) {
						musicSeen.add(name);
					}
				}
			}
		}
		if (seen.size >= maxBgs) return;
		if (story.currentChoices && story.currentChoices.length > 0) {
			let branchSaved;
			try { branchSaved = story.state.toJson(); } catch (e) { return; }
			for (let i = 0; i < story.currentChoices.length && seen.size < maxBgs; i++) {
				try { story.state.LoadJson(branchSaved); } catch (e) { break; }
				try { story.ChooseChoiceIndex(i); } catch (e) { continue; }
				walk();
			}
		}
	};

	try { walk(); } catch (e) { /* swallow: prefetch is best-effort */ }
	try { story.state.LoadJson(savedState); } catch (e) { /* lost — bad */ }

	for (const name of seen) {
		preloadImage(bgUrl(name));
	}
	for (const name of musicSeen) {
		preloadMusic(musicUrl(name));
	}
}

// ----- dev menu (backtick toggles) ----------------------------------
//
// Lists every bg name found in story.json. Selecting one resets the
// story state and fast-forwards (auto-picking choice 0 at branches)
// until the matching bg tag is hit, then renders the chunk that
// carried it. Useful for testing scenes without playing through.

function extractBgNames(parsedJson) {
	// Compiled inkjs tags appear as "^bg: name" — the # is stripped
	// during compilation but the ^ literal-string marker stays.
	// Returns names in first-seen (source) order so the dev list
	// reads roughly like the story; Set preserves insertion order.
	const bgs = new Set();
	const walk = (node) => {
		if (typeof node === "string") {
			if (node.startsWith("^bg:")) {
				const name = node.slice(4).trim();
				if (name) bgs.add(name);
			}
		} else if (Array.isArray(node)) {
			for (const x of node) walk(x);
		} else if (node && typeof node === "object") {
			for (const k in node) walk(node[k]);
		}
	};
	walk(parsedJson);
	return Array.from(bgs);
}

function buildDevList() {
	const filter = ($devSearch.value || "").toLowerCase();
	$devList.innerHTML = "";
	let currentEl = null;
	for (const name of allBgNames) {
		if (filter && !name.toLowerCase().includes(filter)) continue;
		const btn = document.createElement("button");
		btn.className = "dev-item";
		if (name === currentBgName) {
			btn.classList.add("current");
			currentEl = btn;
		}
		btn.textContent = name;
		btn.addEventListener("click", () => {
			$devPanel.hidden = true;
			jumpToBg(name);
		});
		$devList.appendChild(btn);
	}
	if ($devList.children.length === 0) {
		const empty = document.createElement("div");
		empty.className = "dev-item";
		empty.style.color = "rgba(245,235,210,0.4)";
		empty.style.cursor = "default";
		empty.textContent = filter ? "no matches" : "(no bg tags found)";
		$devList.appendChild(empty);
	}
	return currentEl;
}

function bindDevMenu() {
	document.addEventListener("keydown", (ev) => {
		// Backtick toggles. Don't fire while focus is on a text input
		// (e.g. the dev search field itself uses backtick to type).
		const inText = ev.target.matches && ev.target.matches("input, textarea");
		if (ev.code === "Backquote" && !inText) {
			ev.preventDefault();
			toggleDevPanel();
		} else if (ev.code === "Escape" && !$devPanel.hidden) {
			$devPanel.hidden = true;
		}
	});
	// Mobile entry point: 3-finger tap anywhere. Hard to trigger
	// accidentally during normal one-finger reading; easy on purpose.
	// Same convention several iOS apps use for hidden settings.
	document.addEventListener("touchstart", (ev) => {
		if (ev.touches && ev.touches.length >= 3) {
			ev.preventDefault();
			lastMultiFingerAt = Date.now();
			toggleDevPanel();
		}
	}, { passive: false });
	$devClose.addEventListener("click", () => { $devPanel.hidden = true; });
	$devSearch.addEventListener("input", buildDevList);
}

// Render the version row at the top of the dev panel. Reads the
// PWA freshness BUILD_VERSION via window.lirienFreshness (exposed
// by the inline script in index.html) plus the ASSET_VERSION
// constant from this module. Last-checked time is computed live
// each time the panel opens.
function renderDevVersion() {
	if (!$devVersion) return;
	const fresh = window.lirienFreshness || {};
	const buildVersion = fresh.buildVersion || "(unknown)";
	const lastCheck = (typeof fresh.lastCheck === "function") ? fresh.lastCheck() : 0;
	let lastCheckStr = "(never)";
	if (lastCheck > 0) {
		const ago = Math.round((Date.now() - lastCheck) / 1000);
		if (ago < 60) lastCheckStr = `${ago}s ago`;
		else if (ago < 3600) lastCheckStr = `${Math.round(ago / 60)}m ago`;
		else lastCheckStr = `${Math.round(ago / 3600)}h ago`;
	}
	const isStandalone = document.body.classList.contains("is-standalone");
	const modeStr = isStandalone ? "PWA" : "browser";

	// Scroll diagnostic — useful when investigating peek-through /
	// edge-case scroll bugs. Shows current scrollTop, paragraph
	// count, and the offsetTop of each paragraph plus a "..." if
	// long. If something's leaking at the top edge, a screenshot
	// of this row tells us exactly where the math went sideways.
	const padTop = parseInt(getComputedStyle($proseContent).paddingTop, 10) || 0;
	const padBottom = parseInt(getComputedStyle($proseContent).paddingBottom, 10) || 0;
	const scrollTop = $proseContent.scrollTop;
	const clientH = $proseContent.clientHeight;
	const ps = $proseContent.querySelectorAll("p");
	let paraStr = "0";
	if (ps.length > 0) {
		const summaries = [];
		for (let i = Math.max(0, ps.length - 4); i < ps.length; i++) {
			const p = ps[i];
			summaries.push(`${i}:[${p.offsetTop}-${p.offsetTop + p.offsetHeight}]`);
		}
		paraStr = `${ps.length} ${(ps.length > 4 ? "…" : "")}${summaries.join(" ")}`;
	}

	$devVersion.innerHTML =
		`<span class="pair"><span class="label">build:</span> <span class="value">${buildVersion}</span></span>` +
		`<span class="pair"><span class="label">asset:</span> <span class="value">${ASSET_VERSION}</span></span>` +
		`<span class="pair"><span class="label">checked:</span> <span class="value">${lastCheckStr}</span></span>` +
		`<span class="pair"><span class="label">mode:</span> <span class="value">${modeStr}</span></span>` +
		`<span class="pair"><span class="label">scroll:</span> <span class="value">${scrollTop}/${clientH} pad ${padTop}/${padBottom}</span></span>` +
		`<span class="pair"><span class="label">paras:</span> <span class="value">${paraStr}</span></span>`;
}

function toggleDevPanel() {
	$devPanel.hidden = !$devPanel.hidden;
	if (!$devPanel.hidden) {
		$devSearch.value = "";
		// Run snap synchronously before rendering the diagnostic so
		// the version row reflects the post-snap state. Without this,
		// opening the dev panel right after a manual scroll could
		// catch a race window (snap timer pending, panel reads pre-
		// snap scrollTop, screenshot misleads diagnosis).
		snapScrollToWholeParagraphs();
		renderDevVersion();
		// Sub-header: show the bg the user is currently looking at so
		// they can orient and skip forward/back from where they are.
		if (currentBgName) {
			$devCurrent.innerHTML = "currently: <strong></strong>";
			$devCurrent.querySelector("strong").textContent = currentBgName;
			$devCurrent.hidden = false;
		} else {
			$devCurrent.hidden = true;
		}
		const currentEl = buildDevList();
		// Don't auto-focus the filter input. On mobile this pops the
		// soft keyboard, which is the wrong default — most uses are
		// "scroll the list and tap a destination", not "type to
		// filter". The user can still tap the input to bring up the
		// keyboard when they actually want to filter.
		// Center the current row in the list so neighbors are visible
		// in both directions. Defer one frame so layout has settled
		// after the panel un-hides.
		if (currentEl) {
			requestAnimationFrame(() => {
				currentEl.scrollIntoView({ block: "center", behavior: "auto" });
			});
		}
	}
}

function jumpToBg(targetName) {
	if (!story) return false;
	try { story.ResetState(); } catch (e) { console.warn("ResetState failed", e); return false; }

	// Depth-first search: walk forward, and at every choice point try
	// each branch in turn (saving/restoring state via toJson/LoadJson).
	// Without this, bgs that only appear on choice 1+ branches were
	// unreachable. `safety` is shared across recursion so total work
	// stays bounded.
	let safety = 50000;

	// On hit, returns the matched chunk's text + every state-bearing
	// tag accumulated up to and including the matched chunk, with
	// story state left at the matched position so the caller can
	// render it. On miss, returns null and the caller is responsible
	// for restoring state (or calling ResetState before another search).
	//
	// Tracking bg + music + atmosphere + chapter (not just bg/music)
	// per Steve 2026-05-11: dev mode skipping needs to know the
	// CURRENT state at the destination, not just the visual bg —
	// otherwise the shimmer atmosphere or the chapter overlay don't
	// reflect what the narrative would have you in.
	//
	// `latestRealMusic` shadows `latestMusic` but only captures actual
	// track names — not the modifiers `silence` / `dim` / `fade_out`,
	// which adjust the volume of whatever is currently playing. Per
	// Steve 2026-05-11: dev-skip used to land silently when the most
	// recent music tag along the path was a modifier (e.g. ch3 scenes
	// after a `# music: silence` in ch2 sleep). Now we always have a
	// playable track ready, and only apply the modifier on top if the
	// narrative was in a modifier state at the destination.
	const MUSIC_MODIFIERS = new Set(["silence", "dim", "fade_out"]);
	function walk(latestBg, latestMusic, latestRealMusic, latestAtmosphere, latestChapter) {
		while (safety-- > 0) {
			if (story.canContinue) {
				const text = story.Continue();
				for (const raw of (story.currentTags || [])) {
					const tag = String(raw).trim();
					if (tag.startsWith("bg-cut:")) {
						latestBg = tag.slice(7).trim();
					} else if (tag.startsWith("bg:")) {
						latestBg = tag.slice(3).trim();
					} else if (tag.startsWith("music:")) {
						const m = tag.slice(6).trim();
						latestMusic = m;
						if (m && !MUSIC_MODIFIERS.has(m)) latestRealMusic = m;
					} else if (tag.startsWith("atmosphere:")) {
						latestAtmosphere = tag.slice(11).trim();
					} else if (tag.startsWith("chapter:")) {
						latestChapter = tag.slice(8).trim();
					}
				}
				if (latestBg === targetName) {
					return { text, latestBg, latestMusic, latestRealMusic, latestAtmosphere, latestChapter };
				}
			} else if (story.currentChoices && story.currentChoices.length > 0) {
				let saved;
				try { saved = story.state.toJson(); } catch (e) { return null; }
				// Capture branch count BEFORE recursing — after walk()
				// returns, story state has moved past this choice point
				// and story.currentChoices no longer reflects it.
				const numChoices = story.currentChoices.length;
				for (let i = 0; i < numChoices; i++) {
					// Always restore before each branch; the i=0 case is
					// also restoring from a state captured at this exact
					// choice point, so it's a clean re-entry.
					try { story.state.LoadJson(saved); } catch (e) { return null; }
					try { story.ChooseChoiceIndex(i); } catch (e) { continue; }
					const result = walk(latestBg, latestMusic, latestRealMusic, latestAtmosphere, latestChapter);
					if (result) return result;
				}
				return null;
			} else {
				return null;
			}
		}
		return null;
	}

	const result = walk(null, null, null, null, null);
	if (!result) {
		console.warn("[dev] no path to bg:", targetName);
		return false;
	}

	// Match. Apply all four state-bearing fields, in the order they'd
	// naturally fire on narrative pass-through: chapter title first
	// (so its overlay is up before prose starts), then bg, music,
	// atmosphere. Chapter is optional — only applied when a # chapter:
	// tag fired upstream.
	if (result.latestChapter) {
		currentChapterName = result.latestChapter;
		showChapterTitleOverlay(result.latestChapter);
	}
	if (result.latestBg)         swapBackground(result.latestBg);
	// Music: always play the most recent real track so the destination
	// has audible scoring, then re-apply the modifier (silence/dim) on
	// top if the narrative was in that state at the destination. Steve
	// 2026-05-11: previously a `# music: silence` upstream meant dev-
	// skip landed in actual silence even if a real track had been
	// scored a chapter earlier — felt broken.
	if (result.latestRealMusic) {
		swapMusic(result.latestRealMusic);
		if (result.latestMusic && result.latestMusic !== result.latestRealMusic
			&& (result.latestMusic === "silence" || result.latestMusic === "dim")) {
			swapMusic(result.latestMusic);
		}
	} else if (result.latestMusic) {
		swapMusic(result.latestMusic);
	}
	if (result.latestAtmosphere) setAtmosphere(result.latestAtmosphere);
	clearTranscript();
	const trimmed = (result.text || "").trim();
	if (trimmed.length > 0) {
		typeChunk(trimmed);
		prefetchUpcomingBgs(3);
	} else {
		state = "idle";
		advance();
	}
	return true;
}
