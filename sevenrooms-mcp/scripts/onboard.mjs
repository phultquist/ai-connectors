#!/usr/bin/env node
/**
 * Onboard a SevenRooms customer in one command.
 *
 *   node scripts/onboard.mjs \
 *     --name "Acme Restaurant Group" \
 *     --token <their SevenRooms API key> \
 *     [--venue-id 435911] [--api https://sevenrooms-mcp.aiconnectors.workers.dev]
 *
 * ADMIN_SECRET must be set in the environment. Prints the connector key and
 * the exact setup instructions to hand to the customer.
 *
 * Other commands:  list | revoke <tenant_id> | rotate <tenant_id>
 */

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const API = (flag("api", process.env.CONNECTOR_API ?? "https://sevenrooms-mcp.aiconnectors.workers.dev")).replace(/\/+$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error("ADMIN_SECRET is not set.\n  export ADMIN_SECRET=...   (the value you gave `wrangler secret put ADMIN_SECRET`)");
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_SECRET}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    console.error(`\n✗ ${res.status} ${res.statusText}`);
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return parsed;
}

const command = args[0]?.startsWith("--") ? "create" : args[0] ?? "create";

if (command === "list") {
  const { tenants } = await call("GET", "/admin/tenants");
  if (!tenants?.length) {
    console.log("No tenants yet.");
  } else {
    console.table(
      tenants.map((t) => ({
        tenant_id: t.tenant_id,
        name: t.name,
        venue_id: t.venue_id ?? "(auto)",
        created: t.created_at?.slice(0, 10),
      })),
    );
  }
  process.exit(0);
}

if (command === "revoke") {
  const id = args[1];
  if (!id) { console.error("Usage: onboard.mjs revoke <tenant_id>"); process.exit(1); }
  console.log(JSON.stringify(await call("DELETE", `/admin/tenants/${id}`), null, 2));
  process.exit(0);
}

if (command === "rotate") {
  const id = args[1];
  if (!id) { console.error("Usage: onboard.mjs rotate <tenant_id>"); process.exit(1); }
  const out = await call("POST", `/admin/tenants/${id}/rotate`);
  console.log(`\nNew connector key for ${id}:\n\n  ${out.connector_key}\n\nThe old key stopped working immediately.`);
  process.exit(0);
}

/* ---- create ------------------------------------------------------- */

const name = flag("name");
const token = flag("token");
const venueId = flag("venue-id");

if (!name || !token) {
  console.error(
    'Usage: node scripts/onboard.mjs --name "Acme Group" --token <SevenRooms-api-key> [--venue-id 123]',
  );
  process.exit(1);
}

const out = await call("POST", "/admin/tenants", {
  name,
  sevenrooms_token: token,
  ...(venueId ? { venue_id: venueId } : {}),
});

const key = out.connector_key;

console.log(`
✓ Provisioned "${name}"   (tenant ${out.tenant.tenant_id})

  Connector key:  ${key}

  Shown once — it is stored only as a hash. Send it over a secure channel.

──────────────────────────────────────────────────────────────────────
Send the customer these three steps:
──────────────────────────────────────────────────────────────────────

1. Add your key to the shell environment (and reopen the terminal):

     echo 'export SEVENROOMS_CONNECTOR_KEY=${key}' >> ~/.zshrc

2. In Claude Code, add the marketplace and install the plugin:

     /plugin marketplace add phultquist/ai-connectors
     /plugin install sevenrooms@ai-connectors

3. Verify:

     "Use SevenRooms to show me labor percentage by location for last week."
──────────────────────────────────────────────────────────────────────
`);
