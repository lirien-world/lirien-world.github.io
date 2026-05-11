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
	const $status       = document.getElementById("status");
	const $preview      = document.getElementById("preview-frame");

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
		} catch (e) {
			showStatus("Send failed: " + (e && e.message ? e.message : e), "error");
		} finally {
			$btnTest.removeAttribute("disabled");
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
	// A starter intro paragraph in Steve's voice. Three brief blocks
	// with the established Lirien cadence (observational, comma-heavy,
	// the invitation phrased as "if you'd like to keep going"). Steve
	// edits this every time before sending — it's a starting position,
	// not a final draft. Only inserted when intro is empty so a draft
	// in progress isn't blown away.
	const DEFAULT_INTRO =
		"It's been a stretch. There's a new chapter live.\n\n" +
		"You don't have to hurry through it — Lirien tends to land when you let it.\n\n" +
		"If you'd like to keep going —";

	function autofillFromChapter() {
		const n = parseInt($chapterNum.value, 10);
		if (!Number.isFinite(n) || n < 1) {
			showStatus("Enter a chapter number first.", "error");
			return;
		}
		const ch = CHAPTERS.find((c) => c.number === n);
		if (!ch) {
			showStatus(`No chapter ${n} in the manifest (have ${CHAPTERS.length}). Did you bump the version after writing it?`, "error");
			return;
		}
		// Template the templatable fields. Steve can edit any of them
		// after — auto-fill never locks values.
		$chapterTitle.value = ch.title;
		$subject.value      = "A new chapter — " + ch.title;
		$preheader.value    = ch.title + " is live.";
		// chapter_url stays as whatever's there; default lirien.world/lirien/
		// is fine, and a future deep-linking feature can populate per-chapter URLs.
		if (!$chapterUrl.value.trim()) {
			$chapterUrl.value = "https://lirien.world/lirien/";
		}
		// Intro: only fill when empty. Don't overwrite a draft that's
		// already been edited (auto-fill is a starter, not a reset).
		if (!$intro.value.trim()) {
			$intro.value = DEFAULT_INTRO;
		}
		showStatus(`Filled from chapter ${n}: ${ch.title}.`, "ok");
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
