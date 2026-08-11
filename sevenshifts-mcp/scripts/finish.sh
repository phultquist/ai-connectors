#!/usr/bin/env bash
#
# Run after registering the workers.dev subdomain in the Cloudflare dashboard.
# Finishes the deploy and proves the whole chain works end to end.
#
#   ./scripts/finish.sh

set -euo pipefail
cd "$(dirname "$0")/.."

URL="${WORKER_URL:-https://sevenshifts-mcp.aiconnectors.workers.dev}"
SECRETS_FILE="$HOME/.sevenshifts-connector-admin"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

bold "1. Deploy"
OUT="$(npx wrangler deploy 2>&1)" || { echo "$OUT"; exit 1; }
FOUND="$(echo "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
if [ -n "$FOUND" ]; then
  URL="$FOUND"
  ok "live at $URL"
else
  echo "$OUT" | tail -20
  bad "no workers.dev URL in output — is the subdomain registered?"
  exit 1
fi

bold "2. Health"
curl -sS "$URL/health"; echo

bold "3. Auth gate"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$CODE" = "401" ] && ok "unauthenticated request rejected (401)" || { bad "expected 401, got $CODE"; exit 1; }

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/mcp" \
  -H 'Authorization: Bearer ck_live_0000000000000000000000000000000000000000000000000000000000000000' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$CODE" = "401" ] && ok "forged connector key rejected (401)" || { bad "expected 401, got $CODE"; exit 1; }

bold "4. Admin API"
if [ ! -f "$SECRETS_FILE" ]; then bad "no admin secret at $SECRETS_FILE"; exit 1; fi
ADMIN_SECRET="$(cat "$SECRETS_FILE")"
RESP="$(curl -s -w '\n%{http_code}' "$URL/admin/tenants" -H "Authorization: Bearer $ADMIN_SECRET")"
CODE="$(echo "$RESP" | tail -1)"
[ "$CODE" = "200" ] && ok "admin API reachable" || { bad "admin API returned $CODE"; echo "$RESP" | head -3; exit 1; }

bold "5. Point the plugin here"
PLUGIN_MCP="../plugins/sevenshifts/.mcp.json"
cat > "$PLUGIN_MCP" <<JSON
{
  "mcpServers": {
    "sevenshifts": {
      "type": "http",
      "url": "\${SEVENSHIFTS_MCP_URL:-$URL/mcp}",
      "headers": {
        "Authorization": "Bearer \${SEVENSHIFTS_CONNECTOR_KEY}"
      }
    }
  }
}
JSON
ok "plugin points at $URL/mcp"

echo
bold "Ready. Onboard your customer:"
cat <<EOF

  export ADMIN_SECRET=\$(cat $SECRETS_FILE)
  export CONNECTOR_API=$URL
  node scripts/onboard.mjs --name "Their Company" --token <their-7shifts-key>

If the plugin URL changed, push it:
  git -C .. commit -am 'Point plugin at deployed Worker' && git -C .. push
EOF
