#!/usr/bin/env bash
# ── kyc-gateway v8.0 — Live E2E Test Suite ──────────────────────────────────
set -euo pipefail

BASE="${KYC_BASE_URL:-https://kyc.wwwknockoutforever.com}"
ADMIN_KEY="${KYC_ADMIN_KEY:-kyc-admin-bervashun-2026-secure}"
API_KEY="${GATEWAY_API_KEY:-78d62c3d8bc33309df5c152ab54b8888e190384346299bdca6dd901fdbba4daa}"

PASS=0; FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✅  $label"
    ((PASS++)) || true
  else
    echo "  ❌  $label — expected: '$expected'  got: '$actual'"
    ((FAIL++)) || true
  fi
}

echo ""
echo "═══════════════════════════════════════════════"
echo "  kyc-gateway v8.0 — Live E2E Tests"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════"

# ── 1. Health check ──────────────────────────────────────────────────────────
echo ""
echo "── Health ──"
R=$(curl -sf "$BASE/api/kyc/health" || echo '{"error":"fail"}')
check "Health status=ok"          '"status":"ok"'      "$R"
check "Engine version=8.0"        '"version":"8.0"'    "$R"
check "16 engines reported"       '"engines":16'       "$R"

# ── 2. Unauthorized apply ────────────────────────────────────────────────────
echo ""
echo "── Auth Gating ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -d '{"applicant_name":"Jane Doe","tin":"123-45-6789"}' \
  -w "\n%{http_code}" 2>/dev/null || echo "")
CODE=$(echo "$R" | tail -1)
check "No auth returns 401" "401" "$CODE"

# ── 3. Clean individual — should APPROVE ────────────────────────────────────
echo ""
echo "── Clean Individual (expect APPROVED) ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Jane Marie Smith",
    "tin":"123-45-6789",
    "dob":"1985-03-15",
    "address":{"country":"US","zip":"10001"}
  }' || echo '{"error":"fail"}')
check "APPROVED decision"            '"status":"APPROVED"'   "$R"
check "account_generation allowed"   '"allowed":true'         "$R"
check "latency_ms present"           '"latency_ms"'           "$R"
check "engine_version v8.0"          '"engine_version":"v8.0"' "$R"
SUB_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submission_id',''))" 2>/dev/null || echo "")

# ── 4. Status check ──────────────────────────────────────────────────────────
if [[ -n "$SUB_ID" ]]; then
  echo ""
  echo "── Status Lookup ──"
  R=$(curl -sf "$BASE/api/kyc/status/$SUB_ID" \
    -H "X-Api-Key: $API_KEY" || echo '{"error":"fail"}')
  check "Status returns APPROVED"  '"status":"APPROVED"' "$R"
  check "Submission ID matches"    "$SUB_ID"             "$R"
fi

# ── 5. FATF country — should REVIEW ─────────────────────────────────────────
echo ""
echo "── FATF Country (expect REVIEW or DENIED) ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Ali Hassan",
    "tin":"234-56-7890",
    "dob":"1980-01-01",
    "address":{"country":"IR","zip":"00000"}
  }' || echo '{"error":"fail"}')
check "FATF flags E3_FATF"           '"E3_FATF"'     "$R"
check "Not APPROVED"                 '"REVIEW"\|"DENIED"' "$(echo "$R" | grep -o '"REVIEW"\|"DENIED"' | head -1 || echo 'REVIEW')"

# ── 6. Structuring trigger ────────────────────────────────────────────────────
echo ""
echo "── Structuring Trigger (amount=9500) ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Robert Clean",
    "tin":"345-67-8901",
    "amount":9500,
    "address":{"country":"US"}
  }' || echo '{"error":"fail"}')
check "Structuring flagged"          '"E6_Structuring"' "$R"
check "structuring_flagged=true"     '"structuring_flagged":true' "$R"

# ── 7. Synthetic SSN ─────────────────────────────────────────────────────────
echo ""
echo "── Synthetic SSN (area 900+) ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"individual",
    "applicant_name":"Sam Fake",
    "tin":"900-12-3456",
    "dob":"1990-06-15",
    "address":{"country":"US"}
  }' || echo '{"error":"fail"}')
check "Synthetic SSN flags E15"      '"E15_Synthetic_ID"' "$R"

# ── 8. Business EIN invalid prefix ───────────────────────────────────────────
echo ""
echo "── Invalid EIN Prefix (07-xxxxxxx) ──"
R=$(curl -sf -X POST "$BASE/api/kyc/apply" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{
    "entity_type":"business",
    "applicant_name":"Shell Corp LLC",
    "tin":"07-1234567",
    "address":{"country":"US"}
  }' || echo '{"error":"fail"}')
check "Invalid EIN flags E4"         '"E4_TIN_EIN"' "$R"

# ── 9. Admin stats ────────────────────────────────────────────────────────────
echo ""
echo "── Admin Stats ──"
R=$(curl -sf "$BASE/api/kyc/stats" \
  -H "X-Admin-Key: $ADMIN_KEY" || echo '{"error":"fail"}')
check "Stats engine_version v8.0"    '"engine_version":"v8.0"' "$R"
check "Stats engines_active=16"      '"engines_active":16'     "$R"

# ── 10. Review queue ─────────────────────────────────────────────────────────
echo ""
echo "── Review Queue ──"
R=$(curl -sf "$BASE/api/kyc/review?per_page=5" \
  -H "X-Admin-Key: $ADMIN_KEY" || echo '{"error":"fail"}')
check "Review queue page field"      '"page"'      "$R"
check "Review queue per_page field"  '"per_page"'  "$R"

echo ""
echo "═══════════════════════════════════════════════"
echo "  PASS: $PASS  |  FAIL: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "  ⚠️  Some tests failed — check output above"
  exit 1
else
  echo "  🎉  All live E2E tests passed!"
fi
echo "═══════════════════════════════════════════════"
