// ----------------------------------------------------------------
// admin.js — The Reading Room
//
// Reads ?key=<secret> from URL, fetches predefined queries from
// /api/data, renders the dashboard. All charts themed to Lirien's
// gold-and-parchment palette via Chart.js v4.
// ----------------------------------------------------------------

(function () {
	"use strict";

	const params = new URLSearchParams(window.location.search);
	const KEY = params.get("key");

	// No key → show the auth overlay and stop. The page itself is
	// public (it's hosted on lirien.world); the data is what's gated.
	if (!KEY) {
		document.getElementById("auth-error").hidden = false;
		return;
	}

	const ENDPOINT = "/api/data";

	// Lirien palette — referenced from JS for Chart.js theming so the
	// CSS variables and the chart colors stay in lockstep.
	const PAL = {
		gold:        "#d4b878",
		goldBright:  "#fbf2d4",
		goldDeep:    "#c4935a",
		cream:       "#f5ebd2",
		mist:        "#a89ec0",
		ash:         "#7a7090",
		rule:        "rgba(245, 235, 210, 0.10)",
		ruleStrong:  "rgba(245, 235, 210, 0.18)",
		barFill:     "rgba(212, 184, 120, 0.12)",
		panelStrong: "rgba(11, 11, 18, 0.92)",
	};

	// Global Chart.js defaults — applied once, inherited by all charts.
	if (window.Chart) {
		Chart.defaults.color = PAL.cream;
		Chart.defaults.borderColor = PAL.rule;
		Chart.defaults.font.family = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
		Chart.defaults.font.size = 11;
		Chart.defaults.elements.bar.borderRadius = 1;
		Chart.defaults.elements.line.borderWidth = 1.5;
		Chart.defaults.plugins.tooltip.backgroundColor = PAL.panelStrong;
		Chart.defaults.plugins.tooltip.titleColor = PAL.cream;
		Chart.defaults.plugins.tooltip.bodyColor = PAL.cream;
		Chart.defaults.plugins.tooltip.borderColor = PAL.ruleStrong;
		Chart.defaults.plugins.tooltip.borderWidth = 1;
		Chart.defaults.plugins.tooltip.padding = 10;
		Chart.defaults.plugins.tooltip.titleFont = { family: Chart.defaults.font.family, size: 11, weight: "400" };
		Chart.defaults.plugins.tooltip.bodyFont = { family: Chart.defaults.font.family, size: 12 };
		Chart.defaults.plugins.tooltip.displayColors = false;
		Chart.defaults.plugins.tooltip.cornerRadius = 6;
	}

	// ---- helpers --------------------------------------------------

	async function fetchQuery(name) {
		const u = `${ENDPOINT}?key=${encodeURIComponent(KEY)}&q=${encodeURIComponent(name)}`;
		let res;
		try { res = await fetch(u, { cache: "no-store" }); }
		catch (e) { throw new Error("Network error reaching the room."); }

		if (res.status === 401) {
			document.getElementById("auth-error").hidden = false;
			throw new Error("unauthorized");
		}
		if (!res.ok) {
			throw new Error(`Query ${name} failed: ${res.status}`);
		}
		const json = await res.json();
		return json.results || [];
	}

	function fmt(n) {
		if (n === null || n === undefined || (typeof n === "number" && isNaN(n))) return "—";
		if (typeof n === "number" && n >= 1000) return n.toLocaleString();
		return String(n);
	}

	function escapeHtml(s) {
		if (s === null || s === undefined) return "";
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	// Vertical gradient for bar fills — reads as a soft gold lit from
	// above. Returns a CanvasGradient so Chart.js can use it per bar.
	function goldGradient(ctx, area) {
		if (!area) return PAL.gold;
		const g = ctx.createLinearGradient(0, area.bottom, 0, area.top);
		g.addColorStop(0,    "rgba(196, 147, 90, 0.85)");
		g.addColorStop(0.5,  "rgba(212, 184, 120, 0.95)");
		g.addColorStop(1,    "rgba(251, 242, 212, 1.00)");
		return g;
	}

	// ---- summary callouts -----------------------------------------

	async function loadSummary() {
		const rows = await fetchQuery("summary");
		const r = rows[0] || {};
		document.querySelectorAll("[data-value]").forEach((el) => {
			const key = el.dataset.value;
			const suffix = el.dataset.suffix || "";
			const v = r[key];
			el.textContent = (v === null || v === undefined) ? "—" : fmt(v) + suffix;
		});
	}

	// ---- where readers stop ---------------------------------------

	async function loadDropoff() {
		const rows = await fetchQuery("dropoff");
		const labels = rows.map((r) => r.bg);
		const data   = rows.map((r) => r.sessions);

		new Chart(document.getElementById("chart-dropoff"), {
			type: "bar",
			data: {
				labels,
				datasets: [{
					data,
					backgroundColor: (ctx) => goldGradient(ctx.chart.ctx, ctx.chart.chartArea),
					hoverBackgroundColor: PAL.goldBright,
					borderWidth: 0,
					barThickness: "flex",
					maxBarThickness: 28,
					categoryPercentage: 0.86,
					barPercentage: 0.92,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 700, easing: "easeOutQuart" },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							title: (items) => items[0].label,
							label: (item) => `${item.formattedValue} session${item.raw === 1 ? "" : "s"} reached`,
						},
					},
				},
				scales: {
					x: {
						ticks: {
							color: PAL.mist,
							font: { size: 9 },
							maxRotation: 70,
							minRotation: 70,
							autoSkip: false,
						},
						grid: { display: false },
						border: { color: PAL.ruleStrong },
					},
					y: {
						beginAtZero: true,
						ticks: { color: PAL.mist, precision: 0 },
						grid: { color: PAL.rule, drawBorder: false },
						border: { display: false },
					},
				},
			},
		});
	}

	// ---- which way they turned ------------------------------------

	async function loadChoices() {
		const rows = await fetchQuery("choices");

		// Group by bg client-side so we can render one row per branch.
		const byBg = {};
		rows.forEach((r) => {
			if (!r.bg) return;
			(byBg[r.bg] = byBg[r.bg] || []).push(r);
		});

		const container = document.getElementById("choices-list");
		container.innerHTML = "";

		const branches = Object.keys(byBg);
		if (!branches.length) {
			const p = document.createElement("p");
			p.className = "empty-state";
			p.textContent = "No choices recorded yet. Wait for the readers.";
			container.appendChild(p);
			return;
		}

		for (const bg of branches) {
			const choices = byBg[bg].slice().sort((a, b) => a.idx - b.idx);
			const total = choices.reduce((s, c) => s + (c.picks || 0), 0);

			const row = document.createElement("article");
			row.className = "choice-row";

			const label = document.createElement("div");
			label.className = "choice-bg";
			label.textContent = bg;
			row.appendChild(label);

			const bars = document.createElement("div");
			bars.className = "choice-bars";

			for (const c of choices) {
				const pct = total > 0 ? (c.picks / total * 100) : 0;
				const bar = document.createElement("div");
				bar.className = "choice-bar";
				bar.innerHTML =
					`<span class="choice-bar-idx">${escapeHtml(String(c.idx))}</span>` +
					`<span class="choice-bar-track">` +
						`<span class="choice-bar-fill" style="width: ${pct.toFixed(2)}%"></span>` +
					`</span>` +
					`<span class="choice-bar-pct"><span class="pct-num">${pct.toFixed(0)}%</span> · ${escapeHtml(String(c.picks))}</span>`;
				bars.appendChild(bar);
			}

			row.appendChild(bars);
			container.appendChild(row);
		}
	}

	// ---- cache hit rate over time ---------------------------------

	async function loadCacheOverTime() {
		const rows = await fetchQuery("cache_over_time");
		const labels = rows.map((r) => r.day);
		const data   = rows.map((r) => r.hit_pct);

		new Chart(document.getElementById("chart-cache"), {
			type: "line",
			data: {
				labels,
				datasets: [{
					data,
					borderColor: PAL.gold,
					backgroundColor: (ctx) => {
						const a = ctx.chart.chartArea;
						if (!a) return "rgba(212, 184, 120, 0.08)";
						const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
						g.addColorStop(0, "rgba(212, 184, 120, 0.18)");
						g.addColorStop(1, "rgba(212, 184, 120, 0)");
						return g;
					},
					fill: true,
					tension: 0.28,
					borderWidth: 1.5,
					pointBackgroundColor: PAL.goldBright,
					pointBorderColor: PAL.gold,
					pointBorderWidth: 1,
					pointRadius: 3,
					pointHoverRadius: 5,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 800, easing: "easeOutQuart" },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: { label: (item) => `${item.formattedValue}% cached` },
					},
				},
				scales: {
					x: {
						ticks: { color: PAL.mist },
						grid: { display: false },
						border: { color: PAL.ruleStrong },
					},
					y: {
						beginAtZero: true,
						max: 100,
						ticks: { color: PAL.mist, callback: (v) => `${v}%` },
						grid: { color: PAL.rule, drawBorder: false },
						border: { display: false },
					},
				},
			},
		});
	}

	// ---- slowest cold loads ---------------------------------------

	async function loadSlow() {
		const rows = await fetchQuery("slow_assets");
		const tbody = document.querySelector("#slow-table tbody");

		if (!rows.length) {
			tbody.innerHTML =
				`<tr><td colspan="4" class="empty">No cold loads recorded. The cache is doing its work.</td></tr>`;
			return;
		}

		tbody.innerHTML = rows.map((r) => {
			const meta = r.type ? `<span class="row-meta">${escapeHtml(r.type)}</span>` : "";
			return `
				<tr>
					<td>${escapeHtml(r.name || "—")}${meta}</td>
					<td class="num">${fmt(r.avg_ms)}</td>
					<td class="num">${fmt(r.max_ms)}</td>
					<td class="num">${fmt(r.samples)}</td>
				</tr>
			`;
		}).join("");
	}

	// ---- errors and offline blocks --------------------------------

	async function loadErrors() {
		const rows = await fetchQuery("errors");
		const tbody = document.querySelector("#errors-table tbody");

		if (!rows.length) {
			tbody.innerHTML =
				`<tr><td colspan="4" class="empty">No errors. The room is undisturbed.</td></tr>`;
			return;
		}

		tbody.innerHTML = rows.map((r) => {
			const where = r.bg || r.name || "—";
			const detail = r.message || "—";
			return `
				<tr>
					<td>${escapeHtml(r.event_name)}</td>
					<td>${escapeHtml(where)}</td>
					<td>${escapeHtml(detail)}</td>
					<td class="num">${fmt(r.n)}</td>
				</tr>
			`;
		}).join("");
	}

	// ---- time at each scene (heatmap-style horizontal bar) --------

	async function loadPace() {
		const rows = await fetchQuery("pace");
		if (!rows.length) return;

		const labels = rows.map((r) => r.bg);
		const data   = rows.map((r) => r.avg_ms);
		const max    = Math.max(...data);

		// Per-bar opacity ramp — slow scenes saturate to gold, quick
		// scenes ghost down to a hint. Power 0.55 keeps the lower end
		// perceptible while preserving emphasis at the top end.
		const bgFor = (v) => {
			const t = max > 0 ? Math.pow(v / max, 0.55) : 0;
			const opacity = 0.22 + 0.78 * t;
			return `rgba(212, 184, 120, ${opacity.toFixed(3)})`;
		};

		new Chart(document.getElementById("chart-pace"), {
			type: "bar",
			data: {
				labels,
				datasets: [{
					data,
					backgroundColor: (ctx) => bgFor(ctx.raw),
					hoverBackgroundColor: PAL.goldBright,
					borderWidth: 0,
					barThickness: "flex",
					maxBarThickness: 22,
				}],
			},
			options: {
				indexAxis: "y",
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 700, easing: "easeOutQuart" },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							title: (items) => items[0].label,
							label: (item) => `${(item.raw / 1000).toFixed(1)}s avg`,
						},
					},
				},
				scales: {
					x: {
						beginAtZero: true,
						ticks: {
							color: PAL.mist,
							callback: (v) => `${(v / 1000).toFixed(1)}s`,
						},
						grid: { color: PAL.rule, drawBorder: false },
						border: { display: false },
					},
					y: {
						ticks: { color: PAL.mist, font: { size: 10 } },
						grid: { display: false },
						border: { color: PAL.ruleStrong },
					},
				},
			},
		});
	}

	// ---- shared mini-bar chart factory ----------------------------
	//
	// The device + settings sections all want the same chart shape: a
	// short categorical bar chart with gold gradient bars, mist axis
	// ticks, no grid clutter. One factory keeps them visually identical.

	function miniBarChart(canvasId, labels, data, opts) {
		opts = opts || {};
		const ctx = document.getElementById(canvasId);
		if (!ctx) return;
		new Chart(ctx, {
			type: "bar",
			data: {
				labels,
				datasets: [{
					data,
					backgroundColor: (c) => goldGradient(c.chart.ctx, c.chart.chartArea),
					hoverBackgroundColor: PAL.goldBright,
					borderWidth: 0,
					barThickness: "flex",
					maxBarThickness: 28,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 700, easing: "easeOutQuart" },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							title: (items) => items[0].label,
							label: (item) => opts.tooltipLabel
								? opts.tooltipLabel(item)
								: `${item.formattedValue} session${item.raw === 1 ? "" : "s"}`,
						},
					},
				},
				scales: {
					x: {
						ticks: { color: PAL.mist, font: { size: 10 } },
						grid: { display: false },
						border: { color: PAL.ruleStrong },
					},
					y: {
						beginAtZero: true,
						ticks: { color: PAL.mist, precision: 0, font: { size: 10 } },
						grid: { color: PAL.rule, drawBorder: false },
						border: { display: false },
					},
				},
			},
		});
	}

	// Sort entries (label, n) tuples by descending count, with "other"
	// pinned to the end so it never crowds out a real value.
	function sortedByCount(rows, labelKey) {
		const out = rows.slice();
		out.sort((a, b) => {
			if (a[labelKey] === "other" && b[labelKey] !== "other") return 1;
			if (b[labelKey] === "other" && a[labelKey] !== "other") return -1;
			return (b.n || 0) - (a.n || 0);
		});
		return out;
	}

	// ---- how they came in (devices) -------------------------------

	async function loadDeviceBreakdown() {
		const rows = await fetchQuery("device_breakdown");

		// The query returns one row per (platform, browser, device_class,
		// standalone) combination. Roll up to three independent histograms.
		const sumBy = (key) => {
			const map = {};
			rows.forEach((r) => {
				const k = r[key] === null || r[key] === undefined ? "unknown" : String(r[key]);
				map[k] = (map[k] || 0) + (r.n || 0);
			});
			return Object.keys(map).map((k) => ({ label: k, n: map[k] }));
		};

		const platforms = sortedByCount(sumBy("platform").map((x) => ({ platform: x.label, n: x.n })), "platform");
		const browsers  = sortedByCount(sumBy("browser").map((x) => ({ browser: x.label, n: x.n })), "browser");
		const classes   = sortedByCount(sumBy("device_class").map((x) => ({ device_class: x.label, n: x.n })), "device_class");

		miniBarChart("chart-device-platform", platforms.map((r) => r.platform), platforms.map((r) => r.n));
		miniBarChart("chart-device-browser",  browsers.map((r) => r.browser),   browsers.map((r) => r.n));
		miniBarChart("chart-device-class",    classes.map((r) => r.device_class), classes.map((r) => r.n));
	}

	// ---- the door off the street (install funnel) ----------------

	async function loadInstallFunnel() {
		const rows = await fetchQuery("install_funnel");
		const counts = {};
		rows.forEach((r) => { counts[r.event_name] = r.n || 0; });

		const titleSeen        = counts.title_seen || 0;
		const splashSeen       = counts.splash_seen || 0;
		const splashDismissed  = counts.splash_dismissed || 0;
		const installPrompted  = counts.install_prompted || 0;
		const installAccepted  = counts.install_accepted || 0;
		const installRejected  = counts.install_rejected || 0;
		const standaloneStart  = counts.standalone_session || 0;

		// Stages, in narrative order. Each row gets a count; the bar
		// fills relative to the page's title-screen views (the widest
		// part of the funnel for non-standalone visits).
		const denom = Math.max(titleSeen, splashSeen, 1);
		const stages = [
			{ label: "Saw the title",        sub: "title_seen",       n: titleSeen },
			{ label: "Saw the splash",       sub: "splash_seen",      n: splashSeen },
			{ label: "Dismissed the splash", sub: "splash_dismissed", n: splashDismissed },
			{ label: "Tapped install",       sub: "install_prompted", n: installPrompted },
			{ label: "Accepted",             sub: "install_accepted", n: installAccepted, gold: true },
			{ label: "Rejected",             sub: "install_rejected", n: installRejected },
			{ label: "Already standalone",   sub: "session_start with standalone=1", n: standaloneStart },
		];

		const list = document.getElementById("funnel-list");
		list.innerHTML = "";
		const anyData = stages.some((s) => s.n > 0);
		if (!anyData) {
			const p = document.createElement("p");
			p.className = "empty-state";
			p.textContent = "No funnel data yet. Wait for a reader to find the door.";
			list.appendChild(p);
			return;
		}

		for (const s of stages) {
			const pct = s.n > 0 ? Math.min(100, (s.n / denom) * 100) : 0;
			const row = document.createElement("div");
			row.className = "funnel-row";
			row.innerHTML =
				`<div class="funnel-label">${escapeHtml(s.label)}<span class="funnel-sub">${escapeHtml(s.sub)}</span></div>` +
				`<div class="funnel-track"><span class="funnel-fill" style="width: ${pct.toFixed(2)}%"></span></div>` +
				`<div class="funnel-num">${escapeHtml(String(s.n))}<span class="pct-num">${pct.toFixed(0)}%</span></div>`;
			list.appendChild(row);
		}
	}

	// ---- how they have it set (settings distribution) ------------

	async function loadSettingsDistribution() {
		const rows = await fetchQuery("settings_distribution");

		const sumBy = (key, labelFn) => {
			const map = {};
			rows.forEach((r) => {
				const v = r[key];
				const lbl = labelFn ? labelFn(v) : String(v);
				map[lbl] = (map[lbl] || 0) + (r.n || 0);
			});
			return map;
		};

		// Speed: numeric multipliers, sorted ascending so 0.5 → 1.0 → 2.0
		// reads left-to-right as "slower → faster."
		const speedMap = sumBy("speed", (v) => (v === null || v === undefined ? "—" : `${v}×`));
		const speedKeys = Object.keys(speedMap).sort((a, b) => parseFloat(a) - parseFloat(b));
		miniBarChart("chart-set-speed", speedKeys, speedKeys.map((k) => speedMap[k]));

		// Size: integer pixels, sorted ascending.
		const sizeMap = sumBy("size", (v) => (v === null || v === undefined ? "—" : `${v}px`));
		const sizeKeys = Object.keys(sizeMap).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
		miniBarChart("chart-set-size", sizeKeys, sizeKeys.map((k) => sizeMap[k]));

		// Music: boolean — relabel for legibility.
		const musicMap = sumBy("music", (v) => (v === 1 || v === true ? "On" : v === 0 || v === false ? "Off" : "—"));
		const musicKeys = ["On", "Off"].filter((k) => musicMap[k] !== undefined);
		miniBarChart("chart-set-music", musicKeys, musicKeys.map((k) => musicMap[k]));
	}

	// ---- what they were doing when they left ---------------------

	async function loadDropoutState() {
		const rows = await fetchQuery("dropout_state");
		// Friendlier labels in the literary register; preserve unknown.
		const order = ["typing", "waiting", "choosing", "ended", "idle", "unknown"];
		const labelMap = {
			typing:   "Mid-sentence",
			waiting:  "Waiting to tap",
			choosing: "At a choice",
			ended:    "Finished a chapter",
			idle:     "On the title",
			unknown:  "Unknown",
		};
		const counts = {};
		rows.forEach((r) => { counts[r.last_state || "unknown"] = r.n || 0; });
		const present = order.filter((k) => counts[k]);
		const labels = present.map((k) => labelMap[k] || k);
		const data   = present.map((k) => counts[k]);

		miniBarChart("chart-dropout-state", labels, data, {
			tooltipLabel: (item) => `${item.formattedValue} session${item.raw === 1 ? "" : "s"} ended here`,
		});
	}

	// ---- when they read (hour of day) ----------------------------

	async function loadTimeOfDay() {
		const rows = await fetchQuery("time_of_day");

		// Pad to all 24 hours so the chart shape is stable and the
		// quiet hours read as actual zeros, not missing data.
		const buckets = new Array(24).fill(0);
		rows.forEach((r) => {
			const h = parseInt(r.hour_local, 10);
			if (Number.isFinite(h) && h >= 0 && h < 24) buckets[h] += (r.n || 0);
		});
		const labels = buckets.map((_, h) => {
			if (h === 0) return "12a";
			if (h === 12) return "12p";
			return h < 12 ? `${h}a` : `${h - 12}p`;
		});

		new Chart(document.getElementById("chart-time-of-day"), {
			type: "bar",
			data: {
				labels,
				datasets: [{
					data: buckets,
					backgroundColor: (c) => goldGradient(c.chart.ctx, c.chart.chartArea),
					hoverBackgroundColor: PAL.goldBright,
					borderWidth: 0,
					barThickness: "flex",
					maxBarThickness: 18,
					categoryPercentage: 0.92,
					barPercentage: 0.86,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 700, easing: "easeOutQuart" },
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							title: (items) => items[0].label + " (local)",
							label: (item) => `${item.formattedValue} session${item.raw === 1 ? "" : "s"} started`,
						},
					},
				},
				scales: {
					x: {
						ticks: { color: PAL.mist, font: { size: 10 }, autoSkip: false, maxRotation: 0 },
						grid: { display: false },
						border: { color: PAL.ruleStrong },
					},
					y: {
						beginAtZero: true,
						ticks: { color: PAL.mist, precision: 0 },
						grid: { color: PAL.rule, drawBorder: false },
						border: { display: false },
					},
				},
			},
		});
	}

	// ---- last refresh stamp ---------------------------------------

	function setRefresh() {
		const el = document.getElementById("last-refresh");
		const now = new Date();
		el.textContent = now.toLocaleString(undefined, {
			hour: "numeric", minute: "2-digit",
			day: "numeric", month: "short",
		});
	}

	// ---- orchestration -------------------------------------------

	async function loadAll() {
		setRefresh();
		// Run all queries in parallel; let each handle its own rendering.
		// Promise.allSettled so one failed chart doesn't block the others.
		await Promise.allSettled([
			loadSummary(),
			loadDropoff(),
			loadChoices(),
			loadCacheOverTime(),
			loadSlow(),
			loadErrors(),
			loadPace(),
			loadDeviceBreakdown(),
			loadInstallFunnel(),
			loadSettingsDistribution(),
			loadDropoutState(),
			loadTimeOfDay(),
		]);
	}

	loadAll();
})();
