const DATA = {
  summary: {
    loanReceivables: 119456581831769.42,
    capitalizedInterestReceivable: 211231854449.95,
    interestReceivable: 1402508950631.49,
    interestRevenue: 1733458045150.03,
    gainAmount: 687715729.04,
    lossAmount: 1841184602.08,
    netGainLoss: -1153468873.04,
    departmentCount: 24,
    tgaPoints: 1078,
    latestTgaClosing: 929325,
    latestTgaOpening: 924219,
    latestTgaChange: 5106,
    tgaHigh: 1038035,
    tgaLow: 22892,
    tgaAverage: 658800.36,
    periodStart: "2022-04-18",
    periodEnd: "2026-08-05",
  },
  topDepartments: [
    { dept: "091", loans: 73175476331734.48, interestRevenue: 1091342191894.14, interestReceivable: 915711086401.0 },
    { dept: "073", loans: 18411991045091.0, interestRevenue: 163870658599.14, interestReceivable: 139176457507.97 },
    { dept: "020", loans: 9452044789011.36, interestRevenue: 166946606275.8, interestReceivable: 108495746138.63 },
    { dept: "086", loans: 6674018193282.11, interestRevenue: 119203147237.62, interestReceivable: 100791473186.42 },
    { dept: "012", loans: 5685539062167.09, interestRevenue: 94918919624.85, interestReceivable: 68929330046.62 },
    { dept: "069", loans: 1336658980888.97, interestRevenue: 20862717491.38, interestReceivable: 17584686478.47 },
    { dept: "070", loans: 1255412383502.57, interestRevenue: 16761433498.8, interestReceivable: 6471079803.98 },
    { dept: "083", loans: 741772850585.91, interestRevenue: 11902655670.74, interestReceivable: 9861894268.94 },
  ],
  tgaSeriesRecent: [
    { date: "2026-07-03", opening: 770587, deposits: 14572, withdrawals: 8315, closing: 776843 },
    { date: "2026-07-06", opening: 776843, deposits: 28574, withdrawals: 22311, closing: 783107 },
    { date: "2026-07-07", opening: 783107, deposits: 262298, withdrawals: 260441, closing: 784964 },
    { date: "2026-07-08", opening: 784964, deposits: 18298, withdrawals: 54019, closing: 749244 },
    { date: "2026-07-09", opening: 749244, deposits: 335959, withdrawals: 340566, closing: 744637 },
    { date: "2026-07-10", opening: 744637, deposits: 14755, withdrawals: 21120, closing: 738273 },
    { date: "2026-07-13", opening: 738273, deposits: 31143, withdrawals: 19134, closing: 750282 },
    { date: "2026-07-14", opening: 750282, deposits: 300990, withdrawals: 263458, closing: 787814 },
    { date: "2026-07-15", opening: 787814, deposits: 164297, withdrawals: 156135, closing: 795976 },
    { date: "2026-07-16", opening: 795976, deposits: 298520, withdrawals: 271986, closing: 822510 },
    { date: "2026-07-17", opening: 822510, deposits: 14393, withdrawals: 21484, closing: 815418 },
    { date: "2026-07-20", opening: 815418, deposits: 32881, withdrawals: 20103, closing: 828197 },
    { date: "2026-07-21", opening: 828197, deposits: 310515, withdrawals: 263732, closing: 874980 },
    { date: "2026-07-22", opening: 874980, deposits: 18798, withdrawals: 58360, closing: 835417 },
    { date: "2026-07-23", opening: 835417, deposits: 308468, withdrawals: 266684, closing: 877201 },
    { date: "2026-07-24", opening: 877201, deposits: 27042, withdrawals: 17944, closing: 886300 },
    { date: "2026-07-27", opening: 886300, deposits: 33776, withdrawals: 17325, closing: 902751 },
    { date: "2026-07-28", opening: 902751, deposits: 309447, withdrawals: 246062, closing: 966136 },
    { date: "2026-07-29", opening: 966136, deposits: 22514, withdrawals: 18208, closing: 970442 },
    { date: "2026-07-30", opening: 970442, deposits: 293729, withdrawals: 266225, closing: 997946 },
    { date: "2026-07-31", opening: 997946, deposits: 281854, withdrawals: 403235, closing: 876566 },
    { date: "2026-08-03", opening: 876566, deposits: 59203, withdrawals: 65686, closing: 870083 },
    { date: "2026-08-04", opening: 870083, deposits: 312260, withdrawals: 258123, closing: 924219 },
    { date: "2026-08-05", opening: 924219, deposits: 21365, withdrawals: 16259, closing: 929325 },
  ],
};

const ROUTES = {
  "/": "home",
  "/overview": "portfolio overview",
  "/treasury": "treasury view",
  "/departments": "department concentration",
  "/insights": "analysis and notes",
  "/api/health": "heartbeat",
  "/api/summary": "summary JSON",
  "/api/departments": "department JSON",
  "/api/tga": "treasury JSON",
  "/routes": "route index JSON",
};

const PAGE_ORDER = ["/", "/overview", "/treasury", "/departments", "/insights"];

function formatCompactCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requestIdFrom(request) {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin");
  const configuredOrigin = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = configuredOrigin === "*" ? "*" : requestOrigin === configuredOrigin ? configuredOrigin : "null";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function computeDerived() {
  const topFive = DATA.topDepartments.slice(0, 5);
  const topFiveTotal = topFive.reduce((sum, item) => sum + item.loans, 0);
  const latest = DATA.tgaSeriesRecent.at(-1);
  const previous = DATA.tgaSeriesRecent.at(-2);

  return {
    loanReceivables: DATA.summary.loanReceivables,
    capitalizedInterestReceivable: DATA.summary.capitalizedInterestReceivable,
    interestReceivable: DATA.summary.interestReceivable,
    interestRevenue: DATA.summary.interestRevenue,
    gainAmount: DATA.summary.gainAmount,
    lossAmount: DATA.summary.lossAmount,
    netGainLoss: DATA.summary.netGainLoss,
    departmentCount: DATA.summary.departmentCount,
    tgaPoints: DATA.summary.tgaPoints,
    tgaHigh: DATA.summary.tgaHigh,
    tgaLow: DATA.summary.tgaLow,
    tgaAverage: DATA.summary.tgaAverage,
    periodStart: DATA.summary.periodStart,
    periodEnd: DATA.summary.periodEnd,
    topFiveTotal,
    topFiveShare: topFiveTotal / DATA.summary.loanReceivables,
    latestTgaClosing: latest.closing,
    latestTgaOpening: latest.opening,
    latestTgaChange: latest.closing - previous.closing,
    topDepartments: DATA.topDepartments,
    tgaSeriesRecent: DATA.tgaSeriesRecent,
  };
}

function svgLineChart(series) {
  const width = 1160;
  const height = 360;
  const padding = { top: 26, right: 24, bottom: 44, left: 80 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const values = series.map((point) => point.closing);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const xFor = (index) => padding.left + (index / Math.max(series.length - 1, 1)) * innerWidth;
  const yFor = (value) => padding.top + (1 - (value - min) / range) * innerHeight;

  const points = series.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.closing).toFixed(1)}`).join(" ");
  const area = [
    `M ${padding.left} ${height - padding.bottom}`,
    ...series.map((point, index) => `L ${xFor(index).toFixed(1)} ${yFor(point.closing).toFixed(1)}`),
    `L ${padding.left + innerWidth} ${height - padding.bottom}`,
    "Z",
  ].join(" ");

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const y = padding.top + (index / 4) * innerHeight;
    const value = max - (index / 4) * range;
    return `
      <line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.16)" stroke-dasharray="4 6"></line>
      <text x="20" y="${(y + 4).toFixed(1)}" fill="#94a3b8" font-size="12">${formatCompactCurrency(value)}</text>
    `;
  }).join("");

  const xTicks = [0, Math.floor((series.length - 1) / 2), series.length - 1].map((index) => {
    const point = series[index];
    const x = xFor(index);
    return `
      <line x1="${x.toFixed(1)}" y1="${height - padding.bottom}" x2="${x.toFixed(1)}" y2="${height - padding.bottom + 8}" stroke="rgba(148,163,184,0.45)"></line>
      <text x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="#94a3b8" font-size="11">${escapeHtml(point.date)}</text>
    `;
  }).join("");

  const last = series.at(-1);
  const prev = series.at(-2);
  const latestX = xFor(series.length - 1);
  const latestY = yFor(last.closing);
  const delta = last.closing - prev.closing;

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Treasury General Account closing balance trend">
      <defs>
        <linearGradient id="tgaArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#34d399" stop-opacity="0.35"></stop>
          <stop offset="100%" stop-color="#34d399" stop-opacity="0.03"></stop>
        </linearGradient>
        <linearGradient id="tgaLine" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#34d399"></stop>
          <stop offset="50%" stop-color="#22d3ee"></stop>
          <stop offset="100%" stop-color="#a78bfa"></stop>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" rx="20" fill="rgba(2,6,23,0.72)" stroke="rgba(148,163,184,0.18)"></rect>
      ${gridLines}
      ${xTicks}
      <path d="${area}" fill="url(#tgaArea)"></path>
      <polyline points="${points}" fill="none" stroke="url(#tgaLine)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${latestX.toFixed(1)}" cy="${latestY.toFixed(1)}" r="7" fill="#34d399" stroke="#fff" stroke-width="2"></circle>
      <text x="${latestX - 18}" y="${latestY - 18}" text-anchor="end" fill="#e2f8ee" font-size="13" font-weight="700">${formatCurrency(last.closing)}</text>
      <text x="${latestX - 18}" y="${latestY - 2}" text-anchor="end" fill="#94a3b8" font-size="11">${escapeHtml(last.date)} · ${delta >= 0 ? "+" : ""}${formatCurrency(delta)}</text>
    </svg>
  `;
}

function svgDepartmentBars(items) {
  const width = 1160;
  const rowHeight = 38;
  const height = 50 + items.length * rowHeight;
  const padding = { top: 34, right: 44, bottom: 24, left: 98 };
  const innerWidth = width - padding.left - padding.right;
  const maxLoans = Math.max(...items.map((item) => item.loans));

  const rows = items.map((item, index) => {
    const y = padding.top + index * rowHeight;
    const barWidth = (item.loans / maxLoans) * innerWidth;
    const share = (item.loans / DATA.summary.loanReceivables) * 100;
    return `
      <text x="${padding.left - 10}" y="${y + 16}" text-anchor="end" fill="#e2e8f0" font-size="13" font-weight="700">Dept ${escapeHtml(item.dept)}</text>
      <rect x="${padding.left}" y="${y - 2}" width="${innerWidth}" height="22" rx="11" fill="rgba(148,163,184,0.08)"></rect>
      <rect x="${padding.left}" y="${y - 2}" width="${barWidth.toFixed(1)}" height="22" rx="11" fill="url(#deptGradient${index})"></rect>
      <text x="${padding.left + barWidth + 10}" y="${y + 14}" fill="#94a3b8" font-size="11">${formatCompactCurrency(item.loans)} · ${share.toFixed(1)}%</text>
      <defs>
        <linearGradient id="deptGradient${index}" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#34d399"></stop>
          <stop offset="100%" stop-color="#60a5fa"></stop>
        </linearGradient>
      </defs>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Top department loan concentration">
      <rect width="100%" height="100%" rx="20" fill="rgba(2,6,23,0.72)" stroke="rgba(148,163,184,0.18)"></rect>
      <text x="24" y="20" fill="#94a3b8" font-size="11">Department concentration by loan receivables</text>
      ${rows}
    </svg>
  `;
}

function shellNav(active) {
  return PAGE_ORDER.map((path) => {
    const label = path === "/" ? "Home" : path.slice(1).replaceAll("-", " ").replace(/\w/g, (c) => c.toUpperCase());
    return `<a class="${path === active ? "active" : ""}" href="${path}">${label}</a>`;
  }).join("");
}

function metricCard(label, value, note, tone) {
  return `
    <article class="card card-${tone}">
      <div class="card-label">${escapeHtml(label)}</div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-note">${escapeHtml(note)}</div>
    </article>
  `;
}

function layout({ active, title, eyebrow, intro, content, aside = "", footer = "" }) {
  const summary = computeDerived();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #020617;
      --panel: rgba(8, 15, 31, 0.88);
      --panel-strong: rgba(2, 6, 23, 0.82);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --line: rgba(148, 163, 184, 0.18);
      --teal: #2dd4bf;
      --cyan: #22d3ee;
      --green: #34d399;
      --indigo: #818cf8;
      --violet: #c084fc;
      --gold: #fbbf24;
      --rose: #fb7185;
      --shadow: 0 18px 50px rgba(0,0,0,0.3);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 10%, rgba(45, 212, 191, 0.14), transparent 28%),
        radial-gradient(circle at 80% 0%, rgba(129, 140, 248, 0.14), transparent 32%),
        linear-gradient(180deg, #020617, #050b18 45%, #020617);
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; text-decoration: none; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 24px; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      margin-bottom: 18px;
      padding: 18px 20px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(2, 6, 23, 0.9));
      box-shadow: var(--shadow);
    }
    .brand h1 {
      margin: 0;
      font-size: clamp(28px, 3vw, 46px);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      line-height: 1;
    }
    .brand p {
      margin: 10px 0 0;
      max-width: 78ch;
      color: var(--muted);
      line-height: 1.5;
      font-size: 14px;
    }
    .eyebrow {
      color: #7dd3fc;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 11px;
      margin-bottom: 8px;
    }
    .status {
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(45, 212, 191, 0.28);
      background: rgba(13, 148, 136, 0.14);
      color: #bff8ef;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 11px;
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(8, 15, 31, 0.72);
    }
    .nav a {
      padding: 9px 14px;
      border-radius: 999px;
      border: 1px solid transparent;
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .nav a.active {
      color: #effdf7;
      background: rgba(45, 212, 191, 0.12);
      border-color: rgba(45, 212, 191, 0.28);
    }
    .hero {
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      gap: 18px;
      margin-bottom: 18px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-header {
      padding: 16px 18px 0;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .panel h2, .panel h3 { margin: 0; text-transform: uppercase; letter-spacing: 0.08em; }
    .panel h2 { font-size: 13px; color: #cbd5e1; }
    .panel h3 { font-size: 11px; color: var(--muted); }
    .content { padding: 18px; }
    .section-copy { margin: 6px 0 0; color: var(--muted); line-height: 1.55; font-size: 13px; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(2, 6, 23, 0.76));
      min-height: 134px;
    }
    .card-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #a5b4fc;
      margin-bottom: 18px;
    }
    .card-value {
      font-size: clamp(24px, 3vw, 38px);
      line-height: 1.05;
      font-weight: 800;
      margin-bottom: 10px;
    }
    .card-note { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .card-teal .card-value { color: var(--teal); }
    .card-cyan .card-value { color: var(--cyan); }
    .card-indigo .card-value { color: var(--indigo); }
    .card-green .card-value { color: var(--green); }
    .card-gold .card-value { color: var(--gold); }
    .card-violet .card-value { color: var(--violet); }
    .card-rose .card-value { color: var(--rose); }
    .main-grid { display: grid; grid-template-columns: 1.25fr 0.75fr; gap: 18px; margin-bottom: 18px; }
    .section {
      margin-bottom: 18px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(8, 15, 31, 0.82);
    }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .meta {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px 14px;
      background: rgba(2, 6, 23, 0.72);
      font-size: 13px;
      line-height: 1.45;
      color: var(--muted);
    }
    .meta strong { display: block; color: var(--text); font-size: 16px; margin-top: 4px; }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel-strong);
    }
    table { width: 100%; border-collapse: collapse; min-width: 620px; }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      text-align: left;
      font-size: 13px;
    }
    th {
      color: #cbd5e1;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 11px;
      background: rgba(15, 23, 42, 0.72);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td code { color: #c4b5fd; background: rgba(99, 102, 241, 0.08); padding: 2px 6px; border-radius: 999px; }
    .positive { color: var(--green); }
    .negative { color: var(--rose); }
    .chart-svg { width: 100%; height: auto; display: block; }
    .grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .notes {
      display: grid;
      gap: 12px;
    }
    .note-box {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px 16px;
      background: rgba(2, 6, 23, 0.68);
      color: var(--muted);
      line-height: 1.55;
      font-size: 13px;
    }
    .note-box strong { color: var(--text); }
    .foot {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      padding: 8px 2px 24px;
    }
    .quick-links { display: flex; flex-wrap: wrap; gap: 10px; }
    .quick-links a {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 9px 13px;
      color: #dbeafe;
      background: rgba(15, 23, 42, 0.72);
      font-size: 13px;
    }
    .stack { display: grid; gap: 12px; }
    .callout {
      border-left: 4px solid var(--teal);
      background: rgba(45, 212, 191, 0.08);
      border-radius: 16px;
      padding: 14px 16px;
      color: #d7fffa;
      line-height: 1.55;
    }
    .route-list {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .route-pill {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(2, 6, 23, 0.68);
      padding: 12px 14px;
      color: var(--muted);
    }
    .route-pill strong { display: block; color: var(--text); margin-bottom: 4px; }
    .api-block code {
      display: inline-block;
      margin: 4px 0 0;
      padding: 6px 8px;
      background: rgba(99, 102, 241, 0.08);
      border: 1px solid rgba(148, 163, 184, 0.12);
      border-radius: 10px;
      color: #dbeafe;
    }
    @media (max-width: 1120px) {
      .hero, .main-grid, .grid-two, .route-list, .meta-grid, .kpi-grid { grid-template-columns: 1fr; }
      .header { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="header">
      <div class="brand">
        <div class="eyebrow">Cloudflare Worker // Wealth Intelligence</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(intro)}</p>
      </div>
      <div class="status">${escapeHtml(summary.periodStart)} → ${escapeHtml(summary.periodEnd)} · edge routes active</div>
    </header>

    <nav class="nav">${shellNav(active)}</nav>

    ${content}

    ${aside}

    <footer class="foot">
      <div>Derived from <code>FBP_SummaryGeneralLedgerBorrowingBalances_20210801_20260731.csv</code> and <code>DTS_OpCashBal_20210806_20260805.csv</code>.</div>
      <div>${escapeHtml(footer || "Cloudflare Worker · request-safe output · built for edge delivery")}</div>
    </footer>
  </div>
</body>
</html>`;
}

function pageHome(payload) {
  const recent = payload.tgaSeriesRecent.slice(-6).reverse();
  const latest = payload.tgaSeriesRecent.at(-1);
  const rows = recent
    .map((item, index, array) => {
      const prev = index === 0 ? null : array[index - 1];
      const delta = prev ? item.closing - prev.closing : 0;
      return `<tr><td>${escapeHtml(item.date)}</td><td>${formatCurrency(item.opening)}</td><td>${formatCurrency(item.closing)}</td><td class="${delta >= 0 ? "positive" : "negative"}">${delta >= 0 ? "+" : ""}${formatCurrency(delta)}</td></tr>`;
    })
    .join("");

  const content = `
    <section class="hero">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Wealth summary</h2>
            <p class="section-copy">A concise view of the loan ledger and treasury balance files.</p>
          </div>
          <h3>Overview</h3>
        </div>
        <div class="content">
          <div class="kpi-grid">
            ${metricCard("Loan receivables", formatCompactCurrency(payload.loanReceivables), `${payload.departmentCount} departments in the ledger`, "teal")}
            ${metricCard("Interest receivable", formatCompactCurrency(payload.interestReceivable), `Capitalized interest: ${formatCompactCurrency(payload.capitalizedInterestReceivable)}`, "indigo")}
            ${metricCard("Interest revenue", formatCompactCurrency(payload.interestRevenue), `Gain ${formatCompactCurrency(payload.gainAmount)} · Loss ${formatCompactCurrency(payload.lossAmount)}`, "cyan")}
            ${metricCard("Net gain / loss", formatCompactCurrency(payload.netGainLoss), payload.netGainLoss >= 0 ? "Gain-dominant period" : "Loss-dominant period", payload.netGainLoss >= 0 ? "green" : "rose")}
            ${metricCard("Treasury close", formatCurrency(payload.latestTgaClosing), `${payload.periodEnd} · ${payload.latestTgaChange >= 0 ? "+" : ""}${formatCurrency(payload.latestTgaChange)} vs prior`, "gold")}
            ${metricCard("Top-five share", `${(payload.topFiveShare * 100).toFixed(1)}%`, `Top five departments total ${formatCompactCurrency(payload.topFiveTotal)}`, "violet")}
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Fast links</h2>
            <p class="section-copy">Jump into each part of the app or pull the API.</p>
          </div>
        </div>
        <div class="content stack">
          <div class="quick-links">
            <a href="/overview">Portfolio overview</a>
            <a href="/treasury">Treasury view</a>
            <a href="/departments">Department concentration</a>
            <a href="/insights">Insights</a>
            <a href="/routes">Routes JSON</a>
          </div>
          <div class="callout">
            The latest treasury close is <strong>${formatCurrency(latest.closing)}</strong> and the series currently spans <strong>${payload.tgaPoints}</strong> points.
          </div>
          <div class="route-pill">
            <strong>What this app is</strong>
            A multi-page worker that turns the uploaded ledger files into distinct dashboard pages for overview, treasury, concentration, and analysis.
          </div>
        </div>
      </div>
    </section>

    <section class="main-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Recent treasury movements</h2>
            <p class="section-copy">Opening and closing balances from the most recent dates in the uploaded cash ledger.</p>
          </div>
          <h3>Latest 6 closes</h3>
        </div>
        <div class="content">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Opening</th><th>Closing</th><th>Δ close</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>API preview</h2>
            <p class="section-copy">The same worker serves both pages and JSON.</p>
          </div>
        </div>
        <div class="content api-block">
          <div class="notes">
            <div class="note-box"><strong>/api/summary</strong><br>Returns overall wealth metrics and formatted values.</div>
            <div class="note-box"><strong>/api/departments</strong><br>Returns the top concentration list.</div>
            <div class="note-box"><strong>/api/tga</strong><br>Returns the treasury series for charting.</div>
            <div class="note-box"><strong>/routes</strong><br>Returns the route index as JSON.</div>
          </div>
        </div>
      </div>
    </section>
  `;

  return layout({
    active: "/",
    title: "Wealth Worker — Home",
    eyebrow: "Home",
    intro: "A full multi-page wealth worker with separate views for overview, treasury, department concentration, and analysis.",
    content,
  });
}

function pageOverview(payload) {
  const topFive = payload.topDepartments.slice(0, 5);
  const topFiveRows = topFive
    .map((item) => `<tr><td>Dept ${escapeHtml(item.dept)}</td><td>${formatCompactCurrency(item.loans)}</td><td>${formatCompactCurrency(item.interestRevenue)}</td><td>${formatCompactCurrency(item.interestReceivable)}</td></tr>`)
    .join("");

  const routeRows = Object.entries(ROUTES)
    .map(([route, description]) => `<tr><td><code>${escapeHtml(route)}</code></td><td>${escapeHtml(description)}</td></tr>`)
    .join("");

  const content = `
    <section class="hero">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Portfolio overview</h2>
            <p class="section-copy">The finance headline view with enough context for quick review or stakeholder sharing.</p>
          </div>
          <h3>Snapshot</h3>
        </div>
        <div class="content">
          <div class="meta-grid">
            <div class="meta">Loan receivables<strong>${formatCompactCurrency(payload.loanReceivables)}</strong></div>
            <div class="meta">Interest receivable<strong>${formatCompactCurrency(payload.interestReceivable)}</strong></div>
            <div class="meta">Interest revenue<strong>${formatCompactCurrency(payload.interestRevenue)}</strong></div>
            <div class="meta">Departments<strong>${formatNumber(payload.departmentCount)}</strong></div>
          </div>
          <div class="callout">The top five departments account for <strong>${(payload.topFiveShare * 100).toFixed(1)}%</strong> of loan receivables, or <strong>${formatCompactCurrency(payload.topFiveTotal)}</strong>.</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Summary notes</h2>
            <p class="section-copy">A quick read on what the numbers say.</p>
          </div>
        </div>
        <div class="content notes">
          <div class="note-box"><strong>Liquidity</strong><br>Latest TGA close sits at ${formatCurrency(payload.latestTgaClosing)} after a ${payload.latestTgaChange >= 0 ? "gain" : "drop"} of ${formatCurrency(Math.abs(payload.latestTgaChange))} on the last interval.</div>
          <div class="note-box"><strong>Carry</strong><br>Interest revenue remains large relative to losses, but the net gain/loss calculation is negative for the period shown.</div>
          <div class="note-box"><strong>Concentration</strong><br>Department 091 dominates the profile and should remain the first place to drill into for exposure analysis.</div>
        </div>
      </div>
    </section>

    <section class="grid-two">
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Top departments</h2>
            <p class="section-copy">Revenue and receivable concentration by department.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Department</th><th>Loan receivables</th><th>Interest revenue</th><th>Interest receivable</th></tr></thead>
            <tbody>${topFiveRows}</tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Route index</h2>
            <p class="section-copy">Both the page and JSON endpoints live in the same worker.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Route</th><th>Description</th></tr></thead>
            <tbody>${routeRows}</tbody>
          </table>
        </div>
      </section>
    </section>
  `;

  return layout({
    active: "/overview",
    title: "Wealth Worker — Overview",
    eyebrow: "Portfolio overview",
    intro: "A stakeholder-friendly summary of the current wealth position, concentration profile, and route map.",
    content,
  });
}

function pageTreasury(payload) {
  const recent = payload.tgaSeriesRecent.slice(-10).reverse();
  const rows = recent
    .map((item, index, array) => {
      const prev = index === 0 ? null : array[index - 1];
      const delta = prev ? item.closing - prev.closing : 0;
      return `<tr><td>${escapeHtml(item.date)}</td><td>${formatCurrency(item.opening)}</td><td>${formatCurrency(item.deposits)}</td><td>${formatCurrency(item.withdrawals)}</td><td class="${delta >= 0 ? "positive" : "negative"}">${delta >= 0 ? "+" : ""}${formatCurrency(delta)}</td></tr>`;
    })
    .join("");

  const content = `
    <section class="hero">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Treasury trend</h2>
            <p class="section-copy">The Treasury General Account series converted into an interactive chart-friendly view.</p>
          </div>
          <h3>Cash balance</h3>
        </div>
        <div class="content">${svgLineChart(payload.tgaSeriesRecent)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Treasury telemetry</h2>
            <p class="section-copy">Useful rollups for quick finance monitoring.</p>
          </div>
        </div>
        <div class="content stack">
          <div class="meta-grid" style="grid-template-columns:1fr 1fr;">
            <div class="meta">Latest close<strong>${formatCurrency(payload.latestTgaClosing)}</strong></div>
            <div class="meta">Latest open<strong>${formatCurrency(payload.latestTgaOpening)}</strong></div>
            <div class="meta">Average close<strong>${formatCurrency(payload.tgaAverage)}</strong></div>
            <div class="meta">High / low<strong>${formatCurrency(payload.tgaHigh)} / ${formatCurrency(payload.tgaLow)}</strong></div>
          </div>
          <div class="callout">The latest interval changed by <strong>${payload.latestTgaChange >= 0 ? "+" : ""}${formatCurrency(payload.latestTgaChange)}</strong>. The chart spans <strong>${payload.tgaPoints}</strong> observations.</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Recent cash movements</h2>
          <p class="section-copy">A compact ledger table for the latest dates.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Opening</th><th>Deposits</th><th>Withdrawals</th><th>Δ close</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;

  return layout({
    active: "/treasury",
    title: "Wealth Worker — Treasury",
    eyebrow: "Treasury view",
    intro: "A dedicated treasury page for tracking the TGA series, recent balance changes, and liquidity dynamics.",
    content,
  });
}

function pageDepartments(payload) {
  const tableRows = payload.topDepartments
    .map(
      (item, index) => `<tr><td>${index + 1}</td><td>Dept ${escapeHtml(item.dept)}</td><td>${formatCompactCurrency(item.loans)}</td><td>${formatCompactCurrency(item.interestRevenue)}</td><td>${formatCompactCurrency(item.interestReceivable)}</td></tr>`,
    )
    .join("");

  const content = `
    <section class="hero">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Department concentration</h2>
            <p class="section-copy">A bar chart focused on the heaviest loan exposures.</p>
          </div>
          <h3>Top 8</h3>
        </div>
        <div class="content">${svgDepartmentBars(payload.topDepartments)}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2>Concentration notes</h2>
            <p class="section-copy">The first stop for risk review and follow-up analysis.</p>
          </div>
        </div>
        <div class="content notes">
          <div class="note-box"><strong>Dominant department</strong><br>Department 091 materially leads the total loan receivables profile.</div>
          <div class="note-box"><strong>Follow-on candidate</strong><br>Department 073 is the next largest block and should be reviewed alongside 091 for concentration exposure.</div>
          <div class="note-box"><strong>Portfolio shape</strong><br>The top five departments represent nearly the entire loan concentration map in the supplied dataset.</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Department table</h2>
          <p class="section-copy">Ranked by loan receivables with revenue and receivable context.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Rank</th><th>Department</th><th>Loan receivables</th><th>Interest revenue</th><th>Interest receivable</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>
  `;

  return layout({
    active: "/departments",
    title: "Wealth Worker — Departments",
    eyebrow: "Department concentration",
    intro: "A focused page for exposure analysis, ranking the departments that dominate the ledger and showing their associated revenue and receivable profiles.",
    content,
  });
}

function pageInsights(payload) {
  const content = `
    <section class="grid-two">
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Key insights</h2>
            <p class="section-copy">A plain-English readout of the ledger and treasury signals.</p>
          </div>
        </div>
        <div class="notes">
          <div class="note-box"><strong>1. Portfolio concentration is extreme.</strong><br>The top five departments hold ${ (payload.topFiveShare * 100).toFixed(1) }% of the total loan receivables pool.</div>
          <div class="note-box"><strong>2. Treasury is active, not static.</strong><br>The TGA series shows regular swings with occasional large deposit/withdrawal events.</div>
          <div class="note-box"><strong>3. Interest revenue is large.</strong><br>Interest revenue materially exceeds loss amounts across the period shown, although the net gain/loss calculation is still negative.</div>
          <div class="note-box"><strong>4. Department 091 dominates.</strong><br>If this app were extended, department 091 would be the first candidate for drill-down detail or sub-view pages.</div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Build notes</h2>
            <p class="section-copy">What makes this a full multi-page app.</p>
          </div>
        </div>
        <div class="notes">
          <div class="note-box"><strong>Separate pages</strong><br>Home, overview, treasury, departments, and insights are each distinct routes.</div>
          <div class="note-box"><strong>Shared layout</strong><br>All pages use one reusable shell, keeping branding and navigation consistent.</div>
          <div class="note-box"><strong>API parity</strong><br>The same worker also provides JSON endpoints for programmatic integration.</div>
          <div class="note-box"><strong>Edge-friendly</strong><br>No database or build pipeline is required because the uploaded data is embedded at the edge.</div>
        </div>
      </section>
    </section>
  `;

  return layout({
    active: "/insights",
    title: "Wealth Worker — Insights",
    eyebrow: "Analysis and notes",
    intro: "A narrative page that explains the meaning of the figures and documents the app structure.",
    content,
  });
}

function renderPage(path, payload) {
  if (path === "/") return pageHome(payload);
  if (path === "/overview") return pageOverview(payload);
  if (path === "/treasury") return pageTreasury(payload);
  if (path === "/departments") return pageDepartments(payload);
  if (path === "/insights") return pageInsights(payload);
  return null;
}

export default {
  async fetch(request, env) {
    const requestId = requestIdFrom(request);
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);
    const payload = computeDerived();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (request.method === "GET" && ["/", "/overview", "/treasury", "/departments", "/insights"].includes(url.pathname)) {
        return new Response(renderPage(url.pathname, payload), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, service: "wealth-worker", request_id: requestId }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/api/summary") {
        return json(
          {
            request_id: requestId,
            ...payload,
            loanReceivablesFormatted: formatCurrency(payload.loanReceivables),
            interestReceivableFormatted: formatCurrency(payload.interestReceivable),
            interestRevenueFormatted: formatCurrency(payload.interestRevenue),
            tgaLatestFormatted: formatCurrency(payload.latestTgaClosing),
          },
          200,
          cors,
        );
      }

      if (request.method === "GET" && url.pathname === "/api/departments") {
        return json({ request_id: requestId, departments: payload.topDepartments }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/api/tga") {
        return json({ request_id: requestId, series: payload.tgaSeriesRecent }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/routes") {
        return json({ request_id: requestId, routes: ROUTES }, 200, cors);
      }

      return json({ error: "Not found", code: "NOT_FOUND", request_id: requestId }, 404, cors);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "unhandled_error",
          request_id: requestId,
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      return json({ error: "Internal server error", code: "INTERNAL_ERROR", request_id: requestId }, 500, cors);
    }
  },
};
