# SevenRooms MCP server

A Model Context Protocol server wrapping the SevenRooms API. 14 read-only tools
covering venues, reservations, guests, waitlist, demand, and capacity, plus a
generic escape hatch.

Same architecture as [`sevenshifts-mcp`](../sevenshifts-mcp): Cloudflare Worker,
multi-tenant connector keys, OAuth 2.1 for Cowork/web/Desktop.

**Live:** `https://sevenrooms-mcp.aiconnectors.workers.dev/mcp`

## ⚠️ Verification status

SevenRooms' API is **not publicly documented** — access requires a partnership
agreement — and this connector was built without live credentials.

**Verified by probing:** every endpoint path below exists. The API returns 401
for a real route and 404 for an unknown one, which makes route existence
testable without a key.

**Verified against a mock:** auth header plumbing, response-envelope detection,
cursor pagination, the covers arithmetic, read-only enforcement, tenancy, and
the full OAuth flow — 49 tests.

**NOT verified:** query-parameter names and response field names. These are
conventional guesses. Run `scripts/verify-live.mjs` as soon as a real key
exists; it prints the actual shapes so the typed tools can be corrected.

The client is deliberately defensive: it accepts several envelope shapes,
reports which one it saw in `response_shape`, and passes unrecognised data
through intact rather than dropping it.

## Tools

**Venues** — `list_venues`, `get_venue`

**Reservations** — `list_reservations`, `get_reservation`

**Guests** — `list_clients`, `get_client`

**Demand** — `list_waitlist`, `list_requests`

**Capacity** — `get_availability`, `list_tables`, `list_shifts`, `list_events`

**Composite** — `covers_summary`: covers, average party size, cancellations,
no-shows, and a per-day series across one or more venues

**Escape hatch** — `api_request`: any path under `https://api.sevenrooms.com`

All tool names are prefixed `sevenrooms_`.

### Confirmed endpoint map

```
/2_4/venues                        /2_4/reservations
/2_4/venues/{id}                   /2_4/reservations/{id}
/2_4/venues/{id}/availability      /2_4/clients
/2_4/venues/{id}/tables            /2_4/clients/{id}
/2_4/venues/{id}/shifts            /2_4/waitlist      /2_4/waitlist/{id}
/2_4/venues/{id}/events            /2_4/requests      /2_4/requests/{id}
```

Versions `2_0` through `3_0` all respond; `2_4` is the default and is
configurable via `SEVENROOMS_API_VERSION`.

## Authentication to SevenRooms

SevenRooms keys have been observed working as either a bearer token or an
`X-API-Key` header. `SEVENROOMS_AUTH_STYLE` controls this:

| Value | Behaviour |
| --- | --- |
| `both` (default) | Sends the key in both headers, so either kind of key works |
| `bearer` | `Authorization: Bearer <key>` only |
| `apikey` | `X-API-Key: <key>` only |

Once you know which your key uses, tighten it.

## Managing customers

```bash
export ADMIN_SECRET=$(cat ~/.sevenshifts-connector-admin)
export CONNECTOR_API=https://sevenrooms-mcp.aiconnectors.workers.dev

node scripts/onboard.mjs --name "Acme Group" --token <their-key> [--venue-id V]
node scripts/onboard.mjs list
node scripts/onboard.mjs rotate <tenant_id>
node scripts/onboard.mjs revoke <tenant_id>
```

Connector keys are stored only as SHA-256 hashes. Revocation is immediate and
also kills any OAuth tokens derived from the key.

## Deploy

```bash
npm install
npx wrangler deploy
```

KV namespace `6b0a99cf81584a8f8a7b7be4e3e29e57` is already bound, and
`ADMIN_SECRET` is already set (shared with the 7shifts connector).

## Tests

```bash
npm run build
node scripts/test-worker.mjs   # 21 checks, mocked SevenRooms API
node scripts/test-oauth.mjs    # 28 checks, full OAuth flow
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `SEVENROOMS_TOKEN` | API key (single-tenant mode only) |
| `SEVENROOMS_VENUE_ID` | Default venue, so tools can omit `venue_id` |
| `SEVENROOMS_API_VERSION` | Path version segment (default `2_4`) |
| `SEVENROOMS_AUTH_STYLE` | `bearer` \| `apikey` \| `both` (default `both`) |
| `SEVENROOMS_ALLOW_WRITES` | Allow non-GET methods (default false) |
| `ADMIN_SECRET` | Protects `/admin/*` |

## Known duplication

The transport, tenancy, and OAuth layers are copied verbatim from
`sevenshifts-mcp` rather than shared. That was deliberate — it avoided
refactoring a live production service — but a fix applied to one will not reach
the other. Factor these into a shared package before adding a third connector.
