// ---------------------------------------------------------------
// Broadcast composer — phase B1 (test-send only)
//
// Reads ?key=<DASHBOARD_KEY> from the URL. Drafts auto-save to
// localStorage so a page reload doesn't lose your in-progress
// email. Live preview hits /broadcast/preview, debounced. Send-
// test hits /broadcast/test with the same payload.
//
// All requests carry the dashboard key as a query param (matches
// the analytics dashboard pattern in admin.js). The endpoints
// themselves auth on env.DASHBOARD_KEY server-side.
// ---------------------------------------------------------------

(function () {
	"use strict";

	const ENDPOINT_BASE = "https://api.lirien.world";
	const DRAFT_KEY     = "lirien.broadcast.draft";
	const PREVIEW_DEBOUNCE_MS = 350;
	const AUTOSAVE_DEBOUNCE_MS = 600;

	function param(name) {
		const m = location.search.match(new RegExp("[?&]" + name + "=([^&]*)"));
		return m ? decodeURIComponent(m[1]) : "";
	}

	const KEY = param("key");
	if (!KEY) {
		document.body.innerHTML =
			'<div style="padding:48px; font-family:Cormorant Garamond, serif; color:#f5ebd2; background:#0d0e10; min-height:100vh;">' +
			'<p style="font-style:italic; opacity:.7">Missing <code>?key=</code> in URL.</p>' +
			'<p style="font-style:italic; opacity:.7">Reach this composer through the same key-bearing link you use for the main dashboard.</p>' +
			'</div>';
		return;
	}

	const $form         = document.getElementById("composer-form");
	const $chapterNum   = document.getElementById("f-chapter-num");
	const $subject      = document.getElementById("f-subject");
	const $preheader    = document.getElementById("f-preheader");
	const $intro        = document.getElementById("f-intro");
	const $chapterTitle = document.getElementById("f-chapter-title");
	const $chapterUrl   = document.getElementById("f-chapter-url");
	const $bannerUrl    = document.getElementById("f-banner-url");
	const $to           = document.getElementById("f-to");
	const $btnPreview   = document.getElementById("btn-preview");
	const $btnAutofill  = document.getElementById("btn-autofill");
	const $btnTest      = document.getElementById("btn-test");
	const $btnBroadcast = document.getElementById("btn-broadcast");
	const $status       = document.getElementById("status");
	const $preview      = document.getElementById("preview-frame");
	const $modal        = document.getElementById("broadcast-confirm");
	const $modalSummary = document.getElementById("broadcast-confirm-summary");
	const $modalCancel  = document.getElementById("broadcast-cancel");
	const $modalGo      = document.getElementById("broadcast-confirm-go");

	// "Send to all" stays disabled until the user does at least one
	// successful test send. Gates accidental "first click is a real
	// broadcast" mishaps. The flag lives in localStorage so it
	// persists across page reloads but resets between browsers.
	const TEST_SENT_KEY = "lirien.broadcast.testSentOnce";
	let hasTestSent = false;
	try { hasTestSent = localStorage.getItem(TEST_SENT_KEY) === "1"; }
	catch (e) { /* ignore */ }
	function refreshBroadcastButtonState() {
		if (hasTestSent) {
			$btnBroadcast.removeAttribute("disabled");
			$btnBroadcast.title = "Send the email to every active subscriber";
		} else {
			$btnBroadcast.setAttribute("disabled", "");
			$btnBroadcast.title = "Send a successful test to yourself first to enable this";
		}
	}
	refreshBroadcastButtonState();

	// Manifest chapters live on the same origin as the dashboard, so
	// the fetch goes direct to GitHub Pages (no CORS, no auth). Loaded
	// once on boot, used by the auto-fill button.
	let CHAPTERS = [];
	async function loadChapters() {
		try {
			const res = await fetch("/lirien/assets_manifest.json?t=" + Date.now(), { cache: "no-store" });
			if (!res.ok) throw new Error("manifest " + res.status);
			const m = await res.json();
			CHAPTERS = Array.isArray(m.chapters) ? m.chapters : [];
		} catch (e) {
			console.warn("couldn't load chapter list:", e);
		}
	}

	// ---- draft persistence (localStorage) -----------------------

	function snapshot() {
		return {
			subject:       $subject.value,
			preheader:     $preheader.value,
			intro:         $intro.value,
			chapter_title: $chapterTitle.value,
			chapter_url:   $chapterUrl.value,
			banner_url:    $bannerUrl.value,
			to:            $to.value,
		};
	}

	function loadDraft() {
		try {
			const raw = localStorage.getItem(DRAFT_KEY);
			if (!raw) return;
			const d = JSON.parse(raw);
			if (d.subject)       $subject.value      = d.subject;
			if (d.preheader)     $preheader.value    = d.preheader;
			if (d.intro)         $intro.value        = d.intro;
			if (d.chapter_title) $chapterTitle.value = d.chapter_title;
			if (d.chapter_url)   $chapterUrl.value   = d.chapter_url;
			// banner_url uses explicit !== undefined so a deliberately
			// cleared draft (empty string) overrides the HTML default
			// pre-fill. Without this, you couldn't ever ship an email
			// without the default Thistle banner once you'd saved a draft.
			if (d.banner_url !== undefined) $bannerUrl.value = d.banner_url;
			if (d.to)            $to.value           = d.to;
		} catch (e) { /* ignore */ }
	}

	function saveDraft() {
		try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot())); }
		catch (e) { /* ignore */ }
	}

	// ---- preview --------------------------------------------------

	async function fetchPreview() {
		const url = ENDPOINT_BASE + "/broadcast/preview?key=" + encodeURIComponent(KEY);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot()),
		});
		if (!res.ok) throw new Error("preview " + res.status);
		return await res.text();
	}

	async function refreshPreview() {
		try {
			const html = await fetchPreview();
			// srcdoc isolates the iframe from inheriting parent CSS or
			// scripts. Each refresh replaces the entire document.
			$preview.srcdoc = html;
		} catch (e) {
			console.warn("preview failed:", e);
		}
	}

	// ---- test send ------------------------------------------------

	async function sendTest() {
		// Native HTML5 validation already enforced "required" + email
		// shape, but the back-end is authoritative — we just guard
		// against an obvious missing-field case here.
		const s = snapshot();
		if (!s.subject || !s.intro || !s.chapter_url || !s.to) {
			showStatus("Fill in subject, intro, chapter URL, and recipient.", "error");
			return;
		}
		$btnTest.setAttribute("disabled", "");
		showStatus("Sending test…", "");
		try {
			const url = ENDPOINT_BASE + "/broadcast/test?key=" + encodeURIComponent(KEY);
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(s),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.ok) {
				const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
				throw new Error(msg);
			}
			showStatus("Test sent to " + s.to + ". Check the inbox.", "ok");
			// Unlock the gold "Send to all" button — at least one
			// successful test has happened, so the user has actually
			// previewed what the broadcast will look like.
			hasTestSent = true;
			try { localStorage.setItem(TEST_SENT_KEY, "1"); } catch (e) { /* ignore */ }
			refreshBroadcastButtonState();
		} catch (e) {
			showStatus("Send failed: " + (e && e.message ? e.message : e), "error");
		} finally {
			$btnTest.removeAttribute("disabled");
		}
	}

	// ---- broadcast flow ------------------------------------------

	async function fetchSubscriberCount() {
		try {
			const url = ENDPOINT_BASE + "/api/data?key=" + encodeURIComponent(KEY) + "&q=subscribers";
			const res = await fetch(url, { cache: "no-store" });
			if (!res.ok) return null;
			const data = await res.json();
			// Worker returns { q, results, filters } — not { rows }.
			// Matches admin.js's fetchQuery contract.
			const row = (data && data.results && data.results[0]) || null;
			if (!row) return null;
			return {
				total: Number(row.total_active) || 0,
				viaLanding: Number(row.via_landing) || 0,
				viaReaderEnd: Number(row.via_reader_end) || 0,
			};
		} catch (e) {
			return null;
		}
	}

	async function openBroadcastModal() {
		// Pre-flight: validate the same fields the server would.
		const s = snapshot();
		if (!s.subject || !s.intro || !s.chapter_url) {
			showStatus("Fill in subject, intro, and chapter URL first.", "error");
			return;
		}
		$modal.removeAttribute("hidden");
		$modalSummary.textContent = "Loading subscriber count…";
		$modalGo.setAttribute("disabled", "");
		const counts = await fetchSubscriberCount();
		if (counts == null) {
			$modalSummary.textContent = "Couldn't fetch subscriber count. Check the worker is deployed.";
			return;
		}
		if (counts.total === 0) {
			$modalSummary.textContent = "No active subscribers yet. Nothing to send.";
			return;
		}
		$modalSummary.innerHTML = `About to send "<strong>${escAttr(s.subject)}</strong>" to <strong>${counts.total}</strong> active reader${counts.total === 1 ? "" : "s"}.`;
		$modalGo.removeAttribute("disabled");
	}

	function escAttr(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({
			"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
		}[c]));
	}

	function closeBroadcastModal() {
		$modal.setAttribute("hidden", "");
	}

	async function doBroadcast() {
		$modalGo.setAttribute("disabled", "");
		$modalSummary.textContent = "Sending… this can take a moment for larger lists.";
		const s = snapshot();
		try {
			const url = ENDPOINT_BASE + "/broadcast?key=" + encodeURIComponent(KEY);
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(s),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.ok) {
				const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
				throw new Error(msg);
			}
			closeBroadcastModal();
			const okCount = data.total_sent;
			const failCount = data.total_failed;
			let msg = `Sent to ${okCount} reader${okCount === 1 ? "" : "s"}.`;
			if (failCount > 0) msg += ` ${failCount} failed.`;
			showStatus(msg, "ok");
		} catch (e) {
			$modalSummary.textContent = "Send failed: " + (e && e.message ? e.message : e);
			$modalGo.removeAttribute("disabled");
		}
	}

	function showStatus(msg, cls) {
		$status.textContent = msg;
		$status.className = "composer-status" + (cls ? " " + cls : "");
	}

	// ---- debounce helper -----------------------------------------

	function debounce(fn, ms) {
		let t = 0;
		return function () {
			clearTimeout(t);
			t = setTimeout(() => fn.apply(this, arguments), ms);
		};
	}

	const debouncedPreview  = debounce(refreshPreview, PREVIEW_DEBOUNCE_MS);
	const debouncedAutosave = debounce(() => { saveDraft(); showStatus("Draft saved.", ""); }, AUTOSAVE_DEBOUNCE_MS);

	// ---- wiring --------------------------------------------------

	$form.addEventListener("input", () => {
		debouncedAutosave();
		debouncedPreview();
	});

	$btnPreview.addEventListener("click", refreshPreview);
	$btnAutofill.addEventListener("click", autofillFromChapter);
	$btnBroadcast.addEventListener("click", openBroadcastModal);
	$modalCancel.addEventListener("click", closeBroadcastModal);
	$modalGo.addEventListener("click", doBroadcast);
	// Click outside the card closes the modal. Escape too.
	$modal.addEventListener("click", (ev) => {
		if (ev.target === $modal) closeBroadcastModal();
	});
	document.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape" && !$modal.hidden) closeBroadcastModal();
	});
	// Pressing Enter inside the chapter-num field should trigger auto-fill,
	// not submit the form (which would fire a test send with empty fields).
	$chapterNum.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			autofillFromChapter();
		}
	});
	$form.addEventListener("submit", (ev) => {
		ev.preventDefault();
		sendTest();
	});

	// Auto-fills subject, preheader, chapter_title, and chapter_url
	// based on the chapter number in $chapterNum. Pulls the title from
	// the manifest's chapters[] list (parsed from test.ink, so it
	// matches whatever's currently shipped). intro is intentionally
	// NOT auto-filled — that's where Steve's voice goes.
	// Intro template — chapter-aware. Same cadence every time so the
	// email reads as "from Steve" rather than auto-generated. The
	// chapter title is interpolated so each send is naturally unique
	// without Steve having to write fresh copy. Steve edits freely
	// after auto-fill if a particular ship deserves a different note.
	function buildIntro(chapter_title) {
		return (
			`A new chapter is live — ${chapter_title}.\n\n` +
			`You don't have to hurry through it. Lirien tends to land when you let it.\n\n` +
			`If you'd like to keep going —`
		);
	}
	// Used to seed the intro on first visit before any chapter has
	// been auto-filled. Generic version (no chapter title).
	const DEFAULT_INTRO =
		"A new chapter is live.\n\n" +
		"You don't have to hurry through it. Lirien tends to land when you let it.\n\n" +
		"If you'd like to keep going —";
	// Banner URL default — used by auto-fill if the field has been
	// cleared. Kept in sync with the value="" attribute on
	// #f-banner-url so the composer is always self-recovering.
	const DEFAULT_BANNER_URL = "https://lirien.world/atmosphere/email_banner_thistle.jpg";
	const DEFAULT_CHAPTER_URL = "https://lirien.world/lirien/";

	function autofillFromChapter() {
		// Accept both "5" (text) and 5 (number). parseInt tolerates
		// surrounding whitespace + bails to NaN on empty/bad input.
		const n = parseInt(($chapterNum.value || "").trim(), 10);
		if (!Number.isFinite(n) || n < 1) {
			showStatus("Enter a chapter number first.", "error");
			return;
		}
		const ch = CHAPTERS.find((c) => c.number === n);
		if (!ch) {
			showStatus(`No chapter ${n} in the manifest (have ${CHAPTERS.length}). Did you bump the version after writing it?`, "error");
			return;
		}
		// Produce a send-ready email. Every field gets a value so
		// Steve can hit "Send test" immediately. Recipient (the "to"
		// field) is the only thing not templated — it's user-specific,
		// but it persists in localStorage so after the first send it
		// stays filled across visits.
		$chapterTitle.value = ch.title;
		$subject.value      = "A new chapter — " + ch.title;
		$preheader.value    = ch.title + " is live.";
		$chapterUrl.value   = DEFAULT_CHAPTER_URL;
		$intro.value        = buildIntro(ch.title);
		if (!$bannerUrl.value.trim()) {
			$bannerUrl.value = DEFAULT_BANNER_URL;
		}
		showStatus(`Filled from chapter ${n}: ${ch.title}. Send-ready.`, "ok");
		saveDraft();
		refreshPreview();
	}

	// Boot: load chapters list + draft, seed empty intro with the
	// starter paragraph, then initial preview render. First-time
	// visitors with no draft see something coherent in the preview
	// immediately rather than the worker's "(intro paragraph)"
	// placeholder.
	loadChapters().then(loadDraft).then(() => {
		if (!$intro.value.trim()) $intro.value = DEFAULT_INTRO;
		refreshPreview();
	});
})();
