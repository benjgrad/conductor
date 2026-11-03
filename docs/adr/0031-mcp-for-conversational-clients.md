# ADR-0031 · MCP for conversational clients (amends ADR-0028)

- **Status**: accepted (Ben approved the plan, 2026-11-03, on ticket "MCP usability gaps found during a voice-assistant session")
- **Date**: 2026-11-03
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Amends**: [ADR-0028](0028-simple-oauth-for-mcp.md) §Tools ("Never exposed": messages to an agent, transcripts)

## Context
Ben drove ticket c63433c0 from Claude in voice mode, over conductor's MCP. It could search, read, answer and move tickets, but:
1. it could not read what the agent produced (the plan, drafts) without Ben opening GitHub;
2. it could not tell a working agent anything: only an open question could be answered;
3. `status` flipped between `needs_input` and `running` while `state` stayed `implementing`, so "is it waiting on me?" had no clear answer;
4. it had to poll `get_ticket` to notice a change;
5. the only way to ask the agent for a summary was to answer its open question with "give me a summary", which closes the question;
6. `take_transition` sometimes failed as "not loaded" and needed reloading.

ADR-0028 kept messages to an agent and transcripts off MCP, and the `/mcp` endpoint is stateless: it has no server-initiated stream (ADR-0014 §8).

## Decision
Three tools are added (19 in all) and `get_ticket` gains fields. The tool list stays small and stable, because clients load it first and some defer loading the rest.

| Gap | What ships |
|---|---|
| 1 | **`get_ticket_artifacts`** (read-only): `what` = `plan` (the latest plan, `latestPlanEntry` in shared, the same one the board's Plan sheet uses), `results` (each step's result), `output` (the live output ring's assistant and user text) or `transcript` (ADR-0008's `fetch_transcript` from the machine). Long text is paged by `cursor` so nothing is cut by the 8 KB result cap |
| 2 | **`message_agent`**: `operator.message` to a working agent (ADR-0007), the same code as `POST /api/sessions/:id/messages` (`sendOperatorMessage`). While the agent waits on a question it refuses with `question_open` unless `as_answer: true` (then it is the answer), so a message never silently closes a question |
| 3 | **`waiting_on`** on `get_ticket`, `list_tickets` and `wait_for_updates`: `you`, `you_on_board`, `agent`, `checks`, `machine` or `nobody` (`mcp/status.ts`), plus a one-sentence `status_line`. `list_tickets`' `needs_input` means `waiting_on ∈ {you, you_on_board}`. `status` and `state` stay, but the descriptions say to read `waiting_on` |
| 4 | **`wait_for_updates`** (read-only): a long poll over the board-event log. Without `since` it returns the cursor at once; with it, it returns the account's tickets with a board event after the cursor, one row each, as they are now, waiting up to `timeout_seconds` (default 25, at most 50) for one. `needs_you_only` keeps only changes that wait on the user. `get_ticket` returns a `cursor` to start from |
| 5 | **`status_report`** on `get_ticket`: deterministic, ≤ 1 200 characters (status line, plan summary and excerpt, last moves, PR, spend, the agent's last words). It costs nothing and works when the agent is parked or finished. The agent's own report is a `message_agent` away |
| 6 | Every handler is wrapped (`guard`): a throw answers conductor's JSON `{error: {code: 'internal'}}`, like every other refusal. Every caller gets the same tools in the same order (admin-only tools refuse at call time). The server instructions name the core loop. An unknown tool name is already a tool error from the SDK, never "not loaded", so that message comes from the client (U-### below) |

Still never exposed: approvals, permission prompts, fresh conversations, enrollment, team and admin. MCP writes are still recorded as `ui` (ADR-0028).

## Alternatives considered
| Option | Why not |
|---|---|
| Real MCP push (`resources/subscribe`, `notifications/…`) | Needs a stateful Streamable-HTTP session with a GET SSE stream, which ADR-0014 deferred ("Revisit when MCP clients need push"); voice clients don't reliably surface server notifications. A long poll works on today's stateless endpoint |
| A summary written by the agent (a paid turn) | Costs money, needs a live agent, and while the agent is parked it can only be delivered as the answer to its question: the confusion this ticket reports |
| The PR diff through an orchestrator GitHub token | A new credential and external service. The follow-up gets the diff from the machine that holds the worktree (a `fetch_diff` request/response like `fetch_transcript`, in the TS and Rust daemons) |
| `message_agent` that answers an open question by itself | It would silently close the question; refusing with the question and `as_answer` keeps the choice explicit |

## Consequences
- **Good**: each gap is one obvious tool call; `waiting_on` answers "does this need me?" the same way everywhere; no new transport, table or credential.
- **Bad / accepted cost**: a `wait_for_updates` call holds a request for up to 50 s (nginx's `/mcp` read timeout is the default 60 s); the `output` ring is in memory and empty after a restart (`output_complete: false` points at `transcript`); the tool list grew from about 12 KB to about 14 KB.
- **Follow-ups**: the PR diff over MCP (`fetch_diff`, then `what: 'diff'`); the client-side "not loaded" behaviour (reproduce in claude.ai voice); real push if clients start surfacing notifications.

## Revisit when
- MCP clients reliably surface server notifications (push instead of the long poll);
- a second orchestrator instance is added (the BoardBus wake-up is in-process; the event log is not).
