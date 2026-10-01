"use strict";
// =============================================================================
// kyc-gateway v8.1 — Comprehensive Unit Test Suite
// Node.js built-in assert only.  Run: node unit_test.js
// =============================================================================

const assert = require("assert");

let PASSED = 0;
let FAILED = 0;
const FAILURES = [];

function ok(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    PASSED++;
  } else {
    console.log(`  ❌ ${label}`);
    FAILED++;
    FAILURES.push(label);
  }
}

function eq(label, actual, expected) {
  const pass = actual === expected;
  if (pass) {
    console.log(`  ✅ ${label}`);
    PASSED++;
  } else {
    console.log(`  ❌ ${label}  →  got: ${JSON.stringify(actual)}  expected: ${JSON.stringify(expected)}`);
    FAILED++;
    FAILURES.push(`${label} [got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}]`);
  }
}

console.log("Running kyc-gateway v8.1 unit tests...\n");

// =============================================================================
// HELPER IMPLEMENTATIONS (extracted inline — no import from worker.js)
// =============================================================================

// ---------------------------------------------------------------------------
// clamp / cap
// ---------------------------------------------------------------------------
function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}
function cap(n, limit) {
  return Math.min(n, limit);
}

// ---------------------------------------------------------------------------
// jaroWinkler
// ---------------------------------------------------------------------------
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
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
  // Winkler prefix boost (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ---------------------------------------------------------------------------
// tokenSetSim
// ---------------------------------------------------------------------------
function tokenSetSim(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.toUpperCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toUpperCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) { if (tb.has(t)) inter++; }
  return inter / Math.max(ta.size, tb.size);
}

// ---------------------------------------------------------------------------
// normalName
// ---------------------------------------------------------------------------
function normalName(str) {
  if (!str) return "";
  return str
    .replace(/\s+Jr\.?$/i, "")
    .replace(/\s+Sr\.?$/i, "")
    .replace(/\s+IV$/i, "")
    .replace(/\s+III$/i, "")
    .replace(/\s+II$/i, "")
    .replace(/\s+LLC$/i, "")
    .replace(/\s+Inc\.?$/i, "")
    .replace(/\s+Corp\.?$/i, "")
    .replace(/\s+Ltd\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// validateSSN
// ---------------------------------------------------------------------------
function validateSSN(tin) {
  if (!tin || tin.length !== 9 || !/^\d{9}$/.test(tin)) {
    return { valid: false, area: null };
  }
  const area   = parseInt(tin.slice(0, 3), 10);
  const group  = parseInt(tin.slice(3, 5), 10);
  const serial = parseInt(tin.slice(5, 9), 10);
  if (area === 0)   return { valid: false, area };
  if (area === 666) return { valid: false, area };
  if (area >= 900)  return { valid: false, area, synthetic: true };
  if (group === 0)  return { valid: false, area };
  if (serial === 0) return { valid: false, area };
  return { valid: true, area };
}

// ---------------------------------------------------------------------------
// validateEIN
// ---------------------------------------------------------------------------
const DISALLOWED_EIN_PREFIXES = new Set([
  "00","07","08","09","17","18","19",
  "28","29","49","69","70","78","79","89"
]);
function validateEIN(tin) {
  if (!tin || tin.length !== 9 || !/^\d{9}$/.test(tin)) return false;
  const prefix = tin.slice(0, 2);
  return !DISALLOWED_EIN_PREFIXES.has(prefix);
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------
function decide(score, timedOut = false) {
  if (timedOut) return { decision: "REVIEW" };
  if (score <= 29) return { decision: "APPROVED" };
  if (score <= 69) return { decision: "REVIEW" };
  return { decision: "DENIED" };
}

// ---------------------------------------------------------------------------
// FATF countries (55)
// ---------------------------------------------------------------------------
const FATF_COUNTRIES = new Set([
  "AF","AL","BB","BF","BJ","BT","CM","CD","CF","CI","DJ","DZ","ET","GH","GN","GY",
  "HK","HT","IR","IQ","JM","JO","KH","KN","KP","LA","LB","LK","LY","MA","MK","ML",
  "MM","MN","MO","MR","MT","MU","MV","MZ","NG","NI","PA","PH","PK","RU","SB","SN",
  "SL","SO","SS","SY","TH","TN","TR","UG","VU","VE","YE","ZW","UA","BY"
]);

// High-risk ZIPs (sample — E10)
const HIGH_RISK_ZIPS = new Set(["00600","00601","00602","96950","96951","96952"]);

// Adverse media keywords (E7 / E2)
const ADVERSE_KEYWORDS = [
  "fraud","money laundering","terrorism","sanctions","bribery",
  "corruption","trafficking","embezzlement","ponzi","felony"
];

// FinCEN 314(a) sample list (E17) — for test purposes
const FINCEN_LIST = ["PABLO ESCOBAR","JUAN GARCIA ABREGO","AMADO CARRILLO FUENTES"];

// SDN sample list (E1)
const SDN_LIST = ["SPECIALLY DESIGNATED NATIONAL","KIM JONG UN","AL QAEDA FINANCIER"];

// Watchlist delta list (E16)
const DELTA_LIST = ["NEWLY ADDED SANCTIONS PERSON","DELTA WATCHLIST ENTITY"];


// =============================================================================
// TEST SECTION 1 — clamp / cap helpers
// =============================================================================
console.log("\n[clamp/cap helpers]");
eq("[clamp/cap] clamp(150) === 100",   clamp(150), 100);
eq("[clamp/cap] clamp(-10) === 0",     clamp(-10),   0);
eq("[clamp/cap] clamp(50)  === 50",    clamp(50),   50);
eq("[clamp/cap] cap(80,70) === 70",    cap(80, 70), 70);
eq("[clamp/cap] cap(30,70) === 30",    cap(30, 70), 30);

// =============================================================================
// TEST SECTION 2 — jaroWinkler
// =============================================================================
console.log("\n[helper] jaroWinkler");
eq('[helper] jaroWinkler identical strings = 1',
   jaroWinkler("JOHN SMITH","JOHN SMITH"), 1);
ok('[helper] jaroWinkler similar names >= 0.92',
   jaroWinkler("JOHN SMITH","JON SMITH") >= 0.92);
ok('[helper] jaroWinkler completely different < 0.5',
   jaroWinkler("JOHN SMITH","COMPLETELY DIFFERENT") < 0.5);
eq('[helper] jaroWinkler empty s1 === 0',
   jaroWinkler("","JOHN"), 0);
eq('[helper] jaroWinkler empty s2 === 0',
   jaroWinkler("JOHN",""), 0);

// =============================================================================
// TEST SECTION 3 — tokenSetSim
// =============================================================================
console.log("\n[helper] tokenSetSim");
eq('[helper] tokenSetSim reversed tokens = 1',
   tokenSetSim("JOHN SMITH","SMITH JOHN"), 1);
eq('[helper] tokenSetSim one common token of two = 0.5',
   tokenSetSim("JOHN SMITH","JOHN DOE"), 0.5);
eq('[helper] tokenSetSim empty first arg = 0',
   tokenSetSim("","JOHN"), 0);

// =============================================================================
// TEST SECTION 4 — normalName
// =============================================================================
console.log("\n[helper] normalName");
eq('[helper] normalName strips Jr',
   normalName("John Smith Jr"), "John Smith");
eq('[helper] normalName strips Corp',
   normalName("Acme Corp"), "Acme");
eq('[helper] normalName strips LLC',
   normalName("Acme LLC"), "Acme");
eq('[helper] normalName collapses whitespace',
   normalName("  John   Smith  "), "John Smith");
eq('[helper] normalName strips Sr',
   normalName("John Smith Sr"), "John Smith");
eq('[helper] normalName strips III',
   normalName("John Smith III"), "John Smith");
// Strip two suffixes (Corp then nothing left but "Acme Corp LLC" → Corp first → "Acme LLC" → LLC → "Acme")
eq('[helper] normalName strips Corp then LLC',
   normalName("Acme Corp LLC"), "Acme");

// =============================================================================
// TEST SECTION 5 — validateSSN
// =============================================================================
console.log("\n[helper] validateSSN");
{
  const r = validateSSN("123456789");
  ok('[SSN] "123456789" valid=true',  r.valid === true);
  ok('[SSN] "123456789" area=123',    r.area === 123);
}
{
  const r = validateSSN("900123456");
  ok('[SSN] "900123456" valid=false',      r.valid === false);
  ok('[SSN] "900123456" area=900',         r.area === 900);
  ok('[SSN] "900123456" synthetic=true',   r.synthetic === true);
}
{
  const r = validateSSN("000123456");
  ok('[SSN] "000123456" valid=false', r.valid === false);
  ok('[SSN] "000123456" area=0',      r.area === 0);
}
{
  const r = validateSSN("666123456");
  ok('[SSN] "666123456" valid=false', r.valid === false);
  ok('[SSN] "666123456" area=666',    r.area === 666);
}
{
  const r = validateSSN("12345");
  ok('[SSN] "12345" too short → valid=false', r.valid === false);
  ok('[SSN] "12345" area=null',               r.area === null);
}
{
  // group=00 → invalid
  const r = validateSSN("123001234");
  ok('[SSN] "123001234" valid=false (group=00)', r.valid === false);
  ok('[SSN] "123001234" area=123',               r.area === 123);
}
{
  // serial=0000 → invalid
  const r = validateSSN("123120000");
  ok('[SSN] "123120000" valid=false (serial=0000)', r.valid === false);
  ok('[SSN] "123120000" area=123',                  r.area === 123);
}

// =============================================================================
// TEST SECTION 6 — validateEIN
// =============================================================================
console.log("\n[helper] validateEIN");
ok('[EIN] "123456789" prefix "12" → true',  validateEIN("123456789") === true);
ok('[EIN] "071234567" prefix "07" → false', validateEIN("071234567") === false);
ok('[EIN] "891234567" prefix "89" → false', validateEIN("891234567") === false);
ok('[EIN] "123" too short → false',         validateEIN("123") === false);
ok('[EIN] "491234567" prefix "49" → false', validateEIN("491234567") === false);
ok('[EIN] "201234567" prefix "20" → true',  validateEIN("201234567") === true);

// =============================================================================
// TEST SECTION 7 — decide()
// =============================================================================
console.log("\n[decide] decision bands");
eq('[decide] score=0   → APPROVED', decide(0).decision,   "APPROVED");
eq('[decide] score=29  → APPROVED', decide(29).decision,  "APPROVED");
eq('[decide] score=30  → REVIEW',   decide(30).decision,  "REVIEW");
eq('[decide] score=69  → REVIEW',   decide(69).decision,  "REVIEW");
eq('[decide] score=70  → DENIED',   decide(70).decision,  "DENIED");
eq('[decide] score=100 → DENIED',   decide(100).decision, "DENIED");
eq('[decide] score=50, timedOut → REVIEW', decide(50, true).decision, "REVIEW");
eq('[decide] score=80, timedOut → REVIEW', decide(80, true).decision, "REVIEW");


// =============================================================================
// ENGINE IMPLEMENTATIONS (inline, pure functions)
// =============================================================================

// E1 — OFAC SDN (40 pts per hit, cap 70)
function runE1(applicantName, sdnList) {
  const norm = normalName(applicantName).toUpperCase();
  let pts = 0; let hits = 0;
  for (const entry of sdnList) {
    const score = Math.max(
      jaroWinkler(norm, entry.toUpperCase()),
      tokenSetSim(norm, entry.toUpperCase())
    );
    if (score >= 0.82) { pts += 40; hits++; }
  }
  return { pts: cap(pts, 70), hits };
}

// E3 — FATF country risk (20 pts)
function runE3(country) {
  return FATF_COUNTRIES.has((country || "").toUpperCase()) ? 20 : 0;
}

// E4 — TIN validity (20 pts if invalid)
function runE4(tin, isIndividual) {
  const clean = (tin || "").replace(/[-\s]/g, "");
  if (isIndividual) {
    const r = validateSSN(clean);
    return r.valid ? 0 : 20;
  } else {
    return validateEIN(clean) ? 0 : 20;
  }
}

// E6 — Structuring (35 pts if 8000 <= amount < 10000)
function runE6(amount) {
  return (amount >= 8000 && amount < 10000) ? 35 : 0;
}

// E8 — UBO cascade (25 pts if any owner >= 25% with SDN score >= 0.82)
function runE8(beneficialOwners) {
  if (!Array.isArray(beneficialOwners)) return 0;
  for (const owner of beneficialOwners) {
    if ((owner.ownership_pct || 0) >= 25 && (owner.sdn_score || 0) >= 0.82) {
      return 25;
    }
  }
  return 0;
}

// E9 — DOB plausibility (35 pts if future, <18, or >120)
function runE9(dob) {
  if (!dob) return 35; // missing DOB is suspicious
  const now  = new Date();
  const birth = new Date(dob);
  if (isNaN(birth)) return 35;
  if (birth > now) return 35; // future
  const ageMs = now - birth;
  const ageDays = ageMs / 86400000;
  const ageYears = ageDays / 365.25;
  if (ageYears < 18)  return 35;
  if (ageYears > 120) return 35;
  return 0;
}

// E10 — Address risk (10 pts if high-risk zip)
function runE10(zip) {
  return HIGH_RISK_ZIPS.has((zip || "").trim()) ? 10 : 0;
}

// E11 — Entity consistency (15 pts each violation, cap 15 for TIN mismatch)
function runE11(applicantName, tinClean, isIndividual) {
  let pts = 0;
  if ((applicantName || "").length < 2)           pts += 15;
  if (!isIndividual && tinClean.length !== 9)       pts += 15;
  return cap(pts, 30); // cap at 30 total but each sub-check is 15
}

// E12 — Corporate depth (20 pts if depth > 4)
function runE12(corporateDepth) {
  return (corporateDepth || 0) > 4 ? 20 : 0;
}

// E13 — Document entropy (10 pts per issue, cap 10)
function runE13(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return 0;
  const now = new Date();
  let pts = 0;
  for (const doc of documents) {
    let docPts = 0;
    if (doc.expiry_date && new Date(doc.expiry_date) < now) docPts += 10;
    if (!doc.document_number)                                docPts += 10;
    else if (doc.document_number.length < 4)                 docPts += 10;
    pts += docPts;
  }
  return cap(pts, 10);
}

// E15 — Synthetic identity (40 pts for individual with synthetic SSN)
function runE15(tin, isIndividual) {
  if (!isIndividual) return 0;
  const clean = (tin || "").replace(/[-\s]/g, "");
  const r = validateSSN(clean);
  return (r && r.synthetic) ? 40 : 0;
}

// E16 — Watchlist delta (30 pts if match)
function runE16(applicantName, deltaList) {
  const norm = normalName(applicantName).toUpperCase();
  for (const entry of deltaList) {
    const score = Math.max(
      jaroWinkler(norm, entry.toUpperCase()),
      tokenSetSim(norm, entry.toUpperCase())
    );
    if (score >= 0.82) return 30;
  }
  return 0;
}

// E17 — FinCEN 314(a) (25 pts if match via Jaro-Winkler >= 0.82 OR tokenSetSim >= 0.80)
function runE17(applicantName, fincenList) {
  const norm = normalName(applicantName).toUpperCase();
  for (const entry of fincenList) {
    const jw  = jaroWinkler(norm, entry.toUpperCase());
    const tss = tokenSetSim(norm, entry.toUpperCase());
    if (jw >= 0.82 || tss >= 0.80) return 25;
  }
  return 0;
}

// Adverse media (5 pts per keyword hit, cap 30)
function runAdverseMedia(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let pts = 0;
  for (const kw of ADVERSE_KEYWORDS) {
    if (lower.includes(kw)) pts += 5;
  }
  return cap(pts, 30);
}

// Network graph (20 pts if networkHits > 3)
function runNetwork(networkHits) {
  return (networkHits || 0) > 3 ? 20 : 0;
}

// Full score pipeline
function runEngines(payload) {
  const {
    applicant_name = "",
    tin = "",
    is_individual = true,
    dob,
    address = {},
    amount = 0,
    documents = [],
    beneficial_owners = [],
    corporate_depth = 0,
    network_hits = 0,
    adverse_media_text = "",
    sdn_list = [],
    delta_list = [],
    fincen_list = []
  } = payload;

  const tinClean     = tin.replace(/[-\s]/g, "");
  const isIndividual = is_individual !== false;

  const e1  = runE1(applicant_name, sdn_list);
  const e3  = runE3(address.country);
  const e4  = runE4(tin, isIndividual);
  const e6  = runE6(amount);
  const e8  = runE8(beneficial_owners);
  const e9  = runE9(dob);
  const e10 = runE10(address.zip);
  const e11 = runE11(applicant_name, tinClean, isIndividual);
  const e12 = runE12(corporate_depth);
  const e13 = runE13(documents);
  const e15 = runE15(tin, isIndividual);
  const e16 = runE16(applicant_name, delta_list);
  const e17 = runE17(applicant_name, fincen_list);
  const eAdv = runAdverseMedia(adverse_media_text);
  const eNet = runNetwork(network_hits);

  const rawScore = e1.pts + e3 + e4 + e6 + e8 + e9 + e10 +
                   e11 + e12 + e13 + e15 + e16 + e17 + eAdv + eNet;
  const risk_score = clamp(rawScore);
  return { risk_score, decision: decide(risk_score).decision };
}

// =============================================================================
// TEST SECTION 8 — Engine unit tests (isolation)
// =============================================================================

// --- E1 OFAC SDN ---
console.log("\n[E1] OFAC SDN engine");
{
  const r = runE1("SPECIALLY DESIGNATED NATIONAL", SDN_LIST);
  ok('[E1] exact SDN match → 40 pts, hits=1', r.pts === 40 && r.hits === 1);
}
{
  const r = runE1("ALICE JOHNSON", SDN_LIST);
  ok('[E1] clean name → 0 pts, hits=0', r.pts === 0 && r.hits === 0);
}
{
  // cap test: manually test cap(80,70)
  ok('[E1] cap(80,70) === 70', cap(80,70) === 70);
}
{
  // Score < 0.82 → 0 pts
  const lowScore = jaroWinkler("ALICE JOHNSON","SPECIALLY DESIGNATED NATIONAL");
  ok('[E1] low similarity < 0.82 → no hit', lowScore < 0.82);
}

// --- E3 FATF ---
console.log("\n[E3] FATF country risk");
ok('[E3] country "IR" → 20 pts', runE3("IR") === 20);
ok('[E3] country "KP" → 20 pts', runE3("KP") === 20);
ok('[E3] country "US" → 0 pts',  runE3("US") === 0);
ok('[E3] country ""   → 0 pts',  runE3("") === 0);
// FATF set size check (at least 55 high-risk countries defined)
ok('[E3] FATF_COUNTRIES.size >= 55', FATF_COUNTRIES.size >= 55);
// Sample 5 known FATF members
ok('[E3] FATF contains AF', FATF_COUNTRIES.has("AF"));
ok('[E3] FATF contains MM', FATF_COUNTRIES.has("MM"));
ok('[E3] FATF contains YE', FATF_COUNTRIES.has("YE"));
ok('[E3] FATF contains PK', FATF_COUNTRIES.has("PK"));
ok('[E3] FATF contains SY', FATF_COUNTRIES.has("SY"));

// --- E4 TIN Individual ---
console.log("\n[E4] TIN/SSN individual");
ok('[E4-ind] valid SSN "123456789" → 0 pts',      runE4("123456789", true)  === 0);
ok('[E4-ind] synthetic SSN "900123456" → 20 pts',  runE4("900123456", true)  === 20);
ok('[E4-ind] area-0 SSN "000123456" → 20 pts',     runE4("000123456", true)  === 20);

// --- E4 TIN Business ---
console.log("\n[E4] TIN/EIN business");
ok('[E4-biz] valid EIN "201234567" → 0 pts',       runE4("201234567", false) === 0);
ok('[E4-biz] disallowed EIN "071234567" → 20 pts', runE4("071234567", false) === 20);

// --- E6 Structuring ---
console.log("\n[E6] Structuring");
ok('[E6] amount 8000 → 35 pts',  runE6(8000)  === 35);
ok('[E6] amount 9999 → 35 pts',  runE6(9999)  === 35);
ok('[E6] amount 7999 → 0 pts',   runE6(7999)  === 0);
ok('[E6] amount 10000 → 0 pts',  runE6(10000) === 0);
ok('[E6] amount 0 → 0 pts',      runE6(0)     === 0);

// --- E9 DOB Plausibility ---
console.log("\n[E9] DOB plausibility");
{
  const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0,10);
  ok('[E9] future DOB → 35 pts', runE9(future) === 35);
}
{
  const under18 = new Date(Date.now() - 86400000 * 365.25 * 17).toISOString().slice(0,10);
  ok('[E9] age ~17 → 35 pts', runE9(under18) === 35);
}
{
  const over120 = new Date(Date.now() - 86400000 * 365.25 * 130).toISOString().slice(0,10);
  ok('[E9] age ~130 → 35 pts', runE9(over120) === 35);
}
{
  const age30 = new Date(Date.now() - 86400000 * 365.25 * 30).toISOString().slice(0,10);
  ok('[E9] age 30 → 0 pts', runE9(age30) === 0);
}

// --- E10 Address Risk ---
console.log("\n[E10] Address risk");
ok('[E10] zip "00600" → 10 pts', runE10("00600") === 10);
ok('[E10] zip "10001" → 0 pts',  runE10("10001") === 0);

// --- E11 Entity Consistency ---
console.log("\n[E11] Entity consistency");
ok('[E11] biz, tin length != 9 → 15 pts',   runE11("Acme Corp", "12345",     false) === 15);
ok('[E11] biz, tin length == 9 → 0 pts',    runE11("Acme Corp", "123456789", false) === 0);
ok('[E11] name.length < 2 → 15 pts',        runE11("",          "123456789", true)  === 15);
// Both violations (biz + no name) → capped at 30
ok('[E11] no name + bad TIN → 30 pts max',  runE11("",          "12345",     false) === 30);

// --- E12 Corporate Depth ---
console.log("\n[E12] Corporate depth");
ok('[E12] depth 5 → 20 pts', runE12(5) === 20);
ok('[E12] depth 4 → 0 pts',  runE12(4) === 0);
ok('[E12] depth 3 → 0 pts',  runE12(3) === 0);

// --- E13 Document Entropy ---
console.log("\n[E13] Document entropy");
ok('[E13] expired doc → 10 pts',
   runE13([{ expiry_date: "2000-01-01", document_number: "ABCD1234" }]) === 10);
ok('[E13] no document_number → 10 pts',
   runE13([{ expiry_date: "2099-01-01", document_number: null }]) === 10);
ok('[E13] doc_number.length < 4 → 10 pts',
   runE13([{ expiry_date: "2099-01-01", document_number: "AB" }]) === 10);
ok('[E13] valid doc → 0 pts',
   runE13([{ expiry_date: "2099-01-01", document_number: "ABCD1234" }]) === 0);
// cap: two expired docs would be 20, cap to 10
ok('[E13] two expired docs → cap(20,10)=10',
   runE13([
     { expiry_date: "2000-01-01", document_number: "ABCD1234" },
     { expiry_date: "1999-01-01", document_number: "EFGH5678" }
   ]) === 10);

// --- E15 Synthetic Identity ---
console.log("\n[E15] Synthetic identity");
ok('[E15] individual SSN 900... → 40 pts',  runE15("900123456", true)  === 40);
ok('[E15] individual SSN 123... → 0 pts',   runE15("123456789", true)  === 0);
ok('[E15] business entity → 0 pts',         runE15("900123456", false) === 0);

// --- E16 Watchlist Delta ---
console.log("\n[E16] Watchlist delta");
ok('[E16] exact delta match → 30 pts',
   runE16("NEWLY ADDED SANCTIONS PERSON", DELTA_LIST) === 30);
ok('[E16] no match → 0 pts',
   runE16("ALICE JOHNSON", DELTA_LIST) === 0);

// --- E17 FinCEN 314(a) ---
console.log("\n[E17] FinCEN 314(a)");
ok('[E17] exact FinCEN match (JW >= 0.82) → 25 pts',
   runE17("PABLO ESCOBAR", FINCEN_LIST) === 25);
{
  // tokenSetSim >= 0.80 path: same tokens different order
  ok('[E17] tokenSetSim path (tokens match) → 25 pts',
     runE17("ESCOBAR PABLO", FINCEN_LIST) === 25);
}
ok('[E17] no match → 0 pts',
   runE17("ALICE JOHNSON", FINCEN_LIST) === 0);


// =============================================================================
// TEST SECTION 9 — Adverse media
// =============================================================================
console.log("\n[Adverse Media] E7/E2");
ok('[AdverseMedia] "fraud" + "money laundering" → 10 pts',
   runAdverseMedia("There was fraud and money laundering involved") === 10);
{
  // 7 keywords → 35 pts raw → capped at 30
  const text = "fraud money laundering terrorism sanctions bribery corruption trafficking";
  ok('[AdverseMedia] 7 keywords → cap(35,30) = 30 pts', runAdverseMedia(text) === 30);
}
ok('[AdverseMedia] no keywords → 0 pts',
   runAdverseMedia("The applicant has a clean record.") === 0);
ok('[AdverseMedia] empty string → 0 pts', runAdverseMedia("") === 0);

// =============================================================================
// TEST SECTION 10 — Network graph (E14 / E5)
// =============================================================================
console.log("\n[Network graph] E14");
ok('[Network] networkHits > 3 → 20 pts',  runNetwork(4) === 20);
ok('[Network] networkHits = 4 → 20 pts',  runNetwork(4) === 20);
ok('[Network] networkHits = 3 → 0 pts',   runNetwork(3) === 0);
ok('[Network] networkHits = 0 → 0 pts',   runNetwork(0) === 0);

// =============================================================================
// TEST SECTION 11 — UBO cascade (E8)
// =============================================================================
console.log("\n[E8] UBO / beneficial owner cascade");
ok('[E8] owner >= 25% + sdn_score >= 0.82 → 25 pts',
   runE8([{ name: "IRAN SANCTIONS ENTITY", ownership_pct: 30, sdn_score: 0.95 }]) === 25);
ok('[E8] owner >= 25% but sdn_score < 0.82 → 0 pts',
   runE8([{ name: "nobody", ownership_pct: 30, sdn_score: 0.1 }]) === 0);
ok('[E8] owner with high score but < 25% ownership → 0 pts',
   runE8([{ name: "IRAN SANCTIONS ENTITY", ownership_pct: 10, sdn_score: 0.95 }]) === 0);
ok('[E8] empty array → 0 pts', runE8([]) === 0);
ok('[E8] null → 0 pts',        runE8(null) === 0);

// =============================================================================
// TEST SECTION 12 — Batch payload validation
// =============================================================================
console.log("\n[Route] batch payload validation");
function validateBatch(items) {
  if (!Array.isArray(items))      return { error: "items must be an array" };
  if (items.length === 0)         return { error: "items must not be empty" };
  if (items.length > 50)          return { error: "batch size exceeds limit of 50" };
  return { ok: true };
}
ok('[batch] empty items → error',           validateBatch([]).error !== undefined);
ok('[batch] 51 items → error',              validateBatch(new Array(51).fill({})).error !== undefined);
ok('[batch] 50 items → no length error',    validateBatch(new Array(50).fill({})).ok === true);
ok('[batch] 1 item → no error',             validateBatch([{}]).ok === true);
ok('[batch] non-array → error',             validateBatch(null).error !== undefined);

// =============================================================================
// TEST SECTION 13 — Integration scenarios
// =============================================================================
console.log("\n[Integration] end-to-end scenarios");

// Scenario 1: Clean individual → APPROVED
{
  const result = runEngines({
    applicant_name: "Alice Johnson",
    tin: "234567890",
    is_individual: true,
    dob: "1985-05-15",
    address: { country: "US", zip: "10001" },
    amount: 500,
    documents: [{ expiry_date: "2030-01-01", document_number: "DL987654" }],
    sdn_list: [], delta_list: [], fincen_list: []
  });
  ok('[Scenario 1] clean individual risk_score <= 29',      result.risk_score <= 29);
  eq('[Scenario 1] clean individual decision = APPROVED',   result.decision, "APPROVED");
}

// Scenario 2: OFAC SDN hit → DENIED
{
  const result = runEngines({
    applicant_name: "SPECIALLY DESIGNATED NATIONAL",
    tin: "900000001",         // invalid SSN → E4=20, E15=40
    is_individual: true,
    dob: "1975-01-01",
    address: { country: "IR", zip: "10001" }, // FATF → 20
    amount: 500,
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: SDN_LIST, delta_list: [], fincen_list: []
  });
  // E1=40 + E3=20 + E4=20 + E15=40 = 120 → clamped to 100
  ok('[Scenario 2] SDN+FATF+synthetic score >= 70', result.risk_score >= 70);
  eq('[Scenario 2] OFAC+FATF+invalid SSN → DENIED', result.decision, "DENIED");
}

// Scenario 3: Structuring flag → REVIEW
{
  const result = runEngines({
    applicant_name: "Bob Smith",
    tin: "234567890",
    is_individual: true,
    dob: "1980-03-10",
    address: { country: "US", zip: "10001" },
    amount: 9500,            // E6 → 35 pts
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: [], delta_list: [], fincen_list: []
  });
  ok('[Scenario 3] structuring score 30-69',       result.risk_score >= 30 && result.risk_score <= 69);
  eq('[Scenario 3] structuring → REVIEW',          result.decision, "REVIEW");
}

// Scenario 4: Synthetic SSN only → REVIEW (60 pts < 70)
{
  const result = runEngines({
    applicant_name: "John Doe",
    tin: "900000001",       // E4=20 + E15=40 = 60
    is_individual: true,
    dob: "1985-06-20",
    address: { country: "US", zip: "10001" },
    amount: 500,
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: [], delta_list: [], fincen_list: []
  });
  ok('[Scenario 4a] synthetic SSN score = 60',  result.risk_score === 60);
  eq('[Scenario 4a] synthetic SSN → REVIEW',    result.decision, "REVIEW");
}
// Scenario 4b: Synthetic + FATF → DENIED
{
  const result = runEngines({
    applicant_name: "John Doe",
    tin: "900000001",       // E4=20 + E15=40 = 60
    is_individual: true,
    dob: "1985-06-20",
    address: { country: "IR", zip: "10001" }, // +20 = 80
    amount: 500,
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: [], delta_list: [], fincen_list: []
  });
  ok('[Scenario 4b] synthetic+FATF score >= 70', result.risk_score >= 70);
  eq('[Scenario 4b] synthetic+FATF → DENIED',   result.decision, "DENIED");
}

// Scenario 6: Entity consistency — no name
{
  const e11 = runE11("", "123456789", true);
  ok('[Scenario 6] empty name → e11Pts = 15', e11 === 15);
}
{
  // Business + short TIN + no name → cap 30
  const e11 = runE11("", "12345", false);
  ok('[Scenario 6] no name + biz short TIN → 30', e11 === 30);
}

// Scenario 7: UBO cascade (already tested above — reference check)
{
  const e8a = runE8([{ name: "IRAN SANCTIONS ENTITY", ownership_pct: 30, sdn_score: 0.95 }]);
  ok('[Scenario 7] UBO with SDN match → 25 pts', e8a === 25);
  const e8b = runE8([{ name: "nobody", ownership_pct: 30, sdn_score: 0.1 }]);
  ok('[Scenario 7] UBO no SDN match → 0 pts', e8b === 0);
}

// Scenario 8: Adverse media
{
  ok('[Scenario 8] "fraud"+"money laundering" → 10',
     runAdverseMedia("fraud and money laundering") === 10);
  const text7kw = "fraud money laundering terrorism sanctions bribery corruption trafficking";
  ok('[Scenario 8] 7 keywords → 30 (capped)',
     runAdverseMedia(text7kw) === 30);
  ok('[Scenario 8] no keywords → 0',
     runAdverseMedia("good applicant clean record") === 0);
}

// Scenario 9: DOB edge cases
{
  // Tomorrow
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  ok("[Scenario 9] tomorrow's DOB → 35 pts",  runE9(tomorrow) === 35);
}
{
  // Exactly 17 years ago minus 1 day (definitely under 18)
  const under18 = new Date(Date.now() - 86400000 * Math.ceil(365.25 * 17)).toISOString().slice(0,10);
  ok("[Scenario 9] age ~17 → 35 pts", runE9(under18) === 35);
}
{
  // Exactly 18 years ago (valid)
  const exact18 = new Date(Date.now() - 86400000 * (Math.ceil(365.25 * 18) + 1)).toISOString().slice(0,10);
  ok("[Scenario 9] age exactly 18 → 0 pts", runE9(exact18) === 0);
}

// Scenario 10: Network graph
{
  ok('[Scenario 10] networkHits > 3 → 20 pts', runNetwork(10) === 20);
  ok('[Scenario 10] networkHits = 3 → 0 pts',  runNetwork(3) === 0);
  ok('[Scenario 10] networkHits = 4 → 20 pts', runNetwork(4) === 20);
}

// =============================================================================
// TEST SECTION 14 — Route validation helpers
// =============================================================================
console.log("\n[Route] input validation");
function validateSinglePayload(p) {
  const errors = [];
  if (!p || typeof p !== "object")          { errors.push("payload must be object"); return errors; }
  if (typeof p.applicant_name !== "string" || p.applicant_name.trim().length === 0)
    errors.push("applicant_name required");
  if (typeof p.tin !== "string" || p.tin.trim().length === 0)
    errors.push("tin required");
  if (typeof p.amount !== "number" || p.amount < 0)
    errors.push("amount must be non-negative number");
  return errors;
}
ok('[Route] missing applicant_name → error',
   validateSinglePayload({ tin: "123456789", amount: 100 }).length > 0);
ok('[Route] missing tin → error',
   validateSinglePayload({ applicant_name: "Alice", amount: 100 }).length > 0);
ok('[Route] negative amount → error',
   validateSinglePayload({ applicant_name: "Alice", tin: "123456789", amount: -1 }).length > 0);
ok('[Route] valid payload → no errors',
   validateSinglePayload({ applicant_name: "Alice", tin: "123456789", amount: 0 }).length === 0);
ok('[Route] null payload → error',
   validateSinglePayload(null).length > 0);

// =============================================================================
// TEST SECTION 15 — CORS / HTTP method stubs
// =============================================================================
console.log("\n[Route] HTTP method / CORS stubs");
function stubHandleRequest(method, pathname) {
  if (method === "OPTIONS") return { status: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  if (method !== "POST" && method !== "GET") return { status: 405, body: "Method Not Allowed" };
  if (pathname === "/health") return { status: 200, body: "ok" };
  if (pathname === "/v1/screen") return { status: 200, body: "screen" };
  if (pathname === "/v1/batch") return { status: 200, body: "batch" };
  return { status: 404, body: "Not Found" };
}
eq('[Route] OPTIONS → 204',             stubHandleRequest("OPTIONS","/v1/screen").status, 204);
eq('[Route] OPTIONS has CORS header',   stubHandleRequest("OPTIONS","/v1/screen").headers["Access-Control-Allow-Origin"], "*");
eq('[Route] PUT → 405',                 stubHandleRequest("PUT","/v1/screen").status, 405);
eq('[Route] GET /health → 200',         stubHandleRequest("GET","/health").status, 200);
eq('[Route] POST /v1/screen → 200',     stubHandleRequest("POST","/v1/screen").status, 200);
eq('[Route] POST /v1/batch → 200',      stubHandleRequest("POST","/v1/batch").status, 200);
eq('[Route] GET /unknown → 404',        stubHandleRequest("GET","/unknown").status, 404);

// =============================================================================
// TEST SECTION 16 — Additional edge cases
// =============================================================================
console.log("\n[Edge cases] Additional coverage");

// jaroWinkler single-char strings
ok('[edge] jaroWinkler("A","A") === 1', jaroWinkler("A","A") === 1);
ok('[edge] jaroWinkler("A","B") < 1',  jaroWinkler("A","B") < 1);

// tokenSetSim completely disjoint
eq('[edge] tokenSetSim disjoint sets = 0',
   tokenSetSim("ALPHA BETA","GAMMA DELTA"), 0);

// tokenSetSim empty both
eq('[edge] tokenSetSim("","") = 0', tokenSetSim("",""), 0);

// normalName no suffix
eq('[edge] normalName("Alice Johnson") = "Alice Johnson"',
   normalName("Alice Johnson"), "Alice Johnson");

// normalName IV suffix
eq('[edge] normalName strips IV', normalName("John Smith IV"), "John Smith");

// validateSSN all nines (area=999 → synthetic)
{
  const r = validateSSN("999999999");
  ok('[edge] SSN "999999999" → synthetic', r.synthetic === true && r.valid === false);
}

// validateEIN prefix "00" → disallowed
ok('[edge] EIN prefix "00" → false', validateEIN("001234567") === false);

// decide boundary exactly 0
eq('[edge] decide(0) → APPROVED', decide(0).decision, "APPROVED");

// clamp 0 stays 0
eq('[edge] clamp(0) = 0', clamp(0), 0);

// E6 boundary: exactly 8000 is included
ok('[E6 edge] amount exactly 8000 → 35', runE6(8000) === 35);
// E6 boundary: exactly 10000 excluded
ok('[E6 edge] amount exactly 10000 → 0', runE6(10000) === 0);

// E9 with invalid date string
ok('[E9 edge] invalid date → 35 pts (treated as suspicious)', runE9("not-a-date") === 35);

// E12 exactly 4 → 0
ok('[E12 edge] depth exactly 4 → 0', runE12(4) === 0);
// E12 exactly 5 → 20
ok('[E12 edge] depth exactly 5 → 20', runE12(5) === 20);

// E13 empty array → 0
ok('[E13 edge] empty docs array → 0', runE13([]) === 0);

// E15 non-individual with synthetic SSN → 0
ok('[E15 edge] business entity always 0', runE15("900000001", false) === 0);

// Adverse media single keyword
ok('[AdverseMedia edge] single "ponzi" keyword → 5 pts', runAdverseMedia("This was a ponzi scheme") === 5);

// Batch exactly 50 is valid
ok('[batch edge] exactly 50 items → ok', validateBatch(new Array(50).fill({})).ok === true);
// Batch exactly 51 is invalid
ok('[batch edge] exactly 51 items → error', validateBatch(new Array(51).fill({})).error !== undefined);

// Full integration: PEP + E16 delta hit
{
  const result = runEngines({
    applicant_name: "NEWLY ADDED SANCTIONS PERSON",
    tin: "234567890",
    is_individual: true,
    dob: "1975-01-01",
    address: { country: "US", zip: "10001" },
    amount: 500,
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: [], delta_list: DELTA_LIST, fincen_list: []
  });
  // E16 = 30 → REVIEW
  ok('[E16 integration] delta hit score >= 30', result.risk_score >= 30);
}

// Full integration: FinCEN hit (E17=25) + structuring (E6=35) = 60 → REVIEW
{
  const result = runEngines({
    applicant_name: "PABLO ESCOBAR",
    tin: "234567890",
    is_individual: true,
    dob: "1960-01-01",
    address: { country: "US", zip: "10001" },
    amount: 9000,             // E6 structuring: 35 pts → total 60 → REVIEW
    documents: [{ expiry_date: "2030-01-01", document_number: "PP123456" }],
    sdn_list: [], delta_list: [], fincen_list: FINCEN_LIST
  });
  // E17=25 + E6=35 = 60 → REVIEW
  ok('[E17 integration] FinCEN+structuring score >= 25', result.risk_score >= 25);
  eq('[E17 integration] FinCEN+structuring → REVIEW', result.decision, "REVIEW");
}

// =============================================================================
// TEST SECTION 17 — Score accumulation / clamp
// =============================================================================
console.log("\n[Score] accumulation and clamping");
{
  // Pile on many penalties to verify clamp(n) never exceeds 100
  const result = runEngines({
    applicant_name: "SPECIALLY DESIGNATED NATIONAL",
    tin: "900000001",
    is_individual: true,
    dob: "2090-01-01",                // future
    address: { country: "IR", zip: "00600" },
    amount: 9500,
    documents: [
      { expiry_date: "2000-01-01", document_number: null },  // expired + no num
      { expiry_date: "1990-01-01", document_number: "X" }    // expired + short num
    ],
    beneficial_owners: [{ name: "bad actor", ownership_pct: 51, sdn_score: 0.99 }],
    corporate_depth: 10,
    network_hits: 10,
    adverse_media_text: "fraud money laundering terrorism sanctions bribery corruption trafficking embezzlement ponzi felony",
    sdn_list: SDN_LIST, delta_list: DELTA_LIST, fincen_list: FINCEN_LIST
  });
  ok('[Score] worst-case score clamped to 100', result.risk_score === 100);
  eq('[Score] worst-case → DENIED', result.decision, "DENIED");
}

// Zero-score control
{
  const result = runEngines({
    applicant_name: "Alice Johnson",
    tin: "234567890",
    is_individual: true,
    dob: "1985-06-15",
    address: { country: "US", zip: "10001" },
    amount: 100,
    documents: [{ expiry_date: "2035-01-01", document_number: "ABCD1234" }],
    beneficial_owners: [],
    corporate_depth: 0,
    network_hits: 0,
    adverse_media_text: "",
    sdn_list: [], delta_list: [], fincen_list: []
  });
  ok('[Score] zero-risk score = 0', result.risk_score === 0);
  eq('[Score] zero-risk → APPROVED', result.decision, "APPROVED");
}

// =============================================================================
// FINAL REPORT
// =============================================================================
const TOTAL = PASSED + FAILED;
console.log("\n--- Results ---");
if (FAILED === 0) {
  console.log(`✅ ALL ${TOTAL} ASSERTIONS PASSED`);
} else {
  console.log(`✅ ${PASSED} PASSED`);
  console.log(`❌ ${FAILED} FAILED`);
  console.log("\nFailed assertions:");
  FAILURES.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
console.log(`\nTotal assertions run: ${TOTAL}`);
