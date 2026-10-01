#!/usr/bin/env bash
# kyc-gateway v9.0 — live endpoint smoke tests
# Usage: KYC_ADMIN_KEY=<key> bash test.sh [base_url]
set -euo pipefail

BASE="${1:-https://kyc.wwwknockoutforever.com}"
ADMIN_KEY="${KYC_ADMIN_KEY:-kyc-admin-bervashun-2026-secure}"
GATEWAY_KEY="${GATEWAY_API_KEY:-78d62c3d8bc33309df5c152ab54b8888e190384346299bdca6dd901fdbba4daa}"

echo "🔍  Smoke testing kyc-gateway v9.0 at $BASE"
echo ""

pass=0; fail=0

check() {
  local label="$1"; local expected="$2"; local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅  $label"; ((pass++))
  else
    echo "  ❌  $label (expected '$expected' in: $actual)"; ((fail++))
  fi
}

# ── Health ────────────────────────────────────────────────────────────────────
HEALTH=$(curl -sf "$BASE/api/kyc/health" || echo '{"status":"error"}')
check "Health endpoint returns ok"      '"ok"'         "$HEALTH"
check "Health reports version 9.0"     '"9.0"'        "$HEALTH"
check "Health reports 18 engines"      '"engines":18' "$HEALTH"

# ── APPROVED individual ───────────────────────────────────────────────────────
APPROVED=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Alice Whitmore",
    "tin":"234-56-7890",
    "date_of_birth":"1985-04-12",
    "country_code":"US",
    "address":{"street":"200 Oak Ave","city":"Chicago","state":"IL","zip":"60601"},
    "documents":[{"type":"passport","expiry":"2030-06-01"}]
  }' || echo '{"decision":"ERROR"}')
check "APPROVED clean individual"       '"APPROVED"'       "$APPROVED"
check "Account generation allowed"      '"allowed":true'   "$APPROVED"
check "18 engines reported"             '"count":18'       "$APPROVED"
check "latency_ms present"             '"latency_ms"'     "$APPROVED"

# ── DENIED — OFAC hit ────────────────────────────────────────────────────────
DENIED=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Qasem Soleimani",
    "tin":"900-00-1234",
    "country_code":"IR",
    "date_of_birth":"1957-03-11"
  }' || echo '{"decision":"ERROR"}')
check "DENIED OFAC hit"                '"DENIED"'              "$DENIED"
check "OFAC_SDN_HIT flag present"     '"OFAC_SDN_HIT"'       "$DENIED"
check "Account generation blocked"    '"allowed":false'       "$DENIED"
check "review_queued true"            '"review_queued":true'  "$DENIED"

# ── REVIEW — structuring ─────────────────────────────────────────────────────
REVIEW=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Bob Neutral",
    "tin":"345-67-8901",
    "date_of_birth":"1975-08-20",
    "country_code":"US",
    "transaction_amount":8500
  }' || echo '{"decision":"ERROR"}')
check "REVIEW structuring detected"      '"REVIEW"'                "$REVIEW"
check "STRUCTURING_DETECTED flag"       '"STRUCTURING_DETECTED"'  "$REVIEW"

# ── Unauthorized (no key) ─────────────────────────────────────────────────────
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -d '{"applicant_name":"x","tin":"123-45-6789"}')
check "No auth → 401"                   "401"  "$UNAUTH_STATUS"

# ── Missing required fields → 422 ────────────────────────────────────────────
MISSING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"individual"}')
check "Missing fields → 422"            "422"  "$MISSING_STATUS"

# ── Admin stats ───────────────────────────────────────────────────────────────
STATS=$(curl -sf "$BASE/api/kyc/stats" \
  -H "X-Kyc-Admin-Key: $ADMIN_KEY" || echo '{"error":"fail"}')
check "Stats returns total field"       '"total"'     "$STATS"
check "Stats returns version 9.0"      '"9.0"'       "$STATS"
check "Stats returns engine count"     '"engines"'   "$STATS"
check "Stats returns fincen_hits"      '"fincen_hits"' "$STATS"

# ── Review queue (admin) ───────────────────────────────────────────────────────
QUEUE=$(curl -sf "$BASE/api/kyc/review" \
  -H "X-Kyc-Admin-Key: $ADMIN_KEY" || echo '{"error":"fail"}')
check "Review queue returns results"   '"results"' "$QUEUE"
check "Review queue has total field"   '"total"'   "$QUEUE"

# ── 404 for unknown path ──────────────────────────────────────────────────────
NOT_FOUND=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/not-a-real-path")
check "Unknown path → 404"             "404" "$NOT_FOUND"

# ── CORS headers ─────────────────────────────────────────────────────────────
CORS_HEADERS=$(curl -sf -I -X OPTIONS "$BASE/api/kyc/health" \
  -H "Origin: https://app.bervashun.com" || echo "")
check "CORS allow-origin header present" "Access-Control-Allow-Origin" "$CORS_HEADERS"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Smoke test results: ✅ $pass passed  ❌ $fail failed"
echo "═══════════════════════════════════════════════════"
[[ $fail -eq 0 ]]
