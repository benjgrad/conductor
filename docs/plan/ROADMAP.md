# Roadmap

Re-planned 2026-10-26 after Ben approved the plan "transition rules, then accounts, machines, triage, assistant and MCP". The order is **M1b → M2 → M3 → M4 → M5**; on 2026-10-27 two short milestones were proposed between M2 and M3: **M2c** (ticket requirements and verification, overlapping M2's tail) then **M2b** (ticket dependencies), so the order becomes **M1b → M2 → M2c → M2b → M3 → M4 → M5** once Ben approves ADR-0018 and ADR-0019. M3 comes before M4 because the assistant reuses the M3 tool layer. Each milestone has a file in `milestones/`. Only the next one is broken into detailed tasks; the others are outlines until the previous milestone is near done, and Ben approves each file before work starts.

| Milestone | Decisions | Status | Exit criteria |
|---|---|---|---|
| [M1 · Single machine](milestones/M1-single-machine.md) | ADR-0001..0010 | **complete, pending Ben's sign-off** (2026-10-22) | One daemon on one machine runs a ticket through `implement → build → test → done` (M1 workflow), with a `needs_input` round trip answered from the kanban board, all visible live over SSE. E2E test green. |
| [M1b · Transition rules](milestones/M1b-transition-rules.md) | [ADR-0011](../adr/0011-transition-rules.md) | **done** 2026-10-26 (all 10 tasks merged, ci green on 5c49010; Ben's sign-off pending) | Transitions are named edges with `when`, `actor`, `kinds`, `requires` and `on_unmet`. The agent finishes by naming a transition with a reason. Humans move Needs-input cards with one button per allowed transition. Checks, review, actions and **conditions** run on the move; the card stays in its column with a live "waiting for …" checklist. `ticket.kind` exists and filters transitions. `conductor` v2 is seeded. E2E green with the four ADR-0011 scenarios. Local only, no auth. |
| [M2 · Accounts, machines & hosting](milestones/M2-accounts-machines.md) | [ADR-0012](../adr/0012-hosted-multi-user-github-sign-in.md) (tenancy), [ADR-0013](../adr/0013-machine-enrollment-inventory-routing.md), [ADR-0017](../adr/0017-own-sign-in-and-self-hosting.md) | **in progress** (approved 2026-10-26; 26 tasks, groups A–J, M2-T26 added 2026-10-27): T01, T02 done; T03, T04, T05, T07 running as dogfood tickets | Hosted at https://conductor.gradyserver.com (Docker Compose behind the host's nginx) with conductor's own email + password sign-in, invite-only sign-up and a bootstrap admin who claims the existing data. Every row, route, stream and socket is scoped to an account, proved by the four isolation tests. Machines install and enroll with one `curl … /install.sh | sh` line (the orchestrator serves the daemon), report repos and capabilities, and only receive tickets they can finish. Sessions run in worktrees of a daemon reference clone (the user's checkout opt-in). A lost or revoked machine sends its sessions to a human. E2E: two accounts × two fake machines, routed and isolated; laptop sleep. |
| [M2c · Requirements & verification](milestones/M2c-requirements-verification.md) | [ADR-0019](../adr/0019-ticket-requirements-and-verification.md) (proposed) | **proposed** 2026-10-27 (11 tasks, groups A–E); shared and web tasks may start after M2-T20, orchestrator tasks after M2-T21 | Ticket bodies follow Goal / Context / FR-n / NFR-n / Out of scope / Verification, written and edited in the BlockNote editor and parsed by one shared parser. Each requirement's status is built from recorded layers (agent claim, persisted check runs with durations, reviewer / QA grades, human sign-off), and the card shows `FR 6/6 · NFR 3/4 · checks ✓ · QA pass`. `PATCH /api/tickets/:id` and a (reconstructed) prompt view per session. E2E green. |
| [M2b · Ticket dependencies](milestones/M2b-ticket-dependencies.md) | [ADR-0018](../adr/0018-ticket-dependencies.md) (proposed) | **proposed** 2026-10-27 (12 tasks, groups A–F); after M2 and M2c | The claim never starts a ticket with an unfinished dependency (`done` only; cancelled or failed waits for a human to drop it), with a "blocked by" badge. Cycles (≤ 4 tickets) are claimable together, and the orchestrator relays bounded `message_peer` messages between their agents (ADR-0007 path) until they agree on a shared interface; an exhausted budget sends the thread to a human. E2E: wait, cancelled dependency, a two-ticket cycle agreeing, budget exhaustion. |
| [M3 · Tool layer & MCP](milestones/M3-mcp.md) | [ADR-0014](../adr/0014-tool-layer-and-oauth-mcp-server.md) | outline | One tool layer with twelve tools, each result ≤ 8 KB with pagination. `/mcp` over Streamable HTTP, protected by conductor's own OAuth 2.1 server (discovery, dynamic client registration, PKCE, conductor's own sign-in (ADR-0017), account-scoped tokens, revocation). E2E: an MCP client completes OAuth, then creates and reads tickets with bounded responses. |
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

Multi-tenancy was out of scope until 2026-10-26; [ADR-0012](../adr/0012-hosted-multi-user-github-sign-in.md) brings it in. [ADR-0017](../adr/0017-own-sign-in-and-self-hosting.md) replaces its GitHub sign-in with conductor's own and fixes the hosting (2026-10-26).

## How milestones are planned
See the *Plan* phase in [CLAUDE.md](../../CLAUDE.md). Before a milestone starts, its file is written with tasks, dependencies, parallelism and the unknowns it depends on, and Ben approves it.
