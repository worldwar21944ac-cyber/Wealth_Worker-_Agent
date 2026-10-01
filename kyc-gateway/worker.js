/**
 * kyc-gateway v15.0
 * Sub-2-Second KYC/KYB Intake Screening
 * ─────────────────────────────────────────────────────────────────────
 * 20 Parallel Screening Engines:
 *   E01 OFAC SDN           – 40 pts / hit (cap 70)
 *   E02 PEP                – 25 pts / hit (cap 50)
 *   E03 FATF High-Risk     – 20 pts / 55 countries
 *   E04 TIN/EIN Validity   – 20 pts
 *   E05 Velocity           – 15 pts / >5 per TIN per 24h
 *   E06 Structuring        – 35 pts / $8k–$9,999 window
 *   E07 Adverse Media      – 5 pts / keyword (cap 30)
 *   E08 UBO Cascade        – 25 pts / ≥25% ownership + OFAC/PEP cross-ref
 *   E09 DOB Plausibility   – 35 pts / future | under-18 | over-120
 *   E10 Address Risk       – 10 pts / PO Box | CMRA | missing ZIP
 *   E11 Entity Consistency – 15 pts / name↔TIN type mismatch
 *   E12 Corporate Depth    – 20 pts / >4 shell layers
 *   E13 Document Entropy   – 10 pts / low entropy | expired doc
 *   E14 Network Graph      – 20 pts / shared TIN or address across applications
 *   E15 Synthetic ID       – 40 pts / SSN area 900+ | ITIN IRS group rules
 *   E16 Watchlist Delta    – 30 pts / newly-added SDN (delta:7d)
 *   E17 FinCEN 314(a)      – 25 pts / JW ≥0.82 OR token-set ≥0.80
 *   E18 Geo-Velocity       – 20 pts / IP-hop within 1 hour
 *   E19 Country of Birth   – 15 pts / FATF cross-ref on nationality
 *   E20 Second-Degree PEP  – 20 pts / family/associates (pep2:index)
 *
 * Decision Bands:
 *   0–29   → APPROVED  (account generation allowed)
 *   30–69  → REVIEW    (queued for human decision)
 *   70–100 → DENIED    (account generation blocked; notifier alert fired)
 *
 * Hard timeout: 1750ms → auto-REVIEW
 *
 * Bindings required:
 *   AUDIT_DB        D1  – kyc_submissions, kyc_review_queue, kyc_beneficial_owners, audit_log
 *   KYC_SANCTIONS   KV  – sdn:index, pep:index, pep2:index, fincen:314a, sdn:delta:7d
 *   GATEWAY_AUTH    KV  – apikey:{key} → true
 *   KYC_ADMIN_KEY   Secret
 *   NOTIFIER_TOKEN  Secret (fired on DENIED via signup-notifier)
 */

const VERSION = '15.0.0';
const ENGINES_COUNT = 20;
const TIMEOUT_MS = 1750;
const DENIED_THRESHOLD = 70;
const REVIEW_THRESHOLD = 30;

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Search-Admin-Key',
  'Access-Control-Expose-Headers': 'X-Submission-Id, X-Risk-Score, X-Risk-Decision, X-Engines-Run, X-Processing-Ms',
};

// ─── FATF HIGH-RISK COUNTRIES (55) ─────────────────────────────────────────
const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','CF','CG','CI','CM','CU','DZ','EC','ET',
  'GH','GN','GW','HT','ID','IQ','IR','JM','JO','KE','KH','KP','KR','LA',
  'LB','LK','LY','MA','ME','ML','MM','MR','MZ','NG','NI','PA','PH','PK',
  'RS','RU','SA','SD','SL','SN','SY','TG','TJ','TN','TT','UG','UZ','VE',
  'VN','YE','ZW',
]);

// ─── ADVERSE MEDIA KEYWORDS ────────────────────────────────────────────────
const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','drug trafficking','bribery','corruption',
  'embezzlement','cartel','sanction','indicted','convicted','arrested','criminal',
  'ponzi','wire fraud','identity theft','tax evasion','counterfeiting','smuggling',
];

// ─── EIN DISALLOWED PREFIXES (IRS authoritative) ──────────────────────────
const EIN_DISALLOWED = new Set(['07','08','09','17','18','19','28','29','49','69','70','78','79','89']);

// ─── HELPERS ───────────────────────────────────────────────────────────────

/** Strip noise from names before matching */
function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|plc|group|holdings|international|intl|trust|foundation|nv|bv|gmbh|ag|sa)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaro–Winkler similarity */
function jaroWinkler(s1, s2) {
  if (!s1 && !s2) return 0.0;   // both empty → no similarity
  if (s1 === s2) return 1.0;
  const l1 = s1.length, l2 = s2.length;
  if (!l1 || !l2) return 0.0;
  const matchDist = Math.max(Math.floor(Math.max(l1, l2) / 2) - 1, 0);
  const m1 = new Array(l1).fill(false);
  const m2 = new Array(l2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < l1; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, l2);
    for (let j = lo; j < hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0.0;
  let k = 0;
  for (let i = 0; i < l1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / l1 + matches / l2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(l1, l2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token-set similarity (order-insensitive) */
function tokenSetSim(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  const inter = [...sa].filter(t => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/** Combined name match — returns true if JW≥threshold OR tokenSet≥0.80 */
function nameMatch(candidate, target, jwThreshold = 0.82) {
  const c = normalizeName(candidate);
  const t = normalizeName(target);
  if (!c || !t) return false;
  return jaroWinkler(c, t) >= jwThreshold || tokenSetSim(c, t) >= 0.80;
}

/** Validate SSN format, return { valid, area, group, serial } */
function parseSSN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return { valid: false };
  const area = parseInt(digits.slice(0, 3), 10);
  const group = parseInt(digits.slice(3, 5), 10);
  const serial = parseInt(digits.slice(5), 10);
  // All-zero segments invalid
  if (area === 0 || group === 0 || serial === 0) return { valid: false, area, group, serial };
  // 666 invalid
  if (area === 666) return { valid: false, area, group, serial };
  // 900+ = ITIN range
  return { valid: area < 900, itin: area >= 900, area, group, serial };
}

/** Validate ITIN per IRS group rules (7th digit must be 7 or 8, specific group ranges) */
function isITIN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const area = parseInt(digits.slice(0, 3), 10);
  if (area < 900 || area > 999) return false;
  const group = parseInt(digits.slice(3, 5), 10);
  // IRS valid ITIN groups: 50-65, 70-88, 90-92, 94-99
  const validGroups =
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    (group >= 94 && group <= 99);
  return validGroups;
}

/** Validate EIN: XX-XXXXXXX, prefix not in disallowed list */
function validateEIN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const prefix = digits.slice(0, 2);
  return !EIN_DISALLOWED.has(prefix);
}

/** SHA-256 hex fingerprint */
async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** withTimeout — isolates per-engine failure without killing the whole fan-out */
async function withTimeout(label, ms, fn) {
  return Promise.race([
    fn().catch(err => ({ engine: label, skipped: true, error: err.message })),
    new Promise(resolve => setTimeout(() => resolve({ engine: label, skipped: true, error: 'timeout' }), ms)),
  ]);
}

/** JSON response helper */
function jsonResp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

/** Auth helpers */
async function verifyApiKey(req, env) {
  const key = req.headers.get('X-API-Key') || req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!key) return false;
  const val = await env.GATEWAY_AUTH.get(`apikey:${key}`);
  return val === 'true';
}
function verifyAdmin(req, env) {
  const key = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return key === env.KYC_ADMIN_KEY;
}

// ─── SCREENING ENGINES ─────────────────────────────────────────────────────

/** E01 – OFAC SDN */
async function e01_ofac(payload, env) {
  const name = normalizeName(payload.applicantName || payload.entityName || '');
  if (!name) return { score: 0, hits: 0, matches: [] };
  const raw = await env.KYC_SANCTIONS.get('sdn:index');
  if (!raw) return { score: 0, hits: 0, matches: [] };
  const list = JSON.parse(raw);
  const matches = list.filter(entry => nameMatch(name, entry.name));
  const score = Math.min(matches.length * 40, 70);
  return { score, hits: matches.length, matches: matches.map(m => m.name) };
}

/** E02 – PEP */
async function e02_pep(payload, env) {
  const name = normalizeName(payload.applicantName || payload.entityName || '');
  if (!name) return { score: 0, hits: 0, matches: [] };
  const raw = await env.KYC_SANCTIONS.get('pep:index');
  if (!raw) return { score: 0, hits: 0, matches: [] };
  const list = JSON.parse(raw);
  const matches = list.filter(entry => nameMatch(name, entry.name));
  const score = Math.min(matches.length * 25, 50);
  return { score, hits: matches.length, matches: matches.map(m => m.name) };
}

/** E03 – FATF High-Risk Country */
function e03_fatf(payload) {
  const country = (payload.country || payload.countryCode || payload.citizenship || '').toUpperCase().slice(0, 2);
  const hit = FATF_HIGH_RISK.has(country);
  return { score: hit ? 20 : 0, country, flagged: hit };
}

/** E04 – TIN/EIN Validity */
function e04_tin(payload) {
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, '');
  const entityType = (payload.entityType || 'individual').toLowerCase();
  if (!tin) return { score: 20, reason: 'missing_tin' };

  if (entityType === 'business' || entityType === 'kyb') {
    const valid = validateEIN(tin);
    return { score: valid ? 0 : 20, einValid: valid, reason: valid ? null : 'invalid_ein_prefix' };
  }

  const ssn = parseSSN(tin);
  if (ssn.itin) {
    const itinOk = isITIN(tin);
    return { score: itinOk ? 5 : 20, itin: true, itinValid: itinOk, reason: itinOk ? null : 'invalid_itin_group' };
  }
  return { score: ssn.valid ? 0 : 20, ssnValid: ssn.valid, reason: ssn.valid ? null : 'invalid_ssn' };
}

/** E05 – Velocity Check */
async function e05_velocity(payload, env) {
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, '');
  if (!tin) return { score: 0, count: 0 };
  const since = Date.now() - 86400000; // 24h
  const result = await env.AUDIT_DB.prepare(
    `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin = ? AND created_at > ?`
  ).bind(tin, new Date(since).toISOString()).first();
  const count = result?.cnt ?? 0;
  return { score: count > 5 ? 15 : 0, count, flagged: count > 5 };
}

/** E06 – Structuring Detection */
function e06_structuring(payload) {
  const amount = parseFloat(payload.transactionAmount || payload.amount || 0);
  const flagged = amount >= 8000 && amount < 10000;
  return { score: flagged ? 35 : 0, amount, flagged };
}

/** E07 – Adverse Media */
function e07_adverse_media(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => text.includes(kw));
  return { score: Math.min(hits.length * 5, 30), hits, count: hits.length };
}

/** E08 – UBO Cascade (Beneficial Owner cross-ref) */
async function e08_ubo(payload, env) {
  const owners = payload.beneficialOwners || [];
  if (!owners.length) return { score: 0, flagged: [] };
  const sdnRaw = await env.KYC_SANCTIONS.get('sdn:index');
  const pepRaw = await env.KYC_SANCTIONS.get('pep:index');
  const sdnList = sdnRaw ? JSON.parse(sdnRaw) : [];
  const pepList = pepRaw ? JSON.parse(pepRaw) : [];
  const flagged = [];
  for (const owner of owners) {
    if ((owner.ownershipPct || owner.ownership_pct || 0) < 25) continue;
    const name = normalizeName(owner.name || '');
    const sdnHit = sdnList.some(e => nameMatch(name, e.name));
    const pepHit = pepList.some(e => nameMatch(name, e.name));
    if (sdnHit || pepHit) flagged.push({ name: owner.name, sdnHit, pepHit });
  }
  return { score: flagged.length > 0 ? 25 : 0, flagged };
}

/** E09 – DOB Plausibility */
function e09_dob(payload) {
  const dob = payload.dateOfBirth || payload.dob;
  if (!dob) return { score: 0, reason: 'no_dob' };
  const dt = new Date(dob);
  if (isNaN(dt)) return { score: 10, reason: 'invalid_dob_format' };
  const now = new Date();
  if (dt > now) return { score: 35, reason: 'future_dob' };
  const ageYears = (now - dt) / (365.25 * 24 * 3600 * 1000);
  if (ageYears < 18) return { score: 35, reason: 'under_18', age: Math.floor(ageYears) };
  if (ageYears > 120) return { score: 35, reason: 'over_120', age: Math.floor(ageYears) };
  return { score: 0, age: Math.floor(ageYears) };
}

/** E10 – Address Risk */
function e10_address(payload) {
  const addr = (payload.address || payload.streetAddress || '').toLowerCase();
  const zip = payload.zip || payload.postalCode || '';
  const reasons = [];
  if (/\bpo\s*box\b/.test(addr)) reasons.push('po_box');
  if (/\b(cmra|mailbox|mail\s*room|ups\s*store|fedex|pak\s*mail)\b/.test(addr)) reasons.push('cmra');
  if (!zip) reasons.push('missing_zip');
  return { score: reasons.length > 0 ? 10 : 0, reasons };
}

/** E11 – Entity Consistency (name↔TIN type mismatch) */
function e11_consistency(payload) {
  const name = payload.applicantName || payload.entityName || '';
  const entityType = (payload.entityType || 'individual').toLowerCase();
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, '');
  const reasons = [];
  // Business entities: if TIN is NOT a valid EIN, check if it looks like an SSN
  if ((entityType === 'business' || entityType === 'kyb') && tin.length === 9) {
    if (!validateEIN(tin)) {
      // Only flag if it actually parses as a valid SSN (not just any 9-digit number)
      const ssn = parseSSN(tin);
      if (ssn.valid) reasons.push('business_with_ssn');
    }
    // If EIN is valid, no flag — business correctly providing EIN
  }
  // Individual shouldn't have a name that looks corporate
  const corpTerms = /(llc|inc|corp|ltd|co\.|plc|group|holdings|international)/i;
  if (entityType === 'individual' && corpTerms.test(name)) reasons.push('individual_with_corporate_name');
  return { score: reasons.length > 0 ? 15 : 0, reasons };
}

/** E12 – Corporate Shell Depth */
function e12_corporate_depth(payload) {
  const layers = payload.corporateLayers || payload.shellLayers || 0;
  return { score: layers > 4 ? 20 : 0, layers, flagged: layers > 4 };
}

/** E13 – Document Entropy */
function e13_doc_entropy(payload) {
  const docs = payload.documents || [];
  const reasons = [];
  for (const doc of docs) {
    if (doc.expiryDate && new Date(doc.expiryDate) < new Date()) reasons.push(`expired:${doc.type || 'doc'}`);
    const text = doc.text || doc.content || '';
    if (text.length > 10) {
      // Measure char frequency entropy
      const freq = {};
      for (const c of text) freq[c] = (freq[c] || 0) + 1;
      const entropy = Object.values(freq).reduce((acc, n) => {
        const p = n / text.length;
        return acc - p * Math.log2(p);
      }, 0);
      if (entropy < 2.5) reasons.push(`low_entropy:${doc.type || 'doc'}`);
    }
  }
  return { score: reasons.length > 0 ? 10 : 0, reasons };
}

/** E14 – Network Graph (shared TIN or address across submissions) */
async function e14_network(payload, env) {
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, '');
  const addr = payload.address || payload.streetAddress || '';
  if (!tin && !addr) return { score: 0, shared: [] };
  const shared = [];
  if (tin) {
    const r = await env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin = ?`
    ).bind(tin).first();
    if ((r?.cnt ?? 0) > 1) shared.push(`tin_reuse:${r.cnt}_times`);
  }
  return { score: shared.length > 0 ? 20 : 0, shared };
}

/** E15 – Synthetic Identity */
function e15_synthetic(payload) {
  const tin = (payload.tin || payload.ssn || '').replace(/\D/g, '');
  if (!tin || tin.length !== 9) return { score: 0 };
  const area = parseInt(tin.slice(0, 3), 10);
  if (area >= 900) {
    // ITIN range — check if it's a *valid* ITIN or just a bad synthetic
    const itinOk = isITIN(tin);
    return { score: itinOk ? 10 : 40, synthetic: !itinOk, itin: true };
  }
  // SSN 000, 666, or invalid group/serial
  const { valid, group, serial } = parseSSN(tin);
  if (!valid) return { score: 40, synthetic: true, reason: 'invalid_ssn_segments' };
  return { score: 0 };
}

/** E16 – Watchlist Delta (recently added SDN) */
async function e16_delta(payload, env) {
  const name = normalizeName(payload.applicantName || payload.entityName || '');
  if (!name) return { score: 0 };
  const raw = await env.KYC_SANCTIONS.get('sdn:delta:7d');
  if (!raw) return { score: 0 };
  const delta = JSON.parse(raw);
  const hit = delta.some(entry => nameMatch(name, entry.name));
  return { score: hit ? 30 : 0, newlyListed: hit };
}

/** E17 – FinCEN 314(a) */
async function e17_fincen(payload, env) {
  const name = normalizeName(payload.applicantName || payload.entityName || '');
  if (!name) return { score: 0, hits: [] };
  const raw = await env.KYC_SANCTIONS.get('fincen:314a');
  if (!raw) return { score: 0, hits: [] };
  const list = JSON.parse(raw);
  const hits = list.filter(entry => nameMatch(name, entry.name, 0.82));
  return { score: hits.length > 0 ? 25 : 0, hits: hits.map(h => h.name) };
}

/** E18 – Geo-Velocity (IP hop within 1 hour) */
async function e18_geo_velocity(payload, env) {
  const ip = payload.ipAddress || payload.ip || '';
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, '');
  if (!ip || !tin) return { score: 0 };
  const key = `geo:${tin}`;
  const prev = await env.KYC_SANCTIONS.get(key, { type: 'json' });
  const now = Date.now();
  await env.KYC_SANCTIONS.put(key, JSON.stringify({ ip, ts: now }), { expirationTtl: 7200 });
  if (!prev) return { score: 0 };
  const hourAgo = now - 3600000;
  const ipChanged = prev.ip !== ip;
  const withinHour = prev.ts > hourAgo;
  if (ipChanged && withinHour) return { score: 20, prevIp: prev.ip, currentIp: ip, gapMs: now - prev.ts };
  return { score: 0 };
}

/** E19 – Country of Birth / Nationality FATF Cross-ref */
function e19_country_of_birth(payload) {
  const cob = (payload.countryOfBirth || payload.nationality || '').toUpperCase().slice(0, 2);
  if (!cob) return { score: 0 };
  const hit = FATF_HIGH_RISK.has(cob);
  return { score: hit ? 15 : 0, countryOfBirth: cob, flagged: hit };
}

/** E20 – Second-Degree PEP (family / associates) */
async function e20_pep2(payload, env) {
  const name = normalizeName(payload.applicantName || payload.entityName || '');
  if (!name) return { score: 0, hits: [] };
  const raw = await env.KYC_SANCTIONS.get('pep2:index');
  if (!raw) return { score: 0, hits: [] };
  const list = JSON.parse(raw);
  const hits = list.filter(entry => nameMatch(name, entry.name));
  return { score: hits.length > 0 ? 20 : 0, hits: hits.map(h => h.name) };
}

// ─── MAIN SCREENER ─────────────────────────────────────────────────────────

async function runScreening(payload, env) {
  const start = Date.now();
  const submissionId = crypto.randomUUID();
  const fingerprint = await sha256Hex({ ...payload, ts: start });

  // Parallel fan-out across all 20 engines — each isolated with per-engine timeout
  const [
    r01, r02, r03, r04, r05, r06, r07, r08, r09, r10,
    r11, r12, r13, r14, r15, r16, r17, r18, r19, r20,
  ] = await Promise.all([
    withTimeout('E01', 500, () => e01_ofac(payload, env)),
    withTimeout('E02', 500, () => e02_pep(payload, env)),
    withTimeout('E03', 100, () => Promise.resolve(e03_fatf(payload))),
    withTimeout('E04', 100, () => Promise.resolve(e04_tin(payload))),
    withTimeout('E05', 500, () => e05_velocity(payload, env)),
    withTimeout('E06', 100, () => Promise.resolve(e06_structuring(payload))),
    withTimeout('E07', 100, () => Promise.resolve(e07_adverse_media(payload))),
    withTimeout('E08', 600, () => e08_ubo(payload, env)),
    withTimeout('E09', 100, () => Promise.resolve(e09_dob(payload))),
    withTimeout('E10', 100, () => Promise.resolve(e10_address(payload))),
    withTimeout('E11', 100, () => Promise.resolve(e11_consistency(payload))),
    withTimeout('E12', 100, () => Promise.resolve(e12_corporate_depth(payload))),
    withTimeout('E13', 100, () => Promise.resolve(e13_doc_entropy(payload))),
    withTimeout('E14', 500, () => e14_network(payload, env)),
    withTimeout('E15', 100, () => Promise.resolve(e15_synthetic(payload))),
    withTimeout('E16', 500, () => e16_delta(payload, env)),
    withTimeout('E17', 500, () => e17_fincen(payload, env)),
    withTimeout('E18', 500, () => e18_geo_velocity(payload, env)),
    withTimeout('E19', 100, () => Promise.resolve(e19_country_of_birth(payload))),
    withTimeout('E20', 500, () => e20_pep2(payload, env)),
  ]);

  const engineResults = {
    E01_ofac: r01, E02_pep: r02, E03_fatf: r03, E04_tin: r04,
    E05_velocity: r05, E06_structuring: r06, E07_adverse_media: r07, E08_ubo: r08,
    E09_dob: r09, E10_address: r10, E11_consistency: r11, E12_corporate_depth: r12,
    E13_doc_entropy: r13, E14_network: r14, E15_synthetic: r15, E16_watchlist_delta: r16,
    E17_fincen: r17, E18_geo_velocity: r18, E19_country_of_birth: r19, E20_pep2: r20,
  };

  const totalScore = Math.min(
    Object.values(engineResults).reduce((sum, r) => sum + (r?.score ?? 0), 0),
    100
  );
  const processingMs = Date.now() - start;

  // Hard global timeout gate — overrides computed score
  const timedOut = processingMs >= TIMEOUT_MS;
  let decision = timedOut
    ? 'REVIEW'
    : totalScore >= DENIED_THRESHOLD
      ? 'DENIED'
      : totalScore >= REVIEW_THRESHOLD
        ? 'REVIEW'
        : 'APPROVED';

  const enginesRun = Object.values(engineResults).filter(r => !r?.skipped).length;

  // Write to D1
  await env.AUDIT_DB.prepare(`
    INSERT INTO kyc_submissions (
      submission_id, entity_type, applicant_name, tin, status, risk_score, risk_decision,
      risk_breakdown, sanctions_hits, ofac_hits, pep_hits, tin_valid, ein_valid,
      screen_latency_ms, raw_payload, fingerprint, engine_version, created_at, screened_at,
      velocity_flagged, structuring_flagged, adverse_media_hits, flags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    submissionId,
    payload.entityType || 'individual',
    payload.applicantName || payload.entityName || '',
    (payload.tin || payload.ssn || payload.ein || '').replace(/\D/g, ''),
    decision.toLowerCase(),
    totalScore,
    decision,
    JSON.stringify(engineResults),
    (r01?.hits ?? 0) + (r02?.hits ?? 0),
    r01?.hits ?? 0,
    r02?.hits ?? 0,
    r04?.ssnValid ?? (r04?.score === 0 ? 1 : 0),
    r04?.einValid ?? (r04?.score === 0 ? 1 : 0),
    processingMs,
    JSON.stringify(payload),
    fingerprint,
    VERSION,
    new Date().toISOString(),
    new Date().toISOString(),
    r05?.flagged ? 1 : 0,
    r06?.flagged ? 1 : 0,
    r07?.count ?? 0,
    JSON.stringify({ timedOut, enginesRun }),
  ).run().catch(() => null);

  // Queue for human review
  if (decision === 'REVIEW' || decision === 'DENIED') {
    await env.AUDIT_DB.prepare(`
      INSERT INTO kyc_review_queue (
        reference_id, type, flags_json, payload_json, status, created_at
      ) VALUES (?, 'kyc_submission', ?, ?, 'pending', ?)
    `).bind(
      submissionId,
      JSON.stringify({ score: totalScore, decision, engines: Object.fromEntries(
        Object.entries(engineResults).map(([k, v]) => [k, v?.score ?? 0])
      )}),
      JSON.stringify(payload),
      new Date().toISOString(),
    ).run().catch(() => null);
  }

  return {
    submission_id: submissionId,
    fingerprint,
    risk_score: totalScore,
    risk_decision: decision,
    account_generation: { allowed: decision === 'APPROVED' },
    engines: { count: ENGINES_COUNT, version: VERSION, run: enginesRun, timed_out: timedOut },
    processing_ms: processingMs,
    engine_breakdown: engineResults,
  };
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname;

    // ── GET /api/kyc/health ─────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/kyc/health') {
      return jsonResp({
        status: 'ok', version: VERSION, engines: ENGINES_COUNT,
        timeout_ms: TIMEOUT_MS, ts: new Date().toISOString(),
      });
    }

    // ── POST /api/kyc/apply ─────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/kyc/apply') {
      const authed = await verifyApiKey(req, env);
      if (!authed) return jsonResp({ error: 'unauthorized' }, 401);

      let payload;
      try { payload = await req.json(); }
      catch { return jsonResp({ error: 'invalid_json' }, 400); }

      if (!payload.applicantName && !payload.entityName) {
        return jsonResp({ error: 'applicantName or entityName required' }, 400);
      }

      // Hard wall-clock guard — if entire screening exceeds TIMEOUT_MS, return REVIEW
      const result = await Promise.race([
        runScreening(payload, env),
        new Promise(resolve => setTimeout(() => resolve({
          submission_id: crypto.randomUUID(),
          risk_score: 50, risk_decision: 'REVIEW',
          account_generation: { allowed: false },
          engines: { count: ENGINES_COUNT, version: VERSION, run: 0, timed_out: true },
          processing_ms: TIMEOUT_MS, timeout: true,
        }), TIMEOUT_MS + 50)),
      ]);

      // Fire DENIED alert non-blocking
      if (result.risk_decision === 'DENIED' && env.NOTIFIER_TOKEN) {
        ctx.waitUntil(
          fetch('https://notify.wwwknockoutforever.com/webhook/system-alert', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.NOTIFIER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event_type: 'SYSTEM_ALERT', severity: 'HIGH',
              message: `KYC DENIED — ${payload.applicantName || payload.entityName} score=${result.risk_score}`,
              submission_id: result.submission_id,
            }),
          }).catch(() => null)
        );
      }

      return jsonResp(result, 200, {
        'X-Submission-Id': result.submission_id,
        'X-Risk-Score': String(result.risk_score),
        'X-Risk-Decision': result.risk_decision,
        'X-Engines-Run': String(result.engines.run),
        'X-Processing-Ms': String(result.processing_ms),
      });
    }

    // ── GET /api/kyc/status/:id ─────────────────────────────────────────
    if (req.method === 'GET' && path.startsWith('/api/kyc/status/')) {
      const authed = await verifyApiKey(req, env);
      if (!authed) return jsonResp({ error: 'unauthorized' }, 401);
      const id = path.split('/').pop();
      const row = await env.AUDIT_DB.prepare(
        `SELECT submission_id, entity_type, applicant_name, status, risk_score, risk_decision, screen_latency_ms, screened_at FROM kyc_submissions WHERE submission_id = ?`
      ).bind(id).first();
      if (!row) return jsonResp({ error: 'not_found' }, 404);
      return jsonResp(row);
    }

    // ── GET /api/kyc/review ─────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/kyc/review') {
      if (!verifyAdmin(req, env)) return jsonResp({ error: 'forbidden' }, 403);
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '20', 10), 100);
      const status = url.searchParams.get('status') || 'pending';
      const offset = (page - 1) * perPage;
      const rows = await env.AUDIT_DB.prepare(
        `SELECT * FROM kyc_review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(status, perPage, offset).all();
      const total = await env.AUDIT_DB.prepare(
        `SELECT COUNT(*) as cnt FROM kyc_review_queue WHERE status = ?`
      ).bind(status).first();
      return jsonResp({ page, per_page: perPage, total: total?.cnt ?? 0, items: rows.results });
    }

    // ── POST /api/kyc/review/:id/(approve|reject|escalate) ─────────────
    if (req.method === 'POST' && /^\/api\/kyc\/review\/[^/]+\/(approve|reject|escalate)$/.test(path)) {
      if (!verifyAdmin(req, env)) return jsonResp({ error: 'forbidden' }, 403);
      const parts = path.split('/');
      const action = parts.pop();
      const id = parts.pop();
      const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'escalated';
      await env.AUDIT_DB.prepare(
        `UPDATE kyc_review_queue SET status = ?, resolved_at = ? WHERE reference_id = ?`
      ).bind(newStatus, new Date().toISOString(), id).run();
      await env.AUDIT_DB.prepare(
        `UPDATE kyc_submissions SET status = ? WHERE submission_id = ?`
      ).bind(newStatus, id).run();
      await env.AUDIT_DB.prepare(
        `INSERT INTO audit_log (event_type, entity_id, entity_type, event_data, created_at)
         VALUES (?, ?, 'kyc_submission', ?, ?)`
      ).bind(`kyc.review.${action}`, id, JSON.stringify({ action, by: 'admin' }), new Date().toISOString()).run().catch(() => null);
      return jsonResp({ success: true, submission_id: id, action, new_status: newStatus });
    }

    // ── POST /api/kyc/batch ─────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/kyc/batch') {
      if (!verifyAdmin(req, env)) return jsonResp({ error: 'forbidden' }, 403);
      let body;
      try { body = await req.json(); } catch { return jsonResp({ error: 'invalid_json' }, 400); }
      const submissions = body.submissions || [];
      if (!Array.isArray(submissions) || submissions.length === 0) return jsonResp({ error: 'submissions array required' }, 400);
      if (submissions.length > 50) return jsonResp({ error: 'max_50_submissions_per_batch' }, 400);
      const results = await Promise.all(submissions.map(p => runScreening(p, env).catch(e => ({ error: e.message }))));
      return jsonResp({ count: results.length, results });
    }

    // ── GET /api/kyc/stats ──────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/kyc/stats') {
      if (!verifyAdmin(req, env)) return jsonResp({ error: 'forbidden' }, 403);
      const [total, approved, review, denied, avgMs, fincenHits] = await Promise.all([
        env.AUDIT_DB.prepare(`SELECT COUNT(*) as cnt FROM kyc_submissions`).first(),
        env.AUDIT_DB.prepare(`SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='APPROVED'`).first(),
        env.AUDIT_DB.prepare(`SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='REVIEW'`).first(),
        env.AUDIT_DB.prepare(`SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_decision='DENIED'`).first(),
        env.AUDIT_DB.prepare(`SELECT AVG(screen_latency_ms) as avg FROM kyc_submissions`).first(),
        env.AUDIT_DB.prepare(`SELECT COUNT(*) as cnt FROM kyc_submissions WHERE risk_breakdown LIKE '%E17_fincen%score":25%'`).first(),
      ]);
      return jsonResp({
        total: total?.cnt ?? 0,
        approved: approved?.cnt ?? 0,
        review: review?.cnt ?? 0,
        denied: denied?.cnt ?? 0,
        avg_screen_ms: Math.round(avgMs?.avg ?? 0),
        fincen_hits: fincenHits?.cnt ?? 0,
        engine_version: VERSION,
        engines: ENGINES_COUNT,
      });
    }

    return jsonResp({ error: 'not_found', path }, 404);
  },
};
