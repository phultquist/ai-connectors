# SevenRooms connector for Claude

Read-only access to your SevenRooms reservations, covers, guests, and waitlist,
so you can ask Claude questions like:

- "How many covers did we do last week by venue?"
- "What's our no-show rate this month?"
- "Show me our top guests by visit count."
- "Where do we have unsold capacity on Friday night?"

## Setup

You'll be given a **connector key** that looks like `ck_live_…`.

### Claude Cowork, claude.ai, or Claude Desktop

1. **Settings → Connectors → Add custom connector**
2. URL: `https://sevenrooms-mcp.aiconnectors.workers.dev/mcp`
3. Click **Connect**, paste your connector key once.

### Claude Code

```bash
echo 'export SEVENROOMS_CONNECTOR_KEY=ck_live_your_key_here' >> ~/.zshrc
```

Open a **new terminal**, then:

```
/plugin marketplace add phultquist/ai-connectors
/plugin install sevenrooms@ai-connectors
```

Check with `/mcp` — `sevenrooms` should show as connected.

## What it can read

Venues, reservations, guest profiles, waitlist entries, booking requests,
availability, tables, service shifts, and events.

It is **read-only** — it cannot create, modify, or cancel bookings.

## A note on data accuracy

SevenRooms' API is not publicly documented and field names vary by account
configuration. This connector detects the common response shapes and reports
which one it saw. If a number looks wrong, ask Claude to show you the raw
reservation records — the underlying fields will make the discrepancy obvious.

## Troubleshooting

**Not connected in Claude Code** — `SEVENROOMS_CONNECTOR_KEY` isn't set in the
terminal Claude Code was launched from. Check `echo $SEVENROOMS_CONNECTOR_KEY`.

**Cowork / web / Desktop** — use the custom-connector flow above, not the
plugin; those clients have no shell environment to read the key from.

**401 from SevenRooms** — the API key may expect a different auth style. The
server supports `bearer`, `apikey`, or `both`; ask your administrator.
