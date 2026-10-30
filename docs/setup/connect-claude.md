# Connect Claude to conductor (MCP)

conductor serves an MCP server at `<your conductor URL>/mcp`, e.g. `https://conductor.gradyserver.com/mcp` ([ADR-0028](../adr/0028-simple-oauth-for-mcp.md)). Claude signs in with OAuth: the first time, a browser opens on conductor's sign-in, then a page asks you to **Allow** the app.

## Claude Code
```bash
claude mcp add --transport http --scope user conductor https://conductor.gradyserver.com/mcp
```
`--scope user` makes it available in every project. Then, in Claude Code, run `/mcp`, choose **conductor** and **Authenticate**.

## claude.ai and Claude Desktop
1. On claude.ai: **Settings → Connectors → Add custom connector**.
2. Name `conductor`, URL `https://conductor.gradyserver.com/mcp`. Leave the advanced OAuth fields empty: conductor registers the client itself.
3. **Connect**, sign in to conductor, then **Allow**.

Connectors added on claude.ai also show up in Claude Desktop for the same Claude account.

## What Claude can do
| Tool | What |
|---|---|
| `list_tickets` | Your tickets, newest first; `needs_input: true` shows what waits on you |
| `get_ticket` | One ticket: body, column, open question, the transitions you can take, PR |
| `create_ticket` | Queue a new ticket (`repo` is `github.com/org/repo`, `kind` is `work` or `personal`) |
| `answer_input` | Answer an agent's question |
| `take_transition` | Press one of the ticket's board buttons (approve, send back…) |

A ticket can be referred to by its id or its first 8 characters. Every connection can read and write your tickets; your Claude client asks before it runs a tool unless you allow it.

## Disconnect
There is no per-app revoke yet. To cut off every connected app, on the server:
```bash
conductor-admin revoke-sessions <your email>
```
This also signs you out of the web app. A password reset or disabling the user does the same. Access tokens last 1 hour and refresh tokens 30 days.

## Troubleshooting
- **401 with `resource_metadata=`**: expected on the first call; the client then starts the sign-in.
- **"The app gave a return address it did not register"**: remove the connector and add it again (it re-registers).
- **Self-hosted**: `CONDUCTOR_PUBLIC_URL` must be the https URL clients use; it is the OAuth issuer.
