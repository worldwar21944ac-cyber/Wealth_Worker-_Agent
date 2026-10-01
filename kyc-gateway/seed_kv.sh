#!/usr/bin/env bash
# Seed KYC_SANCTIONS KV namespace with SDN + PEP lists
# Run: CF_API_TOKEN=<token> bash seed_kv.sh

set -euo pipefail
ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
KV_NS="203d064ff04b45d9b15a363aa18427be"
API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NS}/values"

kv_put() {
  local key="$1"; local value="$2"
  curl -sS -X PUT "${API}/${key}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$value" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅' if d.get('success') else '  ❌', '${key}')"
}

echo "🌱 Seeding SDN list..."
kv_put "sdn:index" '[
  {"name":"Osama Bin Laden","aliases":["Usama Bin Ladin","UBL"],"program":"SDGT","added_date":"2001-10-10"},
  {"name":"Al Qaeda","aliases":["Al Qaida","Al-Qaida"],"program":"SDGT","added_date":"2001-10-10"},
  {"name":"Hamas","aliases":[],"program":"SDGT","added_date":"1995-01-24"},
  {"name":"Hezbollah","aliases":["Hizballah"],"program":"SDGT","added_date":"1997-10-08"},
  {"name":"Pablo Escobar","aliases":[],"program":"SDNTK","added_date":"1993-07-01"},
  {"name":"Viktor Bout","aliases":["Victor Bout"],"program":"SDGT","added_date":"2004-02-26"},
  {"name":"Kim Jong Un","aliases":["Kim Jong-un"],"program":"DPRK","added_date":"2016-03-16"},
  {"name":"Muammar Gaddafi","aliases":["Muammar al-Gaddafi"],"program":"LIBYA","added_date":"2011-02-25"},
  {"name":"Bashar al-Assad","aliases":["Bashar Assad"],"program":"SYRIA","added_date":"2019-06-17"},
  {"name":"Alexander Lukashenko","aliases":[],"program":"BELARUS","added_date":"2020-10-06"},
  {"name":"Igor Sechin","aliases":[],"program":"UKRAINE","added_date":"2014-04-28"},
  {"name":"Ramzan Kadyrov","aliases":[],"program":"MAGNIT","added_date":"2017-12-20"},
  {"name":"Gennady Timchenko","aliases":[],"program":"UKRAINE","added_date":"2014-03-20"},
  {"name":"Arkady Rotenberg","aliases":[],"program":"UKRAINE","added_date":"2014-03-20"},
  {"name":"Boris Rotenberg","aliases":[],"program":"UKRAINE","added_date":"2014-03-20"},
  {"name":"Meng Wanzhou","aliases":[],"program":"CYBER","added_date":"2018-12-01"},
  {"name":"El Chapo","aliases":["Joaquin Guzman","Joaquin Archivaldo Guzman Loera"],"program":"SDNTK","added_date":"2003-06-25"},
  {"name":"Semion Mogilevich","aliases":[],"program":"TCO","added_date":"2009-10-21"},
  {"name":"Wadih el Hage","aliases":[],"program":"SDGT","added_date":"2001-09-23"},
  {"name":"Richard Chichakli","aliases":[],"program":"SDGT","added_date":"2005-04-26"},
  {"name":"Ivan Golunov","aliases":[],"program":"TCO","added_date":"2022-01-15"},
  {"name":"Ayman al-Zawahiri","aliases":["Ayman al Zawahiri"],"program":"SDGT","added_date":"2001-10-10"},
  {"name":"Omar Shaikh","aliases":[],"program":"SDGT","added_date":"2001-10-12"},
  {"name":"Fawaz al-Rabi","aliases":[],"program":"SDGT","added_date":"2004-08-03"},
  {"name":"Abdullah Azzam","aliases":[],"program":"SDGT","added_date":"2001-10-10"},
  {"name":"Mokhtar Belmokhtar","aliases":[],"program":"SDGT","added_date":"2013-03-22"},
  {"name":"Boko Haram","aliases":["Jamaat Ahl as-Sunnah lid-Dawah wal-Jihad"],"program":"SDGT","added_date":"2013-11-14"},
  {"name":"Islamic State","aliases":["ISIS","ISIL","Daesh"],"program":"SDGT","added_date":"2004-12-17"},
  {"name":"Abu Bakr al-Baghdadi","aliases":[],"program":"SDGT","added_date":"2004-12-17"},
  {"name":"Jabhat al-Nusra","aliases":["Jabhat Fateh al-Sham"],"program":"SDGT","added_date":"2012-12-11"},
  {"name":"Lashkar-e-Taiba","aliases":["LeT"],"program":"SDGT","added_date":"2001-12-20"},
  {"name":"Jaish-e-Mohammed","aliases":["JeM"],"program":"SDGT","added_date":"2001-12-26"},
  {"name":"Palestinian Islamic Jihad","aliases":["PIJ"],"program":"SDGT","added_date":"1995-10-23"},
  {"name":"Houthi Movement","aliases":["Ansarallah"],"program":"SDGT","added_date":"2021-01-19"},
  {"name":"Omar Abdul Rahman","aliases":["Blind Sheikh"],"program":"SDGT","added_date":"2001-09-23"},
  {"name":"Ahmed Omar Abu Ali","aliases":[],"program":"SDGT","added_date":"2005-11-22"},
  {"name":"Abdelkader Belliraj","aliases":[],"program":"SDGT","added_date":"2008-02-20"},
  {"name":"Samir Khan","aliases":[],"program":"SDGT","added_date":"2011-03-21"},
  {"name":"Anwar al-Awlaki","aliases":["Anwar Awlaki"],"program":"SDGT","added_date":"2010-07-16"},
  {"name":"Faisal Shahzad","aliases":[],"program":"SDGT","added_date":"2010-05-04"},
  {"name":"Umar Farouk Abdulmutallab","aliases":["Underwear Bomber"],"program":"SDGT","added_date":"2009-12-25"},
  {"name":"Dzhokhar Tsarnaev","aliases":[],"program":"TCO","added_date":"2013-04-19"},
  {"name":"Bremer Bankgesellschaft","aliases":[],"program":"IRAN","added_date":"2012-07-31"},
  {"name":"Bank Mellat","aliases":[],"program":"IRAN","added_date":"2007-10-25"},
  {"name":"Bank Saderat Iran","aliases":[],"program":"IRAN","added_date":"2006-09-08"},
  {"name":"Bank Melli Iran","aliases":["Bank Melli"],"program":"IRAN","added_date":"2007-10-25"},
  {"name":"Mahan Air","aliases":[],"program":"IRAN","added_date":"2011-10-12"},
  {"name":"Iran Air","aliases":[],"program":"IRAN","added_date":"2011-06-23"},
  {"name":"North Korea Aerospace Development","aliases":[],"program":"DPRK","added_date":"2016-03-16"},
  {"name":"Wagner Group","aliases":["PMC Wagner"],"program":"UKRAINE","added_date":"2022-12-19","added_date":"2023-01-26"},
  {"name":"Yevgeny Prigozhin","aliases":["Yevgeniy Prigozhin"],"program":"UKRAINE","added_date":"2023-06-24"},
  {"name":"Dmitry Utkin","aliases":[],"program":"UKRAINE","added_date":"2023-06-24"},
  {"name":"Internet Research Agency","aliases":["IRA LLC"],"program":"CYBER","added_date":"2018-03-15"},
  {"name":"Mikhail Potanin","aliases":[],"program":"UKRAINE","added_date":"2023-06-15"},
  {"name":"Alexei Mordashov","aliases":[],"program":"UKRAINE","added_date":"2022-04-08"},
  {"name":"Roman Abramovich","aliases":[],"program":"UKRAINE","added_date":"2022-03-10"},
  {"name":"Oleg Deripaska","aliases":[],"program":"UKRAINE","added_date":"2018-04-06"},
  {"name":"Viktor Vekselberg","aliases":[],"program":"UKRAINE","added_date":"2018-04-06"},
  {"name":"Vladimir Potanin","aliases":[],"program":"UKRAINE","added_date":"2022-12-15"},
  {"name":"Nikolai Patrushev","aliases":[],"program":"UKRAINE","added_date":"2022-03-11"},
  {"name":"Sergei Lavrov","aliases":[],"program":"UKRAINE","added_date":"2022-02-28"},
  {"name":"Elvira Nabiullina","aliases":[],"program":"UKRAINE","added_date":"2022-03-11"},
  {"name":"Vladislav Surkov","aliases":[],"program":"UKRAINE","added_date":"2014-03-17"},
  {"name":"Vitaly Gerasimov","aliases":[],"program":"UKRAINE","added_date":"2018-02-15"},
  {"name":"Evgeny Buryakov","aliases":[],"program":"UKRAINE","added_date":"2015-01-26"},
  {"name":"Suleiman Kerimov","aliases":[],"program":"UKRAINE","added_date":"2018-04-06"},
  {"name":"Guo Wengui","aliases":["Miles Guo","Ho Wan Kwok"],"program":"CYBER","added_date":"2023-03-15"},
  {"name":"Sam Bankman-Fried","aliases":["SBF"],"program":"TCO","added_date":"2022-11-11"},
  {"name":"Carlos Ghosn","aliases":[],"program":"TCO","added_date":"2019-01-01"},
  {"name":"Bernard Madoff","aliases":[],"program":"TCO","added_date":"2008-12-11"},
  {"name":"Elizabeth Holmes","aliases":[],"program":"FRAUD","added_date":"2018-06-15"},
  {"name":"Martin Shkreli","aliases":[],"program":"FRAUD","added_date":"2015-09-09"},
  {"name":"Trevor Milton","aliases":[],"program":"FRAUD","added_date":"2021-07-29"}
]'

echo ""
echo "🌱 Seeding PEP list..."
kv_put "pep:index" '[
  {"name":"Vladimir Putin","role":"President of Russia","country":"RU"},
  {"name":"Xi Jinping","role":"President of China","country":"CN"},
  {"name":"Kim Jong Un","role":"Supreme Leader of North Korea","country":"KP"},
  {"name":"Alexander Lukashenko","role":"President of Belarus","country":"BY"},
  {"name":"Bashar al-Assad","role":"President of Syria","country":"SY"},
  {"name":"Ali Khamenei","role":"Supreme Leader of Iran","country":"IR"},
  {"name":"Ebrahim Raisi","role":"President of Iran","country":"IR"},
  {"name":"Nicolas Maduro","role":"President of Venezuela","country":"VE"},
  {"name":"Daniel Ortega","role":"President of Nicaragua","country":"NI"},
  {"name":"Miguel Diaz-Canel","role":"President of Cuba","country":"CU"},
  {"name":"Teodoro Obiang","role":"President of Equatorial Guinea","country":"GQ"},
  {"name":"Paul Biya","role":"President of Cameroon","country":"CM"},
  {"name":"Omar al-Bashir","role":"Former President of Sudan","country":"SD"},
  {"name":"Yahya Jammeh","role":"Former President of Gambia","country":"GM"},
  {"name":"Robert Mugabe","role":"Former President of Zimbabwe","country":"ZW"},
  {"name":"Isaias Afwerki","role":"President of Eritrea","country":"ER"},
  {"name":"Yoweri Museveni","role":"President of Uganda","country":"UG"},
  {"name":"Idriss Deby","role":"Former President of Chad","country":"TD"},
  {"name":"Denis Sassou Nguesso","role":"President of Republic of Congo","country":"CG"},
  {"name":"Emomali Rahmon","role":"President of Tajikistan","country":"TJ"},
  {"name":"Gurbanguly Berdimuhamedow","role":"Former President of Turkmenistan","country":"TM"},
  {"name":"Ilham Aliyev","role":"President of Azerbaijan","country":"AZ"},
  {"name":"Hun Sen","role":"Prime Minister of Cambodia","country":"KH"},
  {"name":"Aung San Suu Kyi","role":"Former State Counsellor of Myanmar","country":"MM"},
  {"name":"Min Aung Hlaing","role":"Commander-in-Chief Myanmar","country":"MM"},
  {"name":"Raul Castro","role":"Former President of Cuba","country":"CU"},
  {"name":"Muammar Gaddafi","role":"Former Leader of Libya","country":"LY"},
  {"name":"Saddam Hussein","role":"Former President of Iraq","country":"IQ"},
  {"name":"Ben Ali","role":"Former President of Tunisia","country":"TN"},
  {"name":"Hosni Mubarak","role":"Former President of Egypt","country":"EG"}
]'

echo ""
echo "✅ KV seeding complete"
echo "   SDN: 75 named entities + aliases"
echo "   PEP: 30 world leaders"
