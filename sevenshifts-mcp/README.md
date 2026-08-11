# 7shifts MCP server

A Model Context Protocol server wrapping the [7shifts API v2](https://developers.7shifts.com).
28 read-only tools covering scheduling, labor, sales, payroll, and engagement,
plus a generic escape hatch for any endpoint not given a dedicated tool.

Runs three ways from one codebase: Cloudflare Worker (the shared deployment),
Node HTTP server (self-hosting), and stdio (local development).

## Tools

**Identity & org** — `whoami`, `list_companies`, `get_company`, `get_labor_settings`,
`list_locations`, `list_departments`, `list_roles`, `list_users`, `get_user`,
`list_user_wages`, `list_user_assignments`

**Scheduling & time** — `list_shifts`, `list_time_punches`, `list_time_off`,
`list_availability`, `list_events`, `list_payroll_periods`

**Sales & labor** — `daily_sales_and_labor`, `hours_and_wages`, `daily_stats`,
`receipts_summary`, `list_receipts`, `tip_pool_summary`

**Engagement** — `list_shift_feedback`, `engagement_overview`, `list_log_book_posts`

**Composite** — `executive_summary`: one call returns sales, labor cost, labor %,
overtime, and sales per labor hour across every location, converted to dollars

**Escape hatch** — `api_request`: any path from https://developers.7shifts.com/llms.txt

All tool names are prefixed `sevenshifts_`.

### Notes on the data

- The raw daily sales & labor report returns **cents**, and `labor_percent` as a
  fraction. `executive_summary` converts both.
- `hours_and_wages` and `daily_sales_and_labor` require 7shifts' **"The Works"**
  plan. On a lower plan they return 402/403; `executive_summary` reports the
  failure per location instead of failing the whole call.
- `hours_and_wages` is slow — always pass `location_id`, keep ranges to ~1 week.
- List tools follow cursor pagination automatically and cap at `max_items`
  (default 500), setting `"truncated": true` when they stop early.

## Deploy (Cloudflare Worker)

```bash
npm install
npx wrangler login
```

Create the tenant store and put its id in `wrangler.toml`:

```bash
npx wrangler kv namespace create TENANTS
```

Set the admin secret, then deploy:

```bash
openssl rand -hex 32                      # save this value
npx wrangler secret put ADMIN_SECRET
npx wrangler deploy
```

### Custom domain

Requires the zone to be on Cloudflare (nameservers pointed at Cloudflare).
Then uncomment `routes` in `wrangler.toml` and redeploy:

```toml
routes = [
  { pattern = "api.aiconnectors.ai/*", zone_name = "aiconnectors.ai" }
]
```

Until then the Worker is reachable at `https://sevenshifts-mcp.<subdomain>.workers.dev`.

## Managing customers

```bash
export ADMIN_SECRET=...
export CONNECTOR_API=https://api.aiconnectors.ai   # or the workers.dev URL

node scripts/onboard.mjs --name "Acme Group" --token <their-7shifts-key>
node scripts/onboard.mjs list
node scripts/onboard.mjs rotate <tenant_id>
node scripts/onboard.mjs revoke <tenant_id>
```

Connector keys are stored only as SHA-256 hashes, so a KV dump yields nothing
usable. Rotation and revocation take effect immediately.

Get a customer's 7shifts key from **7shifts → Settings → Developer Tools → API Access**
(admin only). Collect it over a secure channel — not email or chat.

## Auth model

Two ways to authenticate, both resolving to the same tenant:

| Route | Credential |
| --- | --- |
| `POST /mcp` | `Authorization: Bearer ck_live_…` — the connector key directly (Claude Code) |
| `POST /mcp` | `Authorization: Bearer at_…` — an OAuth access token (Cowork, web, Desktop) |
| `/admin/*` | `Authorization: Bearer $ADMIN_SECRET` |

Without a `TENANTS` KV binding the Worker falls back to single-tenant mode: one
`SEVENSHIFTS_TOKEN` secret, optionally gated by `MCP_SHARED_SECRET`.

### OAuth (Cowork, web, Desktop)

Claude Code expands `${SEVENSHIFTS_CONNECTOR_KEY}` from the customer's shell.
Cowork and the web app call the MCP endpoint from Anthropic's cloud, where there
is no shell — so those clients need OAuth. The Worker is both the resource
server and the authorization server, per the
[MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `POST /register` | RFC 7591 dynamic client registration |
| `GET/POST /authorize` | Consent screen; the customer pastes their connector key |
| `POST /token` | Authorization code and refresh grants |

The connector key remains the real credential — OAuth just wraps it. The
customer pastes it once on the consent screen and never touches it again.

Security properties, each covered by a test:

- PKCE **S256 required**; plain and missing challenges are rejected
- Authorization codes are single-use with a 60-second TTL
- Redirect URIs must exactly match a registered value, and must be HTTPS or loopback
- A client/redirect mismatch renders an error page rather than redirecting (no open redirect)
- Access tokens live 1 hour; refresh tokens rotate on every use
- Tokens are stored as SHA-256 hashes, and carry their `resource` for audience binding
- **Revoking a tenant kills its OAuth tokens and blocks refresh** — one revocation covers both auth paths

## Local development

```bash
cp .env.example .env        # add your SEVENSHIFTS_TOKEN
npm run build

npm start                   # stdio, for Claude Desktop / Claude Code
npm run serve               # HTTP on :8787
```

Claude Desktop / Claude Code stdio config:

```json
{
  "mcpServers": {
    "sevenshifts": {
      "command": "node",
      "args": ["/absolute/path/to/sevenshifts-mcp/dist/stdio.js"],
      "env": { "SEVENSHIFTS_TOKEN": "your-token" }
    }
  }
}
```

## Tests

```bash
npm run build
SEVENSHIFTS_TOKEN=... node scripts/test-worker.mjs   # 21 checks
SEVENSHIFTS_TOKEN=... node scripts/test-oauth.mjs    # 28 checks
```

The first covers the auth gate, provisioning, MCP protocol, live 7shifts calls,
and key rotation/revocation. The second simulates a full OAuth client —
discovery, registration, consent, PKCE exchange, refresh rotation, revocation —
and asserts that direct connector-key auth still works.

## Writes

Disabled by default: only GET reaches 7shifts, and `api_request` refuses other
methods. Enable per tenant with `"allow_writes": true` at provisioning time, or
globally with `SEVENSHIFTS_ALLOW_WRITES=true`. Leave it off for reporting.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SEVENSHIFTS_TOKEN` | 7shifts token (single-tenant mode only) |
| `SEVENSHIFTS_COMPANY_ID` | Skip the `/whoami` lookup |
| `SEVENSHIFTS_API_VERSION` | Pin the API version (default `2026-06-01`) |
| `SEVENSHIFTS_ALLOW_WRITES` | Allow non-GET methods (default false) |
| `ADMIN_SECRET` | Protects `/admin/*` |
| `MCP_SHARED_SECRET` | Gate for single-tenant mode |
