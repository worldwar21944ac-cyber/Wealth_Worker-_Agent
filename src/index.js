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
    tgaPoints: 10,
    latestTgaClosing: 929325,
    latestTgaOpening: 924219,
    latestTgaChange: 5106,
    tgaHigh: 997946,
    tgaLow: 835417,
    tgaAverage: 897544.1,
    periodStart: "2022-04-18",
    periodEnd: "2026-08-05",
  },
  topDepartments: [
    { dept: "091", loans: 73175476331734.48, interestRevenue: 1091342191894.14, interestReceivable: 915711086401.0 },
    { dept: "073", loans: 18411991045091.0, interestRevenue: 163870658599.14, interestReceivable: 139176457507.97 },
    { dept: "020", loans: 9452044789011.36, interestRevenue: 166946606275.8, interestReceivable: 108495746138.63 },
    { dept: "086", loans: 6674018193282.11, interestRevenue: 119203147237.62, interestReceivable: 100791473186.42 },
    { dept: "012", loans: 5685539062167.09, interestRevenue: 94918919624.85, interestReceivable: 68929330046.62 },
  ],
  tgaSeriesRecent: [
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

const STYLE = `body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#08111f;color:#e8eefc}a{color:inherit;text-decoration:none}.wrap{max-width:1180px;margin:0 auto;padding:24px}.hero,.panel,.card{background:rgba(16,27,47,.92);border:1px solid rgba(255,255,255,.09);border-radius:18px}.hero{padding:24px}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.nav a{display:inline-block;padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.09);color:#9eb0d1;margin:6px 8px 0 0}.nav a.active{background:rgba(125,211,252,.14);color:#fff;border-color:rgba(125,211,252,.4)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}.card{padding:16px}.label{color:#9eb0d1;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}.value{font-size:1.4rem;font-weight:700;margin-top:8px}.sub{color:#9eb0d1;margin-top:6px}.section{margin-top:16px}.two{display:grid;grid-template-columns:1.4fr .9fr;gap:12px}.panel{padding:16px}.muted{color:#9eb0d1;line-height:1.55}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.09);text-align:left}.table th{color:#9eb0d1;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}.footer{margin-top:16px;color:#9eb0d1;font-size:.92rem}code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px}`;

function fmt(v) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
}

function compact(v) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rid(request) {
  return request.headers.get("cf-ray") || crypto.randomUUID();
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

function cors(request, env) {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allow = allowed === "*" ? "*" : origin === allowed ? allowed : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function compute() {
  const topFive = DATA.topDepartments.slice(0, 5);
  const topFiveTotal = topFive.reduce((sum, item) => sum + item.loans, 0);
  const latest = DATA.tgaSeriesRecent[DATA.tgaSeriesRecent.length - 1];
  const previous = DATA.tgaSeriesRecent[DATA.tgaSeriesRecent.length - 2];
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

function nav(active) {
  return [
    ["/", "Home"],
    ["/overview", "Overview"],
    ["/treasury", "Treasury"],
    ["/departments", "Departments"],
    ["/insights", "Insights"],
  ]
    .map(([href, label]) => `<a class="${active === href ? "active" : ""}" href="${href}">${label}</a>`)
    .join("");
}

function card(label, value, sub) {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function shell(title, eyebrow, intro, active, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap"><div class="hero"><div class="row"><strong>Wealth Worker</strong><span class="label">${esc(eyebrow)}</span></div><h1>${esc(title)}</h1><p class="muted">${esc(intro)}</p><div class="nav">${nav(active)}</div></div>${body}<div class="footer">Routes: <code>/api/health</code>, <code>/api/summary</code>, <code>/api/departments</code>, <code>/api/tga</code>, <code>/routes</code></div></div></body></html>`;
}

function home(p) {
  return shell(
    "Wealth Worker — Home",
    "Finance dashboard",
    "A multi-page edge dashboard for Treasury and lending analytics.",
    "/",
    `<div class="grid">${card("Loan receivables", compact(p.loanReceivables), "Principal outstanding")}${card("Interest receivable", compact(p.interestReceivable), "Earned but not yet collected")}${card("Interest revenue", compact(p.interestRevenue), "Revenue recognized in the ledger")}${card("Net gain / loss", compact(p.netGainLoss), p.netGainLoss < 0 ? "Negative for the period" : "Positive for the period")}</div><div class="section two"><div class="panel"><div class="label">Quick read</div><p class="muted">The top five departments account for ${(p.topFiveShare * 100).toFixed(1)}% of loan receivables.</p><p class="muted">Treasury closed at ${fmt(p.latestTgaClosing)} in the latest reading.</p></div><div class="panel"><div class="label">API snapshot</div><p class="muted"><strong>${p.departmentCount}</strong> departments tracked.</p><p class="muted"><strong>${p.tgaPoints}</strong> treasury observations embedded.</p></div></div>`,
  );
}

function overview(p) {
  return shell(
    "Wealth Worker — Overview",
    "Portfolio overview",
    "Receivables, revenue, gain/loss, and concentration in one view.",
    "/overview",
    `<div class="grid">${card("Loan receivables", compact(p.loanReceivables), "Total principal outstanding")}${card("Capitalized interest", compact(p.capitalizedInterestReceivable), "Capitalized interest receivable")}${card("Interest revenue", compact(p.interestRevenue), "Recognized revenue")}${card("Net gain / loss", compact(p.netGainLoss), "Period result")}</div><div class="section two"><div class="panel"><div class="label">Concentration</div><p class="muted">Top five departments hold ${(p.topFiveShare * 100).toFixed(1)}% of loan receivables.</p><p class="muted">Top-five loan total: ${fmt(p.topFiveTotal)}</p></div><div class="panel"><div class="label">Spread</div><p class="muted">Interest revenue exceeds loss amount by ${fmt(p.interestRevenue - p.lossAmount)}</p></div></div>`,
  );
}

function treasury(p) {
  const rows = p.tgaSeriesRecent
    .map((r) => `<tr><td>${esc(r.date)}</td><td>${fmt(r.opening)}</td><td>${fmt(r.deposits)}</td><td>${fmt(r.withdrawals)}</td><td>${fmt(r.closing)}</td></tr>`)
    .join("");
  return shell(
    "Wealth Worker — Treasury",
    "Treasury cash trend",
    "Recent Treasury cash movements and closing balances.",
    "/treasury",
    `<div class="section panel"><table class="table"><thead><tr><th>Date</th><th>Opening</th><th>Deposits</th><th>Withdrawals</th><th>Closing</th></tr></thead><tbody>${rows}</tbody></table></div><div class="section grid">${card("High", fmt(p.tgaHigh), "Highest observed close")}${card("Low", fmt(p.tgaLow), "Lowest observed close")}${card("Average", fmt(p.tgaAverage), "Average closing balance")}${card("Latest move", fmt(p.latestTgaChange), "Change from prior close")}</div>`,
  );
}

function departments(p) {
  const rows = p.topDepartments
    .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.dept)}</td><td>${fmt(r.loans)}</td><td>${fmt(r.interestRevenue)}</td><td>${fmt(r.interestReceivable)}</td></tr>`)
    .join("");
  return shell(
    "Wealth Worker — Departments",
    "Department concentration",
    "The departments driving most of the ledger activity.",
    "/departments",
    `<div class="section panel"><table class="table"><thead><tr><th>Rank</th><th>Department</th><th>Loan receivables</th><th>Interest revenue</th><th>Interest receivable</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

function insights() {
  return shell(
    "Wealth Worker — Insights",
    "Analysis and notes",
    "Plain-English takeaways from the embedded data.",
    "/insights",
    `<div class="section two"><div class="panel"><p><strong>Concentration risk</strong><br><span class="muted">Department 091 dominates the portfolio, and the top five departments are the clear center of gravity.</span></p><p><strong>Treasury movement</strong><br><span class="muted">The TGA series shows regular swings, including late-period inflows and outflows.</span></p></div><div class="panel"><p><strong>Revenue profile</strong><br><span class="muted">Interest revenue is large relative to the reported loss amount, even though net gain/loss remains negative.</span></p><p><strong>App shape</strong><br><span class="muted">The worker serves multiple pages plus JSON routes for dashboard and API use.</span></p></div></div>`,
  );
}

function render(path, p) {
  if (path === "/") return home(p);
  if (path === "/overview") return overview(p);
  if (path === "/treasury") return treasury(p);
  if (path === "/departments") return departments(p);
  if (path === "/insights") return insights(p);
  return null;
}

export default {
  async fetch(request, env) {
    const requestId = rid(request);
    const c = cors(request, env);
    const url = new URL(request.url);
    const p = compute();

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: c });

    try {
      if (request.method === "GET" && ["/", "/overview", "/treasury", "/departments", "/insights"].includes(url.pathname)) {
        return new Response(render(url.pathname, p), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, service: "wealth-worker", request_id: requestId }, 200, c);
      if (request.method === "GET" && url.pathname === "/api/summary") return json({ request_id: requestId, loanReceivables: p.loanReceivables, capitalizedInterestReceivable: p.capitalizedInterestReceivable, interestReceivable: p.interestReceivable, interestRevenue: p.interestRevenue, gainAmount: p.gainAmount, lossAmount: p.lossAmount, netGainLoss: p.netGainLoss, departmentCount: p.departmentCount, tgaPoints: p.tgaPoints, tgaHigh: p.tgaHigh, tgaLow: p.tgaLow, tgaAverage: p.tgaAverage, periodStart: p.periodStart, periodEnd: p.periodEnd, topFiveTotal: p.topFiveTotal, topFiveShare: p.topFiveShare, latestTgaClosing: p.latestTgaClosing, latestTgaOpening: p.latestTgaOpening, latestTgaChange: p.latestTgaChange }, 200, c);
      if (request.method === "GET" && url.pathname === "/api/departments") return json({ request_id: requestId, departments: p.topDepartments }, 200, c);
      if (request.method === "GET" && url.pathname === "/api/tga") return json({ request_id: requestId, series: p.tgaSeriesRecent }, 200, c);
      if (request.method === "GET" && url.pathname === "/routes") return json({ request_id: requestId, routes: ROUTES }, 200, c);
      return json({ error: "Not found", code: "NOT_FOUND", request_id: requestId }, 404, c);
    } catch (error) {
      console.error(JSON.stringify({ event: "unhandled_error", request_id: requestId, message: error instanceof Error ? error.message : "Unknown error" }));
      return json({ error: "Internal server error", code: "INTERNAL_ERROR", request_id: requestId }, 500, c);
    }
  },
};
