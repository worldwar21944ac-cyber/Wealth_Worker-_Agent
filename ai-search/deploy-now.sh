#!/usr/bin/env bash
#
# ai-search Worker v3.0 — One-shot deploy script
# Run from your terminal: bash deploy-now.sh <YOUR_CF_API_TOKEN>
#
set -euo pipefail

ACCOUNT="fd6f05d3bbca4cc5f175ca4f7154552b"
ZONE="525461af7dfa6b8bbe5f8f7d465602a0"
WORKER="ai-search"
DOMAIN="ai-search.wwwknockoutforever.com"
D1_ID="f2fe6105-b552-42b4-a2ca-9d2a349861da"
CF_API="https://api.cloudflare.com/client/v4"

# Get token from arg or env
CF_TOKEN="${1:-${CLOUDFLARE_API_TOKEN:-}}"
if [ -z "$CF_TOKEN" ]; then
  echo "Usage: bash deploy-now.sh <CLOUDFLARE_API_TOKEN>"
  echo "   or: CLOUDFLARE_API_TOKEN=xxx bash deploy-now.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH=(-H "Authorization: Bearer ${CF_TOKEN}")

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ai-search Worker v3.0 — Deploy Script  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Create Vectorize index ──────────────────────────────────────────
echo "1. Creating Vectorize index (ai-search-index)..."
INDEX_RES=$(curl -s -X POST \
  "${CF_API}/accounts/${ACCOUNT}/vectorize/v2/indexes" \
  "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name":"ai-search-index","config":{"dimensions":768,"metric":"cosine"}}')
INDEX_OK=$(echo "$INDEX_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success'))")
if [ "$INDEX_OK" = "True" ]; then
  echo "   ✅ Vectorize index created."
else
  ERR=$(echo "$INDEX_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errors',[{}])[0].get('message','?'))")
  if echo "$ERR" | grep -qi "already exist"; then
    echo "   ✅ Vectorize index already exists."
  else
    echo "   ⚠️  Vectorize: $ERR (continuing anyway)"
  fi
fi

# ── Step 2: Deploy Worker (multipart PUT) ───────────────────────────────────
echo ""
echo "2. Deploying worker..."
METADATA=$(python3 -c "
import json
m = {
  'main_module': 'worker.js',
  'compatibility_date': '2026-09-02',
  'bindings': [
    {'type': 'ai', 'name': 'AI'},
    {'type': 'vectorize', 'name': 'VECTORIZE', 'index_name': 'ai-search-index'},
    {'type': 'd1', 'name': 'SEARCH_DB', 'id': 'f2fe6105-b552-42b4-a2ca-9d2a349861da'},
    {'type': 'secret_text', 'name': 'SEARCH_ADMIN_KEY', 'text': 'search-admin-bervashun-2026'}
  ]
}
print(json.dumps(m))
")

DEPLOY_RES=$(curl -s -X PUT \
  "${CF_API}/accounts/${ACCOUNT}/workers/scripts/${WORKER}" \
  "${AUTH[@]}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@${SCRIPT_DIR}/worker.js;type=application/javascript+module")

DEPLOY_OK=$(echo "$DEPLOY_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success'))")
if [ "$DEPLOY_OK" = "True" ]; then
  ETAG=$(echo "$DEPLOY_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('etag','?'))" 2>/dev/null)
  echo "   ✅ Worker deployed! etag: $ETAG"
else
  echo "   ❌ Deploy failed:"
  echo "$DEPLOY_RES" | python3 -m json.tool
  exit 1
fi

# ── Step 3: Custom domain ────────────────────────────────────────────────────
echo ""
echo "3. Setting up custom domain (${DOMAIN})..."
DOMAIN_RES=$(curl -s -X PUT \
  "${CF_API}/accounts/${ACCOUNT}/workers/domains" \
  "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"hostname\":\"${DOMAIN}\",\"service\":\"${WORKER}\",\"environment\":\"production\",\"zone_id\":\"${ZONE}\"}")
DOMAIN_OK=$(echo "$DOMAIN_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success'))" 2>/dev/null)
if [ "$DOMAIN_OK" = "True" ]; then
  echo "   ✅ Custom domain configured."
else
  echo "   ⚠️  Domain response: $(echo "$DOMAIN_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errors','?'))" 2>/dev/null)"
fi

# ── Step 4: Health check ─────────────────────────────────────────────────────
echo ""
echo "4. Health check..."
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  BODY=$(curl -s "https://${DOMAIN}/health" 2>/dev/null)
  echo "   ✅ Live! $BODY"
else
  echo "   ⚠️  HTTP $HTTP_CODE (DNS may take 30-60s to propagate)"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  🎉 ai-search v3.0 deployed!"
echo ""
echo "  Endpoints:"
echo "  GET  https://${DOMAIN}/health"
echo "  POST https://${DOMAIN}/search         { query, top_k, threshold, category }"
echo "  GET  https://${DOMAIN}/search?q=..."
echo "  POST https://${DOMAIN}/index          (admin: X-Search-Admin-Key)"
echo "  POST https://${DOMAIN}/ai/ask         { question, top_k, category }"
echo "  GET  https://${DOMAIN}/stats          (admin)"
echo "  GET  https://${DOMAIN}/documents      (admin)"
echo ""
echo "  Admin key: search-admin-bervashun-2026"
echo "══════════════════════════════════════════"
