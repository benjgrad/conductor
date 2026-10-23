# ADR-0007 · Live messages to a running agent (slash commands pass through)

- **Status**: accepted (Ben, 2026-10-23)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23, branch `lm-backend-live-messages`)
- **Extends**: [ADR-0005](0005-claude-code-driver.md) (driver contract gains `DriverSession.sendMessage`; the U-028 nudge rule is unchanged) and the human-input path ([06](../design/06-human-input.md#live-messages-to-a-running-agent)).

## Context
Until now a human could only reach an agent by answering a question it asked (`ask_user` / `no_outcome` → `needs_input` → `/input` → `send_input`). Ben wants the board to let a human send a message to an agent **while it is running**, the way you type into your own Claude Code session, and wants `/...` messages to reach Claude Code as slash commands.

A spike against the real CLI (claude 2.1.309, `-p`, stream-json in and out) established:
- A stream-json user message written to stdin **mid-turn is folded into the current turn**: the agent saw it and answered both the prompt and the message in a single `result`.
- Claude **does not echo user messages** on stdout.
- A user message `/context` was **executed as Claude Code's built-in slash command**; its output came back as assistant text plus a `result`. Slash commands need no special handling: the text is sent as-is.

Constraints: transitions only on outcomes; every failure path ends at a human; state and commands in one transaction; external side effects are idempotent.

## Decision
A live message is a new engine event that produces a new outbox command and nothing else. It never changes the workflow.

1. **Engine.** `operator.message {text}` (REST). apply accepts it only when `status = running`, the current state is an `agent` state and `agent_process_live` is true; otherwise it is ignored `wrong_status`. Accepted, it emits exactly one effect `send_message {text}`: no transition, no status, deadline or snapshot change. The event row keeps `text`: it is the durable record of what the human said (the output ring is in memory).
2. **Command.** `send_message` is an outbox kind (Postgres enum value added by migration `1761300000000_outbox-send-message`) and a WS command `send_message {command_id, target_command_id, text}` to `machine:<id>`, with the row's fencing token in the envelope like every outbox command. `target_command_id` is the session's `agent_command_id` when the message was accepted, so a message delayed by retries or a reconnect can only land in the process it was meant for, never in a later visit's process. It is retried and deduped on `command_id` exactly like `send_input`, so it is written at most once.
3. **Scrub (U-039 precedent).** `SCRUBBED_PAYLOAD_SQL` nulls `payload.text` when a `send_message` row turns terminal (`acked` / `failed`), as it does `start_session.prompt`. The text is up to 20 000 chars and the event row already keeps it, so the outbox copy is transport only.
4. **REST.** `POST /api/sessions/:id/messages {text}` (`SendMessageRequestSchema`: trimmed, 1–20 000 chars) applies `operator.message`. `applied` → 202 `{ok: true}`, and **after the apply transaction commits** the orchestrator appends the text to the `OutputBus` as a `user` chunk, because Claude does not echo it. Ignored → 409 `conflict` (EngineRoute `message`); unknown session → 404; bad body → 400.
5. **Daemon.** On `send_message` it writes the text with the new `DriverSession.sendMessage` and acks `accepted`, only if the session's agent process is the one spawned by `target_command_id`, runs at or below the envelope fencing token, has not exited and has not completed, and is **not parked** for a human. Otherwise it acks `refused`: `no_live_process` (no such process, other process, newer token, completed or exited) or `agent_parked` (after `ask_user` / `no_outcome`; that process is answered through `send_input`, and writing to it would start a turn nobody asked for).
6. **Not an answer.** `sendMessage` writes the same stream-json user message as `sendInput`, but it does not clear the outcome server's pending question, and the daemon leaves `askPending` and `nudged` alone. A message folded into a turn does not end the turn's obligation to report `complete_state` or `ask_user`.
7. **Refusal.** apply ignores `command.refused` for `send_message` with the new reason `message_refused`, whatever the daemon's reason: a message is best effort and never re-routes the workflow (unlike `send_input`'s `no_live_process` re-answer). The gateway appends a `debug` output chunk, `conductor: message not delivered to the agent (<reason>)`, so the human sees it.

### Interaction with the U-028 nudge
The daemon's process is idle between turns only when it is parked (refused, `agent_parked`) or completed (refused, `no_live_process`): after an outcome-less turn the daemon nudges at once, so the agent is working again. A delivered message therefore reaches Claude during a turn and is folded into it. It runs no turn of its own and changes nothing in the nudge count. A turn that took in a message and still ends without an outcome is nudged and, if the next turn also has none, parked with `no_outcome`, exactly as before. That is the intended behaviour: the human asked something, the agent replied, and the agent still owes an outcome.

**The narrow race, and why it is not guarded.** A message can be written in the instant after Claude's last step of a turn, before or right after its `result` (or right after spawn, before the first turn starts: the E2E fake hit that variant). Claude may then run it as a turn of its own (a "user-triggered turn", e.g. `/context`). If the preceding turn had no outcome, the daemon nudges; the message's turn ends without an outcome and counts as the post-nudge turn, so the daemon parks with `no_outcome` while the nudge's turn is still queued. Worst case: a human gets a spurious "Agent stopped without reporting an outcome" question, and a `complete_state` from the queued nudge turn arrives while the session is `needs_input` and is ignored (`wrong_status`); the process ends after that complete, so the human's answer resumes the Claude session (`--resume`) and the agent reports again. Nothing transitions wrongly and the failure path ends at a human. If the preceding turn completed, the process is already ending and the extra turn is harmless.

We do not add a guard. The daemon cannot tell a folded message from one run as its own turn (Claude does not echo user messages). A guard that skips counting a turn "touched" by a message would, in the common folded case, leave an agent that answered the message and stopped idle in `running` forever with no human asked, which breaks "every failure path ends at a human". `--replay-user-messages` might let the daemon attribute turns exactly; it is unverified and out of scope.

## Alternatives considered
| Option | Why not |
|---|---|
| Reuse `send_input` with no `input_request_id` | `send_input` is an answer: it clears `askPending` / `nudged` and the outcome server's pending question, and its `no_live_process` refusal re-answers via `start_session(resume)`. A message must do none of that |
| Send it as a direct WS frame (like orphan kills), not through the outbox | Loses at-least-once delivery across reconnects, `command_id` dedupe and the audit trail; the outbox costs one enum value |
| Accept messages while `needs_input` | That session is waiting for an answer; a message would race the answer path. The UI answers through `/input` |
| Make a message a transition or an `input_request` | Breaks "transitions only on outcomes"; a message is not an outcome |
| Don't count message-triggered turns toward the nudge | See above: in the common case it strands a silent agent in `running` |
| Keep the text only in the outbox (no event-row copy) | The output ring is in memory; the event row is the only durable record of what the human told the agent |
| Echo the message from the daemon instead of the orchestrator | The message is the orchestrator's own data; appending after the commit shows it at once even if the daemon is slow or refuses (the refusal then shows as a debug line) |

## Consequences
- Good: a human can steer, question or run slash commands (`/context`, …) in a running agent from the board, with no new state, no new workflow path and no change to the engine's routing invariants.
- Good: a delayed message can never reach a later agent visit (`target_command_id`), and is written at most once (`command_id` dedupe).
- Bad / accepted cost: a schema change after M1 (one enum value, additive; its down migration rebuilds the type and drops `send_message` rows). The driver contract (ADR-0005 §Contract) gains `sendMessage`. `APPLY_IGNORE_REASONS` gains `message_refused`; `COMMAND_REFUSAL_REASONS` gains `agent_parked`.
- Bad / accepted cost: the narrow race above can produce a spurious `no_outcome` question.
- Bad / accepted cost: a slash command that changes the session (e.g. `/clear`, `/compact`, `/model`) is passed through like any other; the agent's context or model may change under the workflow. Ben asked for pass-through; nothing filters commands.
- Follow-ups: the web UI (message box, rendering `user` chunks) is a separate task (`packages/web`).

## Revisit when
- Spurious `no_outcome` questions after a live message show up in real runs, or Claude Code changes how it handles stdin messages mid-turn (re-run the spike on a CLI upgrade).
- We adopt `--replay-user-messages` (exact turn attribution would allow a precise nudge guard).
- A slash command passed through breaks a session badly enough to need an allow/deny list.
