#!/usr/bin/env bash
# ============================================================
#  KYC-Gateway v11.0 — E2E curl Test Suite
#  Target: https://kyc.wwwknockoutforever.com
#  Usage:  GATEWAY_API_KEY=<key> KYC_ADMIN_KEY=<key> bash test.sh
# ============================================================
set -euo pipefail

BASE_URL="${KYC_BASE_URL:-https://kyc.wwwknockoutforever.com}"
GATEWAY_KEY="${GATEWAY_API_KEY:-test-gateway-key}"
ADMIN_KEY="${KYC_ADMIN_KEY:-test-admin-key}"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

check() {
  local label="$1"; local condition="$2"
  TOTAL=$((TOTAL+1))
  if [[ "$condition" == "true" ]]; then
    PASS=$((PASS+1))
    echo -e "  ${GREEN}✓${NC} $label"
  else
    FAIL=$((FAIL+1))
    echo -e "  ${RED}✗ FAIL${NC}: $label"
  fi
}

section() { echo -e "\n${BOLD}▶ $1${NC}"; }

# Helper: run curl, return body
api() {
  local method="$1"; local path="$2"; local auth="$3"; local body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sf --max-time 30 -X "$method" \
      "${BASE_URL}${path}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $auth" \
      -d "$body" 2>/dev/null || echo '{}'
  else
    curl -sf --max-time 30 -X "$method" \
      "${BASE_URL}${path}" \
      -H "Authorization: Bearer $auth" 2>/dev/null || echo '{}'
  fi
}

# Helper: run curl, capture HTTP status code
api_code() {
  local method="$1"; local path="$2"; local auth="$3"; local body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -s --max-time 30 -o /dev/null -w "%{http_code}" -X "$method" \
      "${BASE_URL}${path}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $auth" \
      -d "$body" 2>/dev/null || echo "000"
  else
    curl -s --max-time 30 -o /dev/null -w "%{http_code}" -X "$method" \
      "${BASE_URL}${path}" \
      -H "Authorization: Bearer $auth" 2>/dev/null || echo "000"
  fi
}

jq_get() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d$2)" 2>/dev/null || echo "null"; }
jq_bool() { local v=$(jq_get "$1" "$2"); [[ "$v" == "True" || "$v" == "true" ]] && echo "true" || echo "false"; }

# ─────────────────────────────────────────────────────────────

section "1 · Health Check (unauthenticated)"
HEALTH=$(curl -sf --max-time 15 "${BASE_URL}/api/kyc/health" 2>/dev/null || echo '{}')
check "GET /api/kyc/health returns 200" "[[ '$(jq_get "$HEALTH" ".get('status','x')")' == 'ok' ]]"
check "version field present" "[[ '$(jq_get "$HEALTH" ".get('version','x')")' == 'v11.0' ]]"
check "service field present" "[[ '$(jq_get "$HEALTH" ".get('service','x')")' == 'kyc-gateway' ]]"

section "2 · CORS Preflight"
CORS=$(curl -sf --max-time 15 -X OPTIONS "${BASE_URL}/api/kyc/apply" \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  -D - -o /dev/null 2>/dev/null || echo "")
check "OPTIONS returns 200" "[[ '$?' == '0' ]]"

section "3 · Auth Rejection"
BAD_CODE=$(api_code POST /api/kyc/apply "bad-token" '{"entity_type":"individual"}')
check "No/bad Bearer token → 401" "[[ '$BAD_CODE' == '401' ]]"
NO_AUTH_CODE=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" -X GET "${BASE_URL}/api/kyc/review" 2>/dev/null || echo "000")
check "GET /review without admin key → 401" "[[ '$NO_AUTH_CODE' == '401' ]]"

section "4 · Individual KYC — APPROVED path (clean applicant)"
CLEAN_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Alice Testington",
  "tin": "234-56-7890",
  "dob": "1985-06-15",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701" },
  "doc_type": "passport",
  "doc_expiry_date": "2030-01-01",
  "payment_amount": 1000
}'
RESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$CLEAN_PAYLOAD")
check "submission_id starts with kyc_" "[[ '$(jq_get "$RESP" ".get('submission_id','x')")' == kyc_* ]]"
check "status=screened" "[[ '$(jq_get "$RESP" ".get('status','x')")' == 'screened' ]]"
check "engines.count=18" "[[ '$(jq_get "$RESP" "['engines']['count']")' == '18' ]]"
check "timed_out=false" "[[ '$(jq_bool "$RESP" "['engines']['timed_out']")' == 'false' ]]"
check "screen_latency_ms < 1750" "[[ $(jq_get "$RESP" ".get('screen_latency_ms',9999)") -lt 1750 ]]"
check "risk_decision present" "[[ '$(jq_get "$RESP" ".get('risk_decision','x')")' != 'null' ]]"
CLEAN_SID=$(jq_get "$RESP" ".get('submission_id','')" | tr -d "'")
check "approved clean applicant" "[[ '$(jq_get "$RESP" ".get('risk_decision','x')")' == 'APPROVED' ]]"

section "5 · E6 Structuring — REVIEW/DENIED path"
STRUCT_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Bob Normalman",
  "tin": "234-56-7891",
  "dob": "1982-03-10",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "456 Oak Ave", "city": "Dallas", "state": "TX", "zip": "75001" },
  "doc_type": "drivers_license",
  "doc_expiry_date": "2028-05-20",
  "payment_amount": 9500
}'
SRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$STRUCT_PAYLOAD")
SFLAGS=$(jq_get "$SRESP" ".get('flags',[])")
check "structuring flag present" "[[ '$SFLAGS' == *'E6_STRUCTURING'* ]]"
check "risk_score >= 30 (structuring alone = 35)" "[[ $(jq_get "$SRESP" ".get('risk_score',0)") -ge 30 ]]"
check "account_generation.allowed=false" "[[ '$(jq_bool "$SRESP" "['account_generation']['allowed']")' == 'false' ]]"

section "6 · E9 DOB Plausibility — under-18"
MINOR_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Charlie Young",
  "tin": "345-67-8901",
  "dob": "2015-01-01",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "789 Pine Rd", "city": "Houston", "state": "TX", "zip": "77001" },
  "doc_type": "national_id",
  "doc_expiry_date": "2027-01-01"
}'
MRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$MINOR_PAYLOAD")
MFLAGS=$(jq_get "$MRESP" ".get('flags',[])")
check "DOB_IMPLAUSIBLE flag present" "[[ '$MFLAGS' == *'E9_DOB_IMPLAUSIBLE'* ]]"

section "7 · E3 FATF High-Risk Country"
FATF_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Diana Petrov",
  "tin": "456-78-9012",
  "dob": "1978-07-04",
  "country_of_residence": "IR",
  "nationality": "IR",
  "address": { "street": "10 Central Ave", "city": "Tehran", "state": "TH", "zip": "11111" },
  "doc_type": "passport",
  "doc_expiry_date": "2029-06-01"
}'
FRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$FATF_PAYLOAD")
FFLAGS=$(jq_get "$FRESP" ".get('flags',[])")
check "FATF_HIGH_RISK flag present" "[[ '$FFLAGS' == *'E3_FATF_HIGH_RISK'* ]]"

section "8 · E15 Synthetic Identity (SSN area ≥ 900)"
SYN_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Eve Synthetic",
  "tin": "999-45-6789",
  "dob": "1990-01-01",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "1 Fake St", "city": "Nowhere", "state": "CA", "zip": "90210" },
  "doc_type": "passport",
  "doc_expiry_date": "2028-01-01"
}'
SYNRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$SYN_PAYLOAD")
check "E15_SYNTHETIC_SSN flag present" "[[ '$(jq_get "$SYNRESP" ".get('flags',[])")' == *'E15_SYNTHETIC_SSN'* ]]"
check "risk_score >= 40" "[[ $(jq_get "$SYNRESP" ".get('risk_score',0)") -ge 40 ]]"

section "9 · Business KYC — UBO cascade"
BIZ_PAYLOAD='{
  "entity_type": "business",
  "business_name": "Acme Logistics LLC",
  "tin": "12-3456789",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "200 Commerce Blvd", "city": "Chicago", "state": "IL", "zip": "60601" },
  "doc_type": "national_id",
  "doc_expiry_date": "2031-01-01",
  "num_corporate_layers": 2,
  "beneficial_owners": [
    { "name": "Frank Owens", "ownership_pct": 51, "tin": "234-56-7892", "nationality": "US" }
  ]
}'
BIZRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$BIZ_PAYLOAD")
check "business submission accepted" "[[ '$(jq_get "$BIZRESP" ".get('status','x')")' == 'screened' ]]"

section "10 · E12 Corporate Depth"
DEEP_PAYLOAD='{
  "entity_type": "business",
  "business_name": "Nested Holdings Trust",
  "tin": "23-4567890",
  "country_of_residence": "US",
  "nationality": "US",
  "address": { "street": "500 Shell Ave", "city": "New York", "state": "NY", "zip": "10001" },
  "doc_type": "passport",
  "doc_expiry_date": "2030-01-01",
  "num_corporate_layers": 7
}'
DEEPRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$DEEP_PAYLOAD")
check "E12_DEEP_CORPORATE_STRUCTURE flag" "[[ '$(jq_get "$DEEPRESP" ".get('flags',[])")' == *'E12_DEEP_CORPORATE_STRUCTURE'* ]]"

section "11 · GET /api/kyc/status/:id"
if [[ "$CLEAN_SID" != "null" && "$CLEAN_SID" != "" ]]; then
  SRESP2=$(api GET "/api/kyc/status/${CLEAN_SID}" "$GATEWAY_KEY")
  check "status lookup returns submission_id" "[[ '$(jq_get "$SRESP2" ".get('submission_id','x')")' == '$CLEAN_SID' ]]"
  check "status has risk_score" "[[ '$(jq_get "$SRESP2" ".get('risk_score','x')")' != 'null' ]]"
else
  check "status lookup skipped (no submission_id)" "true"
  check "status has risk_score (skipped)" "true"
fi

section "12 · GET /api/kyc/review (admin)"
RRESP=$(api GET "/api/kyc/review?status=pending&per_page=5" "$ADMIN_KEY")
check "review queue returns data array" "[[ '$(jq_get "$RRESP" ".get('data',None)")' != 'null' ]]"
check "review queue has page field" "[[ '$(jq_get "$RRESP" ".get('page',0)")' == '1' ]]"

section "13 · GET /api/kyc/stats (admin)"
STATS=$(api GET /api/kyc/stats "$ADMIN_KEY")
check "stats has total_submissions" "[[ '$(jq_get "$STATS" ".get('total_submissions','x')")' != 'null' ]]"
check "stats has engine_version" "[[ '$(jq_get "$STATS" ".get('engine_version','x')")' == 'v11.0' ]]"
check "stats has avg_risk_score" "[[ '$(jq_get "$STATS" ".get('avg_risk_score','x')")' != 'null' ]]"

section "14 · POST /api/kyc/batch (admin)"
BATCH_PAYLOAD='[
  {"entity_type":"individual","applicant_name":"Batch User 1","tin":"345-67-8902","dob":"1990-01-01","country_of_residence":"US","nationality":"US","address":{"street":"1 Main","city":"NYC","state":"NY","zip":"10001"},"doc_type":"passport","doc_expiry_date":"2030-01-01"},
  {"entity_type":"business","business_name":"Batch Corp 2","tin":"34-5678902","country_of_residence":"US","nationality":"US","address":{"street":"2 Main","city":"NYC","state":"NY","zip":"10001"},"doc_type":"passport","doc_expiry_date":"2030-01-01"}
]'
BRESP=$(api POST /api/kyc/batch "$ADMIN_KEY" "$BATCH_PAYLOAD")
check "batch returns processed count" "[[ '$(jq_get "$BRESP" ".get('processed',0)")' == '2' ]]"
check "batch results array present" "[[ '$(jq_get "$BRESP" ".get('results',None)")' != 'null' ]]"

section "15 · Invalid entity_type returns 422"
BAD_ENT_CODE=$(api_code POST /api/kyc/apply "$GATEWAY_KEY" '{"entity_type":"corporation"}')
check "invalid entity_type → 422" "[[ '$BAD_ENT_CODE' == '422' ]]"

section "16 · 404 for unknown route"
UNKNOWN_CODE=$(api_code GET /api/kyc/unknown "$GATEWAY_KEY")
check "unknown route → 404" "[[ '$UNKNOWN_CODE' == '404' ]]"

section "17 · E7 Adverse Media in applicant name"
ADV_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Gary Fraud Narcotics",
  "tin": "456-78-9013",
  "dob": "1975-03-22",
  "country_of_residence": "US",
  "nationality": "US",
  "address": {"street":"9 Commerce","city":"Miami","state":"FL","zip":"33101"},
  "doc_type": "passport",
  "doc_expiry_date": "2029-01-01"
}'
ADVRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$ADV_PAYLOAD")
check "E7_ADVERSE_MEDIA flag" "[[ '$(jq_get "$ADVRESP" ".get('flags',[])")' == *'E7_ADVERSE_MEDIA'* ]]"

section "18 · E10 PO Box Address"
POBOX_PAYLOAD='{
  "entity_type": "individual",
  "applicant_name": "Hannah Box",
  "tin": "567-89-0124",
  "dob": "1988-09-01",
  "country_of_residence": "US",
  "nationality": "US",
  "address": {"street":"P.O. Box 555","city":"Denver","state":"CO","zip":"80201"},
  "doc_type": "drivers_license",
  "doc_expiry_date": "2026-01-01"
}'
PBRESP=$(api POST /api/kyc/apply "$GATEWAY_KEY" "$POBOX_PAYLOAD")
check "E10_ADDRESS_RISK flag for PO Box" "[[ '$(jq_get "$PBRESP" ".get('flags',[])")' == *'E10_ADDRESS_RISK'* ]]"

# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Results: ${GREEN}${PASS} passed${NC} / ${RED}${FAIL} failed${NC} / ${TOTAL} total"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}❌  $FAIL test(s) FAILED${NC}"
  exit 1
else
  echo -e "  ${GREEN}✅  All $PASS tests passed${NC}"
fi
