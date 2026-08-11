# 7shifts connector for Claude

Read-only access to your 7shifts scheduling, labor, sales, and payroll data,
so you can ask Claude questions like:

- "What was labor percentage by location last week?"
- "Which locations are running the most overtime?"
- "Show me sales vs. projection for the last 30 days."
- "Who worked more than 40 hours in the last pay period?"

## Setup

You'll be given a **connector key** that looks like `ck_live_…`.

**1. Add the key to your environment**

```bash
echo 'export SEVENSHIFTS_CONNECTOR_KEY=ck_live_your_key_here' >> ~/.zshrc
```

Then open a new terminal so it takes effect.

**2. Install the plugin**

```
/plugin marketplace add phultquist/ai-connectors
/plugin install sevenshifts@ai-connectors
```

**3. Check it worked**

```
/mcp
```

`sevenshifts` should show as connected. Then just ask:

> Use 7shifts to show me labor percentage by location for last week.

## What it can read

Locations, departments, roles, employees and wages, scheduled shifts, time
punches, time off, availability, sales receipts, daily sales & labor, tips,
payroll periods, shift feedback, and manager log book entries.

It is **read-only** — it cannot create, edit, or delete anything in 7shifts.

## Notes

- Some reports (daily sales & labor, hours & wages) need the 7shifts
  **"The Works"** plan. On a lower plan Claude will tell you the plan is the
  limitation rather than silently returning nothing.
- You never handle a 7shifts API token. Your connector key can be revoked or
  rotated without touching your 7shifts account.

## Troubleshooting

**`sevenshifts` doesn't appear in `/mcp`** — `SEVENSHIFTS_CONNECTOR_KEY` isn't
set in the environment Claude Code was launched from. Check with
`echo $SEVENSHIFTS_CONNECTOR_KEY`, then restart Claude Code from that terminal.

**401 errors** — the key was revoked or rotated. Ask for a new one.
