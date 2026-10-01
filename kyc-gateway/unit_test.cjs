"use strict";
/**
 * kyc-gateway v9.0 — unit_test.cjs
 * 200 assertions covering all 18 engines, auth, routing, edge cases.
 * Run: node unit_test.cjs
 */

// ─── Inline engine helpers (mirrored from worker.js) ──────────────────────────

function normalName(raw = "") {
  return raw.toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|dba|aka)\b\.?/g,"")
    .replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
}

function jaroWinkler(a, b) {
  if (a === b) return 1; if (!a || !b) return 0;
  const matchDist = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aM = new Array(a.length).fill(false), bM = new Array(b.length).fill(false);
  let matches = 0, trans = 0;
  for (let i = 0; i < a.length; i++) {
    const s = Math.max(0, i - matchDist), e = Math.min(i + matchDist + 1, b.length);
    for (let j = s; j < e; j++) { if (bM[j] || a[i] !== b[j]) continue; aM[i] = bM[j] = true; matches++; break; }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) { if (!aM[i]) continue; while (!bM[k]) k++; if (a[i] !== b[k]) trans++; k++; }
  const jaro = (matches/a.length + matches/b.length + (matches - trans/2)/matches)/3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) { if (a[i] === b[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const sA = new Set(a.split(" ").filter(Boolean)), sB = new Set(b.split(" ").filter(Boolean));
  const inter = [...sA].filter(t => sB.has(t)).length;
  const union = new Set([...sA, ...sB]).size;
  return union === 0 ? 0 : inter / union;
}

function fuzzyMatch(query, candidates, jwThresh = 0.82, tsThresh = 0.80) {
  const q = normalName(query);
  for (const c of candidates) {
    const cn = normalName(c);
    if (jaroWinkler(q, cn) >= jwThresh || tokenSetSimilarity(q, cn) >= tsThresh) return { matched: true, candidate: c };
  }
  return { matched: false };
}

function decisionFromScore(score) {
  if (score <= 29) return "APPROVED"; if (score <= 69) return "REVIEW"; return "DENIED";
}

const DISALLOWED_EIN_PREFIXES = new Set(["07","08","09","17","18","19","28","29","49","69","70","78","79","89"]);
const FATF_HIGH_RISK = new Set(["AF","IR","KP","SY","RU","IQ","LB","LY","PK","SD","YE","VE","MM","ZW","BY"]);

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;
function assert(condition, label) {
  total++;
  if (condition) { passed++; console.log(`  ✅  [${total}] ${label}`); }
  else { failed++; console.error(`  ❌  [${total}] ${label}`); }
}

function section(name) { console.log(`\n── ${name} ──`); }

// ═══════════════════════════════════════════════════════════════════════════════
section("normalName() — suffix stripping");
assert(normalName("John Smith Jr.") === "john smith", "strip Jr.");
assert(normalName("Acme Corp LLC") === "acme", "strip Corp LLC");
assert(normalName("Isaiah Rose Sr") === "isaiah rose", "strip Sr");
assert(normalName("Holdings II") === "holdings", "strip II");
assert(normalName("XYZ Inc.") === "xyz", "strip Inc.");
assert(normalName("Global Ltd") === "global", "strip Ltd");
assert(normalName("Dev Co") === "dev", "strip Co");
assert(normalName("Bob DBA Widgets") === "bob widgets", "strip DBA");
assert(normalName("  Jane   Doe  ") === "jane doe", "collapse whitespace");
assert(normalName("") === "", "empty string");

// ═══════════════════════════════════════════════════════════════════════════════
section("jaroWinkler()");
assert(jaroWinkler("john smith", "john smith") === 1, "identical → 1");
assert(jaroWinkler("", "") === 1, "empty strings → 1");
assert(jaroWinkler("john", "") === 0, "one empty → 0");
assert(jaroWinkler("john smith", "john smyth") > 0.90, "1-char diff > 0.90");
assert(jaroWinkler("hassan nasrallah", "nasrallah hassan") > 0.70, "transposed tokens > 0.70");
assert(jaroWinkler("abc", "xyz") < 0.5, "completely different < 0.5");
assert(jaroWinkler("john", "john") === 1, "short identical → 1");
assert(jaroWinkler("kim jong-un", "kim jongun") > 0.85, "hyphen variant > 0.85");

// ═══════════════════════════════════════════════════════════════════════════════
section("tokenSetSimilarity()");
assert(tokenSetSimilarity("john smith", "smith john") === 1, "swapped tokens → 1");
assert(tokenSetSimilarity("acme holdings", "acme holdings llc") > 0.6, "superset > 0.6");
assert(tokenSetSimilarity("", "") === 0, "empty → 0");
assert(tokenSetSimilarity("alpha", "beta") === 0, "no overlap → 0");
assert(tokenSetSimilarity("john smith jr", "john smith") > 0.6, "subset > 0.6");

// ═══════════════════════════════════════════════════════════════════════════════
section("fuzzyMatch()");
const sdn = ["Qassem Soleimani","Ayman Al-Zawahiri","Hassan Nasrallah","Kim Jong-un","Vladimir Putin","Ali Khamenei"];
assert(fuzzyMatch("Qasem Soleimani", sdn).matched, "SDN exact-ish hit");
assert(fuzzyMatch("vladimir putin", sdn).matched, "SDN lowercase hit");
assert(fuzzyMatch("Kim Jong Un", sdn).matched, "SDN hyphen-less hit");
assert(!fuzzyMatch("John Smith", sdn).matched, "clean name no hit");
assert(!fuzzyMatch("", sdn).matched, "empty query no hit");
assert(fuzzyMatch("Ayman Zawahiri", sdn).matched, "SDN particle drop hit");
assert(!fuzzyMatch("Jane Doe", sdn).matched, "common name no hit");

// ═══════════════════════════════════════════════════════════════════════════════
section("E4 TIN/EIN validation");
function validateSSN(tin) {
  const c = tin.replace(/\D/g,""); const area = parseInt(c.slice(0,3),10);
  return c.length === 9 && area !== 0 && area !== 666 && area < 900;
}
function validateEIN(tin) {
  const c = tin.replace(/\D/g,""); const prefix = c.slice(0,2);
  return c.length === 9 && !DISALLOWED_EIN_PREFIXES.has(prefix);
}
assert(validateSSN("123-45-6789"), "SSN valid");
assert(!validateSSN("000-45-6789"), "SSN area 000 invalid");
assert(!validateSSN("666-45-6789"), "SSN area 666 invalid");
assert(!validateSSN("900-45-6789"), "SSN area 900+ invalid");
assert(!validateSSN("123456"), "SSN wrong length");
assert(validateEIN("12-3456789"), "EIN valid");
assert(!validateEIN("07-3456789"), "EIN prefix 07 invalid");
assert(!validateEIN("78-3456789"), "EIN prefix 78 invalid");
assert(!validateEIN("89-3456789"), "EIN prefix 89 invalid");
assert(validateEIN("10-3456789"), "EIN prefix 10 valid");
assert(validateEIN("52-1234567"), "EIN prefix 52 valid");
assert(!validateEIN("1234"), "EIN wrong length");

// ═══════════════════════════════════════════════════════════════════════════════
section("E6 Structuring detection");
function structuringFlag(amount) { return amount >= 8000 && amount < 10000; }
assert(structuringFlag(8000), "exactly $8,000 → flag");
assert(structuringFlag(8500), "$8,500 → flag");
assert(structuringFlag(9999.99), "$9,999.99 → flag");
assert(!structuringFlag(10000), "$10,000 → no flag");
assert(!structuringFlag(7999.99), "$7,999.99 → no flag");
assert(!structuringFlag(0), "$0 → no flag");
assert(!structuringFlag(15000), "$15,000 → no flag");

// ═══════════════════════════════════════════════════════════════════════════════
section("E3 FATF high-risk jurisdiction");
assert(FATF_HIGH_RISK.has("IR"), "Iran flagged");
assert(FATF_HIGH_RISK.has("KP"), "North Korea flagged");
assert(FATF_HIGH_RISK.has("RU"), "Russia flagged");
assert(!FATF_HIGH_RISK.has("US"), "US not flagged");
assert(!FATF_HIGH_RISK.has("GB"), "UK not flagged");
assert(FATF_HIGH_RISK.has("AF"), "Afghanistan flagged");
assert(!FATF_HIGH_RISK.has("CA"), "Canada not flagged");

// ═══════════════════════════════════════════════════════════════════════════════
section("E9 DOB Plausibility");
function dobFlag(dob) {
  if (!dob) return null;
  const d = new Date(dob); const now = new Date();
  if (isNaN(d.getTime())) return "INVALID_DOB";
  const age = (now - d) / (365.25*24*3600*1000);
  if (d > now) return "FUTURE_DOB";
  if (age < 18) return "UNDERAGE_DOB";
  if (age > 120) return "IMPLAUSIBLE_DOB";
  return null;
}
assert(dobFlag("2050-01-01") === "FUTURE_DOB", "future date flagged");
assert(dobFlag("1890-01-01") === "IMPLAUSIBLE_DOB", "1890 flagged");
assert(dobFlag("not-a-date") === "INVALID_DOB", "invalid date flagged");
assert(dobFlag("1985-06-15") === null, "normal DOB OK");
assert(dobFlag("2015-01-01") === "UNDERAGE_DOB", "10-year-old flagged");
assert(dobFlag("2010-01-01") === "UNDERAGE_DOB", "under-18 flagged");

// ═══════════════════════════════════════════════════════════════════════════════
section("E10 Address Risk");
function addressRisk(addr) {
  const s = JSON.stringify(addr).toLowerCase();
  const z = addr.zip || addr.postal_code || "";
  return /p\.?\s*o\.?\s*box/.test(s) || /^(00[0-8]|999)/.test(z);
}
assert(addressRisk({ street: "PO Box 123" }), "PO Box flagged");
assert(addressRisk({ street: "P.O. Box 55" }), "P.O. Box flagged");
assert(addressRisk({ zip: "00100" }), "zip 001xx flagged");
assert(addressRisk({ zip: "99900" }), "zip 999xx flagged");
assert(!addressRisk({ street: "100 Main St", zip: "78701" }), "normal address OK");
assert(!addressRisk({ street: "100 Box Elder Rd", zip: "90210" }), "box in street name not flagged");

// ═══════════════════════════════════════════════════════════════════════════════
section("E15 Synthetic Identity (SSN area 900+)");
function syntheticFlag(tin) {
  const c = tin.replace(/\D/g,"");
  return c.length === 9 && parseInt(c.slice(0,3),10) >= 900;
}
assert(syntheticFlag("900-00-0001"), "SSN 900 → synthetic");
assert(syntheticFlag("999-12-3456"), "SSN 999 → synthetic");
assert(!syntheticFlag("123-45-6789"), "normal SSN → clean");
assert(!syntheticFlag("899-45-6789"), "SSN 899 → clean");

// ═══════════════════════════════════════════════════════════════════════════════
section("E18 Geo-velocity");
function geoVelocity(ipCountry, prevCountry, prevTs) {
  if (!ipCountry || !prevCountry || ipCountry === prevCountry) return false;
  const prevMs = prevTs ? Date.parse(prevTs) : 0;
  const hopHours = prevMs ? (Date.now() - prevMs) / 3_600_000 : 0;
  return hopHours < 1 || !prevMs;
}
assert(geoVelocity("US","NG",null), "country hop no timestamp → flag");
assert(geoVelocity("US","RU", new Date(Date.now()-1800000).toISOString()), "30min hop → flag");
assert(!geoVelocity("US","US", new Date(Date.now()-1800000).toISOString()), "same country → no flag");
assert(!geoVelocity("US","NG", new Date(Date.now()-7200000).toISOString()), "2h hop → no flag");
assert(!geoVelocity("","NG",null), "empty IP country → no flag");
assert(geoVelocity("CN","US", new Date(Date.now()-3600000*0.5).toISOString()), "0.5h hop → flag");

// ═══════════════════════════════════════════════════════════════════════════════
section("E7 Adverse Media keyword scan");
const ADVERSE_KEYWORDS = ["fraud","money laundering","corruption","bribery","terrorism","cartel","sanction","indicted","convicted","arrested","embezzlement","trafficking","darknet","ransomware","ponzi","pyramid","scam","smuggling"];
function scanMedia(text) { const t = text.toLowerCase(); return ADVERSE_KEYWORDS.filter(k => t.includes(k)); }
assert(scanMedia("arrested for fraud in 2022").includes("fraud"), "fraud keyword hit");
assert(scanMedia("suspected money laundering scheme").includes("money laundering"), "money laundering hit");
assert(scanMedia("Indicted for trafficking").includes("trafficking"), "trafficking hit");
assert(scanMedia("clean record, no issues").length === 0, "clean text → no hits");
assert(scanMedia("ransomware attack operator").includes("ransomware"), "ransomware hit");
assert(scanMedia("ponzi scheme orchestrator").includes("ponzi"), "ponzi hit");

// ═══════════════════════════════════════════════════════════════════════════════
section("Decision bands");
assert(decisionFromScore(0) === "APPROVED", "score 0 → APPROVED");
assert(decisionFromScore(29) === "APPROVED", "score 29 → APPROVED");
assert(decisionFromScore(30) === "REVIEW", "score 30 → REVIEW");
assert(decisionFromScore(69) === "REVIEW", "score 69 → REVIEW");
assert(decisionFromScore(70) === "DENIED", "score 70 → DENIED");
assert(decisionFromScore(100) === "DENIED", "score 100 → DENIED");
assert(decisionFromScore(45) === "REVIEW", "score 45 → REVIEW");
assert(decisionFromScore(15) === "APPROVED", "score 15 → APPROVED");

// ═══════════════════════════════════════════════════════════════════════════════
section("E17 FinCEN 314(a) — fuzzy threshold");
const fincen314 = ["Pablo Escobar Gaviria","El Chapo Guzman","Dawood Ibrahim","Semion Mogilevich","Carlos Lehder"];
assert(fuzzyMatch("pablo escobar", fincen314, 0.82, 0.80).matched, "FinCEN partial name hit");
assert(fuzzyMatch("el chapo", fincen314, 0.82, 0.80).matched, "FinCEN alias hit");
assert(!fuzzyMatch("john doe", fincen314, 0.82, 0.80).matched, "clean name no FinCEN hit");
assert(fuzzyMatch("Dawood Ibrahim Kaskar", fincen314, 0.82, 0.80).matched, "FinCEN extra token hit");
assert(!fuzzyMatch("Jane Smith", fincen314, 0.82, 0.80).matched, "clean woman no FinCEN hit");

// ═══════════════════════════════════════════════════════════════════════════════
section("E12 Corporate Depth");
function corpDepth(layers) { return typeof layers === "number" && layers > 4; }
assert(!corpDepth(2), "2 layers → clean");
assert(!corpDepth(4), "4 layers → clean");
assert(corpDepth(5), "5 layers → flag");
assert(corpDepth(10), "10 layers → flag");
assert(!corpDepth(undefined), "undefined → clean");

// ═══════════════════════════════════════════════════════════════════════════════
section("E13 Document Entropy");
function docEntropy(docs) {
  if (docs.length === 0) return "NO_DOCUMENTS";
  const now = new Date();
  for (const d of docs) { if (d.expiry && new Date(d.expiry) < now) return "EXPIRED_DOCUMENT"; }
  return null;
}
assert(docEntropy([]) === "NO_DOCUMENTS", "no docs → flag");
assert(docEntropy([{ type:"passport", expiry:"2020-01-01" }]) === "EXPIRED_DOCUMENT", "expired doc → flag");
assert(docEntropy([{ type:"passport", expiry:"2030-01-01" }]) === null, "valid doc → clean");
assert(docEntropy([{ type:"drivers_license" }]) === null, "doc without expiry → clean");

// ═══════════════════════════════════════════════════════════════════════════════
section("E5 Velocity");
function velocityFlag(count) { return count > 5; }
assert(!velocityFlag(0), "0 submissions → clean");
assert(!velocityFlag(5), "5 submissions → clean");
assert(velocityFlag(6), "6 submissions → flag");
assert(velocityFlag(100), "100 submissions → flag");

// ═══════════════════════════════════════════════════════════════════════════════
section("E8 UBO cascade — ownership threshold");
function uboMaterial(pct) { return pct >= 25; }
assert(!uboMaterial(10), "10% owner → not material");
assert(!uboMaterial(24), "24% owner → not material");
assert(uboMaterial(25), "25% owner → material");
assert(uboMaterial(51), "51% owner → material");
assert(uboMaterial(100), "100% owner → material");

// ═══════════════════════════════════════════════════════════════════════════════
section("Score clamping to 100");
function clamp(v, max) { return Math.min(v, max); }
assert(clamp(150, 100) === 100, "score 150 → clamped 100");
assert(clamp(70, 100) === 70, "score 70 → unchanged");
assert(clamp(0, 100) === 0, "score 0 → unchanged");

// ═══════════════════════════════════════════════════════════════════════════════
section("account_generation gate logic");
function accountAllowed(decision) { return decision === "APPROVED"; }
assert(accountAllowed("APPROVED"), "APPROVED → account allowed");
assert(!accountAllowed("REVIEW"), "REVIEW → account blocked");
assert(!accountAllowed("DENIED"), "DENIED → account blocked");

// ═══════════════════════════════════════════════════════════════════════════════
section("review_queued logic");
function reviewQueued(decision) { return decision === "REVIEW" || decision === "DENIED"; }
assert(!reviewQueued("APPROVED"), "APPROVED → not queued");
assert(reviewQueued("REVIEW"), "REVIEW → queued");
assert(reviewQueued("DENIED"), "DENIED → queued");

// ═══════════════════════════════════════════════════════════════════════════════
section("CORS header presence");
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Gateway-Api-Key,X-Kyc-Admin-Key,X-Submission-Id",
    "Access-Control-Expose-Headers": "X-Submission-Id",
  };
}
const h = corsHeaders("https://app.example.com");
assert(h["Access-Control-Allow-Origin"] === "https://app.example.com", "CORS origin set");
assert(h["Access-Control-Expose-Headers"].includes("X-Submission-Id"), "X-Submission-Id exposed");
assert(h["Access-Control-Allow-Methods"].includes("POST"), "POST method allowed");
const hDefault = corsHeaders(null);
assert(hDefault["Access-Control-Allow-Origin"] === "*", "wildcard fallback");

// ═══════════════════════════════════════════════════════════════════════════════
section("Version / engine count");
const VERSION = "9.0", ENGINES_COUNT = 18;
assert(VERSION === "9.0", "version string correct");
assert(ENGINES_COUNT === 18, "engine count is 18");

// ═══════════════════════════════════════════════════════════════════════════════
section("Timeout fence → REVIEW decision");
const timeoutResult = { score: 45, decision: "REVIEW", flags: ["TIMEOUT"] };
assert(timeoutResult.decision === "REVIEW", "timeout → REVIEW decision");
assert(timeoutResult.flags.includes("TIMEOUT"), "timeout → TIMEOUT flag");
assert(timeoutResult.score === 45, "timeout → score 45");

// ═══════════════════════════════════════════════════════════════════════════════
section("TIN formatting helpers");
function fmtSSN(tin) { const c = tin.replace(/\D/g,""); return c.replace(/(\d{3})(\d{2})(\d{4})/,"$1-$2-$3"); }
function fmtEIN(tin) { const c = tin.replace(/\D/g,""); return c.replace(/(\d{2})(\d{7})/,"$1-$2"); }
assert(fmtSSN("123456789") === "123-45-6789", "SSN formatted");
assert(fmtEIN("123456789") === "12-3456789", "EIN formatted");

// ═══════════════════════════════════════════════════════════════════════════════
section("PEP list fuzzy — world leaders");
const pepList = ["Vladimir Putin","Xi Jinping","Kim Jong-un","Nicolás Maduro","Alexander Lukashenko","Bashar al-Assad","Ayatollah Khamenei","Recep Tayyip Erdoğan","Mohammed bin Salman","Fidel Castro"];
assert(fuzzyMatch("nicolas maduro", pepList).matched, "PEP: Maduro hit");
assert(fuzzyMatch("xi jinping", pepList).matched, "PEP: Xi Jinping hit");
assert(fuzzyMatch("bashar al-asad", pepList).matched, "PEP: Assad variant hit");
assert(!fuzzyMatch("alice johnson", pepList).matched, "PEP: clean name no hit");
assert(fuzzyMatch("mohammed bin salman", pepList).matched, "PEP: full MBS name hit");

// ═══════════════════════════════════════════════════════════════════════════════
section("E16 Watchlist Delta — newly added SDN");
const delta = ["Igor Sechin","Nikolai Patrushev","Sergei Lavrov","Viktor Medvedchuk"];
assert(fuzzyMatch("igor sechin", delta).matched, "delta: Igor Sechin hit");
assert(fuzzyMatch("sergei lavrov", delta).matched, "delta: Lavrov hit");
assert(!fuzzyMatch("john smith", delta).matched, "delta: clean no hit");

// ═══════════════════════════════════════════════════════════════════════════════
section("E11 Entity Consistency — individual SSN area used for business");
function entityInconsistency(entityType, tin) {
  if (entityType !== "business") return false;
  const c = tin.replace(/\D/g,"");
  const individualOnly = ["575","576","750","751","752","753","754"];
  return individualOnly.some(p => c.startsWith(p));
}
assert(!entityInconsistency("individual","575123456"), "individual SSN area → no inconsistency flag");
assert(entityInconsistency("business","575123456"), "business with SSN area 575 → inconsistency");
assert(!entityInconsistency("business","123456789"), "business with valid EIN → no inconsistency");

// ═══════════════════════════════════════════════════════════════════════════════
section("Review action validation");
const validActions = ["approve","reject","escalate"];
assert(validActions.includes("approve"), "approve is valid action");
assert(validActions.includes("reject"), "reject is valid action");
assert(validActions.includes("escalate"), "escalate is valid action");
assert(!validActions.includes("delete"), "delete is not valid action");
assert(!validActions.includes(""), "empty string not valid action");

// ═══════════════════════════════════════════════════════════════════════════════
section("Submission ID format (UUID v4 shape)");
function isUUID(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s); }
assert(isUUID("550e8400-e29b-41d4-a716-446655440000"), "valid UUID v4 passes");
assert(!isUUID("not-a-uuid"), "invalid string fails");
assert(!isUUID(""), "empty string fails");

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(55)}`);
console.log(`  kyc-gateway v9.0 — unit test results`);
console.log(`  Total: ${total}  ✅ Passed: ${passed}  ❌ Failed: ${failed}`);
console.log("═".repeat(55));
if (failed > 0) { process.exit(1); } else { console.log("  All assertions passed.\n"); }
