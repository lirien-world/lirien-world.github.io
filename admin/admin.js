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

	// Worker is on api.lirien.world while the main site is gray-cloud
	// (Spanish CF-IP block workaround). Absolute URL is required — a
	// relative /api/data would hit lirien.world (GH Pages) and 404.
	const ENDPOINT = "https://api.lirien.world/api/data";

	// ---- filters --------------------------------------------------
	//
	// URL state model:
	//   ?range=today|week|month|30d|all|custom  (default: 30d)
	//   ?from=YYYY-MM-DD&to=YYYY-MM-DD          (only when range=custom)
	//   ?device=phone|tablet|desktop
	//   ?browser=safari|chrome|firefox|edge|samsung|other
	//   ?standalone=true|false
	//   ?conn_type=4g|3g|2g|slow-2g
	//
	// The Worker only understands from/to + the dimensional filters —
	// it doesn't know about presets. The dashboard converts range→dates
	// before sending. Custom range exposes the from/to inputs directly.

	function pad(n) { return n < 10 ? "0" + n : "" + n; }
	function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

	// Returns YYYY-MM-DD strings (local). Worker treats these as
	// inclusive bounds: from→00:00:00, to→23:59:59.999.
	function rangeToDates(range) {
		const today = new Date();
		const t = (offsetDays) => {
			const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetDays);
			return isoDate(d);
		};
		switch (range) {
			case "today":
				return { from: isoDate(today), to: isoDate(today) };
			case "week": {
				// Calendar week: most recent Monday → today
				const day = today.getDay() || 7; // Sunday=0 → 7
				return { from: t(day - 1), to: isoDate(today) };
			}
			case "month": {
				const first = new Date(today.getFullYear(), today.getMonth(), 1);
				return { from: isoDate(first), to: isoDate(today) };
			}
			case "30d":
				return { from: t(30), to: isoDate(today) };
			case "all":
				return { from: "2020-01-01", to: isoDate(today) };
			case "custom":
				return null; // caller reads ?from, ?to directly
			default:
				return { from: t(30), to: isoDate(today) };
		}
	}

	function readFiltersFromUrl() {
		const range = params.get("range") || "30d";
		const dates = rangeToDates(range);
		const from = (range === "custom") ? params.get("from") : (dates && dates.from);
		const to   = (range === "custom") ? params.get("to")   : (dates && dates.to);
		return {
			range, from, to,
			device:        params.get("device")        || "",
			browser:       params.get("browser")       || "",
			standalone:    params.get("standalone")    || "",
			conn_type:     params.get("conn_type")     || "",
			severity:      params.get("severity")      || "",
			dropoff_mode:  params.get("dropoff_mode")  || "",
			slow_mode:     params.get("slow_mode")     || "",
		};
	}

	const FILTERS = readFiltersFromUrl();

	// Build a URL-encoded query string for the Worker call. Drops
	// empty values so the Worker sees only what's actually filtering.
	function workerQueryString(name) {
		const u = new URLSearchParams();
		u.set("key", KEY);
		u.set("q", name);
		if (FILTERS.from) u.set("from", FILTERS.from);
		if (FILTERS.to)   u.set("to",   FILTERS.to);
		if (FILTERS.device)     u.set("device", FILTERS.device);
		if (FILTERS.browser)    u.set("browser", FILTERS.browser);
		if (FILTERS.standalone) u.set("standalone", FILTERS.standalone);
		if (FILTERS.conn_type)  u.set("conn_type", FILTERS.conn_type);
		if (FILTERS.severity)     u.set("severity", FILTERS.severity);
		if (FILTERS.dropoff_mode) u.set("dropoff_mode", FILTERS.dropoff_mode);
		if (FILTERS.slow_mode)    u.set("slow_mode", FILTERS.slow_mode);
		return u.toString();
	}

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
		const u = `${ENDPOINT}?${workerQueryString(name)}`;
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

	// Render an error row into a table's tbody when its loader throws —
	// otherwise the initial "Loading…" placeholder sits forever and the
	// failure looks like a stuck state. Used by every table-based loader
	// via try/catch around the fetchQuery + render block.
	function renderTableError(selector, colspan, msg) {
		const tbody = document.querySelector(selector);
		if (!tbody) return;
		const safe = String(msg || "Couldn't load.")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
		tbody.innerHTML =
			`<tr><td colspan="${colspan}" class="empty">Couldn't load — ${safe}</td></tr>`;
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
							font: { size: 11 },
							maxRotation: 30,
							minRotation: 30,
							autoSkip: false,
							// Per-bar labels are unreadable at this density;
							// instead, surface only the first scene of each
							// chapter as a "Chapter N" marker. Hover still
							// reveals the exact bg name via the tooltip.
							callback: function (value, index) {
								const label = this.getLabelForValue(value);
								const m = label && label.match(/^ch(\d+)_/);
								if (!m) return "";
								const ch = parseInt(m[1], 10);
								if (index === 0) return `Chapter ${ch}`;
								const prev = this.chart.data.labels[index - 1];
								const pm = prev && prev.match(/^ch(\d+)_/);
								return (!pm || parseInt(pm[1], 10) !== ch) ? `Chapter ${ch}` : "";
							},
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
		try {
			const queryName = FILTERS.slow_mode === "perceived" ? "slow_assets_perceived" : "slow_assets";
			const rows = await fetchQuery(queryName);
			const tbody = document.querySelector("#slow-table tbody");

			if (!rows.length) {
				const emptyMsg = FILTERS.slow_mode === "perceived"
					? "No reader-felt waits in this window. The pacing held."
					: "No cold loads recorded. The cache is doing its work.";
				tbody.innerHTML =
					`<tr><td colspan="4" class="empty">${emptyMsg}</td></tr>`;
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
		} catch (e) {
			if (e.message === "unauthorized") return;
			renderTableError("#slow-table tbody", 4, e.message);
		}
	}

	// ---- errors and offline blocks --------------------------------

	async function loadErrors() {
		try {
			const rows = await fetchQuery("errors");
			const tbody = document.querySelector("#errors-table tbody");

			if (!rows.length) {
				tbody.innerHTML =
					`<tr><td colspan="5" class="empty">Nothing in this severity. The room is undisturbed.</td></tr>`;
				return;
			}

			tbody.innerHTML = rows.map((r) => {
				const where = r.bg || r.name || "—";
				const detail = r.message || "—";
				const severity = r.severity || "error";
				return `
					<tr class="sev-${escapeHtml(severity)}">
						<td>${escapeHtml(r.event_name)}</td>
						<td><span class="severity-tag severity-${escapeHtml(severity)}">${escapeHtml(severity)}</span></td>
						<td>${escapeHtml(where)}</td>
						<td>${escapeHtml(detail)}</td>
						<td class="num">${fmt(r.n)}</td>
					</tr>
				`;
			}).join("");
		} catch (e) {
			if (e.message === "unauthorized") return;
			renderTableError("#errors-table tbody", 5, e.message);
		}
	}

	function initDropoffModePills() {
		const pills = document.querySelectorAll("#dropoff-mode-pills .filter-chip");
		const current = FILTERS.dropoff_mode || "";
		for (const pill of pills) {
			const mode = pill.dataset.dropoffMode || "";
			pill.setAttribute("aria-pressed", mode === current ? "true" : "false");
			pill.addEventListener("click", () => {
				// Anchor to the dropoff section so the page scrolls
				// back here after the URL-driven reload — same pattern
				// as the severity pills.
				setUrlAndReload({ dropoff_mode: mode || null }, "sec-dropoff");
			});
		}
	}

	function initSeverityPills() {
		const pills = document.querySelectorAll(".severity-pills .filter-chip");
		const current = FILTERS.severity || "";
		for (const pill of pills) {
			const sev = pill.dataset.severity || "";
			pill.setAttribute("aria-pressed", sev === current ? "true" : "false");
			pill.addEventListener("click", () => {
				// Anchor to the errors section so the browser scrolls
				// back here after reload instead of trying to maintain
				// the Y coordinate (which lands somewhere unrelated
				// when the table size changes).
				setUrlAndReload({ severity: sev || null }, "sec-errors");
			});
		}
	}

	function initSlowModePills() {
		const pills = document.querySelectorAll("#slow-mode-pills .filter-chip");
		const current = FILTERS.slow_mode || "";
		for (const pill of pills) {
			const mode = pill.dataset.slowMode || "";
			pill.setAttribute("aria-pressed", mode === current ? "true" : "false");
			pill.addEventListener("click", () => {
				setUrlAndReload({ slow_mode: mode || null }, "sec-slow");
			});
		}
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

		// Map raw setting values to the friendly labels the reader app's
		// settings menu uses, so this chart speaks the same language as
		// the UI. If a value falls outside the known set (e.g. someone
		// opened a developer console and set a custom value), fall back
		// to the raw number — the chart still renders, just less prettily.
		const SPEED_LABELS = {
			0.2: "Very slow",
			0.3: "Slow",
			0.4: "Normal",
			0.7: "Fast",
			1.0: "Very fast",
		};
		const SPEED_ORDER = ["Very slow", "Slow", "Normal", "Fast", "Very fast"];

		const SIZE_LABELS = {
			28: "Small",
			32: "Medium",
			36: "Large",
			42: "Very large",
		};
		const SIZE_ORDER = ["Small", "Medium", "Large", "Very large"];

		const speedFor = (v) => {
			if (v === null || v === undefined) return "—";
			const num = typeof v === "number" ? v : parseFloat(v);
			return SPEED_LABELS[num] || `${num}×`;
		};
		const sizeFor = (v) => {
			if (v === null || v === undefined) return "—";
			const num = typeof v === "number" ? v : parseInt(v, 10);
			return SIZE_LABELS[num] || `${num}px`;
		};

		const sumBy = (key, labelFn) => {
			const map = {};
			rows.forEach((r) => {
				const v = r[key];
				const lbl = labelFn ? labelFn(v) : String(v);
				map[lbl] = (map[lbl] || 0) + (r.n || 0);
			});
			return map;
		};

		// Sort keys by canonical order, falling back to insertion order
		// for any unknown raw values (so they still appear at the end
		// rather than being dropped).
		const orderKeys = (mapObj, canonical) => {
			const present = new Set(Object.keys(mapObj));
			const ordered = canonical.filter((k) => present.has(k));
			for (const k of present) if (!canonical.includes(k)) ordered.push(k);
			return ordered;
		};

		const speedMap = sumBy("speed", speedFor);
		const speedKeys = orderKeys(speedMap, SPEED_ORDER);
		miniBarChart("chart-set-speed", speedKeys, speedKeys.map((k) => speedMap[k]));

		const sizeMap = sumBy("size", sizeFor);
		const sizeKeys = orderKeys(sizeMap, SIZE_ORDER);
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

	// ---- how long the pages took (latency percentiles) -----------

	async function loadLatencyPercentiles() {
		try {
			const rows = await fetchQuery("asset_load_percentiles");
			const tbody = document.querySelector("#latency-table tbody");
			if (!rows.length) {
				tbody.innerHTML =
					`<tr><td colspan="7" class="empty">No timing data yet.</td></tr>`;
				return;
			}
			// Sort: type asc, then state by canonical order
			const stateOrder = { hit: 0, revalidated: 1, fresh: 2, unknown: 3 };
			rows.sort((a, b) => {
				const t = String(a.type || "").localeCompare(String(b.type || ""));
				if (t !== 0) return t;
				return (stateOrder[a.cache_state] || 9) - (stateOrder[b.cache_state] || 9);
			});
			tbody.innerHTML = rows.map((r) => {
				const state = String(r.cache_state || "unknown");
				return `
					<tr>
						<td>${escapeHtml(r.type || "—")}</td>
						<td><span class="row-meta" style="margin-left:0">${escapeHtml(state)}</span></td>
						<td class="num">${fmt(r.p50)}</td>
						<td class="num">${fmt(r.p90)}</td>
						<td class="num">${fmt(r.p99)}</td>
						<td class="num">${fmt(r.max_ms)}</td>
						<td class="num">${fmt(r.samples)}</td>
					</tr>
				`;
			}).join("");
		} catch (e) {
			if (e.message === "unauthorized") return;
			renderTableError("#latency-table tbody", 7, e.message);
		}
	}

	// ---- where the reader waited (soft wait distribution) -------

	async function loadSoftWait() {
		const rows = await fetchQuery("bg_late_distribution");
		const order = ["under_100ms", "100_250ms", "250_500ms", "500_1000ms", "1_2s", "2_5s", "over_5s"];
		const labelMap = {
			under_100ms:  "<100ms",
			"100_250ms":  "100-250ms",
			"250_500ms":  "250-500ms",
			"500_1000ms": "500ms-1s",
			"1_2s":       "1-2s",
			"2_5s":       "2-5s",
			over_5s:      ">5s",
		};
		const counts = {};
		rows.forEach((r) => { counts[r.bucket] = r.n || 0; });
		const labels = order.map((k) => labelMap[k]);
		const data   = order.map((k) => counts[k] || 0);

		new Chart(document.getElementById("chart-soft-wait"), {
			type: "bar",
			data: {
				labels,
				datasets: [{
					data,
					backgroundColor: (c) => goldGradient(c.chart.ctx, c.chart.chartArea),
					hoverBackgroundColor: PAL.goldBright,
					borderWidth: 0,
					barThickness: "flex",
					maxBarThickness: 32,
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
							title: (items) => "Wait: " + items[0].label,
							label: (item) => `${item.formattedValue} chunk${item.raw === 1 ? "" : "s"} arrived this late`,
						},
					},
				},
				scales: {
					x: {
						ticks: { color: PAL.mist, font: { size: 11 }, autoSkip: false, maxRotation: 0 },
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

	// ---- the wire they came through (connection breakdown) ------

	async function loadConnectionBreakdown() {
		try {
			const rows = await fetchQuery("connection_breakdown");
			const tbody = document.querySelector("#connection-table tbody");
			if (!rows.length) {
				tbody.innerHTML =
					`<tr><td colspan="5" class="empty">No connection data yet.</td></tr>`;
				return;
			}
			// Sort: known buckets first by canonical order, unknown last
			const order = { "4g": 0, "3g": 1, "2g": 2, "slow-2g": 3, unknown: 9 };
			rows.sort((a, b) => (order[a.conn_type] || 9) - (order[b.conn_type] || 9));
			tbody.innerHTML = rows.map((r) => {
				return `
					<tr>
						<td>${escapeHtml(String(r.conn_type || "unknown"))}</td>
						<td class="num">${r.avg_downlink_mbps != null ? fmt(r.avg_downlink_mbps) : "—"}</td>
						<td class="num">${r.avg_rtt_ms != null ? fmt(r.avg_rtt_ms) : "—"}</td>
						<td class="num">${fmt(r.save_data_n || 0)}</td>
						<td class="num">${fmt(r.sessions)}</td>
					</tr>
				`;
			}).join("");
		} catch (e) {
			if (e.message === "unauthorized") return;
			renderTableError("#connection-table tbody", 5, e.message);
		}
	}

	// ---- filter UI wiring ----------------------------------------

	function setUrlAndReload(updates, anchor) {
		const u = new URL(window.location.href);
		for (const [k, v] of Object.entries(updates)) {
			if (v === null || v === "") u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		// Optional anchor — for filter changes that happen mid-page
		// (severity pills inside the errors section), pass the
		// section's id so the browser scrolls back to the section
		// after reload. Without this, browser scroll-restoration
		// tries to keep the Y coordinate stable, but the content
		// height changes when the filter changes (table grows or
		// shrinks), so Y=4500 ends up in a completely different
		// section.
		if (anchor) u.hash = anchor;
		// Preserve key when reloading.
		window.location.href = u.toString();
	}

	function initFilterBar() {
		const presets = document.getElementById("date-presets");
		const customInputs = document.getElementById("filter-custom-dates");
		const fromInput = document.getElementById("filter-from");
		const toInput   = document.getElementById("filter-to");

		// Highlight the active preset chip.
		for (const chip of presets.querySelectorAll(".filter-chip")) {
			chip.setAttribute("aria-pressed", chip.dataset.preset === FILTERS.range ? "true" : "false");
			chip.addEventListener("click", () => {
				const preset = chip.dataset.preset;
				if (preset === "custom") {
					// Default custom inputs to current filter window if not yet set.
					if (!params.get("from") && FILTERS.from) fromInput.value = FILTERS.from;
					if (!params.get("to")   && FILTERS.to)   toInput.value   = FILTERS.to;
					setUrlAndReload({
						range: "custom",
						from:  fromInput.value || FILTERS.from || null,
						to:    toInput.value   || FILTERS.to   || null,
					});
				} else {
					setUrlAndReload({ range: preset, from: null, to: null });
				}
			});
		}

		if (FILTERS.range === "custom") {
			customInputs.hidden = false;
			fromInput.value = FILTERS.from || "";
			toInput.value   = FILTERS.to   || "";
		}
		const onCustomChange = () => {
			if (fromInput.value && toInput.value) {
				setUrlAndReload({ range: "custom", from: fromInput.value, to: toInput.value });
			}
		};
		fromInput.addEventListener("change", onCustomChange);
		toInput.addEventListener("change", onCustomChange);

		// Dimensional filters — selects that update URL on change.
		const wireSelect = (id, paramName) => {
			const el = document.getElementById(id);
			el.value = FILTERS[paramName === "conn_type" ? "conn_type" : paramName];
			el.addEventListener("change", () => {
				setUrlAndReload({ [paramName]: el.value || null });
			});
		};
		wireSelect("filter-device",     "device");
		wireSelect("filter-browser",    "browser");
		wireSelect("filter-standalone", "standalone");
		wireSelect("filter-conn",       "conn_type");

		// Reset → strip every filter param from the URL.
		document.getElementById("filter-reset").addEventListener("click", (ev) => {
			ev.preventDefault();
			const u = new URL(window.location.href);
			for (const k of ["range","from","to","device","browser","standalone","conn_type"]) {
				u.searchParams.delete(k);
			}
			window.location.href = u.toString();
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
			loadLatencyPercentiles(),
			loadSoftWait(),
			loadConnectionBreakdown(),
		]);
		// Charts render asynchronously and grow the page height as they
		// land, which throws off the browser's initial scroll-to-fragment.
		// Re-resolve the URL fragment after everything has rendered AND
		// once more 600ms later to catch any late layout work (Chart.js
		// completes a 700ms animation on each chart that doesn't change
		// canvas size, but it nudges other browser layout work around).
		const hash = window.location.hash;
		if (hash && hash.length > 1) {
			const targetId = hash.slice(1);
			const reanchor = () => {
				const el = document.getElementById(targetId);
				if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
			};
			requestAnimationFrame(() => requestAnimationFrame(reanchor));
			setTimeout(reanchor, 600);
		}
	}

	initFilterBar();
	initSeverityPills();
	initDropoffModePills();
	initSlowModePills();
	loadAll();
})();
