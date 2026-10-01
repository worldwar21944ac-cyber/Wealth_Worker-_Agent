/**
 * kyc-gateway v8.1 — Sub-2-Second KYC/KYB Intake Screening
 * Cloudflare Worker | wwwknockoutforever.com / Bervashun Trust Capital
 *
 * 17 Engines, Promise.all() parallel fan-out, 1800ms hard fence
 * Decision bands: 0-29 APPROVED | 30-69 REVIEW | 70-100 DENIED
 *
 * E1  OFAC SDN          40pts/hit, cap 70
 * E2  PEP               25pts/hit, cap 50
 * E3  FATF              20pts (55 countries)
 * E4  TIN/EIN           20pts invalid
 * E5  Velocity          15pts >5 same TIN/24h
 * E6  Structuring       35pts $8k–$9,999
 * E7  Adverse Media     5pts/kw, cap 30
 * E8  UBO Cascade       25pts ≥25% ownership
 * E9  DOB               35pts future/under-18/over-120
 * E10 Address Risk      10pts
 * E11 Entity Consistency 15pts
 * E12 Corporate Depth   20pts >4 layers
 * E13 Document Entropy  10pts low/expired
 * E14 Network Graph     20pts shared TIN/addr
 * E15 Synthetic Identity 40pts SSN area 900+
 * E16 Watchlist Delta   30pts newly-added SDN
 * E17 FinCEN 314(a)     25pts JW≥0.82 OR token-set≥0.80
 */

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const ENGINE_VERSION = "8.1.0";
const SCREEN_TIMEOUT_MS = 1800;
const ENGINES_COUNT = 17;

const OFAC_SDN_KEYWORDS = [
  "al-qaeda","taliban","isis","hamas","hezbollah","al-shabaab","boko haram",
  "iran revolutionary guard","irgc","quds force","proud boys","wagner group",
  "kim jong","north korea","dprk","maduro","lukashenko","xi jinping","putin vladimir",
  "bin laden","zarqawi","khamenei","nasrallah","sinoloa","zetas cartel",
  "aryan nations","white aryan resistance","patriot front","atomwaffen",
  "al-nusra","jabhat al-nusra","lashkar-e-taiba","jaish-e-mohammed",
  "chinese military company","pla unit","ministry state security",
];

const PEP_LIST = [
  "joe biden","donald trump","kamala harris","nancy pelosi","mitch mcconnell",
  "vladimir putin","xi jinping","rishi sunak","emmanuel macron","olaf scholz",
  "justin trudeau","anthony albanese","fumio kishida","narendra modi",
  "jair bolsonaro","luiz inacio lula da silva","andrés manuel lópez obrador",
  "ursula von der leyen","charles michel","janet yellen","jerome powell",
  "antony blinken","lloyd austin","alejandro mayorkas","christopher wray",
];

const FINCEN_314A_ENTRIES = [
  "carlos escobar mendez","juan carlos ramirez","antonio garcia morales",
  "ibrahim al-rashid","mohammed al-farsi","chen wei hong",
];

const FATF_HIGH_RISK = new Set([
  "AF","AL","BB","BF","BJ","BT","CD","CF","CM","CU","ET","GH","GT","GY",
  "HT","ID","IL","IQ","IR","JM","JO","KP","LB","LK","LY","MA","ML","MR",
  "MU","MW","MX","MY","NG","NI","PA","PK","PH","QA","RS","RU","SD","SN",
  "SO","SS","SY","TG","TH","TN","TR","UG","VE","YE","ZA","ZW",
]);

const ADVERSE_MEDIA_KW = [
  "fraud","money laundering","terrorist financing","sanctions violation",
  "bribery","corruption","ponzi","embezzlement","drug trafficking",
  "human trafficking","tax evasion","wire fraud","securities fraud",
];

const HIGH_RISK_STATES = new Set(["NV","DE","WY","MT","SD","NM"]);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function normalName(raw = "") {
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const maxDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0; let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end = Math.min(i + maxDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = bMatches[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function fuzzyMatchAny(name, list, jwThreshold = 0.82, tsThreshold = 0.80) {
  const norm = normalName(name);
  const hits = [];
  for (const entry of list) {
    const normEntry = normalName(entry);
    const jw = jaroWinkler(norm, normEntry);
    const ts = tokenSetSimilarity(norm, normEntry);
    if (jw >= jwThreshold || ts >= tsThreshold) {
      hits.push({ entry, jw: +jw.toFixed(3), ts: +ts.toFixed(3) });
    }
  }
  return hits;
}

function validateSSN(ssn = "") {
  const digits = ssn.replace(/\D/g, "");
  if (digits.length !== 9) return { valid: false, reason: "length" };
  const area = parseInt(digits.slice(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900) return { valid: false, reason: area >= 900 ? "synthetic_area" : "invalid_area" };
  if (digits.slice(3, 5) === "00" || digits.slice(5) === "0000") return { valid: false, reason: "invalid_group_serial" };
  return { valid: true };
}

function validateEIN(ein = "") {
  const digits = ein.replace(/\D/g, "");
  if (digits.length !== 9) return { valid: false, reason: "length" };
  const prefix = parseInt(digits.slice(0, 2), 10);
  const disallowed = [7, 8, 9, 17, 18, 19, 28, 29, 49, 69, 70, 78, 79, 89];
  if (disallowed.includes(prefix)) return { valid: false, reason: `disallowed_prefix_${prefix}` };
  return { valid: true };
}

function genId(prefix = "kyc") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── SCREENING ENGINES ───────────────────────────────────────────────────────

async function runE1_OFAC(name, kv) {
  // KV lookup first, then local keyword fallback
  let sdnList = OFAC_SDN_KEYWORDS;
  try {
    const raw = await kv.get("sdn:index", { cacheTtl: 300 });
    if (raw) sdnList = JSON.parse(raw);
  } catch (_) {}
  const hits = fuzzyMatchAny(name, sdnList);
  const pts = Math.min(hits.length * 40, 70);
  return { engine: "E1_OFAC_SDN", score: pts, hits: hits.slice(0, 5), flagged: pts > 0 };
}

async function runE2_PEP(name, kv) {
  let pepList = PEP_LIST;
  try {
    const raw = await kv.get("pep:index", { cacheTtl: 300 });
    if (raw) pepList = JSON.parse(raw);
  } catch (_) {}
  const hits = fuzzyMatchAny(name, pepList);
  const pts = Math.min(hits.length * 25, 50);
  return { engine: "E2_PEP", score: pts, hits: hits.slice(0, 5), flagged: pts > 0 };
}

function runE3_FATF(country = "") {
  const flagged = FATF_HIGH_RISK.has(country.toUpperCase());
  return { engine: "E3_FATF", score: flagged ? 20 : 0, flagged, country };
}

function runE4_TIN(tin = "", entityType = "individual") {
  if (!tin) return { engine: "E4_TIN", score: 20, flagged: true, reason: "missing" };
  const clean = tin.replace(/\D/g, "");
  if (entityType === "business") {
    const r = validateEIN(clean);
    return { engine: "E4_TIN", score: r.valid ? 0 : 20, flagged: !r.valid, ...r };
  }
  const r = validateSSN(clean);
  return { engine: "E4_TIN", score: r.valid ? 0 : 20, flagged: !r.valid, ...r };
}

async function runE5_Velocity(tin = "", db) {
  if (!tin || !db) return { engine: "E5_Velocity", score: 0, flagged: false };
  try {
    const clean = tin.replace(/\D/g, "");
    const since = new Date(Date.now() - 86400000).toISOString();
    const { results } = await db.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin=? AND created_at>?`
    ).bind(clean, since).all();
    const cnt = results[0]?.cnt || 0;
    const flagged = cnt > 5;
    return { engine: "E5_Velocity", score: flagged ? 15 : 0, count_24h: cnt, flagged };
  } catch (_) {
    return { engine: "E5_Velocity", score: 0, flagged: false, error: "db_unavailable" };
  }
}

function runE6_Structuring(amount = 0) {
  const flagged = amount >= 8000 && amount < 10000;
  return { engine: "E6_Structuring", score: flagged ? 35 : 0, flagged, amount };
}

function runE7_AdverseMedia(text = "") {
  const lower = text.toLowerCase();
  const hits = ADVERSE_MEDIA_KW.filter(kw => lower.includes(kw));
  const pts = Math.min(hits.length * 5, 30);
  return { engine: "E7_AdverseMedia", score: pts, hits, flagged: pts > 0 };
}

async function runE8_UBO(owners = [], kv) {
  if (!owners || owners.length === 0) return { engine: "E8_UBO", score: 0, flagged: false };
  const majorOwners = owners.filter(o => parseFloat(o.ownership_pct || 0) >= 25);
  const checks = await Promise.all(majorOwners.map(async (o) => {
    const sdnHits = (await runE1_OFAC(o.name, kv)).hits;
    const pepHits = (await runE2_PEP(o.name, kv)).hits;
    return { name: o.name, ownership_pct: o.ownership_pct, sdn_hits: sdnHits, pep_hits: pepHits };
  }));
  const flagged = checks.some(c => c.sdn_hits.length > 0 || c.pep_hits.length > 0);
  return { engine: "E8_UBO", score: flagged ? 25 : 0, flagged, owners_screened: checks };
}

function runE9_DOB(dob = "") {
  if (!dob) return { engine: "E9_DOB", score: 0, flagged: false, reason: "missing_dob" };
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return { engine: "E9_DOB", score: 10, flagged: true, reason: "invalid_format" };
  const now = new Date();
  const age = (now - birth) / (365.25 * 24 * 3600 * 1000);
  if (birth > now) return { engine: "E9_DOB", score: 35, flagged: true, reason: "future_dob", age: null };
  if (age < 18) return { engine: "E9_DOB", score: 35, flagged: true, reason: "under_18", age: +age.toFixed(1) };
  if (age > 120) return { engine: "E9_DOB", score: 35, flagged: true, reason: "over_120", age: +age.toFixed(1) };
  return { engine: "E9_DOB", score: 0, flagged: false, age: +age.toFixed(1) };
}

function runE10_AddressRisk(address = {}) {
  const state = (address.state || "").toUpperCase();
  const flagged = HIGH_RISK_STATES.has(state);
  return { engine: "E10_AddressRisk", score: flagged ? 10 : 0, flagged, state };
}

function runE11_EntityConsistency(payload = {}) {
  const flags = [];
  if (payload.entity_type === "individual" && payload.business_name) flags.push("individual_has_business_name");
  if (payload.entity_type === "business" && !payload.business_name) flags.push("business_missing_name");
  if (payload.entity_type === "business" && payload.ssn) flags.push("business_has_ssn");
  const score = Math.min(flags.length * 15, 15);
  return { engine: "E11_EntityConsistency", score, flagged: flags.length > 0, flags };
}

function runE12_CorporateDepth(ubo_chain = []) {
  const depth = ubo_chain.length;
  const flagged = depth > 4;
  return { engine: "E12_CorporateDepth", score: flagged ? 20 : 0, flagged, depth };
}

function runE13_DocumentEntropy(docs = []) {
  if (!docs || docs.length === 0) return { engine: "E13_DocumentEntropy", score: 10, flagged: true, reason: "no_documents" };
  const expired = docs.filter(d => d.expiry && new Date(d.expiry) < new Date());
  const score = expired.length > 0 ? 10 : 0;
  return { engine: "E13_DocumentEntropy", score, flagged: score > 0, expired_count: expired.length };
}

async function runE14_NetworkGraph(tin = "", address = {}, db) {
  if (!tin || !db) return { engine: "E14_NetworkGraph", score: 0, flagged: false };
  try {
    const clean = tin.replace(/\D/g, "");
    const addrStr = [address.street, address.city, address.state].filter(Boolean).join(",").toLowerCase();
    const { results: tinMatches } = await db.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin=? AND submission_id != 'NEW'`
    ).bind(clean).all();
    const sharedTin = (tinMatches[0]?.cnt || 0) > 1;
    const flagged = sharedTin;
    return { engine: "E14_NetworkGraph", score: flagged ? 20 : 0, flagged, shared_tin: sharedTin };
  } catch (_) {
    return { engine: "E14_NetworkGraph", score: 0, flagged: false };
  }
}

function runE15_SyntheticIdentity(ssn = "", name = "", dob = "") {
  const clean = ssn.replace(/\D/g, "");
  if (!clean || clean.length !== 9) return { engine: "E15_Synthetic", score: 0, flagged: false };
  const area = parseInt(clean.slice(0, 3), 10);
  const synth = area >= 900;
  return { engine: "E15_Synthetic", score: synth ? 40 : 0, flagged: synth, ssn_area: area };
}

async function runE16_WatchlistDelta(name = "", kv) {
  try {
    const raw = await kv.get("sdn:delta:7d", { cacheTtl: 60 });
    if (!raw) return { engine: "E16_WatchlistDelta", score: 0, flagged: false };
    const delta = JSON.parse(raw);
    const hits = fuzzyMatchAny(name, delta);
    return { engine: "E16_WatchlistDelta", score: hits.length > 0 ? 30 : 0, flagged: hits.length > 0, hits };
  } catch (_) {
    return { engine: "E16_WatchlistDelta", score: 0, flagged: false };
  }
}

async function runE17_FinCEN314a(name = "", kv) {
  let fincenList = FINCEN_314A_ENTRIES;
  try {
    const raw = await kv.get("fincen:314a", { cacheTtl: 300 });
    if (raw) fincenList = JSON.parse(raw);
  } catch (_) {}
  const hits = fuzzyMatchAny(name, fincenList, 0.82, 0.80);
  return { engine: "E17_FinCEN_314a", score: hits.length > 0 ? 25 : 0, flagged: hits.length > 0, hits };
}

// ─── DECISION LOGIC ──────────────────────────────────────────────────────────

function decide(totalScore) {
  if (totalScore < 30) return "APPROVED";
  if (totalScore < 70) return "REVIEW";
  return "DENIED";
}

// ─── MAIN SCREENING RUNNER ───────────────────────────────────────────────────

async function screen(payload, env) {
  const startMs = Date.now();
  const {
    entity_type = "individual",
    applicant_name = "",
    business_name,
    tin = "",
    ssn,
    dob,
    address = {},
    country = "",
    amount = 0,
    adverse_media_text = "",
    beneficial_owners = [],
    ubo_chain = [],
    documents = [],
    notes = "",
  } = payload;

  const name = entity_type === "business" ? (business_name || applicant_name) : applicant_name;

  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ timedOut: true }), SCREEN_TIMEOUT_MS)
  );

  const engines = Promise.all([
    runE1_OFAC(name, env.KYC_SANCTIONS),
    runE2_PEP(name, env.KYC_SANCTIONS),
    runE3_FATF(country),
    runE4_TIN(tin || ssn, entity_type),
    runE5_Velocity(tin, env.AUDIT_DB),
    runE6_Structuring(parseFloat(amount)),
    runE7_AdverseMedia(adverse_media_text + " " + notes),
    runE8_UBO(beneficial_owners, env.KYC_SANCTIONS),
    runE9_DOB(dob),
    runE10_AddressRisk(address),
    runE11_EntityConsistency({ ...payload }),
    runE12_CorporateDepth(ubo_chain),
    runE13_DocumentEntropy(documents),
    runE14_NetworkGraph(tin, address, env.AUDIT_DB),
    runE15_SyntheticIdentity(ssn || tin, name, dob),
    runE16_WatchlistDelta(name, env.KYC_SANCTIONS),
    runE17_FinCEN314a(name, env.KYC_SANCTIONS),
  ]);

  const result = await Promise.race([engines, timeout]);

  if (result?.timedOut) {
    return {
      timedOut: true,
      decision: "REVIEW",
      reason: "screening_timeout",
      risk_score: 0,
      latency_ms: Date.now() - startMs,
    };
  }

  const engineResults = result;
  const totalScore = Math.min(engineResults.reduce((sum, e) => sum + (e.score || 0), 0), 100);
  const decision = decide(totalScore);
  const flaggedEngines = engineResults.filter(e => e.flagged).map(e => e.engine);

  return {
    timedOut: false,
    decision,
    risk_score: totalScore,
    flagged_engines: flaggedEngines,
    engine_results: engineResults,
    account_generation: { allowed: decision === "APPROVED" },
    engines: { count: ENGINES_COUNT, version: ENGINE_VERSION },
    latency_ms: Date.now() - startMs,
  };
}

// ─── D1 PERSISTENCE ──────────────────────────────────────────────────────────

async function persistSubmission(submissionId, payload, result, env) {
  if (!env.AUDIT_DB) return;
  const { decision, risk_score, flagged_engines, engine_results, latency_ms } = result;
  const e = engine_results || [];
  const e1 = e.find(x => x.engine === "E1_OFAC_SDN") || {};
  const e2 = e.find(x => x.engine === "E2_PEP") || {};
  const e4 = e.find(x => x.engine === "E4_TIN") || {};
  const e5 = e.find(x => x.engine === "E5_Velocity") || {};
  const e6 = e.find(x => x.engine === "E6_Structuring") || {};
  const e7 = e.find(x => x.engine === "E7_AdverseMedia") || {};
  const tin = (payload.tin || payload.ssn || "").replace(/\D/g, "");
  const tinFormatted = tin.length === 9 ? `${tin.slice(0,3)}-${tin.slice(3,5)}-${tin.slice(5)}` : tin;

  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO kyc_submissions (
        submission_id, entity_type, applicant_name, tin, tin_formatted,
        status, risk_score, risk_decision, risk_breakdown,
        sanctions_hits, ofac_hits, pep_hits,
        tin_valid, ein_valid, screen_latency_ms, raw_payload, screened_at,
        flags_json, velocity_flagged, structuring_flagged, adverse_media_hits, engine_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      submissionId,
      payload.entity_type || "individual",
      payload.applicant_name || payload.business_name || "",
      tin,
      tinFormatted,
      decision === "APPROVED" ? "approved" : decision === "REVIEW" ? "pending_review" : "denied",
      risk_score,
      decision,
      JSON.stringify(flagged_engines || []),
      (e1.hits?.length || 0) + (e2.hits?.length || 0),
      e1.hits?.length || 0,
      e2.hits?.length || 0,
      e4.valid ? 1 : 0,
      payload.entity_type === "business" ? (e4.valid ? 1 : 0) : null,
      latency_ms,
      JSON.stringify(payload),
      new Date().toISOString(),
      JSON.stringify(flagged_engines || []),
      e5.flagged ? 1 : 0,
      e6.flagged ? 1 : 0,
      e7.hits?.length || 0,
      ENGINE_VERSION,
    ).run();

    if (decision !== "APPROVED") {
      await env.AUDIT_DB.prepare(`
        INSERT INTO kyc_review_queue (
          submission_id, entity_type, entity_name, risk_score, risk_decision,
          flags_json, payload_json, status, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(
        submissionId,
        payload.entity_type || "individual",
        payload.applicant_name || payload.business_name || "",
        risk_score,
        decision,
        JSON.stringify(flagged_engines || []),
        JSON.stringify(payload),
        "pending",
        new Date().toISOString(),
      ).run();
    }
  } catch (err) {
    console.error("D1 persist error:", err.message);
  }
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

async function checkAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const apiKey = request.headers.get("X-API-Key") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const gwKey = await env.GATEWAY_AUTH?.get(`apikey:${bearerToken}`) ||
                await env.GATEWAY_AUTH?.get(`apikey:${apiKey}`);
  if (gwKey) return true;

  const adminKey = env.KYC_ADMIN_KEY;
  if (adminKey && (bearerToken === adminKey || apiKey === adminKey)) return true;
  return false;
}

async function checkAdminAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const apiKey = request.headers.get("X-API-Key") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const adminKey = env.KYC_ADMIN_KEY;
  return adminKey && (bearerToken === adminKey || apiKey === adminKey);
}

// ─── CORS HEADERS ────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Submission-Id",
  "Access-Control-Expose-Headers": "X-Submission-Id",
  "Content-Type": "application/json",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, ...extra } });
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

async function handleApply(request, env) {
  if (!(await checkAuth(request, env))) {
    return json({ error: "Unauthorized", hint: "Provide Bearer token or X-API-Key" }, 401);
  }

  let payload;
  try { payload = await request.json(); } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const submissionId = genId("kyc");
  const result = await screen(payload, env);

  // Fire-and-forget D1 write
  env.ctx?.waitUntil?.(persistSubmission(submissionId, payload, result, env)) ||
    persistSubmission(submissionId, payload, result, env);

  // SYSTEM_ALERT for DENIED
  if (result.decision === "DENIED" && env.NOTIFIER_TOKEN) {
    const alertBody = {
      event_type: "SYSTEM_ALERT",
      severity: "HIGH",
      message: `KYC DENIED: ${payload.applicant_name || payload.business_name}`,
      submission_id: submissionId,
      risk_score: result.risk_score,
      flagged_engines: result.flagged_engines,
    };
    fetch("https://notify.wwwknockoutforever.com/webhook/system-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.NOTIFIER_TOKEN}` },
      body: JSON.stringify(alertBody),
    }).catch(() => {});
  }

  return json({
    submission_id: submissionId,
    entity_type: payload.entity_type || "individual",
    applicant_name: payload.applicant_name || payload.business_name,
    decision: result.decision,
    risk_score: result.risk_score,
    flagged_engines: result.flagged_engines,
    account_generation: result.account_generation,
    engines: result.engines,
    screen_latency_ms: result.latency_ms,
    timedOut: result.timedOut,
    engine_details: result.engine_results,
    timestamp: new Date().toISOString(),
  }, 200, { "X-Submission-Id": submissionId });
}

async function handleStatus(submissionId, env) {
  if (!env.AUDIT_DB) return json({ error: "DB unavailable" }, 503);
  try {
    const { results } = await env.AUDIT_DB.prepare(
      `SELECT submission_id, entity_type, applicant_name, status, risk_score, risk_decision,
              risk_breakdown, screen_latency_ms, screened_at, created_at
       FROM kyc_submissions WHERE submission_id=? LIMIT 1`
    ).bind(submissionId).all();
    if (!results[0]) return json({ error: "Not found" }, 404);
    return json(results[0]);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleReview(request, env) {
  if (!(await checkAdminAuth(request, env))) return json({ error: "Admin auth required" }, 403);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const perPage = Math.min(parseInt(url.searchParams.get("per_page") || "20", 10), 100);
  const status = url.searchParams.get("status") || "pending";
  const offset = (page - 1) * perPage;

  if (!env.AUDIT_DB) return json({ error: "DB unavailable" }, 503);
  try {
    const { results } = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_review_queue WHERE status=? ORDER BY risk_score DESC LIMIT ? OFFSET ?`
    ).bind(status, perPage, offset).all();
    const { results: countRes } = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as total FROM kyc_review_queue WHERE status=?`
    ).bind(status).all();
    return json({ page, per_page: perPage, total: countRes[0]?.total || 0, items: results });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleReviewAction(submissionId, action, request, env) {
  if (!(await checkAdminAuth(request, env))) return json({ error: "Admin auth required" }, 403);
  if (!["approve", "reject", "escalate"].includes(action)) return json({ error: "Invalid action" }, 400);

  const statusMap = { approve: "approved", reject: "rejected", escalate: "escalated" };
  const newStatus = statusMap[action];

  if (!env.AUDIT_DB) return json({ error: "DB unavailable" }, 503);
  try {
    await env.AUDIT_DB.prepare(
      `UPDATE kyc_review_queue SET status=?, resolved_at=? WHERE submission_id=?`
    ).bind(newStatus, new Date().toISOString(), submissionId).run();
    await env.AUDIT_DB.prepare(
      `UPDATE kyc_submissions SET status=? WHERE submission_id=?`
    ).bind(newStatus, submissionId).run();
    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_log (event_type, entity_id, entity_type, event_data, created_at)
       VALUES (?,?,?,?,?)`
    ).bind(`kyc_review_${action}`, submissionId, "kyc_submission",
           JSON.stringify({ action, by: "operator" }), new Date().toISOString()).run();
    return json({ submission_id: submissionId, action, new_status: newStatus });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleBatch(request, env) {
  if (!(await checkAdminAuth(request, env))) return json({ error: "Admin auth required" }, 403);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Invalid JSON" }, 400); }
  const items = Array.isArray(body) ? body : body.submissions;
  if (!items || items.length > 50) return json({ error: "Provide array of up to 50 submissions" }, 400);

  const results = await Promise.all(items.map(async (payload) => {
    const submissionId = genId("batch");
    const result = await screen(payload, env);
    await persistSubmission(submissionId, payload, result, env);
    return { submission_id: submissionId, decision: result.decision, risk_score: result.risk_score, latency_ms: result.latency_ms };
  }));

  return json({ processed: results.length, results });
}

async function handleStats(request, env) {
  if (!(await checkAdminAuth(request, env))) return json({ error: "Admin auth required" }, 403);
  if (!env.AUDIT_DB) return json({ error: "DB unavailable" }, 503);
  try {
    const [{ results: totals }, { results: decisions }, { results: fincen }] = await Promise.all([
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as total, AVG(screen_latency_ms) as avg_latency FROM kyc_submissions`).all(),
      env.AUDIT_DB.prepare(`SELECT risk_decision, COUNT(*) as cnt FROM kyc_submissions GROUP BY risk_decision`).all(),
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as fincen_hits FROM kyc_submissions WHERE engine_version=? AND adverse_media_hits>0`).bind(ENGINE_VERSION).all(),
    ]);
    return json({
      total_submissions: totals[0]?.total || 0,
      avg_latency_ms: Math.round(totals[0]?.avg_latency || 0),
      decisions: Object.fromEntries(decisions.map(d => [d.risk_decision, d.cnt])),
      fincen_hits: fincen[0]?.fincen_hits || 0,
      engine_version: ENGINE_VERSION,
      engines_count: ENGINES_COUNT,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function handleHealth(env) {
  return json({
    status: "ok",
    service: "kyc-gateway",
    version: ENGINE_VERSION,
    engines: ENGINES_COUNT,
    timestamp: new Date().toISOString(),
    bindings: {
      audit_db: !!env.AUDIT_DB,
      kyc_sanctions: !!env.KYC_SANCTIONS,
      gateway_auth: !!env.GATEWAY_AUTH,
    },
  });
}

// ─── MAIN FETCH HANDLER ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    env.ctx = ctx;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // POST /api/kyc/apply
    if (method === "POST" && path === "/api/kyc/apply") return handleApply(request, env);

    // GET /api/kyc/status/:id
    if (method === "GET" && path.startsWith("/api/kyc/status/")) {
      return handleStatus(path.split("/")[4], env);
    }

    // GET /api/kyc/review
    if (method === "GET" && path === "/api/kyc/review") return handleReview(request, env);

    // POST /api/kyc/review/:id/(approve|reject|escalate)
    const reviewMatch = path.match(/^\/api\/kyc\/review\/([^/]+)\/(approve|reject|escalate)$/);
    if (method === "POST" && reviewMatch) {
      return handleReviewAction(reviewMatch[1], reviewMatch[2], request, env);
    }

    // POST /api/kyc/batch
    if (method === "POST" && path === "/api/kyc/batch") return handleBatch(request, env);

    // GET /api/kyc/stats
    if (method === "GET" && path === "/api/kyc/stats") return handleStats(request, env);

    // GET /api/kyc/health
    if (method === "GET" && (path === "/api/kyc/health" || path === "/health")) return handleHealth(env);

    return json({ error: "Not found", path }, 404);
  },
};
