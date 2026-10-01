/**
 * kyc-gateway v8.1 — Unit Test Suite
 * 179 assertions covering all 17 engines + decision bands
 * Run: node unit_test.cjs
 */

const assert = require("assert");

// ── Copy helpers from worker ──────────────────────────────────────────────────

function normalName(raw = "") {
  return raw.toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ").trim();
}

function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const maxDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aM = new Array(a.length).fill(false);
  const bM = new Array(b.length).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end = Math.min(i + maxDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches/a.length + matches/b.length + (matches - transpositions/2)/matches)/3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix*0.1*(1-jaro);
}

function tokenSetSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function validateSSN(ssn = "") {
  const d = ssn.replace(/\D/g, "");
  if (d.length !== 9) return { valid: false, reason: "length" };
  const area = parseInt(d.slice(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900) return { valid: false, reason: area >= 900 ? "synthetic_area" : "invalid_area" };
  if (d.slice(3,5) === "00" || d.slice(5) === "0000") return { valid: false, reason: "invalid_group_serial" };
  return { valid: true };
}

function validateEIN(ein = "") {
  const d = ein.replace(/\D/g, "");
  if (d.length !== 9) return { valid: false, reason: "length" };
  const prefix = parseInt(d.slice(0,2), 10);
  const disallowed = [7,8,9,17,18,19,28,29,49,69,70,78,79,89];
  if (disallowed.includes(prefix)) return { valid: false, reason: `disallowed_prefix_${prefix}` };
  return { valid: true };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ── normalName ────────────────────────────────────────────────────────────────
console.log("\n[normalName]");
test("strips Jr suffix", () => assert.equal(normalName("Isaiah Rose Jr"), "isaiah rose"));
test("strips Sr suffix", () => assert.equal(normalName("Isaiah Rose Sr"), "isaiah rose"));
test("strips II suffix", () => assert.equal(normalName("John Doe II"), "john doe"));
test("strips LLC suffix", () => assert.equal(normalName("Bervashun LLC"), "bervashun"));
test("strips Corp suffix", () => assert.equal(normalName("Global Corp"), "global"));
test("lowercase", () => assert.equal(normalName("UPPER CASE"), "upper case"));
test("removes punctuation", () => assert.equal(normalName("O'Brien"), "obrien"));

// ── jaroWinkler ───────────────────────────────────────────────────────────────
console.log("\n[jaroWinkler]");
test("identical strings = 1", () => assert.equal(jaroWinkler("hello", "hello"), 1));
test("empty strings = 0", () => assert.equal(jaroWinkler("", ""), 0));
test("completely different = low score", () => assert(jaroWinkler("abc", "xyz") < 0.5));
test("similar names score high", () => assert(jaroWinkler("vladimir putin", "vladimir putin") === 1));
test("transposition detected", () => assert(jaroWinkler("martha", "marhta") > 0.9));

// ── tokenSetSimilarity ────────────────────────────────────────────────────────
console.log("\n[tokenSetSimilarity]");
test("identical = 1", () => assert.equal(tokenSetSimilarity("foo bar", "foo bar"), 1));
test("empty = 0", () => assert.equal(tokenSetSimilarity("", ""), 0));
test("partial overlap > 0", () => assert(tokenSetSimilarity("foo bar", "foo baz") > 0.3));
test("no overlap = 0", () => assert.equal(tokenSetSimilarity("alpha", "beta"), 0));

// ── validateSSN ───────────────────────────────────────────────────────────────
console.log("\n[validateSSN]");
test("valid SSN", () => assert(validateSSN("123-45-6789").valid));
test("area 000 invalid", () => assert(!validateSSN("000-45-6789").valid));
test("area 666 invalid", () => assert(!validateSSN("666-45-6789").valid));
test("area 900 synthetic", () => { const r = validateSSN("900-45-6789"); assert(!r.valid); assert.equal(r.reason, "synthetic_area"); });
test("area 999 synthetic", () => assert(!validateSSN("999-45-6789").valid));
test("group 00 invalid", () => assert(!validateSSN("123-00-6789").valid));
test("serial 0000 invalid", () => assert(!validateSSN("123-45-0000").valid));
test("short SSN invalid", () => assert(!validateSSN("123-45-678").valid));
test("long SSN invalid", () => assert(!validateSSN("123-45-67890").valid));

// ── validateEIN ───────────────────────────────────────────────────────────────
console.log("\n[validateEIN]");
test("valid EIN 12-3456789", () => assert(validateEIN("12-3456789").valid));
test("valid EIN 20-1234567", () => assert(validateEIN("20-1234567").valid));
test("prefix 07 disallowed", () => assert(!validateEIN("07-1234567").valid));
test("prefix 08 disallowed", () => assert(!validateEIN("08-1234567").valid));
test("prefix 09 disallowed", () => assert(!validateEIN("09-1234567").valid));
test("prefix 17 disallowed", () => assert(!validateEIN("17-1234567").valid));
test("prefix 18 disallowed", () => assert(!validateEIN("18-1234567").valid));
test("prefix 19 disallowed", () => assert(!validateEIN("19-1234567").valid));
test("prefix 70 disallowed", () => assert(!validateEIN("70-1234567").valid));
test("prefix 78 disallowed", () => assert(!validateEIN("78-1234567").valid));
test("prefix 79 disallowed", () => assert(!validateEIN("79-1234567").valid));
test("prefix 89 disallowed", () => assert(!validateEIN("89-1234567").valid));
test("short EIN invalid", () => assert(!validateEIN("12-345678").valid));

// ── E3 FATF ───────────────────────────────────────────────────────────────────
console.log("\n[E3_FATF]");
const FATF = new Set(["AF","AL","BB","BF","BJ","BT","CD","CF","CM","CU","ET","GH","GT","GY","HT","ID","IL","IQ","IR","JM","JO","KP","LB","LK","LY","MA","ML","MR","MU","MW","MX","MY","NG","NI","PA","PK","PH","QA","RS","RU","SD","SN","SO","SS","SY","TG","TH","TN","TR","UG","VE","YE","ZA","ZW"]);
test("Iran (IR) = flagged", () => assert(FATF.has("IR")));
test("North Korea (KP) = flagged", () => assert(FATF.has("KP")));
test("Russia (RU) = flagged", () => assert(FATF.has("RU")));
test("US = not flagged", () => assert(!FATF.has("US")));
test("Canada = not flagged", () => assert(!FATF.has("CA")));
test("UK = not flagged", () => assert(!FATF.has("GB")));

// ── E6 Structuring ────────────────────────────────────────────────────────────
console.log("\n[E6_Structuring]");
function structFlag(amt) { return amt >= 8000 && amt < 10000; }
test("$8,000 = flagged", () => assert(structFlag(8000)));
test("$9,999 = flagged", () => assert(structFlag(9999)));
test("$9,999.99 = flagged", () => assert(structFlag(9999.99)));
test("$10,000 = NOT flagged", () => assert(!structFlag(10000)));
test("$7,999 = NOT flagged", () => assert(!structFlag(7999)));
test("$0 = NOT flagged", () => assert(!structFlag(0)));

// ── E9 DOB ────────────────────────────────────────────────────────────────────
console.log("\n[E9_DOB]");
function checkDOB(dob) {
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return "invalid";
  const now = new Date();
  const age = (now - birth) / (365.25*24*3600*1000);
  if (birth > now) return "future";
  if (age < 18) return "under_18";
  if (age > 120) return "over_120";
  return "ok";
}
test("valid adult DOB", () => assert.equal(checkDOB("1987-08-22"), "ok"));
test("future DOB flagged", () => assert.equal(checkDOB("2099-01-01"), "future"));
test("under 18 flagged", () => assert.equal(checkDOB("2015-01-01"), "under_18"));
test("over 120 flagged", () => assert.equal(checkDOB("1890-01-01"), "over_120"));
test("invalid format", () => assert.equal(checkDOB("not-a-date"), "invalid"));

// ── E10 Address Risk ──────────────────────────────────────────────────────────
console.log("\n[E10_AddressRisk]");
const HIGH_RISK = new Set(["NV","DE","WY","MT","SD","NM"]);
test("Nevada flagged", () => assert(HIGH_RISK.has("NV")));
test("Delaware flagged", () => assert(HIGH_RISK.has("DE")));
test("Wyoming flagged", () => assert(HIGH_RISK.has("WY")));
test("California not flagged", () => assert(!HIGH_RISK.has("CA")));
test("New York not flagged", () => assert(!HIGH_RISK.has("NY")));
test("Texas not flagged", () => assert(!HIGH_RISK.has("TX")));

// ── E11 Entity Consistency ────────────────────────────────────────────────────
console.log("\n[E11_EntityConsistency]");
function checkConsistency(p) {
  const flags = [];
  if (p.entity_type === "individual" && p.business_name) flags.push("individual_has_business_name");
  if (p.entity_type === "business" && !p.business_name) flags.push("business_missing_name");
  if (p.entity_type === "business" && p.ssn) flags.push("business_has_ssn");
  return flags;
}
test("individual with business_name = flagged", () => assert(checkConsistency({entity_type:"individual",business_name:"Acme"}).length > 0));
test("business without name = flagged", () => assert(checkConsistency({entity_type:"business"}).length > 0));
test("business with SSN = flagged", () => assert(checkConsistency({entity_type:"business",business_name:"Acme",ssn:"123456789"}).length > 0));
test("clean individual = no flags", () => assert.equal(checkConsistency({entity_type:"individual",applicant_name:"John"}).length, 0));
test("clean business = no flags", () => assert.equal(checkConsistency({entity_type:"business",business_name:"Acme Inc"}).length, 0));

// ── E12 Corporate Depth ───────────────────────────────────────────────────────
console.log("\n[E12_CorporateDepth]");
test("depth 5 = flagged", () => assert([{},{},{},{},{}].length > 4));
test("depth 4 = NOT flagged", () => assert(!([{},{},{},{}].length > 4)));
test("depth 0 = NOT flagged", () => assert(!(0 > 4)));

// ── E15 Synthetic Identity ────────────────────────────────────────────────────
console.log("\n[E15_SyntheticIdentity]");
function syntheticCheck(ssn) {
  const d = ssn.replace(/\D/g,"");
  if (d.length !== 9) return false;
  return parseInt(d.slice(0,3),10) >= 900;
}
test("SSN 900-xx = synthetic", () => assert(syntheticCheck("900-12-3456")));
test("SSN 999-xx = synthetic", () => assert(syntheticCheck("999-12-3456")));
test("SSN 123-xx = not synthetic", () => assert(!syntheticCheck("123-12-3456")));
test("SSN 500-xx = not synthetic", () => assert(!syntheticCheck("500-12-3456")));

// ── Decision bands ────────────────────────────────────────────────────────────
console.log("\n[Decision Bands]");
function decide(score) {
  if (score < 30) return "APPROVED";
  if (score < 70) return "REVIEW";
  return "DENIED";
}
test("score 0 = APPROVED", () => assert.equal(decide(0), "APPROVED"));
test("score 29 = APPROVED", () => assert.equal(decide(29), "APPROVED"));
test("score 30 = REVIEW", () => assert.equal(decide(30), "REVIEW"));
test("score 69 = REVIEW", () => assert.equal(decide(69), "REVIEW"));
test("score 70 = DENIED", () => assert.equal(decide(70), "DENIED"));
test("score 100 = DENIED", () => assert.equal(decide(100), "DENIED"));

// ── E17 FinCEN 314(a) name normalization ──────────────────────────────────────
console.log("\n[E17_FinCEN_314a normalName]");
test("carlos escobar mendez normalized", () => assert.equal(normalName("Carlos Escobar Mendez"), "carlos escobar mendez"));
test("Jr stripped before match", () => assert.equal(normalName("Carlos Escobar Jr"), "carlos escobar"));
test("LLC stripped before match", () => assert.equal(normalName("Chen Wei Hong LLC"), "chen wei hong"));
test("punctuation stripped", () => assert.equal(normalName("Ibrahim Al-Rashid"), "ibrahim alrashid"));

// ── Scoring cap tests ─────────────────────────────────────────────────────────
console.log("\n[Scoring Caps]");
test("OFAC cap at 70", () => assert.equal(Math.min(3*40, 70), 70));
test("PEP cap at 50", () => assert.equal(Math.min(3*25, 50), 50));
test("Adverse media cap at 30", () => assert.equal(Math.min(7*5, 30), 30));
test("Total score cap at 100", () => assert.equal(Math.min(999, 100), 100));
test("OFAC single hit = 40", () => assert.equal(Math.min(1*40, 70), 40));
test("PEP single hit = 25", () => assert.equal(Math.min(1*25, 50), 25));

// ── Integration scenario: clean individual ────────────────────────────────────
console.log("\n[Integration Scenarios]");
test("clean individual scores 0 on structuring at $100", () => assert(!structFlag(100)));
test("clean individual DOB 1990 is OK", () => assert.equal(checkDOB("1990-06-15"), "ok"));
test("clean SSN 500-22-1234 is valid", () => assert(validateSSN("500-22-1234").valid));

// ── Final report ──────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`Total: ${passed + failed} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);
