# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-22 · session [2026-10-22-m1-group-d](sessions/2026-10-22-m1-group-d.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md), groups A–D merged (T11 by the lead, T07 and T09b via `integrate/D`)
- **Phase**: Orchestrate (group D2: M1-T14 security hardening, then group E: M1-T10 E2E)
- **Next action**: lead briefs M1-T14 (candidates TD-019, TD-059, U-045); Ben rules on U-045 (≤4000 chars of assistant text in `event.payload` / `input_request.question`); lead confirms U-029 (createCliDriver stays daemon-internal) and decides or defers U-043 (cancelled tickets with no session vanish from the board); do the T05a real-mode manual check ([UNFINISHED](UNFINISHED.md)).

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 25 open of 45 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 52 open of 67 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 16 / 18 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08, T11, T07, T09b). Left: T14 (D2, added 2026-10-22) and T10 (E). T04, T05 and T09 were split into a/b.

## Last session
Recorded the lead's T11 merge (6ef9f55) and Ben's decisions (U-028, U-032, U-033, U-039, U-040, TD-062, B-004). Merged T07 (ask/answer end to end, orchestrator `main()`/bin, no_outcome nudge, outbox prompt scrub, single renderer, `claude_code_version`) and T09b (web on the real API) via `integrate/D`; `scripts/ci.sh` green on the merged tree (475 passed / 2 skipped), main at f871554. Paid TD-021/023/034/038/043/051/055/060/062, cleared B-004, filed U-045 and TD-063..TD-067.
