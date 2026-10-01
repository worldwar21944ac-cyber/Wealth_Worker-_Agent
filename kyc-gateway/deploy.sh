#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="kyc-gateway"
CF_API="https://api.cloudflare.com/client/v4"

echo "▶ kyc-gateway v8.0 — Deploy"
echo "  Account : $ACCOUNT_ID"
echo "  Worker  : $WORKER_NAME"
echo ""

# ── 1. Validate token ────────────────────────────────────────────────────────
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "❌  CLOUDFLARE_API_TOKEN not set"
  exit 1
fi

echo "✔ Token present"

# ── 2. Build metadata JSON ───────────────────────────────────────────────────
META=$(cat <<'EOF'
{
  "main_module": "worker.js",
  "compatibility_date": "2026-09-02",
  "usage_model": "standard",
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
  ]
}
EOF
)

# ── 3. Deploy ────────────────────────────────────────────────────────────────
echo "▶ Uploading worker script..."

RESPONSE=$(curl -sS -X PUT \
  "$CF_API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@-;type=application/json" <<< "$META" \
  -F "worker.js=@$SCRIPT_DIR/worker.js;type=application/javascript+module")

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success',False)).lower())" 2>/dev/null || echo "false")

if [[ "$SUCCESS" == "true" ]]; then
  ETAG=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'].get('etag','N/A'))" 2>/dev/null || echo "N/A")
  echo "✅  Deployed!  etag=$ETAG"
else
  echo "❌  Deploy failed:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

# ── 4. Verify health ─────────────────────────────────────────────────────────
echo ""
echo "▶ Checking health endpoint..."
sleep 2
HEALTH=$(curl -sf "https://kyc.wwwknockoutforever.com/api/kyc/health" 2>/dev/null || echo '{"error":"unreachable"}')
echo "$HEALTH"

echo ""
echo "═══════════════════════════════════════════════"
echo "  kyc-gateway v8.0 deployed ✅"
echo "  Custom domain: kyc.wwwknockoutforever.com"
echo "═══════════════════════════════════════════════"
