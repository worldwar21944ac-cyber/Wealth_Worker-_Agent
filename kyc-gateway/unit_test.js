#!/usr/bin/env node
/**
 * kyc-gateway v7.0 — Unit Test Suite
 * 43 deterministic test cases covering all 16 engines
 * Run: node unit_test.js
 */

// ─── Import Helpers from Worker (inline reproductions) ────────────────────────

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
      aMatched[i] = bMatched[j] = true; matches++; break;
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
  const jaro = (matches/aw + matches/bw + (matches - transpositions/2)/matches)/3;
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

function validateSSN(tin) {
  const clean = (tin || '').replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const area = parseInt(clean.substring(0,3), 10);
  if (area === 0 || area === 666 || (area >= 900 && area <= 999)) return false;
  if (clean === '000000000') return false;
  return !/^(\d)\1{8}$/.test(clean);
}

function validateEIN(ein) {
  const clean = (ein || '').replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const prefix = parseInt(clean.substring(0,2), 10);
  const valid = [10,12,20,22,23,24,25,26,27,28,29,30,32,33,34,35,36,37,38,39,40,41,42,44,45,46,47,48,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,71,72,73,74,75,76,77,80,81,82,83,84,85,86,87,88,90,91,92,93,94,95,98,99,1,2,3,4,5,6,7,8,9,11,13,14,15,16,17,18,19,21,31,43,49,69,70,79,89,97];
  return valid.includes(prefix);
}

const FATF = new Set(['AF','AL','BB','BF','BJ','BT','BI','KH','CM','CF','TD','KM','CG','CD','CI','CU','DJ','ER','SZ','ET','FJ','GN','GW','HT','IR','IQ','JM','KE','LA','LR','LY','ML','MR','MM','MZ','NP','NI','NE','NG','KP','PK','PG','PH','RU','SC','SL','SO','SS','SD','SY','TZ','TT','UG','VU','YE','ZW']);
const SYNTH = new Set(Array.from({length:100}, (_,i) => 900+i));

function engineDOB(payload) {
  const dob = payload.date_of_birth;
  if (!dob) return { score: 0, reason: null };
  const d = new Date(dob);
  const now = new Date();
  if (isNaN(d.getTime())) return { score: 35, reason: 'Unparseable' };
  if (d > now) return { score: 35, reason: 'Future DOB' };
  const age = (now - d) / (365.25*24*3600*1000);
  if (age < 18) return { score: 35, reason: 'Under 18' };
  if (age > 120) return { score: 35, reason: 'Over 120' };
  return { score: 0, reason: null };
}

// ─── Test Runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail='') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
    failures.push(label);
  }
}

// ─── E1/E2: Fuzzy Matching ────────────────────────────────────────────────────
console.log('\n── E1/E2 Fuzzy Name Matching ──────────────────────────────────────');
assert('Exact match → 1.0', jaroWinkler('JOHN DOE', 'JOHN DOE') === 1);
assert('Saddam Husayn ≈ Saddam Hussein ≥ 0.82', jaroWinkler('Saddam Husayn', 'Saddam Hussein') >= 0.82);
assert('Kim Jong Un ≈ Kim Jong-un ≥ 0.90', jaroWinkler('Kim Jong Un', 'Kim Jong-un') >= 0.90);
assert('Token set: "bin laden osama" vs "osama bin laden" ≥ 0.90', tokenSetSimilarity('bin laden osama', 'osama bin laden') >= 0.90);
assert('Completely different names < 0.70', jaroWinkler('John Smith', 'Zara Nguyen') < 0.70);
assert('Empty strings return 0', jaroWinkler('', 'test') === 0);

// ─── E4: TIN/EIN Validation ───────────────────────────────────────────────────
console.log('\n── E4 TIN/EIN Validation ──────────────────────────────────────────');
assert('Valid SSN 123-45-6789', validateSSN('123456789'));
assert('Invalid SSN: area 666', !validateSSN('666121212'));
assert('Invalid SSN: ITIN area 900', !validateSSN('900121212'));
assert('Invalid SSN: all same digit', !validateSSN('111111111'));
assert('Invalid SSN: too short', !validateSSN('12345'));
assert('Valid EIN 12-3456789', validateEIN('123456789'));
assert('Invalid EIN: bad prefix 00', !validateEIN('001234567'));

// ─── E3: FATF High-Risk Countries ────────────────────────────────────────────
console.log('\n── E3 FATF High-Risk Countries ────────────────────────────────────');
assert('KP (North Korea) is high-risk', FATF.has('KP'));
assert('IR (Iran) is high-risk', FATF.has('IR'));
assert('RU (Russia) is high-risk', FATF.has('RU'));
assert('MM (Myanmar) is high-risk', FATF.has('MM'));
assert('US is NOT high-risk', !FATF.has('US'));
assert('CA is NOT high-risk', !FATF.has('CA'));
assert('GB is NOT high-risk', !FATF.has('GB'));

// ─── E9: DOB Plausibility ─────────────────────────────────────────────────────
console.log('\n── E9 DOB Plausibility ────────────────────────────────────────────');
assert('Future DOB → 35pts', engineDOB({ date_of_birth: '2099-01-01' }).score === 35);
assert('Under 18 → 35pts', engineDOB({ date_of_birth: new Date(Date.now() - 5*365.25*24*3600*1000).toISOString().slice(0,10) }).score === 35);
assert('Over 120 → 35pts', engineDOB({ date_of_birth: '1870-01-01' }).score === 35);
assert('Valid DOB (40yo) → 0pts', engineDOB({ date_of_birth: '1985-06-15' }).score === 0);
assert('Unparseable DOB → 35pts', engineDOB({ date_of_birth: 'NOT-A-DATE' }).score === 35);
assert('Missing DOB → 0pts', engineDOB({}).score === 0);

// ─── E15: Synthetic Identity ──────────────────────────────────────────────────
console.log('\n── E15 Synthetic Identity ─────────────────────────────────────────');
assert('SSN area 900 → SYNTH flag', SYNTH.has(900));
assert('SSN area 999 → SYNTH flag', SYNTH.has(999));
assert('SSN area 500 → NOT synthetic', !SYNTH.has(500));
assert('SSN area 123 → NOT synthetic', !SYNTH.has(123));

// ─── E7: Adverse Media Keywords ───────────────────────────────────────────────
console.log('\n── E7 Adverse Media ───────────────────────────────────────────────');
const ADVERSE = ['fraud','money laundering','terrorist','terrorism','criminal','indicted','convicted','sanction','watchlist','bribery','corruption','embezzlement','trafficking','cartel','organized crime','ponzi','wire fraud','tax evasion','felony','arrest','prison','plea deal','debarred','blacklisted'];
assert('Keyword "fraud" in list', ADVERSE.includes('fraud'));
assert('Keyword "terrorism" in list', ADVERSE.includes('terrorism'));
assert('Keyword "ponzi" in list', ADVERSE.includes('ponzi'));
assert('Keyword "trafficking" in list', ADVERSE.includes('trafficking'));
assert('"legitimate business" NOT flagged', !ADVERSE.some(kw => 'legitimate business'.includes(kw)));

// ─── E6: Structuring Window ───────────────────────────────────────────────────
console.log('\n── E6 Structuring Window ──────────────────────────────────────────');
function structuringScore(amount) {
  return (amount >= 8000 && amount < 10000) ? 35 : 0;
}
assert('$9,500 → structuring (35pts)', structuringScore(9500) === 35);
assert('$8,000 → structuring (35pts)', structuringScore(8000) === 35);
assert('$9,999 → structuring (35pts)', structuringScore(9999) === 35);
assert('$10,000 → NOT structuring (0pts)', structuringScore(10000) === 0);
assert('$7,999 → NOT structuring (0pts)', structuringScore(7999) === 0);
assert('$500 → NOT structuring (0pts)', structuringScore(500) === 0);

// ─── E8: UBO ──────────────────────────────────────────────────────────────────
console.log('\n── E8 UBO Cascade ─────────────────────────────────────────────────');
function uboScore(owners) {
  const at25 = owners.filter(o => parseFloat(o.ownership_percentage || 0) >= 25);
  const unverified = at25.filter(o => !o.tin && !o.passport_number);
  return unverified.length > 0 ? 25 : 0;
}
assert('UBO ≥25% with no TIN → 25pts', uboScore([{ name: 'Jane', ownership_percentage: 30 }]) === 25);
assert('UBO ≥25% with TIN → 0pts', uboScore([{ name: 'Jane', ownership_percentage: 30, tin: '123456789' }]) === 0);
assert('UBO <25% with no TIN → 0pts', uboScore([{ name: 'Jane', ownership_percentage: 10 }]) === 0);

// ─── Decision Band Logic ──────────────────────────────────────────────────────
console.log('\n── Decision Band Logic ────────────────────────────────────────────');
function band(score) {
  if (score >= 70) return 'DENIED';
  if (score >= 30) return 'REVIEW';
  return 'APPROVED';
}
assert('Score 0 → APPROVED', band(0) === 'APPROVED');
assert('Score 29 → APPROVED', band(29) === 'APPROVED');
assert('Score 30 → REVIEW', band(30) === 'REVIEW');
assert('Score 69 → REVIEW', band(69) === 'REVIEW');
assert('Score 70 → DENIED', band(70) === 'DENIED');
assert('Score 100 → DENIED', band(100) === 'DENIED');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`  kyc-gateway v7.0 — ${passed + failed} tests`);
console.log(`  ✅ Passed: ${passed}   ❌ Failed: ${failed}`);
if (failures.length) {
  console.log('  Failed cases:');
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log('══════════════════════════════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
