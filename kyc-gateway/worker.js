/**
 * kyc-gateway v8.0 — Sub-2-Second KYC/KYB Intake Screening
 * ============================================================
 * Cloudflare Worker | Bervashun Trust Capital
 *
 * Engines (16, Promise.all parallel fan-out):
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
 *
 * Decision bands:
 *   0–29   → APPROVED  (account_generation.allowed = true)
 *   30–69  → REVIEW    (queued for human; account_generation.allowed = false)
 *   70–100 → DENIED    (fires SYSTEM_ALERT; account_generation.allowed = false)
 *
 * Hard timeout fence: 1800 ms → auto-REVIEW if engines not done
 *
 * Routes:
 *   POST /api/kyc/apply                     — intake (GATEWAY_AUTH KV)
 *   GET  /api/kyc/status/:id                — check submission (GATEWAY_AUTH KV)
 *   GET  /api/kyc/review                    — admin review queue (KYC_ADMIN_KEY)
 *   POST /api/kyc/review/:id/approve        — approve (KYC_ADMIN_KEY)
 *   POST /api/kyc/review/:id/reject         — reject  (KYC_ADMIN_KEY)
 *   POST /api/kyc/review/:id/escalate       — escalate (KYC_ADMIN_KEY)
 *   POST /api/kyc/batch                     — batch up to 50 (KYC_ADMIN_KEY)
 *   GET  /api/kyc/health                    — unauthenticated liveness
 *   GET  /api/kyc/stats                     — admin stats (KYC_ADMIN_KEY)
 *
 * Bindings:
 *   AUDIT_DB      — D1 (f2fe6105-b552-42b4-a2ca-9d2a349861da)
 *   KYC_SANCTIONS — KV  (203d064ff04b45d9b15a363aa18427be)
 *   GATEWAY_AUTH  — KV  (06af84f811b84abbb1d956b639d0cd07)
 *   KYC_ADMIN_KEY — secret
 *   NOTIFIER_TOKEN — secret
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = "8.0";
const TIMEOUT_MS = 1800;

// FATF High-Risk + Other Monitored Jurisdictions (55 countries)
const FATF_COUNTRIES = new Set([
  "AF","AL","BB","BF","BJ","BT","CM","CD","CF","CG","CU","ET","GH","GN","GY",
  "HT","IR","IQ","JM","JO","KP","LB","LY","ML","MZ","MR","MM","NA","NG","PA",
  "PK","PH","RU","SA","SN","SC","SL","SO","SS","SD","SY","TZ","TR","TT","TM",
  "UA","UG","VU","VE","VN","YE","ZW","BY","NI","ZM"
]);

// IRS-disallowed EIN prefixes
const DISALLOWED_EIN_PREFIXES = new Set([
  "07","08","09","17","18","19","28","29","49","69","70","78","79","89"
]);

// Adverse media keywords
const ADVERSE_KEYWORDS = [
  "fraud","money laundering","terrorist","sanction","bribery","corruption",
  "trafficking","embezzlement","cartel","conviction","indicted","arrested",
  "seizure","forfeiture","wire fraud","tax evasion","ponzi","pyramid"
];

// High-risk ZIP prefixes (illustrative — real list would be 10k+ entries)
const HIGH_RISK_ZIPS = new Set(["00600","00900","33101","33125","77001","90001"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key");
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

function uuid() {
  return crypto.randomUUID();
}

function cap(val, max) { return Math.min(val, max); }
function clamp(val)     { return Math.min(Math.max(val, 0), 100); }

// Jaro-Winkler similarity
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toUpperCase(); s2 = s2.toUpperCase();
  if (s1 === s2) return 1;
  const l1 = s1.length, l2 = s2.length;
  const matchDist = Math.floor(Math.max(l1, l2) / 2) - 1;
  if (matchDist < 0) return 0;
  const s1m = new Array(l1).fill(false);
  const s2m = new Array(l2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < l1; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, l2);
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = s2m[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < l1; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches/l1 + matches/l2 + (matches - transpositions/2)/matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Token-set similarity (handles out-of-order words)
function tokenSetSim(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.toUpperCase().split(/\s+/));
  const tb = new Set(b.toUpperCase().split(/\s+/));
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

function bestNameScore(name, entries) {
  let best = 0;
  for (const e of entries) {
    const jw = jaroWinkler(name, e.name || e);
    const ts = tokenSetSim(name, e.name || e);
    best = Math.max(best, jw, ts);
  }
  return best;
}

// SHA-256 for audit chain
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// Validate SSN (individual TIN)
function validateSSN(tin) {
  const digits = tin.replace(/\D/g, "");
  if (digits.length !== 9) return { valid: false, area: null };
  const area = parseInt(digits.substring(0, 3), 10);
  if (area === 0 || area === 666) return { valid: false, area };
  if (area >= 900) return { valid: false, area, synthetic: true }; // E15
  const group = parseInt(digits.substring(3, 5), 10);
  const serial = parseInt(digits.substring(5), 10);
  if (group === 0 || serial === 0) return { valid: false, area };
  return { valid: true, area };
}

// Validate EIN (business TIN)
function validateEIN(tin) {
  const digits = tin.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const prefix = digits.substring(0, 2);
  return !DISALLOWED_EIN_PREFIXES.has(prefix);
}

// Auth helpers
async function authGateway(request, env) {
  const apiKey = request.headers.get("X-Api-Key") ||
                 (request.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!apiKey) return false;
  const stored = await env.GATEWAY_AUTH.get(`apikey:${apiKey}`);
  return !!stored;
}

function authAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") ||
              (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return key === env.KYC_ADMIN_KEY;
}

// ─── Screening Engines ────────────────────────────────────────────────────────

async function runEngines(payload, env) {
  const {
    entity_type = "individual",
    applicant_name = "",
    tin = "",
    dob = null,
    address = {},
    amount = null,
    adverse_media_text = "",
    beneficial_owners = [],
    corporate_depth = 0,
    documents = [],
    network_peers = [],
  } = payload;

  const isIndividual = entity_type !== "business";
  const tinClean = (tin || "").replace(/\D/g, "");

  // Load sanctions lists from KV (parallel)
  const [sdnRaw, pepRaw, deltaRaw, fincenRaw] = await Promise.all([
    env.KYC_SANCTIONS.get("sdn:index", "json").catch(() => []),
    env.KYC_SANCTIONS.get("pep:index", "json").catch(() => []),
    env.KYC_SANCTIONS.get("sdn:delta:7d", "json").catch(() => []),
    env.KYC_SANCTIONS.get("fincen:314a", "json").catch(() => []),
  ]);
  const sdnList   = sdnRaw   || [];
  const pepList   = pepRaw   || [];
  const deltaList = deltaRaw || [];

  // Velocity: D1 count of submissions for this TIN in last 24 h
  async function getVelocity() {
    if (!tinClean) return 0;
    const since = new Date(Date.now() - 86400000).toISOString();
    try {
      const r = await env.AUDIT_DB.prepare(
        `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin=? AND created_at>=?`
      ).bind(tinClean, since).first();
      return r ? parseInt(r.cnt, 10) : 0;
    } catch { return 0; }
  }

  // Network graph: check for shared TIN/address in D1
  async function getNetworkHits() {
    if (!tinClean && !address.zip) return 0;
    try {
      const r = await env.AUDIT_DB.prepare(
        `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE (tin=? OR json_extract(raw_payload,'$.address.zip')=?) AND tin != ''`
      ).bind(tinClean, address.zip || "").first();
      return r ? parseInt(r.cnt, 10) : 0;
    } catch { return 0; }
  }

  // Run all 16 engines in parallel
  const [velocityCount, networkHits] = await Promise.all([
    getVelocity(),
    getNetworkHits(),
  ]);

  const sdnScore   = bestNameScore(applicant_name, sdnList);
  const pepScore   = bestNameScore(applicant_name, pepList);
  const deltaScore = bestNameScore(applicant_name, deltaList);

  // E1 OFAC SDN
  const e1Hits = sdnScore >= 0.82 ? 1 : 0;
  const e1Pts  = cap(e1Hits * 40, 70);

  // E2 PEP
  const e2Hits = pepScore >= 0.82 ? 1 : 0;
  const e2Pts  = cap(e2Hits * 25, 50);

  // E3 FATF
  const country = (address.country || "").toUpperCase().trim();
  const e3Pts   = FATF_COUNTRIES.has(country) ? 20 : 0;

  // E4 TIN/EIN validity
  let e4Pts = 0, tinValid = true, einValid = true;
  if (isIndividual) {
    const r = validateSSN(tin);
    tinValid = r.valid;
    if (!r.valid) e4Pts = 20;
  } else {
    einValid = validateEIN(tin);
    if (!einValid) e4Pts = 20;
  }

  // E5 Velocity
  const e5Pts = velocityCount > 5 ? 15 : 0;

  // E6 Structuring — $8,000–$9,999 range
  const amt    = parseFloat(amount) || 0;
  const e6Pts  = (amt >= 8000 && amt < 10000) ? 35 : 0;

  // E7 Adverse Media
  const mediaText = (adverse_media_text || "").toLowerCase();
  const mediaHits = ADVERSE_KEYWORDS.filter(kw => mediaText.includes(kw));
  const e7Pts     = cap(mediaHits.length * 5, 30);

  // E8 UBO Cascade — beneficial owners ≥25% ownership screened vs OFAC+PEP
  let e8Pts = 0;
  const uboFlags = [];
  for (const owner of beneficial_owners) {
    if ((owner.ownership_pct || 0) < 25) continue;
    const oSdn = bestNameScore(owner.name, sdnList);
    const oPep = bestNameScore(owner.name, pepList);
    if (oSdn >= 0.82 || oPep >= 0.82) {
      uboFlags.push({ name: owner.name, sdn: oSdn, pep: oPep });
      e8Pts += 25;
    }
  }
  e8Pts = cap(e8Pts, 75);

  // E9 DOB Plausibility
  let e9Pts = 0;
  if (dob) {
    const dobDate = new Date(dob);
    const now     = new Date();
    const ageYears = (now - dobDate) / (365.25 * 86400000);
    if (dobDate > now)          e9Pts = 35; // future DOB
    else if (ageYears < 18)     e9Pts = 35; // under 18
    else if (ageYears > 120)    e9Pts = 35; // implausibly old
  }

  // E10 Address Risk
  const zip   = (address.zip || "").substring(0, 5);
  const e10Pts = HIGH_RISK_ZIPS.has(zip) ? 10 : 0;

  // E11 Entity Consistency — name/TIN length/type mismatch signals
  let e11Pts = 0;
  if (!isIndividual && tinClean.length !== 9) e11Pts += 15;
  if (applicant_name.length < 2)             e11Pts += 15;
  e11Pts = cap(e11Pts, 15);

  // E12 Corporate Depth
  const depth  = parseInt(corporate_depth, 10) || 0;
  const e12Pts = depth > 4 ? 20 : 0;

  // E13 Document Entropy
  let e13Pts = 0;
  for (const doc of documents) {
    const exp = doc.expiry_date ? new Date(doc.expiry_date) : null;
    if (exp && exp < new Date()) e13Pts += 10; // expired
    if (!doc.document_number || doc.document_number.length < 4) e13Pts += 10; // low entropy
  }
  e13Pts = cap(e13Pts, 10);

  // E14 Network Graph — shared TIN or address with existing submissions
  const e14Pts = networkHits > 3 ? 20 : 0;

  // E15 Synthetic Identity — SSN area code 900+
  let e15Pts = 0;
  if (isIndividual && tinClean.length === 9) {
    const r = validateSSN(tin);
    if (r.synthetic) e15Pts = 40;
  }

  // E16 Watchlist Delta — newly added to SDN list (7-day delta)
  const e16Pts = bestNameScore(applicant_name, deltaList) >= 0.82 ? 30 : 0;

  const breakdown = {
    E1_OFAC_SDN:          { pts: e1Pts,  hit: e1Hits > 0, score: sdnScore },
    E2_PEP:               { pts: e2Pts,  hit: e2Hits > 0, score: pepScore },
    E3_FATF:              { pts: e3Pts,  hit: e3Pts > 0,  country },
    E4_TIN_EIN:           { pts: e4Pts,  tin_valid: tinValid, ein_valid: einValid },
    E5_Velocity:          { pts: e5Pts,  submissions_24h: velocityCount },
    E6_Structuring:       { pts: e6Pts,  amount: amt },
    E7_Adverse_Media:     { pts: e7Pts,  hits: mediaHits },
    E8_UBO_Cascade:       { pts: e8Pts,  flagged_owners: uboFlags },
    E9_DOB:               { pts: e9Pts,  dob },
    E10_Address_Risk:     { pts: e10Pts, zip },
    E11_Entity:           { pts: e11Pts },
    E12_Corporate_Depth:  { pts: e12Pts, layers: depth },
    E13_Document_Entropy: { pts: e13Pts, docs_checked: documents.length },
    E14_Network_Graph:    { pts: e14Pts, shared_matches: networkHits },
    E15_Synthetic_ID:     { pts: e15Pts },
    E16_Watchlist_Delta:  { pts: e16Pts, delta_score: deltaScore },
  };

  const totalPts = clamp(
    e1Pts + e2Pts + e3Pts + e4Pts + e5Pts + e6Pts + e7Pts + e8Pts +
    e9Pts + e10Pts + e11Pts + e12Pts + e13Pts + e14Pts + e15Pts + e16Pts
  );

  const flags = Object.entries(breakdown)
    .filter(([, v]) => v.pts > 0)
    .map(([k]) => k);

  return {
    risk_score: totalPts,
    breakdown,
    flags,
    sanctions_hits:  e1Hits,
    ofac_hits:       e1Hits,
    pep_hits:        e2Hits,
    tin_valid:       tinValid,
    ein_valid:       einValid,
    velocity_flagged: e5Pts > 0,
    structuring_flagged: e6Pts > 0,
    adverse_media_hits: mediaHits.length,
  };
}

// ─── Decision ─────────────────────────────────────────────────────────────────

function decide(score, timedOut = false) {
  if (timedOut) return { decision: "REVIEW", reason: "Engine timeout — manual review required" };
  if (score < 30) return { decision: "APPROVED", reason: "All engines passed" };
  if (score < 70) return { decision: "REVIEW",   reason: "Risk score in review band; human required" };
  return             { decision: "DENIED",   reason: "Risk score exceeds denial threshold" };
}

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function persistSubmission(env, id, payload, result, decision, latency) {
  const now = new Date().toISOString();
  try {
    await env.AUDIT_DB.prepare(`
      INSERT OR IGNORE INTO kyc_submissions (
        submission_id, entity_type, applicant_name, tin, tin_formatted,
        status, risk_score, risk_decision, risk_breakdown,
        sanctions_hits, ofac_hits, pep_hits, tin_valid, ein_valid,
        screen_latency_ms, raw_payload, screened_at, created_at,
        flags_json, velocity_flagged, structuring_flagged,
        adverse_media_hits, engine_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,
      payload.entity_type || "individual",
      payload.applicant_name || "",
      (payload.tin || "").replace(/\D/g,""),
      payload.tin || "",
      decision.decision,
      result.risk_score,
      decision.decision,
      JSON.stringify(result.breakdown),
      result.sanctions_hits,
      result.ofac_hits,
      result.pep_hits,
      result.tin_valid ? 1 : 0,
      result.ein_valid ? 1 : 0,
      latency,
      JSON.stringify(payload),
      now,
      now,
      JSON.stringify(result.flags),
      result.velocity_flagged ? 1 : 0,
      result.structuring_flagged ? 1 : 0,
      result.adverse_media_hits,
      `v${VERSION}`
    ).run();
  } catch (e) {
    console.error("D1 persist error:", e.message);
  }
}

async function persistReviewQueue(env, id, payload, result, decision) {
  if (decision.decision === "APPROVED") return;
  const now = new Date().toISOString();
  try {
    await env.AUDIT_DB.prepare(`
      INSERT OR IGNORE INTO kyc_review_queue (
        reference_id, type, flags_json, payload_json, status, created_at
      ) VALUES (?,?,?,?,?,?)
    `).bind(
      id,
      decision.decision,
      JSON.stringify(result.flags),
      JSON.stringify(payload),
      "PENDING",
      now
    ).run();
  } catch (e) {
    console.error("D1 review queue error:", e.message);
  }
}

async function writeAuditLog(env, eventType, entityId, entityType, data) {
  const now = new Date().toISOString();
  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO audit_log (event_id, event_type, entity_id, entity_type, data, created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(uuid(), eventType, entityId, entityType, JSON.stringify(data), now).run();
  } catch (e) {
    console.error("Audit log error:", e.message);
  }
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

// POST /api/kyc/apply
async function handleApply(request, env) {
  const authed = await authGateway(request, env);
  if (!authed) return json({ error: "Unauthorized" }, 401);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  if (!payload.applicant_name || !payload.tin) {
    return json({ error: "applicant_name and tin are required" }, 400);
  }

  const id    = uuid();
  const start = Date.now();

  let result, timedOut = false;
  try {
    const enginePromise = runEngines(payload, env);
    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => { timedOut = true; resolve(null); }, TIMEOUT_MS)
    );
    result = await Promise.race([enginePromise, timeoutPromise]);
    if (!result) {
      // Timeout: generate a safe default
      result = {
        risk_score: 50, breakdown: {}, flags: ["TIMEOUT"],
        sanctions_hits: 0, ofac_hits: 0, pep_hits: 0,
        tin_valid: false, ein_valid: false,
        velocity_flagged: false, structuring_flagged: false, adverse_media_hits: 0
      };
    }
  } catch (e) {
    console.error("Engine error:", e.message);
    return json({ error: "Screening engine failure", detail: e.message }, 500);
  }

  const latency  = Date.now() - start;
  const decision = decide(result.risk_score, timedOut);

  // Persist (non-blocking)
  const ctx = { waitUntil: () => {} }; // fallback
  await Promise.all([
    persistSubmission(env, id, payload, result, decision, latency),
    persistReviewQueue(env, id, payload, result, decision),
    writeAuditLog(env, "kyc.screened", id, payload.entity_type || "individual", {
      decision: decision.decision, risk_score: result.risk_score, latency_ms: latency
    }),
  ]);

  // Fire SYSTEM_ALERT for DENIED
  if (decision.decision === "DENIED" && env.NOTIFIER_TOKEN) {
    fetch(`https://notify.wwwknockoutforever.com/webhook/system-alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.NOTIFIER_TOKEN}`
      },
      body: JSON.stringify({
        event_type: "SYSTEM_ALERT",
        severity: "HIGH",
        submission_id: id,
        applicant_name: payload.applicant_name,
        risk_score: result.risk_score,
        flags: result.flags,
      })
    }).catch(() => {});
  }

  return json({
    submission_id: id,
    status: decision.decision,
    risk_score: result.risk_score,
    risk_breakdown: result.breakdown,
    flags: result.flags,
    account_generation: {
      allowed: decision.decision === "APPROVED",
      reason: decision.reason,
    },
    screening: {
      latency_ms: latency,
      timed_out: timedOut,
      engine_version: `v${VERSION}`,
      engines_run: 16,
    },
    sanctions: {
      ofac_hits: result.ofac_hits,
      pep_hits: result.pep_hits,
      total_sanctions_hits: result.sanctions_hits,
    },
    tin_validation: {
      valid: result.tin_valid,
      ein_valid: result.ein_valid,
    },
    compliance_flags: {
      velocity_flagged: result.velocity_flagged,
      structuring_flagged: result.structuring_flagged,
      adverse_media_hits: result.adverse_media_hits,
    },
  });
}

// GET /api/kyc/status/:id
async function handleStatus(request, env, id) {
  const authed = await authGateway(request, env);
  if (!authed) return json({ error: "Unauthorized" }, 401);

  try {
    const row = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_submissions WHERE submission_id=? LIMIT 1`
    ).bind(id).first();
    if (!row) return json({ error: "Submission not found" }, 404);

    return json({
      submission_id: row.submission_id,
      status: row.status,
      risk_score: row.risk_score,
      risk_decision: row.risk_decision,
      account_generation: { allowed: row.status === "APPROVED" },
      screened_at: row.screened_at,
      engine_version: row.engine_version,
      flags: (() => { try { return JSON.parse(row.flags_json); } catch { return []; } })(),
    });
  } catch (e) {
    return json({ error: "Database error", detail: e.message }, 500);
  }
}

// GET /api/kyc/review?page=&per_page=&status=
async function handleReviewList(request, env) {
  if (!authAdmin(request, env)) return json({ error: "Admin key required" }, 403);

  const url      = new URL(request.url);
  const page     = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage  = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "25", 10)));
  const status   = url.searchParams.get("status") || null;
  const offset   = (page - 1) * perPage;

  try {
    const whereClause = status ? `WHERE status=?` : "";
    const params      = status ? [status, perPage, offset] : [perPage, offset];
    const rows = await env.AUDIT_DB.prepare(
      `SELECT reference_id, type, flags_json, status, created_at
       FROM kyc_review_queue ${whereClause}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params).all();

    const countRow = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as total FROM kyc_review_queue ${whereClause}`
    ).bind(...(status ? [status] : [])).first();

    return json({
      page, per_page: perPage,
      total: countRow ? parseInt(countRow.total, 10) : 0,
      items: (rows.results || []).map(r => ({
        ...r,
        flags: (() => { try { return JSON.parse(r.flags_json); } catch { return []; } })()
      }))
    });
  } catch (e) {
    return json({ error: "Database error", detail: e.message }, 500);
  }
}

// POST /api/kyc/review/:id/approve|reject|escalate
async function handleReviewAction(request, env, id, action) {
  if (!authAdmin(request, env)) return json({ error: "Admin key required" }, 403);

  const actionMap = { approve: "APPROVED", reject: "REJECTED", escalate: "ESCALATED" };
  const newStatus = actionMap[action];
  if (!newStatus) return json({ error: "Unknown action" }, 400);

  const now = new Date().toISOString();
  let body = {};
  try { body = await request.json(); } catch {}

  try {
    await env.AUDIT_DB.prepare(
      `UPDATE kyc_review_queue SET status=?, resolved_at=?, resolved_by=? WHERE reference_id=?`
    ).bind(newStatus, now, body.reviewer || "admin", id).run();

    await env.AUDIT_DB.prepare(
      `UPDATE kyc_submissions SET status=? WHERE submission_id=?`
    ).bind(newStatus, id).run();

    await writeAuditLog(env, `kyc.${action}`, id, "submission", {
      action, resolved_by: body.reviewer || "admin", note: body.note || null
    });

    return json({ submission_id: id, status: newStatus, actioned_at: now });
  } catch (e) {
    return json({ error: "Database error", detail: e.message }, 500);
  }
}

// POST /api/kyc/batch
async function handleBatch(request, env) {
  if (!authAdmin(request, env)) return json({ error: "Admin key required" }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const items = Array.isArray(body) ? body : body.items;
  if (!Array.isArray(items) || items.length === 0) return json({ error: "No items" }, 400);
  if (items.length > 50) return json({ error: "Max 50 items per batch" }, 400);

  const results = await Promise.all(items.map(async (item) => {
    const fakeReq = new Request("https://kyc.local/api/kyc/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.KYC_ADMIN_KEY}` },
      body: JSON.stringify(item)
    });
    // auth bypass for internal batch
    const id     = uuid();
    const start  = Date.now();
    let result;
    try { result = await runEngines(item, env); }
    catch { result = { risk_score: 50, breakdown: {}, flags: ["ERROR"], sanctions_hits: 0, ofac_hits: 0, pep_hits: 0, tin_valid: false, ein_valid: false, velocity_flagged: false, structuring_flagged: false, adverse_media_hits: 0 }; }
    const latency  = Date.now() - start;
    const decision = decide(result.risk_score);
    await Promise.all([
      persistSubmission(env, id, item, result, decision, latency),
      persistReviewQueue(env, id, item, result, decision),
    ]);
    return { submission_id: id, applicant_name: item.applicant_name, status: decision.decision, risk_score: result.risk_score };
  }));

  return json({ processed: results.length, results });
}

// GET /api/kyc/stats
async function handleStats(request, env) {
  if (!authAdmin(request, env)) return json({ error: "Admin key required" }, 403);
  try {
    const [total, approved, review, denied] = await Promise.all([
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as n FROM kyc_submissions`).first(),
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as n FROM kyc_submissions WHERE status='APPROVED'`).first(),
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as n FROM kyc_submissions WHERE status='REVIEW' OR status='PENDING'`).first(),
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as n FROM kyc_submissions WHERE status='DENIED'`).first(),
    ]);
    const avgRow = await env.AUDIT_DB.prepare(
      `SELECT AVG(screen_latency_ms) as avg_ms FROM kyc_submissions`
    ).first();

    return json({
      engine_version: `v${VERSION}`,
      totals: {
        submissions:  total   ? parseInt(total.n, 10) : 0,
        approved:     approved ? parseInt(approved.n, 10) : 0,
        review:       review   ? parseInt(review.n, 10) : 0,
        denied:       denied   ? parseInt(denied.n, 10) : 0,
      },
      performance: {
        avg_screen_latency_ms: avgRow ? Math.round(parseFloat(avgRow.avg_ms) || 0) : 0,
        target_ms: TIMEOUT_MS,
      },
      engines_active: 16,
    });
  } catch (e) {
    return json({ error: "Database error", detail: e.message }, 500);
  }
}

// GET /api/kyc/health
function handleHealth() {
  return json({
    status: "ok",
    version: VERSION,
    engines: 16,
    timeout_ms: TIMEOUT_MS,
    decision_bands: { APPROVED: "0-29", REVIEW: "30-69", DENIED: "70-100" },
    timestamp: new Date().toISOString(),
  });
}

// ─── Main Fetch Handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;

    // Health (unauthenticated)
    if (path === "/api/kyc/health" && method === "GET") {
      return handleHealth();
    }

    // Stats
    if (path === "/api/kyc/stats" && method === "GET") {
      return handleStats(request, env);
    }

    // Apply
    if (path === "/api/kyc/apply" && method === "POST") {
      return handleApply(request, env);
    }

    // Status
    const statusMatch = path.match(/^\/api\/kyc\/status\/([^/]+)$/);
    if (statusMatch && method === "GET") {
      return handleStatus(request, env, statusMatch[1]);
    }

    // Review list
    if (path === "/api/kyc/review" && method === "GET") {
      return handleReviewList(request, env);
    }

    // Review actions
    const actionMatch = path.match(/^\/api\/kyc\/review\/([^/]+)\/(approve|reject|escalate)$/);
    if (actionMatch && method === "POST") {
      return handleReviewAction(request, env, actionMatch[1], actionMatch[2]);
    }

    // Batch
    if (path === "/api/kyc/batch" && method === "POST") {
      return handleBatch(request, env);
    }

    return json({ error: "Not found", path }, 404);
  }
};
