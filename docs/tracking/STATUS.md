# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-23 · session [2026-10-23-fix-td079-td080](sessions/2026-10-23-fix-td079-td080.md)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. All groups A–E are merged. Since then: the real-run fixes (819cea6) and TD-079/TD-080 (d83acc2)
- **Phase**: M1 sign-off, then M2 planning
- **Next action**:
  - Ben signs off M1 (exit criteria met; all 18 tasks done and QA-passed).
  - Ben approves the paid `E2E_REAL_CLAUDE=1 pnpm test:e2e` run, which also closes the T05a real-mode check ([UNFINISHED](UNFINISHED.md)).
  - Ben rules on U-045 and U-048.
  - Lead fixes U-046 (flaky daemon test; fix identified), pays TD-068, decides U-047 and U-043, confirms U-029.
  - Then plan M2.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 28 open of 48 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 58 open of 80 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done (T00, T01, T12, T13, T02, T03, T05a, T05b, T09, T04a, T04b, T06, T08, T11, T07, T09b, T14, T10). T04, T05 and T09 were split into a/b. Exit criteria met; awaiting Ben's sign-off.

## Last session
Fixed the two UI bugs from Ben's real run, merged as d83acc2 after a QA PASS:
- **TD-079**: a cancelled session no longer shows its question or answer box. The card and session detail show an open request only while `needs_input`, a read-side gate with no contract change.
- **TD-080**: sub-cent spend now reads `<$0.01`, not `$0.00`.

Gates on main: typecheck, lint, test (510 passed / 2 skipped), build and e2e (6 passed / 1 skipped), all green.
