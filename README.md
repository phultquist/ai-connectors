# AI Connectors

A Claude Code plugin marketplace for business-system connectors.

```bash
/plugin marketplace add phultquist/ai-connectors
/plugin install sevenshifts@ai-connectors
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [`sevenshifts`](plugins/sevenshifts) | Read-only access to 7shifts scheduling, labor, sales, and payroll data |

## How it fits together

```
Customer's Claude Code
  └── plugin: sevenshifts            (this repo, public)
        └── HTTPS + connector key
              └── Cloudflare Worker  (sevenshifts-mcp/, private deploy)
                    ├── KV: connector key hash → customer's 7shifts token
                    └── api.7shifts.com
```

The customer never handles a 7shifts token. You hold their token server-side and
issue them a **connector key** (`ck_live_…`) that only works against your Worker.
Revoke or rotate it at any time without touching their 7shifts account.

## Onboarding a customer

One command, from `sevenshifts-mcp/`:

```bash
ADMIN_SECRET=... node scripts/onboard.mjs --name "Acme Group" --token <their-7shifts-key>
```

It prints their connector key plus the three setup steps to send them.

See [`sevenshifts-mcp/README.md`](sevenshifts-mcp/README.md) for deployment,
key rotation, and revocation.

## Repository layout

```
.claude-plugin/marketplace.json   the marketplace catalog
plugins/sevenshifts/              the installable plugin (MCP config + skill)
sevenshifts-mcp/                  the MCP server deployed to Cloudflare
```
