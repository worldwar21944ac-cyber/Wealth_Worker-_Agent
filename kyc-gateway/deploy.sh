#!/usr/bin/env bash
# deploy.sh — kyc-gateway v7.0 full deploy + KV seed
set -euo pipefail

CF_ACCOUNT="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="kyc-gateway"
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"

if [[ -z "$CF_TOKEN" ]]; then
  echo "❌  CLOUDFLARE_API_TOKEN or CF_API_TOKEN required"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  kyc-gateway v7.0 — Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Run unit tests ────────────────────────────────────────────────────────
echo ""
echo "Step 1: Running unit test suite..."
node "$DIR/unit_test.js"

# ── 2. Deploy via Versions API ───────────────────────────────────────────────
echo ""
echo "Step 2: Deploying worker via CF Versions API..."

SCRIPT_CONTENT=$(cat "$DIR/worker.js")

DEPLOY_RESPONSE=$(curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${WORKER_NAME}/versions" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-09-02\",\"bindings\":[{\"name\":\"AUDIT_DB\",\"type\":\"d1\",\"id\":\"f2fe6105-b552-42b4-a2ca-9d2a349861da\"},{\"name\":\"KYC_SANCTIONS\",\"type\":\"kv_namespace\",\"namespace_id\":\"203d064ff04b45d9b15a363aa18427be\"},{\"name\":\"GATEWAY_AUTH\",\"type\":\"kv_namespace\",\"namespace_id\":\"06af84f811b84abbb1d956b639d0cd07\"}]};type=application/json" \
  -F "worker.js=${SCRIPT_CONTENT};type=application/javascript+module")

echo "$DEPLOY_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('success'):
  r = data.get('result', {})
  print(f'  ✅ Deployed: {r.get(\"id\",\"?\")[:16]}...')
  print(f'  etag      : {r.get(\"metadata\",{}).get(\"etag\",\"?\")}')
else:
  print('  ❌ Deploy failed:')
  for e in data.get('errors', []):
    print(f'     {e}')
  sys.exit(1)
"

# ── 3. Promote to production ─────────────────────────────────────────────────
echo ""
echo "Step 3: Promoting to production..."

VERSION_ID=$(echo "$DEPLOY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('id',''))")

if [[ -n "$VERSION_ID" ]]; then
  PROMOTE=$(curl -s -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${WORKER_NAME}/deployments/by-script" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"versions\":[{\"version_id\":\"${VERSION_ID}\",\"percentage\":100}],\"strategy\":\"percentage\"}")
  echo "$PROMOTE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('success'): print('  ✅ Production traffic → v7.0 (100%)')
else:
  print('  ⚠️  Promotion may need manual rollout:')
  for e in d.get('errors',[]): print(f'     {e}')
"
fi

# ── 4. Seed KV ───────────────────────────────────────────────────────────────
echo ""
echo "Step 4: Seeding KV sanctions lists..."
CF_API_TOKEN="${CF_TOKEN}" node "$DIR/seed_kv.js"

# ── 5. Health check ──────────────────────────────────────────────────────────
echo ""
echo "Step 5: Health check..."
sleep 2
HEALTH=$(curl -s https://kyc.wwwknockoutforever.com/api/kyc/health 2>/dev/null || echo '{"status":"timeout"}')
echo "  $HEALTH"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  kyc-gateway v7.0 deploy complete ✅"
echo "  Endpoint: https://kyc.wwwknockoutforever.com/api/kyc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
