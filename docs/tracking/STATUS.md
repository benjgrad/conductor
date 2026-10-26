# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-26 · session [2026-10-26-m1b-transition-rules](sessions/2026-10-26-m1b-transition-rules.md)

## Now
- **Milestone**: [M1b · Transition rules](../plan/milestones/M1b-transition-rules.md) is **done** (all 10 tasks merged, `scripts/ci.sh` green on 5c49010), pending Ben's sign-off. M1 is also still awaiting sign-off.
- **Next**: [M2 · Accounts & machines](../plan/milestones/M2-accounts-machines.md). Its file is an outline. It gets planned in full once Ben answers the open unknowns below.
- **Board**: orchestrator + daemon on :7400, restarted on 5c49010; the dev DB has `ticket.kind` and `conductor` v2.
- **Next action**:
  - Ben: sign off M1b (and M1). Answer the M2 unknowns: U-051 (tenancy), U-056 (moving data into an account), U-057 (hosting, domain, Postgres), U-067 (publishing `@conductor/daemon`). Also open for M2: U-068 (lost lease → human), U-070 (fixed-path runtimes / IIS), U-071 (daemon on Windows).
  - Ben: decide U-072 (`pr_checks_green` with zero checks: met or pending? Pending today).
  - Later milestones, still open: U-052 (M5 webhooks), U-053 (M4 summaries), U-054 (M3 MCP rate limits), U-055 (M4 chat backend), U-064 (M4 triage questions), U-065 (M5 MCP connectors), U-066 (M4 chat history), U-069 (M3 MCP scopes).
  - Lead: remove the merged `m1b-*` and `worktree-agent-*` branches and worktrees ([UNFINISHED](UNFINISHED.md)); then plan M2 with the `planner` agent.
  - Main is ahead of origin; Ben pushes.

## In flight
None.

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 46 open of 72 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 79 open of 106 ([TECH_DEBT](TECH_DEBT.md)) | 2: the M1-T05a manual check, and branch cleanup ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off.
- M1b: 10 / 10 done; awaiting sign-off.
- M2: next, outline. M3–M5: outlined.

## Last session
- **M1b built and merged**, in groups A → B → C → D: contracts, validator rules 10–14, orchestrator (`ticket.kind`, transition route, moves), engine (named transitions, move steps), editor arrows and panel, board checklist and buttons, daemon (named outcomes, gh PR conditions), conditions phase, `conductor` v2 + seed upgrade, e2e + docs.
- **T05 security**: three fix rounds. Only eligible reviewers count, approvals only on the current head, CHANGES_REQUESTED blocks until cleared, and conditions fail if the PR head isn't the commit conductor pushed.
- **Tech debt**: TD-096..099 added and paid within M1b. TD-100..106 open. **New unknown**: U-072.
- **Flakes**: U-046 / U-050 (daemon, cli-driver and web tests under load) recurred several times; every one passed on a rerun.
