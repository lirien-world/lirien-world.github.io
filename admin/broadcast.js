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
	const $subject      = document.getElementById("f-subject");
	const $preheader    = document.getElementById("f-preheader");
	const $intro        = document.getElementById("f-intro");
	const $chapterTitle = document.getElementById("f-chapter-title");
	const $chapterUrl   = document.getElementById("f-chapter-url");
	const $bannerUrl    = document.getElementById("f-banner-url");
	const $to           = document.getElementById("f-to");
	const $btnPreview   = document.getElementById("btn-preview");
	const $btnTest      = document.getElementById("btn-test");
	const $status       = document.getElementById("status");
	const $preview      = document.getElementById("preview-frame");

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
			if (d.banner_url)    $bannerUrl.value    = d.banner_url;
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
	$form.addEventListener("submit", (ev) => {
		ev.preventDefault();
		sendTest();
	});

	// Boot: load draft, initial preview render.
	loadDraft();
	refreshPreview();
})();
