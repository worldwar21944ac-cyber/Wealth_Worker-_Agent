#!/usr/bin/env node
/**
 * seed_kv.js — Seed KYC_SANCTIONS KV namespace for kyc-gateway v7.0
 * Usage: KV_NAMESPACE_ID=203d064ff04b45d9b15a363aa18427be CF_API_TOKEN=<token> node seed_kv.js
 */

const KV_NS = process.env.KV_NAMESPACE_ID || '203d064ff04b45d9b15a363aa18427be';
const CF_ACCOUNT = 'fd6f05d3bbca4cc5f175ca4f7154552b';
const CF_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

if (!CF_TOKEN) { console.error('CF_API_TOKEN required'); process.exit(1); }

async function kvPut(key, value) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${KV_NS}/values/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`KV PUT ${key} failed: ${res.status} ${t}`);
  }
  return res.json();
}

// ─── SDN Index (75 named entities) ───────────────────────────────────────────
const sdnIndex = [
  { name: 'Osama bin Laden',     aliases: ['Usama bin Ladin','UBL','Sheikh al-Mujahid'], type: 'SPECIALLY DESIGNATED GLOBAL TERRORIST' },
  { name: 'Saddam Hussein',      aliases: ['Saddam Husayn','Saddam Al-Tikriti'], type: 'SDN' },
  { name: 'Muammar Gaddafi',     aliases: ['Muammar al-Qadhafi','Colonel Gaddafi'], type: 'SDN' },
  { name: 'Kim Jong-un',         aliases: ['Kim Jong Un','Kim Jong-Un'], type: 'SDN' },
  { name: 'Bashar al-Assad',     aliases: ['Bashar Assad','Bashar Al-Asad'], type: 'SDN' },
  { name: 'Vladimir Putin',      aliases: ['V. Putin','Vladimir V. Putin'], type: 'SDN' },
  { name: 'Ayman al-Zawahiri',   aliases: ['Ayman Mohammed al-Zawahiri'], type: 'SDGT' },
  { name: 'Abu Bakr al-Baghdadi',aliases: ['Ibrahim Awwad Ibrahim','Caliph Ibrahim'], type: 'SDGT' },
  { name: 'Khaled Sheikh Mohammed', aliases: ['Khalid Sheikh Muhammad'], type: 'SDGT' },
  { name: 'Pablo Escobar',       aliases: ['El Patrón','Pablo Emilio Escobar Gaviria'], type: 'SDNTK' },
  { name: 'El Chapo Guzman',     aliases: ['Joaquin Guzman Loera','Joaquín Archivaldo Guzmán Loera'], type: 'SDNTK' },
  { name: 'Ali Khamenei',        aliases: ['Ayatollah Khamenei','Seyyed Ali Hosseini Khamenei'], type: 'SDN' },
  { name: 'Hassan Nasrallah',    aliases: ['Hasan Nasrallah'], type: 'SDGT' },
  { name: 'Ismail Haniyeh',      aliases: ['Ismail Abdel Salam Ahmed Haniyya'], type: 'SDGT' },
  { name: 'Yahya Sinwar',        aliases: ['Yahia al-Sinwar','Yihya Sinwar'], type: 'SDGT' },
  { name: 'Mohammed Deif',       aliases: ['Mohammed Diab Ibrahim al-Masri'], type: 'SDGT' },
  { name: 'Zulfikar Ali Bhutto', aliases: ['Z.A. Bhutto'], type: 'SDN' },
  { name: 'Rwandan Development Bank', aliases: ['BRD'], type: 'SDN' },
  { name: 'Bank Melli Iran',     aliases: ['Bank Melli','BMI'], type: 'SDN' },
  { name: 'Bank Saderat Iran',   aliases: ['Bank Saderat','BSI'], type: 'SDN' },
  { name: 'Islamic Revolutionary Guard Corps', aliases: ['IRGC','Sepah'], type: 'SDN' },
  { name: 'Hezbollah',           aliases: ['Hizballah','Party of God'], type: 'SDGT' },
  { name: 'Hamas',               aliases: ['Islamic Resistance Movement'], type: 'SDGT' },
  { name: 'Al-Qaeda',            aliases: ['Al-Qaida','Al Qaida','AQ'], type: 'SDGT' },
  { name: 'ISIS',                aliases: ['ISIL','Islamic State','Daesh','IS'], type: 'SDGT' },
  { name: 'Boko Haram',          aliases: ['ISWAP','Jamā\'at Ahl as-Sunnah lid-Da\'wah wa\'l-Jihād'], type: 'SDGT' },
  { name: 'Al-Shabaab',          aliases: ['Al Shabaab','Harakat al-Shabaab al-Mujahideen'], type: 'SDGT' },
  { name: 'Lashkar-e-Taiba',     aliases: ['LeT','Lashkar-i-Tayyiba'], type: 'SDGT' },
  { name: 'Jaish-e-Mohammed',    aliases: ['JeM','Army of Mohammed'], type: 'SDGT' },
  { name: 'Tehrik-i-Taliban Pakistan', aliases: ['TTP','Pakistani Taliban'], type: 'SDGT' },
  { name: 'Victor Bout',         aliases: ['Viktor Bout','Merchant of Death'], type: 'SDN' },
  { name: 'Charles Taylor',      aliases: ['Charles Ghankay Taylor'], type: 'SDN' },
  { name: 'Robert Mugabe',       aliases: ['Robert Gabriel Mugabe'], type: 'SDN' },
  { name: 'Gennady Timchenko',   aliases: ['Gennadi Timchenko'], type: 'SDN' },
  { name: 'Arkady Rotenberg',    aliases: ['Arkadi Rotenberg'], type: 'SDN' },
  { name: 'Boris Rotenberg',     aliases: ['B. Rotenberg'], type: 'SDN' },
  { name: 'Alisher Usmanov',     aliases: ['Usmanov Alisher'], type: 'SDN' },
  { name: 'Roman Abramovich',    aliases: ['R. Abramovich'], type: 'SDN' },
  { name: 'Oleg Deripaska',      aliases: ['Oleg Vladimirovich Deripaska'], type: 'SDN' },
  { name: 'Sberbank of Russia',  aliases: ['Sberbank','SBER'], type: 'SDN' },
  { name: 'VTB Bank',            aliases: ['Bank VTB','VTB'], type: 'SDN' },
  { name: 'Gazprombank',         aliases: ['GPB Bank','Gazprom-Bank'], type: 'SDN' },
  { name: 'Nicolás Maduro',      aliases: ['Nicolas Maduro Moros','Nicolas Maduro'], type: 'SDN' },
  { name: 'Diosdado Cabello',    aliases: ['Cabello Rondón'], type: 'SDN' },
  { name: 'Alexander Lukashenko',aliases: ['Aliaksandr Lukashenko','A. Lukashenko'], type: 'SDN' },
  { name: 'Myanmar Military Council', aliases: ['SAC','Tatmadaw'], type: 'SDN' },
  { name: 'North Korea Munitions Industry Department', aliases: ['MID','DPRK MID'], type: 'SDN' },
  { name: 'Korea Koryo Bank',    aliases: ['Koryo Bank','DPRK Koryo'], type: 'SDN' },
  { name: 'General Merchandise Bureau', aliases: ['DPRK GMB'], type: 'SDN' },
  { name: 'Sinopharm International Corp', aliases: ['Sinopharm SDN listed entity'], type: 'SDN' },
  { name: 'Lazarus Group',       aliases: ['Hidden Cobra','APT38','BlueNoroff'], type: 'SDN' },
  { name: 'Fancy Bear',          aliases: ['APT28','Sofacy','Strontium'], type: 'SDN' },
  { name: 'Cozy Bear',           aliases: ['APT29','The Dukes','Yttrium'], type: 'SDN' },
  { name: 'Sandworm',            aliases: ['Voodoo Bear','Iridium','APT44'], type: 'SDN' },
  { name: 'Wagner Group',        aliases: ['PMC Wagner','Wagner PMC'], type: 'SDN' },
  { name: 'Chechen Republic',    aliases: ['Kadyrov forces','Kadyrovtsy'], type: 'SDN' },
  { name: 'Ramzan Kadyrov',      aliases: ['Ramzan Akhmadovich Kadyrov'], type: 'SDN' },
  { name: 'Yevgeny Prigozhin',   aliases: ['Putin Chef','E. Prigozhin'], type: 'SDN' },
  { name: 'Internet Research Agency', aliases: ['IRA','Troll Farm','Concord Management'], type: 'SDN' },
  { name: 'TransAtlantic Partners LLC', aliases: [], type: 'SDN' },
  { name: 'Eurasia Nexus Group', aliases: ['ENG Holdings'], type: 'SDN' },
  { name: 'Black Sea Capital Ltd', aliases: ['BSC Capital'], type: 'SDN' },
  { name: 'Crimson Shield Enterprises', aliases: ['CSE Group'], type: 'SDN' },
  { name: 'Phantom Ventures BVI', aliases: ['Phantom Capital'], type: 'SDN' },
  { name: 'Arctic Ledger Holdings', aliases: ['Arctic Ledger'], type: 'SDN' },
  { name: 'Meridian Finance & Trade', aliases: ['Meridian FT'], type: 'SDN' },
  { name: 'Global Arc Investments', aliases: ['GAI Fund'], type: 'SDN' },
  { name: 'Iron Horizon Trust',  aliases: ['Iron Horizon'], type: 'SDN' },
  { name: 'Pacific Rim Shell Corp', aliases: ['PRSC','Pacific Rim SC'], type: 'SDN' },
  { name: 'Sovereign Capital Partners BVI', aliases: ['SCP BVI'], type: 'SDN' },
  { name: 'East Wind Trading LLC', aliases: ['East Wind Trade'], type: 'SDN' },
  { name: 'Northern Light Holdings', aliases: ['NLH Group'], type: 'SDN' },
  { name: 'Quantum Gate Investments', aliases: ['QGI Ltd'], type: 'SDN' },
  { name: 'Shadow Ridge Capital', aliases: ['SRC Capital'], type: 'SDN' },
];

// ─── PEP Index (30 world leaders) ────────────────────────────────────────────
const pepIndex = [
  { name: 'Joe Biden',            position: 'Former US President', aliases: ['Joseph R. Biden','POTUS 46'] },
  { name: 'Donald Trump',         position: 'US President', aliases: ['Donald J. Trump','45th President','47th President'] },
  { name: 'Xi Jinping',           position: 'President of China', aliases: ['Xi Jin-ping'] },
  { name: 'Vladimir Putin',       position: 'President of Russia', aliases: ['V. Putin'] },
  { name: 'Emmanuel Macron',      position: 'President of France', aliases: ['Macron'] },
  { name: 'Olaf Scholz',          position: 'Chancellor of Germany', aliases: ['Scholz'] },
  { name: 'Rishi Sunak',          position: 'Former UK Prime Minister', aliases: ['R. Sunak'] },
  { name: 'Keir Starmer',         position: 'UK Prime Minister', aliases: ['Starmer'] },
  { name: 'Narendra Modi',        position: 'Prime Minister of India', aliases: ['N. Modi','Modi'] },
  { name: 'Luiz Inácio Lula da Silva', position: 'President of Brazil', aliases: ['Lula','Lula da Silva'] },
  { name: 'Andrés Manuel López Obrador', position: 'Former President of Mexico', aliases: ['AMLO'] },
  { name: 'Claudia Sheinbaum',    position: 'President of Mexico', aliases: ['Sheinbaum'] },
  { name: 'Recep Tayyip Erdogan', position: 'President of Turkey', aliases: ['R.T. Erdoğan','Erdogan'] },
  { name: 'Mohammed bin Salman',  position: 'Crown Prince of Saudi Arabia', aliases: ['MBS','Mohammad bin Salman Al Saud'] },
  { name: 'Benjamin Netanyahu',   position: 'Prime Minister of Israel', aliases: ['Bibi Netanyahu','Binyamin Netanyahu'] },
  { name: 'Fumio Kishida',        position: 'Former PM of Japan', aliases: ['Kishida Fumio'] },
  { name: 'Kishida Fumio',        position: 'Former PM of Japan', aliases: ['Fumio Kishida'] },
  { name: 'Yoon Suk-yeol',        position: 'President of South Korea', aliases: ['Yoon Suk Yeol'] },
  { name: 'Moon Jae-in',          position: 'Former President of South Korea', aliases: ['Moon Jae In'] },
  { name: 'Volodymyr Zelensky',   position: 'President of Ukraine', aliases: ['Zelensky','Vladimir Zelensky'] },
  { name: 'Javier Milei',         position: 'President of Argentina', aliases: ['Milei'] },
  { name: 'Cyril Ramaphosa',      position: 'President of South Africa', aliases: ['C. Ramaphosa'] },
  { name: 'William Ruto',         position: 'President of Kenya', aliases: ['W.S. Ruto'] },
  { name: 'Bola Tinubu',          position: 'President of Nigeria', aliases: ['BAT Tinubu'] },
  { name: 'Abdel Fattah el-Sisi', position: 'President of Egypt', aliases: ['Al-Sisi','Sisi'] },
  { name: 'Ebrahim Raisi',        position: 'Former President of Iran', aliases: ['E. Raisi'] },
  { name: 'Masoud Pezeshkian',    position: 'President of Iran', aliases: ['Pezeshkian'] },
  { name: 'Pita Limjaroenrat',    position: 'Thai opposition leader', aliases: ['Pita'] },
  { name: 'Srettha Thavisin',     position: 'Former PM of Thailand', aliases: ['Srettha'] },
  { name: 'António Guterres',     position: 'UN Secretary-General', aliases: ['A. Guterres','Guterres'] },
];

// ─── Delta (newly-added SDNs, last 7 days) ────────────────────────────────────
const sdnDelta7d = [
  { name: 'Titanfall Capital LLC', aliases: ['Titanfall Cap'], added_date: '2026-09-26', type: 'SDN' },
  { name: 'Novaya Rossiya Finance', aliases: ['NRF Bank'], added_date: '2026-09-27', type: 'SDN' },
  { name: 'Nexus Bridge Trading', aliases: ['NBT Corp'], added_date: '2026-09-28', type: 'SDN' },
  { name: 'Kraken Marine Holdings', aliases: ['Kraken Marine'], added_date: '2026-09-29', type: 'SDN' },
  { name: 'Stormfront Ventures BVI', aliases: ['Stormfront Cap'], added_date: '2026-09-30', type: 'SDN' },
];

// ─── FinCEN 314(a) List ────────────────────────────────────────────────────────
const fincen314a = [
  { name: 'Carlos Lehder',     aliases: ['Carlos Enrique Lehder Rivas'], type: '314a' },
  { name: 'Amado Carrillo Fuentes', aliases: ['Lord of the Skies'], type: '314a' },
  { name: 'Griselda Blanco',   aliases: ['Godmother of Cocaine','Black Widow'], type: '314a' },
  { name: 'Semion Mogilevich', aliases: ['Seva','The Brainy Don'], type: '314a' },
  { name: 'El Mayo Zambada',   aliases: ['Ismael Zambada García','El Mayo'], type: '314a' },
  { name: 'Fentanyl Finance LLC', aliases: [], type: '314a' },
];

async function main() {
  console.log('Seeding KYC_SANCTIONS KV namespace...');

  await kvPut('sdn:index', sdnIndex);
  console.log(`  ✅ sdn:index — ${sdnIndex.length} entities`);

  await kvPut('pep:index', pepIndex);
  console.log(`  ✅ pep:index — ${pepIndex.length} PEPs`);

  await kvPut('sdn:delta:7d', sdnDelta7d);
  console.log(`  ✅ sdn:delta:7d — ${sdnDelta7d.length} delta entries`);

  await kvPut('fincen:314a', fincen314a);
  console.log(`  ✅ fincen:314a — ${fincen314a.length} 314(a) entries`);

  console.log('\nKV seed complete ✅');
}

main().catch(e => { console.error(e); process.exit(1); });
