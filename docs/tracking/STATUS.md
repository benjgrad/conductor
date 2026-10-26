# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-26 · session [2026-10-23-agent-inherit-settings](sessions/2026-10-23-agent-inherit-settings.md) (continued)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. Post-M1 work merged on Ben's requests:
  - ADR-0006 (his settings + hard guards);
  - ADR-0007 (live messages);
  - ADR-0008 (transcript history + reopen);
  - ADR-0009 (reviewer agent);
  - [ADR-0010](../adr/0010-one-workflow-columns-are-states.md) (one workflow, `conductor`; its states are the board columns; requirements to enter a column, with checks run on a fresh checkout of the commit, a reviewer, and conductor opening the PR).
- **Phase**: M1 sign-off, then M2 planning
- **Next action**:
  - Ben runs a real ticket on the new board: Planning → Implementing → checks → PR (pushes with Ben's own `gh`) → Approve → Done.
  - Ben signs off M1 and rules on U-045 and U-048.
  - Lead fixes U-046 / U-050 (flaky daemon tests, slow node spawns) and U-049.
  - Lead checks that the real-CLI `--resume` appends to the same transcript (ADR-0008 unknown).
  - Lead pays TD-082 and TD-091 before relying on reviews over long branches.
  - Plan M2, with TD-088 (hard reopen pin) in scope.
  - Main is ahead of origin; Ben pushes.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 30 open of 50 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 72 open of 95 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done. Exit criteria met; awaiting Ben's sign-off.

## Last session
**ADR-0010**, built by parallel agents, QA'd each round, merged as db29c0c and live:
- `conductor` v1 is seeded, and it is the only workflow;
- the board renders the workflow's columns, with badges;
- entry step: a clean pre-check, then setup and checks in a fresh conductor-owned checkout of the exact commit, then the reviewer, then `open_pr`;
- `open_pr` pushes the checked sha from an ephemeral private repo with hooks and config neutralised, and runs gh `--repo`;
- the PR URL comes only from conductor's action;
- gate verdicts are fenced to the reviewer (this also fixed the ADR-0009 path);
- the column editor covers title, work, checks, setup, review, open_pr and on_unmet;
- the ticket form has no workflow picker;
- `run_action` enum migration applied (Ben approved).

Security reviews and QA found 9 issues across rounds; all were fixed or recorded. Gates: 847 tests, e2e 10. New: TD-093..095, U-050.
