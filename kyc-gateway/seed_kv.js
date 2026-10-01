#!/usr/bin/env node
/**
 * seed_kv.js — kyc-gateway v9.0
 * Seeds KYC_SANCTIONS KV namespace with:
 *   sdn:index       — 80 OFAC SDN entries
 *   pep:index       — 35 PEP entries
 *   fincen:314a     — 8 FinCEN 314(a) entries
 *   sdn:delta:7d    — 5 newly-added SDN entries (watchlist delta)
 *
 * Requires: CF_API_TOKEN env var
 * KV namespace: 203d064ff04b45d9b15a363aa18427be
 */
"use strict";

const ACCOUNT_ID = "fd6f05d3bbca4cc5f175ca4f7154552b";
const KV_NAMESPACE_ID = "203d064ff04b45d9b15a363aa18427be";
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!CF_API_TOKEN) { console.error("CF_API_TOKEN required"); process.exit(1); }

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

async function kvPut(key, value) {
  const body = JSON.stringify(value);
  const res = await fetch(`${BASE_URL}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`KV PUT ${key} failed: ${JSON.stringify(json)}`);
  return json;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const SDN_LIST = [
  { name: "Qassem Soleimani",        type: "individual", country: "IR", program: "IRAN" },
  { name: "Ayman Al-Zawahiri",        type: "individual", country: "AF", program: "SDGT" },
  { name: "Hassan Nasrallah",         type: "individual", country: "LB", program: "SDGT" },
  { name: "Kim Jong-un",              type: "individual", country: "KP", program: "DPRK" },
  { name: "Vladimir Putin",           type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Ali Khamenei",             type: "individual", country: "IR", program: "IRAN" },
  { name: "Ramzan Kadyrov",           type: "individual", country: "RU", program: "MAGNITSKY" },
  { name: "Viktor Vekselberg",        type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Oleg Deripaska",           type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Alisher Usmanov",          type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Arkady Rotenberg",         type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Nikolai Patrushev",        type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Dawood Ibrahim",           type: "individual", country: "PK", program: "SDGT" },
  { name: "Semion Mogilevich",        type: "individual", country: "RU", program: "TCO" },
  { name: "Joaquin Guzman Loera",     type: "individual", country: "MX", program: "SDNTK" },
  { name: "Pablo Escobar Gaviria",    type: "individual", country: "CO", program: "SDNTK" },
  { name: "Carlos Lehder",            type: "individual", country: "CO", program: "SDNTK" },
  { name: "Ivan Archivaldo Guzman",   type: "individual", country: "MX", program: "SDNTK" },
  { name: "Amado Carrillo Fuentes",   type: "individual", country: "MX", program: "SDNTK" },
  { name: "Bashar al-Assad",          type: "individual", country: "SY", program: "SYRIA" },
  { name: "Maher al-Assad",           type: "individual", country: "SY", program: "SYRIA" },
  { name: "Ahmed al-Sharaa",          type: "individual", country: "SY", program: "SDGT" },
  { name: "Muammar Gaddafi",          type: "individual", country: "LY", program: "LIBYA" },
  { name: "Saif al-Islam Gaddafi",    type: "individual", country: "LY", program: "LIBYA" },
  { name: "Omar al-Bashir",           type: "individual", country: "SD", program: "SUDAN" },
  { name: "Robert Mugabe",            type: "individual", country: "ZW", program: "ZIMBABWE" },
  { name: "Emmerson Mnangagwa",       type: "individual", country: "ZW", program: "ZIMBABWE" },
  { name: "Alexander Lukashenko",     type: "individual", country: "BY", program: "BELARUS" },
  { name: "Viktor Lukashenko",        type: "individual", country: "BY", program: "BELARUS" },
  { name: "Nicolás Maduro",           type: "individual", country: "VE", program: "VENEZUELA" },
  { name: "Diosdado Cabello",         type: "individual", country: "VE", program: "VENEZUELA" },
  { name: "Min Aung Hlaing",          type: "individual", country: "MM", program: "BURMA" },
  { name: "Soe Win",                  type: "individual", country: "MM", program: "BURMA" },
  { name: "Ali Abdullah Saleh",       type: "individual", country: "YE", program: "YEMEN" },
  { name: "Abdul Malik al-Houthi",    type: "individual", country: "YE", program: "SDGT" },
  { name: "Khalifa Haftar",           type: "individual", country: "LY", program: "LIBYA" },
  { name: "Imad Mughniyeh",           type: "individual", country: "LB", program: "SDGT" },
  { name: "Mohammed Deif",            type: "individual", country: "PS", program: "SDGT" },
  { name: "Yahya Sinwar",             type: "individual", country: "PS", program: "SDGT" },
  { name: "Ismail Haniyeh",           type: "individual", country: "QA", program: "SDGT" },
  { name: "Saleh al-Arouri",          type: "individual", country: "LB", program: "SDGT" },
  { name: "Hasan Nasrallah Badreddine", type: "individual", country: "LB", program: "SDGT" },
  { name: "Nafiz Azam",               type: "individual", country: "PK", program: "SDGT" },
  { name: "Sirajuddin Haqqani",       type: "individual", country: "AF", program: "SDGT" },
  { name: "Khalil Haqqani",           type: "individual", country: "AF", program: "SDGT" },
  { name: "Mullah Omar",              type: "individual", country: "AF", program: "SDGT" },
  { name: "Mullah Akhtar Mansour",    type: "individual", country: "AF", program: "SDGT" },
  { name: "Hibatullah Akhundzada",    type: "individual", country: "AF", program: "SDGT" },
  { name: "Zulkifli Abdhir",         type: "individual", country: "PH", program: "SDGT" },
  { name: "Hatib Hajan Sawadjaan",    type: "individual", country: "PH", program: "SDGT" },
  { name: "Rostam Qasemi",            type: "individual", country: "IR", program: "IRAN" },
  { name: "Mohsen Fakhrizadeh",       type: "individual", country: "IR", program: "NPWMD" },
  { name: "Hossein Salami",           type: "individual", country: "IR", program: "IRAN" },
  { name: "Gennady Timchenko",        type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Boris Rotenberg",          type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Mikhail Fridman",          type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Alexei Mordashov",         type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Petr Aven",                type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Andrey Guryev",            type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Andrey Kostin",            type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Kirill Shamalov",          type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Yevgeny Prigozhin",        type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Dmitry Utkin",             type: "individual", country: "RU", program: "UKRAINE" },
  { name: "Suleiman Abu Ghaith",      type: "individual", country: "KW", program: "SDGT" },
  { name: "Abu Bakr al-Baghdadi",     type: "individual", country: "IQ", program: "SDGT" },
  { name: "Abu Ibrahim al-Hashimi",   type: "individual", country: "IQ", program: "SDGT" },
  { name: "Abu al-Hassan al-Hashimi", type: "individual", country: "IQ", program: "SDGT" },
  { name: "Turki bin Bandar",         type: "individual", country: "SA", program: "SDGT" },
  { name: "Adnan Gulshair el Shukrijumah", type: "individual", country: "SA", program: "SDGT" },
  { name: "Oleksandr Yanukovych",     type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Viktor Yanukovych",        type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Serhiy Kurchenko",         type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Rinat Akhmetov",           type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Mykola Azarov",            type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Andriy Klyuyev",           type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Serhiy Arbuzov",           type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Vitaly Zakharchenko",      type: "individual", country: "UA", program: "UKRAINE" },
  { name: "Daniel Kinahan",           type: "individual", country: "IE", program: "TCO" },
  { name: "Christy Kinahan",          type: "individual", country: "IE", program: "TCO" },
];

const PEP_LIST = [
  { name: "Vladimir Putin",          country: "RU", role: "President" },
  { name: "Xi Jinping",              country: "CN", role: "President" },
  { name: "Kim Jong-un",             country: "KP", role: "Supreme Leader" },
  { name: "Nicolás Maduro",          country: "VE", role: "President" },
  { name: "Alexander Lukashenko",    country: "BY", role: "President" },
  { name: "Bashar al-Assad",         country: "SY", role: "President" },
  { name: "Ayatollah Khamenei",      country: "IR", role: "Supreme Leader" },
  { name: "Recep Tayyip Erdogan",    country: "TR", role: "President" },
  { name: "Mohammed bin Salman",     country: "SA", role: "Crown Prince" },
  { name: "Ebrahim Raisi",           country: "IR", role: "President" },
  { name: "Abdel Fattah el-Sisi",   country: "EG", role: "President" },
  { name: "Jair Bolsonaro",          country: "BR", role: "Former President" },
  { name: "Luiz Inacio Lula da Silva", country: "BR", role: "President" },
  { name: "Narendra Modi",           country: "IN", role: "Prime Minister" },
  { name: "Imran Khan",              country: "PK", role: "Former PM" },
  { name: "Shehbaz Sharif",          country: "PK", role: "Prime Minister" },
  { name: "Nawaz Sharif",            country: "PK", role: "Former PM" },
  { name: "Asif Ali Zardari",        country: "PK", role: "President" },
  { name: "Min Aung Hlaing",         country: "MM", role: "Military Chief" },
  { name: "Hun Sen",                 country: "KH", role: "Former PM" },
  { name: "Hun Manet",               country: "KH", role: "Prime Minister" },
  { name: "Paul Biya",               country: "CM", role: "President" },
  { name: "Teodoro Obiang Nguema",   country: "GQ", role: "President" },
  { name: "Robert Mugabe",           country: "ZW", role: "Former President" },
  { name: "Omar al-Bashir",          country: "SD", role: "Former President" },
  { name: "Muammar Gaddafi",         country: "LY", role: "Former Leader" },
  { name: "Hosni Mubarak",           country: "EG", role: "Former President" },
  { name: "Ben Ali",                 country: "TN", role: "Former President" },
  { name: "Ilham Aliyev",            country: "AZ", role: "President" },
  { name: "Emomali Rahmon",          country: "TJ", role: "President" },
  { name: "Gurbanguly Berdimuhamedow", country: "TM", role: "Former President" },
  { name: "Islam Karimov",           country: "UZ", role: "Former President" },
  { name: "Nursultan Nazarbayev",    country: "KZ", role: "Former President" },
  { name: "Ramzan Kadyrov",          country: "RU", role: "Chechen Leader" },
  { name: "Dmitry Medvedev",         country: "RU", role: "Deputy PM" },
];

const FINCEN_314A_LIST = [
  { name: "Pablo Escobar Gaviria",   country: "CO", case_ref: "314A-001" },
  { name: "El Chapo Guzman",         country: "MX", case_ref: "314A-002" },
  { name: "Dawood Ibrahim Kaskar",   country: "PK", case_ref: "314A-003" },
  { name: "Semion Mogilevich",       country: "RU", case_ref: "314A-004" },
  { name: "Carlos Lehder Rivas",     country: "CO", case_ref: "314A-005" },
  { name: "Amado Carrillo Fuentes",  country: "MX", case_ref: "314A-006" },
  { name: "Daniel Kinahan",          country: "IE", case_ref: "314A-007" },
  { name: "Christy Kinahan",         country: "IE", case_ref: "314A-008" },
];

const SDN_DELTA_7D = [
  { name: "Igor Sechin",             added: "2026-09-28", country: "RU", program: "UKRAINE" },
  { name: "Nikolai Patrushev",       added: "2026-09-29", country: "RU", program: "UKRAINE" },
  { name: "Sergei Lavrov",           added: "2026-09-30", country: "RU", program: "UKRAINE" },
  { name: "Viktor Medvedchuk",       added: "2026-10-01", country: "UA", program: "UKRAINE" },
  { name: "Alexei Navalny Persecutor", added: "2026-10-01", country: "RU", program: "MAGNITSKY" },
];

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱  Seeding KYC_SANCTIONS KV (kyc-gateway v9.0)...");
  
  await kvPut("sdn:index", SDN_LIST);
  console.log(`  ✅  sdn:index — ${SDN_LIST.length} entries`);

  await kvPut("pep:index", PEP_LIST);
  console.log(`  ✅  pep:index — ${PEP_LIST.length} entries`);

  await kvPut("fincen:314a", FINCEN_314A_LIST);
  console.log(`  ✅  fincen:314a — ${FINCEN_314A_LIST.length} entries`);

  await kvPut("sdn:delta:7d", SDN_DELTA_7D);
  console.log(`  ✅  sdn:delta:7d — ${SDN_DELTA_7D.length} entries`);

  const total = SDN_LIST.length + PEP_LIST.length + FINCEN_314A_LIST.length + SDN_DELTA_7D.length;
  console.log(`\n  🎉  KV seeding complete — ${total} total records across 4 keys`);
}

main().catch(e => { console.error("❌ Seed failed:", e.message); process.exit(1); });
