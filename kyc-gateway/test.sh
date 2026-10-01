#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${KYC_BASE_URL:-https://kyc.wwwknockoutforever.com}"
ADMIN_KEY="${KYC_ADMIN_KEY:-kyc-admin-bervashun-2026-secure}"
API_KEY="${GATEWAY_API_KEY:-78d62c3d8bc33309df5c152ab54b8888e190384346299bdca6dd901fdbba4daa}"

echo "══════════════════════════════════════════════════"
echo "  kyc-gateway v6.0 — E2E Smoke Tests"
echo "  Base: $BASE_URL"
echo "══════════════════════════════════════════════════"

pass=0; fail=0

check() {
  local label="$1"; local status="$2"; local body="$3"; local expected="$4"
  if echo "$body" | grep -q "$expected"; then
    echo "  ✅ $label"
    ((pass++))
  else
    echo "  ❌ $label (expected: $expected)"
    echo "     Response: $(echo "$body" | head -c 200)"
    ((fail++))
  fi
}

echo ""
echo "▶ Health Check"
R=$(curl -sf "$BASE_URL/api/kyc/health")
check "Health returns ok" 200 "$R" '"status":"ok"'
check "Engine version v6.0" 200 "$R" '"engine_version":"v6.0"'
check "16 engines reported" 200 "$R" '"engines":16'

echo ""
echo "▶ Clean Individual (APPROVED)"
R=$(curl -sf -X POST "$BASE_URL/api/kyc/apply" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"individual","applicant_name":"Jane Smith","ssn":"345-67-8901","dob":"1985-06-15","country_code":"US","address":"123 Main St","zip_code":"90210"}')
check "Returns submission_id" 200 "$R" 'submission_id'
check "APPROVED decision" 200 "$R" '"risk_decision":"APPROVED"'
check "account_generation allowed=true" 200 "$R" '"allowed":true'
SUB_ID=$(echo "$R" | grep -o '"submission_id":"[^"]*"' | cut -d'"' -f4)

echo ""
echo "▶ SDN Hit (DENIED)"
R=$(curl -sf -X POST "$BASE_URL/api/kyc/apply" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"individual","applicant_name":"Osama Bin Laden","ssn":"234-56-7890","dob":"1957-03-10","country_code":"AF"}')
check "SDN submission accepted" 200 "$R" 'submission_id'
check "OFAC flag present" 200 "$R" 'OFAC_SDN_MATCH'
check "account_generation blocked" 200 "$R" '"allowed":false'

echo ""
echo "▶ Structuring Flag (REVIEW or DENIED)"
R=$(curl -sf -X POST "$BASE_URL/api/kyc/apply" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"individual","applicant_name":"Mike Dollars","ssn":"456-78-9012","dob":"1978-03-22","declared_amount":9500,"country_code":"US"}')
check "Structuring flag fires" 200 "$R" 'STRUCTURING_AMOUNT'

echo ""
echo "▶ FATF Country + Synthetic SSN (DENIED)"
R=$(curl -sf -X POST "$BASE_URL/api/kyc/apply" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"individual","applicant_name":"Test Person","ssn":"900-45-6789","dob":"1980-01-01","country_code":"KP"}')
check "FATF flag fires" 200 "$R" 'FATF_HIGH_RISK_COUNTRY'
check "Synthetic identity flag fires" 200 "$R" 'SYNTHETIC_IDENTITY'

echo ""
echo "▶ Status Lookup"
if [[ -n "${SUB_ID:-}" ]]; then
  R=$(curl -sf "$BASE_URL/api/kyc/status/$SUB_ID" \
    -H "Authorization: Bearer $API_KEY")
  check "Status lookup returns submission" 200 "$R" 'submission_id'
  check "Status shows APPROVED" 200 "$R" 'APPROVED'
else
  echo "  ⚠️  Skipping status test — no submission_id captured"
fi

echo ""
echo "▶ Review Queue (Admin)"
R=$(curl -sf "$BASE_URL/api/kyc/review?status=pending" \
  -H "Authorization: Bearer $ADMIN_KEY")
check "Review queue returns" 200 "$R" 'queue'

echo ""
echo "▶ Stats (Admin)"
R=$(curl -sf "$BASE_URL/api/kyc/stats" \
  -H "Authorization: Bearer $ADMIN_KEY")
check "Stats returns version" 200 "$R" '"version"'
check "16 engines reported in stats" 200 "$R" '"engines_active":16'

echo ""
echo "▶ Auth Enforcement"
R=$(curl -s "$BASE_URL/api/kyc/apply" \
  -X POST -H "Content-Type: application/json" \
  -d '{"applicant_name":"Test"}')
check "Unauthenticated request rejected" 401 "$R" 'unauthorized'

echo ""
echo "▶ Batch Screen (Admin)"
R=$(curl -sf -X POST "$BASE_URL/api/kyc/batch" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {"entity_type":"individual","applicant_name":"Clean Alice","ssn":"234-56-7890","dob":"1990-01-01","country_code":"US"},
    {"entity_type":"individual","applicant_name":"Risky Bob","ssn":"900-12-3456","country_code":"IR"}
  ]')
check "Batch returns results array" 200 "$R" '"results"'
check "Batch returns summary" 200 "$R" '"summary"'

echo ""
echo "══════════════════════════════════════════════════"
echo "  Passed: $pass"
echo "  Failed: $fail"
echo "══════════════════════════════════════════════════"
[[ $fail -eq 0 ]] && exit 0 || exit 1
