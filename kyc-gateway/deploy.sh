#!/usr/bin/env bash
# kyc-gateway v8.1 — Deploy Script
# Usage: CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
set -euo pipefail

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="kyc-gateway"
SCRIPT="worker.js"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔐 Deploying ${WORKER_NAME} v8.1 to account ${ACCOUNT_ID}..."

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌ CLOUDFLARE_API_TOKEN is not set. Aborting."
  exit 1
fi

# Deploy via Wrangler (preferred — handles multipart module upload)
if command -v npx &>/dev/null; then
  echo "📦 Using wrangler via npx..."
  cd "$DIR"
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    npx wrangler@latest deploy \
    --name "$WORKER_NAME" \
    --compatibility-date 2026-09-02 \
    --account-id "$ACCOUNT_ID" \
    "$SCRIPT"
else
  echo "📦 Falling back to direct Cloudflare API upload (multipart)..."

  METADATA=$(cat <<'EOF'
{
  "main_module": "worker.js",
  "bindings": [
    {
      "type": "d1",
      "name": "AUDIT_DB",
      "id": "f2fe6105-b552-42b4-a2ca-9d2a349861da"
    },
    {
      "type": "kv_namespace",
      "name": "KYC_SANCTIONS",
      "namespace_id": "203d064ff04b45d9b15a363aa18427be"
    },
    {
      "type": "kv_namespace",
      "name": "GATEWAY_AUTH",
      "namespace_id": "06af84f811b84abbb1d956b639d0cd07"
    }
  ],
  "compatibility_date": "2026-09-02",
  "usage_model": "standard"
}
EOF
)

  RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
    -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -F "metadata=${METADATA};type=application/json" \
    -F "worker.js=@${DIR}/${SCRIPT};type=application/javascript+module")

  HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
  BODY=$(echo "$RESPONSE" | grep -v "HTTP_STATUS:")

  if [[ "$HTTP_STATUS" == "200" ]]; then
    ETAG=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'].get('etag','unknown'))" 2>/dev/null || echo "unknown")
    echo "✅ Deployed successfully. etag: ${ETAG}"
  else
    echo "❌ Deploy failed. HTTP ${HTTP_STATUS}"
    echo "$BODY"
    exit 1
  fi
fi

echo ""
echo "🚀 kyc-gateway v8.1 is live at:"
echo "   POST https://kyc.wwwknockoutforever.com/api/kyc/apply"
echo "   GET  https://kyc.wwwknockoutforever.com/api/kyc/health"
echo ""
echo "Health check:"
curl -s https://kyc.wwwknockoutforever.com/api/kyc/health | python3 -m json.tool 2>/dev/null || echo "(health check skipped — no network)"
