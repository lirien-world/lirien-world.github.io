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
const $proseContent = document.getElementById("prose-content");
const $prose = document.getElementById("prose");
const $continueHint = document.getElementById("continue-hint");
const $choices = document.getElementById("choices");
const $chapterTitle = document.getElementById("chapter-title");
const $settingsBtn = document.getElementById("settings-btn");
const $settingsPanel = document.getElementById("settings-panel");
const $titleScreen = document.getElementById("title-screen");
const $titleHint = document.getElementById("title-hint");

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

(async function init() {
	bindSettingsMenu();
	bindAdvanceInput();
	// Show the title screen immediately. The story.json fetch happens
	// in the background; until it resolves, the hint says "loading".
	// The first tap on the title screen unlocks audio and starts the
	// first chunk — which is also when any music tag finally sounds.
	state = "title-loading";
	requestAnimationFrame(() => $titleScreen.classList.add("visible"));
	try {
		const json = await fetch("story.json").then(r => r.text());
		story = new inkjs.Story(json);
		state = "title";
		// Swap the "loading…" text for the gold-line + "Enter" hint.
		const loadingEl = $titleHint.querySelector(".title-hint-loading");
		const readyEl = $titleHint.querySelector(".title-hint-ready");
		if (loadingEl) loadingEl.hidden = true;
		if (readyEl) readyEl.hidden = false;
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
		const text = story.Continue();
		applyTags(story.currentTags || []);
		const trimmed = (text || "").trim();
		if (trimmed.length === 0) continue;
		typeChunk(trimmed);
		return;
	}
	if (story.currentChoices && story.currentChoices.length > 0) {
		applyTags(story.currentTags || []);
		showChoices(story.currentChoices);
		return;
	}
	state = "ended";
	hideContinueHint();
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

function showChapterTitle(spec) {
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

	// Clear the prose transcript at chapter boundaries — same as the
	// Godot version's per-chapter fresh-buffer rule.
	clearTranscript();
}

// ----- backgrounds -----

function swapBackground(name) {
	const url = ATMOSPHERE_DIR + name + ".png";
	$bg.style.backgroundImage = `url("${url}")`;
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

		// Title screen: first tap dismisses + starts the story. Taps
		// during "title-loading" are ignored (story.json not parsed
		// yet); they still unlock audio via onFirstUserGesture above.
		if (state === "title") {
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
