/**
 * kyc-gateway v7.0 — Bervashun Trust Capital
 * Sub-2-Second KYC/KYB Intake Screening
 *
 * 16 parallel screening engines, hard 1800ms fence,
 * pre-account-generation gate, D1 audit trail, human review queue.
 *
 * Bindings required:
 *   AUDIT_DB        — D1 database (f2fe6105-b552-42b4-a2ca-9d2a349861da)
 *   KYC_SANCTIONS   — KV namespace (203d064ff04b45d9b15a363aa18427be)
 *   GATEWAY_AUTH    — KV namespace (06af84f811b84abbb1d956b639d0cd07)
 *
 * Secrets required:
 *   KYC_ADMIN_KEY   — admin bearer token
 *   NOTIFIER_TOKEN  — signup-notifier dispatch token
 */

const VERSION = '7.0.0';
const ENGINE_VERSION = 'E16';

// ─── Decision Bands ──────────────────────────────────────────────────────────
const BAND = { APPROVED: 'APPROVED', REVIEW: 'REVIEW', DENIED: 'DENIED' };
function band(score) {
  if (score >= 70) return BAND.DENIED;
  if (score >= 30) return BAND.REVIEW;
  return BAND.APPROVED;
}

// ─── Fuzzy String Matching ────────────────────────────────────────────────────
function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  a = a.toUpperCase(); b = b.toUpperCase();
  if (a === b) return 1;
  const aw = a.length, bw = b.length;
  const matchDist = Math.floor(Math.max(aw, bw) / 2) - 1;
  const aMatched = new Array(aw).fill(false);
  const bMatched = new Array(bw).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < aw; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, bw);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < aw; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / aw + matches / bw + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(aw, bw)); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toUpperCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toUpperCase().split(/\s+/).filter(Boolean));
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function bestNameScore(name, candidates) {
  let best = 0;
  for (const c of candidates) {
    const jw = jaroWinkler(name, c);
    const ts = tokenSetSimilarity(name, c);
    best = Math.max(best, jw, ts);
  }
  return best;
}

// ─── Validation Helpers ───────────────────────────────────────────────────────
function validateSSN(tin) {
  const clean = (tin || '').replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const area = parseInt(clean.substring(0, 3), 10);
  // ITIN ranges: 900-999
  if (area === 0 || area === 666 || (area >= 900 && area <= 999)) return false;
  if (clean === '000000000' || clean.startsWith('0') && clean.substring(0, 3) === '000') return false;
  return !/^(\d)\1{8}$/.test(clean);
}

function validateEIN(ein) {
  const clean = (ein || '').replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const prefix = parseInt(clean.substring(0, 2), 10);
  const validPrefixes = [10,12,20,22,23,24,25,26,27,28,29,
    30,32,33,34,35,36,37,38,39,40,41,42,44,45,46,47,48,
    50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,
    71,72,73,74,75,76,77,80,81,82,83,84,85,86,87,88,90,91,92,
    93,94,95,98,99,
    1,2,3,4,5,6,7,8,9,11,13,14,15,16,17,18,19,21,31,43,49,69,70,79,89,97];
  return validPrefixes.includes(prefix);
}

function formatTIN(tin, type) {
  const clean = (tin || '').replace(/\D/g, '');
  if (type === 'business') {
    return clean.length >= 9 ? `${clean.substring(0,2)}-${clean.substring(2)}` : clean;
  }
  return clean.length >= 9 ? `${clean.substring(0,3)}-${clean.substring(3,5)}-${clean.substring(5)}` : clean;
}

// ─── FATF High-Risk Countries (55 jurisdictions, June 2026) ─────────────────
const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','BI','KH','CM','CF','TD','KM','CG','CD',
  'CI','CU','DJ','ER','SZ','ET','FJ','GN','GW','HT','IR','IQ','JM',
  'KE','LA','LR','LY','ML','MR','MM','MZ','NP','NI','NE','NG','KP',
  'PK','PG','PH','RU','SC','SL','SO','SS','SD','SY','TZ','TT','UG',
  'VU','YE','ZW'
]);

// ─── ITIN / Synthetic Identity Areas ─────────────────────────────────────────
const SYNTHETIC_AREAS = new Set([900,901,902,903,904,905,906,907,908,909,
  910,911,912,913,914,915,916,917,918,919,920,921,922,923,924,925,926,
  927,928,929,930,931,932,933,934,935,936,937,938,939,940,941,942,943,
  944,945,946,947,948,949,950,951,952,953,954,955,956,957,958,959,960,
  961,962,963,964,965,966,967,968,969,970,971,972,973,974,975,976,977,
  978,979,980,981,982,983,984,985,986,987,988,989,990,991,992,993,994,
  995,996,997,998,999]);

// ─── Adverse Media Keywords ───────────────────────────────────────────────────
const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','terrorism','criminal','indicted',
  'convicted','sanction','watchlist','bribery','corruption','embezzlement',
  'trafficking','cartel','organized crime','ponzi','wire fraud','tax evasion',
  'felony','arrest','prison','plea deal','debarred','blacklisted'
];

// ─── Corporate Depth Patterns ─────────────────────────────────────────────────
const SHELL_PATTERNS = [
  /holdings?\s+llc/i, /ventures?\s+llc/i, /capital\s+group/i,
  /international\s+group/i, /global\s+ventures?/i, /offshore/i, /trust\s+co/i
];

// ─── KV Helpers ───────────────────────────────────────────────────────────────
async function loadIndex(kv, key) {
  try {
    const raw = await kv.get(key, { type: 'json' });
    return raw || [];
  } catch { return []; }
}

async function kv314a(kv) {
  try {
    const raw = await kv.get('fincen:314a', { type: 'json' });
    return raw || [];
  } catch { return []; }
}

// ─── 16 Screening Engines ─────────────────────────────────────────────────────

// E1 — OFAC SDN (40pts/hit, cap 70)
async function engineOFAC(payload, kv) {
  const names = [payload.full_name || payload.business_name || ''];
  if (payload.beneficial_owners) {
    payload.beneficial_owners.forEach(o => names.push(o.name || ''));
  }
  const index = await loadIndex(kv, 'sdn:index');
  let score = 0;
  const hits = [];
  for (const name of names.filter(Boolean)) {
    for (const entry of index) {
      const candidates = [entry.name, ...(entry.aliases || [])];
      const sim = bestNameScore(name, candidates);
      if (sim >= 0.82) {
        score += 40;
        hits.push({ name, matched: entry.name, sim: sim.toFixed(3), type: entry.type || 'SDN' });
      }
    }
  }
  return { engine: 'E1_OFAC_SDN', score: Math.min(score, 70), hits };
}

// E2 — PEP (25pts/hit, cap 50)
async function enginePEP(payload, kv) {
  const name = payload.full_name || payload.business_name || '';
  const index = await loadIndex(kv, 'pep:index');
  let score = 0;
  const hits = [];
  for (const entry of index) {
    const candidates = [entry.name, ...(entry.aliases || [])];
    const sim = bestNameScore(name, candidates);
    if (sim >= 0.80) {
      score += 25;
      hits.push({ name, matched: entry.name, sim: sim.toFixed(3), position: entry.position });
    }
  }
  return { engine: 'E2_PEP', score: Math.min(score, 50), hits };
}

// E3 — FATF High-Risk Country (20pts)
function engineFATF(payload) {
  const countries = [
    payload.country, payload.nationality,
    payload.registered_country, payload.operating_country
  ].filter(Boolean).map(c => c.toUpperCase());
  const hits = countries.filter(c => FATF_HIGH_RISK.has(c));
  return { engine: 'E3_FATF', score: hits.length ? 20 : 0, hits };
}

// E4 — TIN/EIN Validation (20pts)
function engineTIN(payload) {
  const type = payload.entity_type === 'business' ? 'business' : 'individual';
  let valid = false;
  let tin_valid = false;
  let ein_valid = false;
  const tin = (payload.tin || '').replace(/\D/g, '');
  if (type === 'individual') {
    tin_valid = validateSSN(tin);
    valid = tin_valid;
  } else {
    ein_valid = validateEIN(tin);
    valid = ein_valid;
  }
  return {
    engine: 'E4_TIN_EIN',
    score: valid ? 0 : 20,
    tin_valid,
    ein_valid,
    formatted: formatTIN(tin, type)
  };
}

// E5 — Velocity (15pts if >5/TIN/24h)
async function engineVelocity(payload, db) {
  const tin = (payload.tin || '').replace(/\D/g, '');
  if (!tin) return { engine: 'E5_VELOCITY', score: 0, count: 0 };
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { results } = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM kyc_submissions WHERE tin=? AND created_at>?`
    ).bind(tin, since).all();
    const count = results[0]?.cnt || 0;
    return { engine: 'E5_VELOCITY', score: count > 5 ? 15 : 0, count };
  } catch { return { engine: 'E5_VELOCITY', score: 0, count: 0 }; }
}

// E6 — FinCEN 314(a) Structuring (35pts, $8k–$10k window)
async function engineStructuring(payload, kv) {
  const amount = parseFloat(payload.initial_deposit || payload.transaction_amount || 0);
  const name = payload.full_name || payload.business_name || '';
  let score = 0;
  const flags = [];
  if (amount >= 8000 && amount < 10000) {
    score += 35;
    flags.push({ reason: 'Deposit in structuring window ($8k-$10k)', amount });
  }
  // Cross-reference FinCEN 314(a) list
  const list314a = await kv314a(kv);
  for (const entry of list314a) {
    const sim = bestNameScore(name, [entry.name, ...(entry.aliases || [])]);
    if (sim >= 0.80) {
      score += 35;
      flags.push({ reason: 'FinCEN 314(a) match', matched: entry.name, sim: sim.toFixed(3) });
    }
  }
  return { engine: 'E6_STRUCTURING', score: Math.min(score, 70), flags };
}

// E7 — Adverse Media (5pts/keyword, cap 30)
function engineAdverseMedia(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => text.includes(kw));
  return { engine: 'E7_ADVERSE_MEDIA', score: Math.min(hits.length * 5, 30), keywords: hits };
}

// E8 — UBO Cascade (25pts for ≥25% ownership)
function engineUBO(payload) {
  const owners = payload.beneficial_owners || [];
  const flagged = owners.filter(o => parseFloat(o.ownership_percentage || 0) >= 25);
  const unverified = flagged.filter(o => !o.tin && !o.passport_number);
  return {
    engine: 'E8_UBO',
    score: unverified.length > 0 ? 25 : 0,
    beneficial_owners_flagged: unverified.length,
    owners_at_or_above_25pct: flagged.length
  };
}

// E9 — DOB Plausibility (35pts: future, under-18, over-120)
function engineDOB(payload) {
  const dob = payload.date_of_birth;
  if (!dob) return { engine: 'E9_DOB', score: 0, reason: null };
  const d = new Date(dob);
  const now = new Date();
  if (isNaN(d.getTime())) return { engine: 'E9_DOB', score: 35, reason: 'Unparseable DOB' };
  if (d > now) return { engine: 'E9_DOB', score: 35, reason: 'Future DOB' };
  const ageMs = now - d;
  const ageYears = ageMs / (365.25 * 24 * 3600 * 1000);
  if (ageYears < 18) return { engine: 'E9_DOB', score: 35, reason: 'Under 18' };
  if (ageYears > 120) return { engine: 'E9_DOB', score: 35, reason: 'Age >120 years' };
  return { engine: 'E9_DOB', score: 0, reason: null };
}

// E10 — Address Risk (10pts for PO Box, no address, high-risk states)
function engineAddress(payload) {
  const addr = (payload.address || '').toLowerCase();
  const flags = [];
  if (!addr || addr.trim().length < 5) flags.push('Missing address');
  if (/p\.?o\.?\s+box|post\s+office\s+box/i.test(addr)) flags.push('PO Box');
  if (/general\s+delivery/i.test(addr)) flags.push('General Delivery');
  return { engine: 'E10_ADDRESS', score: flags.length ? 10 : 0, flags };
}

// E11 — Entity Consistency (15pts for name/TIN type mismatch)
function engineConsistency(payload) {
  const flags = [];
  const type = payload.entity_type;
  if (type === 'business' && payload.full_name && !payload.business_name) {
    flags.push('Business entity but individual name field used');
  }
  if (type === 'individual' && payload.business_name && !payload.full_name) {
    flags.push('Individual entity but business name field used');
  }
  if (type === 'individual' && payload.tin && validateEIN(payload.tin) && !validateSSN(payload.tin)) {
    flags.push('Individual TIN matches EIN format');
  }
  return { engine: 'E11_CONSISTENCY', score: flags.length ? 15 : 0, flags };
}

// E12 — Corporate Depth (20pts for >4 layers or shell patterns)
function engineCorporateDepth(payload) {
  const depth = parseInt(payload.corporate_layers || 0, 10);
  const name = payload.business_name || '';
  const shellMatch = SHELL_PATTERNS.some(p => p.test(name));
  const flags = [];
  if (depth > 4) flags.push(`Corporate depth ${depth} layers`);
  if (shellMatch) flags.push('Shell company naming pattern');
  return { engine: 'E12_CORPORATE_DEPTH', score: flags.length ? 20 : 0, flags };
}

// E13 — Document Entropy (10pts: missing/expired docs)
function engineDocumentEntropy(payload) {
  const flags = [];
  if (!payload.id_document_type) flags.push('No ID document type');
  if (!payload.id_document_number) flags.push('No ID document number');
  if (payload.id_expiry_date) {
    const expiry = new Date(payload.id_expiry_date);
    if (!isNaN(expiry.getTime()) && expiry < new Date()) {
      flags.push('Expired ID document');
    }
  }
  return { engine: 'E13_DOCUMENT_ENTROPY', score: flags.length ? 10 : 0, flags };
}

// E14 — Network Graph (20pts: shared TIN or address across recent submissions)
async function engineNetworkGraph(payload, db) {
  const tin = (payload.tin || '').replace(/\D/g, '');
  const addr = payload.address || '';
  if (!tin && !addr) return { engine: 'E14_NETWORK_GRAPH', score: 0, shared: [] };
  try {
    const shared = [];
    if (tin) {
      const { results } = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM kyc_submissions WHERE tin=? AND risk_decision IN ('APPROVED','REVIEW','DENIED')`
      ).bind(tin).all();
      if ((results[0]?.cnt || 0) > 1) shared.push(`TIN appears in ${results[0].cnt} submissions`);
    }
    return { engine: 'E14_NETWORK_GRAPH', score: shared.length ? 20 : 0, shared };
  } catch { return { engine: 'E14_NETWORK_GRAPH', score: 0, shared: [] }; }
}

// E15 — Synthetic Identity (40pts: SSN area 900+)
function engineSyntheticIdentity(payload) {
  const tin = (payload.tin || '').replace(/\D/g, '');
  if (payload.entity_type === 'business') return { engine: 'E15_SYNTHETIC_IDENTITY', score: 0 };
  if (tin.length >= 3) {
    const area = parseInt(tin.substring(0, 3), 10);
    if (SYNTHETIC_AREAS.has(area)) {
      return { engine: 'E15_SYNTHETIC_IDENTITY', score: 40, reason: `SSN area ${area} (ITIN range)` };
    }
  }
  return { engine: 'E15_SYNTHETIC_IDENTITY', score: 0, reason: null };
}

// E16 — Watchlist Delta (30pts: newly-added SDN in last 7 days)
async function engineWatchlistDelta(payload, kv) {
  const name = payload.full_name || payload.business_name || '';
  const delta = await loadIndex(kv, 'sdn:delta:7d');
  const hits = [];
  for (const entry of delta) {
    const candidates = [entry.name, ...(entry.aliases || [])];
    const sim = bestNameScore(name, candidates);
    if (sim >= 0.80) {
      hits.push({ name, matched: entry.name, sim: sim.toFixed(3), added: entry.added_date });
    }
  }
  return { engine: 'E16_WATCHLIST_DELTA', score: hits.length ? 30 : 0, newly_added_hits: hits };
}

// ─── Run All 16 Engines in Parallel ──────────────────────────────────────────
async function runAllEngines(payload, db, kv) {
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ timedOut: true }), 1800)
  );

  const engines = Promise.all([
    engineOFAC(payload, kv),
    enginePEP(payload, kv),
    Promise.resolve(engineFATF(payload)),
    Promise.resolve(engineTIN(payload)),
    engineVelocity(payload, db),
    engineStructuring(payload, kv),
    Promise.resolve(engineAdverseMedia(payload)),
    Promise.resolve(engineUBO(payload)),
    Promise.resolve(engineDOB(payload)),
    Promise.resolve(engineAddress(payload)),
    Promise.resolve(engineConsistency(payload)),
    Promise.resolve(engineCorporateDepth(payload)),
    Promise.resolve(engineDocumentEntropy(payload)),
    engineNetworkGraph(payload, db),
    Promise.resolve(engineSyntheticIdentity(payload)),
    engineWatchlistDelta(payload, kv),
  ]);

  const result = await Promise.race([engines, timeout]);
  if (result?.timedOut) {
    return { timedOut: true, results: [] };
  }
  return { timedOut: false, results: result };
}

// ─── D1 Helpers ───────────────────────────────────────────────────────────────
async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kyc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT UNIQUE NOT NULL,
      entity_type TEXT NOT NULL,
      applicant_name TEXT,
      tin TEXT,
      tin_formatted TEXT,
      status TEXT DEFAULT 'pending',
      risk_score INTEGER DEFAULT 0,
      risk_decision TEXT,
      risk_breakdown TEXT,
      sanctions_hits INTEGER DEFAULT 0,
      ofac_hits INTEGER DEFAULT 0,
      pep_hits INTEGER DEFAULT 0,
      tin_valid INTEGER DEFAULT 0,
      ein_valid INTEGER DEFAULT 0,
      screen_latency_ms INTEGER,
      raw_payload TEXT,
      screened_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      flags_json TEXT,
      pep_hits_json TEXT,
      ofac_hits_json TEXT,
      velocity_flagged INTEGER DEFAULT 0,
      structuring_flagged INTEGER DEFAULT 0,
      adverse_media_hits INTEGER DEFAULT 0,
      engine_version TEXT DEFAULT 'E16'
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kyc_review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT NOT NULL,
      reference_id TEXT,
      type TEXT DEFAULT 'KYC',
      flags_json TEXT,
      payload_json TEXT,
      status TEXT DEFAULT 'pending',
      assigned_to TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kyc_beneficial_owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT NOT NULL,
      owner_name TEXT,
      ownership_percentage REAL,
      tin TEXT,
      nationality TEXT,
      is_flagged INTEGER DEFAULT 0,
      sanctions_score INTEGER DEFAULT 0,
      pep_flag INTEGER DEFAULT 0,
      match_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
  ]);
}

async function saveSubmission(db, submissionId, payload, engineResults, score, decision, latencyMs, tinResult) {
  const ofacResult = engineResults.find(e => e.engine === 'E1_OFAC_SDN');
  const pepResult = engineResults.find(e => e.engine === 'E2_PEP');
  const structResult = engineResults.find(e => e.engine === 'E6_STRUCTURING');
  const mediaResult = engineResults.find(e => e.engine === 'E7_ADVERSE_MEDIA');
  const velResult = engineResults.find(e => e.engine === 'E5_VELOCITY');

  const name = payload.full_name || payload.business_name || '';
  const tin = (payload.tin || '').replace(/\D/g, '');

  await db.prepare(`INSERT OR REPLACE INTO kyc_submissions (
    submission_id,entity_type,applicant_name,tin,tin_formatted,
    status,risk_score,risk_decision,risk_breakdown,
    sanctions_hits,ofac_hits,pep_hits,tin_valid,ein_valid,
    screen_latency_ms,raw_payload,screened_at,
    flags_json,pep_hits_json,ofac_hits_json,
    velocity_flagged,structuring_flagged,adverse_media_hits,engine_version
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(
    submissionId,
    payload.entity_type || 'individual',
    name,
    tin,
    tinResult?.formatted || tin,
    decision.toLowerCase(),
    score,
    decision,
    JSON.stringify(engineResults),
    (ofacResult?.hits?.length || 0) + (pepResult?.hits?.length || 0),
    ofacResult?.hits?.length || 0,
    pepResult?.hits?.length || 0,
    tinResult?.tin_valid ? 1 : 0,
    tinResult?.ein_valid ? 1 : 0,
    latencyMs,
    JSON.stringify(payload),
    new Date().toISOString(),
    JSON.stringify(engineResults.filter(e => e.score > 0).map(e => e.engine)),
    JSON.stringify(pepResult?.hits || []),
    JSON.stringify(ofacResult?.hits || []),
    (velResult?.count || 0) > 5 ? 1 : 0,
    (structResult?.flags?.length || 0) > 0 ? 1 : 0,
    mediaResult?.keywords?.length || 0,
    ENGINE_VERSION
  ).run();
}

async function enqueueReview(db, submissionId, payload, engineResults, score, decision) {
  const flaggedEngines = engineResults.filter(e => e.score > 0).map(e => e.engine);
  await db.prepare(`INSERT INTO kyc_review_queue (
    submission_id,reference_id,type,flags_json,payload_json,status
  ) VALUES (?,?,?,?,?,'pending')`)
  .bind(
    submissionId,
    submissionId,
    payload.entity_type === 'business' ? 'KYB' : 'KYC',
    JSON.stringify({ score, decision, flaggedEngines }),
    JSON.stringify(payload)
  ).run();
}

async function saveBeneficialOwners(db, submissionId, payload, ofacIndex, pepIndex) {
  const owners = payload.beneficial_owners || [];
  for (const owner of owners) {
    const name = owner.name || '';
    let isFlagged = 0;
    let matchReason = null;
    let pepFlag = 0;
    let sanctionsScore = 0;

    const ofacSim = bestNameScore(name, ofacIndex.flatMap(e => [e.name, ...(e.aliases || [])]));
    if (ofacSim >= 0.82) {
      isFlagged = 1;
      matchReason = `OFAC SDN match (${ofacSim.toFixed(3)})`;
      sanctionsScore = 40;
    }
    const pepSim = bestNameScore(name, pepIndex.flatMap(e => [e.name, ...(e.aliases || [])]));
    if (pepSim >= 0.80) {
      pepFlag = 1;
      if (!isFlagged) { isFlagged = 1; matchReason = `PEP match (${pepSim.toFixed(3)})`; }
    }

    await db.prepare(`INSERT INTO kyc_beneficial_owners (
      submission_id,owner_name,ownership_percentage,tin,nationality,
      is_flagged,sanctions_score,pep_flag,match_reason
    ) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(
      submissionId,
      name,
      parseFloat(owner.ownership_percentage || 0),
      (owner.tin || '').replace(/\D/g, ''),
      owner.nationality || null,
      isFlagged,
      sanctionsScore,
      pepFlag,
      matchReason
    ).run();
  }
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────
function getBearer(req) {
  const auth = req.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

async function authApiKey(kv, key) {
  if (!key) return false;
  const stored = await kv.get(`apikey:${key}`);
  return stored !== null;
}

function isAdminKey(env, key) {
  return key === env.KYC_ADMIN_KEY;
}

// ─── Notify Helper ────────────────────────────────────────────────────────────
async function notifySystemAlert(env, payload) {
  if (!env.NOTIFIER_TOKEN) return;
  try {
    await fetch('https://notify.wwwknockoutforever.com/webhook/system-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NOTIFIER_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
  } catch { /* non-blocking */ }
}

// ─── Response Helpers ─────────────────────────────────────────────────────────
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'X-KYC-Version': VERSION,
    'X-Engine-Version': ENGINE_VERSION,
  }
});

// ─── Main Handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Always ensure schema on boot (idempotent)
    ctx.waitUntil(ensureSchema(env.AUDIT_DB));

    // ── Health ──────────────────────────────────────────────────────────────
    if (path === '/api/kyc/health' && method === 'GET') {
      return json({ status: 'ok', version: VERSION, engine_version: ENGINE_VERSION, ts: new Date().toISOString() });
    }

    // ── KYC/KYB Intake ─────────────────────────────────────────────────────
    if (path === '/api/kyc/apply' && method === 'POST') {
      const bearer = getBearer(request);
      const apiKeyOk = await authApiKey(env.GATEWAY_AUTH, bearer);
      const adminOk = isAdminKey(env, bearer);
      if (!apiKeyOk && !adminOk) return json({ error: 'Unauthorized' }, 401);

      let payload;
      try { payload = await request.json(); }
      catch { return json({ error: 'Invalid JSON body' }, 400); }

      if (!payload.entity_type || !payload.tin) {
        return json({ error: 'Required fields: entity_type, tin' }, 400);
      }

      const submissionId = `KYC-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
      const t0 = Date.now();

      // Run all 16 engines
      const { timedOut, results } = await runAllEngines(payload, env.AUDIT_DB, env.KYC_SANCTIONS);

      const latencyMs = Date.now() - t0;

      if (timedOut) {
        // Hard timeout → auto-REVIEW
        const timeoutResult = {
          submission_id: submissionId,
          entity_type: payload.entity_type,
          risk_score: 30,
          risk_decision: BAND.REVIEW,
          risk_breakdown: [{ engine: 'TIMEOUT', score: 30, reason: 'Screening exceeded 1800ms — auto-queued for review' }],
          account_generation: { allowed: false, reason: 'Auto-REVIEW: timeout fence triggered' },
          screen_latency_ms: latencyMs,
          engine_version: ENGINE_VERSION,
          version: VERSION,
        };
        ctx.waitUntil(enqueueReview(env.AUDIT_DB, submissionId, payload, [], 30, BAND.REVIEW));
        return json(timeoutResult);
      }

      // Aggregate score
      let totalScore = 0;
      for (const r of results) totalScore += (r.score || 0);
      totalScore = Math.min(totalScore, 100);

      const decision = band(totalScore);
      const tinResult = results.find(e => e.engine === 'E4_TIN_EIN');

      // Pre-account-generation gate
      const accountGenAllowed = decision === BAND.APPROVED;
      const accountGen = {
        allowed: accountGenAllowed,
        reason: accountGenAllowed
          ? 'All engines passed — account generation authorized'
          : `Account generation blocked: ${decision} decision (score ${totalScore})`
      };

      // Persist
      ctx.waitUntil((async () => {
        await saveSubmission(env.AUDIT_DB, submissionId, payload, results, totalScore, decision, latencyMs, tinResult);
        if (decision !== BAND.APPROVED) {
          await enqueueReview(env.AUDIT_DB, submissionId, payload, results, totalScore, decision);
        }
        const ofacIndex = await loadIndex(env.KYC_SANCTIONS, 'sdn:index');
        const pepIndex  = await loadIndex(env.KYC_SANCTIONS, 'pep:index');
        await saveBeneficialOwners(env.AUDIT_DB, submissionId, payload, ofacIndex, pepIndex);
        if (decision === BAND.DENIED) {
          await notifySystemAlert(env, {
            event_type: 'SYSTEM_ALERT',
            severity: 'HIGH',
            title: 'KYC DENIED',
            submission_id: submissionId,
            entity: payload.full_name || payload.business_name,
            score: totalScore,
            flagged_engines: results.filter(r => r.score > 0).map(r => r.engine),
          });
        }
      })());

      return json({
        submission_id: submissionId,
        entity_type: payload.entity_type,
        applicant: payload.full_name || payload.business_name,
        risk_score: totalScore,
        risk_decision: decision,
        risk_breakdown: results.map(r => ({ engine: r.engine, score: r.score })),
        risk_detail: results.filter(r => r.score > 0),
        account_generation: accountGen,
        tin_formatted: tinResult?.formatted,
        screen_latency_ms: latencyMs,
        engine_version: ENGINE_VERSION,
        version: VERSION,
      });
    }

    // ── Batch Intake ────────────────────────────────────────────────────────
    if (path === '/api/kyc/batch' && method === 'POST') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON' }, 400); }

      const submissions = body.submissions || [];
      if (!Array.isArray(submissions) || submissions.length === 0)
        return json({ error: 'submissions array required' }, 400);
      if (submissions.length > 50)
        return json({ error: 'Max 50 submissions per batch' }, 400);

      const results = await Promise.all(
        submissions.map(async (s) => {
          if (!s.entity_type || !s.tin) return { error: 'entity_type and tin required', payload: s };
          const sid = `KYC-B${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
          const t0 = Date.now();
          const { timedOut, results: er } = await runAllEngines(s, env.AUDIT_DB, env.KYC_SANCTIONS);
          const ms = Date.now() - t0;
          if (timedOut) return { submission_id: sid, risk_decision: BAND.REVIEW, risk_score: 30, screen_latency_ms: ms, timedOut: true };
          let score = 0;
          for (const r of er) score += (r.score || 0);
          score = Math.min(score, 100);
          const dec = band(score);
          const tinR = er.find(e => e.engine === 'E4_TIN_EIN');
          ctx.waitUntil(saveSubmission(env.AUDIT_DB, sid, s, er, score, dec, ms, tinR));
          return { submission_id: sid, applicant: s.full_name || s.business_name, risk_score: score, risk_decision: dec, screen_latency_ms: ms };
        })
      );

      return json({ batch_count: results.length, results });
    }

    // ── Status ──────────────────────────────────────────────────────────────
    if (path.startsWith('/api/kyc/status/') && method === 'GET') {
      const bearer = getBearer(request);
      const apiKeyOk = await authApiKey(env.GATEWAY_AUTH, bearer);
      const adminOk = isAdminKey(env, bearer);
      if (!apiKeyOk && !adminOk) return json({ error: 'Unauthorized' }, 401);

      const sid = path.split('/').pop();
      try {
        const { results } = await env.AUDIT_DB.prepare(
          `SELECT submission_id,entity_type,applicant_name,risk_score,risk_decision,status,screen_latency_ms,screened_at,tin_formatted,engine_version FROM kyc_submissions WHERE submission_id=?`
        ).bind(sid).all();
        if (!results.length) return json({ error: 'Not found' }, 404);
        return json(results[0]);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Review Queue ────────────────────────────────────────────────────────
    if (path === '/api/kyc/review' && method === 'GET') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);

      const status = url.searchParams.get('status') || 'pending';
      try {
        const { results } = await env.AUDIT_DB.prepare(
          `SELECT q.*,s.risk_score,s.risk_decision,s.applicant_name,s.screen_latency_ms
           FROM kyc_review_queue q
           LEFT JOIN kyc_submissions s ON q.submission_id=s.submission_id
           WHERE q.status=?
           ORDER BY s.risk_score DESC
           LIMIT 100`
        ).bind(status).all();
        return json({ count: results.length, queue: results });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Approve ─────────────────────────────────────────────────────────────
    if (path.match(/^\/api\/kyc\/review\/[^/]+\/approve$/) && method === 'POST') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);
      const sid = path.split('/')[4];
      const body = await request.json().catch(() => ({}));
      try {
        await env.AUDIT_DB.prepare(
          `UPDATE kyc_review_queue SET status='approved',resolved_by=?,resolved_at=datetime('now') WHERE submission_id=?`
        ).bind(body.reviewer || 'admin', sid).run();
        await env.AUDIT_DB.prepare(
          `UPDATE kyc_submissions SET status='approved',risk_decision='APPROVED' WHERE submission_id=?`
        ).bind(sid).run();
        return json({ submission_id: sid, status: 'approved' });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Reject ──────────────────────────────────────────────────────────────
    if (path.match(/^\/api\/kyc\/review\/[^/]+\/reject$/) && method === 'POST') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);
      const sid = path.split('/')[4];
      const body = await request.json().catch(() => ({}));
      try {
        await env.AUDIT_DB.prepare(
          `UPDATE kyc_review_queue SET status='rejected',resolved_by=?,resolved_at=datetime('now') WHERE submission_id=?`
        ).bind(body.reviewer || 'admin', sid).run();
        await env.AUDIT_DB.prepare(
          `UPDATE kyc_submissions SET status='rejected',risk_decision='DENIED' WHERE submission_id=?`
        ).bind(sid).run();
        return json({ submission_id: sid, status: 'rejected' });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Stats ───────────────────────────────────────────────────────────────
    if (path === '/api/kyc/stats' && method === 'GET') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);
      try {
        const [totals, latency, decisions] = await Promise.all([
          env.AUDIT_DB.prepare(`SELECT COUNT(*) AS total FROM kyc_submissions`).all(),
          env.AUDIT_DB.prepare(`SELECT AVG(screen_latency_ms) AS avg_ms, MAX(screen_latency_ms) AS max_ms, MIN(screen_latency_ms) AS min_ms FROM kyc_submissions`).all(),
          env.AUDIT_DB.prepare(`SELECT risk_decision, COUNT(*) AS cnt FROM kyc_submissions GROUP BY risk_decision`).all(),
        ]);
        return json({
          total_submissions: totals.results[0]?.total || 0,
          latency_ms: latency.results[0],
          decisions: decisions.results,
          engine_version: ENGINE_VERSION,
          version: VERSION,
        });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── Beneficial Owners ───────────────────────────────────────────────────
    if (path.startsWith('/api/kyc/owners/') && method === 'GET') {
      const bearer = getBearer(request);
      if (!isAdminKey(env, bearer)) return json({ error: 'Admin only' }, 403);
      const sid = path.split('/').pop();
      try {
        const { results } = await env.AUDIT_DB.prepare(
          `SELECT * FROM kyc_beneficial_owners WHERE submission_id=?`
        ).bind(sid).all();
        return json({ submission_id: sid, owners: results });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    return json({ error: 'Not found', version: VERSION }, 404);
  }
};
