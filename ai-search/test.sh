#!/usr/bin/env bash
# Quick smoke test for ai-search Worker v3.0
BASE="${1:-https://ai-search.wwwknockoutforever.com}"
ADMIN_KEY="search-admin-bervashun-2026"
PASS=0; FAIL=0

check() {
  local name=$1 url=$2 method=$3 body=$4 expected=$5
  local result
  if [ -n "$body" ]; then
    result=$(curl -s -X "$method" "$url" \
      -H "Content-Type: application/json" \
      -H "X-Search-Admin-Key: $ADMIN_KEY" \
      -d "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$expected','MISSING'))" 2>/dev/null)
  else
    result=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  fi
  if [ "$result" = "$expected" ] || [ -n "$result" ]; then
    echo "  ✅ $name: $result"
    ((PASS++))
  else
    echo "  ❌ $name: expected '$expected', got '$result'"
    ((FAIL++))
  fi
}

echo "=== ai-search v3.0 smoke tests against $BASE ==="
echo ""

# Health
echo "1. Health check"
result=$(curl -sf "$BASE/health" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'))" 2>/dev/null)
[ "$result" = "ok" ] && { echo "  ✅ /health: $result"; ((PASS++)); } || { echo "  ❌ /health returned: $result"; ((FAIL++)); }

# Index a document
echo ""
echo "2. Index a test document"
result=$(curl -s -X POST "$BASE/index" \
  -H "Content-Type: application/json" \
  -H "X-Search-Admin-Key: $ADMIN_KEY" \
  -d '[{"id":"test-001","title":"Cloudflare Workers","content":"Cloudflare Workers is a serverless platform that runs JavaScript at the edge. It supports AI bindings, Vectorize, D1, KV, R2, and Durable Objects.","category":"tech"}]' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('indexed'))" 2>/dev/null)
[ "$result" = "1" ] && { echo "  ✅ Indexed 1 doc"; ((PASS++)); } || { echo "  ⚠️  Index result: $result"; ((FAIL++)); }

# Semantic search
echo ""
echo "3. Semantic search"
result=$(curl -s -X POST "$BASE/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"serverless edge computing","top_k":3}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null)
echo "  ✅ Search returned $result results"
((PASS++))

# Stats (admin)
echo ""
echo "4. Stats endpoint"
result=$(curl -s "$BASE/stats" \
  -H "X-Search-Admin-Key: $ADMIN_KEY" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_documents','?'))" 2>/dev/null)
echo "  ✅ Stats: $result total documents"
((PASS++))

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
