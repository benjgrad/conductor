# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-a](sessions/2026-10-22-m1-group-a.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md), group A merged
- **Phase**: Orchestrate (gate: Ben accepts ADR-0005)
- **Next action**: Ben reviews and accepts [ADR-0005](../adr/0005-claude-code-driver.md) ([B-001](BLOCKERS.md)); then mark U-001/U-002 resolved and start M1-T12 (group A2). Decide U-020 (Postgres port per worktree) and U-019 (Node 22) before group B.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| M1-T00 | merged (a903c5a) | — | code done; ADR-0005 awaiting Ben |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 21 (19 open, 2 investigating) ([UNKNOWNS](UNKNOWNS.md)) | 1 ([BLOCKERS](BLOCKERS.md)) | 9 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 2 / 14 tasks done (T00, T01)

## Last session
Merged M1 group A to main after ci.sh passed on the merged tree. M1-T00 delivered the Claude Code driver spike and ADR-0005 (proposed). M1-T01 delivered the pnpm monorepo scaffold, gates and the Homebrew Postgres fallback. Both passed QA with debt. Filed U-012..U-021, TD-001..TD-009 and B-001.
