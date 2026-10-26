# Roadmap

Re-planned 2026-10-26 after Ben approved the plan "transition rules, then accounts, machines, triage, assistant and MCP". The order is **M1b → M2 → M3 → M4 → M5**. M3 comes before M4 because the assistant reuses the M3 tool layer. Each milestone has a file in `milestones/`. Only the next one is broken into detailed tasks; the others are outlines until the previous milestone is near done, and Ben approves each file before work starts.

| Milestone | Decisions | Status | Exit criteria |
|---|---|---|---|
| [M1 · Single machine](milestones/M1-single-machine.md) | ADR-0001..0010 | **complete, pending Ben's sign-off** (2026-10-22) | One daemon on one machine runs a ticket through `implement → build → test → done` (M1 workflow), with a `needs_input` round trip answered from the kanban board, all visible live over SSE. E2E test green. |
| [M1b · Transition rules](milestones/M1b-transition-rules.md) | [ADR-0011](../adr/0011-transition-rules.md) | **planned**, awaiting Ben's approval | Transitions are named edges with `when`, `actor`, `kinds`, `requires` and `on_unmet`. The agent finishes by naming a transition with a reason. Humans move Needs-input cards with one button per allowed transition. Checks, review, actions and **conditions** run on the move; the card stays in its column with a live "waiting for …" checklist. `ticket.kind` exists and filters transitions. `conductor` v2 is seeded. E2E green with the four ADR-0011 scenarios. Local only, no auth. |
| [M2 · Accounts & machines](milestones/M2-accounts-machines.md) | [ADR-0012](../adr/0012-hosted-multi-user-github-sign-in.md), [ADR-0013](../adr/0013-machine-enrollment-inventory-routing.md) | outline | Hosted over HTTPS with Sign in with GitHub. Every row, route, stream and socket is scoped to an account, proved by the route-matrix isolation test. Machines enroll with a one-time token and a revocable credential, report repos and capabilities, and only receive tickets whose repo and required capabilities they have. Sessions run in worktrees off the user's own checkout. Leases and the reaper send a lost session to a human. E2E: two fake machines in two accounts, routed by repo and capability, isolated. |
| [M3 · Tool layer & MCP](milestones/M3-mcp.md) | [ADR-0014](../adr/0014-tool-layer-and-oauth-mcp-server.md) | outline | One tool layer with twelve tools, each result ≤ 8 KB with pagination. `/mcp` over Streamable HTTP, protected by conductor's own OAuth 2.1 server (discovery, dynamic client registration, PKCE, GitHub login, account-scoped tokens, revocation). E2E: an MCP client completes OAuth, then creates and reads tickets with bounded responses. |
| [M4 · Intake & assistant](milestones/M4-intake-assistant.md) | [ADR-0015](../adr/0015-triage-and-assistant-on-the-users-machine.md) | outline | New tickets pass triage (deterministic fields, then a clarity check on a machine) before Queued, with questions answerable on the card or in chat. A chat panel runs a per-account `claude` conversation on an online machine, using the tool layer; writes need a click. Summaries are refreshed on events. With no machine online the panel shows the needs-attention list. E2E: triage asks for the kind; the chat answers an input request through a tool. |
| [M5 · Work connectors](milestones/M5-work-connectors.md) | [ADR-0016](../adr/0016-work-connectors-on-the-users-machine.md) | outline | GitHub checks, approvals and merges as conditions (polling plus webhook hints); Jira field updates and status reads; Azure Pipelines status for a branch; an approval-gated Slack message. All run on the user's machine via its CLIs and MCPs, routed by capability, with no third-party secrets on the server. `conductor` v3 turns on the Jira and Azure conditions. E2E with fake CLIs. |

## What happened to the old rows
The 2026-10-22 roadmap had M2 · Fleet, M3 · Production workflow and M4 · Authoring & reach. Their items now sit here:

| Old item | Old row | Now |
|---|---|---|
| ≥ 2 machines, pull claim | M2 Fleet | **M2**, with hard routing by repo and capability (ADR-0013) |
| Short hold | M2 Fleet | **Dropped**: a machine without the repo can no longer claim the ticket (ADR-0013) |
| Leases, fencing, reaper | M2 Fleet | **M2**. Fencing already exists; a lost lease goes to a human (U-068) |
| Daemon disk buffer + seq replay | M2 Fleet | **Done in M1** (bounded, TD-025) |
| Laptop-sleep chaos test | M2 Fleet | **M2** e2e |
| Daemon enrollment tokens | M2 Fleet | **M2** (ADR-0013) |
| `open_pr` | M3 Production | **Done** (ADR-0010) |
| `await_approval` with webhook + UI approve | M3 Production | UI approve **done**; PR approval as a condition **M1b** (via `gh`); webhooks **M5** |
| `notify`, connectors with idempotency (ticket, Azure, Jira) | M3 Production | **M5**, on the user's machine (ADR-0016) |
| Budgets enforced | M3 Production | **Deferred**: nothing fires `budget.exceeded` yet. Agents run on the user's subscription (ADR-0006); revisit with U-014 |
| Sandboxing | M3 Production | **Deferred** (U-004); ADR-0013's `.git` tamper detection is the stopgap |
| Ticket webhooks (Jira/GitHub issues → tickets) | M3 Production | **Deferred** (U-003); tickets come from the board, MCP and chat |
| Visual workflow editor | M4 Authoring | **Done** (ADR-0009/0010 editor); transition arrows in **M1b** |
| Slack answering of input requests | M4 Authoring | **Deferred** (U-007); the assistant chat covers answering from elsewhere |
| Triage / plan states with child tickets | M4 Authoring | Triage as intake **M4**; child tickets **deferred** (U-010) |

## Out of scope (until a decision says otherwise)
- Shared (team) accounts and moving machines between accounts (U-051). Accounts are personal in M2.
- A second orchestrator instance, sharded schedulers, thousands of machines (ADR-0003's revisit trigger).
- Central (push) scheduler ([ADR-0001](../adr/0001-pull-scheduler.md)).
- Persisting terminal output history (ADR-0003, ADR-0008).
- Model calls on the server: chat, triage and summaries run on the user's machines (ADR-0015).
- Third-party credentials on the server (ADR-0016).

Multi-tenancy was out of scope until 2026-10-26; [ADR-0012](../adr/0012-hosted-multi-user-github-sign-in.md) brings it in.

## How milestones are planned
See the *Plan* phase in [CLAUDE.md](../../CLAUDE.md). Before a milestone starts, its file is written with tasks, dependencies, parallelism and the unknowns it depends on, and Ben approves it.
