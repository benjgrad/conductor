# Session 2026-10-26 · m1b-transition-rules

- **Lead**: Claude (Opus 5.5) with Ben · session link: https://claude.ai/code/session_01NhmNbZ2iRArH99MxNSABmj
- **Milestone / phase**: M1b · Orchestrate → QA → done
- **Goal for this session**: build and merge M1b, which puts rules on transitions ([ADR-0011](../../adr/0011-transition-rules.md)).

## What happened
- **Group A**: T01 contracts merged (7431131).
- **Group B**:
  - T07 web board (6726b05);
  - T02 validator rules 10–14 (9a33f01);
  - T04 orchestrator: `ticket.kind`, `POST /api/sessions/:id/transition`, moves (490e76a). Ben approved the `ticket.kind` migration, and it's applied to the dev DB;
  - T03 engine: named transitions, move steps, kind-filtered prompts (bd0813d);
  - T06 workflow editor: transition arrows and panel (a7c7679);
  - T05 daemon: named outcomes, gh PR conditions (ac52bb6).
- **T05 security** took three fix rounds:
  - only OWNER / MEMBER / COLLABORATOR approvals count, never the PR author's;
  - approvals count only on the current head;
  - CHANGES_REQUESTED blocks on any commit until the same reviewer approves on the head or the review is dismissed; a stale approval doesn't clear it;
  - head_sha pinning: if the PR head isn't the commit conductor pushed, every PR condition fails.
- **Group C**: T08 conditions phase (516bf82): poll, backoff 2 → 15 min, timeout → human, "waiting for a machine".
- **Group C/D**: T09 (`conductor` v2 + seed upgrade) and T10 (e2e + docs sweep) merged together (5c49010). T10 was stacked on T09, so main never had v2 without the moved e2e scenario.
- **Gates**: `scripts/ci.sh` green on main 5c49010: 1115 unit tests, e2e 15 passed / 1 skipped, ~50 s.
- **Board**: orchestrator + daemon on :7400 restarted on 5c49010; the seed added `conductor` v2 to the dev DB.
- **Flakes**: U-046 / U-050 (daemon, cli-driver and web tests under load) recurred several times. Every one passed on a rerun.
- **Decisions** (DECISIONS_LOG):
  - a stale CHANGES_REQUESTED still blocks (fail closed);
  - a PR condition with no conductor PR goes straight to `on_unmet.else`, uncounted;
  - the backoff "unchanged" comparison ignores status-only changes;
  - neutral "not produced" input wording;
  - v2 splits `pr_ready_for_review` (work) from `personal_pr_ready_for_review` (personal);
  - null-kind tickets see both twins (U-062);
  - T09 and T10 merged together.
- **Doc-keeper**: swapped the T08 `// TD:` markers in apply.ts for TD-104 / TD-105; added `// TD-103` (apply.ts conditions `action.completed`) and `// TD-100` (web `validateTransitions`); reordered the `pr_approvals` header comment in daemon conditions.ts to match the code (blockers first).

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| implementer + qa-reviewer | M1b-T01 contracts | m1b-t01-contracts | PASS, merged 7431131 |
| implementer + qa-reviewer | M1b-T02 validator | m1b-t02-validator | PASS, merged 9a33f01 |
| implementer + qa-reviewer | M1b-T03 engine | m1b-t03-engine | PASS, merged bd0813d |
| implementer + qa-reviewer | M1b-T04 orchestrator | m1b-t04-orchestrator | PASS, merged 490e76a |
| implementer + qa-reviewer | M1b-T05 daemon | m1b-t05-daemon | PASS after 3 security fix rounds, merged ac52bb6 |
| implementer + qa-reviewer | M1b-T06 editor | m1b-t06-editor | PASS, merged a7c7679 (debt: TD-100) |
| implementer + qa-reviewer | M1b-T07 board | m1b-t07-board | PASS, merged 6726b05 |
| implementer + qa-reviewer | M1b-T08 conditions | m1b-t08-conditions | PASS, merged 516bf82 (debt: TD-103..105) |
| implementer + qa-reviewer | M1b-T09 conductor v2 | m1b-t09-conductor-v2 | PASS, merged with T10 in 5c49010 |
| implementer + qa-reviewer | M1b-T10 e2e + docs | m1b-t10-e2e | PASS, merged 5c49010 |
| doc-keeper | session-end tracking | tracking-2026-10-26-m1b | done |

## Tracking changes
- Unknowns raised / resolved: U-072 raised (`pr_checks_green` with zero checks: met or pending?).
- Blockers raised / cleared: none.
- Tech debt added / paid: TD-096..099 added and paid within M1b; TD-100..106 added, open.
- ADRs: none new. ADR-0011 has implementation notes (T10).
- Unfinished handoffs written: none for M1b. A housekeeping entry asks for removal of the merged `m1b-*` / `worktree-agent-*` branches and worktrees.

## Next session should start with
- Ben signs off M1b (and M1), and answers U-051, U-056, U-057 and U-067 (plus U-072).
- Lead cleans up the merged branches and worktrees, then has the `planner` agent turn the M2 outline into a full milestone file for Ben's approval.
