#!/usr/bin/env bash
# ============================================================
#  KYC-Gateway v11.0 — Cloudflare Worker Deploy Script
#  Deploys via direct multipart PUT to Cloudflare API
#  Usage: CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
# ============================================================
set -euo pipefail

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="kyc-gateway"
SCRIPT_FILE="./worker.js"
COMPAT_DATE="2026-09-02"
CF_API="https://api.cloudflare.com/client/v4"

# ── Validate environment ──────────────────────────────────────
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌  CLOUDFLARE_API_TOKEN is not set." >&2
  echo "    Export it: export CLOUDFLARE_API_TOKEN=<your-token>" >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_FILE" ]]; then
  echo "❌  worker.js not found at $SCRIPT_FILE" >&2
  exit 1
fi

echo "🚀  Deploying $WORKER_NAME to account $ACCOUNT_ID ..."
echo "    Script : $SCRIPT_FILE"
echo "    Compat : $COMPAT_DATE"
echo ""

# ── Build metadata JSON ───────────────────────────────────────
METADATA=$(cat <<METAEOF
{
  "main_module": "worker.js",
  "compatibility_date": "${COMPAT_DATE}",
  "compatibility_flags": [],
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
    },
    {
      "type": "secret_text",
      "name": "KYC_ADMIN_KEY",
      "text": "${KYC_ADMIN_KEY:-REPLACE_ME}"
    },
    {
      "type": "secret_text",
      "name": "NOTIFIER_TOKEN",
      "text": "${NOTIFIER_TOKEN:-REPLACE_ME}"
    }
  ],
  "observability": { "enabled": true },
  "migrations": null,
  "placement": null,
  "tail_consumers": null,
  "usage_model": "bundled"
}
METAEOF
)

# ── Upload via multipart PUT ──────────────────────────────────
echo "📤  Uploading script ..."

RESPONSE=$(curl -sS -X PUT \
  "${CF_API}/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=@-;type=application/json" \
  -F "worker.js=@${SCRIPT_FILE};type=application/javascript+module" \
  <<< "${METADATA}")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null || echo "false")

if [[ "$SUCCESS" == "True" ]] || [[ "$SUCCESS" == "true" ]]; then
  echo ""
  echo "✅  Worker deployed successfully!"
  echo ""
  ETAG=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('etag','n/a'))" 2>/dev/null || echo "n/a")
  echo "    ETag       : $ETAG"
  echo "    Worker URL : https://kyc-gateway.${ACCOUNT_ID}.workers.dev"
  echo "    Custom URL : https://kyc.wwwknockoutforever.com"
else
  echo ""
  echo "❌  Deployment failed. Response:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

# ── Verify deployment with health check ───────────────────────
echo ""
echo "🏥  Verifying deployment (health check) ..."
sleep 3

HEALTH=$(curl -sf --max-time 10 \
  "https://kyc-gateway.${ACCOUNT_ID}.workers.dev/api/kyc/health" \
  -H "Accept: application/json" 2>/dev/null || echo '{"status":"unreachable"}')

STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")

if [[ "$STATUS" == "ok" ]]; then
  VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
  echo "✅  Health check passed — version: $VERSION"
else
  echo "⚠️   Health check returned: $STATUS (deployment may still be propagating)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Post-deploy checklist:"
echo "  1. Set secrets (if not already):"
echo "     wrangler secret put KYC_ADMIN_KEY"
echo "     wrangler secret put NOTIFIER_TOKEN"
echo "  2. Seed GATEWAY_AUTH KV:"
echo "     wrangler kv key put --binding=GATEWAY_AUTH apikey:<your-key> 'active'"
echo "  3. Seed KYC_SANCTIONS KV (sdn:index, pep:index, fincen:314a, sdn:delta:7d)"
echo "     Example: wrangler kv key put --binding=KYC_SANCTIONS sdn:index '[]'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
