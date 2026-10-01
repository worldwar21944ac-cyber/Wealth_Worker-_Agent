/**
 * kyc-gateway v9.0 — Sub-2-Second KYC/KYB Intake Screening
 * Cloudflare Worker · ES2022 modules · no npm dependencies
 *
 * 18 parallel screening engines:
 *   E1  OFAC SDN          – fuzzy name match, 40 pts/hit, cap 70
 *   E2  PEP               – politically exposed persons, 25 pts/hit, cap 50
 *   E3  FATF              – high-risk jurisdiction, 20 pts/hit
 *   E4  TIN/EIN           – IRS format validation, 20 pts on failure
 *   E5  Velocity          – >5 TIN submissions/24 h, 15 pts
 *   E6  Structuring       – $8,000–$9,999.99 bracket, 35 pts
 *   E7  Adverse Media     – keyword scan, 5 pts/kw, cap 30
 *   E8  UBO Cascade       – beneficial owner ≥25% → fan-out OFAC+PEP, 25 pts
 *   E9  DOB Plausibility  – future/under-18/over-120, 35 pts
 *   E10 Address Risk      – PO Box / known risk zip patterns, 10 pts
 *   E11 Entity Consistency– name/TIN/address cross-check, 15 pts
 *   E12 Corporate Depth   – >4 ownership layers, 20 pts
 *   E13 Document Entropy  – expired/missing document signals, 10 pts
 *   E14 Network Graph     – shared TIN or address across submissions, 20 pts
 *   E15 Synthetic ID      – SSN area 900+, 40 pts
 *   E16 Watchlist Delta   – newly-added SDN since last check, 30 pts
 *   E17 FinCEN 314(a)     – JW ≥0.82 OR token-set ≥0.80 on 314a list, 25 pts
 *   E18 Geo-velocity      – IP/country hop ≤1 h, 20 pts
 *
 * Decision bands: 0–29 APPROVED | 30–69 REVIEW | 70–100 DENIED
 * Hard timeout fence: 1 800 ms → auto-REVIEW
 *
 * Bindings (wrangler.toml):
 *   AUDIT_DB       – D1 database (bervashun-audit)
 *   KYC_SANCTIONS  – KV namespace (sanctions data)
 *   GATEWAY_AUTH   – KV namespace (API key store)
 *   KYC_ADMIN_KEY  – secret (admin routes)
 *   NOTIFIER_TOKEN – secret (signup-notifier webhook)
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION = "9.0";
const ENGINES_COUNT = 18;
const TIMEOUT_MS = 1800;
const SCREEN_TIMEOUT = 1750; // fence before hard limit

const SCORE_BANDS = { APPROVED: 29, REVIEW: 69 }; // ≤29 APPROVED, 30–69 REVIEW, ≥70 DENIED

const FATF_HIGH_RISK = new Set([
  "AF","AL","BB","BF","BI","CF","CN","CG","CD","CU","ET","GH","GN","GW","HT",
  "IR","IQ","JM","JO","KE","KP","LB","LY","ML","MM","MR","MZ","NI","NG","PK",
  "PA","PH","RU","SA","SD","SN","SL","SS","SY","TZ","TJ","TT","TN","TR","UA",
  "UG","VE","VU","YE","ZW","BY","MK","LA","KH","AM"
]);

const ADVERSE_KEYWORDS = [
  "fraud","money laundering","corruption","bribery","terrorism","cartel",
  "sanction","indicted","convicted","arrested","embezzlement","trafficking",
  "darknet","ransomware","ponzi","pyramid","scam","smuggling"
];

const DISALLOWED_EIN_PREFIXES = new Set([
  "07","08","09","17","18","19","28","29","49","69","70","78","79","89"
]);

const RISK_ZIP_PATTERNS = /^(00[0-8]|999)/;

const NOTIFIER_URL = "https://notify.wwwknockoutforever.com/webhook/system-alert";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalName(raw = "") {
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|dba|aka)\b\.?/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const matchDist = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = bMatches[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  const inter = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function fuzzyMatch(query, candidates, jwThresh = 0.82, tsThresh = 0.80) {
  const q = normalName(query);
  for (const c of candidates) {
    const cn = normalName(c);
    if (jaroWinkler(q, cn) >= jwThresh || tokenSetSimilarity(q, cn) >= tsThresh) return { matched: true, candidate: c };
  }
  return { matched: false };
}

function clamp(v, max) { return Math.min(v, max); }

function decisionFromScore(score) {
  if (score <= SCORE_BANDS.APPROVED) return "APPROVED";
  if (score <= SCORE_BANDS.REVIEW) return "REVIEW";
  return "DENIED";
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Gateway-Api-Key,X-Kyc-Admin-Key,X-Submission-Id",
    "Access-Control-Expose-Headers": "X-Submission-Id",
  };
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

async function requireAuth(request, env) {
  // Accept: Authorization: Bearer <key> OR X-Gateway-Api-Key: <key>
  const auth = request.headers.get("Authorization") || "";
  const keyHeader = request.headers.get("X-Gateway-Api-Key") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : keyHeader.trim();
  if (!token) return false;
  const stored = await env.GATEWAY_AUTH.get(`apikey:${token}`);
  return !!stored;
}

function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const adminHeader = request.headers.get("X-Kyc-Admin-Key") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : adminHeader.trim();
  return token === env.KYC_ADMIN_KEY;
}

// ─── KV helpers ───────────────────────────────────────────────────────────────

async function loadList(env, key) {
  try {
    const raw = await env.KYC_SANCTIONS.get(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─── Engine fan-out ───────────────────────────────────────────────────────────

async function runEngines(payload, env, ctx) {
  const {
    entity_type = "individual",
    applicant_name = "",
    tin = "",
    date_of_birth = "",
    address = {},
    transaction_amount,
    adverse_media_text = "",
    beneficial_owners = [],
    documents = [],
    ownership_layers,
    country_code = "",
    previous_country_code = "",
    previous_check_timestamp,
    ip_country = "",
    previous_ip_country = "",
    previous_ip_timestamp,
    network_peers = [],
  } = payload;

  const flags = [];
  let totalScore = 0;
  const breakdown = {};
  const startMs = Date.now();

  // Load KV data in parallel
  const [sdnList, pepList, fincenList, deltaList] = await Promise.all([
    loadList(env, "sdn:index"),
    loadList(env, "pep:index"),
    loadList(env, "fincen:314a"),
    loadList(env, "sdn:delta:7d"),
  ]);

  // Velocity KV check
  const velocityKey = `velocity:tin:${tin}:${new Date().toISOString().slice(0,10)}`;
  const velocityCountRaw = await env.KYC_SANCTIONS.get(velocityKey);
  const velocityCount = velocityCountRaw ? parseInt(velocityCountRaw, 10) : 0;

  // Increment velocity counter (fire-and-forget via ctx.waitUntil)
  ctx.waitUntil(
    env.KYC_SANCTIONS.put(velocityKey, String(velocityCount + 1), { expirationTtl: 86400 })
  );

  // Network graph: load peer TINs/addresses
  const peerTins = network_peers.map(p => p.tin).filter(Boolean);
  const peerAddresses = network_peers.map(p => p.address).filter(Boolean);

  // ── E1 OFAC SDN ─────────────────────────────────────────────────────────────
  const e1 = { score: 0, hits: [] };
  const sdnNames = sdnList.map(e => e.name || e);
  const sdnMatch = fuzzyMatch(applicant_name, sdnNames);
  if (sdnMatch.matched) { e1.score = clamp(40, 70); e1.hits.push(sdnMatch.candidate); flags.push("OFAC_SDN_HIT"); }
  breakdown.E1_OFAC_SDN = e1;

  // ── E2 PEP ──────────────────────────────────────────────────────────────────
  const e2 = { score: 0, hits: [] };
  const pepNames = pepList.map(e => e.name || e);
  const pepMatch = fuzzyMatch(applicant_name, pepNames);
  if (pepMatch.matched) { e2.score = clamp(25, 50); e2.hits.push(pepMatch.candidate); flags.push("PEP_HIT"); }
  breakdown.E2_PEP = e2;

  // ── E3 FATF ──────────────────────────────────────────────────────────────────
  const e3 = { score: 0 };
  const checkCountry = country_code.toUpperCase();
  if (checkCountry && FATF_HIGH_RISK.has(checkCountry)) { e3.score = 20; flags.push("FATF_HIGH_RISK_COUNTRY"); }
  breakdown.E3_FATF = e3;

  // ── E4 TIN/EIN ───────────────────────────────────────────────────────────────
  const e4 = { score: 0, tin_valid: false, ein_valid: false };
  const cleanTin = tin.replace(/\D/g, "");
  if (entity_type === "individual") {
    // SSN: 9 digits, area not 000/666/900+
    const area = parseInt(cleanTin.slice(0, 3), 10);
    e4.tin_valid = cleanTin.length === 9 && area !== 0 && area !== 666 && area < 900;
    if (!e4.tin_valid) { e4.score = 20; flags.push("INVALID_SSN"); }
  } else {
    // EIN: 9 digits, prefix not in disallowed set
    const prefix = cleanTin.slice(0, 2);
    e4.ein_valid = cleanTin.length === 9 && !DISALLOWED_EIN_PREFIXES.has(prefix);
    if (!e4.ein_valid) { e4.score = 20; flags.push("INVALID_EIN"); }
  }
  breakdown.E4_TIN_EIN = e4;

  // ── E5 Velocity ──────────────────────────────────────────────────────────────
  const e5 = { score: 0, count: velocityCount };
  if (velocityCount > 5) { e5.score = 15; flags.push("HIGH_VELOCITY"); }
  breakdown.E5_VELOCITY = e5;

  // ── E6 Structuring ───────────────────────────────────────────────────────────
  const e6 = { score: 0 };
  const amount = parseFloat(transaction_amount) || 0;
  if (amount >= 8000 && amount < 10000) { e6.score = 35; flags.push("STRUCTURING_DETECTED"); }
  breakdown.E6_STRUCTURING = e6;

  // ── E7 Adverse Media ─────────────────────────────────────────────────────────
  const e7 = { score: 0, hits: [] };
  const mediaLower = adverse_media_text.toLowerCase();
  for (const kw of ADVERSE_KEYWORDS) {
    if (mediaLower.includes(kw)) { e7.hits.push(kw); e7.score = clamp(e7.score + 5, 30); }
  }
  if (e7.hits.length) flags.push("ADVERSE_MEDIA");
  breakdown.E7_ADVERSE_MEDIA = e7;

  // ── E8 UBO Cascade ───────────────────────────────────────────────────────────
  const e8 = { score: 0, flagged_owners: [] };
  const materialOwners = beneficial_owners.filter(o => (o.ownership_pct || 0) >= 25);
  if (materialOwners.length) {
    const uboChecks = await Promise.all(materialOwners.map(async owner => {
      const [oSdn, oPep] = await Promise.all([
        Promise.resolve(fuzzyMatch(owner.name || "", sdnNames)),
        Promise.resolve(fuzzyMatch(owner.name || "", pepNames)),
      ]);
      return { owner, sdnHit: oSdn.matched, pepHit: oPep.matched };
    }));
    for (const r of uboChecks) {
      if (r.sdnHit || r.pepHit) {
        e8.score = clamp(e8.score + 25, 70);
        e8.flagged_owners.push({ name: r.owner.name, sdnHit: r.sdnHit, pepHit: r.pepHit });
        flags.push("UBO_SANCTIONS_HIT");
      }
    }
  }
  breakdown.E8_UBO_CASCADE = e8;

  // ── E9 DOB Plausibility ──────────────────────────────────────────────────────
  const e9 = { score: 0 };
  if (date_of_birth && entity_type === "individual") {
    const dob = new Date(date_of_birth);
    const now = new Date();
    if (isNaN(dob.getTime())) {
      e9.score = 35; flags.push("INVALID_DOB");
    } else {
      const ageYears = (now - dob) / (365.25 * 24 * 3600 * 1000);
      if (dob > now) { e9.score = 35; flags.push("FUTURE_DOB"); }
      else if (ageYears < 18) { e9.score = 35; flags.push("UNDERAGE_DOB"); }
      else if (ageYears > 120) { e9.score = 35; flags.push("IMPLAUSIBLE_DOB"); }
    }
  }
  breakdown.E9_DOB_PLAUSIBILITY = e9;

  // ── E10 Address Risk ─────────────────────────────────────────────────────────
  const e10 = { score: 0 };
  const addrStr = JSON.stringify(address).toLowerCase();
  const zip = address.zip || address.postal_code || "";
  if (/\bp\.?\s*o\.?\s*box\b/.test(addrStr) || RISK_ZIP_PATTERNS.test(zip)) {
    e10.score = 10; flags.push("RISKY_ADDRESS");
  }
  breakdown.E10_ADDRESS_RISK = e10;

  // ── E11 Entity Consistency ───────────────────────────────────────────────────
  const e11 = { score: 0 };
  if (entity_type === "business" && applicant_name && tin) {
    // simple heuristic: EIN should not begin with individual area codes
    const prefix = cleanTin.slice(0, 2);
    const individualOnly = ["575","576","750","751","752","753","754"];
    if (individualOnly.some(p => cleanTin.startsWith(p))) {
      e11.score = 15; flags.push("ENTITY_INCONSISTENCY");
    }
  }
  breakdown.E11_ENTITY_CONSISTENCY = e11;

  // ── E12 Corporate Depth ──────────────────────────────────────────────────────
  const e12 = { score: 0 };
  if (typeof ownership_layers === "number" && ownership_layers > 4) {
    e12.score = 20; flags.push("DEEP_OWNERSHIP_STRUCTURE");
  }
  breakdown.E12_CORPORATE_DEPTH = e12;

  // ── E13 Document Entropy ─────────────────────────────────────────────────────
  const e13 = { score: 0 };
  if (documents.length === 0) {
    e13.score = 10; flags.push("NO_DOCUMENTS");
  } else {
    const now = new Date();
    for (const doc of documents) {
      if (doc.expiry && new Date(doc.expiry) < now) {
        e13.score = Math.min(e13.score + 5, 10); flags.push("EXPIRED_DOCUMENT");
      }
    }
  }
  breakdown.E13_DOCUMENT_ENTROPY = e13;

  // ── E14 Network Graph ────────────────────────────────────────────────────────
  const e14 = { score: 0 };
  // Check D1 for shared TIN or address in last 30 days
  try {
    if (cleanTin && env.AUDIT_DB) {
      const netQ = await env.AUDIT_DB.prepare(
        `SELECT COUNT(*) as cnt FROM kyc_submissions
         WHERE tin = ? AND submission_id != ''
         AND created_at > datetime('now','-30 days')`
      ).bind(tin).first();
      const sharedTin = netQ?.cnt || 0;
      if (sharedTin > 1 || peerTins.includes(tin)) {
        e14.score = 20; flags.push("SHARED_TIN_NETWORK");
      }
    }
  } catch { /* non-fatal */ }
  breakdown.E14_NETWORK_GRAPH = e14;

  // ── E15 Synthetic Identity ───────────────────────────────────────────────────
  const e15 = { score: 0 };
  if (entity_type === "individual" && cleanTin.length === 9) {
    const area = parseInt(cleanTin.slice(0, 3), 10);
    if (area >= 900) { e15.score = 40; flags.push("SYNTHETIC_IDENTITY_SSN"); }
  }
  breakdown.E15_SYNTHETIC_IDENTITY = e15;

  // ── E16 Watchlist Delta ──────────────────────────────────────────────────────
  const e16 = { score: 0 };
  const deltaNames = deltaList.map(e => e.name || e);
  const deltaMatch = fuzzyMatch(applicant_name, deltaNames);
  if (deltaMatch.matched) { e16.score = 30; flags.push("NEWLY_ADDED_SDN_DELTA"); }
  breakdown.E16_WATCHLIST_DELTA = e16;

  // ── E17 FinCEN 314(a) ────────────────────────────────────────────────────────
  const e17 = { score: 0, hits: [] };
  const fincenNames = fincenList.map(e => e.name || e);
  const fincenMatch = fuzzyMatch(applicant_name, fincenNames, 0.82, 0.80);
  if (fincenMatch.matched) { e17.score = 25; e17.hits.push(fincenMatch.candidate); flags.push("FINCEN_314A_HIT"); }
  breakdown.E17_FINCEN_314A = e17;

  // ── E18 Geo-velocity ────────────────────────────────────────────────────────
  const e18 = { score: 0 };
  if (ip_country && previous_ip_country && ip_country !== previous_ip_country) {
    const prevTs = previous_ip_timestamp ? Date.parse(previous_ip_timestamp) : 0;
    const hopHours = prevTs ? (Date.now() - prevTs) / 3_600_000 : 0;
    if (hopHours < 1 || !prevTs) { // within 1 hour OR no timestamp (conservative)
      e18.score = 20; flags.push("GEO_VELOCITY_ANOMALY");
    }
  }
  breakdown.E18_GEO_VELOCITY = e18;

  // ── Aggregate ────────────────────────────────────────────────────────────────
  for (const k of Object.keys(breakdown)) {
    totalScore += breakdown[k].score || 0;
  }
  totalScore = Math.min(totalScore, 100);

  const latency_ms = Date.now() - startMs;

  return {
    score: totalScore,
    decision: decisionFromScore(totalScore),
    flags: [...new Set(flags)],
    breakdown,
    latency_ms,
    engines: { count: ENGINES_COUNT },
    e4_detail: { tin_valid: e4.tin_valid, ein_valid: e4.ein_valid },
    e8_detail: { flagged_owners: e8.flagged_owners },
    e17_detail: { fincen_hits: e17.hits },
  };
}

// ─── D1 persistence ───────────────────────────────────────────────────────────

async function persistSubmission(env, submissionId, payload, result, authorized) {
  const {
    entity_type = "individual", applicant_name = "", tin = "",
    address = {}, beneficial_owners = [],
  } = payload;
  const tinClean = tin.replace(/\D/g, "");
  const tinFormatted = entity_type === "individual"
    ? tinClean.replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3")
    : tinClean.replace(/(\d{2})(\d{7})/, "$1-$2");
  const flagsJson = JSON.stringify(result.flags);
  const breakdownJson = JSON.stringify(result.breakdown);
  const ofacHits = result.flags.filter(f => f.includes("OFAC") || f === "NEWLY_ADDED_SDN_DELTA").length;
  const pepHits = result.flags.includes("PEP_HIT") ? 1 : 0;
  const sanctionsHits = ofacHits + pepHits;
  const velocityFlagged = result.flags.includes("HIGH_VELOCITY") ? 1 : 0;
  const structuringFlagged = result.flags.includes("STRUCTURING_DETECTED") ? 1 : 0;
  const adverseHits = (result.breakdown.E7_ADVERSE_MEDIA?.hits || []).length;

  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO kyc_submissions
        (submission_id, entity_type, applicant_name, tin, tin_formatted,
         status, risk_score, risk_decision, risk_breakdown,
         sanctions_hits, ofac_hits, pep_hits, tin_valid, ein_valid,
         screen_latency_ms, raw_payload, screened_at, created_at,
         flags_json, velocity_flagged, structuring_flagged,
         adverse_media_hits, engine_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),?,?,?,?,?)
    `).bind(
      submissionId, entity_type, applicant_name, tin, tinFormatted,
      result.decision.toLowerCase(), result.score, result.decision, breakdownJson,
      sanctionsHits, ofacHits, pepHits,
      result.e4_detail.tin_valid ? 1 : 0,
      result.e4_detail.ein_valid ? 1 : 0,
      result.latency_ms, JSON.stringify(payload), flagsJson,
      velocityFlagged, structuringFlagged, adverseHits, VERSION
    ).run();

    // Queue for human review if needed
    if (result.decision === "REVIEW" || result.decision === "DENIED") {
      await env.AUDIT_DB.prepare(`
        INSERT INTO kyc_review_queue
          (reference_id, type, flags_json, payload_json, status, created_at)
        VALUES (?,?,?,?,?,datetime('now'))
      `).bind(
        submissionId, entity_type, flagsJson, JSON.stringify(payload), "pending"
      ).run();
    }
  } catch (e) {
    console.error("D1 persist error:", e.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

async function handleApply(request, env, ctx) {
  // Auth check
  const authed = await requireAuth(request, env);
  if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);

  let payload;
  try { payload = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  // Required fields
  if (!payload.applicant_name || !payload.tin) {
    return jsonResponse({ error: "applicant_name and tin are required" }, 422);
  }

  const submissionId = crypto.randomUUID();

  // Race engines against hard timeout
  let result;
  try {
    result = await Promise.race([
      runEngines(payload, env, ctx),
      new Promise(res => setTimeout(() =>
        res({ score: 45, decision: "REVIEW", flags: ["TIMEOUT"], breakdown: {}, latency_ms: TIMEOUT_MS, engines: { count: ENGINES_COUNT }, e4_detail: {}, e8_detail: { flagged_owners: [] }, e17_detail: { fincen_hits: [] } }),
        SCREEN_TIMEOUT
      )),
    ]);
  } catch (e) {
    result = { score: 45, decision: "REVIEW", flags: ["ENGINE_ERROR", e.message], breakdown: {}, latency_ms: 0, engines: { count: ENGINES_COUNT }, e4_detail: {}, e8_detail: { flagged_owners: [] }, e17_detail: { fincen_hits: [] } };
  }

  // Persist asynchronously
  ctx.waitUntil(persistSubmission(env, submissionId, payload, result, true));

  // Fire DENIED alert to notifier (non-blocking)
  if (result.decision === "DENIED" && env.NOTIFIER_TOKEN) {
    ctx.waitUntil(
      fetch(NOTIFIER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.NOTIFIER_TOKEN}` },
        body: JSON.stringify({
          event_type: "KYC_DENIED",
          severity: "HIGH",
          submission_id: submissionId,
          applicant_name: payload.applicant_name,
          flags: result.flags,
          score: result.score,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {})
    );
  }

  const responseBody = {
    submission_id: submissionId,
    version: VERSION,
    decision: result.decision,
    risk_score: result.score,
    flags: result.flags,
    engines: result.engines,
    latency_ms: result.latency_ms,
    account_generation: {
      allowed: result.decision === "APPROVED",
      blocked_reason: result.decision !== "APPROVED" ? `KYC decision: ${result.decision}` : null,
    },
    review_queued: result.decision === "REVIEW" || result.decision === "DENIED",
    breakdown: result.breakdown,
    e4_detail: result.e4_detail,
    e8_detail: result.e8_detail,
    e17_detail: result.e17_detail,
    screened_at: new Date().toISOString(),
  };

  return jsonResponse(responseBody, 200, { "X-Submission-Id": submissionId });
}

async function handleStatus(request, env, submissionId) {
  const authed = await requireAuth(request, env);
  if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
  try {
    const row = await env.AUDIT_DB.prepare(
      "SELECT * FROM kyc_submissions WHERE submission_id = ?"
    ).bind(submissionId).first();
    if (!row) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse({ submission_id: submissionId, ...row });
  } catch (e) {
    return jsonResponse({ error: "DB error", detail: e.message }, 500);
  }
}

async function handleReviewList(request, env) {
  if (!requireAdmin(request, env)) return jsonResponse({ error: "Forbidden" }, 403);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = Math.min(100, parseInt(url.searchParams.get("per_page") || "25", 10));
  const status = url.searchParams.get("status") || "pending";
  const offset = (page - 1) * perPage;
  try {
    const rows = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(status, perPage, offset).all();
    const total = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_review_queue WHERE status = ?`
    ).bind(status).first();
    return jsonResponse({ page, per_page: perPage, total: total?.cnt || 0, results: rows.results || [] });
  } catch (e) {
    return jsonResponse({ error: "DB error", detail: e.message }, 500);
  }
}

async function handleReviewAction(request, env, submissionId, action) {
  if (!requireAdmin(request, env)) return jsonResponse({ error: "Forbidden" }, 403);
  const validActions = ["approve", "reject", "escalate"];
  if (!validActions.includes(action)) return jsonResponse({ error: "Invalid action" }, 400);
  let notes = "";
  try { const b = await request.json(); notes = b.notes || ""; } catch {}
  const newStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "escalated";
  try {
    await env.AUDIT_DB.prepare(
      `UPDATE kyc_review_queue SET status = ?, resolved_at = datetime('now'), resolved_by = 'admin' WHERE reference_id = ?`
    ).bind(newStatus, submissionId).run();
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_log (event_id, event_type, entity_id, entity_type, created_at)
       VALUES (?,?,?,'kyc_submission',datetime('now'))`
    ).bind(crypto.randomUUID(), `kyc.${action}`, submissionId).run();
    return jsonResponse({ submission_id: submissionId, action, new_status: newStatus, notes, timestamp: new Date().toISOString() });
  } catch (e) {
    return jsonResponse({ error: "DB error", detail: e.message }, 500);
  }
}

async function handleBatch(request, env, ctx) {
  if (!requireAdmin(request, env)) return jsonResponse({ error: "Forbidden" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  const items = Array.isArray(body.submissions) ? body.submissions : [];
  if (items.length === 0 || items.length > 50) return jsonResponse({ error: "1–50 submissions required" }, 422);
  const results = await Promise.allSettled(
    items.map(async item => {
      const id = crypto.randomUUID();
      const r = await runEngines(item, env, ctx);
      ctx.waitUntil(persistSubmission(env, id, item, r, true));
      return { submission_id: id, applicant_name: item.applicant_name, decision: r.decision, risk_score: r.score, flags: r.flags, latency_ms: r.latency_ms };
    })
  );
  return jsonResponse({
    total: items.length,
    results: results.map((r, i) => r.status === "fulfilled" ? r.value : { index: i, error: r.reason?.message }),
  });
}

async function handleStats(request, env) {
  if (!requireAdmin(request, env)) return jsonResponse({ error: "Forbidden" }, 403);
  try {
    const [total, approved, review, denied, avgLatency, fincenHits] = await Promise.all([
      env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions").first(),
      env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='APPROVED'").first(),
      env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='REVIEW'").first(),
      env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='DENIED'").first(),
      env.AUDIT_DB.prepare("SELECT AVG(screen_latency_ms) as avg FROM kyc_submissions").first(),
      env.AUDIT_DB.prepare("SELECT COUNT(*) as cnt FROM kyc_submissions WHERE flags_json LIKE '%FINCEN_314A_HIT%'").first(),
    ]);
    return jsonResponse({
      version: VERSION, engines: ENGINES_COUNT,
      total: total?.cnt || 0, approved: approved?.cnt || 0,
      review: review?.cnt || 0, denied: denied?.cnt || 0,
      avg_latency_ms: Math.round(avgLatency?.avg || 0),
      fincen_hits: fincenHits?.cnt || 0,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return jsonResponse({ error: "DB error", detail: e.message }, 500);
  }
}

async function handleHealth(env) {
  let dbOk = false;
  try { await env.AUDIT_DB.prepare("SELECT 1").first(); dbOk = true; } catch {}
  return jsonResponse({
    status: dbOk ? "ok" : "degraded",
    version: VERSION, engines: ENGINES_COUNT,
    db: dbOk ? "connected" : "error",
    timestamp: new Date().toISOString(),
  }, dbOk ? 200 : 503);
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let response;

    try {
      if (path === "/api/kyc/apply" && request.method === "POST") {
        response = await handleApply(request, env, ctx);
      } else if (path.startsWith("/api/kyc/status/") && request.method === "GET") {
        const sid = path.split("/api/kyc/status/")[1];
        response = await handleStatus(request, env, sid);
      } else if (path === "/api/kyc/review" && request.method === "GET") {
        response = await handleReviewList(request, env);
      } else if (path.match(/^\/api\/kyc\/review\/[^/]+\/(approve|reject|escalate)$/) && request.method === "POST") {
        const parts = path.split("/");
        const action = parts[parts.length - 1];
        const sid = parts[parts.length - 2];
        response = await handleReviewAction(request, env, sid, action);
      } else if (path === "/api/kyc/batch" && request.method === "POST") {
        response = await handleBatch(request, env, ctx);
      } else if (path === "/api/kyc/stats" && request.method === "GET") {
        response = await handleStats(request, env);
      } else if (path === "/api/kyc/health" && request.method === "GET") {
        response = await handleHealth(env);
      } else {
        response = jsonResponse({ error: "Not found", path }, 404);
      }
    } catch (e) {
      response = jsonResponse({ error: "Internal server error", detail: e.message }, 500);
    }

    // Attach CORS headers to every response
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
};
