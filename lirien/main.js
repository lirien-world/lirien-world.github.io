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

// ----- DOM refs -----

const $bg = document.getElementById("bg");
const $bgImage = document.getElementById("bg-image");
const $proseContent = document.getElementById("prose-content");
const $prose = document.getElementById("prose");
const $continueHint = document.getElementById("continue-hint");
const $choices = document.getElementById("choices");
const $chapterTitle = document.getElementById("chapter-title");
const $settingsBtn = document.getElementById("settings-btn");
const $settingsPanel = document.getElementById("settings-panel");
const $chaptersBtn = document.getElementById("chapters-btn");
const $chaptersPanel = document.getElementById("chapters-panel");
const $chapterList = document.getElementById("chapter-list");
const $restartBtn = document.getElementById("restart-btn");
const $returnRecentBtn = document.getElementById("return-recent-btn");
const $titleContinue = document.getElementById("title-continue");
const $confirmDialog = document.getElementById("confirm-dialog");
const $confirmTitle = document.getElementById("confirm-title");
const $confirmMessage = document.getElementById("confirm-message");
const $confirmOk = document.getElementById("confirm-ok");
const $confirmCancel = document.getElementById("confirm-cancel");
const $titleScreen = document.getElementById("title-screen");
const $titleHint = document.getElementById("title-hint");
const $devPanel = document.getElementById("dev-panel");
const $devSearch = document.getElementById("dev-search");
const $devList = document.getElementById("dev-list");
const $devClose = document.getElementById("dev-close");
const $devCurrent = document.getElementById("dev-current");

// ----- settings (persisted to localStorage) -----

const SETTINGS_KEY = "lirien.settings";
const DEFAULT_SETTINGS = { speedMultiplier: 0.4, fontSize: 36, musicOn: true };
let settings = loadSettings();
applyFontSize();

function loadSettings() {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
	} catch (e) {
		return { ...DEFAULT_SETTINGS };
	}
}
function saveSettings() {
	try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
	catch (e) { /* private mode etc. */ }
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
	bindSettingsMenu();
	bindChaptersMenu();
	bindAdvanceInput();
	bindDevMenu();

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
		isExploring = false;
		state = "idle";
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
		const parsed = await fetch("story.json").then(r => r.json());
		story = new inkjs.Story(parsed);
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
		if (loadAutosave()) {
			$titleContinue.hidden = false;
			$titleHint.classList.add("has-continue");
		}
	} catch (e) {
		showFatalError(e);
	}
})();

function dismissTitleScreen() {
	$titleScreen.classList.add("dismissed");
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
	hideContinueHint();
	if (!isExploring) saveAutosave();
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
			const padBottom = parseInt(getComputedStyle($prose).paddingBottom, 10) || 0;
			const panelHeight = $prose.clientHeight;

			let lastTop = null;
			for (let i = 0; i < spans.length; i++) {
				const top = spans[i].offsetTop;
				if (top === lastTop) continue;
				lastTop = top;

				const lineBottom = top + spans[i].offsetHeight;
				const desiredScroll = lineBottom - panelHeight + padBottom;
				if (desiredScroll <= $prose.scrollTop + 1) continue;

				const t = setTimeout(() => {
					if (desiredScroll > $prose.scrollTop) {
						$prose.scrollTo({ top: desiredScroll, behavior: "smooth" });
					}
					timers.delete(t);
				}, spanTimes[i]);
				timers.add(t);
			}
		});
	});
}

function onChunkRevealed() {
	currentReveal = null;
	state = "waiting";
	showContinueHint();
}

function scrollChunkToTop(paragraph) {
	// Scroll the prose panel so the new chunk's first line sits a
	// padding-height below the top of the visible area — i.e. flush
	// with the inner padding edge, not the bare panel border. After
	// settling, the user can scroll up freely to re-read prior chunks.
	requestAnimationFrame(() => {
		const padTop = parseInt(getComputedStyle($prose).paddingTop, 10) || 0;
		const offset = Math.max(0, paragraph.offsetTop - padTop);
		$prose.scrollTo({ top: offset, behavior: "auto" });
	});
}

// ----- choices -----

function showChoices(choices) {
	state = "choosing";
	hideContinueHint();
	$choices.innerHTML = "";
	$choices.classList.add("visible");
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
	story.ChooseChoiceIndex(index);
	$choices.classList.remove("visible");
	$choices.innerHTML = "";
	state = "idle";
	advance();
}

// ----- continue hint -----

function showContinueHint() {
	$continueHint.classList.add("visible");
}
function hideContinueHint() {
	$continueHint.classList.remove("visible");
}

// ----- chapter title overlay -----

function clearTranscript() {
	// Match the Godot version's "fresh transcript per chapter" pattern.
	// New chapter = empty prose panel. The chapter overlay lands over
	// the cleared panel; first prose chunk types into a clean surface.
	$proseContent.innerHTML = "";
	$prose.scrollTop = 0;
}

// Visual-only chapter overlay: parses the spec, paints it, and fades
// it in/out. No transcript clearing or bookmark recording — those are
// the caller's responsibility. Used both by the natural in-flow tag
// handler and by autosave resume (Continue / Return-to-recent), where
// recording a bookmark would land on a stale stateBeforeContinue.
function showChapterTitleOverlay(spec) {
	// spec is "<num> — <title>", e.g. "One — Ash and Arrival".
	let numText = "";
	let titleText = spec;
	for (const sep of [" — ", " – ", " - "]) {
		if (spec.indexOf(sep) >= 0) {
			const idx = spec.indexOf(sep);
			numText = "CHAPTER " + spec.substring(0, idx).trim().toUpperCase();
			titleText = spec.substring(idx + sep.length).trim();
			break;
		}
	}
	if (numText === "") numText = "CHAPTER";

	$chapterTitle.querySelector(".chapter-number").textContent = numText;
	$chapterTitle.querySelector(".chapter-name").textContent = titleText;

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

function swapBackground(name) {
	// Skip identical reassignment — defensive against rapid advance()
	// calls re-applying the same bg, which would otherwise trigger a
	// fresh decode+composite even though the visible bitmap is unchanged.
	if (name === currentBgName) return;
	const url = ATMOSPHERE_DIR + name + ".png";
	// Setting img.src instead of CSS background-image gives Safari a
	// clean release-then-decode lifecycle. Browsers also share the
	// decoded bitmap between this img and any prior `new Image()`
	// preload of the same URL, so the prefetch actually pays off here.
	$bgImage.src = url;
	currentBgName = name;
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

let audioCtx = null;
let musicA = null;
let musicB = null;
let activePlayer = null;
let currentMusicName = "";
let userGestured = false;          // first pointerup/keydown flips this true
let pendingMusicName = null;       // music tag that fired before gesture

function ensureAudioRig() {
	if (audioCtx) return;
	const Ctor = window.AudioContext || window.webkitAudioContext;
	audioCtx = new Ctor();
	musicA = makePlayer();
	musicB = makePlayer();
	activePlayer = musicA;
}

function onFirstUserGesture() {
	if (userGestured) return;
	userGestured = true;
	ensureAudioRig();
	if (audioCtx.state === "suspended") audioCtx.resume();
	if (settings.musicOn && pendingMusicName) {
		const n = pendingMusicName;
		pendingMusicName = null;
		swapMusic(n);
	}
}

function stopAllMusic() {
	// Pause both players. Keep `pendingMusicName` so toggling music
	// back on re-engages the scene's current track.
	currentMusicName = "";
	if (musicA) { fadeGain(musicA, 0, 0.4); setTimeout(() => musicA.el.pause(), 500); }
	if (musicB) { fadeGain(musicB, 0, 0.4); setTimeout(() => musicB.el.pause(), 500); }
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

	if (name === "silence") {
		fadeGain(activePlayer, MUSIC_QUIET_VOLUME, MUSIC_QUIET_FADE_S);
		return;
	}
	if (name === "fade_out") {
		currentMusicName = "";
		fadeGain(activePlayer, 0, 4.0);
		setTimeout(() => activePlayer && activePlayer.el.pause(), 4100);
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

	currentMusicName = name;
	const url = MUSIC_DIR + name + ".ogg";
	const outgoing = activePlayer;
	const incoming = (outgoing === musicA) ? musicB : musicA;
	incoming.el.src = url;
	incoming.gain.gain.value = 0;
	const playPromise = incoming.el.play();
	if (playPromise && playPromise.catch) {
		playPromise.catch(() => { /* autoplay blocked; will work after first gesture */ });
	}
	activePlayer = incoming;

	fadeGain(outgoing, 0, MUSIC_CROSSFADE_S);
	fadeGain(incoming, MUSIC_VOLUME, MUSIC_CROSSFADE_S);
	setTimeout(() => {
		if (outgoing && outgoing.el && outgoing !== activePlayer) outgoing.el.pause();
	}, (MUSIC_CROSSFADE_S * 1000) + 100);
}

// ----- tag dispatch -----

function applyTags(tags) {
	for (const raw of tags) {
		const tag = String(raw).trim();
		if (tag.startsWith("bg:"))            swapBackground(tag.slice(3).trim());
		else if (tag.startsWith("music:"))    swapMusic(tag.slice(6).trim());
		else if (tag.startsWith("chapter:"))  showChapterTitle(tag.slice(8).trim());
		else if (tag === "transition")        { /* TODO: shimmer dissolve */ }
		// portrait_left / portrait_right / portrait_clear can be wired
		// later when the new game adds them.
	}
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

		// Ignore taps that originate from a choice button, the settings
		// menu, or the scrollbar interaction. Buttons handle their own
		// click events.
		if (ev.target.closest(".choice")) return;
		if (ev.target.closest(".settings-btn") || ev.target.closest(".settings-panel")) return;
		if (ev.target.closest(".chapters-btn") || ev.target.closest(".chapters-panel")) return;
		if (ev.target.closest(".title-continue")) return;
		if (ev.target.closest(".confirm-dialog")) return;

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
	$settingsBtn.addEventListener("click", () => {
		$settingsPanel.hidden = !$settingsPanel.hidden;
		// Mutual exclusion — only one corner panel visible at a time.
		if (!$settingsPanel.hidden) $chaptersPanel.hidden = true;
		refreshSelectionMarkers();
	});
	for (const btn of $settingsPanel.querySelectorAll(".speed-btn")) {
		btn.addEventListener("click", () => {
			const m = parseFloat(btn.dataset.multiplier);
			if (Number.isFinite(m)) {
				settings.speedMultiplier = m;
				saveSettings();
				refreshSelectionMarkers();
			}
		});
	}
	for (const btn of $settingsPanel.querySelectorAll(".size-btn")) {
		btn.addEventListener("click", () => {
			const px = parseInt(btn.dataset.size, 10);
			if (Number.isFinite(px)) {
				settings.fontSize = px;
				saveSettings();
				applyFontSize();
				refreshSelectionMarkers();
			}
		});
	}
	for (const btn of $settingsPanel.querySelectorAll(".music-btn")) {
		btn.addEventListener("click", () => {
			const want = btn.dataset.music === "on";
			settings.musicOn = want;
			saveSettings();
			refreshSelectionMarkers();
			if (!want) {
				stopAllMusic();
			} else if (userGestured && pendingMusicName) {
				// Re-engage the scene's current track at full volume.
				const n = pendingMusicName;
				currentMusicName = "";
				swapMusic(n);
			}
		});
	}
	refreshSelectionMarkers();

	// Click outside the panel closes it.
	document.addEventListener("pointerdown", (ev) => {
		if ($settingsPanel.hidden) return;
		if (ev.target.closest(".settings-panel") || ev.target.closest(".settings-btn")) return;
		$settingsPanel.hidden = true;
	});
}

// ----- chapters menu -----
//
// Empty shell for now — the chapter list is populated when save/restore
// is wired up. Restart-from-beginning is functional today since it
// just resets the inkjs state and re-runs the start.

function bindChaptersMenu() {
	$chaptersBtn.addEventListener("click", () => {
		$chaptersPanel.hidden = !$chaptersPanel.hidden;
		// Mutual exclusion — only one corner panel visible at a time.
		if (!$chaptersPanel.hidden) {
			$settingsPanel.hidden = true;
			// Render on open so previously-saved bookmarks appear even
			// if no chapter: tag has fired yet this session, and so any
			// late-session changes are reflected.
			renderChapterList();
			updateReturnRecentVisibility();
		}
	});

	$restartBtn.addEventListener("click", () => {
		showConfirm({
			title: "Restart from beginning?",
			message: "Your reading position and chapter list will be cleared. This can't be undone.",
			confirmLabel: "Restart",
		}, () => {
			$chaptersPanel.hidden = true;
			restartFromBeginning();
		});
	});

	$returnRecentBtn.addEventListener("click", () => {
		$chaptersPanel.hidden = true;
		returnToMostRecent();
	});

	// Click outside the panel closes it.
	document.addEventListener("pointerdown", (ev) => {
		if ($chaptersPanel.hidden) return;
		if (ev.target.closest(".chapters-panel") || ev.target.closest(".chapters-btn")) return;
		$chaptersPanel.hidden = true;
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
	if (saved.bg)    swapBackground(saved.bg);
	if (saved.music) swapMusic(saved.music);
	if (saved.chapter) {
		currentChapterName = saved.chapter;
		showChapterTitleOverlay(saved.chapter);
	}
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
	const idx = chapterBookmarks.findIndex(b => b.name === spec);
	if (idx >= 0) chapterBookmarks[idx].state = stateJson;
	else chapterBookmarks.push({ name: spec, state: stateJson });
	currentChapterName = spec;
	saveChapterBookmarks();
	renderChapterList();
}

function renderChapterList() {
	$chapterList.innerHTML = "";
	if (chapterBookmarks.length === 0) {
		const empty = document.createElement("div");
		empty.className = "chapter-empty";
		empty.textContent = "Chapter list will appear here as you read.";
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
	try { story.state.LoadJson(bookmark.state); }
	catch (e) { console.warn("[chapters] LoadJson failed:", e); return; }
	if (currentReveal && currentReveal.skipFn) currentReveal.skipFn();
	currentReveal = null;
	$choices.innerHTML = "";
	$choices.classList.remove("visible");
	hideContinueHint();
	clearTranscript();
	// Enter exploration mode — autosave is now frozen at the user's
	// real most-recent point so they can return to it. The chapters
	// panel will surface a "Return to most recent point" button until
	// they leave exploration mode (return, restart, or title Continue).
	isExploring = true;
	state = "idle";
	// Don't manually call showChapterTitle here — the bookmark state is
	// from BEFORE the chapter: tag fires, so advance()'s next Continue()
	// will naturally re-emit the chapter/bg/music tags and applyTags
	// will fire showChapterTitle (and re-record the bookmark, idempotent).
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

function preloadImage(url) {
	if (preloadedBgs.has(url)) return;
	preloadedBgs.add(url);
	const img = new Image();
	img.src = url;
}

function prefetchUpcomingBgs(maxBgs) {
	if (!story) return;
	const seen = new Set();

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
				if (tag.startsWith("bg:")) {
					const name = tag.slice(3).trim();
					if (name) seen.add(name);
					if (seen.size >= maxBgs) return;
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
		preloadImage(ATMOSPHERE_DIR + name + ".png");
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
	$devClose.addEventListener("click", () => { $devPanel.hidden = true; });
	$devSearch.addEventListener("input", buildDevList);
}

function toggleDevPanel() {
	$devPanel.hidden = !$devPanel.hidden;
	if (!$devPanel.hidden) {
		$devSearch.value = "";
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
		$devSearch.focus();
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

	// On hit, returns the matched chunk's text + the bg/music tags
	// accumulated up to and including the matched chunk, with story
	// state left at the matched position so the caller can render it.
	// On miss, returns null and the caller is responsible for restoring
	// state (or calling ResetState before another search).
	function walk(latestBg, latestMusic) {
		while (safety-- > 0) {
			if (story.canContinue) {
				const text = story.Continue();
				for (const raw of (story.currentTags || [])) {
					const tag = String(raw).trim();
					if (tag.startsWith("bg:"))         latestBg = tag.slice(3).trim();
					else if (tag.startsWith("music:")) latestMusic = tag.slice(6).trim();
				}
				if (latestBg === targetName) {
					return { text, latestBg, latestMusic };
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
					const result = walk(latestBg, latestMusic);
					if (result) return result;
				}
				return null;
			} else {
				return null;
			}
		}
		return null;
	}

	const result = walk(null, null);
	if (!result) {
		console.warn("[dev] no path to bg:", targetName);
		return false;
	}

	// Match. Apply latest bg + music (skip chapter title overlay).
	if (result.latestBg)    swapBackground(result.latestBg);
	if (result.latestMusic) swapMusic(result.latestMusic);
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
