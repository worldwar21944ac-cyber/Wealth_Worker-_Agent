/**
 * kyc-gateway v8.1 — Sub-2-Second KYC/KYB Intake Screening
 * ============================================================
 * Cloudflare Worker | Bervashun Trust Capital
 *
 * Engines (17, Promise.all parallel fan-out):
 *   E1  OFAC SDN          — 40 pts/hit, cap 70
 *   E2  PEP               — 25 pts/hit, cap 50
 *   E3  FATF High-Risk    — 20 pts, 55 countries
 *   E4  TIN/EIN Validity  — 20 pts
 *   E5  Velocity          — 15 pts if >5 submissions/TIN/24 h
 *   E6  Structuring       — 35 pts if $8,000–$9,999 amount
 *   E7  Adverse Media     — 5 pts/keyword, cap 30
 *   E8  UBO Cascade       — 25 pts, ≥25% ownership; OFAC+PEP parallel
 *   E9  DOB Plausibility  — 35 pts future/under-18/over-120
 *   E10 Address Risk      — 10 pts high-risk ZIP/country mismatch
 *   E11 Entity Consistency — 15 pts name/TIN mismatch signals
 *   E12 Corporate Depth   — 20 pts >4 ownership layers
 *   E13 Document Entropy  — 10 pts low-entropy / expired docs
 *   E14 Network Graph     — 20 pts shared TIN or address
 *   E15 Synthetic Identity — 40 pts SSN area 900+
 *   E16 Watchlist Delta   — 30 pts newly-added SDN (delta list)
 *   E17 FinCEN 314(a)     — 25 pts Jaro-Winkler ≥ 0.82 OR tokenSetSim ≥ 0.80
 *
 * Decision bands:
 *   0–29   → APPROVED  (account_generation.allowed = true)
 *   30–69  → REVIEW    (queued for human; account_generation.allowed = false)
 *   70–100 → DENIED    (fires SYSTEM_ALERT; account_generation.allowed = false)
 *
 * Hard timeout fence: 1800 ms → auto-REVIEW if engines not done
 */

const VERSION = "8.1";
const HARD_TIMEOUT_MS = 1800;

// ---------------------------------------------------------------------------
// Name normalisation helper (E1, E2, E8, E16, E17)
// ---------------------------------------------------------------------------
function normalName(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(
      /\b(Jr\.?|Sr\.?|II|III|IV|LLC|Inc\.?|Corp\.?|Ltd\.?)\b/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// String-similarity helpers
// ---------------------------------------------------------------------------
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0;
  let transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, len2);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSim(a, b) {
  if (!a || !b) return 0;
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

function bestNameScore(candidate, listEntries) {
  let best = 0;
  for (const entry of listEntries) {
    const jw = jaroWinkler(candidate, entry);
    const ts = tokenSetSim(candidate, entry);
    const score = Math.max(jw, ts);
    if (score > best) best = score;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Static lists (representative — real impl pulls from KV / D1)
// ---------------------------------------------------------------------------
const FATF_HIGH_RISK = new Set([
  "AF","AL","BB","BF","BJ","BT","CD","CF","CG","CI","CM","CV","DJ","DZ",
  "EC","EG","ET","GH","GN","GT","GY","HT","ID","IQ","IR","JM","JO","KE",
  "KH","KP","KW","LA","LB","LK","LR","LY","MA","ML","MM","MN","MR","MU",
  "MW","MZ","NE","NG","NI","PA","PH","PK","SA","SC","SN","SO","SS","SY",
  "TG","TH","TJ","TM","TN","TR","TZ","UA","UG","VN","VU","YE","ZM","ZW",
]);

const ADVERSE_KEYWORDS = [
  "fraud","money laundering","terrorism","sanction","bribery","corruption",
  "cartel","trafficking","embezzlement","ponzi","wire fraud","tax evasion",
];

const HIGH_RISK_ZIPS = new Set(["00000","11111","99999","12345"]);

const SDN_SAMPLE = [
  "al-qaeda network","islamic state","hamas military wing","hezbollah",
  "medellin cartel","sinaloa cartel","cosa nostra","al-shabaab",
  "iran revolutionary guard","wagner group",
];

const PEP_SAMPLE = [
  "vladimir putin","kim jong un","bashar al-assad","alexander lukashenko",
  "nicolás maduro","robert mugabe","muammar gaddafi","saddam hussein",
];

const DELTA_SDN_SAMPLE = [
  "new sanctioned entity alpha","newly listed corp beta",
  "recently added individual gamma","fresh sdn addition delta",
];

const FINCEN_314A_SAMPLE = [
  "john doe suspect","jane suspect smith","richard roe laundering",
  "fincen listed alpha","fincen subject beta","target person gamma",
  "illicit actor delta","314a listed entity epsilon",
];

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Request-Id",
    "Access-Control-Expose-Headers": "X-Submission-Id",
    "Access-Control-Max-Age": "86400",
  };
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------
async function kvGet(kv, key) {
  try { return await kv.get(key); } catch { return null; }
}
async function kvPut(kv, key, value, opts) {
  try { await kv.put(key, value, opts); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Engine runner
// ---------------------------------------------------------------------------
async function runEngines(payload, env) {
  const {
    applicant_name: rawApplicantName = "",
    tin = "",
    country = "",
    amount = 0,
    dob = "",
    address = {},
    entity_type = "individual",
    ubo_owners = [],
    document_ids = [],
    ownership_layers = 0,
    network_tins = [],
    network_addresses = [],
    ssn_area = 0,
    adverse_keywords = [],
    existing_submission_ids = [],
  } = payload;

  // Normalise applicant name once — used by E1, E2, E16, E17
  const applicant_name = normalName(rawApplicantName);

  const nowMs = Date.now();
  const breakdown = {};

  // ------------------------------------------------------------------
  // E1 — OFAC SDN
  // ------------------------------------------------------------------
  async function e1_ofac() {
    let pts = 0;
    let hit = false;
    const score = bestNameScore(applicant_name, SDN_SAMPLE);
    if (score >= 0.82) {
      pts = Math.min(40, 70);
      hit = true;
    }
    breakdown.E1_OFAC = { pts, hit, score: +score.toFixed(4) };
    return pts;
  }

  // ------------------------------------------------------------------
  // E2 — PEP
  // ------------------------------------------------------------------
  async function e2_pep() {
    let pts = 0;
    let hit = false;
    const score = bestNameScore(applicant_name, PEP_SAMPLE);
    if (score >= 0.80) {
      pts = Math.min(25, 50);
      hit = true;
    }
    breakdown.E2_PEP = { pts, hit, score: +score.toFixed(4) };
    return pts;
  }

  // ------------------------------------------------------------------
  // E3 — FATF High-Risk
  // ------------------------------------------------------------------
  async function e3_fatf() {
    const hit = FATF_HIGH_RISK.has((country || "").toUpperCase());
    const pts = hit ? 20 : 0;
    breakdown.E3_FATF = { pts, hit, country };
    return pts;
  }

  // ------------------------------------------------------------------
  // E4 — TIN/EIN Validity
  // ------------------------------------------------------------------
  async function e4_tin() {
    let pts = 0;
    let valid = true;
    const clean = (tin || "").replace(/\D/g, "");
    if (entity_type === "individual") {
      // SSN: 9 digits, first 3 not 000/666/900-999
      const area = parseInt(clean.slice(0, 3), 10);
      if (clean.length !== 9 || area === 0 || area === 666 || area >= 900) {
        valid = false; pts = 20;
      }
    } else {
      // EIN: 9 digits, first 2 digits 01-99
      const prefix = parseInt(clean.slice(0, 2), 10);
      if (clean.length !== 9 || prefix < 1) {
        valid = false; pts = 20;
      }
    }
    breakdown.E4_TIN = { pts, valid };
    return pts;
  }

  // ------------------------------------------------------------------
  // E5 — Velocity
  // ------------------------------------------------------------------
  async function e5_velocity() {
    let pts = 0;
    let count = 0;
    if (env.AUDIT_DB && tin) {
      try {
        const since = new Date(nowMs - 86_400_000).toISOString();
        const row = await env.AUDIT_DB
          .prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin=? AND created_at>=?")
          .bind(tin, since)
          .first();
        count = row?.cnt ?? 0;
        if (count > 5) pts = 15;
      } catch { /* non-fatal */ }
    }
    breakdown.E5_Velocity = { pts, count_24h: count };
    return pts;
  }

  // ------------------------------------------------------------------
  // E6 — Structuring
  // ------------------------------------------------------------------
  async function e6_structuring() {
    const num = parseFloat(amount) || 0;
    const hit = num >= 8000 && num <= 9999;
    const pts = hit ? 35 : 0;
    breakdown.E6_Structuring = { pts, hit, amount: num };
    return pts;
  }

  // ------------------------------------------------------------------
  // E7 — Adverse Media
  // ------------------------------------------------------------------
  async function e7_adverse() {
    const combined = [
      ...(adverse_keywords || []),
      applicant_name,
    ].join(" ").toLowerCase();
    let hits = 0;
    const matched = [];
    for (const kw of ADVERSE_KEYWORDS) {
      if (combined.includes(kw)) { hits++; matched.push(kw); }
    }
    const pts = Math.min(hits * 5, 30);
    breakdown.E7_AdverseMedia = { pts, hits, matched };
    return pts;
  }

  // ------------------------------------------------------------------
  // E8 — UBO Cascade (OFAC + PEP in parallel per owner)
  // ------------------------------------------------------------------
  async function e8_ubo() {
    let pts = 0;
    const flagged = [];
    const significant = (ubo_owners || []).filter((o) => (o.ownership_pct || 0) >= 25);
    await Promise.all(
      significant.map(async (owner) => {
        // Normalise owner name before similarity checks
        const ownerName = normalName(owner.name || "");
        const [ofacScore, pepScore] = await Promise.all([
          Promise.resolve(bestNameScore(ownerName, SDN_SAMPLE)),
          Promise.resolve(bestNameScore(ownerName, PEP_SAMPLE)),
        ]);
        if (ofacScore >= 0.82 || pepScore >= 0.80) {
          pts = Math.min(pts + 25, 75);
          flagged.push({
            name: ownerName,
            ownership_pct: owner.ownership_pct,
            ofac_score: +ofacScore.toFixed(4),
            pep_score: +pepScore.toFixed(4),
          });
        }
      })
    );
    breakdown.E8_UBO = { pts, flagged_owners: flagged };
    return pts;
  }

  // ------------------------------------------------------------------
  // E9 — DOB Plausibility
  // ------------------------------------------------------------------
  async function e9_dob() {
    let pts = 0;
    let reason = "ok";
    if (!dob) { breakdown.E9_DOB = { pts, reason: "missing" }; return 0; }
    const birth = new Date(dob);
    if (isNaN(birth.getTime())) { pts = 35; reason = "unparseable"; }
    else {
      const now = new Date();
      if (birth > now) { pts = 35; reason = "future_date"; }
      else {
        const ageYears = (now - birth) / (365.25 * 24 * 3600 * 1000);
        if (ageYears < 18) { pts = 35; reason = "under_18"; }
        else if (ageYears > 120) { pts = 35; reason = "over_120"; }
      }
    }
    breakdown.E9_DOB = { pts, reason };
    return pts;
  }

  // ------------------------------------------------------------------
  // E10 — Address Risk
  // ------------------------------------------------------------------
  async function e10_address() {
    let pts = 0;
    const reasons = [];
    const zip = (address?.zip || "").replace(/\D/g, "");
    const addrCountry = (address?.country || "").toUpperCase();
    if (HIGH_RISK_ZIPS.has(zip)) { pts += 5; reasons.push("high_risk_zip"); }
    if (addrCountry && country && addrCountry !== country.toUpperCase()) {
      pts += 5; reasons.push("country_mismatch");
    }
    pts = Math.min(pts, 10);
    breakdown.E10_AddressRisk = { pts, reasons };
    return pts;
  }

  // ------------------------------------------------------------------
  // E11 — Entity Consistency
  // ------------------------------------------------------------------
  async function e11_entity() {
    let pts = 0;
    const reasons = [];
    // Individual TIN but entity_type=business → mismatch
    if (entity_type === "business" && (tin || "").replace(/\D/g, "").length === 9) {
      const area = parseInt((tin || "").replace(/\D/g, "").slice(0, 3), 10);
      // SSN-like area numbers in a business filing is suspicious
      if (area >= 1 && area <= 899 && area !== 666) {
        pts += 5; reasons.push("ssn_as_business_tin");
      }
    }
    // Name contains business suffix but entity_type=individual
    if (entity_type === "individual" && /\b(LLC|Inc|Corp|Ltd)\b/i.test(rawApplicantName)) {
      pts += 10; reasons.push("corporate_suffix_on_individual");
    }
    pts = Math.min(pts, 15);
    breakdown.E11_EntityConsistency = { pts, reasons };
    return pts;
  }

  // ------------------------------------------------------------------
  // E12 — Corporate Depth
  // ------------------------------------------------------------------
  async function e12_depth() {
    const layers = parseInt(ownership_layers, 10) || 0;
    const hit = layers > 4;
    const pts = hit ? 20 : 0;
    breakdown.E12_CorporateDepth = { pts, layers, hit };
    return pts;
  }

  // ------------------------------------------------------------------
  // E13 — Document Entropy
  // ------------------------------------------------------------------
  async function e13_docs() {
    let pts = 0;
    const reasons = [];
    const docs = document_ids || [];
    if (docs.length === 0) { pts += 5; reasons.push("no_documents"); }
    for (const doc of docs) {
      if (doc.expired) { pts += 3; reasons.push(`expired:${doc.id}`); }
      if (doc.entropy !== undefined && doc.entropy < 3.5) {
        pts += 2; reasons.push(`low_entropy:${doc.id}`);
      }
    }
    pts = Math.min(pts, 10);
    breakdown.E13_DocumentEntropy = { pts, reasons };
    return pts;
  }

  // ------------------------------------------------------------------
  // E14 — Network Graph
  // ------------------------------------------------------------------
  async function e14_network() {
    let pts = 0;
    const reasons = [];
    if (network_tins && network_tins.includes(tin)) {
      pts += 10; reasons.push("shared_tin");
    }
    const addrKey = `${(address?.zip || "").trim()}|${(address?.street || "").trim().toLowerCase()}`;
    if (network_addresses && network_addresses.includes(addrKey)) {
      pts += 10; reasons.push("shared_address");
    }
    pts = Math.min(pts, 20);
    breakdown.E14_NetworkGraph = { pts, reasons };
    return pts;
  }

  // ------------------------------------------------------------------
  // E15 — Synthetic Identity
  // ------------------------------------------------------------------
  async function e15_synthetic() {
    const area = parseInt(ssn_area, 10) || 0;
    const hit = area >= 900;
    const pts = hit ? 40 : 0;
    breakdown.E15_SyntheticIdentity = { pts, hit, ssn_area: area };
    return pts;
  }

  // ------------------------------------------------------------------
  // E16 — Watchlist Delta
  // ------------------------------------------------------------------
  async function e16_delta() {
    let pts = 0;
    let hit = false;
    const score = bestNameScore(applicant_name, DELTA_SDN_SAMPLE);
    if (score >= 0.82) { pts = 30; hit = true; }
    breakdown.E16_WatchlistDelta = { pts, hit, score: +score.toFixed(4) };
    return pts;
  }

  // ------------------------------------------------------------------
  // E17 — FinCEN 314(a)  [NEW in v8.1]
  // ------------------------------------------------------------------
  async function e17_fincen() {
    let pts = 0;
    let fincen_hit = false;
    let fincen_score = 0;

    // Pull live list from KV if available, fall back to static sample
    let fincenList = FINCEN_314A_SAMPLE;
    if (env.KYC_SANCTIONS) {
      try {
        const raw = await env.KYC_SANCTIONS.get("fincen_314a");
        if (raw) fincenList = JSON.parse(raw);
      } catch { /* fall back to static */ }
    }

    const jwScore = (() => {
      let best = 0;
      for (const entry of fincenList) {
        const s = jaroWinkler(applicant_name, entry);
        if (s > best) best = s;
      }
      return best;
    })();

    const tsScore = (() => {
      let best = 0;
      for (const entry of fincenList) {
        const s = tokenSetSim(applicant_name, entry);
        if (s > best) best = s;
      }
      return best;
    })();

    fincen_score = Math.max(jwScore, tsScore);
    if (jwScore >= 0.82 || tsScore >= 0.80) {
      pts = 25;
      fincen_hit = true;
    }
    pts = Math.min(pts, 25);

    breakdown.E17_FinCEN = {
      pts,
      fincen_hit,
      fincen_score: +fincen_score.toFixed(4),
      jaro_winkler: +jwScore.toFixed(4),
      token_set_sim: +tsScore.toFixed(4),
    };
    return pts;
  }

  // ------------------------------------------------------------------
  // Fan-out all 17 engines in parallel, guarded by the hard timeout
  // ------------------------------------------------------------------
  const enginePromise = Promise.all([
    e1_ofac(), e2_pep(), e3_fatf(), e4_tin(), e5_velocity(),
    e6_structuring(), e7_adverse(), e8_ubo(), e9_dob(), e10_address(),
    e11_entity(), e12_depth(), e13_docs(), e14_network(), e15_synthetic(),
    e16_delta(), e17_fincen(),
  ]);

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve("TIMEOUT"), HARD_TIMEOUT_MS)
  );

  const race = await Promise.race([enginePromise, timeoutPromise]);
  const timedOut = race === "TIMEOUT";

  let totalPts = 0;
  if (!timedOut) {
    for (const pts of race) totalPts += pts;
    totalPts = Math.min(totalPts, 100);
  }

  return { totalPts, breakdown, timedOut };
}

// ---------------------------------------------------------------------------
// Decision band
// ---------------------------------------------------------------------------
function decide(totalPts, timedOut) {
  if (timedOut) return "REVIEW";
  if (totalPts < 30) return "APPROVED";
  if (totalPts < 70) return "REVIEW";
  return "DENIED";
}

// ---------------------------------------------------------------------------
// Submission ID generator
// ---------------------------------------------------------------------------
function newSubmissionId() {
  const rand = () => Math.random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);
  return `KYC-${rand()}-${rand()}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Audit log to D1
// ---------------------------------------------------------------------------
async function auditLog(env, record) {
  if (!env.AUDIT_DB) return;
  try {
    await env.AUDIT_DB
      .prepare(
        `INSERT INTO kyc_submissions
         (submission_id, tin, applicant_name, decision, score, flags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.submission_id,
        record.tin,
        record.applicant_name,
        record.decision,
        record.score,
        JSON.stringify(record.flags),
        new Date().toISOString()
      )
      .run();
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------
async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  if (!env.GATEWAY_AUTH) return false;
  const stored = await kvGet(env.GATEWAY_AUTH, `token:${token}`);
  return stored === "valid";
}

// ---------------------------------------------------------------------------
// Route: POST /api/kyc/apply
// ---------------------------------------------------------------------------
async function handleApply(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const { totalPts, breakdown, timedOut } = await runEngines(payload, env);
  const decision = decide(totalPts, timedOut);
  const submission_id = newSubmissionId();

  const allowed = decision === "APPROVED";

  // Collect flag keys (engines that scored > 0)
  const flags = Object.entries(breakdown)
    .filter(([, v]) => v.pts > 0)
    .map(([k]) => k);

  // Persist asynchronously (non-blocking)
  const auditRecord = {
    submission_id,
    tin: payload.tin || "",
    applicant_name: normalName(payload.applicant_name || ""),
    decision,
    score: totalPts,
    flags,
  };
  env.ctx?.waitUntil(auditLog(env, auditRecord));

  const systemAlert = decision === "DENIED"
    ? { fired: true, reason: "Score ≥70 — automatic denial", score: totalPts }
    : null;

  const responseBody = {
    submission_id,
    decision,
    score: totalPts,
    timed_out: timedOut,
    account_generation: { allowed },
    engines: {
      count: 17,
      version: `v${VERSION}`,
      parallel: true,
      timeout_ms: HARD_TIMEOUT_MS,
    },
    engines_run: 17,
    engine_version: `v${VERSION}`,
    breakdown,
    flags,
    ...(systemAlert ? { system_alert: systemAlert } : {}),
  };

  return { status: 200, body: responseBody, submission_id };
}

// ---------------------------------------------------------------------------
// Route: GET /api/kyc/health
// ---------------------------------------------------------------------------
function handleHealth() {
  return {
    status: 200,
    body: {
      status: "ok",
      version: VERSION,
      engines: 17,
      engine_version: `v${VERSION}`,
      timeout_ms: HARD_TIMEOUT_MS,
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Route: GET /api/kyc/stats
// ---------------------------------------------------------------------------
async function handleStats(env) {
  const result = {
    status: "ok",
    version: VERSION,
    totals: {},
  };

  if (env.AUDIT_DB) {
    try {
      const [total, approved, review, denied, fincenHits] = await Promise.all([
        env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions").first(),
        env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE decision='APPROVED'").first(),
        env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE decision='REVIEW'").first(),
        env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE decision='DENIED'").first(),
        env.AUDIT_DB
          .prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE flags_json LIKE '%E17_FinCEN%'")
          .first(),
      ]);
      result.totals = {
        all: total?.cnt ?? 0,
        approved: approved?.cnt ?? 0,
        review: review?.cnt ?? 0,
        denied: denied?.cnt ?? 0,
        fincen_hits: fincenHits?.cnt ?? 0,
      };
    } catch (err) {
      result.totals = { error: String(err) };
    }
  } else {
    result.totals = { note: "No AUDIT_DB binding — stats unavailable in this environment" };
  }

  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// Route: POST /api/kyc/batch  (internal; calls runEngines directly)
// ---------------------------------------------------------------------------
async function handleBatch(request, env) {
  let items;
  try {
    const body = await request.json();
    items = body.submissions;
    if (!Array.isArray(items)) throw new Error("submissions must be an array");
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }

  const results = await Promise.all(
    items.map(async (payload) => {
      const { totalPts, breakdown, timedOut } = await runEngines(payload, env);
      const decision = decide(totalPts, timedOut);
      const submission_id = newSubmissionId();
      return {
        submission_id,
        decision,
        score: totalPts,
        timed_out: timedOut,
        engine_version: `v${VERSION}`,
        breakdown,
      };
    })
  );

  return {
    status: 200,
    body: {
      engine_version: `v${VERSION}`,
      count: results.length,
      results,
    },
  };
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    // Stash ctx so auditLog can use waitUntil
    env.ctx = ctx;

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get("Origin") || "*";
    const cors = corsHeaders(origin);

    // Pre-flight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Routing
    let result;

    if (url.pathname === "/api/kyc/apply" && method === "POST") {
      const authed = await authenticate(request, env);
      if (!authed) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      result = await handleApply(request, env);
    } else if (url.pathname === "/api/kyc/batch" && method === "POST") {
      const authed = await authenticate(request, env);
      if (!authed) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      result = await handleBatch(request, env);
    } else if (url.pathname === "/api/kyc/health" && method === "GET") {
      result = handleHealth();
    } else if (url.pathname === "/api/kyc/stats" && method === "GET") {
      const authed = await authenticate(request, env);
      if (!authed) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      result = await handleStats(env);
    } else {
      result = {
        status: 404,
        body: { error: "Not found", version: VERSION },
      };
    }

    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json",
      "X-KYC-Version": VERSION,
    };

    // Expose submission ID in header for apply endpoint
    if (result.submission_id) {
      responseHeaders["X-Submission-Id"] = result.submission_id;
    }

    return new Response(JSON.stringify(result.body, null, 2), {
      status: result.status,
      headers: responseHeaders,
    });
  },
};
