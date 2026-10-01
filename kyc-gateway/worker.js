/**
 * kyc-gateway v15.0
 * Sub-2-second KYC/KYB Intake Screening
 * 22 Compliance Engines | Promise.all() parallel fan-out | Cloudflare Workers ES Module
 *
 * Engines:
 *   E01  OFAC SDN Name Match         40 pts  (Jaro-Winkler ≥0.82 OR token-set ≥0.80)
 *   E02  PEP Cross-Reference         25 pts  (fuzzy name, cap 50)
 *   E03  FATF High-Risk Country      20 pts  (58 jurisdictions)
 *   E04  TIN/EIN Validation          20 pts  (IRS rules, disallowed prefixes)
 *   E05  Velocity / Replay Guard     15 pts  (>5 submissions/TIN/24h)
 *   E06  Structuring Detector        35 pts  ($8,000–$9,999 band)
 *   E07  Adverse Media               5 pts/kw cap 30
 *   E08  UBO Cascade                 25 pts  (≥25% beneficial owner, SDN+PEP cross-ref)
 *   E09  DOB Plausibility            35 pts  (future | under-18 | over-120)
 *   E10  Address Risk                10 pts  (PO Box / CMRA / known drop addr)
 *   E11  Entity Consistency          15 pts  (individual TIN used for business)
 *   E12  Corporate Depth             20 pts  (>4 ownership layers)
 *   E13  Document Entropy            10 pts  (missing/expired docs)
 *   E14  Network Graph               20 pts  (shared TIN or address across submissions)
 *   E15  Synthetic Identity          40 pts  (SSN area 900+ | ITIN IRS group rules)
 *   E16  Watchlist Delta             30 pts  (newly-added SDN in last 7 days)
 *   E17  FinCEN 314(a)               25 pts  (JW ≥0.82 OR token-set ≥0.80)
 *   E18  Geo-Velocity                20 pts  (IP jurisdiction hop <1h)
 *   E19  Country-of-Birth FATF       15 pts  (nationality cross-ref on COB field)
 *   E20  Second-Degree PEP Network   20 pts  (family/associates pep2:index)
 *   E21  ITIN Expiry / Renewal Flag  10 pts  (ITIN older than 3 years without renewal)
 *   E22  Adverse-Country Pair        25 pts  (address country ≠ nationality AND both FATF)
 *
 * Decision bands: 0-29 APPROVED | 30-69 REVIEW | 70-100 DENIED
 * Hard timeout:   1750ms → auto-REVIEW
 *
 * Routes:
 *   POST /api/kyc/apply
 *   GET  /api/kyc/status/:id
 *   GET  /api/kyc/review            (admin)
 *   POST /api/kyc/review/:id/approve|reject|escalate  (admin)
 *   POST /api/kyc/batch             (admin, ≤50)
 *   GET  /api/kyc/stats             (admin)
 *   GET  /api/kyc/health
 *
 * Bindings: AUDIT_DB (D1), KYC_SANCTIONS (KV), GATEWAY_AUTH (KV)
 * Secrets:  KYC_ADMIN_KEY, NOTIFIER_TOKEN
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const VERSION      = '15.0.0';
const ENGINE_COUNT = 22;
const TIMEOUT_MS   = 1750;
const APPROVE_MAX  = 29;
const REVIEW_MAX   = 69;

const FATF_HIGH_RISK = new Set([
  'AF','AL','AO','BB','BF','BJ','BI','CM','CD','CF','CG','CU','ET','GH','GN','GW','GY',
  'HT','IQ','IR','KP','LB','LR','LY','ML','MM','MR','MZ','NE','NG','PA','PK','PH','RU',
  'SD','SL','SN','SO','SS','SY','TG','TJ','TM','TT','TR','UA','UG','VE','VU','YE','ZW',
  'BY','KZ','UZ','AZ','AM','GE','KG'
]);

const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','trafficking','sanction','cartel',
  'corruption','bribery','ponzi','embezzlement','cybercrime','darknet',
  'narco','smuggling','extortion','organized crime'
];

const EIN_DISALLOWED_PREFIX = new Set([
  '07','08','09','17','18','19','28','29','49','69','70','78','79','89'
]);

// ITIN area numbers that are valid (IRS-assigned)
// ITINs start with 9. Middle two digits (group) 70-88, 90-92, 94-99 are valid
const ITIN_VALID_GROUPS = (() => {
  const g = new Set();
  for (let i = 70; i <= 88; i++) g.add(String(i));
  for (let i = 90; i <= 92; i++) g.add(String(i));
  for (let i = 94; i <= 99; i++) g.add(String(i));
  return g;
})();

// ── Helpers ────────────────────────────────────────────────────────────────────

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  h.set('Access-Control-Expose-Headers', 'X-Submission-Id,X-Risk-Score,X-Risk-Decision,X-Engine-Version');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(body, status = 200, extra = {}) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra }
  }));
}

function uid() {
  return crypto.randomUUID();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Jaro-Winkler similarity (0–1)
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = s1.toLowerCase(); s2 = s2.toLowerCase();
  if (s1 === s2) return 1;
  const len1 = s1.length, len2 = s2.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
  if (matchDist < 0) return 0;
  const s1m = Array(len1).fill(false), s2m = Array(len2).fill(false);
  let matches = 0, trans = 0;
  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - matchDist), hi = Math.min(i + matchDist + 1, len2);
    for (let j = lo; j < hi; j++) {
      if (!s2m[j] && s1[i] === s2[j]) { s1m[i] = s2m[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (s1m[i]) {
      while (!s2m[k]) k++;
      if (s1[i] !== s2[k]) trans++;
      k++;
    }
  }
  const jaro = (matches / len1 + matches / len2 + (matches - trans / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Token-set similarity
function tokenSetSim(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.toLowerCase().split(/\s+/));
  const tb = new Set(b.toLowerCase().split(/\s+/));
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

// Strip suffixes/titles before matching
function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v|llc|inc|corp|ltd|co|plc|group|holdings|international|intl|trust|foundation|the)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fuzzy name match against a list string
function fuzzyMatch(name, listStr, threshold = 0.82) {
  if (!name || !listStr) return false;
  const norm = normalizeName(name);
  const entries = listStr.split('\n').map(e => normalizeName(e.trim())).filter(Boolean);
  for (const entry of entries) {
    if (jaroWinkler(norm, entry) >= threshold || tokenSetSim(norm, entry) >= 0.80) return true;
  }
  return false;
}

// ── TIN Validation ─────────────────────────────────────────────────────────────

function validateSSN(ssn) {
  const d = ssn.replace(/[^0-9]/g, '');
  if (d.length !== 9) return { valid: false, reason: 'bad_length' };
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5); // serial = last 4 digits
  // ITIN check FIRST: area 900-999 = IRS-assigned ITIN range
  if (parseInt(area) >= 900) {
    if (area === '999' && group === '99') return { valid: false, reason: 'blacklisted_itin' };
    if (!ITIN_VALID_GROUPS.has(group)) return { valid: false, reason: 'invalid_itin_group' };
    return { valid: true, isITIN: true };
  }
  // SSN-specific invalids
  if (area === '000' || area === '666') return { valid: false, reason: 'invalid_area' };
  if (group === '00') return { valid: false, reason: 'zero_group' };
  if (serial === '0000') return { valid: false, reason: 'zero_serial' };
  if (d === '123456789' || d === '111111111' || d === '999999999')
    return { valid: false, reason: 'blacklisted' };
  return { valid: true, isITIN: false };
}

function validateEIN(ein) {
  const d = ein.replace(/[^0-9]/g, '');
  if (d.length !== 9) return { valid: false, reason: 'bad_length' };
  const prefix = d.slice(0, 2);
  if (EIN_DISALLOWED_PREFIX.has(prefix)) return { valid: false, reason: 'disallowed_prefix' };
  return { valid: true };
}

function validateITINExpiry(itinIssuedYear) {
  // ITINs issued before 2013 or not renewed every 3 years are expired per IRS
  if (!itinIssuedYear) return false;
  const age = new Date().getFullYear() - parseInt(itinIssuedYear);
  return age > 3;
}

// ── Engine Implementations ─────────────────────────────────────────────────────

async function engineOFAC(payload, env) {
  const sdnList = await env.KYC_SANCTIONS.get('sdn:index');
  if (!sdnList) return { score: 0, hits: [] };
  const name = payload.name || payload.business_name || '';
  if (fuzzyMatch(name, sdnList)) return { score: 40, hits: [name] };
  return { score: 0, hits: [] };
}

async function enginePEP(payload, env) {
  const pepList = await env.KYC_SANCTIONS.get('pep:index');
  if (!pepList) return { score: 0, hits: [] };
  const name = payload.name || payload.business_name || '';
  if (fuzzyMatch(name, pepList, 0.82)) return { score: 25, hits: [name] };
  return { score: 0, hits: [] };
}

async function engineFATF(payload) {
  const country = (payload.address?.country || payload.country || '').toUpperCase();
  if (FATF_HIGH_RISK.has(country)) return { score: 20, country };
  return { score: 0 };
}

async function engineTIN(payload) {
  const entityType = (payload.entity_type || 'individual').toLowerCase();
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/[^0-9]/g, '');
  if (!tin) return { score: 20, reason: 'missing_tin' };
  if (entityType === 'individual' || entityType === 'sole_prop') {
    const res = validateSSN(tin);
    if (!res.valid) return { score: 20, reason: res.reason };
    return { score: 0, isITIN: res.isITIN };
  } else {
    const res = validateEIN(tin);
    if (!res.valid) return { score: 20, reason: res.reason };
    return { score: 0 };
  }
}

async function engineVelocity(payload, env) {
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/[^0-9]/g, '');
  if (!tin) return { score: 0 };
  const key = `vel:${tin}`;
  const existing = await env.KYC_SANCTIONS.get(key);
  const count = existing ? parseInt(existing) : 0;
  // Increment (fire-and-forget)
  await env.KYC_SANCTIONS.put(key, String(count + 1), { expirationTtl: 86400 });
  if (count >= 5) return { score: 15, count: count + 1 };
  return { score: 0, count: count + 1 };
}

async function engineStructuring(payload) {
  const amount = parseFloat(payload.transaction_amount || payload.amount || 0);
  if (amount >= 8000 && amount <= 9999.99) return { score: 35, amount };
  return { score: 0 };
}

async function engineAdverseMedia(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => text.includes(kw));
  const score = Math.min(hits.length * 5, 30);
  return { score, hits };
}

async function engineUBO(payload, env) {
  const owners = payload.beneficial_owners || [];
  if (!owners.length) return { score: 0 };
  const sdnList = await env.KYC_SANCTIONS.get('sdn:index');
  const pepList = await env.KYC_SANCTIONS.get('pep:index');
  const flagged = [];
  for (const o of owners) {
    if ((o.ownership_pct || 0) < 25) continue;
    const name = o.name || '';
    const sdnHit = sdnList && fuzzyMatch(name, sdnList);
    const pepHit = pepList && fuzzyMatch(name, pepList, 0.82);
    if (sdnHit || pepHit) flagged.push({ name, sdnHit, pepHit });
  }
  return { score: flagged.length ? 25 : 0, flagged };
}

async function engineDOB(payload) {
  const dob = payload.dob || payload.date_of_birth || '';
  if (!dob) return { score: 0 };
  const d = new Date(dob);
  if (isNaN(d)) return { score: 10, reason: 'invalid_date' };
  const now = new Date();
  if (d > now) return { score: 35, reason: 'future_dob' };
  const ageYears = (now - d) / (365.25 * 24 * 3600 * 1000);
  if (ageYears < 18) return { score: 35, reason: 'under_18', age: Math.floor(ageYears) };
  if (ageYears > 120) return { score: 35, reason: 'over_120', age: Math.floor(ageYears) };
  return { score: 0, age: Math.floor(ageYears) };
}

async function engineAddressRisk(payload) {
  const addr = JSON.stringify(payload.address || {}).toLowerCase();
  const poBad = /\b(p\.?o\.?\s*box|pmb|mailbox|cmra|ups store|the ups store|fedex office|pak mail|postal center)\b/.test(addr);
  return { score: poBad ? 10 : 0, poBad };
}

async function engineEntityConsistency(payload) {
  const et = (payload.entity_type || '').toLowerCase();
  // Only flag if the payload explicitly submits an SSN field for a business entity
  // (not generic tin= which could be EIN)
  const ssn = (payload.ssn || '').replace(/[^0-9]/g, '');
  if (!ssn || !et) return { score: 0 };
  const isBusinessEntity = et === 'llc' || et === 'corporation' || et === 'business' || et === 'partnership';
  const validSSNArea = ssn.length === 9 && parseInt(ssn.slice(0, 3)) < 900 && ssn.slice(0, 3) !== '000';
  if (isBusinessEntity && validSSNArea)
    return { score: 15, reason: 'individual_ssn_on_business_entity' };
  return { score: 0 };
}

async function engineCorporateDepth(payload) {
  function countLayers(obj, depth = 0) {
    if (!obj || typeof obj !== 'object') return depth;
    if (Array.isArray(obj)) return Math.max(...obj.map(o => countLayers(o, depth)));
    if (obj.parent_entity || obj.parent) return countLayers(obj.parent_entity || obj.parent, depth + 1);
    return depth;
  }
  const depth = countLayers(payload);
  return { score: depth > 4 ? 20 : 0, depth };
}

async function engineDocumentEntropy(payload) {
  const docs = payload.documents || [];
  if (!docs.length) return { score: 10, reason: 'no_documents' };
  const now = Date.now();
  const expired = docs.filter(d => d.expiry && new Date(d.expiry) < now);
  if (expired.length) return { score: 10, reason: 'expired_document', count: expired.length };
  return { score: 0 };
}

async function engineNetworkGraph(payload, env) {
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/[^0-9]/g, '');
  const addrKey = JSON.stringify(payload.address || {}).toLowerCase().replace(/\s+/g, '');
  const netKey = `net:${tin}`;
  const addrKV = `neta:${addrKey.slice(0, 64)}`;
  const [prevTin, prevAddr] = await Promise.all([
    tin ? env.KYC_SANCTIONS.get(netKey) : Promise.resolve(null),
    addrKey ? env.KYC_SANCTIONS.get(addrKV) : Promise.resolve(null)
  ]);
  // Store for future cross-referencing
  const tasks = [];
  if (tin) tasks.push(env.KYC_SANCTIONS.put(netKey, '1', { expirationTtl: 604800 }));
  if (addrKey) tasks.push(env.KYC_SANCTIONS.put(addrKV, '1', { expirationTtl: 604800 }));
  await Promise.all(tasks);
  if (prevTin || prevAddr) return { score: 20, sharedTin: !!prevTin, sharedAddr: !!prevAddr };
  return { score: 0 };
}

async function engineSyntheticId(payload) {
  const tin = (payload.ssn || payload.tin || '').replace(/[^0-9]/g, '');
  if (!tin || tin.length !== 9) return { score: 0 };
  const area = parseInt(tin.slice(0, 3));
  if (area >= 900) return { score: 40, reason: 'synthetic_area_900plus' };
  return { score: 0 };
}

async function engineWatchlistDelta(payload, env) {
  const sdnDelta = await env.KYC_SANCTIONS.get('sdn:delta:7d');
  if (!sdnDelta) return { score: 0 };
  const name = payload.name || payload.business_name || '';
  if (fuzzyMatch(name, sdnDelta)) return { score: 30, reason: 'newly_listed' };
  return { score: 0 };
}

async function engineFinCEN314a(payload, env) {
  const list = await env.KYC_SANCTIONS.get('fincen:314a');
  if (!list) return { score: 0 };
  const name = payload.name || payload.business_name || '';
  if (fuzzyMatch(name, list)) return { score: 25, hits: [name] };
  return { score: 0 };
}

async function engineGeoVelocity(payload, env, ip) {
  if (!ip) return { score: 0 };
  const tin = (payload.tin || payload.ssn || payload.ein || '').replace(/[^0-9]/g, '');
  if (!tin) return { score: 0 };
  const geoKey = `geo:${tin}`;
  const prev = await env.KYC_SANCTIONS.get(geoKey, { type: 'json' });
  const now = Date.now();
  const ipHash = await sha256Hex(ip);
  await env.KYC_SANCTIONS.put(geoKey, JSON.stringify({ ipHash, ts: now }), { expirationTtl: 3600 });
  if (prev && prev.ipHash !== ipHash && (now - prev.ts) < 3600000) {
    return { score: 20, reason: 'ip_hop_under_1h' };
  }
  return { score: 0 };
}

async function engineCOBFATF(payload) {
  // E19: Country-of-Birth cross-ref against FATF list
  const cob = (payload.country_of_birth || payload.nationality || '').toUpperCase();
  if (cob && FATF_HIGH_RISK.has(cob)) return { score: 15, country: cob };
  return { score: 0 };
}

async function engineSecondDegreePEP(payload, env) {
  // E20: Associates / family of PEP
  const list = await env.KYC_SANCTIONS.get('pep2:index');
  if (!list) return { score: 0 };
  const name = payload.name || payload.business_name || '';
  if (fuzzyMatch(name, list, 0.82)) return { score: 20, reason: 'second_degree_pep' };
  return { score: 0 };
}

async function engineITINExpiry(payload) {
  // E21: ITIN renewal check
  const tin = (payload.ssn || payload.tin || '').replace(/[^0-9]/g, '');
  if (!tin || tin.length !== 9) return { score: 0 };
  const area = parseInt(tin.slice(0, 3));
  if (area < 900) return { score: 0 }; // Not an ITIN
  const itinIssuedYear = payload.itin_issued_year;
  if (itinIssuedYear && validateITINExpiry(itinIssuedYear)) {
    return { score: 10, reason: 'itin_expired_or_renewal_needed', issued: itinIssuedYear };
  }
  return { score: 0 };
}

async function engineAdverseCountryPair(payload) {
  // E22: Address country ≠ nationality AND both FATF high-risk
  const addrCountry = (payload.address?.country || '').toUpperCase();
  const natCountry = (payload.nationality || payload.country_of_birth || '').toUpperCase();
  if (addrCountry && natCountry && addrCountry !== natCountry &&
      FATF_HIGH_RISK.has(addrCountry) && FATF_HIGH_RISK.has(natCountry)) {
    return { score: 25, addrCountry, natCountry };
  }
  return { score: 0 };
}

// ── Core Screening Logic ───────────────────────────────────────────────────────

async function screenPayload(payload, env, ip) {
  const start = Date.now();

  // Run all 22 engines in parallel with per-engine timeout isolation
  function withTimeout(promise, ms = 400) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve({ score: 0, timeout: true }), ms))
    ]);
  }

  const [
    r01, r02, r03, r04, r05, r06, r07, r08, r09, r10, r11,
    r12, r13, r14, r15, r16, r17, r18, r19, r20, r21, r22
  ] = await Promise.all([
    withTimeout(engineOFAC(payload, env)),
    withTimeout(enginePEP(payload, env)),
    withTimeout(engineFATF(payload)),
    withTimeout(engineTIN(payload)),
    withTimeout(engineVelocity(payload, env)),
    withTimeout(engineStructuring(payload)),
    withTimeout(engineAdverseMedia(payload)),
    withTimeout(engineUBO(payload, env)),
    withTimeout(engineDOB(payload)),
    withTimeout(engineAddressRisk(payload)),
    withTimeout(engineEntityConsistency(payload)),
    withTimeout(engineCorporateDepth(payload)),
    withTimeout(engineDocumentEntropy(payload)),
    withTimeout(engineNetworkGraph(payload, env)),
    withTimeout(engineSyntheticId(payload)),
    withTimeout(engineWatchlistDelta(payload, env)),
    withTimeout(engineFinCEN314a(payload, env)),
    withTimeout(engineGeoVelocity(payload, env, ip)),
    withTimeout(engineCOBFATF(payload)),
    withTimeout(engineSecondDegreePEP(payload, env)),
    withTimeout(engineITINExpiry(payload)),
    withTimeout(engineAdverseCountryPair(payload))
  ]);

  const latency = Date.now() - start;
  const timedOut = latency >= TIMEOUT_MS;

  const rawScore = r01.score + r02.score + r03.score + r04.score + r05.score +
    r06.score + r07.score + r08.score + r09.score + r10.score + r11.score +
    r12.score + r13.score + r14.score + r15.score + r16.score + r17.score +
    r18.score + r19.score + r20.score + r21.score + r22.score;

  const risk_score = Math.min(rawScore, 100);

  let risk_decision;
  if (timedOut) {
    risk_decision = 'REVIEW';
  } else if (risk_score <= APPROVE_MAX) {
    risk_decision = 'APPROVED';
  } else if (risk_score <= REVIEW_MAX) {
    risk_decision = 'REVIEW';
  } else {
    risk_decision = 'DENIED';
  }

  const breakdown = {
    E01_ofac_sdn:            r01,
    E02_pep:                 r02,
    E03_fatf_country:        r03,
    E04_tin_validation:      r04,
    E05_velocity:            r05,
    E06_structuring:         r06,
    E07_adverse_media:       r07,
    E08_ubo_cascade:         r08,
    E09_dob_plausibility:    r09,
    E10_address_risk:        r10,
    E11_entity_consistency:  r11,
    E12_corporate_depth:     r12,
    E13_document_entropy:    r13,
    E14_network_graph:       r14,
    E15_synthetic_id:        r15,
    E16_watchlist_delta:     r16,
    E17_fincen_314a:         r17,
    E18_geo_velocity:        r18,
    E19_cob_fatf:            r19,
    E20_second_degree_pep:   r20,
    E21_itin_expiry:         r21,
    E22_adverse_country_pair: r22
  };

  return { risk_score, risk_decision, breakdown, latency_ms: latency, timed_out: timedOut };
}

// ── Auth Helpers ───────────────────────────────────────────────────────────────

async function authUser(request, env) {
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!apiKey) return false;
  const stored = await env.GATEWAY_AUTH.get(`apikey:${apiKey}`);
  return !!stored;
}

function authAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
  return key === env.KYC_ADMIN_KEY;
}

// ── D1 Persistence ─────────────────────────────────────────────────────────────

async function persistSubmission(db, submissionId, payload, result) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT OR IGNORE INTO kyc_submissions
      (submission_id, entity_type, applicant_name, tin, status, risk_score, risk_decision,
       risk_breakdown, sanctions_hits, ofac_hits, pep_hits, tin_valid, screen_latency_ms,
       raw_payload, screened_at, created_at, flags_json, velocity_flagged, structuring_flagged,
       adverse_media_hits, engine_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    submissionId,
    payload.entity_type || 'individual',
    payload.name || payload.business_name || '',
    (payload.tin || payload.ssn || payload.ein || '').replace(/[^0-9]/g, '').slice(0, 9),
    result.risk_decision,
    result.risk_score,
    result.risk_decision,
    JSON.stringify(result.breakdown),
    (result.breakdown.E01_ofac_sdn?.hits?.length || 0) + (result.breakdown.E17_fincen_314a?.hits?.length || 0),
    result.breakdown.E01_ofac_sdn?.hits?.length || 0,
    result.breakdown.E02_pep?.hits?.length || 0,
    result.breakdown.E04_tin_validation?.score === 0 ? 1 : 0,
    result.latency_ms,
    JSON.stringify(payload),
    now,
    now,
    JSON.stringify({ timed_out: result.timed_out }),
    result.breakdown.E05_velocity?.score > 0 ? 1 : 0,
    result.breakdown.E06_structuring?.score > 0 ? 1 : 0,
    result.breakdown.E07_adverse_media?.hits?.length || 0,
    VERSION
  ).run();
}

async function enqueueReview(db, submissionId, payload, result) {
  await db.prepare(`
    INSERT OR IGNORE INTO kyc_review_queue
      (reference_id, type, flags_json, payload_json, status)
    VALUES (?,?,?,?,?)
  `).bind(
    submissionId,
    result.risk_decision,
    JSON.stringify(Object.entries(result.breakdown)
      .filter(([, v]) => v.score > 0)
      .map(([k, v]) => ({ engine: k, score: v.score }))),
    JSON.stringify(payload),
    'pending'
  ).run();
}

async function writeAuditLog(db, eventType, entityId, detail) {
  await db.prepare(`
    INSERT INTO audit_log (event_id, event_type, entity_id, entity_type, detail, created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(uid(), eventType, entityId, 'kyc_submission', JSON.stringify(detail), new Date().toISOString()).run();
}

// ── Route Handlers ─────────────────────────────────────────────────────────────

async function handleApply(request, env, ctx) {
  const authed = await authUser(request, env);
  if (!authed) return json({ error: 'Unauthorized' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!payload.name && !payload.business_name)
    return json({ error: 'name or business_name required' }, 400);

  const submissionId = uid();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const fingerprint = await sha256Hex(JSON.stringify(payload) + ip);

  // Hard timeout guard around the entire screening pass
  const screeningPromise = screenPayload(payload, env, ip);
  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve(null), TIMEOUT_MS + 100)
  );

  let result = await Promise.race([screeningPromise, timeoutPromise]);
  if (!result) {
    result = {
      risk_score: 50,
      risk_decision: 'REVIEW',
      breakdown: {},
      latency_ms: TIMEOUT_MS + 100,
      timed_out: true
    };
  }

  // Persist to D1 (non-blocking for latency)
  ctx.waitUntil((async () => {
    try {
      await persistSubmission(env.AUDIT_DB, submissionId, payload, result);
      if (result.risk_decision !== 'APPROVED') {
        await enqueueReview(env.AUDIT_DB, submissionId, payload, result);
      }
      await writeAuditLog(env.AUDIT_DB, 'kyc.screened', submissionId, {
        decision: result.risk_decision, score: result.risk_score
      });
      // Fire DENIED system alert
      if (result.risk_decision === 'DENIED' && env.NOTIFIER_TOKEN) {
        await fetch('https://notify.wwwknockoutforever.com/webhook/system-alert', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.NOTIFIER_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_type: 'SYSTEM_ALERT',
            severity: 'HIGH',
            message: `KYC DENIED: ${payload.name || payload.business_name} — score ${result.risk_score}`,
            submission_id: submissionId
          })
        }).catch(() => {});
      }
    } catch {}
  })());

  const responseHeaders = {
    'X-Submission-Id': submissionId,
    'X-Risk-Score': String(result.risk_score),
    'X-Risk-Decision': result.risk_decision,
    'X-Engine-Version': VERSION
  };

  return json({
    submission_id: submissionId,
    fingerprint,
    risk_score: result.risk_score,
    risk_decision: result.risk_decision,
    latency_ms: result.latency_ms,
    timed_out: result.timed_out,
    engines: { count: ENGINE_COUNT, version: VERSION },
    risk_breakdown: result.breakdown,
    account_generation: { allowed: result.risk_decision === 'APPROVED' },
    flags: Object.entries(result.breakdown)
      .filter(([, v]) => v.score > 0)
      .map(([k, v]) => ({ engine: k, score: v.score }))
  }, 200, responseHeaders);
}

async function handleStatus(id, env) {
  const row = await env.AUDIT_DB.prepare(
    'SELECT submission_id, status, risk_score, risk_decision, screened_at FROM kyc_submissions WHERE submission_id = ?'
  ).bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json(row);
}

async function handleReviewList(request, env) {
  if (!authAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '20'), 100);
  const status = url.searchParams.get('status') || 'pending';
  const offset = (page - 1) * perPage;
  const rows = await env.AUDIT_DB.prepare(
    'SELECT reference_id, type, status, flags_json, created_at FROM kyc_review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(status, perPage, offset).all();
  return json({ page, per_page: perPage, items: rows.results || [] });
}

async function handleReviewAction(id, action, request, env) {
  if (!authAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
  const validActions = ['approve', 'reject', 'escalate'];
  if (!validActions.includes(action)) return json({ error: 'Invalid action' }, 400);

  const statusMap = { approve: 'approved', reject: 'rejected', escalate: 'escalated' };
  const now = new Date().toISOString();

  await env.AUDIT_DB.prepare(
    'UPDATE kyc_review_queue SET status = ?, resolved_at = ? WHERE reference_id = ?'
  ).bind(statusMap[action], now, id).run();

  await env.AUDIT_DB.prepare(
    'UPDATE kyc_submissions SET status = ? WHERE submission_id = ?'
  ).bind(statusMap[action], id).run();

  await writeAuditLog(env.AUDIT_DB, `kyc.${action}`, id, { action, timestamp: now });

  return json({ submission_id: id, action, status: statusMap[action], timestamp: now });
}

async function handleBatch(request, env, ctx) {
  if (!authAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const submissions = body.submissions || [];
  if (!submissions.length || submissions.length > 50)
    return json({ error: 'submissions must be 1-50 items' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const results = await Promise.all(submissions.map(async p => {
    const id = uid();
    const result = await screenPayload(p, env, ip);
    ctx.waitUntil(persistSubmission(env.AUDIT_DB, id, p, result).catch(() => {}));
    return { submission_id: id, risk_score: result.risk_score, risk_decision: result.risk_decision, latency_ms: result.latency_ms };
  }));

  return json({ count: results.length, results });
}

async function handleStats(request, env) {
  if (!authAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
  const [total, approved, review, denied] = await Promise.all([
    env.AUDIT_DB.prepare('SELECT COUNT(*) as n FROM kyc_submissions').first(),
    env.AUDIT_DB.prepare("SELECT COUNT(*) as n FROM kyc_submissions WHERE risk_decision='APPROVED'").first(),
    env.AUDIT_DB.prepare("SELECT COUNT(*) as n FROM kyc_submissions WHERE risk_decision='REVIEW'").first(),
    env.AUDIT_DB.prepare("SELECT COUNT(*) as n FROM kyc_submissions WHERE risk_decision='DENIED'").first()
  ]);
  return json({
    total: total?.n || 0,
    approved: approved?.n || 0,
    review: review?.n || 0,
    denied: denied?.n || 0,
    engines: { count: ENGINE_COUNT, version: VERSION },
    decision_bands: { approved: '0-29', review: '30-69', denied: '70-100', timeout: 'auto-REVIEW' }
  });
}

function handleHealth() {
  return json({ status: 'ok', version: VERSION, engines: ENGINE_COUNT, timeout_ms: TIMEOUT_MS, ts: Date.now() });
}

// ── Main Fetch Handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health (unauthenticated)
    if (path === '/api/kyc/health' && method === 'GET') return handleHealth();

    // Apply
    if (path === '/api/kyc/apply' && method === 'POST') return handleApply(request, env, ctx);

    // Status
    const statusMatch = path.match(/^\/api\/kyc\/status\/([^/]+)$/);
    if (statusMatch && method === 'GET') return handleStatus(statusMatch[1], env);

    // Review list
    if (path === '/api/kyc/review' && method === 'GET') return handleReviewList(request, env);

    // Review actions
    const reviewAction = path.match(/^\/api\/kyc\/review\/([^/]+)\/(approve|reject|escalate)$/);
    if (reviewAction && method === 'POST') return handleReviewAction(reviewAction[1], reviewAction[2], request, env);

    // Batch
    if (path === '/api/kyc/batch' && method === 'POST') return handleBatch(request, env, ctx);

    // Stats
    if (path === '/api/kyc/stats' && method === 'GET') return handleStats(request, env);

    return json({ error: 'Not found', path }, 404);
  }
};
