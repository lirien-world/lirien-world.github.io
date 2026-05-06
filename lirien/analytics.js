// ----------------------------------------------------------------
// analytics.js — Lirien narrative analytics, privacy-respecting
//
// Phase 1: console-only. All events emit to console.log so we can
// validate the model and iterate on what to track. No network calls.
//
// Phase 2 (planned): switch `BACKEND` to "beacon" and point at a
// Cloudflare Worker. Same event shape, same call sites.
//
// Privacy properties:
//   - Ephemeral SESSION_ID generated per page load via crypto.randomUUID()
//   - Never persisted to localStorage / sessionStorage / cookies
//   - No reader_id, no fingerprinting, no IP correlation
//   - Closing the tab destroys the session identifier
//   - All events are aggregate-friendly counts, not individual histories
//
// Public API (window.lirienAnalytics):
//   track(eventName, props)         — emit a single event
//   startSession(source)            — mark the start of a reading session;
//                                      idempotent, only fires once
//   recordAssetLoad(type, name, url)— look up Performance API entry and
//                                      emit asset_load with cache-hit info
//   recordAssetError(type, name, err)
//   getSessionId()                  — returns the ephemeral UUID
//
// Event shape:
//   {
//     event: "<name>",
//     session_id: "<ephemeral uuid>",
//     timestamp_ms: <unix ms>,
//     since_session_start_ms: <ms since this page-load>,
//     props: { ... }
//   }
//
// Defined event names (phase 1):
//   session_start    { source, standalone, viewport_w, viewport_h, online }
//   session_end      { duration_ms, chunks_reached, choices_made,
//                      last_chunk, last_chapter }
//   chunk_revealed   { bg, chapter, time_since_prev_ms }
//   choice_taken    { bg, choice_index, choices_total }
//   chapter_jump     { from_bg, to_chapter, source: "menu"|"continue"|"return" }
//   asset_load       { type: "bg"|"music"|"story", name, ms, cache_hit }
//   asset_error      { type, name, message, online }
//   offline_block    { reason: "bg"|"music", chunk }
//   error            { message, source }
// ----------------------------------------------------------------

(function () {
	"use strict";

	const BACKEND = "beacon";        // "console" | "beacon"
	// Same-origin route on lirien.world; the Worker is served behind
	// the /api/* path now that lirien.world is on Cloudflare. No CORS
	// dance needed — the request is same-origin from the reader app.
	const ENDPOINT = "https://lirien.world/api/track";

	// Dev-mode escape: ?show-splash forces the install splash to render
	// for testing on platforms where it wouldn't normally appear. We
	// don't want those test sessions polluting production telemetry,
	// so the whole module short-circuits when that flag is present.
	const DEV_MODE = (() => {
		try { return new URLSearchParams(window.location.search).has("show-splash"); }
		catch (e) { return false; }
	})();

	// Ephemeral session UUID. Regenerated every page load. Never persisted.
	const SESSION_ID = (typeof crypto !== "undefined" && crypto.randomUUID)
		? crypto.randomUUID()
		: "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

	const SESSION_START_PERF = (typeof performance !== "undefined") ? performance.now() : 0;
	const SESSION_START_WALL = Date.now();

	// In-session aggregates kept here so session_end can summarize without
	// the caller needing to assemble it. Resets are not supported — closing
	// the tab is the only way to end a session.
	let chunksReached = 0;
	let choicesMade = 0;
	let lastChunkBg = null;
	let lastChunkChapter = null;
	let lastChunkAt = null;       // performance.now() of last chunk reveal
	let sessionStarted = false;

	function nowSinceSessionStart() {
		return Math.round(performance.now() - SESSION_START_PERF);
	}

	function emit(eventName, rawProps) {
		// Copy props so we can enrich without mutating the caller's object.
		const props = Object.assign({}, rawProps || {});

		// Auto-enrich chunk_revealed with time-since-previous-chunk so
		// callers don't have to track it. Reading speed comes from this.
		if (eventName === "chunk_revealed" && lastChunkAt !== null && props.time_since_prev_ms === undefined) {
			props.time_since_prev_ms = Math.round(performance.now() - lastChunkAt);
		}

		const evt = {
			event: eventName,
			session_id: SESSION_ID,
			timestamp_ms: Date.now(),
			since_session_start_ms: nowSinceSessionStart(),
			props: props
		};

		// Maintain aggregates AFTER props finalized but BEFORE emission so
		// session_end is correct even if emission triggers a re-entry.
		if (eventName === "chunk_revealed") {
			chunksReached++;
			lastChunkBg = props.bg || lastChunkBg;
			lastChunkChapter = props.chapter || lastChunkChapter;
			lastChunkAt = performance.now();
		} else if (eventName === "choice_taken") {
			choicesMade++;
		}

		try {
			if (BACKEND === "console") {
				console.log("[analytics]", evt.event, evt);
			} else if (BACKEND === "beacon" && ENDPOINT && navigator.sendBeacon) {
				navigator.sendBeacon(ENDPOINT, JSON.stringify(evt));
			}
		} catch (e) {
			// Never let analytics errors break the game.
		}
	}

	function track(eventName, props) {
		if (DEV_MODE) return;
		try { emit(eventName, props); } catch (e) { /* swallow */ }
	}

	// Coarse client-side environment detection. Returns categorical
	// strings only — no full UA, no fingerprint. The combination of
	// {platform, browser, standalone, device_class} answers questions
	// like "is the install path being used by iOS Safari readers" at
	// aggregate level without identifying anyone individually.
	function detectEnvironment() {
		const ua = navigator.userAgent || "";

		let platform = "other";
		if (/iPhone|iPad|iPod/.test(ua)) platform = "ios";
		else if (/Android/.test(ua))     platform = "android";
		else if (/Mac OS X/.test(ua))    platform = "macos";
		else if (/Windows/.test(ua))     platform = "windows";
		else if (/Linux/.test(ua))       platform = "linux";

		// Order matters: Edge contains Chrome string, Chrome contains Safari, etc.
		let browser = "other";
		if (/Edg(iOS)?\//.test(ua))             browser = "edge";
		else if (/SamsungBrowser/.test(ua))     browser = "samsung";
		else if (/(FxiOS|Firefox)\//.test(ua))  browser = "firefox";
		else if (/(CriOS|Chrome)\//.test(ua))   browser = "chrome";
		else if (/Safari\//.test(ua))           browser = "safari";

		// Phone/tablet/desktop heuristic. coarse-pointer ⇒ touch device.
		// Branch by the SHORT edge of the viewport so a phone in
		// landscape doesn't get mis-classified as a tablet — iPhone
		// Pro Max landscape is 932×430, which trivially exceeds any
		// width-only threshold. Phones top out around 480px on the
		// short edge; iPad mini portrait starts at 744. 600 is a
		// conservative midpoint.
		let device_class = "desktop";
		const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
		if (coarse) {
			const shortEdge = Math.min(window.innerWidth, window.innerHeight);
			device_class = (shortEdge >= 600) ? "tablet" : "phone";
		}

		// Timezone offset in minutes, signed JS-style (negative = ahead of UTC).
		// Coarse temporal signal for "when do readers read?" queries; ~24
		// distinct values worldwide, low identification risk.
		const tz_offset_min = (new Date()).getTimezoneOffset();

		// Network connection info — Chromium and Firefox expose this;
		// Safari does not. Two distinct fields:
		//   effectiveType — derived speed bucket: 4g/3g/2g/slow-2g.
		//                   Reflects observed bandwidth + RTT, not
		//                   physical medium. A slow wifi can show as
		//                   "3g". Reliably populated where the API
		//                   exists.
		//   type          — physical link: wifi/cellular/ethernet/etc.
		//                   Hidden in Safari, iOS, and most Chromium
		//                   contexts as anti-fingerprinting; usually
		//                   null in practice. Captured anyway because
		//                   when it IS available it's the only way to
		//                   distinguish wifi from cellular.
		// downlink in Mbps, rtt in ms (rounded to 25ms increments by
		// the API for privacy). saveData reflects user's data-saver
		// preference. Captured once at session start — we don't
		// subscribe to changes.
		let conn_effective_type = null, conn_link_type = null;
		let conn_downlink = null, conn_rtt = null, conn_save_data = null;
		const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
		if (c) {
			conn_effective_type = typeof c.effectiveType === "string" ? c.effectiveType : null;
			conn_link_type      = typeof c.type          === "string" ? c.type          : null;
			conn_downlink       = typeof c.downlink      === "number" ? c.downlink       : null;
			conn_rtt            = typeof c.rtt           === "number" ? c.rtt            : null;
			conn_save_data      = typeof c.saveData      === "boolean" ? c.saveData      : null;
		}

		return {
			platform, browser, device_class, tz_offset_min,
			conn_effective_type, conn_link_type,
			conn_downlink, conn_rtt, conn_save_data,
		};
	}

	function startSession(source, extras) {
		if (sessionStarted) return;
		sessionStarted = true;
		const isStandalone =
			(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
			window.navigator.standalone === true;
		track("session_start", Object.assign({
			source: source || "fresh",          // "fresh" | "continue"
			standalone: !!isStandalone,
			viewport_w: window.innerWidth,
			viewport_h: window.innerHeight,
			online: navigator.onLine !== false,
			lang: navigator.language || null
		}, detectEnvironment(), extras || {}));
	}

	// Caller (main.js) keeps us informed of the game's current `state`
	// so session_end can record what the reader was doing when they
	// left ("typing" / "waiting" / "choosing" / "ended") rather than
	// just where they stopped. Drop-off interpretation hinges on this.
	let lastKnownState = null;
	function setLastState(s) { lastKnownState = s || null; }

	function endSession() {
		// Only emit session_end if we actually started one. Pageviews where
		// the user closes the tab from the title screen without entering
		// don't represent a reading session.
		if (!sessionStarted) return;
		const duration = Math.round(performance.now() - SESSION_START_PERF);
		track("session_end", {
			duration_ms: duration,
			chunks_reached: chunksReached,
			choices_made: choicesMade,
			last_chunk: lastChunkBg,
			last_chapter: lastChunkChapter,
			last_state: lastKnownState
		});
	}

	// pagehide is the modern, reliable "user leaving" signal — fires even
	// on iOS where unload is unreliable, and works with bfcache. sendBeacon
	// is designed exactly for this case: fire-and-forget while the page
	// goes away.
	window.addEventListener("pagehide", endSession);
	// visibilitychange catches tab-hide-but-not-close cases. Fires more
	// often than pagehide; we just ignore the duplicates by guarding emit
	// with sessionStarted (and accepting that a repeated session_end isn't
	// a problem in phase 1 console mode).
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") endSession();
	});

	// Helper: after an asset URL has been requested (img.src = url or
	// new Image().src = url or audio.src = url), call this to look up
	// the PerformanceResourceTiming entry and emit asset_load.
	//
	// Two layers of state are reported, answering different questions:
	//
	//   cache_hit (boolean) — was the resource ready when needed?
	//     True if the load completed in under 100ms — the threshold
	//     below which a load feels instant. This is the user-facing
	//     "did I have to wait" signal. A resource on disk from a
	//     previous play is ready. A prefetch that finished just in
	//     time is also ready. A cold network fetch usually isn't.
	//     A "cached" response that took 7s to deliver because the
	//     tab was backgrounded ALSO isn't ready, even though the
	//     bytes never crossed the network — the user still waited.
	//
	//   cache_state ("hit" | "revalidated" | "fresh") — what did the
	//     browser actually do?
	//     "hit"         — transferSize === 0; entirely from disk cache
	//     "revalidated" — transferSize > 0, encodedBodySize === 0; 304
	//                     response, headers only, body from cache
	//     "fresh"       — both > 0; real bytes pulled from the network
	//     Used for diagnosing the network/cache layer independently of
	//     the user-experience question.
	//
	// We resolve to absolute URL before getEntriesByName because the
	// Performance API stores entries keyed by absolute URL. Passing a
	// relative URL silently returned nothing; that was the bug behind
	// the original "0% cache hit" chart.
	const READY_THRESHOLD_MS = 100;

	function recordAssetLoad(type, name, url) {
		setTimeout(() => {
			try {
				const abs = (typeof window !== "undefined" && window.URL)
					? new URL(url, window.location.href).href
					: url;
				const entries = performance.getEntriesByName(abs);
				if (!entries || entries.length === 0) {
					track("asset_load", { type, name, ms: null, cache_hit: null, cache_state: null, note: "no_entry" });
					return;
				}
				const entry = entries[entries.length - 1];
				const transfer_size     = typeof entry.transferSize    === "number" ? entry.transferSize    : null;
				const encoded_body_size = typeof entry.encodedBodySize === "number" ? entry.encodedBodySize : null;
				const ms = Math.round(entry.duration);
				let cache_state = "fresh";
				if (transfer_size === 0)                              cache_state = "hit";
				else if (encoded_body_size === 0 && transfer_size > 0) cache_state = "revalidated";
				const cache_hit = ms !== null && ms < READY_THRESHOLD_MS;
				track("asset_load", {
					type, name, ms,
					cache_hit,        // user perspective: was it ready?
					cache_state,      // browser perspective: hit | revalidated | fresh
					transfer_size,
					encoded_body_size,
				});
			} catch (e) { /* swallow */ }
		}, 80);
	}

	function recordAssetError(type, name, message) {
		track("asset_error", {
			type, name,
			message: message || "unknown",
			online: navigator.onLine !== false
		});
	}

	// Catch top-level JS errors so we know about breakage in production.
	window.addEventListener("error", (ev) => {
		track("error", {
			message: (ev && ev.message) || "unknown",
			source: (ev && ev.filename) || null
		});
	});
	window.addEventListener("unhandledrejection", (ev) => {
		track("error", {
			message: (ev && ev.reason && ev.reason.message) || String(ev && ev.reason) || "unhandled rejection",
			source: "promise"
		});
	});

	window.lirienAnalytics = {
		track,
		startSession,
		setLastState,
		recordAssetLoad,
		recordAssetError,
		getSessionId: () => SESSION_ID
	};
})();
