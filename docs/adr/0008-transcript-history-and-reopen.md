# ADR-0008 · Message history from Claude's transcript; reopen a finished ticket with the same agent

- **Status**: accepted (Ben, 2026-10-23)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23, branch `reopen-and-history`)
- **Extends**: [ADR-0005](0005-claude-code-driver.md) (resume and the transcript it needs), [ADR-0007](0007-live-messages-to-agents.md) (the composer and `user` chunks), [U-005](../tracking/UNKNOWNS.md) / [ADR-0003](0003-postgres-outbox-no-kafka.md) (no raw output in Postgres).

## Context
Two gaps showed up once the session panel (Messages tab, composer) landed:

1. **History is lost on restart.** Session output lives only in the orchestrator's in-memory `OutputBus` ring (U-005: no raw output in Postgres). After an orchestrator restart every session's Messages tab is empty.
2. **A finished ticket is final.** Once a ticket is Done (or Failed), the only way to ask for a change is a new ticket, with a new agent that knows nothing of the first one's work.

Ben decided both on 2026-10-23: history comes from **Claude Code's own transcript** ("Read Claude's transcript", nothing new in Postgres), and a finished ticket is reopened by **resuming the same agent** ("Resume same agent").

Facts we rely on:
- Claude Code writes every conversation to `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<claude_session_id>.jsonl` (default config dir `~/.claude`) on the machine that ran it. `<cwd-slug>` is the realpath of the cwd with every non-alphanumeric character replaced by `-` (verified: `/private/tmp/conductor-demo-bf2d6fd1/root/wt/1351542f-…` → `-private-tmp-conductor-demo-bf2d6fd1-root-wt-1351542f-…`).
- Lines are JSON with `type` ∈ {`user`, `assistant`, `attachment`, `system`, `queue-operation`, `api-request*`, `last-prompt`, …}. `assistant` lines carry `message.content` blocks (`text`, `tool_use`, `thinking`); `user` lines carry a string prompt, `text` blocks, or `tool_result` blocks. Lines have `timestamp`, `isSidechain`, sometimes `isMeta` (checked against real transcripts from a demo run).
- `--resume <id>` keeps the conversation and works from any cwd on the same machine (ADR-0005), and `result.total_cost_usd` stays cumulative across it.
- The daemon's store (`<root>/state/daemon.json`) knows each session's worktree path and Claude session id.

## Decision

### 1. History from Claude's transcript (read-only WS request/response)
- **Protocol.** The orchestrator sends `fetch_transcript {request_id, session_id}` (machine-level envelope) to the machine in `session.machine_id`; the daemon answers `transcript {request_id, chunks, truncated}` or `{request_id, error}` with `error` ∈ `unknown_session`, `no_transcript`, `read_failed`. It is a **direct frame, not an outbox command**: it is read-only, so there is nothing to make durable, retry or dedupe. The gateway accepts a reply only from the machine it asked, times out after `TRANSCRIPT_TIMEOUT_MS` = 10 s, and answers `offline` at once when the machine has no socket or its socket closes while waiting.
- **No traversal.** The daemon locates the file only from its own store: the session's worktree path and Claude session id (which must be a uuid). First `<config>/projects/<slug(realpath(worktree))>/<id>.jsonl`; the realpath of a removed worktree is `realpath(parent) + name`, so the transcript stays findable after the worktree is gone. Then any project dir holding `<id>.jsonl` (newest), for a conversation resumed from another cwd. Nothing in the request is a path.
- **Mapping** (`daemon/src/claude/transcript.ts`), the same streams as the live parser: assistant `text` → `assistant`; `tool_use` → `tool_use` with text `Name {json input}` (exactly as `stream-parser.ts`); user `tool_result` → `tool_result`; a user string prompt or `text` blocks → `user`. Thinking blocks, sidechain and meta lines, and every other line type are skipped.
- **Caps.** Each tool result ≤ 16 KB (`TRANSCRIPT_RESULT_CHARS`, with a `[truncated: n more characters]` marker), any other chunk ≤ 64 KB; the reply keeps the most recent chunks whose JSON fits 2 MB (`TRANSCRIPT_MAX_BYTES`, under the gateway's 4 MB frame limit); the daemon reads at most the last 32 MB of the file. `truncated` says older chunks were dropped.
- **REST.** `GET /api/sessions/:id/transcript` → `{machine_id, chunks: OutputChunk[], truncated}`. 404 `not_found` (unknown session), 404 `no_transcript`, 502 `internal` (`read_failed`), 503 `machine_offline` (no machine, or not connected), 504 `timeout`.
- **Synthetic `seq` / `ts`.** A chunk's `seq` is its position in the response (0..n-1); `ts` is the transcript line's own timestamp (else the previous line's). Transcript chunks are **never merged with ring chunks by seq**: the web keeps the history as its own list in front of the ring snapshot and the live chunks, and `OutputLog` keys entries by position (the list only grows at the end), so equal seqs from the two sources can't collide.
- **Web.** When the Messages tab opens on a session with a machine whose ring snapshot and live stream are empty, it fetches the transcript once and renders it through the same `OutputLog`, with a quiet notice: "History loaded from Claude's transcript on <machine>" / "History unavailable: <machine> is offline" / "No transcript found". A session still running after a restart shows the transcript, then live chunks appended after it. **Accepted overlap:** a chunk streamed live between the daemon's read and the first live chunk may show twice; and the transcript has the agent's side only (no build/test command output, which never went through Claude).

### 2. Reopen a finished ticket by resuming the same agent
- **REST.** `POST /api/sessions/:id/reopen {text}` (trimmed, 1–20 000 chars) → 202 `{session_id}` (the new session). Allowed only for the ticket's **latest** session, and only when it is `done` or `failed`; 409 `conflict` otherwise, 404 unknown, 400 bad body.
- **`lost` is excluded.** A `lost` session is one whose machine stopped heartbeating; its conversation and worktree live on that machine, and recovering it is the reaper's requeue, not a human's reopen (M1 never produces `lost` anyway).
- **One transaction, no migration** (`orchestrator/src/engine/reopen.ts`): lock the ticket, then the old session; check; INSERT a new session `queued` with `workflow_state = null` carrying `branch`, `context`, `claude_session_id`, `claude_spend_totals` and the workflow version, and with `pending_answer = {input_request_id: null, answer: text}`; ticket → `ready`; an `operator.reopen` audit row (`{text, reopened_from, actor}`, the durable record of the text); `card.moved` + `card.upserted`. Everything else is fresh: retry counters, state visits, spend, wall time, deadline. The old session stays terminal, so the one-live-session-per-ticket index allows the new one. `PendingAnswer.input_request_id` becomes nullable (jsonb, no DDL).
- **First command through the claim path.** The claim reuses the queued session and applies `session.assigned`; apply's `onAssigned` now passes `pending_answer` when it enters `def.start`, so the start is `start_session {resume_claude_session_id: <old id>, prompt: text}` (the bare text, as for any resumed answer), or, if the old session never got a Claude id, the rendered start prompt with the text in it. Then implement → build → test → done as usual. The §Pending answer rules hold unchanged: an ack-timeout requeue re-answers with the same text, the matching `started` clears it, a resumed process that exits without reporting fails to a human.
- **Hard machine pin in the claim.** The reopened session needs the old worktree and the transcript, both on the old machine. A ticket whose `queued` session shares its `branch` with an earlier session of the ticket that ran on machine M is claimable only by M (`gateway/claim.ts`; the M1 claim has no soft scores at all). It survives requeues, because it reads the earlier session, not the queued one's `machine_id`.
- **Same branch, same worktree.** The branch is still checked out in the old session's worktree (`<root>/wt/<old session>`), so `git worktree add` would fail. The daemon **reuses that worktree**: when `git worktree list` shows the branch checked out in a directory directly under `<root>/wt`, `ensureWorktree` returns it, and the start is refused (`start_failed: … in use`) while a process of another session still runs in it. Reusing (rather than removing the old worktree and adding a new one) keeps uncommitted files, needs no git mutation, and keeps the cwd identical, so the resumed conversation and its transcript stay in the same project dir: both sessions' `fetch_transcript` find the same file.
- **Same agent.** The agent's name and avatar are derived from the ticket id, so they are the same automatically.
- **Web.** On a done/failed session the composer is in reopen mode: placeholder "Ask {agent} to change something…", a "Reopen" button; on 202 the panel switches to the new session (`App` keys the panel by the selected session id). `/help` explains it. The text is appended to the new session's ring as a `user` chunk, like a live message.

## Alternatives considered
| Option | Why not |
|---|---|
| Persist output chunks in Postgres | U-005 / ADR-0003: no raw output in Postgres. Ben chose the transcript |
| Ship the transcript through the outbox | It is a read, not a side effect: no idempotency or durability needed, and a 2 MB reply has no business in an outbox row |
| Let the request carry the transcript path | Path traversal: any file the daemon can read. The store already knows the session's cwd and Claude id |
| Merge transcript and ring chunks by seq / time | The two sequences are unrelated; times are close but not exact. Keeping history as its own prefix is simple and the overlap is tiny and documented |
| Reopen = reset the old session to the start state | Breaks "terminal is terminal" (apply ignores every event on a terminal session) and rewrites history; a new session keeps the old one's record intact |
| Reopen = a fresh agent with a summary of the old work | Ben chose resuming the same conversation: the agent keeps everything it knew |
| Remove the old worktree (keep the branch) and add a new one | Loses uncommitted files, mutates git, and moves the cwd, so the resumed transcript would land in another project dir |
| Soft affinity (the 04 +50 score) instead of a hard pin | On a second machine the resume fails (no transcript) and the branch isn't there; the start would be refused and requeued, possibly onto the wrong machine again |
| A new column (`reopened_from`, `pinned_machine`) | Not needed: the shared branch identifies the pin, and the audit row records the origin. Avoids a migration |
| Allow reopening `lost` | Its machine is gone; the requeue path owns it |

## Consequences
- Good: after a restart the Messages tab shows the real conversation, read from Claude's own record, with nothing new stored centrally.
- Good: a human can send a Done/Failed ticket back to the same agent with one message; it continues the same conversation on the same branch, with the workflow's full build/test loop, budgets reset, and every failure path still ending at a human.
- Good: no migration. Contract changes: two WS message types, two REST routes, two `ApiError` codes plus `timeout`, `PendingAnswer.input_request_id` nullable, `TranscriptSource` on the gateway handle, `onAssigned` delivering a pending answer on the first entry.
- Bad / accepted: history needs the session's machine online and its transcript intact; Claude Code's transcript format is unversioned (mapped leniently, like the stream parser; unknown lines are skipped). It lacks command output.
- Bad / accepted: two sessions of a reopened ticket share a worktree and a transcript, so each one's history shows the whole conversation (both passes).
- Bad / accepted: a reopened ticket whose machine never returns waits in Queued until a human cancels it (cross-machine reopen would need the branch pushed and the transcript shipped; ADR-0005 revisit trigger). Recorded as TD.
- Bad / accepted: the daemon reads the transcript synchronously (≤ 32 MB) on its event loop.

## Revisit when
- Claude Code changes its transcript location, slug rule or line format (re-check on a CLI upgrade, like the stream-json spike).
- Multi-machine fleets (M2): cross-machine reopen and history (push the branch; ship or proxy the transcript).
- Durable output becomes a requirement (U-005 reopened).

## Amendment (M2-T34, 2026-10-29): a reopen takes the newest workflow version
The reopened session used to copy the old session's `workflow_version`. It now takes the newest version of the same workflow id when that version has `def.start` (where a reopen always enters), and the ticket's `workflow_version` follows (`reopenVersion`, `orchestrator/src/engine/repin.ts`; [05 §Versioning](../design/05-workflow-engine.md#versioning)). The cause: ticket UX-11 was reopened on conductor v2 and closed itself a second time through v2's personal `done`, which v4 removes. Branch, context and Claude session still carry over unchanged; `operator.reopen` records `workflow_version: {from, to}` when it changed. The rest of this ADR stands.
