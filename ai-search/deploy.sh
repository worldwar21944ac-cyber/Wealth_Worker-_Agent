#!/usr/bin/env bash
# deploy.sh — ai-search Worker deployment
# Usage: CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
set -euo pipefail

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="ai-search"
ZONE_ID="525461af7dfa6b8bbe5f8f7d465602a0"

echo "━━━ Step 1: Create Vectorize index (skip if exists) ━━━"
npx wrangler vectorize create ai-search-index \
  --dimensions=768 \
  --metric=cosine \
  --account-id="${ACCOUNT_ID}" 2>/dev/null || echo "  → Index already exists, continuing."

echo ""
echo "━━━ Step 2: Create D1 search_documents table ━━━"
npx wrangler d1 execute bervashun-audit \
  --account-id="${ACCOUNT_ID}" \
  --command="CREATE TABLE IF NOT EXISTS search_documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    source      TEXT,
    category    TEXT,
    metadata    TEXT,
    indexed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );" 2>/dev/null || echo "  → Table already exists, continuing."

echo ""
echo "━━━ Step 3: Deploy Worker ━━━"
npx wrangler deploy \
  --name="${WORKER_NAME}" \
  --compatibility-date=2026-09-02 \
  --account-id="${ACCOUNT_ID}"

echo ""
echo "━━━ Step 4: Set SEARCH_ADMIN_KEY secret ━━━"
if [ -n "${SEARCH_ADMIN_KEY:-}" ]; then
  echo "${SEARCH_ADMIN_KEY}" | npx wrangler secret put SEARCH_ADMIN_KEY \
    --name="${WORKER_NAME}" --account-id="${ACCOUNT_ID}"
else
  echo "  ⚠ SEARCH_ADMIN_KEY env var not set — skipping. Set manually:"
  echo "    echo '<key>' | npx wrangler secret put SEARCH_ADMIN_KEY --name ai-search"
fi

echo ""
echo "━━━ Step 5: Add custom domain ai-search.wwwknockoutforever.com ━━━"
ZONE_ID_WWW="525461af7dfa6b8bbe5f8f7d465602a0"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/domains" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"hostname\":\"ai-search.wwwknockoutforever.com\",\"zone_id\":\"${ZONE_ID_WWW}\",\"service\":\"${WORKER_NAME}\",\"environment\":\"production\"}" \
  | python3 -m json.tool 2>/dev/null || true

echo ""
echo "✅ Done! Worker deployed at:"
echo "   https://ai-search.wwwknockoutforever.workers.dev"
echo "   https://ai-search.wwwknockoutforever.com (custom domain, may take ~30s)"
echo ""
echo "📡 Quick test:"
echo "   curl https://ai-search.wwwknockoutforever.com/health"
