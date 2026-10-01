#!/usr/bin/env bash
# Manual deploy script for ai-search worker
# Usage: CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
set -e

ACCOUNT_ID="fd6f05d3bbca4cc5f175ca4f7154552b"
WORKER_NAME="ai-search"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating Vectorize index (skip if exists)"
npx wrangler@latest vectorize create ai-search-index \
  --dimensions=768 \
  --metric=cosine \
  --description="AI Search semantic index" 2>/dev/null || echo "Index already exists"

echo "==> Deploying $WORKER_NAME"
cd "$DIR"
CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
npx wrangler@latest deploy

echo "==> Setting SEARCH_ADMIN_KEY (optional — skip with SKIP_SECRET=1)"
if [ -z "$SKIP_SECRET" ] && [ -n "$SEARCH_ADMIN_KEY" ]; then
  echo "$SEARCH_ADMIN_KEY" | \
  CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  npx wrangler@latest secret put SEARCH_ADMIN_KEY --name "$WORKER_NAME"
  echo "Secret set."
fi

echo ""
echo "✅ Done. Test with:"
echo "   curl https://ai-search.wwwknockoutforever.com/health"
