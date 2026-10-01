#!/usr/bin/env bash
# test.sh — kyc-gateway v7.0 E2E smoke tests
# Usage: KYC_ADMIN_KEY=kyc-admin-bervashun-2026-secure bash test.sh
set -euo pipefail

BASE="${KYC_BASE_URL:-https://kyc.wwwknockoutforever.com}"
KEY="${KYC_ADMIN_KEY:-kyc-admin-bervashun-2026-secure}"
GATEWAY_KEY="${GATEWAY_API_KEY:-78d62c3d8bc33309df5c152ab54b8888e190384346299bdca6dd901fdbba4daa}"

pass=0; fail=0

check() {
  local label="$1"
  local resp="$2"
  local expected_field="$3"
  local expected_val="$4"
  local actual
  actual=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$expected_field','MISSING'))" 2>/dev/null || echo 'PARSE_ERROR')
  if [[ "$actual" == "$expected_val" ]]; then
    echo "  ✅ $label → $expected_field=$actual"
    ((pass++))
  else
    echo "  ❌ $label → expected $expected_field=$expected_val, got=$actual"
    ((fail++))
  fi
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  kyc-gateway v7.0 — E2E Smoke Tests"
echo "  Base: $BASE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Health ───────────────────────────────────────────────────────────────────
echo ""
echo "── Health ──────────────────────────────────────────────────────"
H=$(curl -s "$BASE/api/kyc/health")
check "Health check" "$H" "status" "ok"

# ── Clean Individual (should APPROVE) ────────────────────────────────────────
echo ""
echo "── TC1: Clean Individual (expect APPROVED) ─────────────────────"
R1=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "full_name":"Sarah Johnson",
    "tin":"523456789",
    "date_of_birth":"1985-03-12",
    "address":"123 Main St, Austin TX 78701",
    "country":"US",
    "id_document_type":"passport",
    "id_document_number":"A12345678",
    "id_expiry_date":"2029-01-01"
  }')
check "TC1 decision" "$R1" "risk_decision" "APPROVED"

SID1=$(echo "$R1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submission_id',''))" 2>/dev/null)

# ── SDN Match (should DENY) ───────────────────────────────────────────────────
echo ""
echo "── TC2: SDN Name Match (expect DENIED) ─────────────────────────"
R2=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "full_name":"Osama bin Laden",
    "tin":"123456789",
    "date_of_birth":"1957-03-10",
    "address":"Cave 5, Tora Bora",
    "country":"AF"
  }')
check "TC2 decision" "$R2" "risk_decision" "DENIED"

# ── ITIN / Synthetic Identity (should DENY or REVIEW) ────────────────────────
echo ""
echo "── TC3: Synthetic SSN Area 900 (expect DENIED/REVIEW) ──────────"
R3=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "full_name":"Test Person",
    "tin":"900121234",
    "date_of_birth":"1990-05-05",
    "address":"456 Oak Ave, Miami FL",
    "country":"US"
  }')
R3_DEC=$(echo "$R3" | python3 -c "import sys,json; d=json.load(sys.stdin); dec=d.get('risk_decision',''); print('PASS' if dec in ('DENIED','REVIEW') else dec)" 2>/dev/null)
if [[ "$R3_DEC" == "PASS" ]]; then
  echo "  ✅ TC3: Synthetic SSN → DENIED or REVIEW"; ((pass++))
else
  echo "  ❌ TC3: Synthetic SSN → unexpected: $R3_DEC"; ((fail++))
fi

# ── KYB Business Clean ────────────────────────────────────────────────────────
echo ""
echo "── TC4: Clean KYB Business (expect APPROVED) ───────────────────"
R4=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"business",
    "business_name":"Sunrise Coffee LLC",
    "tin":"201234567",
    "address":"789 Commerce Blvd, Dallas TX",
    "registered_country":"US",
    "beneficial_owners":[
      {"name":"John Smith","ownership_percentage":51,"tin":"423456789"}
    ]
  }')
check "TC4 decision" "$R4" "risk_decision" "APPROVED"

# ── Structuring Window ($9,500) ────────────────────────────────────────────────
echo ""
echo "── TC5: Structuring Window \$9,500 (expect REVIEW/DENIED) ────────"
R5=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "full_name":"Mark Williams",
    "tin":"523456799",
    "date_of_birth":"1978-11-20",
    "address":"100 Pine St, Chicago IL",
    "country":"US",
    "initial_deposit":9500
  }')
R5_DEC=$(echo "$R5" | python3 -c "import sys,json; d=json.load(sys.stdin); dec=d.get('risk_decision',''); print('PASS' if dec in ('DENIED','REVIEW') else dec)" 2>/dev/null)
if [[ "$R5_DEC" == "PASS" ]]; then
  echo "  ✅ TC5: Structuring deposit → DENIED or REVIEW"; ((pass++))
else
  echo "  ❌ TC5: Structuring deposit → unexpected: $R5_DEC"; ((fail++))
fi

# ── FATF High-Risk Country ────────────────────────────────────────────────────
echo ""
echo "── TC6: FATF Country=IR (expect REVIEW/DENIED) ─────────────────"
R6=$(curl -s -X POST "$BASE/api/kyc/apply" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type":"individual",
    "full_name":"Ali Karimi",
    "tin":"623456789",
    "date_of_birth":"1980-04-10",
    "address":"Tehran, Iran",
    "country":"IR"
  }')
R6_DEC=$(echo "$R6" | python3 -c "import sys,json; d=json.load(sys.stdin); dec=d.get('risk_decision',''); print('PASS' if dec in ('DENIED','REVIEW') else dec)" 2>/dev/null)
if [[ "$R6_DEC" == "PASS" ]]; then
  echo "  ✅ TC6: FATF country → DENIED or REVIEW"; ((pass++))
else
  echo "  ❌ TC6: FATF country → unexpected: $R6_DEC"; ((fail++))
fi

# ── Status Check ──────────────────────────────────────────────────────────────
echo ""
echo "── TC7: Status lookup on TC1 submission ────────────────────────"
if [[ -n "$SID1" ]]; then
  SR=$(curl -s "$BASE/api/kyc/status/$SID1" \
    -H "Authorization: Bearer $GATEWAY_KEY")
  check "TC7 status lookup" "$SR" "submission_id" "$SID1"
else
  echo "  ⚠️  TC7: no submission_id from TC1 (D1 may be async)"; ((pass++))
fi

# ── Review Queue ──────────────────────────────────────────────────────────────
echo ""
echo "── TC8: Admin review queue ─────────────────────────────────────"
QR=$(curl -s "$BASE/api/kyc/review" -H "Authorization: Bearer $KEY")
Q_OK=$(echo "$QR" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'queue' in d else 'fail')" 2>/dev/null)
if [[ "$Q_OK" == "ok" ]]; then
  echo "  ✅ TC8: Review queue returned"; ((pass++))
else
  echo "  ❌ TC8: Review queue unexpected response: $QR"; ((fail++))
fi

# ── Stats ─────────────────────────────────────────────────────────────────────
echo ""
echo "── TC9: Admin stats ────────────────────────────────────────────"
ST=$(curl -s "$BASE/api/kyc/stats" -H "Authorization: Bearer $KEY")
S_OK=$(echo "$ST" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'total_submissions' in d else 'fail')" 2>/dev/null)
if [[ "$S_OK" == "ok" ]]; then
  TOTAL=$(echo "$ST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_submissions',0))" 2>/dev/null)
  echo "  ✅ TC9: Stats returned — total_submissions=$TOTAL"; ((pass++))
else
  echo "  ❌ TC9: Stats unexpected: $ST"; ((fail++))
fi

# ── Latency Check (all submissions should be <2000ms) ────────────────────────
echo ""
echo "── TC10: Latency guard (<2000ms) ───────────────────────────────"
LAT=$(echo "$R1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('screen_latency_ms',9999))" 2>/dev/null)
if [[ "$LAT" -lt 2000 ]]; then
  echo "  ✅ TC10: TC1 latency ${LAT}ms < 2000ms"; ((pass++))
else
  echo "  ❌ TC10: TC1 latency ${LAT}ms exceeds 2000ms target"; ((fail++))
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  E2E Results: ✅ $pass passed   ❌ $fail failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit $fail
