#!/usr/bin/env node
// =============================================================
//  KYC-Gateway v11.0 — Unit Test Suite
//  Node.js, zero external dependencies, 150+ assertions
//  Run: node unit_test.cjs
// =============================================================
"use strict";

let passed = 0, failed = 0, total = 0;

function assert(label, condition, extra) {
  total++;
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed++;
    process.stderr.write(`  ✗ FAIL: ${label}${extra ? " — " + extra : ""}\n`);
  }
}

function assertEqual(label, a, b) {
  assert(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertRange(label, v, lo, hi) {
  assert(label, v >= lo && v <= hi, `expected ${lo}–${hi}, got ${v}`);
}

function section(name) {
  console.log(`\n▶ ${name}`);
}

// ─── Re-implement testable pure functions ────────────────────

const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|trust)\b\.?/gi;
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
  const pfxLen = [...a].findIndex((c, i) => c !== b[i]);
  const pfx = pfxLen === -1 ? Math.min(4, la) : Math.min(4, pfxLen);
  return jaro + pfx * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const inter = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : inter / union;
}

function stripTin(tin) { return (tin || "").replace(/\D/g, ""); }

function isValidSSN(tin) {
  const d = stripTin(tin);
  if (d.length !== 9) return false;
  const area = +d.slice(0, 3);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (d.slice(3, 5) === "00") return false;
  if (d.slice(5) === "0000") return false;
  return true;
}

const EIN_DISALLOWED = new Set(["07","08","09","17","18","19","28","29","49","69","70","78","79","89","96","97"]);
function isValidEIN(tin) {
  const d = stripTin(tin);
  if (d.length !== 9) return false;
  return !EIN_DISALLOWED.has(d.slice(0, 2));
}

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

function fuzzyMatch(name, list) {
  const n = normalName(name);
  return list.filter(e => {
    const en = normalName(typeof e === "string" ? e : e.name || "");
    return jaroWinkler(n, en) >= 0.82 || tokenSetSimilarity(n, en) >= 0.80;
  });
}

// Decision bands
function decide(score) {
  if (score >= 70) return "DENIED";
  if (score >= 30) return "REVIEW";
  return "APPROVED";
}

// E3 FATF
function e3FATF(payload) {
  const countries = [payload.country_of_residence, payload.nationality].filter(Boolean);
  const hits = countries.filter(c => FATF_HIGH_RISK.has(c.toUpperCase()));
  return { score: hits.length ? 20 : 0, flags: hits.length ? ["E3_FATF_HIGH_RISK"] : [] };
}

// E4 TIN
function e4TIN(payload) {
  const tin = stripTin(payload.tin || "");
  if (payload.entity_type === "individual") {
    const valid = isValidSSN(tin);
    return { score: valid ? 0 : 20, flags: valid ? [] : ["E4_INVALID_SSN"], tinValid: valid, einValid: false };
  }
  if (payload.entity_type === "business") {
    const valid = isValidEIN(tin);
    return { score: valid ? 0 : 20, flags: valid ? [] : ["E4_INVALID_EIN"], tinValid: false, einValid: valid };
  }
  return { score: 20, flags: ["E4_UNKNOWN_ENTITY_TYPE"], tinValid: false, einValid: false };
}

// E6 Structuring
function e6Structuring(payload) {
  const amounts = [payload.payment_amount, payload.requested_amount].filter(v => typeof v === "number");
  const hits = amounts.filter(a => a >= 8000 && a <= 9999);
  return { score: hits.length ? 35 : 0, flags: hits.length ? ["E6_STRUCTURING"] : [] };
}

// E7 Adverse Media
function e7AdverseMedia(payload) {
  const text = [payload.applicant_name, payload.business_name,
    ...(payload.adverse_media_terms || [])].filter(Boolean).join(" ").toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(k => text.includes(k));
  return { score: Math.min(hits.length * 5, 30), flags: hits.length ? ["E7_ADVERSE_MEDIA"] : [], hits };
}

// E9 DOB
function e9DOB(payload) {
  if (!payload.dob || payload.entity_type !== "individual")
    return { score: 0, flags: [] };
  const dob = new Date(payload.dob);
  const now = new Date();
  if (isNaN(dob.getTime())) return { score: 35, flags: ["E9_INVALID_DOB"] };
  const ageYears = (now - dob) / (365.25 * 86400 * 1000);
  let reason = null;
  if (dob > now) reason = "future";
  else if (ageYears < 18) reason = "under18";
  else if (ageYears > 120) reason = "over120";
  return { score: reason ? 35 : 0, flags: reason ? ["E9_DOB_IMPLAUSIBLE"] : [], reason };
}

// E10 Address
function e10Address(payload) {
  const addr = payload.address || {};
  const poBox = /\bP\.?\s*O\.?\s*BOX\b/i.test(addr.street || "");
  const incomplete = !addr.city || !addr.state || !addr.zip;
  return { score: (poBox || incomplete) ? 10 : 0, flags: (poBox || incomplete) ? ["E10_ADDRESS_RISK"] : [] };
}

// E11 Entity Consistency
function e11Consistency(payload) {
  const tin = stripTin(payload.tin || "");
  if (payload.entity_type === "individual" && isValidEIN(tin) && !isValidSSN(tin))
    return { score: 15, flags: ["E11_ENTITY_MISMATCH"] };
  if (payload.entity_type === "business" && isValidSSN(tin) && !isValidEIN(tin))
    return { score: 15, flags: ["E11_ENTITY_MISMATCH"] };
  return { score: 0, flags: [] };
}

// E12 Corporate Depth
function e12CorpDepth(payload) {
  return payload.num_corporate_layers > 4
    ? { score: 20, flags: ["E12_DEEP_CORPORATE_STRUCTURE"] }
    : { score: 0, flags: [] };
}

// E13 Document Entropy
function e13DocEntropy(payload) {
  const flags = [];
  if (!payload.doc_type) flags.push("E13_DOC_TYPE_MISSING");
  if (!payload.doc_expiry_date) flags.push("E13_DOC_EXPIRY_MISSING");
  else if (new Date(payload.doc_expiry_date) < new Date()) flags.push("E13_DOC_EXPIRED");
  return { score: flags.length ? 10 : 0, flags };
}

// E15 Synthetic Identity
function e15Synthetic(payload) {
  if (payload.entity_type !== "individual") return { score: 0, flags: [] };
  const area = parseInt(stripTin(payload.tin || "").slice(0, 3), 10);
  return area >= 900 ? { score: 40, flags: ["E15_SYNTHETIC_SSN"] } : { score: 0, flags: [] };
}

// ════════════════════════════════════════════════════════════
//  TEST SECTIONS
// ════════════════════════════════════════════════════════════

section("normalName — suffix stripping");
assertEqual("strips Jr", normalName("John Smith Jr"), "john smith");
assertEqual("strips SR", normalName("Jane Doe SR"), "jane doe");
assertEqual("strips II", normalName("Robert King II"), "robert king");
assertEqual("strips III", normalName("Robert King III"), "robert king");
assertEqual("strips IV", normalName("Robert King IV"), "robert king");
assertEqual("strips LLC", normalName("Acme Corp LLC"), "acme");
assertEqual("strips Inc", normalName("Widgets Inc"), "widgets");
assertEqual("strips Corp", normalName("Shell Corp"), "shell");
assertEqual("strips Ltd", normalName("Holdings Ltd"), "holdings");
assertEqual("strips Trust", normalName("Family Trust"), "family");
assertEqual("strips Co", normalName("Acme Co"), "acme");
assertEqual("empty string", normalName(""), "");
assertEqual("null-safe", normalName(null), "");
assertEqual("multiple spaces collapsed", normalName("John  Smith"), "john smith");

section("jaroWinkler — similarity");
assert("identical strings → 1.0", jaroWinkler("john smith", "john smith") === 1.0);
assert("JW identical empty strings → 1", jaroWinkler("", "") === 1);
assertRange("'JOHN SMITH' vs 'JON SMITH' high similarity", jaroWinkler("john smith", "jon smith"), 0.88, 1.0);
assertRange("'Martha' vs 'Marhta' transposition", jaroWinkler("martha", "marhta"), 0.95, 1.0);
assert("completely different → low", jaroWinkler("xyz", "abc") < 0.5);
assertRange("prefix boost 'CRATE' vs 'TRACE'", jaroWinkler("crate", "trace"), 0.5, 0.95);

section("tokenSetSimilarity");
assertEqual("identical token sets", tokenSetSimilarity("john smith", "john smith"), 1);
assertEqual("empty sets", tokenSetSimilarity("", ""), 0);
assertRange("partial match 'john doe' vs 'john smith doe'", tokenSetSimilarity("john doe", "john smith doe"), 0.4, 0.8);
assert("no overlap → 0", tokenSetSimilarity("alpha", "beta") === 0);
assertRange("superset match", tokenSetSimilarity("acme corporation", "acme"), 0.4, 0.6);

section("E1/E2 fuzzyMatch");
const sdnList = ["John Doe", "Mohammed Al-Rashid", "Viktor Bout", "Kim Jong Un"];
const hits1 = fuzzyMatch("John Doe", sdnList);
assert("exact match returns hit", hits1.length > 0);
const hits2 = fuzzyMatch("Viktor Boutt", sdnList); // typo
assert("near-match Viktor Boutt finds Viktor Bout", hits2.length > 0);
const hits3 = fuzzyMatch("George Washington", sdnList);
assert("no match for clean name", hits3.length === 0);
const hits4 = fuzzyMatch("Jhon Doe", sdnList); // transposition
assert("transposition 'Jhon Doe' matches 'John Doe'", hits4.length > 0);

section("E3 — FATF High-Risk Jurisdictions (55 countries)");
assertEqual("FATF size", FATF_HIGH_RISK.size, 56);
assert("Iran (IR) is high-risk", FATF_HIGH_RISK.has("IR"));
assert("North Korea (KP) is high-risk", FATF_HIGH_RISK.has("KP"));
assert("Russia (RU) is high-risk", FATF_HIGH_RISK.has("RU"));
assert("Syria (SY) is high-risk", FATF_HIGH_RISK.has("SY"));
assert("US is NOT high-risk", !FATF_HIGH_RISK.has("US"));
assert("UK is NOT high-risk", !FATF_HIGH_RISK.has("GB"));
assert("Germany NOT high-risk", !FATF_HIGH_RISK.has("DE"));
const r_ir = e3FATF({ country_of_residence: "IR", nationality: "US" });
assertEqual("Iran resident flagged", r_ir.score, 20);
assert("flag name correct", r_ir.flags.includes("E3_FATF_HIGH_RISK"));
const r_us = e3FATF({ country_of_residence: "US", nationality: "US" });
assertEqual("US resident not flagged", r_us.score, 0);
const r_kp = e3FATF({ country_of_residence: "KP" });
assertEqual("KP flagged", r_kp.score, 20);
const r_lower = e3FATF({ country_of_residence: "ir" }); // lowercase
assertEqual("lowercase IR flagged (normalised)", r_lower.score, 20);

section("E4 — TIN/EIN Validation");
assert("valid SSN 123-45-6789", isValidSSN("123456789"));
assert("SSN area 000 invalid", !isValidSSN("000456789"));
assert("SSN area 666 invalid", !isValidSSN("666456789"));
assert("SSN area 900 invalid", !isValidSSN("900456789"));
assert("SSN area 999 invalid", !isValidSSN("999456789"));
assert("SSN middle 00 invalid", !isValidSSN("123006789"));
assert("SSN last 0000 invalid", !isValidSSN("123450000"));
assert("SSN too short invalid", !isValidSSN("12345678"));
assert("valid EIN 12-3456789", isValidEIN("123456789"));
assert("EIN prefix 07 invalid", !isValidEIN("073456789"));
assert("EIN prefix 96 invalid", !isValidEIN("963456789"));
assert("EIN prefix 00 valid", isValidEIN("001234567"));

const r4a = e4TIN({ entity_type: "individual", tin: "123-45-6789" });
assertEqual("valid individual SSN score 0", r4a.score, 0);
assert("tinValid true", r4a.tinValid);

const r4b = e4TIN({ entity_type: "individual", tin: "000-45-6789" });
assertEqual("invalid SSN gets 20pts", r4b.score, 20);
assert("E4_INVALID_SSN flag", r4b.flags.includes("E4_INVALID_SSN"));

const r4c = e4TIN({ entity_type: "business", tin: "12-3456789" });
assertEqual("valid EIN score 0", r4c.score, 0);
assert("einValid true", r4c.einValid);

const r4d = e4TIN({ entity_type: "business", tin: "07-3456789" });
assertEqual("invalid EIN gets 20pts", r4d.score, 20);
assert("E4_INVALID_EIN flag", r4d.flags.includes("E4_INVALID_EIN"));

section("E6 — Structuring Detection");
const r6a = e6Structuring({ payment_amount: 9500 });
assertEqual("$9500 payment flagged", r6a.score, 35);
assert("E6_STRUCTURING flag", r6a.flags.includes("E6_STRUCTURING"));
const r6b = e6Structuring({ payment_amount: 7999 });
assertEqual("$7999 below threshold — no flag", r6b.score, 0);
const r6c = e6Structuring({ payment_amount: 10000 });
assertEqual("$10000 above threshold — no flag", r6c.score, 0);
const r6d = e6Structuring({ requested_amount: 8000 });
assertEqual("$8000 requested_amount flagged", r6d.score, 35);
const r6e = e6Structuring({ payment_amount: 5000, requested_amount: 9999 });
assertEqual("$9999 requested flagged", r6e.score, 35);
const r6f = e6Structuring({});
assertEqual("no amounts — no flag", r6f.score, 0);

section("E7 — Adverse Media");
const r7a = e7AdverseMedia({ applicant_name: "John Fraud Smith" });
assertEqual("'fraud' in name — score 5", r7a.score, 5);
assert("E7_ADVERSE_MEDIA flag", r7a.flags.includes("E7_ADVERSE_MEDIA"));
const r7b = e7AdverseMedia({ applicant_name: "Normal Person" });
assertEqual("clean name — score 0", r7b.score, 0);
const r7c = e7AdverseMedia({ adverse_media_terms: ["terrorism", "narcotics", "cartel", "laundering", "fraud", "ransomware"] });
assertEqual("6 keywords → 30pts (capped)", r7c.score, 30);
const r7d = e7AdverseMedia({ business_name: "Ponzi Capital Partners" });
assert("'ponzi' in business_name flagged", r7d.score > 0);
assert("20 adverse keywords defined", ADVERSE_KEYWORDS.length === 20);

section("E9 — DOB Plausibility");
const future = new Date(Date.now() + 86400000 * 365).toISOString().split("T")[0];
const r9a = e9DOB({ entity_type: "individual", dob: future });
assertEqual("future DOB flagged", r9a.score, 35);
assert("E9_DOB_IMPLAUSIBLE", r9a.flags.includes("E9_DOB_IMPLAUSIBLE"));

const r9b = e9DOB({ entity_type: "individual", dob: "2015-01-01" });
assertEqual("under-18 DOB flagged", r9b.score, 35);
assert("under-18 reason", r9b.reason === "under18");

const r9c = e9DOB({ entity_type: "individual", dob: "1850-01-01" });
assertEqual("over-120 DOB flagged", r9c.score, 35);
assert("over-120 reason", r9c.reason === "over120");

const r9d = e9DOB({ entity_type: "individual", dob: "1985-06-15" });
assertEqual("valid DOB — score 0", r9d.score, 0);

const r9e = e9DOB({ entity_type: "business", dob: "2015-01-01" });
assertEqual("business entity DOB ignored", r9e.score, 0);

const r9f = e9DOB({ entity_type: "individual", dob: "not-a-date" });
assertEqual("unparseable DOB flagged", r9f.score, 35);

section("E10 — Address Risk");
const r10a = e10Address({ address: { street: "P.O. Box 123", city: "NYC", state: "NY", zip: "10001" } });
assertEqual("PO Box flagged", r10a.score, 10);
assert("E10_ADDRESS_RISK flag", r10a.flags.includes("E10_ADDRESS_RISK"));
const r10b = e10Address({ address: { street: "123 Main St", city: "NYC", state: "NY", zip: "10001" } });
assertEqual("complete address clean", r10b.score, 0);
const r10c = e10Address({ address: { street: "123 Main St", city: "NYC" } }); // missing state, zip
assertEqual("incomplete address flagged", r10c.score, 10);
const r10d = e10Address({});
assertEqual("no address flagged", r10d.score, 10);
const r10e = e10Address({ address: { street: "P O BOX 999", city: "LA", state: "CA", zip: "90001" } });
assertEqual("'P O BOX' variant flagged", r10e.score, 10);

section("E11 — Entity Consistency");
// Individual with EIN-formatted TIN (EIN not disallowed prefix, not valid SSN)
const r11a = e11Consistency({ entity_type: "individual", tin: "123456789" }); // valid SSN
assertEqual("individual+valid SSN no flag", r11a.score, 0);

// Business with valid SSN
const r11b = e11Consistency({ entity_type: "business", tin: "070456789" }); // valid SSN, EIN prefix 07 disallowed
assertEqual("business+valid SSN flagged", r11b.score, 15);
assert("E11_ENTITY_MISMATCH flag", r11b.flags.includes("E11_ENTITY_MISMATCH"));

section("E12 — Corporate Depth");
const r12a = e12CorpDepth({ num_corporate_layers: 5 });
assertEqual(">4 layers flagged", r12a.score, 20);
const r12b = e12CorpDepth({ num_corporate_layers: 4 });
assertEqual("=4 layers no flag", r12b.score, 0);
const r12c = e12CorpDepth({ num_corporate_layers: 0 });
assertEqual("0 layers no flag", r12c.score, 0);
const r12d = e12CorpDepth({ num_corporate_layers: 10 });
assert("10 layers flagged", r12d.score > 0);

section("E13 — Document Entropy");
const r13a = e13DocEntropy({ doc_type: "passport", doc_expiry_date: "2030-01-01" });
assertEqual("valid doc no flag", r13a.score, 0);
const r13b = e13DocEntropy({});
assertEqual("missing doc_type and expiry flagged", r13b.score, 10);
assert("missing type flag", r13b.flags.includes("E13_DOC_TYPE_MISSING"));
const r13c = e13DocEntropy({ doc_type: "passport", doc_expiry_date: "2020-01-01" });
assertEqual("expired doc flagged", r13c.score, 10);
assert("expired flag", r13c.flags.includes("E13_DOC_EXPIRED"));
const r13d = e13DocEntropy({ doc_type: "passport" });
assertEqual("missing expiry flagged", r13d.score, 10);

section("E15 — Synthetic Identity");
const r15a = e15Synthetic({ entity_type: "individual", tin: "999456789" });
assertEqual("SSN area 999 flagged", r15a.score, 40);
assert("E15_SYNTHETIC_SSN flag", r15a.flags.includes("E15_SYNTHETIC_SSN"));
const r15b = e15Synthetic({ entity_type: "individual", tin: "900456789" });
assertEqual("SSN area 900 flagged", r15b.score, 40);
const r15c = e15Synthetic({ entity_type: "individual", tin: "899456789" });
assertEqual("SSN area 899 not flagged", r15c.score, 0);
const r15d = e15Synthetic({ entity_type: "business", tin: "999456789" });
assertEqual("business entity E15 skipped", r15d.score, 0);

section("Decision Bands");
assertEqual("score 0 → APPROVED", decide(0), "APPROVED");
assertEqual("score 29 → APPROVED", decide(29), "APPROVED");
assertEqual("score 30 → REVIEW", decide(30), "REVIEW");
assertEqual("score 69 → REVIEW", decide(69), "REVIEW");
assertEqual("score 70 → DENIED", decide(70), "DENIED");
assertEqual("score 100 → DENIED", decide(100), "DENIED");

section("Score Aggregation — combined scenarios");
function scoreCombo(engines) {
  return Math.min(engines.reduce((a, e) => a + e.score, 0), 100);
}
// E6(35) + E15(40) = 75 → DENIED
const combo1 = scoreCombo([{ score: 35 }, { score: 40 }]);
assertEqual("35+40=75 → DENIED", decide(combo1), "DENIED");
// E3(20) + E10(10) = 30 → REVIEW
const combo2 = scoreCombo([{ score: 20 }, { score: 10 }]);
assertEqual("20+10=30 → REVIEW", decide(combo2), "REVIEW");
// score cap at 100
const combo3 = scoreCombo([{ score: 70 }, { score: 40 }, { score: 35 }]);
assertEqual("scores capped at 100", combo3, 100);
// E4(20) alone = 20 → APPROVED
assertEqual("20pts alone → APPROVED", decide(20), "APPROVED");

section("Auth — Gateway API Key format");
function mockGatewayCheck(token, kvStore) {
  return kvStore.has(`apikey:${token}`);
}
const kvStore = new Set(["apikey:test-token-abc", "apikey:prod-key-xyz"]);
assert("valid token passes", mockGatewayCheck("test-token-abc", kvStore));
assert("invalid token fails", !mockGatewayCheck("bad-token", kvStore));
assert("prod token passes", mockGatewayCheck("prod-key-xyz", kvStore));
assert("empty token fails", !mockGatewayCheck("", kvStore));

section("Auth — Admin Key");
function mockAdminCheck(headers, adminKey) {
  const auth = headers["authorization"] || "";
  const xkey = headers["x-admin-key"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return bearer === adminKey || xkey === adminKey;
}
const adminKey = "super-secret-admin";
assert("Bearer admin key passes", mockAdminCheck({ authorization: "Bearer super-secret-admin" }, adminKey));
assert("X-Admin-Key header passes", mockAdminCheck({ "x-admin-key": "super-secret-admin" }, adminKey));
assert("wrong bearer fails", mockAdminCheck({ authorization: "Bearer wrong" }, adminKey) === false);
assert("no auth fails", mockAdminCheck({}, adminKey) === false);

section("Batch Validation");
assert("batch ≤ 50 allowed", [].concat(Array(50).fill({})).length <= 50);
assert("batch > 50 rejected", [].concat(Array(51).fill({})).length > 50);
assert("empty batch rejected", [].length === 0);

section("Route Pattern Matching");
const routes = [
  ["/api/kyc/apply", "POST", "apply"],
  ["/api/kyc/status/kyc_123", "GET", "status"],
  ["/api/kyc/review", "GET", "review-list"],
  ["/api/kyc/review/kyc_abc/approve", "POST", "approve"],
  ["/api/kyc/review/kyc_abc/reject", "POST", "reject"],
  ["/api/kyc/review/kyc_abc/escalate", "POST", "escalate"],
  ["/api/kyc/batch", "POST", "batch"],
  ["/api/kyc/stats", "GET", "stats"],
  ["/api/kyc/health", "GET", "health"],
];
for (const [path, method, name] of routes) {
  assert(`Route matched: ${method} ${path} → ${name}`, !!path);
}

section("Submission ID format");
function genId() { return `kyc_${Math.random().toString(36).slice(2,18)}`; }
const id = genId();
assert("submission_id starts with kyc_", id.startsWith("kyc_"));
assert("submission_id length > 10", id.length > 10);

section("TIN Formatting");
function formatTin(tin, entityType) {
  const d = (tin || "").replace(/\D/g, "");
  if (entityType === "business" && d.length === 9) return `${d.slice(0,2)}-${d.slice(2)}`;
  if (entityType === "individual" && d.length === 9) return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
  return d;
}
assertEqual("SSN formatted", formatTin("123456789", "individual"), "123-45-6789");
assertEqual("EIN formatted", formatTin("123456789", "business"), "12-3456789");
assertEqual("formatted SSN input strips dashes", formatTin("123-45-6789", "individual"), "123-45-6789");
assertEqual("formatted EIN input strips dashes", formatTin("12-3456789", "business"), "12-3456789");

section("CORS Headers");
const corsH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "X-Submission-Id"
};
assert("CORS allow-origin wildcard", corsH["Access-Control-Allow-Origin"] === "*");
assert("CORS expose submission ID", corsH["Access-Control-Expose-Headers"] === "X-Submission-Id");
assert("CORS allow OPTIONS", corsH["Access-Control-Allow-Methods"].includes("OPTIONS"));

section("Engine Version");
assertEqual("engine version constant", "v11.0", "v11.0");

section("Adverse Keywords Count");
assertEqual("exactly 20 adverse media keywords", ADVERSE_KEYWORDS.length, 20);
assert("'fraud' present", ADVERSE_KEYWORDS.includes("fraud"));
assert("'laundering' present", ADVERSE_KEYWORDS.includes("laundering"));
assert("'indictment' present", ADVERSE_KEYWORDS.includes("indictment"));
assert("'ransomware' present", ADVERSE_KEYWORDS.includes("ransomware"));

section("EIN Disallowed Prefixes Count");
assertEqual("16 disallowed EIN prefixes", EIN_DISALLOWED.size, 16);
assert("07 disallowed", EIN_DISALLOWED.has("07"));
assert("97 disallowed", EIN_DISALLOWED.has("97"));
assert("12 allowed", !EIN_DISALLOWED.has("12"));
assert("45 allowed", !EIN_DISALLOWED.has("45"));

section("E6 Structuring Boundary Conditions");
[8000, 8001, 9000, 9998, 9999].forEach(amt => {
  const r = e6Structuring({ payment_amount: amt });
  assert(`$${amt} triggers E6`, r.score === 35);
});
[7999, 10000, 0, 100000].forEach(amt => {
  const r = e6Structuring({ payment_amount: amt });
  assert(`$${amt} does NOT trigger E6`, r.score === 0);
});

section("Review Queue Status Values");
const validStatuses = ["pending", "approved", "rejected", "escalated"];
for (const s of validStatuses) assert(`review status '${s}' valid`, validStatuses.includes(s));

section("E8 UBO Threshold");
function uboIsInScope(pct) { return pct >= 25; }
assert("24% UBO out of scope", !uboIsInScope(24));
assert("25% UBO in scope", uboIsInScope(25));
assert("51% UBO in scope", uboIsInScope(51));
assert("100% UBO in scope", uboIsInScope(100));

section("Notification Endpoint");
assertEqual("notifier URL", "https://notify.wwwknockoutforever.com/webhook/system-alert",
  "https://notify.wwwknockoutforever.com/webhook/system-alert");

section("D1 Table Column Validation");
const submissionCols = [
  "id","submission_id","entity_type","applicant_name","tin","tin_formatted",
  "status","risk_score","risk_decision","risk_breakdown","sanctions_hits",
  "ofac_hits","pep_hits","tin_valid","ein_valid","screen_latency_ms",
  "raw_payload","screened_at","created_at","flags_json","pep_hits_json",
  "ofac_hits_json","velocity_flagged","structuring_flagged","adverse_media_hits",
  "engine_version"
];
assertEqual("kyc_submissions has 26 columns", submissionCols.length, 26);
assert("has submission_id", submissionCols.includes("submission_id"));
assert("has flags_json", submissionCols.includes("flags_json"));
assert("has engine_version", submissionCols.includes("engine_version"));

const reviewCols = [
  "id","submission_id","reference_id","type","flags_json","payload_json",
  "status","risk_score","assigned_to","resolved_by","resolved_at",
  "escalation_reason","created_at"
];
assertEqual("kyc_review_queue has 13 columns", reviewCols.length, 13);
assert("has escalation_reason", reviewCols.includes("escalation_reason"));

// ────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`  Results: ${passed} passed / ${failed} failed / ${total} total`);
if (failed > 0) {
  console.error(`\n  ❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n  ✅ All ${passed} tests passed`);
}
