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
		]);
	}

	loadAll();
})();
