# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Every other agent (local or conductor ticket) updates only its own *In flight* row, on its branch. Keep it under one screen.

**Updated**: 2026-10-29 · sessions [2026-10-29-inventory-reconcile](sessions/2026-10-29-inventory-reconcile.md), [2026-10-29-rust-daemon-plan](sessions/2026-10-29-rust-daemon-plan.md)

## Now
- **Rust daemon (MR, 2026-10-29)**: Ben chose to port `packages/daemon` to Rust now ([ADR-0026](../adr/0026-rust-daemon.md), [MR](../plan/milestones/MR-rust-daemon.md), 19 tasks, PR #69). The TS daemon freezes to bug fixes at tag `daemon-ts-freeze` once #69 merges; daemon-side M2/MW tasks move to MR. Built on the board in 13 waves: wave 1 (MR-T01 spike, ticket e4bbe7dd) posted 2026-10-29. **Ben**: merge #69, install rustup on the agent machines (B-005), answer U-112.
- **Live**: https://conductor.gradyserver.com runs origin/main **0b3b8bb** (`/healthz`, CI deploys from the self-hosted runner, PR #57). Sign-in, invites, machine enrollment (macOS / Linux `install.sh`, Windows `install.ps1`), the Machines page, permission prompts on the board, `conductor` v5 (green CI before review, Done only through a human, screenshots on UI PRs).
- **The gap (code review, 2026-10-29)**: the gateway drops the daemon's v2 `inventory` and `alert` (TD-112), so the Machines drawer's Capabilities list is always empty. The claim has no routing, so **every online machine takes every ready ticket**. IIS is a spike report only (U-070).
- **New order** ([ROADMAP §2026-10-29](../plan/ROADMAP.md)): M2-T16a (ingest + routing + badge) → IIS runtime slot (ADR + U-070 first) → dependencies-lite (not planned yet), with mobile (UX-9 → UX-12) and push (UX-15 → UX-14 / UX-16) beside them, then M2r → M3 (MCP).
- **Next action**:
  - Ben: merge `docs/reconcile-2026-10-29`. On the local checkout, drop the unpushed 178f5a8 (its TD-189 collides with origin's TD-189; it is TD-195 now) and fast-forward `main`.
  - Ben: approve UX-15's migration (PR #67); review #56 (M2r-T03), #65 (M2-T35b), #69 (Rust daemon plan).
  - Lead: post M2-T16a, UX-9 and UX-14 as tickets (disjoint files); write the IIS runtime-slot ADR and U-070's sub-questions; plan dependencies-lite.

## In flight
| Task | Where | State |
|---|---|---|
| M2r-T03 QA state | PR #56 | in_review |
| M2-T35b screenshots attached to the PR | PR #65 | in_review (v5 already asks for them, T35c merged first) |
| UX-15 Web Push (server) | PR #67 | in_review; migration needs Ben |
| MR-T00 Rust daemon plan | PR #69 | in_review (plan only) |
| MR-T01 Rust spike | board ticket e4bbe7dd | ready (posted 2026-10-29); stops for `cargo` until B-005 |
| MR-T04 Rust `platform/` (spawn, Job Objects, procinfo, ACLs, shell, …) | branch `mr-t04-platform` | in_review; Windows code proven only by the `daemon-rust` matrix |
| MR-T03 protocol codegen | board ticket (this branch) | in_review: conductor opens the PR; waits for the `daemon-rust` 3-OS matrix |
| M2-T18 `service install`, M2-T18b, MW-T09 | tickets / branches | in_progress; TD-195 (`install.sh --service` fails) until T18 |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 65 open of 116 ([UNKNOWNS](UNKNOWNS.md); +U-112..116 for MR) | 1 open of 5 ([BLOCKERS](BLOCKERS.md): B-005 Rust toolchain) | 153 open of 195 ([TECH_DEBT](TECH_DEBT.md)); high: TD-112 (inventory dropped; T16a), TD-195 (no `service` command), TD-149 (no second account before T21) | 6 ([UNFINISHED](UNFINISHED.md)): open PRs + next tickets, UX waves, M3 waves, Hazel / Nova, M1-T05a manual check, M1b branch cleanup |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off. M1b: 10 / 10 done; awaiting sign-off.
- M2 (61 rows): 32 done, 3 in progress (T15b, T18, T18b), 1 in review (T35b), 2 split (T15, T16 → T16a), 22 todo (incl. T16a), 1 cancelled. Out of plan: UX-1..UX-8b, BUG-1/1b/2, SPIKE-1, FIX-1, CI-1..3 merged.
- M2r: 2 / 13 done (T01, T02), T03 in review. MW: 9 / 15 done (T00–T08, T11), T09 in progress.
- UX board: UX-10, UX-11 done; UX-15 in review; UX-9, UX-12, UX-13a/b, UX-14, UX-16 todo.
- MR (Rust daemon, ADR-0026): approved 2026-10-29; 0 / 19 done, T00 in review (PR #69), T01 posted. MW-T09 rest..T13 moved to MR.
- M2c, M2b: approved, not started. M3: approved, waits on M2r. M4, M5: outlined.

## Last session
- **Inventory**: mapped PRs #1–#69 to tasks against the code at 0b3b8bb; the milestone tables had missed ~25 merges (2026-10-27..29). Updated M2, M2r, MW and the UX board; added the out-of-plan rows.
- **Found**: no inventory ingest and no routing (above); TD-189 used twice (renumbered the local one to TD-195); TD-187 / TD-188 sat inside the template comment (moved out).
- **Planned**: M2-T16a split out of T16 (doesn't wait for T12); new order of work in ROADMAP.
