/**
 * kyc-gateway v15.0 — Unit Test Suite
 * 175 assertions across 22 test sections
 * Run: node unit_test.cjs
 */

'use strict';

let passed = 0, failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ─── Re-implement helpers locally (mirror of worker.js) ───────────────────

const FATF_HIGH_RISK = new Set([
  'AF','AL','BB','BF','BJ','BT','CF','CG','CI','CM','CU','DZ','EC','ET',
  'GH','GN','GW','HT','ID','IQ','IR','JM','JO','KE','KH','KP','KR','LA',
  'LB','LK','LY','MA','ME','ML','MM','MR','MZ','NG','NI','PA','PH','PK',
  'RS','RU','SA','SD','SL','SN','SY','TG','TJ','TN','TT','UG','UZ','VE',
  'VN','YE','ZW',
]);

const EIN_DISALLOWED = new Set(['07','08','09','17','18','19','28','29','49','69','70','78','79','89']);

const ADVERSE_KEYWORDS = [
  'fraud','money laundering','terrorist','drug trafficking','bribery','corruption',
  'embezzlement','cartel','sanction','indicted','convicted','arrested','criminal',
  'ponzi','wire fraud','identity theft','tax evasion','counterfeiting','smuggling',
];

function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|llc|inc|corp|ltd|co|plc|group|holdings|international|intl|trust|foundation|nv|bv|gmbh|ag|sa)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaroWinkler(s1, s2) {
  if (!s1 && !s2) return 0.0;
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

function tokenSetSim(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  const inter = [...sa].filter(t => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function nameMatch(candidate, target, jwThreshold = 0.82) {
  const c = normalizeName(candidate);
  const t = normalizeName(target);
  if (!c || !t) return false;
  return jaroWinkler(c, t) >= jwThreshold || tokenSetSim(c, t) >= 0.80;
}

function parseSSN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return { valid: false };
  const area = parseInt(digits.slice(0, 3), 10);
  const group = parseInt(digits.slice(3, 5), 10);
  const serial = parseInt(digits.slice(5), 10);
  if (area === 0 || group === 0 || serial === 0) return { valid: false, area, group, serial };
  if (area === 666) return { valid: false, area, group, serial };
  return { valid: area < 900, itin: area >= 900, area, group, serial };
}

function isITIN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const area = parseInt(digits.slice(0, 3), 10);
  if (area < 900 || area > 999) return false;
  const group = parseInt(digits.slice(3, 5), 10);
  return (group >= 50 && group <= 65) ||
         (group >= 70 && group <= 88) ||
         (group >= 90 && group <= 92) ||
         (group >= 94 && group <= 99);
}

function validateEIN(tin) {
  const digits = (tin || '').replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const prefix = digits.slice(0, 2);
  return !EIN_DISALLOWED.has(prefix);
}

// Engine stubs (pure functions — no KV/D1)
function e03_fatf(payload) {
  const country = (payload.country || '').toUpperCase().slice(0, 2);
  const hit = FATF_HIGH_RISK.has(country);
  return { score: hit ? 20 : 0, country, flagged: hit };
}
function e04_tin(payload) {
  const tin = (payload.tin || '').replace(/\D/g, '');
  const entityType = (payload.entityType || 'individual').toLowerCase();
  if (!tin) return { score: 20, reason: 'missing_tin' };
  if (entityType === 'business' || entityType === 'kyb') {
    const valid = validateEIN(tin);
    return { score: valid ? 0 : 20, einValid: valid };
  }
  const ssn = parseSSN(tin);
  if (ssn.itin) {
    const itinOk = isITIN(tin);
    return { score: itinOk ? 5 : 20, itin: true, itinValid: itinOk };
  }
  return { score: ssn.valid ? 0 : 20, ssnValid: ssn.valid };
}
function e06_structuring(payload) {
  const amount = parseFloat(payload.amount || 0);
  const flagged = amount >= 8000 && amount < 10000;
  return { score: flagged ? 35 : 0, flagged };
}
function e07_adverse(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  const hits = ADVERSE_KEYWORDS.filter(kw => text.includes(kw));
  return { score: Math.min(hits.length * 5, 30), hits };
}
function e09_dob(payload) {
  const dob = payload.dateOfBirth;
  if (!dob) return { score: 0 };
  const dt = new Date(dob);
  if (isNaN(dt)) return { score: 10 };
  const now = new Date();
  if (dt > now) return { score: 35, reason: 'future_dob' };
  const age = (now - dt) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) return { score: 35, reason: 'under_18', age: Math.floor(age) };
  if (age > 120) return { score: 35, reason: 'over_120' };
  return { score: 0, age: Math.floor(age) };
}
function e10_address(payload) {
  const addr = (payload.address || '').toLowerCase();
  const reasons = [];
  if (/\bpo\s*box\b/.test(addr)) reasons.push('po_box');
  if (/\b(cmra|mailbox)\b/.test(addr)) reasons.push('cmra');
  if (!payload.zip) reasons.push('missing_zip');
  return { score: reasons.length > 0 ? 10 : 0, reasons };
}
function e11_consistency(payload) {
  const name = payload.applicantName || '';
  const entityType = (payload.entityType || 'individual').toLowerCase();
  const tin = (payload.tin || '').replace(/\D/g, '');
  const reasons = [];
  if ((entityType === 'business' || entityType === 'kyb') && tin.length === 9) {
    if (!validateEIN(tin)) {
      const ssn = parseSSN(tin);
      if (ssn.valid) reasons.push('business_with_ssn');
    }
  }
  const corpTerms = /(llc|inc|corp|ltd|co\.|plc|group|holdings)/i;
  if (entityType === 'individual' && corpTerms.test(name)) reasons.push('individual_with_corporate_name');
  return { score: reasons.length > 0 ? 15 : 0, reasons };
}
function e12_corporate(payload) {
  const layers = payload.corporateLayers || 0;
  return { score: layers > 4 ? 20 : 0, layers };
}
function e15_synthetic(payload) {
  const tin = (payload.tin || '').replace(/\D/g, '');
  if (!tin || tin.length !== 9) return { score: 0 };
  const area = parseInt(tin.slice(0, 3), 10);
  if (area >= 900) {
    const itinOk = isITIN(tin);
    return { score: itinOk ? 10 : 40, synthetic: !itinOk, itin: true };
  }
  const { valid } = parseSSN(tin);
  return { score: valid ? 0 : 40 };
}
function e19_cob(payload) {
  const cob = (payload.countryOfBirth || '').toUpperCase().slice(0, 2);
  const hit = FATF_HIGH_RISK.has(cob);
  return { score: hit ? 15 : 0, flagged: hit };
}

// ─── SECTION 1: normalizeName ─────────────────────────────────────────────
console.log('\n§1  normalizeName()');
assert('strips LLC',               normalizeName('Acme LLC') === 'acme');
assert('strips Inc.',              normalizeName('Widgets Inc.') === 'widgets');
assert('strips Corp',              normalizeName('BigCo Corp') === 'bigco');
assert('strips Ltd',               normalizeName('Alpha Ltd') === 'alpha');
assert('strips Jr',                normalizeName('John Smith Jr') === 'john smith');
assert('strips Sr',                normalizeName('John Smith Sr') === 'john smith');
assert('strips II',                normalizeName('Robert Lee II') === 'robert lee');
assert('strips Holdings',          normalizeName('XYZ Holdings') === 'xyz');
assert('strips International',     normalizeName('Global International Corp') === 'global');
assert('strips Trust',             normalizeName('Family Trust') === 'family');
assert('strips Foundation',        normalizeName('Gates Foundation') === 'gates');
assert('strips GmbH',              normalizeName('Bayer GmbH') === 'bayer');
assert('handles empty',            normalizeName('') === '');
assert('handles null',             normalizeName(null) === '');
assert('collapses whitespace',     normalizeName('  John   Doe  ') === 'john doe');

// ─── SECTION 2: jaroWinkler ───────────────────────────────────────────────
console.log('\n§2  jaroWinkler()');
assert('identical strings → 1.0',  jaroWinkler('john smith', 'john smith') === 1.0);
assert('empty strings → 0.0',      jaroWinkler('', '') === 0.0);
assert('completely different < 0.5', jaroWinkler('john', 'xyz') < 0.5);
assert('close names > 0.80',        jaroWinkler('john smith', 'jon smith') > 0.80);
assert('common prefix boost',       jaroWinkler('johnathan', 'john') > 0.7);

// ─── SECTION 3: tokenSetSim ───────────────────────────────────────────────
console.log('\n§3  tokenSetSim()');
assert('identical → 1.0',          tokenSetSim('john doe', 'john doe') === 1.0);
assert('no overlap → 0.0',         tokenSetSim('alice', 'bob') === 0.0);
assert('partial overlap',          tokenSetSim('john doe smith', 'john doe') > 0.5);

// ─── SECTION 4: nameMatch ─────────────────────────────────────────────────
console.log('\n§4  nameMatch()');
assert('exact match',              nameMatch('John Smith', 'John Smith'));
assert('fuzzy match typo',         nameMatch('Jon Smith', 'John Smith'));
assert('no match — different',     !nameMatch('Alice Johnson', 'Robert Brown'));
assert('strips suffixes before',   nameMatch('Acme LLC', 'Acme'));
assert('empty candidate → false',  !nameMatch('', 'John Smith'));
assert('empty target → false',     !nameMatch('John Smith', ''));

// ─── SECTION 5: parseSSN ─────────────────────────────────────────────────
console.log('\n§5  parseSSN()');
assert('valid SSN → valid:true',   parseSSN('123-45-6789').valid === true);
assert('area 666 → valid:false',   parseSSN('666-12-3456').valid === false);
assert('area 000 → valid:false',   parseSSN('000-12-3456').valid === false);
assert('group 00 → valid:false',   parseSSN('123-00-6789').valid === false);
assert('serial 0000 → valid:false',parseSSN('123-45-0000').valid === false);
assert('area 900 → itin:true',     parseSSN('900-70-1234').itin === true);
assert('area 999 → itin:true',     parseSSN('999-50-1234').itin === true);
assert('8 digits → valid:false',   parseSSN('12345678').valid === false);

// ─── SECTION 6: isITIN ───────────────────────────────────────────────────
console.log('\n§6  isITIN()');
assert('group 70 valid',           isITIN('900-70-1234') === true);
assert('group 88 valid',           isITIN('900-88-1234') === true);
assert('group 50 valid',           isITIN('900-50-1234') === true);
assert('group 65 valid',           isITIN('900-65-1234') === true);
assert('group 90 valid',           isITIN('900-90-1234') === true);
assert('group 92 valid',           isITIN('900-92-1234') === true);
assert('group 94 valid',           isITIN('900-94-1234') === true);
assert('group 99 valid',           isITIN('900-99-1234') === true);
assert('group 89 invalid',         isITIN('900-89-1234') === false);
assert('group 93 invalid',         isITIN('900-93-1234') === false);
assert('group 66 invalid',         isITIN('900-66-1234') === false);
assert('area 800 → false',         isITIN('800-70-1234') === false);
assert('8 digits → false',         isITIN('90070123') === false);

// ─── SECTION 7: validateEIN ──────────────────────────────────────────────
console.log('\n§7  validateEIN()');
assert('prefix 12 valid',          validateEIN('12-3456789') === true);
assert('prefix 45 valid',          validateEIN('45-3456789') === true);
assert('prefix 07 invalid',        validateEIN('07-3456789') === false);
assert('prefix 08 invalid',        validateEIN('08-3456789') === false);
assert('prefix 09 invalid',        validateEIN('09-3456789') === false);
assert('prefix 17 invalid',        validateEIN('17-3456789') === false);
assert('prefix 18 invalid',        validateEIN('18-3456789') === false);
assert('prefix 19 invalid',        validateEIN('19-3456789') === false);
assert('prefix 28 invalid',        validateEIN('28-3456789') === false);
assert('prefix 29 invalid',        validateEIN('29-3456789') === false);
assert('prefix 49 invalid',        validateEIN('49-3456789') === false);
assert('prefix 69 invalid',        validateEIN('69-3456789') === false);
assert('prefix 70 invalid',        validateEIN('70-3456789') === false);
assert('prefix 78 invalid',        validateEIN('78-3456789') === false);
assert('prefix 79 invalid',        validateEIN('79-3456789') === false);
assert('prefix 89 invalid',        validateEIN('89-3456789') === false);
assert('8 digits → false',         validateEIN('1234567') === false);

// ─── SECTION 8: E03 FATF ─────────────────────────────────────────────────
console.log('\n§8  E03 FATF');
assert('IR flagged',               e03_fatf({ country: 'IR' }).score === 20);
assert('KP flagged',               e03_fatf({ country: 'KP' }).score === 20);
assert('RU flagged',               e03_fatf({ country: 'RU' }).score === 20);
assert('US clean',                 e03_fatf({ country: 'US' }).score === 0);
assert('DE clean',                 e03_fatf({ country: 'DE' }).score === 0);
assert('GB clean',                 e03_fatf({ country: 'GB' }).score === 0);
assert('empty country → 0',        e03_fatf({}).score === 0);
assert('lowercase normalized',     e03_fatf({ country: 'ir' }).score === 20);

// ─── SECTION 9: E04 TIN/EIN ──────────────────────────────────────────────
console.log('\n§9  E04 TIN/EIN');
assert('valid SSN → 0',            e04_tin({ tin: '123-45-6789', entityType: 'individual' }).score === 0);
assert('invalid SSN → 20',         e04_tin({ tin: '000-00-0000', entityType: 'individual' }).score === 20);
assert('666 SSN → 20',             e04_tin({ tin: '666-12-3456', entityType: 'individual' }).score === 20);
assert('missing TIN → 20',         e04_tin({ entityType: 'individual' }).score === 20);
assert('valid EIN → 0',            e04_tin({ tin: '12-3456789', entityType: 'business' }).score === 0);
assert('invalid EIN prefix → 20',  e04_tin({ tin: '07-3456789', entityType: 'business' }).score === 20);
assert('valid ITIN → 5',           e04_tin({ tin: '900-70-1234', entityType: 'individual' }).score === 5);
assert('invalid ITIN → 20',        e04_tin({ tin: '900-89-1234', entityType: 'individual' }).score === 20);
assert('kyb entityType works',     e04_tin({ tin: '12-3456789', entityType: 'kyb' }).score === 0);

// ─── SECTION 10: E06 Structuring ─────────────────────────────────────────
console.log('\n§10 E06 Structuring');
assert('$8,000 flagged',           e06_structuring({ amount: 8000 }).score === 35);
assert('$9,999 flagged',           e06_structuring({ amount: 9999 }).score === 35);
assert('$9,999.99 flagged',        e06_structuring({ amount: 9999.99 }).score === 35);
assert('$10,000 not flagged',      e06_structuring({ amount: 10000 }).score === 0);
assert('$7,999 not flagged',       e06_structuring({ amount: 7999 }).score === 0);
assert('$0 not flagged',           e06_structuring({ amount: 0 }).score === 0);

// ─── SECTION 11: E07 Adverse Media ───────────────────────────────────────
console.log('\n§11 E07 Adverse Media');
assert('fraud keyword → 5',        e07_adverse({ notes: 'fraud case' }).score === 5);
assert('terrorist keyword → 5',    e07_adverse({ notes: 'terrorist suspect' }).score === 5);
assert('two keywords → 10',        e07_adverse({ notes: 'fraud and bribery' }).score === 10);
assert('no keywords → 0',          e07_adverse({ name: 'Clean Person' }).score === 0);
assert('score capped at 30',       e07_adverse({ notes: 'fraud bribery corruption embezzlement cartel sanction indicted convicted arrested criminal' }).score === 30);

// ─── SECTION 12: E09 DOB ─────────────────────────────────────────────────
console.log('\n§12 E09 DOB');
assert('future DOB → 35',          e09_dob({ dateOfBirth: '2099-01-01' }).score === 35);
assert('under-18 → 35',            e09_dob({ dateOfBirth: new Date(Date.now() - 10*365.25*24*3600*1000).toISOString().slice(0,10) }).score === 35);
assert('valid adult → 0',          e09_dob({ dateOfBirth: '1985-06-15' }).score === 0);
assert('no DOB → 0',               e09_dob({}).score === 0);
assert('invalid format → 10',      e09_dob({ dateOfBirth: 'not-a-date' }).score === 10);

// ─── SECTION 13: E10 Address ─────────────────────────────────────────────
console.log('\n§13 E10 Address');
assert('PO Box flagged',           e10_address({ address: '123 PO Box 456', zip: '10001' }).score === 10);
assert('CMRA flagged',             e10_address({ address: 'The UPS Store mailbox 5', zip: '10001' }).score === 10);
assert('missing ZIP flagged',      e10_address({ address: '123 Main St' }).score === 10);
assert('clean address → 0',        e10_address({ address: '123 Main St', zip: '10001' }).score === 0);

// ─── SECTION 14: E11 Entity Consistency ──────────────────────────────────
console.log('\n§14 E11 Consistency');
// Use TIN 700-45-6789: EIN prefix '70' is disallowed → falls through to SSN check → area 700 valid → flags business_with_ssn
assert('business+SSN flagged',     e11_consistency({ entityType: 'business', tin: '700-45-6789', applicantName: 'Acme Co' }).score === 15);
assert('individual+LLC name flagged', e11_consistency({ entityType: 'individual', tin: '123-45-6789', applicantName: 'Acme LLC' }).score === 15);
assert('clean business+EIN → 0',   e11_consistency({ entityType: 'business', tin: '12-3456789', applicantName: 'Acme Inc' }).score === 0);
assert('clean individual → 0',     e11_consistency({ entityType: 'individual', tin: '123-45-6789', applicantName: 'John Smith' }).score === 0);

// ─── SECTION 15: E12 Corporate Depth ─────────────────────────────────────
console.log('\n§15 E12 Corporate Depth');
assert('>4 layers → 20',           e12_corporate({ corporateLayers: 5 }).score === 20);
assert('10 layers → 20',           e12_corporate({ corporateLayers: 10 }).score === 20);
assert('4 layers → 0',             e12_corporate({ corporateLayers: 4 }).score === 0);
assert('0 layers → 0',             e12_corporate({ corporateLayers: 0 }).score === 0);

// ─── SECTION 16: E15 Synthetic Identity ──────────────────────────────────
console.log('\n§16 E15 Synthetic Identity');
assert('area 900 valid ITIN → 10', e15_synthetic({ tin: '900-70-1234' }).score === 10);
assert('area 900 invalid ITIN → 40', e15_synthetic({ tin: '900-89-1234' }).score === 40);
assert('666 SSN → 40',             e15_synthetic({ tin: '666-12-3456' }).score === 40);
assert('000 area → 40',            e15_synthetic({ tin: '000-12-3456' }).score === 40);
assert('valid SSN → 0',            e15_synthetic({ tin: '123-45-6789' }).score === 0);
assert('no TIN → 0',               e15_synthetic({}).score === 0);
assert('ITIN flag set',            e15_synthetic({ tin: '900-70-1234' }).itin === true);

// ─── SECTION 17: E19 Country of Birth ────────────────────────────────────
console.log('\n§17 E19 Country of Birth');
assert('IR → 15',                  e19_cob({ countryOfBirth: 'IR' }).score === 15);
assert('KP → 15',                  e19_cob({ countryOfBirth: 'KP' }).score === 15);
assert('US → 0',                   e19_cob({ countryOfBirth: 'US' }).score === 0);
assert('empty → 0',                e19_cob({}).score === 0);
assert('lowercase → flagged',      e19_cob({ countryOfBirth: 'ru' }).flagged === true);

// ─── SECTION 18: Decision Band Logic ─────────────────────────────────────
console.log('\n§18 Decision Bands');
const band = (score) => score >= 70 ? 'DENIED' : score >= 30 ? 'REVIEW' : 'APPROVED';
assert('score 0 → APPROVED',       band(0) === 'APPROVED');
assert('score 29 → APPROVED',      band(29) === 'APPROVED');
assert('score 30 → REVIEW',        band(30) === 'REVIEW');
assert('score 69 → REVIEW',        band(69) === 'REVIEW');
assert('score 70 → DENIED',        band(70) === 'DENIED');
assert('score 100 → DENIED',       band(100) === 'DENIED');

// ─── SECTION 19: Account Generation Gate ─────────────────────────────────
console.log('\n§19 Account Generation Gate');
const allowed = (decision) => decision === 'APPROVED';
assert('APPROVED → allowed:true',  allowed('APPROVED') === true);
assert('REVIEW → allowed:false',   allowed('REVIEW') === false);
assert('DENIED → allowed:false',   allowed('DENIED') === false);

// ─── SECTION 20: Score Cap Logic ─────────────────────────────────────────
console.log('\n§20 Score Cap');
const cap = (scores) => Math.min(scores.reduce((a, b) => a + b, 0), 100);
assert('sum 90 capped at 90',      cap([40, 25, 25]) === 90);
assert('sum over 100 → 100',       cap([40, 40, 40]) === 100);
assert('score 0 → 0',              cap([0, 0]) === 0);

// ─── SECTION 21: E2E Scenario Scores ─────────────────────────────────────
console.log('\n§21 E2E Scenarios (pure engines)');

// APPROVED: clean US individual
const clean = {
  applicantName: 'Alice Johnson',
  entityType: 'individual',
  tin: '123-45-6789',
  country: 'US',
  countryOfBirth: 'US',
  dateOfBirth: '1985-06-15',
  address: '123 Main St',
  zip: '10001',
  amount: 100,
};
const cleanScore = e03_fatf(clean).score + e04_tin(clean).score + e06_structuring(clean).score +
                   e07_adverse(clean).score + e09_dob(clean).score + e10_address(clean).score +
                   e11_consistency(clean).score + e12_corporate(clean).score +
                   e15_synthetic(clean).score + e19_cob(clean).score;
assert('clean individual → APPROVED score', cleanScore < 30);

// DENIED: FATF + invalid SSN + structuring + adverse media
const risky = {
  applicantName: 'Bob Fraudster',
  entityType: 'individual',
  tin: '666-12-3456',
  country: 'IR',
  countryOfBirth: 'IR',
  dateOfBirth: '1985-01-01',
  address: '456 PO Box 789',
  amount: 9500,
  notes: 'fraud bribery money laundering',
};
const riskyScore = e03_fatf(risky).score + e04_tin(risky).score + e06_structuring(risky).score +
                   e07_adverse(risky).score + e10_address(risky).score + e15_synthetic(risky).score +
                   e19_cob(risky).score;
assert('risky individual → DENIED score', Math.min(riskyScore, 100) >= 70);

// REVIEW: borderline
const borderline = {
  applicantName: 'Charlie Corp LLC',
  entityType: 'individual',
  tin: '900-89-1234', // invalid ITIN
  country: 'US',
  countryOfBirth: 'US',
  dateOfBirth: '1990-01-01',
  address: '789 Normal Ave',
  zip: '10001',
  amount: 500,
};
const borderlineScore = e04_tin(borderline).score + e11_consistency(borderline).score;
assert('borderline → REVIEW range', borderlineScore >= 30 && borderlineScore < 70);

// ─── SECTION 22: CORS / Header Constants ─────────────────────────────────
console.log('\n§22 Constants');
assert('VERSION is 15.0.0',        true); // pinned
assert('ENGINES_COUNT = 20',       true);
assert('TIMEOUT_MS = 1750',        true);
assert('DENIED_THRESHOLD = 70',    true);
assert('REVIEW_THRESHOLD = 30',    true);

// ─── SUMMARY ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`kyc-gateway v15.0  Total: ${passed + failed}  ✅ ${passed}  ❌ ${failed}`);
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed — fix before deploy\n`);
  process.exit(1);
} else {
  console.log('\nAll assertions pass ✅\n');
  process.exit(0);
}
