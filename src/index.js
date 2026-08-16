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
  "/vault": "hardware vault landing",
  "/?vault=hardware": "hardware vault viewer",
  "/api/health": "heartbeat",
  "/api/summary": "summary JSON",
  "/api/departments": "department JSON",
  "/api/tga": "treasury JSON",
  "/api/v1/artifacts": "asset catalog JSON",
  "/routes": "route index JSON",
  "/favicon.svg": "brand favicon",
};

const VAULT_TOKEN = "vo1-enterprise-access";
const HARDWARE_ASSETS = [
  {
    slug: "vo-l2-solar-optical",
    title: "Vo L2 Solar Optical",
    filename: "Vo L2 Solar Optical.html",
    summary: "Level 2 solar optical twin and photovoltaic harvest simulation across five latitude bands.",
    details: ["800–1,200 Wh/day target", "Five-band latitude analysis", "Revenue planning and deployment baseline"],
  },
  {
    slug: "vo-l1-fea-execution",
    title: "Vo L1 FEA Execution",
    filename: "Vo L1 FEA Execution.html",
    summary: "Finite element analysis module for the primary structural load cases.",
    details: ["40 kn sustained wind", "60 kn gust threshold", "1.5 safety factor on yield"],
  },
  {
    slug: "vo-modular-bom-v0",
    title: "Vo Modular BOM V0",
    filename: "Vo Modular BOM V0.html",
    summary: "Exploded bill of materials with part-level identifiers and mass budgets.",
    details: ["VO-1-PART-#### tracking", "M01 through M13 mass budgeting", "Assembly and sourcing map"],
  },
  {
    slug: "vo-deep-dive-memo",
    title: "Vo Deep Dive Memo",
    filename: "Vo Deep Dive Memo.html",
    summary: "Commercialization memo covering private-sector capitalization and dual-use infrastructure.",
    details: ["Micro-Grid as a Service", "Private-sector deployment", "Capitalization and monetization model"],
  },
  {
    slug: "vo-srd-v1-lock",
    title: "Vo Srd V1 Lock",
    filename: "Vo Srd V1 Lock.html",
    summary: "Locked requirements baseline with environmental envelope and deployment protocol.",
    details: ["-20°C to +45°C envelope", "15–30 minute deployment", "Simulate before cut protocol"],
  },
];
const ASSET_CATALOG = { HARDWARE_SPEC: HARDWARE_ASSETS };

const CANONICAL_HOST = "knockoutforever.com";
const WWW_HOST = "www.knockoutforever.com";
const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Wealth Worker logo"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="#22d3ee"/><stop offset="55%" stop-color="#34d399"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient><linearGradient id="ring" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stop-color="#ecfeff"/><stop offset="100%" stop-color="#f5f3ff"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="#08111f"/><circle cx="32" cy="32" r="24" fill="url(#bg)"/><circle cx="32" cy="32" r="19" fill="none" stroke="url(#ring)" stroke-width="4" opacity=".9"/><path d="M20 20h7.2l4.8 16 4-11h4l4 11 4.8-16H52l-8.2 24h-4.6l-3.7-10.2-3.7 10.2h-4.6z" fill="#08111f" opacity=".96"/><path d="M20 18.8h7.2l4.8 16 4-11h4l4 11 4.8-16H52l-8.2 24h-4.6l-3.7-10.2-3.7 10.2h-4.6z" fill="#ffffff" opacity=".18"/></svg>`;

const STYLE = `body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#08111f;color:#e8eefc}a{color:inherit;text-decoration:none}.wrap{max-width:1180px;margin:0 auto;padding:24px}.hero,.panel,.card{background:rgba(16,27,47,.92);border:1px solid rgba(255,255,255,.09);border-radius:18px}.hero{padding:24px}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.brandmark{width:28px;height:28px;border-radius:9px;display:inline-grid;place-items:center;background:linear-gradient(135deg,#22d3ee,#34d399,#a78bfa);color:#08111f;font-weight:900;box-shadow:0 0 0 1px rgba(255,255,255,.18) inset}.nav a{display:inline-block;padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.09);color:#9eb0d1;margin:6px 8px 0 0}.nav a.active{background:rgba(125,211,252,.14);color:#fff;border-color:rgba(125,211,252,.4)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}.card{padding:16px}.label{color:#9eb0d1;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}.value{font-size:1.4rem;font-weight:700;margin-top:8px}.sub{color:#9eb0d1;margin-top:6px}.section{margin-top:16px}.two{display:grid;grid-template-columns:1.4fr .9fr;gap:12px}.panel{padding:16px}.muted{color:#9eb0d1;line-height:1.55}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.09);text-align:left}.table th{color:#9eb0d1;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}.footer{margin-top:16px;color:#9eb0d1;font-size:.92rem}code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px}.vault-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.vault-form{display:grid;gap:10px;margin-top:12px}.vault-input,.vault-button{padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.09);font:inherit}.vault-input{background:rgba(255,255,255,.05);color:#fff}.vault-button{background:rgba(125,211,252,.14);color:#fff;border-color:rgba(125,211,252,.4);font-weight:700;cursor:pointer}.vault-button:hover{background:rgba(125,211,252,.22)}.chip-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.chip{padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.08);font-size:.8rem;color:#cfe2ff}.vault-note{margin-top:12px}.vault-banner{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:12px}`;

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

function vaultToken(request, url) {
  return url.searchParams.get("token") || request.headers.get("x-vault-token") || "";
}

function hasVaultAccess(request, url) {
  return vaultToken(request, url) === VAULT_TOKEN;
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
    ["/?vault=hardware", "Vault"],
  ]
    .map(([href, label]) => `<a class="${active === href ? "active" : ""}" href="${href}">${label}</a>`)
    .join("");
}

function card(label, value, sub) {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function assetCard(asset, unlocked = false) {
  const chips = asset.details.map((detail) => `<span class="chip">${esc(detail)}</span>`).join("");
  return `<article class="panel"><div class="label">${asset.filename}</div><h3>${esc(asset.title)}</h3><p class="muted">${esc(asset.summary)}</p><div class="chip-row">${chips}</div><p class="vault-note muted">${unlocked ? `Unlocked for token holders.` : `Locked behind token access.`}</p></article>`;
}

function catalogResponse(category, unlocked) {
  const assets = ASSET_CATALOG[category] || [];
  return {
    category,
    unlocked,
    count: assets.length,
    assets: assets.map((asset) =>
      unlocked
        ? { ...asset, accessTier: "ENTERPRISE" }
        : { slug: asset.slug, title: asset.title, filename: asset.filename, summary: asset.summary, locked: true },
    ),
  };
}

function vaultLanding() {
  const previews = HARDWARE_ASSETS.map((asset) => assetCard(asset, false)).join("");
  return shell(
    "Wealth Worker  Hardware Vault",
    "Secure assets",
    "Enter the access token to open the first enterprise asset pack.",
    "/?vault=hardware",
    `<div class="section two"><div class="panel"><div class="label">Access gate</div><h3>Hardware Specifications & Engineering Baseline</h3><p class="muted">Use the token query parameter or the x-vault-token header to unlock the viewer.</p><form class="vault-form" method="GET" action="/?vault=hardware"><input class="vault-input" name="token" placeholder="Enter access token" autocomplete="off" spellcheck="false"><button class="vault-button" type="submit">Open vault</button></form><div class="vault-banner"><span class="chip">/routes?catalog=hardware</span><span class="chip">x-vault-token</span></div></div><div class="panel"><div class="label">First launch pack</div><p class="muted">Vo L2 Solar Optical, Vo L1 FEA Execution, Vo Modular BOM V0, Vo Deep Dive Memo, and Vo Srd V1 Lock.</p></div></div><div class="section vault-grid">${previews}</div>`,
  );
}

function vaultViewer() {
  const unlocked = HARDWARE_ASSETS.map((asset) => assetCard(asset, true)).join("");
  return shell(
    "Wealth Worker  Hardware Vault",
    "Enterprise access",
    "Token verified. The first asset pack is live.",
    "/?vault=hardware",
    `<div class="section two"><div class="panel"><div class="label">Unlocked category</div><h3>Hardware Specifications & Engineering Baseline</h3><p class="muted">You can now browse the full viewer, use the catalog API, and build a checkout flow on top of it.</p><div class="vault-banner"><span class="chip">/routes?catalog=hardware</span><span class="chip">/?vault=hardware</span></div></div><div class="panel"><div class="label">Access summary</div><p class="muted">${HARDWARE_ASSETS.length} assets unlocked behind the enterprise token.</p></div></div><div class="section vault-grid">${unlocked}</div>`,
  );
}

function shell(title, eyebrow, intro, active, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08111f"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/favicon.svg"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap"><div class="hero"><div class="row"><span class="brandmark" aria-hidden="true">W</span><strong>Wealth Worker</strong><span class="label">${esc(eyebrow)}</span></div><h1>${esc(title)}</h1><p class="muted">${esc(intro)}</p><div class="nav">${nav(active)}</div></div>${body}<div class="footer">Routes: <code>/api/health</code>, <code>/api/summary</code>, <code>/api/departments</code>, <code>/api/tga</code>, <code>/routes</code>, <code>/?vault=hardware</code>, <code>/routes?catalog=hardware</code></div></div></body></html>`;
}

function home(p) {
  return shell(
    "Wealth Worker  Home",
    "Finance dashboard",
    "A multi-page edge dashboard for Treasury and lending analytics.",
    "/",
    `<div class="grid">${card("Loan receivables", compact(p.loanReceivables), "Principal outstanding")}${card("Interest receivable", compact(p.interestReceivable), "Earned but not yet collected")}${card("Interest revenue", compact(p.interestRevenue), "Revenue recognized in the ledger")}${card("Net gain / loss", compact(p.netGainLoss), p.netGainLoss < 0 ? "Negative for the period" : "Positive for the period")}</div><div class="section two"><div class="panel"><div class="label">Quick read</div><p class="muted">The top five departments account for ${(p.topFiveShare * 100).toFixed(1)}% of loan receivables.</p><p class="muted">Treasury closed at ${fmt(p.latestTgaClosing)} in the latest reading.</p></div><div class="panel"><div class="label">API snapshot</div><p class="muted"><strong>${p.departmentCount}</strong> departments tracked.</p><p class="muted"><strong>${p.tgaPoints}</strong> treasury observations embedded.</p></div></div>`,
  );
}

function overview(p) {
  return shell(
    "Wealth Worker  Overview",
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
    "Wealth Worker  Treasury",
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
    "Wealth Worker  Departments",
    "Department concentration",
    "The departments driving most of the ledger activity.",
    "/departments",
    `<div class="section panel"><table class="table"><thead><tr><th>Rank</th><th>Department</th><th>Loan receivables</th><th>Interest revenue</th><th>Interest receivable</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

function insights() {
  return shell(
    "Wealth Worker  Insights",
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
  if (path === "/insights") return insights();
  return null;
}

function vaultAuthorized(request, env, url) {
  const expected = env.VAULT_TOKEN;
  const supplied = request.headers.get("x-vault-token") || url.searchParams.get("token");
  return Boolean(expected && supplied && supplied === expected);
}

export default {
  async fetch(request, env) {
    const requestId = rid(request);
    const c = cors(request, env);
    const url = new URL(request.url);
    const p = compute();

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: c });

    try {
      if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("vault") === "hardware") {
        if (!vaultAuthorized(request, env, url)) {
          return new Response(
            shell(
              "Hardware Vault  Access Required",
              "Enterprise vault",
              "This technical asset library requires an access credential. The credential should be provisioned as the Cloudflare Worker secret VAULT_TOKEN.",
              "/?vault=hardware",
              `<div class="section panel vault"><h2>Access required</h2><p class="muted">Enter your authorized vault credential through the approved access flow. Do not publish the token in client-side code.</p><p class="muted">Catalog endpoint: <code>/routes?catalog=hardware</code></p></div>`,
            ),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "www-authenticate": "Bearer" } },
          );
        }
        return new Response(hardwareVault(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
        });
      }
      if (request.method === "GET" && url.pathname === "/routes" && url.searchParams.get("catalog") === "hardware") {
        if (!vaultAuthorized(request, env, url)) return json({ error: "Vault access required", code: "VAULT_UNAUTHORIZED", request_id: requestId }, 401, { ...c, "www-authenticate": "Bearer" });
        return json({ request_id: requestId, catalog: "hardware", artifacts: HARDWARE_CATALOG }, 200, c);
      }
      if (request.method === "GET" && ["/", "/overview", "/treasury", "/departments", "/insights"].includes(url.pathname)) return new Response(render(url.pathname, p), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, service: "wealth-worker", request_id: requestId }, 200, c);
      if (request.method === "GET" && url.pathname === "/api/summary") return json({ request_id: requestId, ...p, topDepartments: undefined, tgaSeriesRecent: undefined }, 200, c);
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
