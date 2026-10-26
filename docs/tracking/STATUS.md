# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-26 · session [2026-10-23-agent-inherit-settings](sessions/2026-10-23-agent-inherit-settings.md) (continued)

## Now
- **Milestone**: [M1b · Transition rules](../plan/milestones/M1b-transition-rules.md) (ADR-0011, accepted), **in progress**. M1 is complete pending Ben's sign-off.
- **Roadmap** ([ROADMAP](../plan/ROADMAP.md)), re-planned 2026-10-26:
  - M1b transition rules;
  - M2 hosted accounts + machine enrollment, inventory and capability routing (ADR-0012/0013);
  - M3 tool layer + OAuth MCP (ADR-0014);
  - M4 triage + assistant chat on the user's machine (ADR-0015);
  - M5 work connectors (ADR-0016).
  
  ADR-0012..0016 are proposed.
- **Phase**: M1b Orchestrate, group A (T01 contracts)
- **Next action**:
  - Lead: T01 contracts → group B (T02–T07 in parallel) → group C (T08, T09) → T10 e2e, QA each.
  - Before M2, Ben answers U-051, U-056, U-057, U-060 and U-067.
  - Main is ahead of origin; Ben pushes.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| M1b-T01 contracts | m1b-t01-contracts | implementer | starting |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 44 open of 69 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 72 open of 95 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
- M1: 18 / 18 done; awaiting sign-off.
- M1b: 0 / 10 done (T01 in progress).
- M2–M5: outlined.

## Last session
- **ADR-0010** (one workflow, columns = states, checks on a fresh checkout) is merged and live.
- **Ben re-planned:** rules move to transitions (ADR-0011), plus the platform roadmap (accounts, machines, MCP, assistant, connectors).
- **Planning:** a planner agent drafted ADR-0012..0016, the roadmap and the milestone files. Ben answered U-058/059/061–063 and approved M1b.
- **New unknowns:** U-051..U-069.
