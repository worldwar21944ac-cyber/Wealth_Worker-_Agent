/**
 * kyc-gateway v10.0 — Sub-2-Second KYC/KYB Intake Screening
 * Bervashun Trust Capital / Worldwar2.1944.ac
 *
 * 18 parallel screening engines with hard 1750 ms timeout fence.
 * Decisions: APPROVED (0-29) | REVIEW (30-69) | DENIED (70-100)
 *
 * Routes:
 *   POST /api/kyc/apply                  — KYC (individual) / KYB (business) intake
 *   GET  /api/kyc/status/:id             — submission status lookup
 *   GET  /api/kyc/review                 — admin review queue (paginated)
 *   POST /api/kyc/review/:id/approve     — human approve
 *   POST /api/kyc/review/:id/reject      — human reject
 *   POST /api/kyc/review/:id/escalate    — escalate to senior review
 *   POST /api/kyc/batch                  — batch intake (≤50 submissions, admin)
 *   GET  /api/kyc/stats                  — aggregate statistics (admin)
 *   GET  /api/kyc/health                 — liveness (unauthenticated)
 *
 * Bindings:
 *   AUDIT_DB         — D1 (bervashun-audit)
 *   KYC_SANCTIONS    — KV (kyc-sanctions-cache)
 *   GATEWAY_AUTH     — KV (gateway-auth)
 *   KYC_ADMIN_KEY    — secret
 *   NOTIFIER_TOKEN   — secret
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const ENGINE_VERSION = '10.0';
const ENGINE_COUNT   = 18;
const TIMEOUT_MS     = 1750;
const NOTIFY_URL     = 'https://notify.wwwknockoutforever.com/webhook/system-alert';

// FATF high-risk / grey-list jurisdictions (55 countries, updated Oct 2026)
const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','CM','CF','CD','CI','CU','CG','ET',
  'GH','GT','GY','HT','IR','IQ','JM','JO','KE','KH','KP','LA','LB',
  'LY','MA','ML','MM','MO','MR','MZ','NG','NI','PA','PH','PK','SA',
  'SN','SO','SS','SY','TN','TT','UG','US_TERRITORY','VE','VN','VU',
  'YE','ZM','ZW','BY','RU'
]);

// IRS disallowed EIN prefixes (authoritative)
const BAD_EIN_PREFIXES = new Set([
  '07','08','09','17','18','19','28','29','49','69','70','78','79','89'
]);

// Adverse media high-risk keyword set
const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','bribery','corruption','sanction',
  'indicted','convicted','arrested','cartel','trafficking','embezzlement',
  'ponzi','insider trading','wire fraud','tax evasion','fictitious',
  'shell company','dummy','phantom','forfeiture','seizure'
];

// ─── Name normalisation ─────────────────────────────────────────────────────

function normalName(raw = '') {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|the|and|of|for)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Fuzzy name matching ────────────────────────────────────────────────────

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const lenS1 = s1.length, lenS2 = s2.length;
  if (!lenS1 || !lenS2) return 0;
  const matchDist = Math.floor(Math.max(lenS1, lenS2) / 2) - 1;
  const s1Matches = new Array(lenS1).fill(false);
  const s2Matches = new Array(lenS2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < lenS1; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, lenS2);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true; s2Matches[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < lenS1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / lenS1 + matches / lenS2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, lenS1, lenS2); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  const intersection = [...tokensA].filter(t => tokensB.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size ? intersection.length / union.size : 0;
}

function nameSimilarity(a, b) {
  const na = normalName(a), nb = normalName(b);
  return Math.max(jaroWinkler(na, nb), tokenSetSimilarity(na, nb));
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

function bearerToken(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function isValidApiKey(env, req) {
  const key = bearerToken(req) || req.headers.get('X-API-Key');
  if (!key) return false;
  const entry = await env.GATEWAY_AUTH.get(`apikey:${key}`);
  return !!entry;
}

async function isAdmin(env, req) {
  const key = req.headers.get('X-KYC-Admin-Key') || bearerToken(req);
  return key === env.KYC_ADMIN_KEY;
}

// ─── Unique ID generator ────────────────────────────────────────────────────

function newId(prefix = 'kyc') {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rnd}`.toUpperCase();
}

// ─── Sanction / PEP list helpers ────────────────────────────────────────────

async function fetchList(env, key) {
  try {
    const raw = await env.KYC_SANCTIONS.get(key, { type: 'json' });
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

// ─── Engine Implementations ─────────────────────────────────────────────────

// E1 — OFAC SDN (40 pts/hit, cap 70)
async function e1_ofac(env, name) {
  const list = await fetchList(env, 'sdn:index');
  let score = 0; const hits = [];
  for (const entry of list) {
    const sim = nameSimilarity(name, entry.name || entry);
    if (sim >= 0.82) { hits.push(entry.name || entry); score = Math.min(score + 40, 70); }
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (nameSimilarity(name, alias) >= 0.82) { hits.push(alias); score = Math.min(score + 40, 70); break; }
      }
    }
  }
  return { engine: 'E1_OFAC_SDN', score, hits, flag: score > 0 };
}

// E2 — PEP (25 pts/hit, cap 50)
async function e2_pep(env, name) {
  const list = await fetchList(env, 'pep:index');
  let score = 0; const hits = [];
  for (const entry of list) {
    const sim = nameSimilarity(name, entry.name || entry);
    if (sim >= 0.80) { hits.push(entry.name || entry); score = Math.min(score + 25, 50); }
  }
  return { engine: 'E2_PEP', score, hits, flag: score > 0 };
}

// E3 — FATF high-risk country (20 pts)
function e3_fatf(country) {
  const cc = (country || '').toUpperCase().trim();
  const flag = FATF_HIGH_RISK.has(cc);
  return { engine: 'E3_FATF', score: flag ? 20 : 0, country: cc, flag };
}

// E4 — TIN/EIN validation (20 pts for invalid)
function e4_tin(tin, entityType) {
  if (!tin) return { engine: 'E4_TIN_EIN', score: 15, flag: true, reason: 'missing' };
  const cleaned = tin.replace(/[^0-9]/g, '');
  if (entityType === 'business') {
    // EIN: 9 digits, no bad prefix
    if (cleaned.length !== 9) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ein_length' };
    const prefix = cleaned.slice(0, 2);
    if (BAD_EIN_PREFIXES.has(prefix)) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ein_bad_prefix', prefix };
    return { engine: 'E4_TIN_EIN', score: 0, flag: false };
  }
  // SSN: 9 digits, first 3 not 000/666/900-999, middle 2 not 00, last 4 not 0000
  if (cleaned.length !== 9) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_length' };
  const area = parseInt(cleaned.slice(0, 3));
  if (area === 0 || area === 666 || area >= 900) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_area', area };
  if (cleaned.slice(3, 5) === '00') return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_group' };
  if (cleaned.slice(5) === '0000') return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_serial' };
  return { engine: 'E4_TIN_EIN', score: 0, flag: false };
}

// E5 — Velocity (15 pts if >5 submissions from same TIN in 24h)
async function e5_velocity(env, tin) {
  try {
    const key = `velocity:${tin}:${Math.floor(Date.now() / 86400000)}`;
    const current = parseInt(await env.KYC_SANCTIONS.get(key) || '0');
    await env.KYC_SANCTIONS.put(key, String(current + 1), { expirationTtl: 86400 });
    const flag = current >= 5;
    return { engine: 'E5_VELOCITY', score: flag ? 15 : 0, count: current + 1, flag };
  } catch { return { engine: 'E5_VELOCITY', score: 0, flag: false }; }
}

// E6 — Structuring ($8,000–$9,999 window, 35 pts)
function e6_structuring(amount) {
  if (amount === undefined || amount === null) return { engine: 'E6_STRUCTURING', score: 0, flag: false };
  const n = parseFloat(amount);
  const flag = n >= 8000 && n < 10000;
  return { engine: 'E6_STRUCTURING', score: flag ? 35 : 0, amount: n, flag };
}

// E7 — Adverse media keywords (5 pts/kw, cap 30)
function e7_adverse(adverseMedia = '') {
  if (!adverseMedia) return { engine: 'E7_ADVERSE_MEDIA', score: 0, flag: false, hits: [] };
  const lower = adverseMedia.toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => lower.includes(kw));
  const score = Math.min(hits.length * 5, 30);
  return { engine: 'E7_ADVERSE_MEDIA', score, hits, flag: score > 0 };
}

// E8 — UBO cascade (25 pts/owner ≥25% flagged by OFAC or PEP)
async function e8_ubo(env, owners = []) {
  if (!owners.length) return { engine: 'E8_UBO_CASCADE', score: 0, flag: false, hits: [] };
  const significant = owners.filter(o => (o.ownership_pct || 0) >= 25);
  if (!significant.length) return { engine: 'E8_UBO_CASCADE', score: 0, flag: false, hits: [] };
  const checks = await Promise.all(significant.map(async o => {
    const [ofac, pep] = await Promise.all([e1_ofac(env, o.name), e2_pep(env, o.name)]);
    return { owner: o.name, pct: o.ownership_pct, ofac_hit: ofac.flag, pep_hit: pep.flag };
  }));
  const hits = checks.filter(c => c.ofac_hit || c.pep_hit);
  const score = Math.min(hits.length * 25, 75);
  return { engine: 'E8_UBO_CASCADE', score, hits: hits.map(h => h.owner), flag: hits.length > 0 };
}

// E9 — DOB plausibility (35 pts: future / under-18 / over-120)
function e9_dob(dob) {
  if (!dob) return { engine: 'E9_DOB', score: 0, flag: false, reason: 'not_provided' };
  const d = new Date(dob);
  if (isNaN(d)) return { engine: 'E9_DOB', score: 20, flag: true, reason: 'unparseable' };
  const now = new Date();
  if (d > now) return { engine: 'E9_DOB', score: 35, flag: true, reason: 'future_dob' };
  const ageYears = (now - d) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 18) return { engine: 'E9_DOB', score: 35, flag: true, reason: 'under_18', age: Math.floor(ageYears) };
  if (ageYears > 120) return { engine: 'E9_DOB', score: 35, flag: true, reason: 'over_120', age: Math.floor(ageYears) };
  return { engine: 'E9_DOB', score: 0, flag: false };
}

// E10 — Address risk (10 pts for high-risk address patterns)
function e10_address(address = '') {
  if (!address) return { engine: 'E10_ADDRESS_RISK', score: 5, flag: false, reason: 'missing' };
  const lower = address.toLowerCase();
  const highRiskPatterns = [
    /p\.?o\.?\s*box/i, /suite\s+\d{4,}/i, /pmb/i, /mail\s+drop/i,
    /forwarding/i, /virtual\s+office/i, /no\s+fixed\s+address/i
  ];
  const hit = highRiskPatterns.find(p => p.test(lower));
  return { engine: 'E10_ADDRESS_RISK', score: hit ? 10 : 0, flag: !!hit, pattern: hit?.toString() };
}

// E11 — Entity consistency (15 pts if individual TIN used on business or vice versa)
function e11_consistency(entityType, tin, dob, registrationNumber) {
  const issues = [];
  if (entityType === 'individual' && !dob) issues.push('missing_dob_for_individual');
  if (entityType === 'business' && !registrationNumber) issues.push('missing_reg_for_business');
  if (entityType === 'individual' && registrationNumber) issues.push('reg_number_on_individual');
  if (entityType === 'business' && dob) issues.push('dob_on_business');
  const score = Math.min(issues.length * 15, 30);
  return { engine: 'E11_ENTITY_CONSISTENCY', score, issues, flag: issues.length > 0 };
}

// E12 — Corporate depth (20 pts if >4 layers)
function e12_corp_depth(corporateStructure = {}) {
  const depth = corporateStructure.depth || 0;
  const flag = depth > 4;
  return { engine: 'E12_CORPORATE_DEPTH', score: flag ? 20 : 0, depth, flag };
}

// E13 — Document entropy (10 pts for low-entropy or expired docs)
function e13_docs(documents = []) {
  if (!documents.length) return { engine: 'E13_DOCUMENT_ENTROPY', score: 5, flag: false, reason: 'no_docs' };
  const now = new Date();
  const issues = [];
  for (const doc of documents) {
    if (doc.expiry && new Date(doc.expiry) < now) issues.push(`expired:${doc.type}`);
    if (!doc.number || doc.number.length < 5) issues.push(`low_entropy:${doc.type}`);
  }
  const score = Math.min(issues.length * 10, 30);
  return { engine: 'E13_DOCUMENT_ENTROPY', score, issues, flag: issues.length > 0 };
}

// E14 — Network graph (20 pts if shared TIN/address with flagged entity)
async function e14_network(env, tin, address) {
  try {
    const tinNet = tin ? await env.KYC_SANCTIONS.get(`netgraph:tin:${tin}`) : null;
    const addrNet = address ? await env.KYC_SANCTIONS.get(`netgraph:addr:${normalName(address)}`) : null;
    const flag = !!(tinNet || addrNet);
    return { engine: 'E14_NETWORK_GRAPH', score: flag ? 20 : 0, tin_shared: !!tinNet, addr_shared: !!addrNet, flag };
  } catch { return { engine: 'E14_NETWORK_GRAPH', score: 0, flag: false }; }
}

// E15 — Synthetic identity (40 pts if SSN area ≥900 — ITIN range only, not SSN)
function e15_synthetic(tin, entityType) {
  if (entityType !== 'individual' || !tin) return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
  const cleaned = tin.replace(/[^0-9]/g, '');
  if (cleaned.length !== 9) return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
  const area = parseInt(cleaned.slice(0, 3));
  // ITINs: area 900-999 (IRS-issued, not SSA) — flag for further human review
  if (area >= 900) return { engine: 'E15_SYNTHETIC_ID', score: 40, flag: true, reason: 'ssn_area_900_plus', area };
  return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
}

// E16 — Watchlist delta (30 pts if name newly added to SDN in last 7 days)
async function e16_delta(env, name) {
  try {
    const deltaList = await fetchList(env, 'sdn:delta:7d');
    for (const entry of deltaList) {
      if (nameSimilarity(name, entry.name || entry) >= 0.82) {
        return { engine: 'E16_WATCHLIST_DELTA', score: 30, flag: true, matched: entry.name || entry };
      }
    }
    return { engine: 'E16_WATCHLIST_DELTA', score: 0, flag: false };
  } catch { return { engine: 'E16_WATCHLIST_DELTA', score: 0, flag: false }; }
}

// E17 — FinCEN 314(a) (25 pts if JW ≥0.82 OR token-set ≥0.80)
async function e17_fincen(env, name) {
  try {
    const list = await fetchList(env, 'fincen:314a');
    for (const entry of list) {
      const n = entry.name || entry;
      const jw = jaroWinkler(normalName(name), normalName(n));
      const ts = tokenSetSimilarity(normalName(name), normalName(n));
      if (jw >= 0.82 || ts >= 0.80) {
        return { engine: 'E17_FINCEN_314A', score: 25, flag: true, matched: n, jw: +jw.toFixed(3), ts: +ts.toFixed(3) };
      }
    }
    return { engine: 'E17_FINCEN_314A', score: 0, flag: false };
  } catch { return { engine: 'E17_FINCEN_314A', score: 0, flag: false }; }
}

// E18 — Geo-velocity (20 pts if IP country changed within 1h from last submission)
async function e18_geovelocity(env, tin, ipCountry) {
  if (!tin || !ipCountry) return { engine: 'E18_GEO_VELOCITY', score: 0, flag: false };
  try {
    const key = `geovelocity:${tin}`;
    const last = await env.KYC_SANCTIONS.get(key, { type: 'json' });
    const now = Date.now();
    await env.KYC_SANCTIONS.put(key, JSON.stringify({ country: ipCountry, ts: now }), { expirationTtl: 7200 });
    if (last && last.country && last.country !== ipCountry && (now - last.ts) < 3600000) {
      return { engine: 'E18_GEO_VELOCITY', score: 20, flag: true, from: last.country, to: ipCountry, elapsed_ms: now - last.ts };
    }
    return { engine: 'E18_GEO_VELOCITY', score: 0, flag: false };
  } catch { return { engine: 'E18_GEO_VELOCITY', score: 0, flag: false }; }
}

// ─── Decision band ──────────────────────────────────────────────────────────

function scoreToDecision(score) {
  if (score < 30) return 'APPROVED';
  if (score < 70) return 'REVIEW';
  return 'DENIED';
}

// ─── D1 persistence ─────────────────────────────────────────────────────────

async function persistSubmission(env, sub) {
  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO kyc_submissions
        (submission_id, entity_type, applicant_name, tin, tin_formatted,
         status, risk_score, risk_decision, risk_breakdown,
         sanctions_hits, ofac_hits, pep_hits,
         tin_valid, ein_valid, screen_latency_ms, raw_payload,
         screened_at, created_at, flags_json,
         pep_hits_json, ofac_hits_json,
         velocity_flagged, structuring_flagged, adverse_media_hits, engine_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      sub.submission_id, sub.entity_type, sub.applicant_name, sub.tin, sub.tin_formatted,
      sub.status, sub.risk_score, sub.risk_decision, JSON.stringify(sub.risk_breakdown),
      sub.sanctions_hits, sub.ofac_hits, sub.pep_hits,
      sub.tin_valid ? 1 : 0, sub.ein_valid ? 1 : 0,
      sub.screen_latency_ms, JSON.stringify(sub.raw_payload),
      sub.screened_at, sub.screened_at,
      JSON.stringify(sub.flags_json),
      JSON.stringify(sub.pep_hits_json || []),
      JSON.stringify(sub.ofac_hits_json || []),
      sub.velocity_flagged ? 1 : 0, sub.structuring_flagged ? 1 : 0,
      sub.adverse_media_hits, ENGINE_VERSION
    ).run();
  } catch (err) {
    console.error('D1 persist error:', err.message);
  }
}

async function persistReviewQueue(env, sub) {
  try {
    if (sub.risk_decision === 'REVIEW' || sub.risk_decision === 'DENIED') {
      await env.AUDIT_DB.prepare(`
        INSERT INTO kyc_review_queue
          (reference_id, type, flags_json, payload_json, status)
        VALUES (?,?,?,?,?)
      `).bind(
        sub.submission_id,
        sub.risk_decision === 'DENIED' ? 'DENIED_AUTO' : 'HUMAN_REVIEW',
        JSON.stringify(sub.flags_json),
        JSON.stringify(sub.raw_payload),
        'PENDING'
      ).run();
    }
  } catch (err) {
    console.error('D1 review queue error:', err.message);
  }
}

async function persistAuditLog(env, eventType, entityId, payload) {
  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO audit_log (event_id, event_type, entity_id, entity_type, payload, created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      newId('evt'), eventType, entityId, 'kyc_submission',
      JSON.stringify(payload), new Date().toISOString()
    ).run();
  } catch {}
}

// ─── Notifier helper ─────────────────────────────────────────────────────────

async function notifyDenied(env, sub) {
  if (!env.NOTIFIER_TOKEN) return;
  try {
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NOTIFIER_TOKEN}`
      },
      body: JSON.stringify({
        event_type: 'KYC_DENIED',
        severity: 'HIGH',
        submission_id: sub.submission_id,
        applicant: sub.applicant_name,
        risk_score: sub.risk_score,
        flags: sub.flags_json
      })
    });
  } catch {}
}

// ─── Core screening pipeline ────────────────────────────────────────────────

async function runScreening(env, payload) {
  const {
    entity_type = 'individual',
    applicant_name, name,
    tin, ssn, ein,
    dob, date_of_birth,
    country, country_of_residence,
    address,
    registration_number,
    corporate_structure,
    documents = [],
    beneficial_owners = [],
    transaction_amount,
    adverse_media = '',
    ip_country
  } = payload;

  const resolvedName    = applicant_name || name || '';
  const resolvedTin     = tin || ssn || ein || '';
  const resolvedDob     = dob || date_of_birth || '';
  const resolvedCountry = country || country_of_residence || '';
  const resolvedAddress = address || '';

  // Fan out all 18 engines in parallel with hard timeout
  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve({ timed_out: true }), TIMEOUT_MS)
  );

  const enginePromises = Promise.all([
    e1_ofac(env, resolvedName),
    e2_pep(env, resolvedName),
    Promise.resolve(e3_fatf(resolvedCountry)),
    Promise.resolve(e4_tin(resolvedTin, entity_type)),
    e5_velocity(env, resolvedTin),
    Promise.resolve(e6_structuring(transaction_amount)),
    Promise.resolve(e7_adverse(adverse_media)),
    e8_ubo(env, beneficial_owners),
    Promise.resolve(e9_dob(resolvedDob)),
    Promise.resolve(e10_address(resolvedAddress)),
    Promise.resolve(e11_consistency(entity_type, resolvedTin, resolvedDob, registration_number)),
    Promise.resolve(e12_corp_depth(corporate_structure)),
    Promise.resolve(e13_docs(documents)),
    e14_network(env, resolvedTin, resolvedAddress),
    Promise.resolve(e15_synthetic(resolvedTin, entity_type)),
    e16_delta(env, resolvedName),
    e17_fincen(env, resolvedName),
    e18_geovelocity(env, resolvedTin, ip_country)
  ]);

  const result = await Promise.race([enginePromises, timeoutPromise]);

  if (result.timed_out) {
    return {
      timed_out: true,
      risk_score: 35,
      risk_decision: 'REVIEW',
      reason: 'engine_timeout',
      engines: { count: ENGINE_COUNT }
    };
  }

  const [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18] = result;

  const totalScore = Math.min(100,
    r1.score + r2.score + r3.score + r4.score + r5.score + r6.score +
    r7.score + r8.score + r9.score + r10.score + r11.score + r12.score +
    r13.score + r14.score + r15.score + r16.score + r17.score + r18.score
  );

  const decision = scoreToDecision(totalScore);
  const flags    = [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,r16,r17,r18].filter(e => e.flag);

  return {
    risk_score:    totalScore,
    risk_decision: decision,
    risk_breakdown: result,
    sanctions_hits: (r1.hits?.length || 0) + (r2.hits?.length || 0) + (r8.hits?.length || 0),
    ofac_hits:     r1.hits || [],
    pep_hits:      r2.hits || [],
    tin_valid:     !r4.flag,
    ein_valid:     entity_type === 'business' ? !r4.flag : null,
    velocity_flagged:    r5.flag,
    structuring_flagged: r6.flag,
    adverse_media_hits:  r7.hits?.length || 0,
    flags_json:   flags.map(e => e.engine),
    engines:      { count: ENGINE_COUNT },
    account_generation: { allowed: decision === 'APPROVED' }
  };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleApply(req, env) {
  const authed = await isValidApiKey(env, req);
  if (!authed) return json({ error: 'Unauthorized' }, 401);

  let payload;
  try { payload = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const name = payload.applicant_name || payload.name || '';
  if (!name) return json({ error: 'applicant_name is required' }, 422);

  const submissionId = newId('kyc');
  const startTs      = Date.now();

  const screening = await runScreening(env, payload);
  const latencyMs  = Date.now() - startTs;

  const submissionRecord = {
    submission_id:     submissionId,
    entity_type:       payload.entity_type || 'individual',
    applicant_name:    name,
    tin:               payload.tin || payload.ssn || payload.ein || '',
    tin_formatted:     (payload.tin || payload.ssn || payload.ein || '').replace(/(\d{3})(\d{2})(\d{4})/, '$1-$2-$3'),
    status:            screening.risk_decision,
    risk_score:        screening.risk_score,
    risk_decision:     screening.risk_decision,
    risk_breakdown:    screening.risk_breakdown,
    sanctions_hits:    screening.sanctions_hits,
    ofac_hits:         screening.ofac_hits?.length || 0,
    pep_hits:          screening.pep_hits?.length || 0,
    tin_valid:         screening.tin_valid,
    ein_valid:         screening.ein_valid,
    screen_latency_ms: latencyMs,
    raw_payload:       payload,
    screened_at:       new Date().toISOString(),
    flags_json:        screening.flags_json,
    pep_hits_json:     screening.pep_hits,
    ofac_hits_json:    screening.ofac_hits,
    velocity_flagged:  screening.velocity_flagged,
    structuring_flagged: screening.structuring_flagged,
    adverse_media_hits: screening.adverse_media_hits,
    engine_version:    ENGINE_VERSION
  };

  await Promise.all([
    persistSubmission(env, submissionRecord),
    persistReviewQueue(env, submissionRecord),
    persistAuditLog(env, 'KYC_SUBMITTED', submissionId, { decision: screening.risk_decision, score: screening.risk_score })
  ]);

  if (screening.risk_decision === 'DENIED') {
    notifyDenied(env, submissionRecord); // non-blocking fire-and-forget
  }

  return json({
    submission_id:  submissionId,
    status:         screening.risk_decision,
    risk_score:     screening.risk_score,
    risk_decision:  screening.risk_decision,
    account_generation: screening.account_generation,
    flags:          screening.flags_json,
    engines:        screening.engines,
    screen_latency_ms: latencyMs,
    engine_version: ENGINE_VERSION,
    timestamp:      submissionRecord.screened_at
  });
}

async function handleStatus(req, env, id) {
  const authed = await isValidApiKey(env, req);
  if (!authed) return json({ error: 'Unauthorized' }, 401);
  try {
    const row = await env.AUDIT_DB.prepare(
      'SELECT submission_id, status, risk_score, risk_decision, flags_json, screen_latency_ms, screened_at FROM kyc_submissions WHERE submission_id = ?'
    ).bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    return json({ ...row, flags_json: safeJson(row.flags_json) });
  } catch (err) {
    return json({ error: 'DB error', detail: err.message }, 500);
  }
}

async function handleReview(req, env) {
  if (!await isAdmin(env, req)) return json({ error: 'Admin required' }, 403);
  const url    = new URL(req.url);
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit  = Math.min(50, parseInt(url.searchParams.get('per_page') || '20'));
  const status = url.searchParams.get('status') || 'PENDING';
  const offset = (page - 1) * limit;
  try {
    const rows = await env.AUDIT_DB.prepare(
      'SELECT * FROM kyc_review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(status, limit, offset).all();
    const countRow = await env.AUDIT_DB.prepare(
      'SELECT COUNT(*) as total FROM kyc_review_queue WHERE status = ?'
    ).bind(status).first();
    return json({
      items: rows.results.map(r => ({ ...r, flags_json: safeJson(r.flags_json) })),
      total: countRow?.total || 0,
      page, per_page: limit
    });
  } catch (err) {
    return json({ error: 'DB error', detail: err.message }, 500);
  }
}

async function handleReviewAction(req, env, id, action) {
  if (!await isAdmin(env, req)) return json({ error: 'Admin required' }, 403);
  const validActions = ['approve', 'reject', 'escalate'];
  if (!validActions.includes(action)) return json({ error: 'Invalid action' }, 400);
  const statusMap = { approve: 'APPROVED', reject: 'REJECTED', escalate: 'ESCALATED' };
  const newStatus = statusMap[action];
  try {
    await env.AUDIT_DB.prepare(
      'UPDATE kyc_review_queue SET status = ?, resolved_at = ? WHERE reference_id = ?'
    ).bind(newStatus, new Date().toISOString(), id).run();
    await env.AUDIT_DB.prepare(
      'UPDATE kyc_submissions SET status = ? WHERE submission_id = ?'
    ).bind(newStatus, id).run();
    await persistAuditLog(env, `KYC_${newStatus}`, id, { action, by: 'admin' });
    return json({ success: true, submission_id: id, status: newStatus, action });
  } catch (err) {
    return json({ error: 'DB error', detail: err.message }, 500);
  }
}

async function handleBatch(req, env) {
  if (!await isAdmin(env, req)) return json({ error: 'Admin required' }, 403);
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  const submissions = Array.isArray(body) ? body : body.submissions;
  if (!submissions || !submissions.length) return json({ error: 'submissions array required' }, 422);
  if (submissions.length > 50) return json({ error: 'Max 50 per batch' }, 422);
  const results = await Promise.all(submissions.map(async payload => {
    const id   = newId('kyc');
    const name = payload.applicant_name || payload.name || '';
    if (!name) return { error: 'missing applicant_name', payload };
    const s = await runScreening(env, payload);
    return { submission_id: id, applicant_name: name, status: s.risk_decision, risk_score: s.risk_score, account_generation: s.account_generation };
  }));
  return json({ results, count: results.length, engine_version: ENGINE_VERSION });
}

async function handleStats(req, env) {
  if (!await isAdmin(env, req)) return json({ error: 'Admin required' }, 403);
  try {
    const [totals, decisions, latency, fincen] = await Promise.all([
      env.AUDIT_DB.prepare('SELECT COUNT(*) as total FROM kyc_submissions').first(),
      env.AUDIT_DB.prepare('SELECT risk_decision, COUNT(*) as cnt FROM kyc_submissions GROUP BY risk_decision').all(),
      env.AUDIT_DB.prepare('SELECT AVG(screen_latency_ms) as avg_ms, MAX(screen_latency_ms) as max_ms FROM kyc_submissions').first(),
      env.AUDIT_DB.prepare("SELECT COUNT(*) as fincen_hits FROM kyc_submissions WHERE flags_json LIKE '%E17_FINCEN%'").first()
    ]);
    return json({
      total_submissions: totals?.total || 0,
      by_decision: decisions.results,
      latency_ms: latency,
      fincen_hits: fincen?.fincen_hits || 0,
      engine_version: ENGINE_VERSION,
      engine_count: ENGINE_COUNT
    });
  } catch (err) {
    return json({ error: 'DB error', detail: err.message }, 500);
  }
}

function handleHealth() {
  return json({
    status: 'ok',
    version: ENGINE_VERSION,
    engine_count: ENGINE_COUNT,
    timeout_ms: TIMEOUT_MS,
    decision_bands: { APPROVED: '0-29', REVIEW: '30-69', DENIED: '70-100' },
    timestamp: new Date().toISOString()
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-KYC-Admin-Key',
      'Access-Control-Expose-Headers': 'X-Submission-Id'
    }
  });
}

function safeJson(v) {
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; }
  catch { return v; }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return json({}, 204);

    // Health — unauthenticated
    if (path === '/api/kyc/health' && method === 'GET') return handleHealth();

    // Intake
    if (path === '/api/kyc/apply' && method === 'POST') return handleApply(req, env);

    // Status
    const statusMatch = path.match(/^\/api\/kyc\/status\/(.+)$/);
    if (statusMatch && method === 'GET') return handleStatus(req, env, statusMatch[1]);

    // Review action
    const actionMatch = path.match(/^\/api\/kyc\/review\/(.+)\/(approve|reject|escalate)$/);
    if (actionMatch && method === 'POST') return handleReviewAction(req, env, actionMatch[1], actionMatch[2]);

    // Review queue
    if (path === '/api/kyc/review' && method === 'GET') return handleReview(req, env);

    // Batch
    if (path === '/api/kyc/batch' && method === 'POST') return handleBatch(req, env);

    // Stats
    if (path === '/api/kyc/stats' && method === 'GET') return handleStats(req, env);

    return json({ error: 'Not Found', path }, 404);
  }
};
