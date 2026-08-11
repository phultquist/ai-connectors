#!/usr/bin/env bash
#
# One-command Cloudflare setup for the 7shifts connector.
#
#   ./scripts/deploy.sh
#
# Creates the KV tenant store, generates and stores the admin secret, deploys
# the Worker, and patches the plugin so customers get the right URL by default.
# Safe to re-run: each step is skipped if it is already done.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
PLUGIN_MCP="$ROOT/plugins/sevenshifts/.mcp.json"
SECRETS_FILE="$HOME/.sevenshifts-connector-admin"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
info() { printf "  → %s\n" "$1"; }

bold "1. Cloudflare account"
if ! npx wrangler whoami >/dev/null 2>&1 || npx wrangler whoami 2>&1 | grep -q "not authenticated"; then
  info "Opening a browser to log in to Cloudflare…"
  npx wrangler login
fi
ok "authenticated as $(npx wrangler whoami 2>/dev/null | grep -oE '[^ ]+@[^ ]+' | head -1 || echo 'cloudflare user')"

bold "2. Tenant store (KV)"
if grep -q "REPLACE_WITH_KV_NAMESPACE_ID" wrangler.toml; then
  info "Creating KV namespace TENANTS…"
  OUT="$(npx wrangler kv namespace create TENANTS 2>&1)" || { echo "$OUT"; exit 1; }
  KV_ID="$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$KV_ID" ]; then
    echo "$OUT"
    echo "Could not parse the namespace id. Paste it into wrangler.toml manually."
    exit 1
  fi
  # BSD/GNU-portable in-place edit.
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml && rm -f wrangler.toml.bak
  ok "created and bound ($KV_ID)"
else
  ok "already configured"
fi

bold "3. Admin secret"
if [ -f "$SECRETS_FILE" ]; then
  ADMIN_SECRET="$(cat "$SECRETS_FILE")"
  ok "reusing the secret saved at $SECRETS_FILE"
else
  ADMIN_SECRET="$(openssl rand -hex 32)"
  printf "%s" "$ADMIN_SECRET" > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  ok "generated and saved to $SECRETS_FILE (chmod 600)"
fi
printf "%s" "$ADMIN_SECRET" | npx wrangler secret put ADMIN_SECRET >/dev/null 2>&1
ok "uploaded to Cloudflare"

bold "4. Deploy"
DEPLOY_OUT="$(npx wrangler deploy 2>&1)" || { echo "$DEPLOY_OUT"; exit 1; }
echo "$DEPLOY_OUT" | grep -E "Uploaded|Published|workers.dev|Current Version" || true
WORKER_URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
if [ -z "$WORKER_URL" ]; then
  echo
  echo "Deployed, but the workers.dev URL was not in the output."
  echo "Find it in the Cloudflare dashboard, then re-run with:  WORKER_URL=... $0"
  WORKER_URL="${WORKER_URL:-}"
fi
[ -n "$WORKER_URL" ] && ok "live at $WORKER_URL"

bold "5. Health check"
if [ -n "$WORKER_URL" ]; then
  sleep 2
  curl -sS "$WORKER_URL/health" | head -20
  echo
fi

bold "6. Point the plugin at this deployment"
if [ -n "$WORKER_URL" ]; then
  cat > "$PLUGIN_MCP" <<JSON
{
  "mcpServers": {
    "sevenshifts": {
      "type": "http",
      "url": "\${SEVENSHIFTS_MCP_URL:-$WORKER_URL/mcp}",
      "headers": {
        "Authorization": "Bearer \${SEVENSHIFTS_CONNECTOR_KEY}"
      }
    }
  }
}
JSON
  ok "updated plugins/sevenshifts/.mcp.json"
  info "commit and push so customers pick it up:"
  echo "       git -C \"$ROOT\" commit -am 'Point plugin at deployed Worker' && git -C \"$ROOT\" push"
fi

echo
bold "Done. To onboard your first customer:"
cat <<EOF

  export ADMIN_SECRET=\$(cat $SECRETS_FILE)
  export CONNECTOR_API=$WORKER_URL

  node scripts/onboard.mjs --name "Their Company" --token <their-7shifts-key>

That prints their connector key and the three steps to send them.
EOF
