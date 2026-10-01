// ============================================================
//  KYC-Gateway v11.0 — Bervashun Trust Capital
//  Cloudflare Worker  |  ES Module  |  No external deps
// ============================================================

/* ─── CONSTANTS ──────────────────────────────────────────── */

const ENGINE_VERSION = "v11.0";
const SCREEN_TIMEOUT_MS = 1750;

const FATF_HIGH_RISK = new Set([
  "AF","AL","AO","BB","BF","BI","BJ","BT","CF","CM","CG","CD","CI","CU",
  "DZ","ER","ET","GH","GN","GW","HT","IR","IQ","JM","JO","KE","KH","KP",
  "LA","LB","LR","LY","ML","MM","MR","MZ","NE","NG","NI","PA","PH","PK",
  "RU","SD","SL","SO","SS","SY","TJ","TN","TT","UG","VU","YE","ZW","VE"
]);

const ADVERSE_KEYWORDS = [
  "fraud","laundering","trafficking","cartel","terrorism","corruption",
  "bribery","sanctions","embezzlement","extortion","forgery","counterfeiting",
  "ransomware","cybercrime","narcotics","ponzi","smuggling","terrorist",
  "felony","indictment"
];

const EIN_DISALLOWED_PREFIXES = new Set([
  "07","08","09","17","18","19","28","29","49","69","70","78","79","89","96","97"
]);

const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|trust)\b\.?/gi;

/* ─── UTILITIES ──────────────────────────────────────────── */

function normalName(s) {
  if (!s) return "";
  return s.replace(SUFFIX_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function jaroWinkler(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const matchDist = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aMatched = new Uint8Array(la);
  const bMatched = new Uint8Array(lb);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(lb - 1, i + matchDist);
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = 1; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
  const pfxLen = Math.min(4, [...a].findIndex((c, i) => c !== b[i]) >>> 0);
  return jaro + pfxLen * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const inter = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : inter / union;
}

function fuzzyMatch(name, list) {
  const n = normalName(name);
  const hits = [];
  for (const entry of list) {
    const e = normalName(typeof entry === "string" ? entry : entry.name || "");
    const jw = jaroWinkler(n, e);
    const ts = tokenSetSimilarity(n, e);
    if (jw >= 0.82 || ts >= 0.80) {
      hits.push({ entry: typeof entry === "string" ? entry : entry.name, jw: +jw.toFixed(4), ts: +ts.toFixed(4) });
    }
  }
  return hits;
}

function stripTin(tin) {
  return (tin || "").replace(/\D/g, "");
}

function formatTin(tin, entityType) {
  const d = stripTin(tin);
  if (entityType === "business" && d.length === 9) return `${d.slice(0,2)}-${d.slice(2)}`;
  if (entityType === "individual" && d.length === 9) return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
  return d;
}

function isValidSSN(tin) {
  const d = stripTin(tin);
  if (d.length !== 9) return false;
  const area = +d.slice(0, 3);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (d.slice(3, 5) === "00") return false;
  if (d.slice(5) === "0000") return false;
  return true;
}

function isValidEIN(tin) {
  const d = stripTin(tin);
  if (d.length !== 9) return false;
  const prefix = d.slice(0, 2);
  if (EIN_DISALLOWED_PREFIXES.has(prefix)) return false;
  return true;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function uuid() { return crypto.randomUUID(); }

function nowISO() { return new Date().toISOString(); }

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Submission-Id",
  };
}

function jsonResp(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra }
  });
}

function errResp(msg, status, cors = {}) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}

async function parseKVList(kv, key) {
  try {
    const raw = await kv.get(key, { type: "json" });
    if (Array.isArray(raw)) return raw;
    return [];
  } catch { return []; }
}

/* ─── AUTH ───────────────────────────────────────────────── */

async function verifyGatewayAuth(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  const val = await env.GATEWAY_AUTH.get(`apikey:${token}`);
  return val !== null;
}

function verifyAdminKey(req, env) {
  const authHeader = req.headers.get("Authorization") || "";
  const adminHeader = req.headers.get("X-Admin-Key") || "";
  const fromBearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return fromBearer === env.KYC_ADMIN_KEY || adminHeader === env.KYC_ADMIN_KEY;
}

/* ─── 18 SCREENING ENGINES ───────────────────────────────── */

async function engineE1_OFAC(payload, env) {
  const list = await parseKVList(env.KYC_SANCTIONS, "sdn:index");
  const names = [payload.applicant_name, payload.business_name].filter(Boolean);
  let score = 0; const flags = []; const detail = [];
  for (const name of names) {
    const hits = fuzzyMatch(name, list);
    if (hits.length) {
      score = Math.min(score + 40 * hits.length, 70);
      flags.push("E1_OFAC_HIT");
      detail.push(...hits.map(h => ({ name, match: h.entry, jw: h.jw, ts: h.ts })));
    }
  }
  return { engine: "E1_OFAC_SDN", score, flags, detail };
}

async function engineE2_PEP(payload, env) {
  const list = await parseKVList(env.KYC_SANCTIONS, "pep:index");
  const names = [payload.applicant_name, payload.business_name].filter(Boolean);
  let score = 0; const flags = []; const detail = [];
  for (const name of names) {
    const hits = fuzzyMatch(name, list);
    if (hits.length) {
      score = Math.min(score + 25 * hits.length, 50);
      flags.push("E2_PEP_HIT");
      detail.push(...hits.map(h => ({ name, match: h.entry, jw: h.jw, ts: h.ts })));
    }
  }
  return { engine: "E2_PEP", score, flags, detail };
}

function engineE3_FATF(payload) {
  const countries = [payload.country_of_residence, payload.nationality,
    ...(payload.beneficial_owners || []).map(b => b.nationality)].filter(Boolean);
  const hits = countries.filter(c => FATF_HIGH_RISK.has(c.toUpperCase()));
  const score = hits.length ? 20 : 0;
  return {
    engine: "E3_FATF_HIGH_RISK",
    score,
    flags: hits.length ? ["E3_FATF_HIGH_RISK"] : [],
    detail: hits
  };
}

function engineE4_TIN(payload) {
  const tin = stripTin(payload.tin || "");
  const entityType = payload.entity_type;
  let score = 0; const flags = []; const detail = [];
  let tinValid = false, einValid = false;
  if (entityType === "individual") {
    tinValid = isValidSSN(tin);
    if (!tinValid) { score = 20; flags.push("E4_INVALID_SSN"); detail.push({ tin, reason: "SSN failed validation" }); }
  } else if (entityType === "business") {
    einValid = isValidEIN(tin);
    if (!einValid) { score = 20; flags.push("E4_INVALID_EIN"); detail.push({ tin, reason: "EIN failed validation" }); }
  } else {
    score = 20; flags.push("E4_UNKNOWN_ENTITY_TYPE"); detail.push({ tin, reason: "Unknown entity type" });
  }
  return { engine: "E4_TIN_EIN", score, flags, detail, tinValid, einValid };
}

async function engineE5_Velocity(payload, env) {
  const tin = stripTin(payload.tin || "");
  if (!tin) return { engine: "E5_VELOCITY", score: 0, flags: [], detail: [] };
  try {
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const res = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin=? AND created_at>=?`
    ).bind(tin, cutoff).first();
    const cnt = res?.cnt ?? 0;
    const flagged = cnt > 5;
    return {
      engine: "E5_VELOCITY",
      score: flagged ? 15 : 0,
      flags: flagged ? ["E5_VELOCITY_FLAGGED"] : [],
      detail: { tin, count_24h: cnt }
    };
  } catch (e) {
    return { engine: "E5_VELOCITY", score: 0, flags: [], detail: { error: e.message } };
  }
}

function engineE6_Structuring(payload) {
  const amounts = [payload.payment_amount, payload.requested_amount].filter(v => typeof v === "number");
  const hits = amounts.filter(a => a >= 8000 && a <= 9999);
  return {
    engine: "E6_STRUCTURING",
    score: hits.length ? 35 : 0,
    flags: hits.length ? ["E6_STRUCTURING"] : [],
    detail: { amounts_flagged: hits }
  };
}

function engineE7_AdverseMedia(payload) {
  const text = [payload.applicant_name, payload.business_name,
    ...(payload.adverse_media_terms || [])].filter(Boolean).join(" ").toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(k => text.includes(k));
  const score = Math.min(hits.length * 5, 30);
  return {
    engine: "E7_ADVERSE_MEDIA",
    score,
    flags: hits.length ? ["E7_ADVERSE_MEDIA"] : [],
    detail: { keywords_matched: hits }
  };
}

async function engineE8_UBO(payload, env) {
  const owners = (payload.beneficial_owners || []).filter(b => (b.ownership_pct || 0) >= 25);
  if (!owners.length) return { engine: "E8_UBO_CASCADE", score: 0, flags: [], detail: [], uboResults: [] };
  const [sdnList, pepList] = await Promise.all([
    parseKVList(env.KYC_SANCTIONS, "sdn:index"),
    parseKVList(env.KYC_SANCTIONS, "pep:index")
  ]);
  const uboResults = [];
  let score = 0; const flags = [];
  for (const owner of owners) {
    const sdnHits = fuzzyMatch(owner.name, sdnList);
    const pepHits = fuzzyMatch(owner.name, pepList);
    const ownerFlagged = sdnHits.length > 0 || pepHits.length > 0;
    if (ownerFlagged) {
      score = Math.min(score + 25, 100);
      flags.push("E8_UBO_FLAGGED");
    }
    uboResults.push({
      name: owner.name,
      ownership_pct: owner.ownership_pct,
      tin: owner.tin,
      nationality: owner.nationality,
      sanctionsScore: Math.min(sdnHits.length * 40, 70),
      pepFlag: pepHits.length > 0 ? 1 : 0,
      ofacHit: sdnHits.length > 0 ? 1 : 0,
      isFlagged: ownerFlagged ? 1 : 0,
      matchReason: [
        sdnHits.length ? `OFAC:${sdnHits[0].match}` : null,
        pepHits.length ? `PEP:${pepHits[0].match}` : null
      ].filter(Boolean).join(", ")
    });
  }
  return { engine: "E8_UBO_CASCADE", score, flags, detail: uboResults, uboResults };
}

function engineE9_DOB(payload) {
  if (!payload.dob || payload.entity_type !== "individual") {
    return { engine: "E9_DOB_PLAUSIBILITY", score: 0, flags: [], detail: {} };
  }
  const dob = new Date(payload.dob);
  const now = new Date();
  if (isNaN(dob.getTime())) {
    return { engine: "E9_DOB_PLAUSIBILITY", score: 35, flags: ["E9_INVALID_DOB"], detail: { reason: "unparseable" } };
  }
  const ageMs = now - dob;
  const ageYears = ageMs / (365.25 * 86400 * 1000);
  let reason = null;
  if (dob > now) reason = "DOB in the future";
  else if (ageYears < 18) reason = "Under 18";
  else if (ageYears > 120) reason = "Over 120 years old";
  return {
    engine: "E9_DOB_PLAUSIBILITY",
    score: reason ? 35 : 0,
    flags: reason ? ["E9_DOB_IMPLAUSIBLE"] : [],
    detail: { dob: payload.dob, ageYears: +ageYears.toFixed(2), reason }
  };
}

function engineE10_Address(payload) {
  const addr = payload.address || {};
  const street = (addr.street || "").toUpperCase();
  const poBox = /\bP\.?\s*O\.?\s*BOX\b/i.test(street);
  const incomplete = !addr.city || !addr.state || !addr.zip;
  const flagged = poBox || incomplete;
  return {
    engine: "E10_ADDRESS_RISK",
    score: flagged ? 10 : 0,
    flags: flagged ? ["E10_ADDRESS_RISK"] : [],
    detail: { po_box: poBox, incomplete }
  };
}

function engineE11_EntityConsistency(payload) {
  const tin = stripTin(payload.tin || "");
  const flags = [];
  let reason = null;
  if (payload.entity_type === "individual" && isValidEIN(tin) && !isValidSSN(tin)) {
    flags.push("E11_ENTITY_MISMATCH");
    reason = "Individual entity but EIN-format TIN provided";
  } else if (payload.entity_type === "business" && isValidSSN(tin) && !isValidEIN(tin)) {
    flags.push("E11_ENTITY_MISMATCH");
    reason = "Business entity but SSN-format TIN provided";
  }
  return { engine: "E11_ENTITY_CONSISTENCY", score: flags.length ? 15 : 0, flags, detail: { reason } };
}

function engineE12_CorporateDepth(payload) {
  const layers = payload.num_corporate_layers ?? 0;
  const flagged = layers > 4;
  return {
    engine: "E12_CORPORATE_DEPTH",
    score: flagged ? 20 : 0,
    flags: flagged ? ["E12_DEEP_CORPORATE_STRUCTURE"] : [],
    detail: { num_corporate_layers: layers }
  };
}

function engineE13_DocumentEntropy(payload) {
  const flags = [];
  const detail = {};
  if (!payload.doc_type) { flags.push("E13_DOC_TYPE_MISSING"); detail.missing_type = true; }
  if (payload.doc_expiry_date) {
    const exp = new Date(payload.doc_expiry_date);
    const now = new Date();
    if (!isNaN(exp.getTime()) && exp < now) {
      flags.push("E13_DOC_EXPIRED");
      detail.expired = true;
      detail.expiry = payload.doc_expiry_date;
    }
  } else {
    flags.push("E13_DOC_EXPIRY_MISSING");
    detail.missing_expiry = true;
  }
  return { engine: "E13_DOCUMENT_ENTROPY", score: flags.length ? 10 : 0, flags, detail };
}

async function engineE14_NetworkGraph(payload, env) {
  const tin = stripTin(payload.tin || "");
  const street = (payload.address || {}).street || "";
  const flags = []; const detail = {};
  try {
    if (tin) {
      const res = await env.AUDIT_DB.prepare(
        `SELECT COUNT(DISTINCT applicant_name) as cnt FROM kyc_submissions WHERE tin=? AND applicant_name!=?`
      ).bind(tin, payload.applicant_name || "").first();
      if ((res?.cnt ?? 0) > 0) {
        flags.push("E14_TIN_NAME_CONFLICT");
        detail.tin_shared_by_different_names = res.cnt;
      }
    }
    if (street) {
      const res2 = await env.AUDIT_DB.prepare(
        `SELECT COUNT(DISTINCT submission_id) as cnt FROM kyc_submissions WHERE raw_payload LIKE ?`
      ).bind(`%"street":"${street}"%`).first();
      if ((res2?.cnt ?? 0) >= 3) {
        flags.push("E14_ADDRESS_SHARED");
        detail.address_submission_count = res2.cnt;
      }
    }
  } catch (e) { detail.error = e.message; }
  return { engine: "E14_NETWORK_GRAPH", score: flags.length ? 20 : 0, flags, detail };
}

function engineE15_SyntheticIdentity(payload) {
  if (payload.entity_type !== "individual") return { engine: "E15_SYNTHETIC_IDENTITY", score: 0, flags: [], detail: {} };
  const tin = stripTin(payload.tin || "");
  const area = parseInt(tin.slice(0, 3), 10);
  const flagged = area >= 900;
  return {
    engine: "E15_SYNTHETIC_IDENTITY",
    score: flagged ? 40 : 0,
    flags: flagged ? ["E15_SYNTHETIC_SSN"] : [],
    detail: { ssn_area: area }
  };
}

async function engineE16_WatchlistDelta(payload, env) {
  const tin = stripTin(payload.tin || "");
  const name = normalName(payload.applicant_name || payload.business_name || "");
  let flags = []; const detail = {};
  try {
    const delta = await parseKVList(env.KYC_SANCTIONS, "sdn:delta:7d");
    const tinHit = delta.some(e => (typeof e === "object" ? e.tin : "") === tin);
    const nameHits = fuzzyMatch(name, delta.map(e => typeof e === "object" ? e.name || "" : e));
    if (tinHit) { flags.push("E16_DELTA_TIN_HIT"); detail.tin_in_delta = true; }
    if (nameHits.length) { flags.push("E16_DELTA_NAME_HIT"); detail.name_match = nameHits[0]; }
  } catch (e) { detail.error = e.message; }
  return { engine: "E16_WATCHLIST_DELTA", score: flags.length ? 30 : 0, flags, detail };
}

async function engineE17_FinCEN(payload, env) {
  const list = await parseKVList(env.KYC_SANCTIONS, "fincen:314a");
  const names = [payload.applicant_name, payload.business_name].filter(Boolean);
  let score = 0; const flags = []; const detail = [];
  for (const name of names) {
    const hits = fuzzyMatch(name, list);
    if (hits.length) {
      score = Math.min(score + 25, 50);
      flags.push("E17_FINCEN_314A");
      detail.push(...hits.map(h => ({ name, match: h.entry, jw: h.jw, ts: h.ts })));
    }
  }
  return { engine: "E17_FINCEN_314A", score, flags, detail };
}

async function engineE18_GeoVelocity(payload, env) {
  const tin = stripTin(payload.tin || "");
  const ip = payload.ip_address || "";
  if (!tin || !ip) return { engine: "E18_GEO_VELOCITY", score: 0, flags: [], detail: { reason: "no TIN or IP" } };
  try {
    const cutoff = new Date(Date.now() - 3600000).toISOString();
    const res = await env.AUDIT_DB.prepare(
      `SELECT COUNT(DISTINCT raw_payload) as cnt FROM kyc_submissions WHERE tin=? AND created_at>=? AND raw_payload NOT LIKE ?`
    ).bind(tin, cutoff, `%"ip_address":"${ip}"%`).first();
    const flagged = (res?.cnt ?? 0) > 0;
    return {
      engine: "E18_GEO_VELOCITY",
      score: flagged ? 20 : 0,
      flags: flagged ? ["E18_GEO_VELOCITY_FLAGGED"] : [],
      detail: { tin, ip, different_ip_count_1h: res?.cnt ?? 0 }
    };
  } catch (e) {
    return { engine: "E18_GEO_VELOCITY", score: 0, flags: [], detail: { error: e.message } };
  }
}

/* ─── SCREENING ORCHESTRATOR ─────────────────────────────── */

async function runScreening(payload, env) {
  const t0 = Date.now();

  const enginePromises = [
    engineE1_OFAC(payload, env),
    engineE2_PEP(payload, env),
    Promise.resolve(engineE3_FATF(payload)),
    Promise.resolve(engineE4_TIN(payload)),
    engineE5_Velocity(payload, env),
    Promise.resolve(engineE6_Structuring(payload)),
    Promise.resolve(engineE7_AdverseMedia(payload)),
    engineE8_UBO(payload, env),
    Promise.resolve(engineE9_DOB(payload)),
    Promise.resolve(engineE10_Address(payload)),
    Promise.resolve(engineE11_EntityConsistency(payload)),
    Promise.resolve(engineE12_CorporateDepth(payload)),
    Promise.resolve(engineE13_DocumentEntropy(payload)),
    engineE14_NetworkGraph(payload, env),
    Promise.resolve(engineE15_SyntheticIdentity(payload)),
    engineE16_WatchlistDelta(payload, env),
    engineE17_FinCEN(payload, env),
    engineE18_GeoVelocity(payload, env),
  ];

  let timedOut = false;
  let settled;

  const race = Promise.race([
    Promise.allSettled(enginePromises),
    sleep(SCREEN_TIMEOUT_MS).then(() => { timedOut = true; return null; })
  ]);

  settled = await race;

  const latency = Date.now() - t0;

  if (timedOut || !settled) {
    return {
      results: [],
      score: 35,
      flags: ["TIMEOUT_AUTO_REVIEW"],
      risk_decision: "REVIEW",
      timedOut: true,
      completed: 0,
      latency
    };
  }

  const results = settled.map(r => r.status === "fulfilled" ? r.value : {
    engine: "UNKNOWN", score: 0, flags: [], detail: { error: r.reason?.message }
  });

  const e4 = results[3] || {};
  const e8 = results[7] || {};

  let totalScore = results.reduce((acc, r) => acc + (r.score || 0), 0);
  totalScore = Math.min(totalScore, 100);

  const flags = results.flatMap(r => r.flags || []);
  const velocityFlagged = flags.includes("E5_VELOCITY_FLAGGED") ? 1 : 0;
  const structuringFlagged = flags.includes("E6_STRUCTURING") ? 1 : 0;
  const adverseMediaHits = results[6]?.detail?.keywords_matched?.length || 0;
  const ofacHitsArr = results[0]?.detail || [];
  const pepHitsArr = results[1]?.detail || [];

  let risk_decision;
  if (totalScore >= 70) risk_decision = "DENIED";
  else if (totalScore >= 30) risk_decision = "REVIEW";
  else risk_decision = "APPROVED";

  return {
    results,
    score: totalScore,
    flags,
    risk_decision,
    timedOut: false,
    completed: results.length,
    latency,
    tinValid: e4.tinValid || false,
    einValid: e4.einValid || false,
    ofacHits: ofacHitsArr.length,
    pepHits: pepHitsArr.length,
    sanctionsHits: ofacHitsArr.length + pepHitsArr.length,
    uboResults: e8.uboResults || [],
    velocityFlagged,
    structuringFlagged,
    adverseMediaHits,
    ofacHitsJson: JSON.stringify(ofacHitsArr),
    pepHitsJson: JSON.stringify(pepHitsArr),
    riskBreakdown: JSON.stringify(results.map(r => ({ engine: r.engine, score: r.score, flags: r.flags })))
  };
}

/* ─── D1 PERSISTENCE ─────────────────────────────────────── */

async function persistSubmission(env, submissionId, payload, screening, ctx) {
  const tin = stripTin(payload.tin || "");
  const now = nowISO();

  const insertSubmission = env.AUDIT_DB.prepare(`
    INSERT INTO kyc_submissions
      (submission_id,entity_type,applicant_name,tin,tin_formatted,status,risk_score,
       risk_decision,risk_breakdown,sanctions_hits,ofac_hits,pep_hits,tin_valid,ein_valid,
       screen_latency_ms,raw_payload,screened_at,flags_json,pep_hits_json,ofac_hits_json,
       velocity_flagged,structuring_flagged,adverse_media_hits,engine_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    submissionId,
    payload.entity_type || "",
    payload.applicant_name || payload.business_name || "",
    tin,
    formatTin(tin, payload.entity_type),
    "screened",
    screening.score,
    screening.risk_decision,
    screening.riskBreakdown || "[]",
    screening.sanctionsHits || 0,
    screening.ofacHits || 0,
    screening.pepHits || 0,
    screening.tinValid ? 1 : 0,
    screening.einValid ? 1 : 0,
    screening.latency,
    JSON.stringify(payload),
    now,
    JSON.stringify(screening.flags || []),
    screening.pepHitsJson || "[]",
    screening.ofacHitsJson || "[]",
    screening.velocityFlagged || 0,
    screening.structuringFlagged || 0,
    screening.adverseMediaHits || 0,
    ENGINE_VERSION
  );

  const insertAudit = env.AUDIT_DB.prepare(`
    INSERT INTO audit_log (event_id,event_type,entity_id,entity_type,payload,created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    uuid(),
    "kyc.screened",
    submissionId,
    payload.entity_type || "",
    JSON.stringify({ score: screening.score, decision: screening.risk_decision, flags: screening.flags }),
    now
  );

  const stmts = [insertSubmission, insertAudit];

  if (screening.risk_decision === "REVIEW" || screening.timedOut) {
    const insertReview = env.AUDIT_DB.prepare(`
      INSERT INTO kyc_review_queue
        (submission_id,reference_id,type,flags_json,payload_json,status,risk_score,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(
      submissionId,
      submissionId,
      payload.entity_type === "business" ? "KYB" : "KYC",
      JSON.stringify(screening.flags || []),
      JSON.stringify(payload),
      "pending",
      screening.score,
      now
    );
    stmts.push(insertReview);
  }

  for (const ubo of (screening.uboResults || [])) {
    stmts.push(env.AUDIT_DB.prepare(`
      INSERT INTO kyc_beneficial_owners
        (submission_id,owner_name,ownership_pct,tin,nationality,sanctions_score,
         pep_flag,ofac_hit,is_flagged,match_reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      submissionId,
      ubo.name || "",
      ubo.ownership_pct || 0,
      ubo.tin || "",
      ubo.nationality || "",
      ubo.sanctionsScore || 0,
      ubo.pepFlag || 0,
      ubo.ofacHit || 0,
      ubo.isFlagged || 0,
      ubo.matchReason || "",
      now
    ));
  }

  ctx.waitUntil(env.AUDIT_DB.batch(stmts).catch(() => {}));
}

async function fireSystemAlert(submissionId, screening, env) {
  try {
    await fetch("https://notify.wwwknockoutforever.com/webhook/system-alert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.NOTIFIER_TOKEN}`
      },
      body: JSON.stringify({
        event: "SYSTEM_ALERT",
        submission_id: submissionId,
        risk_decision: "DENIED",
        risk_score: screening.score,
        flags: screening.flags,
        timestamp: nowISO()
      })
    });
  } catch (_) {}
}

/* ─── ROUTE HANDLERS ─────────────────────────────────────── */

async function handleApply(req, env, ctx, cors) {
  let payload;
  try { payload = await req.json(); }
  catch { return errResp("Invalid JSON body", 400, cors); }

  if (!payload.entity_type || !["individual", "business"].includes(payload.entity_type)) {
    return errResp("entity_type must be 'individual' or 'business'", 422, cors);
  }

  const submissionId = `kyc_${uuid()}`;
  const screening = await runScreening(payload, env);

  await persistSubmission(env, submissionId, payload, screening, ctx);

  if (screening.risk_decision === "DENIED") {
    ctx.waitUntil(fireSystemAlert(submissionId, screening, env));
  }

  let agReason;
  if (screening.risk_decision === "APPROVED") agReason = "All screening checks passed";
  else if (screening.risk_decision === "REVIEW") agReason = "Risk score requires human review";
  else agReason = "Application denied based on risk screening";

  return new Response(JSON.stringify({
    submission_id: submissionId,
    status: "screened",
    risk_decision: screening.risk_decision,
    risk_score: screening.score,
    account_generation: {
      allowed: screening.risk_decision === "APPROVED",
      reason: agReason
    },
    flags: screening.flags,
    engines: {
      count: 18,
      completed: screening.timedOut ? 0 : screening.completed,
      timed_out: screening.timedOut
    },
    screen_latency_ms: screening.latency,
    review_queued: screening.risk_decision === "REVIEW",
    timestamp: nowISO()
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Submission-Id": submissionId,
      ...cors
    }
  });
}

async function handleStatus(submissionId, env, cors) {
  try {
    const row = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_submissions WHERE submission_id=?`
    ).bind(submissionId).first();
    if (!row) return errResp("Submission not found", 404, cors);
    return jsonResp(row, 200, cors);
  } catch (e) {
    return errResp(e.message, 500, cors);
  }
}

async function handleReviewQueue(req, env, cors) {
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "20", 10)));
  const status = url.searchParams.get("status") || "pending";
  const offset = (page - 1) * perPage;
  try {
    const rows = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_review_queue WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(status, perPage, offset).all();
    const countRow = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as total FROM kyc_review_queue WHERE status=?`
    ).bind(status).first();
    return jsonResp({
      data: rows.results || [],
      page,
      per_page: perPage,
      total: countRow?.total ?? 0,
      status_filter: status
    }, 200, cors);
  } catch (e) {
    return errResp(e.message, 500, cors);
  }
}

async function handleReviewAction(reviewId, action, req, env, cors) {
  let body = {};
  try { body = await req.json(); } catch {}
  const now = nowISO();
  const statusMap = { approve: "approved", reject: "rejected", escalate: "escalated" };
  const newStatus = statusMap[action];
  if (!newStatus) return errResp("Unknown action", 400, cors);

  try {
    const existing = await env.AUDIT_DB.prepare(
      `SELECT * FROM kyc_review_queue WHERE submission_id=?`
    ).bind(reviewId).first();
    if (!existing) return errResp("Review item not found", 404, cors);

    await env.AUDIT_DB.prepare(
      `UPDATE kyc_review_queue SET status=?,resolved_by=?,resolved_at=?,escalation_reason=? WHERE submission_id=?`
    ).bind(newStatus, body.resolved_by || "admin", now, body.reason || null, reviewId).run();

    if (action === "approve" || action === "reject") {
      await env.AUDIT_DB.prepare(
        `UPDATE kyc_submissions SET status=?,risk_decision=? WHERE submission_id=?`
      ).bind(newStatus, action === "approve" ? "APPROVED" : "DENIED", reviewId).run();
    }

    return jsonResp({ submission_id: reviewId, action, status: newStatus, resolved_at: now }, 200, cors);
  } catch (e) {
    return errResp(e.message, 500, cors);
  }
}

async function handleBatch(req, env, ctx, cors) {
  let body;
  try { body = await req.json(); } catch { return errResp("Invalid JSON", 400, cors); }
  const items = Array.isArray(body) ? body : body.submissions || [];
  if (!items.length || items.length > 50) return errResp("Batch must contain 1–50 submissions", 422, cors);

  const results = await Promise.allSettled(items.map(async (payload) => {
    if (!payload.entity_type) throw new Error("Missing entity_type");
    const submissionId = `kyc_${uuid()}`;
    const screening = await runScreening(payload, env);
    await persistSubmission(env, submissionId, payload, screening, ctx);
    if (screening.risk_decision === "DENIED") ctx.waitUntil(fireSystemAlert(submissionId, screening, env));
    return { submission_id: submissionId, risk_decision: screening.risk_decision, risk_score: screening.score, flags: screening.flags };
  }));

  return jsonResp({
    processed: results.length,
    results: results.map((r, i) => r.status === "fulfilled" ? r.value : { index: i, error: r.reason?.message })
  }, 200, cors);
}

async function handleStats(env, cors) {
  try {
    const [total, byDecision, avgScore] = await Promise.all([
      env.AUDIT_DB.prepare(`SELECT COUNT(*) as total FROM kyc_submissions`).first(),
      env.AUDIT_DB.prepare(`SELECT risk_decision, COUNT(*) as cnt FROM kyc_submissions GROUP BY risk_decision`).all(),
      env.AUDIT_DB.prepare(`SELECT AVG(risk_score) as avg_score, AVG(screen_latency_ms) as avg_latency FROM kyc_submissions`).first()
    ]);
    const decisions = {};
    for (const row of (byDecision.results || [])) decisions[row.risk_decision || "UNKNOWN"] = row.cnt;
    return jsonResp({
      total_submissions: total?.total ?? 0,
      decisions,
      avg_risk_score: +(avgScore?.avg_score || 0).toFixed(2),
      avg_latency_ms: +(avgScore?.avg_latency || 0).toFixed(2),
      engine_version: ENGINE_VERSION
    }, 200, cors);
  } catch (e) {
    return errResp(e.message, 500, cors);
  }
}

/* ─── MAIN FETCH HANDLER ─────────────────────────────────── */

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);

    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: cors });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Health check (unauthenticated)
    if (path === "/api/kyc/health" && method === "GET") {
      return jsonResp({
        status: "ok",
        version: ENGINE_VERSION,
        timestamp: nowISO(),
        service: "kyc-gateway"
      }, 200, cors);
    }

    // POST /api/kyc/apply
    if (path === "/api/kyc/apply" && method === "POST") {
      if (!(await verifyGatewayAuth(req, env))) return errResp("Unauthorized", 401, cors);
      return handleApply(req, env, ctx, cors);
    }

    // GET /api/kyc/status/:id
    const statusMatch = path.match(/^\/api\/kyc\/status\/(.+)$/);
    if (statusMatch && method === "GET") {
      if (!(await verifyGatewayAuth(req, env))) return errResp("Unauthorized", 401, cors);
      return handleStatus(statusMatch[1], env, cors);
    }

    // Admin routes
    if (!verifyAdminKey(req, env) && path !== "/api/kyc/health") {
      // Check if it's an admin-only route
      const adminRoutes = ["/api/kyc/review", "/api/kyc/batch", "/api/kyc/stats"];
      const isAdminRoute = adminRoutes.some(r => path.startsWith(r));
      if (isAdminRoute) return errResp("Unauthorized", 401, cors);
    }

    // GET /api/kyc/review
    if (path === "/api/kyc/review" && method === "GET") {
      if (!verifyAdminKey(req, env)) return errResp("Unauthorized", 401, cors);
      return handleReviewQueue(req, env, cors);
    }

    // POST /api/kyc/review/:id/approve|reject|escalate
    const reviewMatch = path.match(/^\/api\/kyc\/review\/([^/]+)\/(approve|reject|escalate)$/);
    if (reviewMatch && method === "POST") {
      if (!verifyAdminKey(req, env)) return errResp("Unauthorized", 401, cors);
      return handleReviewAction(reviewMatch[1], reviewMatch[2], req, env, cors);
    }

    // POST /api/kyc/batch
    if (path === "/api/kyc/batch" && method === "POST") {
      if (!verifyAdminKey(req, env)) return errResp("Unauthorized", 401, cors);
      return handleBatch(req, env, ctx, cors);
    }

    // GET /api/kyc/stats
    if (path === "/api/kyc/stats" && method === "GET") {
      if (!verifyAdminKey(req, env)) return errResp("Unauthorized", 401, cors);
      return handleStats(env, cors);
    }

    return errResp("Not found", 404, cors);
  }
};
