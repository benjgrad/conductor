<!--
  A copy of packages/web/src/help/connect-claude.md, which the web app shows at /help/connect-claude.
  Edit that file and copy it here; a test keeps the two identical. In the examples,
  https://conductor.example.com stands for your conductor server (e.g. https://conductor.gradyserver.com);
  the web page shows its own address instead. The design is ADR-0028 (docs/adr/0028-simple-oauth-for-mcp.md).
-->

# Connect Claude to conductor (MCP)

conductor serves an MCP server at `<your conductor URL>/mcp`, e.g. `https://conductor.example.com/mcp`. Claude signs in with OAuth: the first time, a browser opens on conductor's sign-in (your conductor account; a local server has no sign-in step), then a page asks you to **Allow** the app.

## Claude Code
```bash
claude mcp add --transport http --scope user conductor https://conductor.example.com/mcp
```
`--scope user` makes it available in every project. Then, in Claude Code, run `/mcp`, choose **conductor** and **Authenticate**.

## claude.ai and Claude Desktop
1. On claude.ai: **Settings → Connectors → Add custom connector**.
2. Name `conductor`, URL `https://conductor.example.com/mcp`. Leave the advanced OAuth fields empty: conductor registers the client itself.
3. **Connect**, sign in to conductor, then **Allow**.

Connectors added on claude.ai also show up in Claude Desktop for the same Claude account.

## What Claude can do
| Tool | What |
|---|---|
| `list_tickets` | Your open tickets, newest first; filter by `needs_input`, column, kind, repo or status (`done`, `cancelled`, `all`) |
| `search_tickets` | Find tickets of any status by a word in the title or body, or by the start of the id |
| `get_ticket` | One ticket: who it's waiting on (`waiting_on`: you, the board, the agent, checks, a machine, nobody), a status report to read out, the open question, the transitions you can take, PR |
| `get_ticket_artifacts` | What the agent wrote: its plan, each step's result, its recent output, or the whole conversation (long text comes in pages) |
| `list_machines` | Your machines: online or not, running sessions, some of their repos |
| `create_ticket` | Queue a new ticket (`repo` is `github.com/org/repo`, `kind` is `work` or `personal`) |
| `answer_input` | Answer an agent's question |
| `take_transition` | Press one of the ticket's board buttons (send back, mark done…) |
| `message_agent` | Send instructions or a correction to the agent while it works, or ask it for a report in its own words. If it's waiting on a question, answer that instead |
| `wait_for_updates` | Wait (up to 50 s) until a ticket changes or asks something, then say what changed; call it again to keep listening |
| `reopen_ticket` | Send a done or failed ticket back to its agent with new instructions |
| `cancel_ticket` | Stop the agent and cancel the ticket |
| `list_repo_checks` | The repos that have their own pre-PR checks |
| `get_repo_checks` | What runs before a repo's PR opens: its own checks, or the workflow's |
| `set_repo_checks` | Give a repo its own checks (e.g. `cd m-one && npm ci && npm run build`); they replace the workflow's build and test for that repo |
| `clear_repo_checks` | Go back to the workflow's checks for a repo |
| `list_schedules` | Your recurring jobs: when each runs next, its last run's ticket, and why a run was skipped |
| `save_schedule` | Create or edit a recurring job: a cron (`0 9 * * 1-5` = weekdays at 09:00) and timezone, the ticket's title, instructions and repo, and the machines it runs on (e.g. your work laptop, for its skills and plugins). `enabled: false` pauses it |
| `delete_schedule` | Remove a recurring job (its past tickets stay) |
| `run_schedule_now` | Run a recurring job now, without moving its next run |
| `get_workflow` | The workflow: its states and transitions, or one state in full |
| `save_workflow` | Save a new version of a workflow (instance admins only: it changes the workflow for every account). It can't remove an approval |
| `adopt_default_workflow` | Replace your edits with the newest shipped `conductor` workflow (instance admins only) |
| `get_process_metrics` | How your tickets moved over the last days: time in each state, repo or machine, checks that fail, questions, permission denials |
| `list_findings` | What slows your work down (slow states, failing checks, repeated denials, frequent questions, rework), with example tickets and the tool that would fix it |

A move that needs an approval checkbox (such as a migration approval), and an agent's permission prompts, are answered on the board only: Claude gets the card's link instead.

Things to try: "What's waiting on me in conductor?", "What's the plan on c63433c0?", "Tell the agent on c63433c0 to also update the README", "Give me a status report on c63433c0", "Wait until something needs me", "Every weekday at 9, have my work laptop bring my PRs and Jira tickets up to date", "Where is my workflow wasting time?" (or use the `workflow_advisor` prompt, which walks Claude through finding a problem and proposing one small change for you to confirm).

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
