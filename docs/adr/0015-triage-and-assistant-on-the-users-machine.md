# ADR-0015 · Triage before Queued, and an assistant chat that runs on the user's own machine

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M4)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26)
- **Builds on**:
  - [ADR-0011](0011-transition-rules.md): `ticket.kind`, required before Queued;
  - [ADR-0013](0013-machine-enrollment-inventory-routing.md): machines and their inventory;
  - [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md): the tool layer and `/mcp`;
  - [ADR-0005](0005-claude-code-driver.md) / [ADR-0006](0006-agents-inherit-claude-code-settings.md): how a daemon runs `claude`, and its hard guards.
- **Touches**: [U-010](../tracking/UNKNOWNS.md) (triage and plan states): triage here is intake only; child tickets stay open.

## Context
Ben wants conductor to ask for what a ticket is missing ("is this work or personal?"), and an AI chat that summarises what needs attention and can answer or approve on his behalf. He decided (2026-10-26) that **chat and summaries run on the user's own machine**, under their Claude subscription, so the hosted server needs no model API key and pays for no tokens.

Until M4, ADR-0011 makes `kind` a required field of the create form.

## Decision
**A new ticket passes triage before it can be claimed: first deterministic field checks on the server, then a short clarity check on one of the user's machines. What is missing becomes a question to the user. The assistant is a per-account `claude` conversation on an online machine of the user's, whose only tools are the ADR-0014 tool layer over `/mcp`. It reads freely and writes only after the user confirms. With no machine online, the chat panel shows a deterministic list instead.**

### Triage
- `ticket_status` gains `triage` (a migration). `POST /api/tickets` and `create_ticket` create tickets in `triage`; the claim never sees them.
- **Step 1, deterministic (server, synchronous):**
  - `kind` is set;
  - `repo` is canonical and at least one machine of the account has it ([ADR-0013](0013-machine-enrollment-inventory-routing.md));
  - `title` is not empty.

  Each failure becomes a question with fixed choices ("Is this a work ticket or personal?" → Work / Personal; "Which repo?" → the account's known repos).
- **Step 2, clarity check (machine, asynchronous):** one `claude -p` run on an online machine (`assistant_job {kind: 'triage'}`), on the cheapest configured model, with **no tools**. It gets the ticket text plus the repo name and returns `{clear: boolean, questions: string[] ≤ 3}` as JSON (`--json-schema`). It times out after 60 s; a timeout or a malformed result counts as clear, so a model can never hold a ticket back on its own.
- **Questions** are `input_request` rows with `kind: 'triage'`, `ticket_id` set and `session_id` null (U-064). The card stays in **Queued** with a `needs info` badge and the question. It is answered from the card or in the chat. Answers update the ticket (`kind`, `repo`) or append to its body, and triage re-runs. When nothing is missing the ticket goes to `ready`.
- The user can always press **Skip triage**, if the deterministic fields are present.

### The assistant chat
- **Where it runs**: one conversation per account, hosted by one online machine: the one the user marked "assistant machine", else the most recently active one with `claude` logged in. If that machine goes offline, the next message starts the conversation on another machine.
- **How it runs**: the daemon gets `start_chat` / `chat_message` commands (outbox, like `start_session`) and runs `claude` in stream-json mode as for agents ([ADR-0005](0005-claude-code-driver.md)), with:
  - `--strict-mcp-config` and an MCP config naming only conductor's `/mcp`, with a **short-lived access token** (1 h, `conductor:read conductor:write`, client `assistant`), minted per conversation start and refreshed by a new start;
  - `--tools ""` (no Bash, Edit, Read, or web), and `--permission-mode dontAsk` with `--allowedTools` listing only the conductor tools;
  - `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `--setting-sources user` (ADR-0006's guards), and cwd an empty private directory under the daemon root.
- **What it may do without confirmation**: every `read` tool. **Every `write` tool needs a click**: the tool layer, when `ctx.via = 'chat'`, does not execute a write. It stores a `pending_action` and returns "Waiting for the user to confirm: <one-line description>". The panel renders a Confirm / Cancel card; Confirm runs the same tool through REST as the user. Settings may later auto-approve specific tools (`create_ticket`, `answer_input` with fixed choices).
- **History**: chat messages are stored (`chat_message`: role, text ≤ 8 KB, created_at, account_id) so the panel and a conversation moved to another machine can show them. A new `claude` conversation is seeded with the last 20 messages and the needs-attention list. Storing assistant text in Postgres is U-066 (the U-045 class).
- **Budget**: the assistant runs on the user's subscription. A per-account cap on assistant turns per hour (default 60) protects the user's rate limits shared with work sessions (U-055, U-014).

### Stored summaries
- `ticket_summary (ticket_id, account_id, text ≤ 1 200 chars, through_event_id, generated_at, machine_id)`.
- **Refreshed on events**: a ticket entering a new state, a new input request, a terminal state. Debounced: at most once per ticket per 10 minutes, and only if `through_event_id` is behind. Batched per account (up to 10 tickets per `assistant_job {kind: 'summaries'}`), on the cheapest model, no tools, input = the deterministic digest plus the last result summary.
- **Freshness**: a summary older than its ticket's last state change is served with `stale: true`, and the tool layer falls back to the deterministic summary when it is stale by more than a state (U-053).

### Offline fallback
No online machine with `claude` → the panel says "No machine online to run the assistant" and shows the **needs-attention list**: open input requests oldest first (with the answer box and the ADR-0011 transition buttons), pending checklists, triage questions. All of it comes from the database. Triage step 2 and summaries wait; step 1 still runs.

### Boundaries
- ADR-0006's guards hold: no repo settings, conductor's MCP only, no claude.ai connectors.
- The assistant can't edit code or run commands. Its reach is exactly the tool layer, with writes confirmed by a human; its actions are recorded as `actor = <user> via assistant`.
- Assistant runs don't count as sessions against `max_sessions`, but use one "light slot" each (default 1 per machine) so a chat can't crowd out work (U-055).

## Alternatives considered
| Option | Why not |
|---|---|
| Chat and summaries on the server with an API key | Ben: run on the user's machine and subscription; no model key or token cost on the server |
| An LLM triage agent that edits the ticket itself | Nondeterministic intake. Deterministic checks first, and the model only asks |
| The chat as an agent with Bash and repo access | A far larger blast radius for a summarising assistant; the work agents already have that |
| Writes from chat without confirmation | A misread request could cancel or approve work. One click is cheap |
| Triage as the workflow's first state | It must run before a machine is claimed and before the workflow is pinned; it is intake, not work |

## Consequences
- **Good:**
  - tickets reach Queued complete;
  - the assistant uses the same audited tools as MCP clients;
  - no model costs on the server;
  - an offline user still sees and answers everything.
- **Bad / accepted cost:**
  - the assistant needs an online machine;
  - its chat history is new model text in Postgres (U-066);
  - assistant runs share the user's subscription limits with their work sessions;
  - `ticket_status` and `input_request` change shape (migrations).
- **Follow-ups:** M4 tasks; U-053, U-055, U-064, U-066.

## Revisit when
Users want the assistant with no machine online (a server-side model with the account's own key), or chat writes need fine-grained auto-approval.
