#!/usr/bin/env bash
# kyc-gateway v9.0 — deploy via Cloudflare API multipart PUT
# Usage: CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
set -euo pipefail

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="kyc-gateway"
SCRIPT="worker.js"
CF_API="https://api.cloudflare.com/client/v4"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌  CLOUDFLARE_API_TOKEN is not set"; exit 1
fi

echo "🚀  Deploying $WORKER_NAME v9.0 ..."

METADATA=$(cat <<'EOF'
{
  "main_module": "worker.js",
  "compatibility_date": "2026-09-02",
  "bindings": [
    { "type": "d1",  "name": "AUDIT_DB",      "id": "f2fe6105-b552-42b4-a2ca-9d2a349861da" },
    { "type": "kv_namespace", "name": "KYC_SANCTIONS", "namespace_id": "203d064ff04b45d9b15a363aa18427be" },
    { "type": "kv_namespace", "name": "GATEWAY_AUTH",  "namespace_id": "06af84f811b84abbb1d956b639d0cd07" }
  ]
}
EOF
)

HTTP_STATUS=$(curl -s -o /tmp/cf_deploy_out.json -w "%{http_code}" \
  -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@${SCRIPT};type=application/javascript+module")

if [[ "$HTTP_STATUS" == "200" ]]; then
  ETAG=$(jq -r '.result.etag // "n/a"' /tmp/cf_deploy_out.json)
  echo "✅  Deployed! etag: $ETAG"
else
  echo "❌  Deploy failed (HTTP $HTTP_STATUS)"
  cat /tmp/cf_deploy_out.json
  exit 1
fi
