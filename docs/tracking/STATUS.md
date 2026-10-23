# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-23 · session [2026-10-23-agent-inherit-settings](sessions/2026-10-23-agent-inherit-settings.md) (continued)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. Post-M1 work merged on Ben's requests:
  - ADR-0006: Ben's settings, plus hard guards;
  - ADR-0007: live messages and slash commands;
  - the session panel: tabs and agent identities;
  - [ADR-0008](../adr/0008-transcript-history-and-reopen.md): history from Claude's transcript, and reopen;
  - [ADR-0009](../adr/0009-transition-requirements-review.md): transition requirements checked by a reviewer agent, and the Workflows UML view and editor.
- **Phase**: M1 sign-off, then M2 planning
- **Next action**:
  - Ben tries the Workflows view and a ticket on `m1_reviewed` (saved locally); reopens a done ticket; then signs off M1.
  - Ben rules on U-045 and U-048.
  - Lead:
    - fixes U-046 (two flaky daemon tests) and U-049;
    - checks the real-CLI `--resume` appends to the same transcript (ADR-0008 unknown);
    - pays TD-082 and TD-091 before M3.
  - Plan M2, with TD-088 (hard reopen pin) in scope.
  - Main is ahead of origin; Ben pushes.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 29 open of 49 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 69 open of 92 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done. Exit criteria met; awaiting Ben's sign-off.

## Last session
- **ADR-0008**: an empty Messages tab loads Claude's transcript from the daemon. Reopen resumes the same Claude conversation on the same branch and worktree. No migration.
- **ADR-0009**:
  - `requirements` gates on transitions;
  - a fresh read-only reviewer in forced dontAsk mode;
  - unmet → back with the reasons and an instruction, bounded, then a human;
  - validator rule 8;
  - GET /api/workflows/:id with `versions`;
  - an in-house SVG UML diagram and editor, with a draft guard;
  - the session diagram highlights the state, or the edge under review;
  - `m1_reviewed` example workflow;
  - no migration.
- **QA**: every branch PASS WITH DEBT. Main green: 721 tests, e2e 9.
- **Restarted** the orchestrator and daemon on main.
- **Tracking**: TD-088..092 added, TD-033 paid, U-046 extended.
