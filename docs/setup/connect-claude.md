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
| `list_tickets` | Your open tickets, newest first; filter by `needs_input`, column, kind, repo or status (`done`, `cancelled`, `all`) |
| `search_tickets` | Find tickets of any status by a word in the title or body, or by the start of the id |
| `get_ticket` | One ticket: body, column, open question, the transitions you can take, PR |
| `list_machines` | Your machines: online or not, running sessions, some of their repos |
| `create_ticket` | Queue a new ticket (`repo` is `github.com/org/repo`, `kind` is `work` or `personal`) |
| `answer_input` | Answer an agent's question |
| `take_transition` | Press one of the ticket's board buttons (send back, mark done…) |
| `reopen_ticket` | Send a done or failed ticket back to its agent with new instructions |
| `cancel_ticket` | Stop the agent and cancel the ticket |

A move that needs an approval checkbox (such as a migration approval), and an agent's permission prompts, are answered on the board only: Claude gets the card's link instead.

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
