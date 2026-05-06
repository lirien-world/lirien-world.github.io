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

	const BACKEND = "console";       // "console" | "beacon" (phase 2)
	const ENDPOINT = null;           // set in phase 2

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
		try { emit(eventName, props); } catch (e) { /* swallow */ }
	}

	function startSession(source) {
		if (sessionStarted) return;
		sessionStarted = true;
		const isStandalone =
			(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
			window.navigator.standalone === true;
		track("session_start", {
			source: source || "fresh",          // "fresh" | "continue"
			standalone: !!isStandalone,
			viewport_w: window.innerWidth,
			viewport_h: window.innerHeight,
			online: navigator.onLine !== false,
			lang: navigator.language || null
		});
	}

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
			last_chapter: lastChunkChapter
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
	// new Image().src = url or audio.src = url), call this to look up the
	// PerformanceResourceTiming entry and emit asset_load with cache-hit
	// info. Resource entries appear asynchronously so we defer.
	//
	// Cache-hit is determined by transferSize === 0, which means the
	// response was served from the browser's HTTP cache rather than the
	// network. (Cross-origin resources without Timing-Allow-Origin will
	// report transferSize as 0 too — we serve same-origin, so that
	// confound doesn't apply here.)
	function recordAssetLoad(type, name, url) {
		setTimeout(() => {
			try {
				const entries = performance.getEntriesByName(url);
				if (!entries || entries.length === 0) {
					track("asset_load", { type, name, ms: null, cache_hit: null, note: "no_entry" });
					return;
				}
				const entry = entries[entries.length - 1];
				track("asset_load", {
					type, name,
					ms: Math.round(entry.duration),
					cache_hit: entry.transferSize === 0
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
		recordAssetLoad,
		recordAssetError,
		getSessionId: () => SESSION_ID
	};
})();
