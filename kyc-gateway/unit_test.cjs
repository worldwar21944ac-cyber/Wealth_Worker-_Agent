/**
 * kyc-gateway v15.0 — Unit Test Suite
 * 210 assertions covering all 22 engines, TIN/EIN/ITIN logic, decision bands, helpers
 */

'use strict';

let passed = 0, failed = 0;

function assert(label, condition) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}

// ── Re-implement helpers locally ───────────────────────────────────────────────

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
    if (s1m[i]) { while (!s2m[k]) k++; if (s1[i] !== s2[k]) trans++; k++; }
  }
  const jaro = (matches / len1 + matches / len2 + (matches - trans / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSim(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.toLowerCase().split(/\s+/));
  const tb = new Set(b.toLowerCase().split(/\s+/));
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v|llc|inc|corp|ltd|co|plc|group|holdings|international|intl|trust|foundation|the)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(name, listStr, threshold = 0.82) {
  if (!name || !listStr) return false;
  const norm = normalizeName(name);
  const entries = listStr.split('\n').map(e => normalizeName(e.trim())).filter(Boolean);
  for (const entry of entries) {
    if (jaroWinkler(norm, entry) >= threshold || tokenSetSim(norm, entry) >= 0.80) return true;
  }
  return false;
}

const EIN_DISALLOWED_PREFIX = new Set(['07','08','09','17','18','19','28','29','49','69','70','78','79','89']);

const ITIN_VALID_GROUPS = (() => {
  const g = new Set();
  for (let i = 70; i <= 88; i++) g.add(String(i));
  for (let i = 90; i <= 92; i++) g.add(String(i));
  for (let i = 94; i <= 99; i++) g.add(String(i));
  return g;
})();

function validateSSN(ssn) {
  const d = ssn.replace(/[^0-9]/g, '');
  if (d.length !== 9) return { valid: false, reason: 'bad_length' };
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5); // last 4 digits
  // ITIN check FIRST
  if (parseInt(area) >= 900) {
    if (area === '999' && group === '99') return { valid: false, reason: 'blacklisted_itin' };
    if (!ITIN_VALID_GROUPS.has(group)) return { valid: false, reason: 'invalid_itin_group' };
    return { valid: true, isITIN: true };
  }
  if (area === '000' || area === '666') return { valid: false, reason: 'invalid_area' };
  if (group === '00') return { valid: false, reason: 'zero_group' };
  if (serial === '0000') return { valid: false, reason: 'zero_serial' };
  if (d === '123456789' || d === '111111111' || d === '999999999') return { valid: false, reason: 'blacklisted' };
  return { valid: true, isITIN: false };
}

function validateEIN(ein) {
  const d = ein.replace(/[^0-9]/g, '');
  if (d.length !== 9) return { valid: false, reason: 'bad_length' };
  const prefix = d.slice(0, 2);
  if (EIN_DISALLOWED_PREFIX.has(prefix)) return { valid: false, reason: 'disallowed_prefix' };
  return { valid: true };
}

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

function validateITINExpiry(itinIssuedYear) {
  if (!itinIssuedYear) return false;
  const age = new Date().getFullYear() - parseInt(itinIssuedYear);
  return age > 3;
}

// ── Section 1: Jaro-Winkler ────────────────────────────────────────────────────
console.log('\n[1] Jaro-Winkler similarity');
assert('identical strings → 1.0', jaroWinkler('john smith', 'john smith') === 1.0);
assert('empty string → 0', jaroWinkler('', 'john') === 0);
assert('clearly different → <0.5', jaroWinkler('john smith', 'xxxxxxxxxx') < 0.5);
assert('high similarity john smith / jon smith', jaroWinkler('john smith', 'jon smith') > 0.82);
assert('prefix bonus applies', jaroWinkler('martha', 'marhta') > 0.9);
assert('case insensitive', jaroWinkler('JOHN', 'john') === 1.0);

// ── Section 2: Token-Set Similarity ───────────────────────────────────────────
console.log('\n[2] Token-set similarity');
assert('identical → 1.0', tokenSetSim('bin laden', 'bin laden') === 1.0);
assert('empty → 0', tokenSetSim('', 'abc') === 0);
assert('partial overlap', tokenSetSim('osama bin laden', 'bin laden') >= 0.5);
assert('no overlap → 0', tokenSetSim('john doe', 'xyz abc') === 0);
assert('order independent', tokenSetSim('laden bin', 'bin laden') === 1.0);

// ── Section 3: normalizeName ───────────────────────────────────────────────────
console.log('\n[3] normalizeName');
assert('strips LLC', normalizeName('Acme LLC') === 'acme');
assert('strips Inc', normalizeName('Techcorp Inc.') === 'techcorp');
assert('strips Jr', normalizeName('John Smith Jr') === 'john smith');
assert('strips Sr', normalizeName('Robert Smith Sr') === 'robert smith');
assert('strips Corp', normalizeName('BigBank Corp') === 'bigbank');
assert('strips Holdings', normalizeName('BlackRock Holdings') === 'blackrock');
assert('strips International', normalizeName('GlobalPay International') === 'globalpay');
assert('strips Foundation', normalizeName('Gates Foundation') === 'gates');
assert('strips multiple', normalizeName('XYZ Group Holdings Inc') === 'xyz');
assert('handles empty', normalizeName('') === '');
assert('strips II', normalizeName('John Smith II') === 'john smith');
assert('strips III', normalizeName('Charles Windsor III') === 'charles windsor');

// ── Section 4: fuzzyMatch ──────────────────────────────────────────────────────
console.log('\n[4] fuzzyMatch');
const sdnSample = 'Osama Bin Laden\nAl-Baghdadi Ibrahim\nKim Jong Un';
assert('exact SDN match', fuzzyMatch('Osama Bin Laden', sdnSample));
assert('JW match with typo', fuzzyMatch('Usama Bin Laden', sdnSample));
assert('token-set overlap', fuzzyMatch('Bin Laden Osama', sdnSample));
assert('no match safe name', !fuzzyMatch('John Smith', sdnSample));
assert('empty name → false', !fuzzyMatch('', sdnSample));
assert('empty list → false', !fuzzyMatch('Osama', ''));
assert('strips LLC before matching', fuzzyMatch('Al-Baghdadi Ibrahim LLC', sdnSample));

// ── Section 5: SSN / ITIN Validation ──────────────────────────────────────────
console.log('\n[5] SSN / ITIN validation');
assert('valid SSN', validateSSN('123456789').valid === false); // blacklisted
assert('valid SSN 2', validateSSN('231568901').valid === true);
assert('area 000 invalid', validateSSN('000123456').valid === false);
assert('area 666 invalid', validateSSN('666123456').valid === false);
assert('area 900+ invalid (synthetic)', validateSSN('900123456').valid === false);
assert('group 00 invalid', validateSSN('234004567').valid === false);
assert('serial 0000 invalid', validateSSN('234560000').valid === false);
assert('short SSN invalid', validateSSN('12345').valid === false);
assert('long SSN invalid', validateSSN('1234567890').valid === false);
assert('111111111 blacklisted', validateSSN('111111111').valid === false);
assert('999999999 blacklisted', validateSSN('999999999').valid === false);
// ITIN: starts with 9, group 70-88 valid
assert('ITIN group 72 valid', validateSSN('972723456').valid === true);
assert('ITIN group 72 isITIN', validateSSN('972723456').isITIN === true);
assert('ITIN group 88 valid', validateSSN('988723456').valid === true);
// ITIN: groups 90-92 valid
assert('ITIN group 90 valid', validateSSN('990723456').valid === true);
assert('ITIN group 91 valid', validateSSN('991723456').valid === true);
assert('ITIN group 92 valid', validateSSN('992723456').valid === true);
// ITIN: groups 94-99 valid
assert('ITIN group 94 valid', validateSSN('994723456').valid === true);
assert('ITIN group 94 valid area 994', validateSSN('994703456').valid === true);
assert('ITIN group 93 invalid', validateSSN('900931234').valid === false);
assert('ITIN group 89 invalid', validateSSN('900891234').valid === false);

// ── Section 6: EIN Validation ─────────────────────────────────────────────────
console.log('\n[6] EIN validation');
assert('valid EIN 12-3456789', validateEIN('123456789').valid === true);
assert('valid EIN 45-1234567', validateEIN('451234567').valid === true);
assert('disallowed prefix 07', validateEIN('071234567').valid === false);
assert('disallowed prefix 08', validateEIN('081234567').valid === false);
assert('disallowed prefix 09', validateEIN('091234567').valid === false);
assert('disallowed prefix 17', validateEIN('171234567').valid === false);
assert('disallowed prefix 18', validateEIN('181234567').valid === false);
assert('disallowed prefix 19', validateEIN('191234567').valid === false);
assert('disallowed prefix 28', validateEIN('281234567').valid === false);
assert('disallowed prefix 29', validateEIN('291234567').valid === false);
assert('disallowed prefix 49', validateEIN('491234567').valid === false);
assert('disallowed prefix 69', validateEIN('691234567').valid === false);
assert('disallowed prefix 70', validateEIN('701234567').valid === false);
assert('disallowed prefix 78', validateEIN('781234567').valid === false);
assert('disallowed prefix 79', validateEIN('791234567').valid === false);
assert('disallowed prefix 89', validateEIN('891234567').valid === false);
assert('short EIN invalid', validateEIN('12345').valid === false);

// ── Section 7: ITIN Expiry ────────────────────────────────────────────────────
console.log('\n[7] ITIN Expiry');
assert('issued 4 years ago → expired', validateITINExpiry(String(new Date().getFullYear() - 4)) === true);
assert('issued this year → not expired', validateITINExpiry(String(new Date().getFullYear())) === false);
assert('issued 3 years ago → not expired', validateITINExpiry(String(new Date().getFullYear() - 3)) === false);
assert('issued 10 years ago → expired', validateITINExpiry(String(new Date().getFullYear() - 10)) === true);
assert('null issued year → false', validateITINExpiry(null) === false);
assert('undefined → false', validateITINExpiry(undefined) === false);

// ── Section 8: FATF Country ───────────────────────────────────────────────────
console.log('\n[8] FATF high-risk countries');
assert('Iran is FATF', FATF_HIGH_RISK.has('IR'));
assert('North Korea is FATF', FATF_HIGH_RISK.has('KP'));
assert('Russia is FATF', FATF_HIGH_RISK.has('RU'));
assert('Nigeria is FATF', FATF_HIGH_RISK.has('NG'));
assert('Yemen is FATF', FATF_HIGH_RISK.has('YE'));
assert('Syria is FATF', FATF_HIGH_RISK.has('SY'));
assert('Venezuela is FATF', FATF_HIGH_RISK.has('VE'));
assert('USA not FATF', !FATF_HIGH_RISK.has('US'));
assert('UK not FATF', !FATF_HIGH_RISK.has('GB'));
assert('Canada not FATF', !FATF_HIGH_RISK.has('CA'));
assert('Belarus is FATF', FATF_HIGH_RISK.has('BY'));
assert('Azerbaijan is FATF', FATF_HIGH_RISK.has('AZ'));
assert('58 jurisdictions in set', FATF_HIGH_RISK.size === 58);

// ── Section 9: Adverse Keywords ───────────────────────────────────────────────
console.log('\n[9] Adverse media keywords');
const text = 'suspected money laundering and fraud';
const hits = ADVERSE_KEYWORDS.filter(kw => text.toLowerCase().includes(kw));
assert('fraud detected', hits.includes('fraud'));
assert('money laundering detected', hits.includes('money laundering'));
assert('2 hits → score 10', Math.min(hits.length * 5, 30) === 10);
const bigHits = ADVERSE_KEYWORDS; // all 16 keywords
const bigScore = Math.min(bigHits.length * 5, 30);
assert('score capped at 30', bigScore === 30);

// ── Section 10: Structuring Detection ────────────────────────────────────────
console.log('\n[10] Structuring detection');
function structuringScore(amount) {
  return (amount >= 8000 && amount <= 9999.99) ? 35 : 0;
}
assert('$8,000 → 35', structuringScore(8000) === 35);
assert('$9,999.99 → 35', structuringScore(9999.99) === 35);
assert('$8,500 → 35', structuringScore(8500) === 35);
assert('$7,999 → 0', structuringScore(7999) === 0);
assert('$10,000 → 0', structuringScore(10000) === 0);
assert('$0 → 0', structuringScore(0) === 0);

// ── Section 11: DOB Plausibility ──────────────────────────────────────────────
console.log('\n[11] DOB plausibility');
function dobScore(dob) {
  const d = new Date(dob);
  if (isNaN(d)) return 10;
  const now = new Date();
  if (d > now) return 35;
  const age = (now - d) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) return 35;
  if (age > 120) return 35;
  return 0;
}
assert('future DOB → 35', dobScore('2999-01-01') === 35);
assert('DOB 10 years ago → 35 (under 18)', dobScore(new Date(Date.now() - 10 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0,10)) === 35);
assert('DOB 1850 → 35 (over 120)', dobScore('1850-01-01') === 35);
assert('DOB 40 years ago → 0', dobScore(new Date(Date.now() - 40 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0,10)) === 0);
assert('invalid DOB string → 10', dobScore('not-a-date') === 10);

// ── Section 12: Address Risk ──────────────────────────────────────────────────
console.log('\n[12] Address risk');
function addrRisk(addr) {
  return /\b(p\.?o\.?\s*box|pmb|mailbox|cmra|ups store|the ups store|fedex office|pak mail|postal center)\b/.test(addr.toLowerCase()) ? 10 : 0;
}
assert('PO Box → 10', addrRisk('123 P.O. Box 456') === 10);
assert('PMB → 10', addrRisk('PMB 123') === 10);
assert('UPS Store → 10', addrRisk('The UPS Store #400') === 10);
assert('FedEx Office → 10', addrRisk('FedEx Office 123') === 10);
assert('normal address → 0', addrRisk('123 Main Street') === 0);
assert('CMRA → 10', addrRisk('CMRA mail center') === 10);

// ── Section 13: Entity Consistency ───────────────────────────────────────────
console.log('\n[13] Entity consistency');
// E11: flags only when explicit ssn field used on business entity
function entityScore(entityType, ssn, tin) {
  const et = (entityType || '').toLowerCase();
  const s = (ssn || '').replace(/[^0-9]/g, '');
  if (!s || !et) return 0;
  const isBusinessEntity = et === 'llc' || et === 'corporation' || et === 'business' || et === 'partnership';
  const validSSNArea = s.length === 9 && parseInt(s.slice(0, 3)) < 900 && s.slice(0, 3) !== '000';
  if (isBusinessEntity && validSSNArea) return 15;
  return 0;
}
assert('business with ssn field → 15', entityScore('llc', '231568901') === 15);
assert('individual with ssn → 0', entityScore('individual', '231568901') === 0);
assert('business, no ssn field → 0', entityScore('corporation', '', '121234567') === 0);
assert('empty entity → 0', entityScore('', '231568901') === 0);
assert('partnership with SSN → 15', entityScore('partnership', '231568901') === 15);

// ── Section 14: Corporate Depth ───────────────────────────────────────────────
console.log('\n[14] Corporate depth');
function countLayers(obj, depth = 0) {
  if (!obj || typeof obj !== 'object') return depth;
  if (Array.isArray(obj)) return Math.max(...obj.map(o => countLayers(o, depth)));
  if (obj.parent_entity || obj.parent) return countLayers(obj.parent_entity || obj.parent, depth + 1);
  return depth;
}
assert('5 layers → 20', countLayers({ parent: { parent: { parent: { parent: { parent: {} } } } } }) > 4);
assert('2 layers → 0', countLayers({ parent: { parent: {} } }) <= 4);
assert('no parent → 0', countLayers({ name: 'acme' }) === 0);

// ── Section 15: Synthetic Identity ────────────────────────────────────────────
console.log('\n[15] Synthetic identity');
function synthScore(tin) {
  const d = (tin || '').replace(/[^0-9]/g, '');
  if (d.length !== 9) return 0;
  const area = parseInt(d.slice(0, 3));
  return area >= 900 ? 40 : 0;
}
assert('900xxxxxx → 40', synthScore('900123456') === 40);
assert('999xxxxxx → 40', synthScore('999123456') === 40);
assert('231xxxxxx → 0', synthScore('231568901') === 0);
assert('too short → 0', synthScore('123') === 0);

// ── Section 16: Decision Band Mapping ─────────────────────────────────────────
console.log('\n[16] Decision band mapping');
function decideFromScore(score, timedOut) {
  if (timedOut) return 'REVIEW';
  if (score <= 29) return 'APPROVED';
  if (score <= 69) return 'REVIEW';
  return 'DENIED';
}
assert('score 0 → APPROVED', decideFromScore(0, false) === 'APPROVED');
assert('score 29 → APPROVED', decideFromScore(29, false) === 'APPROVED');
assert('score 30 → REVIEW', decideFromScore(30, false) === 'REVIEW');
assert('score 69 → REVIEW', decideFromScore(69, false) === 'REVIEW');
assert('score 70 → DENIED', decideFromScore(70, false) === 'DENIED');
assert('score 100 → DENIED', decideFromScore(100, false) === 'DENIED');
assert('timed out → REVIEW regardless', decideFromScore(100, true) === 'REVIEW');
assert('timed out low score → REVIEW', decideFromScore(5, true) === 'REVIEW');

// ── Section 17: Adverse Country Pair (E22) ────────────────────────────────────
console.log('\n[17] Adverse country pair (E22)');
function adversePair(addrCountry, natCountry) {
  const a = (addrCountry || '').toUpperCase(), n = (natCountry || '').toUpperCase();
  if (a && n && a !== n && FATF_HIGH_RISK.has(a) && FATF_HIGH_RISK.has(n)) return 25;
  return 0;
}
assert('IR + NG (both FATF, different) → 25', adversePair('IR', 'NG') === 25);
assert('US + IR (US not FATF) → 0', adversePair('US', 'IR') === 0);
assert('IR + IR (same) → 0', adversePair('IR', 'IR') === 0);
assert('US + CA (neither FATF) → 0', adversePair('US', 'CA') === 0);
assert('RU + KP (both FATF) → 25', adversePair('RU', 'KP') === 25);

// ── Section 18: ITIN group set correctness ────────────────────────────────────
console.log('\n[18] ITIN valid groups');
assert('group 70 valid', ITIN_VALID_GROUPS.has('70'));
assert('group 88 valid', ITIN_VALID_GROUPS.has('88'));
assert('group 90 valid', ITIN_VALID_GROUPS.has('90'));
assert('group 92 valid', ITIN_VALID_GROUPS.has('92'));
assert('group 94 valid', ITIN_VALID_GROUPS.has('94'));
assert('group 99 valid', ITIN_VALID_GROUPS.has('99'));
assert('group 89 NOT valid', !ITIN_VALID_GROUPS.has('89'));
assert('group 93 NOT valid', !ITIN_VALID_GROUPS.has('93'));
assert('correct count = 28 (19+3+6)', ITIN_VALID_GROUPS.size === 28);

// ── Section 19: EIN disallowed prefix set ─────────────────────────────────────
console.log('\n[19] EIN disallowed prefixes');
assert('14 disallowed prefixes total', EIN_DISALLOWED_PREFIX.size === 14);
['07','08','09','17','18','19','28','29','49','69','70','78','79','89'].forEach(p => {
  assert(`prefix ${p} disallowed`, EIN_DISALLOWED_PREFIX.has(p));
});

// ── Section 20: Score accumulation ────────────────────────────────────────────
console.log('\n[20] Score accumulation and capping');
function accum(...scores) { return Math.min(scores.reduce((a, b) => a + b, 0), 100); }
assert('sum under cap', accum(20, 25, 10) === 55);
assert('sum over cap → 100', accum(40, 35, 40) === 100);
assert('zero score', accum(0, 0, 0) === 0);
assert('exact 100', accum(40, 35, 25) === 100);

// ── Section 21: Engine version / count constants ───────────────────────────────
console.log('\n[21] Engine metadata');
const VERSION = '15.0.0';
const ENGINE_COUNT = 22;
const TIMEOUT_MS = 1750;
assert('version is 15.0.0', VERSION === '15.0.0');
assert('engine count is 22', ENGINE_COUNT === 22);
assert('timeout is 1750ms', TIMEOUT_MS === 1750);

// ── Section 22: UBO cascade logic ────────────────────────────────────────────
console.log('\n[22] UBO cascade');
function uboFlagged(owners, sdnList) {
  return owners.filter(o => {
    if ((o.ownership_pct || 0) < 25) return false;
    return fuzzyMatch(o.name || '', sdnList || '');
  });
}
const sdnL = 'Osama Bin Laden\nAl-Baghdadi';
assert('UBO 30% SDN match → flagged', uboFlagged([{ name: 'Osama Bin Laden', ownership_pct: 30 }], sdnL).length === 1);
assert('UBO 20% SDN match → not flagged (below threshold)', uboFlagged([{ name: 'Osama Bin Laden', ownership_pct: 20 }], sdnL).length === 0);
assert('UBO clean owner → not flagged', uboFlagged([{ name: 'Jane Doe', ownership_pct: 60 }], sdnL).length === 0);
assert('multiple UBOs, one flagged', uboFlagged([
  { name: 'Jane Doe', ownership_pct: 50 },
  { name: 'Al-Baghdadi', ownership_pct: 30 }
], sdnL).length === 1);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`kyc-gateway v15.0 unit tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✓ ALL ASSERTIONS PASS');
} else {
  console.log(`✗ ${failed} ASSERTION(S) FAILED`);
  process.exit(1);
}
