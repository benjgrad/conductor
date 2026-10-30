# ADR-0027 · Messages while waiting on the PR's checks

- **Status**: proposed (amends [ADR-0007](0007-live-messages-to-agents.md) §1 for one case; Ben asked for the behaviour, 2026-10-29)
- **Date**: 2026-10-29
- **Deciders**: Ben (+ Claude session, background job "chat while PR checks run")
- **Resolves**: —

## Context
Ben, 2026-10-29: *"when the PR checks are running, we should still be able to chat with the AI session and provide feedback"*.

A move step with conditions (`pr_ready_for_review`, `ready_for_testing` in `conductor` v4) ends the worker, runs checks, review and `open_pr`, then waits on the PR's checks for up to `condition_timeout` (2 h) in the conditions phase ([ADR-0011](0011-transition-rules.md), [05 §Conditions](../design/05-workflow-engine.md)). The session is `waiting_external` and no agent process runs, so ADR-0007's live message (`send_message` into a live process) has nowhere to go: apply refuses `operator.message` (`wrong_status`, 409) and the composer was off. A human who spots a problem in the PR had to wait up to two hours, or cancel.

## Decision
While a move step **out of an agent state** is in its **conditions phase**, `operator.message {text}` ends the step and resumes the source agent with the text: `leaveStep` (nothing is killed: the worker has exited, an evaluation in flight comes back stale), then `enter(from)` with the text as the pending answer, the same Claude conversation resumed (a resume's prompt is the bare text), `state_entered.transition = message` (`MESSAGE_MOVE`), actor `human`, reason the text. No retry counter is taken. The agent finishes the move again when it is done, which runs the whole step again (checks, review, `open_pr`, which finds the existing PR, and the conditions).

Every other case is unchanged: ADR-0007's live message into a running agent, and `wrong_status` in the checks, review and actions phases (conductor is judging or acting; those are minutes, not hours) and in a conditions phase out of an event state (no agent to resume).

The composer offers "Message" in that case with the note "Conductor is waiting on the PR's checks. A message stops the wait: <agent> picks the ticket back up with it, then finishes the step again." The REST route, the `user` chunk in the output ring and the event row are ADR-0007's.

## Alternatives considered
| Option | Why not |
|---|---|
| Queue the message; deliver it when the agent next runs | If the checks pass, the agent doesn't run again before the human review: the feedback would wait for nothing. Ben wants to give feedback now. |
| Start the agent alongside the pending conditions | Two things running in one session state; the FSM has one current state, and the conditions' result would race the agent's own move. |
| Also accept it in the checks / review / actions phases | They are short and conductor is mid-judgement (a running check, a reviewer, a push). Killing them for a message is possible later if wanted. |

## Consequences
- Good: feedback reaches the agent the moment it is given; the conversation (and its history) continues in the same Claude session.
- Good: invariants hold: the transition is a human outcome (recorded with actor and text); the loop is bounded because every pass back needs a human message; nothing new to make idempotent (the `start_session` is the usual one).
- Bad / accepted cost: a message throws away the conditions' wait so far; the next step re-runs the checks and waits again.
- Follow-ups: none.

## Revisit when
People want to interrupt the checks or review phases too, or want a message that doesn't stop the wait.
