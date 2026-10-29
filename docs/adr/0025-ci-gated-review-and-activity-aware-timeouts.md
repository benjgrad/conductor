# ADR-0025 · CI-gated review and activity-aware agent timeouts

- **Status**: accepted (Ben, 2026-10-29; part 2 is built in M2-T31b)
- **Date**: 2026-10-29
- **Deciders**: Ben (+ Claude session, background job "we keep hitting the timeout")
- **Resolves**: U-072 (`pr_checks_green` with zero checks)

## Context
Ben, 2026-10-29: *"We keep hitting the timeout … is it 30 minutes to do everything? Is it 30 minutes for a single command? … our workflow doesn't catch when PR checks fail. Agents should be able to resume work, and fix them until the issue is fixed."*

What the production database showed (`conductor` v2):
- `timeout` was the most common reason a session reached a human: 20 of 44 input requests (11 planning at 20m, 9 implementing at 30m). Nearly every answer was "keep going".
- A state `timeout` is **one wall clock per visit of the state** (`deadlineFor`), armed when the session is assigned. It covers everything the agent does, its own test runs included. It is not per command.
- The clock starts before Claude does. `session.started` → `agent.claude_session_id` took 8–10 minutes under load (3–4 sessions starting at once on one machine). The time goes to the Claude CLI before its `system/init` line; the daemon's own work is finished before `started`.
- A timeout does not kill the agent (`enter` into a human state emits no `kill`). One agent "timed out" in Planning, finished its plan 11 minutes later, and the result was dropped as `wrong_status`.
- A pending permission prompt (ADR-0023, held up to 30 min) does not pause the clock.
- The daemon never set the Claude CLI's Bash limits, so an agent's own `pnpm test` was killed at the CLI's 2-minute default and re-run until the state timed out.
- Every live ticket was `personal`. `personal_pr_ready_for_review` and `done` never read GitHub CI after `open_pr`: a red PR reached Ben as "ready for review". Only `ready_for_testing` (work) had `pr_checks_green`.

## Decision
**1. A ticket reaches a human for review only with green PR CI** (built in M2-T31a, `conductor` v3):
- Every transition out of Implementing that ships code (`pr_ready_for_review`, `personal_pr_ready_for_review`, `ready_for_testing`, `done`) has `requires.conditions: [{type: pr_checks_green, no_checks_after: "5m"}]`. The two review hand-offs and `done` poll every minute (`condition_poll: 1m`) for at most 2 hours (`condition_timeout: 2h`); `ready_for_testing` keeps its approval, 2m poll and 3d timeout.
- A failed check is `unmet`: back to Implementing in the agent's own conversation (the existing ADR-0011 path), counted, 3 retries, then Needs input. The evidence names each failing check with its https link, and the instruction says how to read the log (`gh pr checks <pr>`, `gh run view <run-id> --log-failed`). The next round's checks and `open_pr` push the fix, and the head pin makes sure the new commit is the one judged.
- **U-072**: new optional `pr_checks_green.no_checks_after` (a duration). A PR that still reports *no checks at all* that long after the conditions phase started (`GateStep.conditions_started_at`) is met, with the detail "no CI checks reported within 5m". Checks that exist but are still running are never graced. Without the field, no checks stays pending (the v2 behaviour). It is the engine's rule: the zero-checks answer is the daemon's `value` `NO_PR_CHECKS_VALUE` (`"0/0 passed"`), and the field is stripped from `evaluate_conditions` args, so daemons that predate it keep working (their condition schema is strict).
- `conductor` v3 also raises the state ceilings: Planning 60m, Implementing 2h, `budget.minutes` 240.
- The daemon gives agents `BASH_DEFAULT_TIMEOUT_MS` = 10 min and `BASH_MAX_TIMEOUT_MS` = 30 min.

**2. Agent timeouts measure inactivity, with the wall clock as a ceiling** (M2-T31b, not built yet):
- An agent state may declare `idle_timeout` (v3 values: 15m). The daemon reports per-session activity in its heartbeat (last output, tool calls in flight, a held permission prompt). The orchestrator keeps `session.last_activity_at`, and the sweep feeds `agent.idle` through apply when there has been no activity for `idle_timeout`. A tool call in flight or a pending permission prompt counts as activity.
- The ceiling (`timeout`) is re-armed when Claude reports its session id, so startup no longer eats the box.
- A timeout from an agent state kills the agent. Answering the timeout resumes the conversation (`--resume`).

## Alternatives considered
| Option | Why not |
|---|---|
| Only raise the 20m / 30m limits | A stuck agent still holds the machine for the whole ceiling; it does not tell working from stuck. Done anyway as the backstop. |
| Ceiling only, but pause it during permission prompts | Fixes one cause, not the real one (no notion of activity). |
| Zero checks → met immediately | A slow-to-start CI run would be skipped. Ben chose a 5-minute grace. |
| Zero checks → wait for the condition timeout, then a human (v2 behaviour) | Every repo without CI would park every ticket. |
| The grace in the daemon (`since` in the args) | Needs a protocol change and a coordinated daemon upgrade (U-102); the engine already knows when the phase started. |
| A new outcome / state for "CI failed" | The ADR-0011 `requires.conditions` + `on_unmet` loop already does this, bounded and counted. |

## Consequences
- Good: a red PR goes back to the agent with the failing check instead of to Ben; repos without CI still flow (5 min); agents' own test runs are no longer killed at 2 minutes; fewer false timeouts.
- Bad / accepted cost: a review hand-off now waits for CI (up to 2h, then a human). The machine slot stays held while conditions poll (existing TD). `conductor` v3 takes the version number M2r-T10 had planned; M2r's definition becomes v4.
- Follow-ups: M2-T31b (part 2); a new unknown on why the Claude CLI takes 8–10 min to start under load; CI going red after the hand-off (main moved) stays with M2r's `inspect_pr`.

## Revisit when
- Timeouts stay a top input-request kind after T31b ships, or agents are killed while visibly working.
- A repo's CI routinely takes more than 5 minutes to report its first check (raise `no_checks_after`).
