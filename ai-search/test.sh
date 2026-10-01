#!/usr/bin/env bash
# test.sh — ai-search end-to-end smoke test
# Usage: SEARCH_ADMIN_KEY=<key> BASE_URL=https://ai-search.wwwknockoutforever.com bash test.sh
set -euo pipefail

BASE="${BASE_URL:-https://ai-search.wwwknockoutforever.com}"
ADMIN_KEY="${SEARCH_ADMIN_KEY:-ai-search-sovereign-2026}"

echo "🔍 Testing ai-search at $BASE"
echo ""

# 1. Health
echo "1️⃣  GET /health"
curl -sf "$BASE/health" | python3 -m json.tool
echo ""

# 2. Root info
echo "2️⃣  GET /"
curl -sf "$BASE/" | python3 -m json.tool
echo ""

# 3. Index a document
echo "3️⃣  POST /index — ingest 2 documents"
curl -sf -X POST "$BASE/index" \
  -H "Content-Type: application/json" \
  -H "X-Search-Admin-Key: $ADMIN_KEY" \
  -d '[
    {
      "id": "doc-001",
      "title": "Bervashun Trust Capital Overview",
      "content": "Bervashun Trust Capital is a sovereign financial technology platform built on Cloudflare Workers. It integrates with Unit for banking-as-a-service, enabling KYC, virtual cards, and ACH transfers. The platform uses AI to screen customers and detect fraud.",
      "source": "internal",
      "category": "fintech"
    },
    {
      "id": "doc-002",
      "title": "KYC Gateway Documentation",
      "content": "The KYC Gateway v6.0 implements 16 screening engines including OFAC SDN, PEP, FATF country risk, TIN/EIN validation, structuring detection, adverse media, and synthetic identity detection. Decisions are APPROVED (0-29), REVIEW (30-69), or DENIED (70-100).",
      "source": "internal",
      "category": "compliance"
    }
  ]' | python3 -m json.tool
echo ""

# 4. Semantic search
echo "4️⃣  POST /search — semantic search"
curl -sf -X POST "$BASE/search" \
  -H "Content-Type: application/json" \
  -d '{"query": "how does KYC screening work?", "top_k": 3}' \
  | python3 -m json.tool
echo ""

# 5. GET search
echo "5️⃣  GET /search?q= — browser-style search"
curl -sf "$BASE/search?q=banking+ACH+transfers" | python3 -m json.tool
echo ""

# 6. RAG ask
echo "6️⃣  POST /ai/ask — RAG question"
curl -sf -X POST "$BASE/ai/ask" \
  -H "Content-Type: application/json" \
  -d '{"question": "What risk score leads to a DENIED decision in KYC?"}' \
  | python3 -m json.tool
echo ""

# 7. List documents
echo "7️⃣  GET /documents — list indexed"
curl -sf "$BASE/documents" \
  -H "X-Search-Admin-Key: $ADMIN_KEY" \
  | python3 -m json.tool
echo ""

echo "✅ All tests complete."
