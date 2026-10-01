#!/usr/bin/env bash
# Smoke test for ai-search worker
# Usage: SEARCH_ADMIN_KEY=<key> bash test.sh [BASE_URL]
set -e

BASE="${1:-https://ai-search.wwwknockoutforever.com}"
KEY="${SEARCH_ADMIN_KEY:-}"

if [ -z "$KEY" ]; then
  echo "ERROR: SEARCH_ADMIN_KEY is required"
  exit 1
fi

pass=0; fail=0

check() {
  local label="$1"; local expected="$2"; local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅  $label"
    ((pass++)) || true
  else
    echo "  ❌  $label — expected '$expected' in: $actual"
    ((fail++)) || true
  fi
}

echo "=== ai-search smoke test ==="
echo "Base URL: $BASE"
echo ""

# 1. Health
echo "[1] GET /health"
RES=$(curl -sf "$BASE/health")
check "status=ok"      '"status"' "$RES"
check "version=1.1"    '"1.1"'    "$RES"

# 2. Ingest one doc
echo "[2] POST /index — ingest test doc"
RES=$(curl -sf -X POST "$BASE/index" \
  -H "Content-Type: application/json" \
  -H "X-Search-Admin-Key: $KEY" \
  -d '[{"title":"Bervashun Trust Capital","content":"Bervashun Trust Capital is a financial technology company providing digital banking services via the Unit platform, including KYC screening, virtual accounts, and card issuing.","category":"fintech"}]')
check "indexed=1"  '"indexed"' "$RES"
DOC_ID=$(echo "$RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "   doc_id: $DOC_ID"

# 3. Semantic search
echo "[3] POST /search"
RES=$(curl -sf -X POST "$BASE/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"digital banking KYC","top_k":3}')
check "results array" '"results"' "$RES"

# 4. GET search
echo "[4] GET /search?q=virtual+accounts"
RES=$(curl -sf "$BASE/search?q=virtual+accounts&top_k=3")
check "results array" '"results"' "$RES"

# 5. RAG ask
echo "[5] POST /ai/ask"
RES=$(curl -sf -X POST "$BASE/ai/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"What services does Bervashun Trust Capital provide?"}')
check "answer field"   '"answer"'  "$RES"
check "sources field"  '"sources"' "$RES"

# 6. List documents
echo "[6] GET /documents"
RES=$(curl -sf "$BASE/documents" \
  -H "X-Search-Admin-Key: $KEY")
check "documents array" '"documents"' "$RES"

# 7. Delete doc
if [ -n "$DOC_ID" ]; then
  echo "[7] DELETE /index/:id"
  RES=$(curl -sf -X DELETE "$BASE/index/$DOC_ID" \
    -H "X-Search-Admin-Key: $KEY")
  check "deleted id" '"deleted"' "$RES"
fi

echo ""
echo "=== Results: $pass passed, $fail failed ==="
[ "$fail" -eq 0 ] && exit 0 || exit 1
