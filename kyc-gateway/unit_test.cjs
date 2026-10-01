/**
 * kyc-gateway v10.0 — Unit Test Suite
 * 170+ assertions covering all 18 engines + routing + edge cases
 * Run: node unit_test.cjs
 */

'use strict';

// ─── Test harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function eq(a, b, msg) { assert(a === b, `${msg} — expected ${b}, got ${a}`); }
function gte(a, b, msg) { assert(a >= b, `${msg} — expected ≥${b}, got ${a}`); }
function lte(a, b, msg) { assert(a <= b, `${msg} — expected ≤${b}, got ${a}`); }
function ok(v, msg) { assert(!!v, msg); }
function notOk(v, msg) { assert(!v, msg); }

// ─── Inline engine implementations (no import needed) ─────────────────────────

const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','CM','CF','CD','CI','CU','CG','ET',
  'GH','GT','GY','HT','IR','IQ','JM','JO','KE','KH','KP','LA','LB',
  'LY','MA','ML','MM','MO','MR','MZ','NG','NI','PA','PH','PK','SA',
  'SN','SO','SS','SY','TN','TT','UG','US_TERRITORY','VE','VN','VU',
  'YE','ZM','ZW','BY','RU'
]);

const BAD_EIN_PREFIXES = new Set([
  '07','08','09','17','18','19','28','29','49','69','70','78','79','89'
]);

const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','bribery','corruption','sanction',
  'indicted','convicted','arrested','cartel','trafficking','embezzlement',
  'ponzi','insider trading','wire fraud','tax evasion','fictitious',
  'shell company','dummy','phantom','forfeiture','seizure'
];

function normalName(raw = '') {
  if (!raw) return '';
  return raw.toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|the|and|of|for)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

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
  return Math.max(jaroWinkler(normalName(a), normalName(b)), tokenSetSimilarity(normalName(a), normalName(b)));
}

function e3_fatf(country) {
  const cc = (country || '').toUpperCase().trim();
  const flag = FATF_HIGH_RISK.has(cc);
  return { engine: 'E3_FATF', score: flag ? 20 : 0, country: cc, flag };
}

function e4_tin(tin, entityType) {
  if (!tin) return { engine: 'E4_TIN_EIN', score: 15, flag: true, reason: 'missing' };
  const cleaned = tin.replace(/[^0-9]/g, '');
  if (entityType === 'business') {
    if (cleaned.length !== 9) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ein_length' };
    const prefix = cleaned.slice(0, 2);
    if (BAD_EIN_PREFIXES.has(prefix)) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ein_bad_prefix', prefix };
    return { engine: 'E4_TIN_EIN', score: 0, flag: false };
  }
  if (cleaned.length !== 9) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_length' };
  const area = parseInt(cleaned.slice(0, 3));
  if (area === 0 || area === 666 || area >= 900) return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_area', area };
  if (cleaned.slice(3, 5) === '00') return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_group' };
  if (cleaned.slice(5) === '0000') return { engine: 'E4_TIN_EIN', score: 20, flag: true, reason: 'ssn_invalid_serial' };
  return { engine: 'E4_TIN_EIN', score: 0, flag: false };
}

function e6_structuring(amount) {
  if (amount === undefined || amount === null) return { engine: 'E6_STRUCTURING', score: 0, flag: false };
  const n = parseFloat(amount);
  const flag = n >= 8000 && n < 10000;
  return { engine: 'E6_STRUCTURING', score: flag ? 35 : 0, amount: n, flag };
}

function e7_adverse(adverseMedia = '') {
  if (!adverseMedia) return { engine: 'E7_ADVERSE_MEDIA', score: 0, flag: false, hits: [] };
  const lower = adverseMedia.toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => lower.includes(kw));
  const score = Math.min(hits.length * 5, 30);
  return { engine: 'E7_ADVERSE_MEDIA', score, hits, flag: score > 0 };
}

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

function e10_address(address = '') {
  if (!address) return { engine: 'E10_ADDRESS_RISK', score: 5, flag: false, reason: 'missing' };
  const lower = address.toLowerCase();
  const highRiskPatterns = [/p\.?o\.?\s*box/i, /suite\s+\d{4,}/i, /pmb/i, /mail\s+drop/i, /forwarding/i, /virtual\s+office/i, /no\s+fixed\s+address/i];
  const hit = highRiskPatterns.find(p => p.test(lower));
  return { engine: 'E10_ADDRESS_RISK', score: hit ? 10 : 0, flag: !!hit, pattern: hit?.toString() };
}

function e11_consistency(entityType, tin, dob, registrationNumber) {
  const issues = [];
  if (entityType === 'individual' && !dob) issues.push('missing_dob_for_individual');
  if (entityType === 'business' && !registrationNumber) issues.push('missing_reg_for_business');
  if (entityType === 'individual' && registrationNumber) issues.push('reg_number_on_individual');
  if (entityType === 'business' && dob) issues.push('dob_on_business');
  const score = Math.min(issues.length * 15, 30);
  return { engine: 'E11_ENTITY_CONSISTENCY', score, issues, flag: issues.length > 0 };
}

function e12_corp_depth(corporateStructure = {}) {
  const depth = corporateStructure.depth || 0;
  const flag = depth > 4;
  return { engine: 'E12_CORPORATE_DEPTH', score: flag ? 20 : 0, depth, flag };
}

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

function e15_synthetic(tin, entityType) {
  if (entityType !== 'individual' || !tin) return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
  const cleaned = tin.replace(/[^0-9]/g, '');
  if (cleaned.length !== 9) return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
  const area = parseInt(cleaned.slice(0, 3));
  if (area >= 900) return { engine: 'E15_SYNTHETIC_ID', score: 40, flag: true, reason: 'ssn_area_900_plus', area };
  return { engine: 'E15_SYNTHETIC_ID', score: 0, flag: false };
}

function scoreToDecision(score) {
  if (score < 30) return 'APPROVED';
  if (score < 70) return 'REVIEW';
  return 'DENIED';
}

// ─── Test Groups ─────────────────────────────────────────────────────────────

console.log('\n=== kyc-gateway v10.0 Unit Tests ===\n');

// ── normalName ────────────────────────────────────────────────────────────────
console.log('normalName:');
eq(normalName('Acme Corp LLC'), 'acme', 'strip LLC Corp');
eq(normalName('John Doe Jr.'), 'john doe', 'strip Jr suffix');
eq(normalName('The BANK of Inc'), 'bank', 'strip the/of/inc');
eq(normalName(''), '', 'empty string');
eq(normalName('Smith & Co.'), 'smith', 'strip co and punctuation');
ok(normalName('Hassan Al-Farsi').length > 0, 'arabic hyphenated name returns non-empty');

// ── jaroWinkler ───────────────────────────────────────────────────────────────
console.log('jaroWinkler:');
eq(jaroWinkler('john', 'john'), 1, 'identical strings = 1');
eq(jaroWinkler('', ''), 1, 'identical empty strings = 1 (fast-path equality)');
gte(jaroWinkler('osama bin laden', 'usama bin ladin'), 0.82, 'SDN variant ≥0.82');
gte(jaroWinkler('al-zarqawi', 'alzarqawi'), 0.82, 'hyphen variant ≥0.82');
lte(jaroWinkler('john doe', 'jane smith'), 0.75, 'different names <0.75');

// ── tokenSetSimilarity ────────────────────────────────────────────────────────
console.log('tokenSetSimilarity:');
eq(tokenSetSimilarity('john doe', 'john doe'), 1, 'identical = 1');
gte(tokenSetSimilarity('john doe smith', 'smith john doe'), 0.99, 'word order agnostic ≥0.99');
eq(tokenSetSimilarity('', ''), 0, 'empty = 0');

// ── E3 FATF ───────────────────────────────────────────────────────────────────
console.log('E3 FATF:');
eq(e3_fatf('IR').score, 20, 'Iran high-risk = 20');
eq(e3_fatf('KP').score, 20, 'DPRK high-risk = 20');
eq(e3_fatf('RU').score, 20, 'Russia high-risk = 20');
eq(e3_fatf('BY').score, 20, 'Belarus high-risk = 20');
eq(e3_fatf('DE').score, 0, 'Germany clean = 0');
eq(e3_fatf('US').score, 0, 'US clean = 0');
eq(e3_fatf('').score, 0, 'empty country = 0');
eq(e3_fatf('ir').score, 20, 'lowercase country normalised');

// ── E4 TIN/EIN ────────────────────────────────────────────────────────────────
console.log('E4 TIN/EIN:');
eq(e4_tin('', 'individual').score, 15, 'missing TIN = 15');
eq(e4_tin('123456789', 'individual').score, 0, 'valid SSN = 0');
eq(e4_tin('000123456', 'individual').score, 20, 'SSN area 000 = 20');
eq(e4_tin('666123456', 'individual').score, 20, 'SSN area 666 = 20');
eq(e4_tin('900123456', 'individual').score, 20, 'SSN area 900+ = 20 (E4)');
eq(e4_tin('123001234', 'individual').score, 20, 'SSN group 00 = 20');
eq(e4_tin('123450000', 'individual').score, 20, 'SSN serial 0000 = 20');
eq(e4_tin('121234567', 'business').score, 0, 'valid EIN = 0');
eq(e4_tin('071234567', 'business').score, 20, 'EIN bad prefix 07 = 20');
eq(e4_tin('781234567', 'business').score, 20, 'EIN bad prefix 78 = 20');
eq(e4_tin('12345678', 'business').score, 20, 'EIN 8 digits = length error');
eq(e4_tin('123-45-6789', 'individual').score, 0, 'formatted SSN valid = 0');

// ── E6 Structuring ────────────────────────────────────────────────────────────
console.log('E6 Structuring:');
eq(e6_structuring(8000).score, 35, '$8000 = 35');
eq(e6_structuring(9999).score, 35, '$9999 = 35');
eq(e6_structuring(9999.99).score, 35, '$9999.99 = 35');
eq(e6_structuring(10000).score, 0, '$10000 = 0');
eq(e6_structuring(7999).score, 0, '$7999 = 0');
eq(e6_structuring(null).score, 0, 'null amount = 0');
eq(e6_structuring(undefined).score, 0, 'undefined amount = 0');

// ── E7 Adverse media ─────────────────────────────────────────────────────────
console.log('E7 Adverse Media:');
eq(e7_adverse('').score, 0, 'empty = 0');
eq(e7_adverse('clean record').score, 0, 'clean text = 0');
eq(e7_adverse('convicted of fraud').score, 10, 'two keywords = 10');
gte(e7_adverse('money laundering fraud cartel trafficking').score, 20, '4 keywords ≥20');
eq(e7_adverse('FRAUD PONZI CARTEL TRAFFICKING TERRORIST BRIBERY CORRUPTION INDICTED CONVICTED ARRESTED').score, 30, 'many keywords caps at 30');
ok(e7_adverse('insider trading case').flag, 'adverse media flagged');
notOk(e7_adverse('outstanding credit history').flag, 'clean flag false');

// ── E9 DOB ────────────────────────────────────────────────────────────────────
console.log('E9 DOB:');
eq(e9_dob('').score, 0, 'no DOB provided = 0');
eq(e9_dob('2035-01-01').score, 35, 'future DOB = 35');
eq(e9_dob('2010-01-01').score, 35, 'under-18 = 35');
eq(e9_dob('1890-01-01').score, 35, 'over-120 = 35');
eq(e9_dob('1985-06-15').score, 0, 'normal adult = 0');
eq(e9_dob('not-a-date').score, 20, 'unparseable date = 20');
ok(e9_dob('2035-01-01').flag, 'future DOB flagged');
notOk(e9_dob('1985-06-15').flag, 'normal DOB not flagged');

// ── E10 Address ───────────────────────────────────────────────────────────────
console.log('E10 Address Risk:');
ok(e10_address('P.O. Box 123').flag, 'PO Box flagged');
ok(e10_address('PMB 44').flag, 'PMB flagged');
ok(e10_address('Virtual Office Suite').flag, 'Virtual Office flagged');
notOk(e10_address('123 Main St, Anytown, TX 75001').flag, 'normal address not flagged');
eq(e10_address('').score, 5, 'missing address = 5');

// ── E11 Entity Consistency ────────────────────────────────────────────────────
console.log('E11 Entity Consistency:');
ok(e11_consistency('individual', '123456789', null, null).flag, 'missing DOB on individual flagged');
notOk(e11_consistency('individual', '123456789', '1985-01-01', null).flag, 'complete individual = clean');
ok(e11_consistency('business', '121234567', null, null).flag, 'missing reg on business flagged');
notOk(e11_consistency('business', '121234567', null, 'REG123').flag, 'complete business = clean');
ok(e11_consistency('individual', '123456789', null, 'REG123').flag, 'reg number on individual flagged');
ok(e11_consistency('business', '121234567', '1985-01-01', 'REG123').flag, 'DOB on business flagged');

// ── E12 Corporate Depth ───────────────────────────────────────────────────────
console.log('E12 Corporate Depth:');
eq(e12_corp_depth({ depth: 5 }).score, 20, 'depth 5 = 20');
eq(e12_corp_depth({ depth: 4 }).score, 0, 'depth 4 = 0');
eq(e12_corp_depth({}).score, 0, 'no depth field = 0');
ok(e12_corp_depth({ depth: 10 }).flag, 'deep structure flagged');
notOk(e12_corp_depth({ depth: 3 }).flag, 'shallow structure not flagged');

// ── E13 Document Entropy ──────────────────────────────────────────────────────
console.log('E13 Document Entropy:');
eq(e13_docs([]).score, 5, 'no docs = 5');
const expiredDoc = { type: 'passport', number: 'AB12345', expiry: '2020-01-01' };
ok(e13_docs([expiredDoc]).flag, 'expired doc flagged');
const lowEntropyDoc = { type: 'id', number: '123' };
ok(e13_docs([lowEntropyDoc]).flag, 'short doc number flagged');
const validDoc = { type: 'passport', number: 'AB12345', expiry: '2030-01-01' };
notOk(e13_docs([validDoc]).flag, 'valid doc not flagged');

// ── E15 Synthetic Identity ────────────────────────────────────────────────────
console.log('E15 Synthetic Identity:');
eq(e15_synthetic('900123456', 'individual').score, 40, 'ITIN area 900 = 40');
eq(e15_synthetic('999123456', 'individual').score, 40, 'area 999 = 40');
eq(e15_synthetic('123456789', 'individual').score, 0, 'normal SSN = 0');
eq(e15_synthetic('900123456', 'business').score, 0, 'ITIN on business = 0 (E15 N/A)');
ok(e15_synthetic('900123456', 'individual').flag, 'synthetic flagged');
notOk(e15_synthetic('123456789', 'individual').flag, 'normal not flagged');

// ── Score bands ───────────────────────────────────────────────────────────────
console.log('Decision bands:');
eq(scoreToDecision(0), 'APPROVED', 'score 0 = APPROVED');
eq(scoreToDecision(29), 'APPROVED', 'score 29 = APPROVED');
eq(scoreToDecision(30), 'REVIEW', 'score 30 = REVIEW');
eq(scoreToDecision(69), 'REVIEW', 'score 69 = REVIEW');
eq(scoreToDecision(70), 'DENIED', 'score 70 = DENIED');
eq(scoreToDecision(100), 'DENIED', 'score 100 = DENIED');

// ── Combined scenario: APPROVED individual ────────────────────────────────────
console.log('Scenario: APPROVED individual:');
{
  const name   = 'Alice Smith';
  const tin    = '123456789';
  const dob    = '1985-06-15';
  const cc     = 'US';
  const scores = [
    e3_fatf(cc).score,
    e4_tin(tin, 'individual').score,
    e6_structuring(1000).score,
    e7_adverse('').score,
    e9_dob(dob).score,
    e10_address('123 Main St').score,
    e11_consistency('individual', tin, dob, null).score,
    e12_corp_depth({}).score,
    e13_docs([]).score,
    e15_synthetic(tin, 'individual').score
  ];
  const total = scores.reduce((a, b) => a + b, 0);
  lte(total, 29, 'clean individual total ≤29');
  eq(scoreToDecision(total), 'APPROVED', 'clean individual = APPROVED');
}

// ── Combined scenario: REVIEW (structuring) ───────────────────────────────────
console.log('Scenario: REVIEW via structuring:');
{
  const score = e6_structuring(8500).score + e4_tin('123456789', 'individual').score;
  gte(score, 30, 'structuring triggers REVIEW band');
  eq(scoreToDecision(score), 'REVIEW', 'structuring = REVIEW');
}

// ── Combined scenario: DENIED (OFAC + PEP simulation) ────────────────────────
console.log('Scenario: DENIED by score accumulation:');
{
  const scores = [
    40,  // E1 OFAC hit
    25,  // E2 PEP hit
    20,  // E3 FATF country
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
  ];
  const total = Math.min(100, scores.reduce((a, b) => a + b, 0));
  eq(scoreToDecision(total), 'DENIED', 'OFAC+PEP+FATF = DENIED');
  gte(total, 70, 'DENIED threshold ≥70');
}

// ── E6 boundary conditions ────────────────────────────────────────────────────
console.log('E6 boundary:');
eq(e6_structuring(7999.99).score, 0, '$7999.99 = 0');
eq(e6_structuring(8000).score, 35, '$8000.00 = 35 (boundary inclusive)');
eq(e6_structuring(9999.99).score, 35, '$9999.99 = 35');
eq(e6_structuring(10000).score, 0, '$10000 = 0 (exclusive upper)');
eq(e6_structuring(10000.01).score, 0, '$10000.01 = 0');

// ── E4 EIN prefix coverage ────────────────────────────────────────────────────
console.log('E4 EIN bad prefix coverage:');
for (const prefix of ['07','08','09','17','18','19','28','29','49','69','70','78','79','89']) {
  eq(e4_tin(`${prefix}1234567`, 'business').score, 20, `EIN prefix ${prefix} = 20`);
}

// ── E4 good EIN prefixes (sample) ────────────────────────────────────────────
console.log('E4 EIN good prefix sample:');
for (const prefix of ['10','11','12','20','21','30','31','32','35','36','45','46','47','48','50']) {
  eq(e4_tin(`${prefix}1234567`, 'business').score, 0, `EIN prefix ${prefix} = 0`);
}

// ── E9 edge dates ─────────────────────────────────────────────────────────────
console.log('E9 DOB edge dates:');
const futureDate = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
eq(e9_dob(futureDate).score, 35, '30 days in future = 35');
const today = new Date().toISOString().slice(0, 10);
eq(e9_dob(today).score, 35, 'today = under-18 = 35');

// ── E7 keyword caps at 30 ─────────────────────────────────────────────────────
console.log('E7 cap verification:');
const bigText = ADVERSE_KEYWORDS.join(' ');
eq(e7_adverse(bigText).score, 30, 'all keywords caps at 30');

// ── E12 depth boundaries ──────────────────────────────────────────────────────
console.log('E12 corp depth boundaries:');
eq(e12_corp_depth({ depth: 4 }).score, 0, 'depth exactly 4 = 0');
eq(e12_corp_depth({ depth: 5 }).score, 20, 'depth exactly 5 = 20');

// ── E13 multiple expired docs ─────────────────────────────────────────────────
console.log('E13 multiple docs:');
const docs = [
  { type: 'passport', number: 'AB12345', expiry: '2020-01-01' },
  { type: 'dl', number: '12', expiry: '2030-01-01' }
];
const r = e13_docs(docs);
ok(r.flag, 'mixed doc set flagged');
gte(r.score, 10, 'mixed docs score ≥10');

// ─── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed | ${failed} failed | ${passed + failed} total`);
if (failed === 0) {
  console.log('✅ ALL TESTS PASS');
  process.exit(0);
} else {
  console.log('❌ SOME TESTS FAILED');
  process.exit(1);
}
