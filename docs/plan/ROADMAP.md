# Roadmap

Re-planned 2026-10-26 after Ben approved the plan "transition rules, then accounts, machines, triage, assistant and MCP". The order is **M1b → M2 → M3 → M4 → M5**; on 2026-10-27 two short milestones were proposed between M2 and M3: **M2c** (ticket requirements and verification, overlapping M2's tail) then **M2b** (ticket dependencies), so the order is **M1b → M2 → M2c → M2b → M3 → M4 → M5** (Ben approved ADR-0018 and ADR-0019, 2026-10-27). On 2026-10-27 Ben also asked for **M2r** (review and merge, [ADR-0020](../adr/0020-review-and-merge-flow.md), proposed) **next, before the early you-only deploy**, so the order is **M1b → M2 (with M2r before its early deploy) → M2c → M2b → M3 → M4 → M5**. M3 comes before M4 because the assistant reuses the M3 tool layer. Each milestone has a file in `milestones/`. Only the next one is broken into detailed tasks; the others are outlines until the previous milestone is near done, and Ben approves each file before work starts.

| Milestone | Decisions | Status | Exit criteria |
|---|---|---|---|
| [M1 · Single machine](milestones/M1-single-machine.md) | ADR-0001..0010 | **complete, pending Ben's sign-off** (2026-10-22) | One daemon on one machine runs a ticket through `implement → build → test → done` (M1 workflow), with a `needs_input` round trip answered from the kanban board, all visible live over SSE. E2E test green. |
| [M1b · Transition rules](milestones/M1b-transition-rules.md) | [ADR-0011](../adr/0011-transition-rules.md) | **done** 2026-10-26 (all 10 tasks merged, ci green on 5c49010; Ben's sign-off pending) | Transitions are named edges with `when`, `actor`, `kinds`, `requires` and `on_unmet`. The agent finishes by naming a transition with a reason. Humans move Needs-input cards with one button per allowed transition. Checks, review, actions and **conditions** run on the move; the card stays in its column with a live "waiting for …" checklist. `ticket.kind` exists and filters transitions. `conductor` v2 is seeded. E2E green with the four ADR-0011 scenarios. Local only, no auth. |
| [M2 · Accounts, machines & hosting](milestones/M2-accounts-machines.md) | [ADR-0012](../adr/0012-hosted-multi-user-github-sign-in.md) (tenancy), [ADR-0013](../adr/0013-machine-enrollment-inventory-routing.md), [ADR-0017](../adr/0017-own-sign-in-and-self-hosting.md) | **in progress** (approved 2026-10-26; 26 tasks, groups A–J, M2-T26 added 2026-10-27): T01–T10 done, plus follow-ups T08b, T09b, T10b; T07b, T14 running as dogfood tickets and T15a queued (2026-10-27). T15 split into T15a / T15b for an early you-only deploy | Hosted at https://conductor.gradyserver.com (Docker Compose behind the host's nginx) with conductor's own email + password sign-in, invite-only sign-up and a bootstrap admin who claims the existing data. Every row, route, stream and socket is scoped to an account, proved by the four isolation tests. Machines install and enroll with one `curl … /install.sh | sh` line (the orchestrator serves the daemon), report repos and capabilities, and only receive tickets they can finish. Sessions run in worktrees of a daemon reference clone (the user's checkout opt-in). A lost or revoked machine sends its sessions to a human. E2E: two accounts × two fake machines, routed and isolated; laptop sleep. |
| [M2r · Review & merge](milestones/M2r-review-merge.md) | [ADR-0020](../adr/0020-review-and-merge-flow.md) (**proposed**) | **in progress** (13 tasks; T01, T02 done, T03 in review PR #56, 2026-10-29); proposed 2026-10-27 | After the PR opens a ticket goes to **In QA** (conductor's independent QA session on a fresh checkout of the exact PR commit; `qa_fail` back to Implementing with the findings, ≤ 3 rounds, then a human), then **Ready to merge**, whose only actions are **Merge** (conductor's `merge_pr`, pinned to the reviewed commit, with a migration approval when the diff has migrations) and Request changes. Done only through a merge or "Close without merging". `conductor` v3 seeded, `conductor_dev` v3 posted. E2E green with ten scenarios. No DB migration. |
| [M2c · Requirements & verification](milestones/M2c-requirements-verification.md) | [ADR-0019](../adr/0019-ticket-requirements-and-verification.md) | **approved** 2026-10-27 (11 tasks, groups A–E); shared and web tasks may start after M2-T20, orchestrator tasks after M2-T21 | Ticket bodies follow Goal / Context / FR-n / NFR-n / Out of scope / Verification, written and edited in the BlockNote editor and parsed by one shared parser. Each requirement's status is built from recorded layers (agent claim, persisted check runs with durations, reviewer / QA grades, human sign-off), and the card shows `FR 6/6 · NFR 3/4 · checks ✓ · QA pass`. `PATCH /api/tickets/:id` and a (reconstructed) prompt view per session. E2E green. |
| [M2b · Ticket dependencies](milestones/M2b-ticket-dependencies.md) | [ADR-0018](../adr/0018-ticket-dependencies.md) | **approved** 2026-10-27 with Ben's amendments (15 tasks, groups A–G); after M2 and M2c | The claim never starts a ticket with an unfinished dependency (`done` only). A cancelled or failed dependency gets an orchestrator **unblock assessment** (a one-shot `claude -p` on the user's machine: proceed / retry once / propose a replacement / escalate), and every other path ends at a human decision. Cycles (no size cap) are claimable together, and the orchestrator relays bounded `message_peer` messages between their agents (ADR-0007 path) until they agree on a shared interface; an exhausted message budget sends the thread to a human. Concurrency is **hardware-based**: daemons admit work by measured free RAM and CPU, with hysteresis. E2E: wait, assessment proceed and escalate, a two-ticket cycle agreeing, budget exhaustion, a three-ticket cycle under limited headroom. |
| [M3 · Tool layer & MCP](milestones/M3-mcp.md) | [ADR-0014](../adr/0014-tool-layer-and-oauth-mcp-server.md) (**accepted** 2026-10-27) | **approved** 2026-10-27 (19 tasks: 17 in groups A–H, plus T18 / T19 after M2b / M2c; one migration, T02). **Runs right after M2r, before the rest of M2** (Ben, 2026-10-27) | Eleven tools (six read, five write), each result ≤ 8 KB with cursors. `/mcp` is stateless Streamable HTTP, protected by conductor's own OAuth 2.1 server: discovery, dynamic registration, PKCE S256, conductor's sign-in and a consent page, opaque hashed tokens bound to `/mcp` and to one account, refresh rotation, rate limits, audit with the client's name, and Connected apps to revoke. A Connect Claude page. E2E with the official SDK client; Ben connects Claude Code and claude.ai to the hosted instance. |
| [M4 · Intake & assistant](milestones/M4-intake-assistant.md) | [ADR-0015](../adr/0015-triage-and-assistant-on-the-users-machine.md) | outline | New tickets pass triage (deterministic fields, then a clarity check on a machine) before Queued, with questions answerable on the card or in chat. A chat panel runs a per-account `claude` conversation on an online machine, using the tool layer; writes need a click. Summaries are refreshed on events. With no machine online the panel shows the needs-attention list. E2E: triage asks for the kind; the chat answers an input request through a tool. |
| [M5 · Work connectors](milestones/M5-work-connectors.md) | [ADR-0016](../adr/0016-work-connectors-on-the-users-machine.md) | outline | GitHub checks, approvals and merges as conditions (polling plus webhook hints); Jira field updates and status reads; Azure Pipelines status for a branch; an approval-gated Slack message. All run on the user's machine via its CLIs and MCPs, routed by capability, with no third-party secrets on the server. `conductor` v3 turns on the Jira and Azure conditions. E2E with fake CLIs. |
| [MW · Native Windows daemon](milestones/MW-windows-daemon.md) | [ADR-0024](../adr/0024-native-windows-daemon.md) | **approved** 2026-10-28 (14 tasks, T00 done, groups A–F); independent lane, T09/T10 after M2-T18 | The daemon runs natively on Windows with the same guarantees (tree kill via `taskkill /T` + orphan sweep, fail-closed edit guard, owner-only DACL credentials). `install.ps1` + Scheduled Task enrolls and starts it at logon. GitHub Actions `windows-latest` green (unit + fake-claude e2e); Ben's laptop smoke run passes. |
| [MR · Rust daemon](milestones/MR-rust-daemon.md) | [ADR-0026](../adr/0026-rust-daemon.md) | **approved** 2026-10-29 (19 tasks, groups A–H); the TS daemon is frozen to bug fixes from tag `daemon-ts-freeze`, and M2/MW daemon-side tasks move here | `conductor-daemon` is a native Rust binary on macOS, Linux and Windows; every TS daemon test has a Rust counterpart (PARITY.md 100%); protocol types generated from zod with two-sided fixture parity; shipped in the same tarball layout through the same `install.sh`/`install.ps1` in-place upgrade, then ADR-0021 auto-update; e2e green against the binary; every machine moved and one dogfood day per OS; `packages/daemon` deleted. |

## Order of work (2026-10-29, routing first)
Ben approved this order after an inventory of PRs #1–#69 against the code at 0b3b8bb. Sign-in, invites, enrollment and the Machines page are live, but the gateway drops the daemon's v2 `inventory` (TD-112), and the claim has no routing: every online machine takes every ready ticket. Ben's goals are three: several machines (Mac, gradyserver, the Windows work laptop with IIS), the whole backlog queued at once, and the board usable from his phone. So:

1. **M2-T16a**: inventory ingest, then routing by repo and required capabilities in the claim, the Queued "needs a machine with …" badge, and the drawer's "can't take" list. It's split out of T16 and doesn't wait for T12.
2. **IIS runtime slot** (U-070, from [the Windows spike](../design/windows-spike.md) FR-3): a repo declares a fixed-path runtime, the daemon reports it, and routing sends those tickets only to that machine, with one slot per (machine, runtime). It needs an ADR and Ben's answers to U-070's sub-questions first; no tasks yet.
3. **Dependencies-lite**: a slice of M2b pulled ahead of M2. It covers `depends_on`, the claim waiting for `done`, "blocked by", and dropping a failed dependency. It goes after T16a because both edit `gateway/claim.ts`. Cycles, the relay, assessments and hardware admission stay in M2b. Not planned yet.
4. **Phone**: UX-9 → UX-12 (mobile) and UX-15 → UX-14 / UX-16 (push). These touch the web only, apart from UX-15, so they run beside 1–3.
5. **MCP**: the rest of M2r, then M3, as before.

The rest of M2 (isolation T19–T21 before any second account, auto-update, agent settings, the e2e and deploy tail), then M2c and the rest of M2b, follow.

## Order of work (2026-10-27, M3 moved up)
Ben chose to do M3 (MCP) **right after M2r** and before the rest of M2, so that he can use conductor from Claude Code and claude.ai. The order of work is now:

**M1b → M2's you-only slice (done; live) → M2r → M3 → the rest of M2 → M2c → M2b → M4 → M5**

(M3-T18 and T19 follow M2b and M2c.)

- **M3 needs from M2**, already merged: T08 / T08b (auth core), T14 (distribution), T15a (bootstrap and CLI), T15b1 (admin routes), T17 (machines REST), and the you-only deploy.
- **M3 does not need** T15b's general sign-up, because grants belong to existing users.
- **Isolation** (T16, T19, T21) is needed **before any second account**, not before M3. M3 scopes its own queries and adds a two-account `/mcp` test, and M2-T21's route matrix gains `/mcp` and `/api/oauth/*` (M3-T16 adds the note). TD-149 stands: no second account on the hosted instance until T21.
- **M2c-T02** builds `parseTicketBody` on M3-T04's `splitBodySections`.
- **M2b** has no change: M3 audits writes in `mcp_tool_call`, not in `event.ticket_id`.

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

## Future features (wanted, not yet scheduled)
Ben's asks that have no milestone yet. Each gets a milestone (or a ticket in one) when it's planned, and Ben approves it like any other plan.

- **Attach a running Claude session to conductor** (Ben, 2026-10-28). A Claude Code session the user started themselves (in a terminal, the IDE or the desktop app) joins conductor as a ticket, so it shows on the board, surfaces needs-input, and can be finished by conductor. The design is open: [U-097](../tracking/UNKNOWNS.md). The likely shape is a hand-off. From inside the session, a `conductor` MCP tool (M3's tool layer) or a `conductor attach` command creates or links a ticket with the session's `claude_session_id`, cwd and branch. The daemon on that machine then resumes the session (`claude --resume`, ADR-0005) in stream-json mode and the user's terminal steps away. It needs M3 (the client-side tool), M2's machines and routing (the daemon that owns that checkout), and a decision on the user's own checkout versus a daemon worktree (ADR-0013).

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
