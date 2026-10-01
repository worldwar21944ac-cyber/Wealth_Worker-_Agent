#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AI Search Worker v3.0 — Deploy Script
# Usage:  CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="ai-search"
ZONE_ID="525461af7dfa6b8bbe5f8f7d465602a0"        # wwwknockoutforever.com
CUSTOM_DOMAIN="ai-search.wwwknockoutforever.com"
D1_ID="f2fe6105-b552-42b4-a2ca-9d2a349861da"
VECTORIZE_INDEX="ai-search-index"
ADMIN_KEY="${SEARCH_ADMIN_KEY:-search-admin-bervashun-2026}"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_JS="$DIR/worker.js"

echo "🚀  Deploying $WORKER_NAME v3.0 …"

# ── 1. Build metadata ────────────────────────────────────────────────────────
cat > /tmp/ai-search-meta.json <<EOF
{
  "main_module": "worker.js",
  "bindings": [
    {"type": "ai",        "name": "AI"},
    {"type": "vectorize", "name": "VECTORIZE", "index_name": "$VECTORIZE_INDEX"},
    {"type": "d1",        "name": "SEARCH_DB",  "id": "$D1_ID"}
  ],
  "compatibility_date": "2026-09-02"
}
EOF

# ── 2. Upload Worker ─────────────────────────────────────────────────────────
echo "   Uploading worker script…"
UPLOAD=$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=</tmp/ai-search-meta.json;type=application/json" \
  -F "worker.js=@${WORKER_JS};type=application/javascript+module")

OK=$(echo "$UPLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null || echo "false")
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  echo "❌ Upload failed:"
  echo "$UPLOAD" | python3 -m json.tool 2>/dev/null || echo "$UPLOAD"
  exit 1
fi

ETAG=$(echo "$UPLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'].get('etag','?'))" 2>/dev/null || echo "?")
echo "   ✅ Uploaded — etag: $ETAG"

# ── 3. Set admin key secret ─────────────────────────────────────────────────
echo "   Setting SEARCH_ADMIN_KEY secret…"
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"SEARCH_ADMIN_KEY\",\"text\":\"${ADMIN_KEY}\",\"type\":\"secret_text\"}" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('   secret ok' if d.get('success') else '   secret err: '+str(d))" 2>/dev/null || true

# ── 4. Ensure custom domain route ────────────────────────────────────────────
echo "   Checking custom domain route…"
ROUTES=$(curl -sS \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

HAS_ROUTE=$(echo "$ROUTES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
routes=d.get('result',[])
print('yes' if any(r.get('pattern','').startswith('ai-search') for r in routes) else 'no')
" 2>/dev/null || echo "no")

if [ "$HAS_ROUTE" = "no" ]; then
  echo "   Creating zone route…"
  curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"pattern\":\"${CUSTOM_DOMAIN}/*\",\"script\":\"${WORKER_NAME}\"}" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('   route ok' if d.get('success') else '   route err: '+str(d))" 2>/dev/null || true
fi

# ── 5. Health check ──────────────────────────────────────────────────────────
echo "   Health check…"
sleep 3
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "https://${CUSTOM_DOMAIN}/health" || echo "000")
if [ "$HTTP" = "200" ]; then
  echo "   ✅ Health check passed (HTTP $HTTP)"
else
  echo "   ⚠️  Health check returned HTTP $HTTP — worker may still be propagating"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  AI Search v3.0 deployed!"
echo "  UI:     https://${CUSTOM_DOMAIN}/"
echo "  API:    https://${CUSTOM_DOMAIN}/search"
echo "  Health: https://${CUSTOM_DOMAIN}/health"
echo "  Admin:  X-Search-Admin-Key: ${ADMIN_KEY}"
echo "═══════════════════════════════════════════════════════"
