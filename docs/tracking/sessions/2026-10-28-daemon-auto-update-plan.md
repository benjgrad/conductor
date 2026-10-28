# Session 2026-10-28 · daemon-auto-update-plan

- **Lead**: Claude (Opus 5.5) with Ben · background session
- **Milestone / phase**: M2 · Plan
- **Goal for this session**: Ben: "improve our daemon so it auto-updates and starts when the user opens the laptop."

## What happened
- Found that starting at login is already M2-T18 (todo; deps T04 and T14 are both merged, so it is unblocked). Auto-update had no design: ADR-0017 made upgrades a manual `install.sh` re-run.
- Ben chose (AskUserQuestion): **server-announced** trigger, **drain then update**, **automatic rollback**, **on by default with a per-machine opt-out**.
- Wrote ADR-0021 (proposed) and amended ADR-0017's "Upgrades" bullet to point to it. Updated 03-protocols (`update_available`, `heartbeat.draining`, the `update_failed` alert), 10-contracts §Daemon auto-update, and 08 §Bad daemon update.
- M2 plan: extended T18 with the version-independent launcher `conductor-launch` and a wake check (a wall-clock jump of more than 30 s reconnects at once). Added T18b (contracts), T18c (daemon updater + rollback), T18d (orchestrator), T18e (web). T22 now covers one update and one rollback.
- No DB migration is needed: `machine.status` already has `draining`, and update failures ride the existing durable `alert`. T18d stops and reports if storing machine-level alerts turns out to need one.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| none | | | |

## Tracking changes
- Unknowns raised / resolved: none
- Blockers raised / cleared: none
- Tech debt added / paid: none
- ADRs: ADR-0021 (proposed)
- Unfinished handoffs written: none (plan branch `m2-t18b-plan-daemon-autoupdate`, PR open)

## Next session should start with
- Once Ben accepts ADR-0021 and merges the plan PR, queue M2-T18 and M2-T18b (both unblocked, no file overlap) as tickets or implementer agents. T18c follows T18 + T18b; T18d needs T16 and T17.
