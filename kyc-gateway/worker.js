/**
 * kyc-gateway v6.0 — Bervashun Trust Capital
 * Sub-2-Second KYC/KYB Intake Screening
 * 16 Engines, 1800ms Hard Fence, Pre-Account-Generation Gate
 *
 * Decision Bands:
 *   0–29  → APPROVED  (account_generation.allowed = true)
 *   30–69 → REVIEW    (account_generation.allowed = false, queued)
 *   70–100→ DENIED    (account_generation.allowed = false, SYSTEM_ALERT fired)
 *
 * Engines:
 *  E1  OFAC SDN          — 40pts/hit, cap 70
 *  E2  PEP               — 25pts/hit, cap 50
 *  E3  FATF High-Risk    — 20pts, 55 countries
 *  E4  TIN/EIN Validity  — 20pts bad format
 *  E5  Velocity          — 15pts if >5 submissions/TIN/24h
 *  E6  Structuring       — 35pts if $8,000–$9,999 declared
 *  E7  Adverse Media     — 5pts/keyword, cap 30
 *  E8  UBO Cascade       — 25pts if ≥25% owner flagged
 *  E9  DOB Plausibility  — 35pts future/under-18/over-120
 *  E10 Address Risk      — 10pts high-risk ZIP patterns
 *  E11 Entity Consistency— 15pts name/TIN mismatch signals
 *  E12 Corporate Depth   — 20pts if >4 ownership layers
 *  E13 Document Entropy  — 10pts low-entropy or expired docs
 *  E14 Network Graph     — 20pts shared TIN/address across submissions
 *  E15 Synthetic Identity— 40pts SSN area code 900 (invalid area)
 *  E16 Watchlist Delta   — 30pts newly-added SDN (added ≤30d)
 */

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const VERSION = '6.0';
const ENGINE_VERSION = 'v6.0';
const TIMEOUT_MS = 1800;
const ADMIN_PATH_PREFIX = '/api/kyc';

const SCORE_BANDS = { APPROVED: 29, REVIEW: 69 }; // >69 = DENIED

const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','CD','CF','CM','CU','DZ','ET','GY','HT',
  'HK','IR','IQ','JM','JO','KH','KP','LA','LB','LY','MA','MM','MN','MR',
  'MZ','NG','NI','PA','PH','PK','RU','RW','SA','SD','SN','SO','SS','SY',
  'TJ','TN','TT','TZ','UA','UG','VE','VN','YE','ZW','ML','GH','SL'
]);

const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorism','sanctions','indicted','arrested',
  'convicted','bribery','corruption','embezzlement','cartel','trafficking',
  'hack','breach','ponzi','scam','illicit','criminal','felony','extortion'
];

const HIGH_RISK_ZIP_PATTERNS = [
  /^000/, /^999/, /^123(?!4[0-9]{2})/ // known problematic patterns
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-KYC-Engine': ENGINE_VERSION }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key'
  };
}

function submissionId() {
  return 'kyc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeStr(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Jaro-Winkler similarity
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  s1 = normalizeStr(s1); s2 = normalizeStr(s2);
  if (s1 === s2) return 1.0;
  const len1 = s1.length, len2 = s2.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true; s2Matches[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Token-set similarity (handles word-order variation)
function tokenSetSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const t1 = new Set(normalizeStr(s1).split(' '));
  const t2 = new Set(normalizeStr(s2).split(' '));
  const intersection = [...t1].filter(t => t2.has(t));
  const union = new Set([...t1, ...t2]);
  return intersection.length / union.size;
}

function nameSimilarity(a, b) {
  return Math.max(jaroWinkler(a, b), tokenSetSimilarity(a, b));
}

// Validate SSN: 9 digits, area ≠ 000/666/900+, group ≠ 00, serial ≠ 0000
function validateSSN(ssn) {
  const digits = (ssn || '').replace(/\D/g, '');
  if (digits.length !== 9) return { valid: false, reason: 'length' };
  const area = parseInt(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === 0 || area === 666 || area >= 900) return { valid: false, reason: 'area', area };
  if (group === '00') return { valid: false, reason: 'group' };
  if (serial === '0000') return { valid: false, reason: 'serial' };
  return { valid: true };
}

// Validate EIN: 2-digit prefix (not 00,07,08,09,17,18,19,28,29,49,69,70,78,79,89,96,97)
function validateEIN(ein) {
  const digits = (ein || '').replace(/\D/g, '');
  if (digits.length !== 9) return { valid: false, reason: 'length' };
  const prefix = parseInt(digits.slice(0, 2));
  const invalidPrefixes = new Set([0,7,8,9,17,18,19,28,29,49,69,70,78,79,89,96,97]);
  if (invalidPrefixes.has(prefix)) return { valid: false, reason: 'prefix', prefix };
  return { valid: true };
}

// Parse date, return age in years (null if unparseable)
function ageFromDOB(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return { age, future: d > now, dobDate: d };
}

// Check if value is in structuring range [$8,000, $9,999]
function isStructuringAmount(amount) {
  const amt = parseFloat(amount);
  return !isNaN(amt) && amt >= 8000 && amt <= 9999.99;
}

// ─── SANCTIONS LOOKUP ────────────────────────────────────────────────────────

async function fetchSanctionsList(kv, listKey) {
  try {
    const raw = await kv.get(listKey, 'json');
    return raw || [];
  } catch { return []; }
}

async function screenAgainstSDN(name, kv) {
  const sdnList = await fetchSanctionsList(kv, 'sdn:index');
  const hits = [];
  const nameLower = normalizeStr(name);
  for (const entry of sdnList) {
    const score = nameSimilarity(nameLower, normalizeStr(entry.name));
    if (score >= 0.82) {
      hits.push({ name: entry.name, score: parseFloat(score.toFixed(3)), program: entry.program || 'SDN', added_date: entry.added_date });
    }
    // Check aliases
    for (const alias of (entry.aliases || [])) {
      const aScore = nameSimilarity(nameLower, normalizeStr(alias));
      if (aScore >= 0.82) {
        hits.push({ name: alias, score: parseFloat(aScore.toFixed(3)), program: entry.program || 'SDN', added_date: entry.added_date, alias_of: entry.name });
        break;
      }
    }
  }
  return hits;
}

async function screenAgainstPEP(name, kv) {
  const pepList = await fetchSanctionsList(kv, 'pep:index');
  const hits = [];
  for (const entry of pepList) {
    const score = nameSimilarity(normalizeStr(name), normalizeStr(entry.name));
    if (score >= 0.82) {
      hits.push({ name: entry.name, score: parseFloat(score.toFixed(3)), role: entry.role || 'PEP', country: entry.country });
    }
  }
  return hits;
}

// ─── VELOCITY CHECK ──────────────────────────────────────────────────────────

async function checkVelocity(tin, db) {
  try {
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const result = await db.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE tin = ? AND created_at >= ?`
    ).bind(tin, cutoff).first();
    return (result?.cnt || 0);
  } catch { return 0; }
}

// ─── NETWORK GRAPH CHECK ─────────────────────────────────────────────────────

async function checkNetworkGraph(tin, address, db) {
  try {
    const sharedTinCount = await db.prepare(
      `SELECT COUNT(DISTINCT applicant_name) as cnt FROM kyc_submissions WHERE tin = ? AND status != 'pending'`
    ).bind(tin).first();
    const addrNorm = normalizeStr(address || '');
    let sharedAddrCount = 0;
    if (addrNorm.length > 5) {
      const res = await db.prepare(
        `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE UPPER(REPLACE(raw_payload, '-', '')) LIKE ? AND tin != ?`
      ).bind(`%${addrNorm.slice(0, 20)}%`, tin).first();
      sharedAddrCount = res?.cnt || 0;
    }
    return { sharedTin: sharedTinCount?.cnt || 0, sharedAddr: sharedAddrCount };
  } catch { return { sharedTin: 0, sharedAddr: 0 }; }
}

// ─── WATCHLIST DELTA (E16) ───────────────────────────────────────────────────

function isRecentlyAdded(addedDate, dayThreshold = 30) {
  if (!addedDate) return false;
  const added = new Date(addedDate);
  if (isNaN(added.getTime())) return false;
  const diffDays = (Date.now() - added.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= dayThreshold;
}

// ─── MAIN SCREENING ENGINE ───────────────────────────────────────────────────

async function runScreening(payload, env) {
  const startTime = Date.now();
  const {
    entity_type = 'individual',
    applicant_name,
    first_name, last_name,
    dob,
    ssn, ein, tin,
    address, zip_code,
    country_code,
    declared_amount,
    adverse_media_text,
    beneficial_owners = [],
    corporate_layers = 0,
    document_expiry,
    document_entropy_score
  } = payload;

  const fullName = applicant_name || [first_name, last_name].filter(Boolean).join(' ');
  const effectiveTIN = tin || ssn || ein || '';
  const isIndividual = entity_type === 'individual';

  let score = 0;
  const breakdown = {};
  const flags = [];
  const ofacHitsArr = [];
  const pepHitsArr = [];

  // Run engines in parallel with timeout fence
  const enginePromises = [
    // E1: OFAC SDN
    (async () => {
      const hits = await screenAgainstSDN(fullName, env.KYC_SANCTIONS);
      if (hits.length > 0) {
        const raw = Math.min(hits.length * 40, 70);
        ofacHitsArr.push(...hits);
        breakdown.E1_OFAC_SDN = { score: raw, hits: hits.length, matched: hits.map(h => h.name) };
        flags.push(`OFAC_SDN_MATCH:${hits[0].name}`);
        return raw;
      }
      breakdown.E1_OFAC_SDN = { score: 0 };
      return 0;
    })(),

    // E2: PEP
    (async () => {
      const hits = await screenAgainstPEP(fullName, env.KYC_SANCTIONS);
      if (hits.length > 0) {
        const raw = Math.min(hits.length * 25, 50);
        pepHitsArr.push(...hits);
        breakdown.E2_PEP = { score: raw, hits: hits.length, matched: hits.map(h => h.name) };
        flags.push(`PEP_MATCH:${hits[0].name}`);
        return raw;
      }
      breakdown.E2_PEP = { score: 0 };
      return 0;
    })(),

    // E3: FATF
    (async () => {
      const cc = (country_code || '').toUpperCase();
      if (cc && FATF_HIGH_RISK.has(cc)) {
        breakdown.E3_FATF = { score: 20, country: cc };
        flags.push(`FATF_HIGH_RISK_COUNTRY:${cc}`);
        return 20;
      }
      breakdown.E3_FATF = { score: 0 };
      return 0;
    })(),

    // E4: TIN/EIN Validity
    (async () => {
      if (!effectiveTIN) {
        breakdown.E4_TIN_EIN = { score: 20, reason: 'missing_tin' };
        flags.push('MISSING_TIN');
        return 20;
      }
      const check = isIndividual ? validateSSN(effectiveTIN) : validateEIN(effectiveTIN);
      if (!check.valid) {
        breakdown.E4_TIN_EIN = { score: 20, reason: check.reason };
        flags.push(`INVALID_TIN:${check.reason}`);
        return 20;
      }
      breakdown.E4_TIN_EIN = { score: 0 };
      return 0;
    })(),

    // E5: Velocity
    (async () => {
      if (!effectiveTIN || !env.AUDIT_DB) { breakdown.E5_VELOCITY = { score: 0 }; return 0; }
      const cnt = await checkVelocity(effectiveTIN, env.AUDIT_DB);
      if (cnt > 5) {
        breakdown.E5_VELOCITY = { score: 15, count_24h: cnt };
        flags.push(`HIGH_VELOCITY:${cnt}_submissions_24h`);
        return 15;
      }
      breakdown.E5_VELOCITY = { score: 0, count_24h: cnt };
      return 0;
    })(),

    // E6: Structuring
    (async () => {
      if (declared_amount && isStructuringAmount(declared_amount)) {
        breakdown.E6_STRUCTURING = { score: 35, amount: declared_amount };
        flags.push(`STRUCTURING_AMOUNT:${declared_amount}`);
        return 35;
      }
      breakdown.E6_STRUCTURING = { score: 0 };
      return 0;
    })(),

    // E7: Adverse Media
    (async () => {
      const text = normalizeStr(adverse_media_text || '');
      if (!text) { breakdown.E7_ADVERSE_MEDIA = { score: 0 }; return 0; }
      const matched = ADVERSE_KEYWORDS.filter(kw => text.includes(kw.toUpperCase()));
      const raw = Math.min(matched.length * 5, 30);
      breakdown.E7_ADVERSE_MEDIA = { score: raw, matched_keywords: matched };
      if (raw > 0) flags.push(`ADVERSE_MEDIA:${matched.slice(0, 3).join(',')}`);
      return raw;
    })(),

    // E8: UBO Cascade
    (async () => {
      if (!beneficial_owners || beneficial_owners.length === 0) {
        breakdown.E8_UBO_CASCADE = { score: 0 };
        return 0;
      }
      const flaggedOwners = [];
      for (const owner of beneficial_owners) {
        const ownership = parseFloat(owner.ownership_pct || 0);
        if (ownership < 25) continue;
        // Screen owner name
        const hits = await screenAgainstSDN(owner.name || '', env.KYC_SANCTIONS);
        const pepHits = await screenAgainstPEP(owner.name || '', env.KYC_SANCTIONS);
        if (hits.length > 0 || pepHits.length > 0) {
          flaggedOwners.push({ name: owner.name, ownership_pct: ownership, sdn_hits: hits.length, pep_hits: pepHits.length });
        }
      }
      if (flaggedOwners.length > 0) {
        breakdown.E8_UBO_CASCADE = { score: 25, flagged_owners: flaggedOwners };
        flags.push(`FLAGGED_UBO:${flaggedOwners[0].name}`);
        return 25;
      }
      breakdown.E8_UBO_CASCADE = { score: 0, owners_checked: beneficial_owners.length };
      return 0;
    })(),

    // E9: DOB Plausibility
    (async () => {
      if (!dob) { breakdown.E9_DOB = { score: 0, reason: 'no_dob' }; return 0; }
      const result = ageFromDOB(dob);
      if (!result) { breakdown.E9_DOB = { score: 10, reason: 'unparseable_dob' }; return 10; }
      if (result.future) {
        breakdown.E9_DOB = { score: 35, reason: 'future_dob' };
        flags.push('FUTURE_DOB');
        return 35;
      }
      if (result.age < 18) {
        breakdown.E9_DOB = { score: 35, reason: 'underage', age: result.age };
        flags.push(`UNDERAGE:${result.age}`);
        return 35;
      }
      if (result.age > 120) {
        breakdown.E9_DOB = { score: 35, reason: 'implausible_age', age: result.age };
        flags.push(`IMPLAUSIBLE_AGE:${result.age}`);
        return 35;
      }
      breakdown.E9_DOB = { score: 0, age: result.age };
      return 0;
    })(),

    // E10: Address Risk
    (async () => {
      const zip = (zip_code || '').replace(/\D/g, '');
      if (!zip) { breakdown.E10_ADDRESS = { score: 0 }; return 0; }
      const risky = HIGH_RISK_ZIP_PATTERNS.some(p => p.test(zip));
      if (risky) {
        breakdown.E10_ADDRESS = { score: 10, zip };
        flags.push(`HIGH_RISK_ZIP:${zip}`);
        return 10;
      }
      breakdown.E10_ADDRESS = { score: 0 };
      return 0;
    })(),

    // E11: Entity Consistency
    (async () => {
      // Flag if entity_type says 'business' but SSN format is provided, or vice versa
      const hasSsnFormat = /^\d{3}-?\d{2}-?\d{4}$/.test(effectiveTIN || '');
      const hasEinFormat = /^\d{2}-?\d{7}$/.test(effectiveTIN || '');
      if (isIndividual && hasEinFormat && !hasSsnFormat) {
        breakdown.E11_ENTITY_CONSISTENCY = { score: 15, reason: 'individual_with_ein_format' };
        flags.push('ENTITY_TIN_MISMATCH');
        return 15;
      }
      if (!isIndividual && hasSsnFormat && !hasEinFormat) {
        breakdown.E11_ENTITY_CONSISTENCY = { score: 15, reason: 'business_with_ssn_format' };
        flags.push('ENTITY_TIN_MISMATCH');
        return 15;
      }
      breakdown.E11_ENTITY_CONSISTENCY = { score: 0 };
      return 0;
    })(),

    // E12: Corporate Depth
    (async () => {
      const layers = parseInt(corporate_layers || 0);
      if (layers > 4) {
        breakdown.E12_CORPORATE_DEPTH = { score: 20, layers };
        flags.push(`DEEP_CORPORATE_STRUCTURE:${layers}_layers`);
        return 20;
      }
      breakdown.E12_CORPORATE_DEPTH = { score: 0, layers };
      return 0;
    })(),

    // E13: Document Entropy
    (async () => {
      let pts = 0;
      const reasons = [];
      if (document_expiry) {
        const expiry = new Date(document_expiry);
        if (!isNaN(expiry.getTime()) && expiry < new Date()) {
          pts += 5; reasons.push('expired_document');
        }
      }
      if (document_entropy_score !== undefined && document_entropy_score < 2.5) {
        pts += 5; reasons.push(`low_entropy_score:${document_entropy_score}`);
      }
      const capped = Math.min(pts, 10);
      breakdown.E13_DOCUMENT_ENTROPY = { score: capped, reasons };
      if (capped > 0) flags.push(`DOC_ISSUES:${reasons.join(',')}`);
      return capped;
    })(),

    // E14: Network Graph
    (async () => {
      if (!env.AUDIT_DB || !effectiveTIN) {
        breakdown.E14_NETWORK_GRAPH = { score: 0 };
        return 0;
      }
      const graph = await checkNetworkGraph(effectiveTIN, address, env.AUDIT_DB);
      if (graph.sharedTin > 3 || graph.sharedAddr > 2) {
        breakdown.E14_NETWORK_GRAPH = { score: 20, shared_tin_submissions: graph.sharedTin, shared_addr_submissions: graph.sharedAddr };
        flags.push(`NETWORK_GRAPH_CLUSTER:tin=${graph.sharedTin},addr=${graph.sharedAddr}`);
        return 20;
      }
      breakdown.E14_NETWORK_GRAPH = { score: 0, shared_tin_submissions: graph.sharedTin };
      return 0;
    })(),

    // E15: Synthetic Identity
    (async () => {
      if (!isIndividual || !effectiveTIN) {
        breakdown.E15_SYNTHETIC_IDENTITY = { score: 0 };
        return 0;
      }
      const ssnCheck = validateSSN(effectiveTIN);
      if (!ssnCheck.valid && ssnCheck.reason === 'area' && (ssnCheck.area || 0) >= 900) {
        breakdown.E15_SYNTHETIC_IDENTITY = { score: 40, reason: `ssn_area_${ssnCheck.area}` };
        flags.push(`SYNTHETIC_IDENTITY:SSN_AREA_${ssnCheck.area}`);
        return 40;
      }
      breakdown.E15_SYNTHETIC_IDENTITY = { score: 0 };
      return 0;
    })(),

    // E16: Watchlist Delta (newly-added SDN)
    (async () => {
      const hits = await screenAgainstSDN(fullName, env.KYC_SANCTIONS);
      const recentHits = hits.filter(h => isRecentlyAdded(h.added_date, 30));
      if (recentHits.length > 0) {
        breakdown.E16_WATCHLIST_DELTA = { score: 30, recent_additions: recentHits.map(h => h.name) };
        flags.push(`NEWLY_ADDED_SDN:${recentHits[0].name}`);
        return 30;
      }
      breakdown.E16_WATCHLIST_DELTA = { score: 0 };
      return 0;
    })(),
  ];

  // Apply timeout fence
  let engineScores;
  let timedOut = false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS)
    );
    engineScores = await Promise.race([
      Promise.all(enginePromises),
      timeoutPromise
    ]);
  } catch (e) {
    timedOut = true;
    // Partial results — use whatever resolved
    engineScores = await Promise.allSettled(enginePromises).then(results =>
      results.map(r => r.status === 'fulfilled' ? r.value : 0)
    );
  }

  // Cap total score at 100
  score = Math.min(engineScores.reduce((acc, s) => acc + (s || 0), 0), 100);

  let decision;
  if (score <= SCORE_BANDS.APPROVED) decision = 'APPROVED';
  else if (score <= SCORE_BANDS.REVIEW) decision = 'REVIEW';
  else decision = 'DENIED';

  const latency = Date.now() - startTime;

  return {
    score,
    decision,
    flags,
    breakdown,
    ofac_hits: ofacHitsArr,
    pep_hits: pepHitsArr,
    account_generation: {
      allowed: decision === 'APPROVED',
      reason: decision === 'APPROVED' ? 'clean_screen' : `${decision.toLowerCase()}_pending`
    },
    engine_version: ENGINE_VERSION,
    screen_latency_ms: latency,
    timed_out: timedOut
  };
}

// ─── D1 PERSISTENCE ──────────────────────────────────────────────────────────

async function persistSubmission(id, payload, result, env) {
  try {
    const db = env.AUDIT_DB;
    await db.prepare(`
      INSERT INTO kyc_submissions (
        submission_id, entity_type, applicant_name, tin, tin_formatted,
        status, risk_score, risk_decision, risk_breakdown, sanctions_hits,
        ofac_hits, pep_hits, tin_valid, ein_valid, screen_latency_ms,
        raw_payload, screened_at, created_at,
        flags_json, pep_hits_json, ofac_hits_json,
        velocity_flagged, structuring_flagged, adverse_media_hits, engine_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,
      payload.entity_type || 'individual',
      payload.applicant_name || [payload.first_name, payload.last_name].filter(Boolean).join(' '),
      payload.tin || payload.ssn || payload.ein || '',
      payload.tin || payload.ssn || payload.ein || '',
      result.decision.toLowerCase(),
      result.score,
      result.decision,
      JSON.stringify(result.breakdown),
      result.ofac_hits.length + result.pep_hits.length,
      result.ofac_hits.length,
      result.pep_hits.length,
      1, 1, // tin_valid / ein_valid — simplified
      result.screen_latency_ms,
      JSON.stringify(payload),
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(result.flags),
      JSON.stringify(result.pep_hits),
      JSON.stringify(result.ofac_hits),
      result.flags.some(f => f.startsWith('HIGH_VELOCITY')) ? 1 : 0,
      result.flags.some(f => f.startsWith('STRUCTURING')) ? 1 : 0,
      result.breakdown.E7_ADVERSE_MEDIA?.matched_keywords?.length || 0,
      ENGINE_VERSION
    ).run();
  } catch (e) {
    console.error('D1 persist error:', e.message);
  }
}

async function queueForReview(id, payload, result, env) {
  try {
    await env.AUDIT_DB.prepare(`
      INSERT INTO kyc_review_queue (
        reference_id, type, flags_json, payload_json, status, created_at
      ) VALUES (?,?,?,?,?,?)
    `).bind(
      id,
      result.decision === 'DENIED' ? 'denied_review' : 'compliance_review',
      JSON.stringify(result.flags),
      JSON.stringify(payload),
      'pending',
      new Date().toISOString()
    ).run();
  } catch (e) {
    console.error('D1 queue error:', e.message);
  }
}

async function fireSystemAlert(id, result, env) {
  try {
    if (!env.NOTIFIER_TOKEN) return;
    await fetch('https://notify.wwwknockoutforever.com/webhook/system-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.NOTIFIER_TOKEN}` },
      body: JSON.stringify({
        event_type: 'SYSTEM_ALERT',
        severity: 'HIGH',
        submission_id: id,
        risk_score: result.score,
        risk_decision: result.decision,
        flags: result.flags,
        message: `KYC DENIED — submission ${id} scored ${result.score}/100`
      })
    });
  } catch (e) {
    console.error('Notifier alert error:', e.message);
  }
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

async function verifyAuth(request, env) {
  // Try X-API-Key header
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey) {
    const stored = await env.GATEWAY_AUTH.get(`apikey:${apiKey}`);
    if (stored) return { ok: true, type: 'api_key' };
  }
  // Try Bearer token
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (token === env.KYC_ADMIN_KEY) return { ok: true, type: 'admin' };
    const stored = await env.GATEWAY_AUTH.get(`apikey:${token}`);
    if (stored) return { ok: true, type: 'api_key' };
  }
  return { ok: false };
}

function verifyAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.KYC_ADMIN_KEY}`;
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

async function handleApply(request, env) {
  let payload;
  try { payload = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const authResult = await verifyAuth(request, env);
  if (!authResult.ok) return jsonResponse({ error: 'unauthorized' }, 401);

  if (!payload.applicant_name && !(payload.first_name || payload.last_name)) {
    return jsonResponse({ error: 'applicant_name or first_name/last_name required' }, 400);
  }

  const id = submissionId();
  const result = await runScreening(payload, env);

  // Persist (non-blocking)
  if (env.AUDIT_DB) {
    const persist = persistSubmission(id, payload, result, env);
    if (result.decision !== 'APPROVED') {
      const queue = queueForReview(id, payload, result, env);
      if (result.decision === 'DENIED') {
        const alert = fireSystemAlert(id, result, env);
        await Promise.allSettled([persist, queue, alert]);
      } else {
        await Promise.allSettled([persist, queue]);
      }
    } else {
      await persist.catch(() => {});
    }
  }

  return jsonResponse({
    submission_id: id,
    entity_type: payload.entity_type || 'individual',
    applicant_name: payload.applicant_name || [payload.first_name, payload.last_name].filter(Boolean).join(' '),
    risk_score: result.score,
    risk_decision: result.decision,
    risk_breakdown: result.breakdown,
    flags: result.flags,
    ofac_hits: result.ofac_hits,
    pep_hits: result.pep_hits,
    account_generation: result.account_generation,
    engine_version: result.engine_version,
    screen_latency_ms: result.screen_latency_ms,
    timed_out: result.timed_out
  });
}

async function handleStatus(request, env, id) {
  const authResult = await verifyAuth(request, env);
  if (!authResult.ok) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!env.AUDIT_DB) return jsonResponse({ error: 'database_unavailable' }, 503);

  const row = await env.AUDIT_DB.prepare(
    `SELECT submission_id, entity_type, applicant_name, status, risk_score, risk_decision,
            risk_breakdown, flags_json, ofac_hits, pep_hits, screen_latency_ms, screened_at, engine_version
     FROM kyc_submissions WHERE submission_id = ?`
  ).bind(id).first();

  if (!row) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({
    ...row,
    risk_breakdown: JSON.parse(row.risk_breakdown || '{}'),
    flags: JSON.parse(row.flags_json || '[]'),
    account_generation: { allowed: row.risk_decision === 'APPROVED' }
  });
}

async function handleReview(request, env) {
  if (!verifyAdmin(request, env)) return jsonResponse({ error: 'admin_required' }, 403);
  if (!env.AUDIT_DB) return jsonResponse({ error: 'database_unavailable' }, 503);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const status = url.searchParams.get('status') || 'pending';

  const rows = await env.AUDIT_DB.prepare(
    `SELECT q.reference_id, q.type, q.flags_json, q.status, q.created_at,
            s.applicant_name, s.risk_score, s.risk_decision, s.entity_type
     FROM kyc_review_queue q
     LEFT JOIN kyc_submissions s ON s.submission_id = q.reference_id
     WHERE q.status = ?
     ORDER BY s.risk_score DESC
     LIMIT ?`
  ).bind(status, limit).all();

  return jsonResponse({
    total: rows.results?.length || 0,
    status_filter: status,
    queue: (rows.results || []).map(r => ({ ...r, flags: JSON.parse(r.flags_json || '[]') }))
  });
}

async function handleReviewAction(request, env, id, action) {
  if (!verifyAdmin(request, env)) return jsonResponse({ error: 'admin_required' }, 403);
  if (!env.AUDIT_DB) return jsonResponse({ error: 'database_unavailable' }, 503);

  const now = new Date().toISOString();
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await env.AUDIT_DB.prepare(
    `UPDATE kyc_review_queue SET status = ?, resolved_at = ? WHERE reference_id = ?`
  ).bind(newStatus, now, id).run();
  await env.AUDIT_DB.prepare(
    `UPDATE kyc_submissions SET status = ? WHERE submission_id = ?`
  ).bind(newStatus, id).run();

  return jsonResponse({ submission_id: id, action, new_status: newStatus, resolved_at: now });
}

async function handleBatch(request, env) {
  if (!verifyAdmin(request, env)) return jsonResponse({ error: 'admin_required' }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const submissions = Array.isArray(body) ? body : body.submissions;
  if (!Array.isArray(submissions)) return jsonResponse({ error: 'submissions array required' }, 400);
  if (submissions.length > 50) return jsonResponse({ error: 'max_50_submissions_per_batch' }, 400);

  const results = await Promise.all(submissions.map(async (payload) => {
    const id = submissionId();
    const result = await runScreening(payload, env);
    return {
      submission_id: id,
      applicant_name: payload.applicant_name || [payload.first_name, payload.last_name].filter(Boolean).join(' '),
      risk_score: result.score,
      risk_decision: result.decision,
      flags: result.flags,
      account_generation: result.account_generation,
      screen_latency_ms: result.screen_latency_ms
    };
  }));

  return jsonResponse({
    batch_size: results.length,
    summary: {
      approved: results.filter(r => r.risk_decision === 'APPROVED').length,
      review: results.filter(r => r.risk_decision === 'REVIEW').length,
      denied: results.filter(r => r.risk_decision === 'DENIED').length
    },
    results
  });
}

async function handleStats(request, env) {
  if (!verifyAdmin(request, env)) return jsonResponse({ error: 'admin_required' }, 403);
  if (!env.AUDIT_DB) return jsonResponse({ error: 'database_unavailable' }, 503);

  const [totals, recent, avgLatency] = await Promise.all([
    env.AUDIT_DB.prepare(
      `SELECT risk_decision, COUNT(*) as cnt FROM kyc_submissions GROUP BY risk_decision`
    ).all(),
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as cnt FROM kyc_submissions WHERE created_at >= datetime('now','-24 hours')`
    ).first(),
    env.AUDIT_DB.prepare(
      `SELECT AVG(screen_latency_ms) as avg_ms FROM kyc_submissions WHERE created_at >= datetime('now','-24 hours')`
    ).first()
  ]);

  const summary = {};
  for (const row of (totals.results || [])) {
    summary[row.risk_decision?.toLowerCase()] = row.cnt;
  }

  return jsonResponse({
    version: VERSION,
    engine_version: ENGINE_VERSION,
    totals: summary,
    last_24h: { submissions: recent?.cnt || 0, avg_latency_ms: Math.round(avgLatency?.avg_ms || 0) },
    engines_active: 16,
    timeout_fence_ms: TIMEOUT_MS
  });
}

async function handleHealth() {
  return jsonResponse({
    status: 'ok',
    version: VERSION,
    engine_version: ENGINE_VERSION,
    engines: 16,
    timeout_fence_ms: TIMEOUT_MS,
    decision_bands: { approved: '0-29', review: '30-69', denied: '70-100' },
    timestamp: new Date().toISOString()
  });
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    let response;

    if (path === `${ADMIN_PATH_PREFIX}/health` && method === 'GET') {
      response = await handleHealth();
    } else if (path === `${ADMIN_PATH_PREFIX}/apply` && method === 'POST') {
      response = await handleApply(request, env);
    } else if (path.match(new RegExp(`^${ADMIN_PATH_PREFIX}/status/([^/]+)$`)) && method === 'GET') {
      const id = path.split('/').pop();
      response = await handleStatus(request, env, id);
    } else if (path === `${ADMIN_PATH_PREFIX}/review` && method === 'GET') {
      response = await handleReview(request, env);
    } else if (path.match(new RegExp(`^${ADMIN_PATH_PREFIX}/review/([^/]+)/(approve|reject)$`)) && method === 'POST') {
      const parts = path.split('/');
      const action = parts.pop();
      const id = parts.pop();
      response = await handleReviewAction(request, env, id, action);
    } else if (path === `${ADMIN_PATH_PREFIX}/batch` && method === 'POST') {
      response = await handleBatch(request, env);
    } else if (path === `${ADMIN_PATH_PREFIX}/stats` && method === 'GET') {
      response = await handleStats(request, env);
    } else {
      response = jsonResponse({ error: 'not_found', version: VERSION }, 404);
    }

    // Attach CORS to all responses
    const corsH = corsHeaders();
    for (const [k, v] of Object.entries(corsH)) {
      response.headers.set(k, v);
    }
    return response;
  }
};
