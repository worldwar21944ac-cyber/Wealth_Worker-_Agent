#!/usr/bin/env bash
# kyc-gateway v8.1 — Live Integration Tests
# Usage: KYC_ADMIN_KEY=<key> GATEWAY_API_KEY=<key> bash test.sh
set -euo pipefail

BASE="${KYC_BASE_URL:-https://kyc.wwwknockoutforever.com}"
ADMIN_KEY="${KYC_ADMIN_KEY:-kyc-admin-bervashun-2026-secure}"
API_KEY="${GATEWAY_API_KEY:-78d62c3d8bc33309df5c152ab54b8888e190384346299bdca6dd901fdbba4daa}"

PASS=0; FAIL=0

check() {
  local label="$1"; local expected="$2"; local actual="$3"
  if echo "$actual" | grep -q "$expected" 2>/dev/null; then
    echo "✅ $label"
    ((PASS++)) || true
  else
    echo "❌ $label — expected '$expected' in: $actual"
    ((FAIL++)) || true
  fi
}

echo "═══════════════════════════════════════════════"
echo "  kyc-gateway v8.1 — Live Integration Tests"
echo "  Base: $BASE"
echo "═══════════════════════════════════════════════"
echo ""

# ── Health
echo "── Health"
H=$(curl -sf "$BASE/api/kyc/health")
check "Health status=ok"        '"status":"ok"'    "$H"
check "Health version=8.1"      '"version":"8.1"'  "$H"
check "Health engines=17"       '"engines":17'     "$H"
echo ""

# ── Unauthorized
echo "── Auth"
R=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -d '{"applicant_name":"Test","tin":"123456789"}' 2>/dev/null || echo "401")
check "No API key → 401"   "401"   "$R"
echo ""

# ── Clean individual (APPROVED)
echo "── Clean Individual"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Alice Johnson",
    "tin":"234567890",
    "dob":"1985-05-15",
    "address":{"country":"US","zip":"10001"},
    "amount":500
  }')
check "Clean individual → APPROVED"   '"status":"APPROVED"'         "$R"
check "account_generation.allowed"    '"allowed":true'              "$R"
check "17 engines run"                '"engines_run":17'            "$R"
check "engine version v8.1"           '"engine_version":"v8.1"'     "$R"
SID=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['submission_id'])" 2>/dev/null || echo "unknown")
echo "   submission_id: $SID"
echo ""

# ── Status check
echo "── Status"
if [[ "$SID" != "unknown" ]]; then
  S=$(curl -sf "$BASE/api/kyc/status/$SID" -H "X-Api-Key: $API_KEY")
  check "Status found"             '"submission_id"'    "$S"
  check "Status = APPROVED"        '"status":"APPROVED"' "$S"
fi
echo ""

# ── Structuring flag (REVIEW)
echo "── Structuring (E6)"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Bob Martinez",
    "tin":"456789012",
    "dob":"1975-03-22",
    "address":{"country":"US","zip":"10001"},
    "amount":9500
  }')
check "Structuring → REVIEW"          '"status":"REVIEW"'   "$R"
check "E6_Structuring flagged"        'E6_Structuring'      "$R"
check "structuring_flagged=true"      '"structuring_flagged":true' "$R"
echo ""

# ── Synthetic SSN (E15)
echo "── Synthetic Identity (E15)"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Carl Davis",
    "tin":"900000001",
    "dob":"1990-01-01",
    "address":{"country":"US","zip":"10001"},
    "amount":100
  }')
check "Synthetic SSN → REVIEW or DENIED" '"status":"' "$R"
check "E15_Synthetic_ID in flags"         'E15_Synthetic' "$R"
echo ""

# ── FATF country (E3)
echo "── FATF High-Risk Country (E3)"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Dana Lee",
    "tin":"345678901",
    "dob":"1980-06-15",
    "address":{"country":"IR","zip":"10001"},
    "amount":100
  }')
check "FATF Iran → REVIEW or DENIED"  '"status":"'     "$R"
check "E3_FATF flagged"               'E3_FATF'        "$R"
echo ""

# ── Admin stats
echo "── Stats (admin)"
R=$(curl -sf "$BASE/api/kyc/stats" -H "X-Admin-Key: $ADMIN_KEY")
check "Stats has totals"          '"totals"'          "$R"
check "Stats has engine_version"  '"engine_version"'  "$R"
check "Stats has fincen_hits"     '"fincen_hits"'     "$R"
echo ""

# ── Review queue
echo "── Review Queue"
R=$(curl -sf "$BASE/api/kyc/review" -H "X-Admin-Key: $ADMIN_KEY")
check "Review queue returns page"    '"page"'     "$R"
check "Review queue returns items"   '"items"'    "$R"
echo ""

# ── Batch
echo "── Batch (admin)"
R=$(curl -sf -X POST "$BASE/api/kyc/batch" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '[
    {"entity_type":"individual","applicant_name":"Eve Turner","tin":"567890123","dob":"1992-04-10","address":{"country":"US","zip":"10001"},"amount":200},
    {"entity_type":"business","applicant_name":"Frontier Corp","tin":"201234567","address":{"country":"US","zip":"10001"},"amount":5000}
  ]')
check "Batch processed=2"      '"processed":2'   "$R"
check "Batch has results"      '"results"'       "$R"
echo ""

echo "═══════════════════════════════════════════════"
echo "  Results: ✅ $PASS passed  |  ❌ $FAIL failed"
echo "═══════════════════════════════════════════════"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
