# ADR-0044 · A message stops conductor's checks and review

- **Status**: proposed (amends [ADR-0027](0027-messages-while-waiting-on-pr-checks.md); Ben asked for the behaviour, 2026-11-19)
- **Date**: 2026-11-19
- **Deciders**: Ben (+ conductor ticket "Interrupt Conductor Running checks")
- **Resolves**: —

## Context
Ben, 2026-11-19: *"It should be possible to interrupt the conductor when it's running checks by messaging the agent."*

When an agent finishes a gated move, conductor runs the gate step: the checks (each in a fresh checkout, up to 10 min each), the requirements review (a reviewer agent, up to 10 min), the actions (`open_pr`), then the conditions (the PR's CI). ADR-0027 let a human's message end the **conditions** wait and resume the agent. It kept `wrong_status` (409) for the checks, review and actions phases, because "they are short and conductor is mid-judgement". It also named the case for revisiting: "People want to interrupt the checks or review phases too". The composer was off during those phases.

In practice the checks are not short: a build and a test suite can take 20 minutes, plus the wait for a build slot. And a human who spots a problem while they run (a wrong approach, a missing piece, a rebase needed) has to wait for the checks to finish, and maybe fail, before the agent can hear about it.

## Decision
While a gate step **out of an agent state** is in its **checks** or **review** phase (status `queued`, `assigned` or `running`), `operator.message {text}` ends the step and resumes the source agent with the text:
- `leaveStep(kill: true)` emits a session `kill` (no `target_command_id`). The daemon cancels the running check, drops its fresh checkout and stops a running reviewer. A requeued step has no machine, so nothing is killed.
- Then the same move as ADR-0027: `enter(from)` with the text as the pending answer, the worker's own Claude conversation resumed (a resume's prompt is the bare text), `state_entered.transition = message` (`MESSAGE_MOVE`), actor `human`, reason the text.
- No retry counter is taken. The agent finishes the move again when it is done, which runs the whole step again.
- Leaving the step bumps the fencing token (the wrapper's `stepFenced`), and the kill and the new `start_session` carry the new token. So the killed check's or reviewer's late events are stale.

Unchanged:
- The **actions** phase (`open_pr`) still refuses a message (`wrong_status`). It takes seconds and pushes to GitHub; a kill mid-push gains nothing.
- A gate step out of an event or command state still refuses a message: there is no agent to resume.
- The conditions and held phases are ADR-0027's.

The composer offers "Message" in the checks and review phases, with the note "Conductor is running checks. A message stops them: <agent> picks the ticket back up with it, then finishes the step again (the checks run again)." During the actions phase it stays off: "Conductor is opening the PR; …".

## Alternatives considered
| Option | Why not |
|---|---|
| Queue the message until the checks end | If they pass, the agent doesn't run again before the PR opens, so the message waits for nothing. If they fail, the agent runs anyway; the human wanted it now. |
| Deliver the message to the reviewer | The reviewer judges the work independently (ADR-0009); a human steering it defeats the review. The message is for the worker. |
| Also interrupt the actions phase | Seconds long and outward-facing; `open_pr` is idempotent, so it could be added later if wanted. |

## Consequences
- Good: feedback reaches the agent the moment it is given, in its own conversation; no wait for a 20-minute check run.
- Good: invariants hold. The move is a human outcome (actor and text recorded), the loop is bounded because every pass back needs a human message, and the kill is the existing session kill.
- Bad / accepted cost: the checks done so far are thrown away; the next step runs them again.
- Related: conductor sending a failed check back to the agent *on its own judgement* (the ticket's second request) is the triage role of [ADR-0043](0043-triage-role-on-gate-failures.md). It is built; turning it on is a workflow save (the draft `conductor.triage.draft.json`).

## Revisit when
People want a message that doesn't stop the checks (a note queued for the agent's next turn), or want to interrupt the actions phase too.
