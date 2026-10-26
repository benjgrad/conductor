# M4 · Intake & assistant

> **Outline.** The detailed task breakdown is written when M3 is near done, and Ben approves it before work starts. The task table below is a first cut.

**Goal** ([ADR-0015](../../adr/0015-triage-and-assistant-on-the-users-machine.md)):
- **Triage**: new tickets pass it before they can be claimed. The server checks the required fields, then a short clarity check runs on one of the user's machines, and what is missing becomes a question on the card and in the chat.
- **Assistant**: a chat panel runs a per-account `claude` conversation on an online machine, with the M3 tool layer as its only tools. It summarises what needs attention and answers or approves through tool calls the user confirms.
- **Summaries**: stored ticket summaries are refreshed on events.
- **Offline**: with no machine online, the panel shows the deterministic needs-attention list.

**Exit criteria**:
- A ticket created without `kind` (over MCP or the API) waits in Queued with "Is this a work ticket or personal?"; answering it on the card or in the chat moves it to `ready`. The M1b create-form requirement is relaxed to "triage asks".
- The clarity check runs on a machine with no tools and a 60 s cap; a timeout or a malformed result never holds a ticket; "Skip triage" works.
- E2E (fake claude extended to make MCP tool calls): the chat is asked "what needs me?", calls `list_tickets`, then proposes `answer_input`. The panel shows Confirm, and confirming answers the input request and the session continues.
- Summaries: after a state change, a summary is regenerated within the debounce window; `get_ticket_summary` returns it, or the deterministic one with `stale: true`.
- With every machine offline the panel shows the needs-attention list, and each item can be answered from it.
- Assistant runs use a light slot and never block a work session from being claimed (test).

**Not in M4**:
- child tickets and plan breakdown (U-010);
- Slack answering (U-007);
- auto-approval settings for chat writes;
- a server-side model;
- voice or mobile.

**Blocking unknowns**: proposed U-053 (summary freshness and cost), U-055 (`claude` as the chat backend next to work sessions), U-064 (where triage questions live and which column shows them), U-066 (storing chat text in Postgres). Also [U-014](../../tracking/UNKNOWNS.md) (subscription rate limits) and [U-016](../../tracking/UNKNOWNS.md) (tool-use compliance on cheaper models).

## Task board (first cut)

| ID | Task | Depends on | Parallel group | Status |
|---|---|---|---|---|
| M4-T01 | **Contracts**: `ticket_status.triage`; `input_request.ticket_id` (nullable `session_id`) and kind `triage`; WS `start_chat` / `chat_message` / `chat_output` / `assistant_job` / `assistant_result`; chat REST + SSE; `pending_action`; summary job shapes | M3 done, U-064 | A | todo |
| M4-T02 | Migrations: the triage status, `input_request` changes, `chat_message`, `pending_action`, assistant settings | T01 | B | todo |
| M4-T03 | Triage step 1 (deterministic) and the triage state machine on the server; `create_ticket` and `POST /api/tickets` go through it | T01 | B | todo |
| M4-T04 | Daemon assistant runner: chat conversations (stream-json, MCP config with a short-lived token, no built-in tools, ADR-0006 guards) and one-shot jobs (`-p --json-schema`) for clarity and summaries; light slots | T01 | B | todo |
| M4-T05 | Orchestrator chat service: machine choice and failover, history seeding, the assistant token mint, `pending_action` + confirm, turn caps | T02, T03 | C | todo |
| M4-T06 | Triage step 2 (clarity) and summaries: scheduling, debounce, batching, freshness, deterministic fallback | T02, T04 | C | todo |
| M4-T07 | Web: chat panel (stream, confirm cards, offline needs-attention list), triage questions on Queued cards, assistant machine setting | T01 | B | todo |
| M4-T08 | E2E: triage asks for kind; chat answers an input request through a tool; offline fallback; summaries refresh | all | D | todo |
