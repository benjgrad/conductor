# M2b · Ticket dependencies (ADR-0018)

> **Approved by Ben 2026-10-27** (PR #6), with two amendments now written in: a cancelled or failed dependency first gets an orchestrator **unblock assessment** (ADR-0018 §2a, tasks T14–T15), and concurrency is **hardware-based** (ADR-0018 §6, task T13), with no cycle-size cap.

**Goal** ([ADR-0018](../../adr/0018-ticket-dependencies.md)): tickets can depend on other tickets, and the orchestrator handles both cases.
- **The claim waits.** It never starts a ticket while a dependency is unfinished (`done` is the only finished status). A queued card shows "blocked by #…".
- **A cancelled or failed dependency gets an unblock assessment.** It runs as a one-shot `claude -p` on a machine of the account and decides `proceed` / `retry_dependency` (once) / `replace` / `escalate`. Anything but `proceed` or a first retry, and every error, ends at a human decision.
- **Concurrency is hardware-based.** The daemon asks for work only while its measured free RAM and CPU are above thresholds (with hysteresis); `max_sessions` becomes an optional ceiling.
- **Cycles are worked out, not deadlocked.** Tickets that depend on each other (any number) are claimable together and are claimed as headroom allows, on one machine or several. Their agents see each other in the prompt and talk through `message_peer`, which the orchestrator relays on ADR-0007's `send_message` path and records on both timelines. They can agree on a shared interface. The relay has a budget, and when it runs out a human gets the thread.

**Why a separate milestone after M2 (and after M2c), before M3**:
- It needs M2's account scoping (M2-T19, T21) and M2's claim (M2-T16). Inside M2 it would collide with T16 and T19 in `gateway/claim.ts` and `engine/service.ts`, and lengthen a ten-group chain.
- The live board is pinned to the M1b build until M2-T25 (U-075), so it couldn't be dogfooded before then anyway.
- Right after M2, it lets Ben queue all of M3, M4 and M5 at once, each ticket with its dependencies.

**Exit criteria**:
- Every task below is `done` and passed QA.
- `pnpm test:e2e` green with the M2b scenarios (M2b-T11):
  1. B depends on A: B stays in Queued with "blocked by", and is claimed only after A is Done;
  2. D is cancelled → an assessment (fake `claude -p`) answers `proceed` → the edge is cleared with the reason on both timelines, and C is claimed;
  3. F fails → the assessment answers `escalate` → E shows "needs your decision" in Queued → "drop this dependency" → E runs; an assessment timeout escalates the same way;
  4. a cycle of two runs on two fake machines, the agents exchange a proposal and an agreement, and both finish;
  5. budget exhaustion sends the sender to Needs input with the thread;
  6. a cycle of three on one fake machine whose (fake) headroom admits two at a time: two run, the third's messages queue, and the third is claimed when one finishes; all three finish.
- The M2 isolation proofs cover the new routes and tables: the route matrix, the schema-isolation test and the unscoped-SQL lint all pass.
- Deployed to conductor.gradyserver.com. Ben queues one real pair of dependent tickets on the hosted board, and the dependent starts only after the first is Done.
- ADR-0018 accepted, with implementation notes.

**Not in M2b**:
- dependencies across accounts (U-051);
- a hard "agreement required" gate on finishing (ADR-0018 §Alternatives);
- "finished = merged" (U-078; the default is `done`);
- the M3 MCP tool (`set_dependencies` is M3-T04's, once the tool layer exists);
- triage suggesting dependencies (M4);
- automatic dependency inference.

**Blocking unknowns**: none. Not blocking, with the defaults this plan assumes:
- **U-077**: the message budget numbers. 20 relayed messages per cycle, +10 per human grant, 5 proposal versions, `wait_seconds` ≤ 600. These are constants in M2b-T01, tuned after real use. There is no cycle-size cap (Ben).
- **U-078**: "finished" = ticket `done` (not "PR merged").
- **U-081**: the assessment's model and cost: the account's default model, one turn, a 5-minute timeout.
- **U-082**: the admission thresholds: 3 GB or 15 % of RAM free, 1 idle core, hysteresis of +1 GB / +0.5 core, and a 90 s start reservation of 2 GB / 1 core.

## How M2b is run
The same as M2 ([M2 §How M2 is run](M2-accounts-machines.md#how-m2-is-run-dogfooding)): each block is a conductor ticket on the hosted board, on branch `m2b-tNN-<slug>`, ending in a PR with the report. The same rules apply: do not edit `docs/tracking/*`; code against the T01 contracts; shortcuts get a `// TD:` comment and a line in the PR report; a migration waits for Ben; standard gates apply. Once M2b-T08 and T09 are deployed, later M2b tickets may use dependencies themselves.

## Task board

| ID | Task | Depends on | Group | Migration | Status |
|---|---|---|---|---|---|
| M2b-T01 | **Contracts**: dependency DTOs and routes, card `blocked_by` (with assessment) / `cycle`, peer events, `send_message.from_peer`, `session_event peer_message`, `cycle_coordination` / `dependency_blocked`, ticket-level input requests, `run_assessment` / `assessment_result`, the assessment outcome schema, admission fields, constants; 10-contracts §Ticket dependencies | M2c-T01 | A | — | todo |
| M2b-T02 | Shared: `dependencyCycles` (Tarjan SCC), `blockingDependencies`; property tests | M2c-T01 | A | — | todo |
| M2b-T03 | Migration: `ticket_dependency`, `dependency_cycle`, `cycle_message`, `unblock_assessment`, `ticket.cycle_id` / `unblock_retry_used`, `ticket (account_id, id)` unique, `event.ticket_id`, ticket-level `input_request`, enum values, `run_assessment` outbox kind, nullable `machine.max_sessions`; row types; schema tests | T01 | B | **yes** | todo |
| M2b-T04 | Shared engine: apply handles the peer events, inbox flush on start, budget exhausted → needs_input | T01, M2c-T04 | B | — | todo |
| M2b-T05 | Shared engine: prompt render (`## Cycle partners`, inbox messages, `## Agreed interface`, `message_peer` how-to) and `renderUnblockAssessment` | T01, M2c-T05 | B | — | todo |
| M2b-T06 | Daemon: `message_peer` tool, `wait_seconds`, `from_peer` delivery, `session_event peer_message` | T01 | B | — | todo |
| M2b-T07 | Web: "Blocked by" picker, Queued badge (with the assessment state), the "needs your decision" request, cycle badge and thread, "drop this dependency", "Agree on v<n>", admission state on the Machines page | T01 | B | — | todo |
| M2b-T08 | Orchestrator: dependency service + REST (add, drop, `depends_on` on create), advisory lock, cycle recompute, 409s | T02, T03, M2 done, M2c-T07 | C | — | todo |
| M2b-T09 | Orchestrator: the claim filter, the soft cycle-partner preference, an optional `max_sessions` ceiling, and the board view (`blocked_by`, `cycle`) | T02, T03, M2 done, M2c-T08 | C | — | todo |
| M2b-T10 | Orchestrator: the relay (wrapper + gateway), `cycle_message`, agreement, budget, human guidance, partner finished / cancelled notices | T04, T05, T08 | D | — | todo |
| M2b-T11 | E2E: the six scenarios | T07, T09, T10, T13, T15 | F | — | todo |
| M2b-T12 | Docs sweep (02, 03, 04, 05, 06, 07, 10; ADR-0018 notes) and deploy (lead) | T11 | G | — | todo |
| M2b-T13 | Daemon: hardware-based admission (thresholds, hysteresis, start reservation, optional ceiling), reported in the inventory; pays TD-027 | T01, T06 | C | — | todo |
| M2b-T14 | Daemon: `run_assessment` (one-shot `claude -p` with a JSON schema, no tools, timeout, admitted like a session) | T01, T13 | D | — | todo |
| M2b-T15 | Orchestrator: unblock assessments (created on close, dispatched, result applied, one retry, escalation as a `dependency_blocked` request), both timelines | T03, T05, T08, T10 | E | — | todo |

Groups run A → G. Tasks within a group own disjoint files. The longest chain is T01 → T03 → T08 → T10 → T15 → T11 → T12. The daemon lane is T06 → T13 → T14; the web lane (T07) finishes in group B.
- **Collision check with M2**: M2b starts after M2 is done, so `gateway/claim.ts` (M2-T16), `engine/service.ts` (M2-T19, T20) and the daemon's `daemon.ts` (M2-T04, T10, T13) are settled first.
- Inside M2b, `claim.ts` belongs only to T09, `service.ts` only to T10, the gateway's `assessment_result` case to T15 (a group after T10's `peer_message` case), and `daemon.ts` to T06 (B), then T13 (C), then T14 (D).

**Placement in the roadmap.** The order is M2 → [M2c](M2c-requirements-verification.md) (requirements and verification, overlapping M2's tail) → **M2b** → M3.
- M2b starts when M2 is done (after M2-T25's deploy) **and** M2c's engine and orchestrator tasks (M2c-T04, T05, T07, T08) have merged. The two milestones edit the same files in sequence: `apply.ts`, `render.ts`, `board-view.ts`, the ticket-create handler, `rest.ts`.
- Exception: **M2b-T01 and T02 may start once M2c-T01 has merged**. They touch only `packages/shared` and 10-contracts.
- Why M2c goes first and the two stay separate milestones: see M2c's placement note. In short, verification is used by every dogfood ticket at once, while dependencies pay off when whole milestones are queued.

**Migrations**: T03 only (Ben approves before merge; applied to the server at T12's deploy).

**Shared files with section ownership**:
- `packages/shared/src/engine/apply.ts`: T04 only. `render.ts`: T05 only.
- `packages/orchestrator/src/engine/service.ts`: T10 only. `gateway/claim.ts` and `engine/board-view.ts`: T09 only. `gateway/index.ts`: T10 (`peer_message`), then T15 (`assessment_result`). `src/tickets/dependencies.ts`: T08, then T15 (the assessment hook in `onTicketClosed`).
- `packages/daemon/src/daemon.ts`: T06 (`send_message` with `from_peer`), then T13 (`maybeRequestWork`, admission), then T14 (the `run_assessment` case).
- `packages/orchestrator/src/api/index.ts`: T08 (the dependency route registration) and T10 (the cycle route registration), in different groups. `src/api/tickets.ts` (since M2c-T07): T08 adds `depends_on` to create.
- `docs/design/10-contracts.md`: T01 writes §Ticket dependencies; T12 corrects it against the code.

---

## Task details

### M2b-T01 · Contracts
- **Scope.** Additive only; existing code compiles unchanged.
  - **`packages/shared/src/api/dependencies.ts`** (new):
    - `AddDependencyRequest {depends_on_ticket_id: uuid}`;
    - `DependencyDto {id, ticket_id, depends_on_ticket_id, depends_on: {short_id, title, status}, created_at, created_by}`;
    - `DependencyChangeResponse {dependencies: DependencyDto[], cycle: {id, members: {ticket_id, short_id, title}[]} | null}`;
    - `CycleAgreementRequest {version: int}`;
    - `CycleThreadDto {cycle_id, members, messages: {from_short_id, to_short_id | null, kind, text, proposal_version, at}[], agreement: {version, text, agreed_at} | null, budget: {used, total}}`;
    - `shortTicketId(id)` (the first 8 hex digits).
  - **`rest.ts`**:
    - `CreateTicketRequest.depends_on?: uuid[]` (≤ 20);
    - `API_PATHS.ticketDependencies(id)`, `ticketDependency(id, depId)`, `cycleThread(id)`, `cycleAgreement(id)`;
    - the error code `dependency_invalid` (a self-edge; an unknown or other-account ticket stays 404 `not_found`). There is no size cap and no `cycle_too_large`;
    - `blocked_by[].assessment?: {status, outcome?, reason?}`; ticket-level input requests (`InputRequestDto.session_id` nullable, `ticket_id`), kind `dependency_blocked`, and the decision actions `POST /api/tickets/:id/dependency-decision {edge_id, action: 'drop' | 'reopen_dependency' | 'create_replacement' | 'cancel', replacement?}`;
    - `BoardCard.blocked_by?: {ticket_id, short_id, title, status}[]`;
    - `BoardCard.cycle?: {id, partners: {ticket_id, short_id, title}[], state: 'negotiating' | 'agreed' | 'waiting_on_human', agreed_version?}`.
  - **`packages/shared/src/engine/types.ts`**:
    - events `agent.peer_message {to: 'all' | ticket_id, kind: 'message' | 'proposal' | 'agree', text, proposal_version?, seq}` (from the sender's daemon), `peer.message_received {from_ticket_id, from_short_id, kind, text, proposal_version?, cycle_message_id, deliver: 'now' | 'inbox'}` (applied by the wrapper to a recipient), `cycle.budget_exhausted {cycle_id, thread: string}`;
    - `input_request_kind` value `cycle_coordination`;
    - the context key `__cycle` (`CycleContext {cycle_id, partners, agreement?, inbox: {cycle_message_id, from_short_id, kind, text}[]}`; no migration).
  - **Protocol** (`protocol/ws.ts`): `send_message.from_peer? {ticket_id, short_id, kind}` (additive; ADR-0007 delivery unchanged); `session_event` kind `peer_message {to, kind, text, proposal_version?, wait_seconds?}` (durable, seq); the `message_peer` tool's input schema and its result enum `relayed | queued | partner_finished | budget_exhausted | reply | no_reply`.
  - **Assessment** (ADR-0018 §2a): the WS command `run_assessment {assessment_id, prompt, schema, timeout_ms}` (machine-level, outbox kind `run_assessment`) and the daemon reply `assessment_result {assessment_id, result | error}`; `UnblockOutcomeSchema` (`proceed {reason}` | `retry_dependency {reason}` | `replace {reason, title, body}` | `escalate {reason}`); `ASSESSMENT_TIMEOUT_MS` 300 000, `ASSESSMENT_MACHINE_WAIT_MS` 1 800 000.
  - **Admission** (ADR-0018 §6): `register.max_sessions` becomes nullable (no ceiling); the inventory gains `admission {admitting: boolean, reason: 'ok' | 'memory' | 'cpu' | 'ceiling', thresholds: {mem_mb, cpu}}`; the defaults `ADMIT_MEM_MB_MIN` 3072, `ADMIT_MEM_FRACTION` 0.15, `ADMIT_CPU` 1.0, `ADMIT_HYSTERESIS_MEM_MB` 1024, `ADMIT_HYSTERESIS_CPU` 0.5, `ADMIT_SETTLE_MS` 90 000, `RESERVE_MEM_MB` 2048, `RESERVE_CPU` 1.0 (U-082); `CYCLE_PARTNER_START_TIMEOUT_MS` 3 600 000.
  - **Constants** (U-077): `CYCLE_MESSAGE_BUDGET = 20` (`CONDUCTOR_CYCLE_MESSAGE_BUDGET`), `CYCLE_HUMAN_GRANT = 10`, `MAX_PROPOSAL_VERSIONS = 5`, `PEER_WAIT_MAX_SECONDS = 600`, `PEER_TEXT_MAX = 8000`.
  - Fixtures for every new DTO, event and message. **10-contracts §Ticket dependencies** (new): routes, status codes (201 / 200; 400 `dependency_invalid`; 404), the claim filter SQL from ADR-0018 §2, the relay table (who applies what, which effect, in which transaction), and the `command_id` derivation `sha256(sender_session, seq, recipient_session)`.
- **Design refs**: ADR-0018 (all); [ADR-0007](../../adr/0007-live-messages-to-agents.md); [10](../../design/10-contracts.md) §EngineService wrapper, §Machines protocol v2 conventions.
- **Depends on**: M2c-T01 merged (shared contract files in sequence).
- **Files owned**: `packages/shared/src/api/dependencies.ts` (new), the additions in `api/rest.ts`, `engine/types.ts`, `engine/fixtures.ts`, `protocol/ws.ts`, `protocol/fixtures.ts`, one export line in `shared/src/index.ts`, 10-contracts §Ticket dependencies.
- **Do not touch**: `engine/apply.ts`, `engine/render.ts`, `workflow/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `api/dependencies.test.ts`: every fixture parses; `shortTicketId` gives 8 hex characters; `depends_on` over 20 is refused.
  - [ ] `engine/peer-events.types.test.ts`: each new event fixture parses; `send_message` without `from_peer` still parses (ADR-0007 unchanged).
  - [ ] `protocol/ws.peer.test.ts`: `session_event peer_message` fixture parses; `wait_seconds` 601 is refused.
  - [ ] An interface-review agent confirms T03–T10 can be built from these contracts alone.
  - [ ] Ben approves the 10-contracts diff.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2b-T02 · Shared: dependency graph
- **Scope.** `packages/shared/src/tickets/graph.ts` (new, pure):
  - `dependencyCycles(edges: {from, to}[], openTickets: Set<string>): string[][]`: Tarjan's strongly connected components over the edges whose two ends are both open (not `done`). It returns only the components with ≥ 2 members, each sorted, the list sorted by the first member. Iterative, not recursive, so a long chain can't overflow the stack.
  - `blockingDependencies(ticket, edges, statusOf, cycleOf)`: the unmet dependencies of a ticket, leaving out the edges inside its own cycle. This is the same rule as the claim SQL, used by the board view and in tests.
- **Design refs**: ADR-0018 §2, §3.
- **Depends on**: M2c-T01 merged (timing only; the input types are plain, so it doesn't need T01).
- **Files owned**: `packages/shared/src/tickets/**` (new), one export line in `shared/src/index.ts`.
- **Do not touch**: everything else.
- **Migration**: no.
- **Acceptance**:
  - [ ] `tickets/graph.test.ts`: a 2-cycle, a 3-cycle, two disjoint cycles, a cycle plus a tail, a self-loop ignored, a `done` ticket breaking a cycle, a 10 000-node chain (no stack overflow).
  - [ ] `tickets/graph.property.test.ts` (fast-check, 1 000 runs): every returned component is strongly connected and maximal (checked against a brute-force reachability closure); `blockingDependencies` never lists an edge inside the ticket's own cycle, and lists every other unmet one.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2b-T03 · Migration and row types
- **Scope.** `packages/orchestrator/migrations/<ts>_ticket-dependencies.sql` (up and down):
  - `ticket_dependency`, `dependency_cycle` and `cycle_message`, as in ADR-0018 §1;
  - `ticket.cycle_id uuid NULL REFERENCES dependency_cycle(id)`;
  - a unique index on `ticket (account_id, id)` for the composite foreign keys;
  - `CHECK (ticket_id <> depends_on_ticket_id)`;
  - a partial unique index on live edges, and the claim's index `ticket_dependency (ticket_id) WHERE cleared_at IS NULL`;
  - `input_request_kind` gains `cycle_coordination` and `dependency_blocked`;
  - `unblock_assessment` (ADR-0018 §1, unique `(edge_id, trigger_event_id)`); `ticket.unblock_retry_used bool NOT NULL DEFAULT false`;
  - `event.ticket_id uuid NULL` (+ index `(ticket_id, id)`), so a session-less ticket has a timeline; `input_request.ticket_id uuid` (backfilled from the session) and `session_id` made nullable, with `CHECK (session_id IS NOT NULL OR kind = 'dependency_blocked')` for now (M4 widens it for triage, U-064);
  - `outbox_kind` gains `run_assessment`; `machine.max_sessions` becomes nullable.

  Every table has `account_id uuid NOT NULL REFERENCES account`, with no default. Add the row types in `db/types.ts`, extend `test/schema.test.ts`, and update the 02 sections.
- **Design refs**: ADR-0018 §1; ADR-0012 §Proving isolation; [02](../../design/02-data-model.md).
- **Depends on**: T01.
- **Files owned**: the migration, `db/types.ts` (the new rows), `test/schema*.test.ts`, 02 (§ticket_dependency, §dependency_cycle, §cycle_message, §ticket `cycle_id`).
- **Do not touch**: `src/api/**`, `src/engine/**`, `src/gateway/**`, `shared/**`, `docs/tracking/*`.
- **Migration**: **yes**. Ben approves before merge.
- **Acceptance**:
  - [ ] Migration up, down, up on a database with M2 rows.
  - [ ] `schema-isolation.test.ts` passes with the new tables.
  - [ ] `test/schema.dependencies.test.ts`: an edge between tickets of two accounts fails the foreign key; a self-edge fails the check; a second live copy of an edge fails, and a cleared one doesn't block re-adding.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T04 · Shared engine: peer messages in apply
- **Scope.** In `packages/shared/src/engine/apply.ts` and a new `engine/peer.ts`:
  - `agent.peer_message` on the sender: no state, status or deadline change. It is accepted only from a session whose context has `__cycle` and a live agent process. Otherwise it is ignored `wrong_status` (the wrapper then answers the daemon `queued` or `budget_exhausted`; T10).
  - `peer.message_received` on a recipient: `deliver: 'now'` while the session is `running` with a live, non-parked agent process → one `send_message {text: "[from #<short>] <text>", from_peer}` (target = `agent_command_id`, as ADR-0007). Otherwise the message is appended to `context.__cycle.inbox` (capped at 50, oldest dropped, with a note).
  - Inbox flush: a `start_session` effect for an agent state of a session with a non-empty inbox carries the inbox into the prompt (T05 renders it) and empties it in the same apply.
  - `cycle.budget_exhausted` on the sender → needs_input, kind `cycle_coordination`, the question = the thread, `return_to` = the current agent state; the process stays live and parked, as with `ask_user` (the answer resumes it via `send_input`).
  - A `send_message` refused with `message_refused` while it carried `from_peer` puts the message back in the inbox, so nothing is lost.
- **Design refs**: ADR-0018 §3–§4; ADR-0007; [05](../../design/05-workflow-engine.md).
- **Depends on**: T01.
- **Files owned**: `shared/src/engine/{apply.ts, peer.ts}` and their tests.
- **Do not touch**: `render.ts` (T05), `types.ts` (T01), other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `engine/apply.peer.test.ts`:
    - a live recipient gets one `send_message` with `from_peer`;
    - a parked or queued recipient gets the message in its inbox and no effect;
    - the next `start_session` carries the inbox and leaves it empty;
    - `cycle.budget_exhausted` → needs_input `cycle_coordination` with the thread;
    - a refused peer `send_message` goes back to the inbox;
    - a peer event changes no `workflow_state`, status or `retry_counters` (transitions only on outcomes).
  - [ ] `apply.property.test.ts` includes the three events and stays green at 1 000 runs.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2b-T05 · Shared engine: prompt render for cycles
- **Scope.** `packages/shared/src/engine/render.ts`: when the context has `__cycle`, every agent prompt gets:
  - `## Cycle partners`: each partner's short id, title, the first 1 000 characters of its body, repo and current column;
  - `## Agreed interface` (the agreement's version and text), when there is one;
  - "Messages from your cycle partners" (the inbox being flushed);
  - a short `message_peer` how-to: agree on what you share before relying on it, propose with `kind: 'proposal'`, confirm with `agree`, use `wait_seconds` to wait for a reply, and the budget left.

  The text is bounded: the whole section is ≤ 12 KB, older inbox messages are summarised as "… N earlier messages", and partner bodies are truncated.
- **Design refs**: ADR-0018 §3.1; 05 §Prompt render.
- **Depends on**: T01.
  - `shared/src/engine/assessment-prompt.ts` (new): `renderUnblockAssessment(input)` per ADR-0018 §2a (metadata only, no output; body caps of 4 000 characters; `retry_dependency` left out of the allowed outcomes when the retry is used).
- **Files owned**: `shared/src/engine/render.ts` (+ `render.cycle.test.ts`), `shared/src/engine/assessment-prompt.ts` (+ test).
- **Do not touch**: `apply.ts`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `engine/assessment-prompt.test.ts`: the prompt names both tickets, the reason, the PR URL when there is one, and the dependent's FR lines; with the retry used, the schema has no `retry_dependency`; a 20 000-character body is capped.
  - [ ] `engine/render.cycle.test.ts`: the partner section lists every partner; the agreement section appears only when agreed; the inbox renders in order; a 100-message inbox stays under 12 KB; a session with no `__cycle` renders byte-identically to before (snapshot).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2b-T06 · Daemon: the `message_peer` tool
- **Scope.**
  - On the daemon's outcome MCP server (ADR-0005), next to `complete_state` / `ask_user`: `message_peer` with T01's input schema.
    - It sends a durable `session_event peer_message`.
    - With `wait_seconds: 0` it returns the orchestrator's answer for that event (`relayed` / `queued` / `partner_finished` / `budget_exhausted`).
    - With `wait_seconds > 0` it holds the tool call until a `send_message` with `from_peer.ticket_id` = the addressee arrives, and returns `reply` with its text. That message is then **not** written to Claude's stdin as well. If the wait ends first, it returns `no_reply`.
    - At most one waiting call per session. A second one returns an error.
  - `send_message` with `from_peer` and no waiting call → written as a user message (ADR-0007 path, `[from #<short>]` prefix already in the text).
  - The orchestrator's answer to `peer_message` travels on the existing `session_event` ack path; T01 fixes the shape.
- **Design refs**: ADR-0018 §3.2; ADR-0005 (outcome server); ADR-0007 (daemon side).
- **Depends on**: T01.
- **Files owned**: `packages/daemon/src/claude/outcome-server.ts` (the tool), `packages/daemon/src/peer.ts` (new: the wait registry), the `send_message` case in `daemon.ts`, their tests.
- **Do not touch**: `workspace.ts`, `inventory/**`, `actions/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `peer.test.ts`:
    - a `message_peer` emits one durable `session_event peer_message`, replayed once after a reconnect (seq dedupe);
    - `wait_seconds: 5` resolves with a `from_peer` message from that partner, which is not written to stdin;
    - a message from another partner is written to stdin;
    - the wait times out with `no_reply`;
    - a second concurrent wait errors.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T07 · Web: dependencies on the board
- **Scope.** Against T01's contracts and the mock client.
  - The create form and the detail panel get "Blocked by…": a ticket picker (search by title or short id within the account) and chips with "drop". When the server's response reports a cycle, a notice says "These tickets depend on each other. They will start together and agree on what they share."
  - Queued cards with `blocked_by` show "blocked by #a1b2c3d4 Title". A cancelled or failed dependency is red, with "drop this dependency".
  - Cards with `cycle` show a badge (negotiating / agreed vN / waiting on a human) that opens the thread (`GET cycleThread`). The thread view has "Agree on v<n> for everyone".
  - A blocked-by chip shows the assessment's state (assessing… / proceeded: reason / retrying #… / needs your decision). A `dependency_blocked` request renders in Queued with the reason and four buttons: drop / reopen the dependency / create the replacement (prefilled from `replace`, editable) / cancel this ticket. It is also listed in the needs-attention list.
  - The Machines page shows each machine's admission state ("admitting" / "full: memory" / "full: CPU" / "at ceiling").
- **Design refs**: ADR-0018 §1–§3; 10-contracts §Ticket dependencies.
- **Depends on**: T01.
- **Files owned**: `packages/web/src/dependencies/**` (new), the dependency parts of `web/src/api/{client,http,mock}.ts`, the badge in `components/Board.tsx`, the picker slot in the create form and the detail panel, their tests.
- **Do not touch**: `web/src/auth/**`, `web/src/machines/**`, `web/src/workflow/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `dependencies/BlockedBy.test.tsx`: adding a dependency shows a chip; dropping one calls the DELETE route; each assessment state renders.
  - [ ] `dependencies/DependencyDecision.test.tsx`: the four actions post `dependency-decision`; "create the replacement" is prefilled from the assessment and editable.
  - [ ] `components/Board.dependencies.test.tsx`: a Queued card shows "blocked by" with titles; a cancelled dependency is red with the drop control; a cycle badge opens the thread and "Agree on v2" posts the agreement.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2b-T08 · Orchestrator: dependency service and REST
- **Scope.** `packages/orchestrator/src/tickets/dependencies.ts` (new) and `src/api/dependencies.ts` (new), both scoped by `request.auth.scope`:
  - `addDependency`, `dropDependency`, `setDependenciesOnCreate`, each in one transaction:
    - `pg_advisory_xact_lock(hashtext('deps:' || account_id))`;
    - check that both tickets are in the account (404 otherwise) and that the edge isn't a self-edge (400 `dependency_invalid`);
    - insert the edge, or set `cleared_at` / `cleared_by` to drop it;
    - recompute `dependencyCycles` over the account's open tickets and rewrite `dependency_cycle` (a new cycle is created, a changed one is updated or dissolved, `dissolved_at` set) and `ticket.cycle_id`;
    - publish `card.upserted` for every ticket whose `blocked_by` or `cycle` changed.
  - Routes from T01: `POST /api/tickets/:id/dependencies`, `DELETE /api/tickets/:id/dependencies/:dep_id`, and `depends_on` in `POST /api/tickets` (same transaction as the create).
  - A ticket reaching `done`, `cancelled` or `failed` triggers the recompute too. This is exported as `onTicketClosed(tx, scope, ticketId)` for T10 to call from the wrapper.
- **Design refs**: ADR-0018 §1, §3; ADR-0012 §Tenancy.
- **Depends on**: T02, T03.
- **Files owned**: `src/tickets/dependencies.ts` (new), `src/api/dependencies.ts`, its registration line in `src/api/index.ts`, the `depends_on` part of the ticket-create handler (in `src/api/tickets.ts` since M2c-T07), `test/tickets/dependencies.test.ts`, `test/api.dependencies.test.ts`.
- **Do not touch**: `gateway/**`, `engine/**`, `auth/**`, `shared/**`, the PATCH handler in `api/tickets.ts`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/tickets/dependencies.test.ts`:
    - add A→B, then B→A → one cycle {A, B}, and both tickets get `cycle_id`;
    - drop B→A → the cycle is dissolved and `cycle_id` is null;
    - a 6-ticket cycle is accepted (no size cap) and gets one `cycle_id`;
    - two concurrent adds that each close a different cycle through a shared ticket → both commit and the final cycle set is correct (advisory lock serialises the recompute);
    - A reaching `done` dissolves {A, B}.
  - [ ] `test/api.dependencies.test.ts`: account B adding an edge to A's ticket → 404; a self-edge → 400; `depends_on` on create writes the edges in the same transaction (a bad id rolls back the ticket too).
  - [ ] The M2 route matrix includes the new paths (an entry in its call table) and passes.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T09 · Orchestrator: claim filter and board view
- **Scope.**
  - `gateway/claim.ts`: the ADR-0018 §2 `NOT EXISTS` filter, after the M2 routing filters; the soft **cycle-partner preference** (an unclaimed member whose partner is running sorts first, after priority); the `max_sessions` filter applies only when the machine reports a ceiling (null = none, ADR-0018 §6).
  - `engine/board-view.ts`: Queued cards get `blocked_by`, computed with the same rule as the SQL; it is cross-checked against `blockingDependencies` in tests. Every card of a cycle member gets `cycle` (partners, state from `dependency_cycle.agreement` and any open `cycle_coordination` request).
  - 04 §2 gains the filter.
- **Design refs**: ADR-0018 §2; 04 §2; 10-contracts §Claim.
- **Depends on**: T02, T03.
- **Files owned**: `src/gateway/claim.ts`, `src/engine/board-view.ts`, `test/gateway/claim.dependencies.test.ts`, `test/engine/board-view.dependencies.test.ts`, 04 §2 (the filter paragraph).
- **Do not touch**: `api/**`, `engine/service.ts`, `tickets/**`, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/gateway/claim.dependencies.test.ts`:
    - B depends on A (`in_progress`) → B is not claimed; A → `done` → the next claim takes B, with no other write in between;
    - A `cancelled` → B is still not claimed; after the edge is dropped → claimed;
    - a 2-cycle with no outside dependencies → both claimable;
    - a 2-cycle whose member depends on an open outside ticket → that member is not claimable, the other is;
    - a cleared edge never blocks;
    - with two equal-priority tickets, the one whose cycle partner is running is claimed first;
    - a machine with `max_sessions` null is never refused for slots by the orchestrator.
  - [ ] `test/engine/board-view.dependencies.test.ts`: `blocked_by` matches `blockingDependencies` for 200 random graphs (seeded); cycle cards carry partners and state.
  - [ ] `EXPLAIN` of the claim on a 10 000-ticket test database uses the partial index (noted in the PR).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T10 · Orchestrator: the relay
- **Scope.**
  - **Gateway**: the `session_event peer_message` case calls `EngineService.relayPeerMessage(scope, senderSessionId, event)`.
  - **Wrapper** (`engine/service.ts`), in one transaction:
    1. load the sender's cycle (`FOR UPDATE` on `dependency_cycle`);
    2. resolve the recipients: the live session of each partner ticket. A partner with no session yet gets an inbox entry, rendered when its session starts. A finished partner gets `partner_finished` with its last summary, uncounted;
    3. if the budget is exhausted (`messages_used + recipients > message_budget`, or a 6th proposal version), apply `cycle.budget_exhausted` to the sender and answer `budget_exhausted`;
    4. otherwise insert `cycle_message`, apply `agent.peer_message` to the sender and `peer.message_received` to each recipient, increment `messages_used`, and update the agreement on `proposal` / `agree` (all members agreed to the latest version → `agreement` set and a system notice to everyone, uncounted);
    5. write the `event` rows on both timelines, and answer `relayed` / `queued`.

    The relayed `send_message` `command_id`s use T01's derivation.
  - **Human paths**:
    - answering a `cycle_coordination` request also relays the answer to every partner as `kind: 'human'`, uncounted, and grants `CYCLE_HUMAN_GRANT`;
    - `POST /api/cycles/:id/agreement {version}` sets the agreement as the human's and notifies everyone;
    - `GET /api/cycles/:id/thread` returns `CycleThreadDto`.
  - **Closing tickets**: when the wrapper moves a ticket to `done`, `cancelled` or `failed`, it calls T08's `onTicketClosed`. If the ticket was a cycle member, it sends a system notice to the remaining partners ("#… finished; its last summary: …" or "#… was cancelled").
- **Design refs**: ADR-0018 §3.2–§3.6, §4; ADR-0007; 10-contracts §EngineService wrapper, §Ticket dependencies.
- **Depends on**: T04, T05, T08.
- **Files owned**: `src/engine/service.ts` (the relay and the close hook), the `peer_message` case in `src/gateway/index.ts`, `src/api/cycles.ts` (+ its registration line), `test/engine/relay.test.ts`, `test/api.cycles.test.ts`.
- **Do not touch**: `gateway/claim.ts`, `engine/board-view.ts`, `tickets/**` (call only), `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/engine/relay.test.ts`:
    - a message from A reaches B's live process as one `send_message` with `from_peer`;
    - a replayed daemon event (same seq) relays nothing new;
    - B parked → inbox, then delivered in B's next `start_session`;
    - the 21st message → A in Needs input `cycle_coordination` with the thread, and B gets a notice;
    - the human's answer reaches A (`send_input`) and B (`send_message`, `kind: 'human'`), and the budget grows by 10;
    - a proposal plus agree from every member sets `agreement`;
    - A reaching `done` → B gets the "finished" notice, and a later message to A returns `partner_finished`.
  - [ ] Every relay is one transaction: a failure injected after the sender's apply leaves no `cycle_message`, no event rows and no outbox rows.
  - [ ] `test/api.cycles.test.ts`: account B gets 404 on A's cycle; the agreement route sets the agreement.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T11 · E2E: dependencies and cycles
- **Scope.** `e2e/m2b.e2e.test.ts`, password mode (M2 harness), two fake machines.
  - The fake `claude` gains a script step that calls `message_peer`, and a `-p` mode that answers an assessment from a fixture (`proceed`, `escalate`, a hang for the timeout).
  - The daemon's admission reads fake resources from `CONDUCTOR_TEST_SYSINFO` (T13; tests only), so scenario 6 can cap headroom.
  - The six exit-criteria scenarios, plus G ⇄ H with the budget lowered to 3 (`CONDUCTOR_CYCLE_MESSAGE_BUDGET=3`): the 4th message sends its sender to Needs input with the thread, and the human answer reaches both.
- **Design refs**: ADR-0018; [e2e/README.md](../../../e2e/README.md).
- **Depends on**: T07, T09, T10, T13, T15 (and T06, T14 through them).
- **Files owned**: `e2e/m2b.e2e.test.ts`, additive helpers in `e2e/harness/**`, the fake `claude`'s `message_peer` step and `-p` assessment mode (`packages/daemon/test/fixtures/fake-claude.mjs`, additive).
- **Do not touch**: `packages/**/src`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `pnpm test:e2e` green with every scenario above and every earlier one; 3 consecutive green runs.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T12 · Docs sweep and deploy
- **Scope.**
  - Make 02, 03, 04, 05, 06, 07 (admission) and 10 describe what was built; add implementation notes to ADR-0018; mention dependencies in the README.
  - The lead then deploys `main` with `deploy/gradyserver/deploy.sh` (the T03 migration runs as the release step), runs `smoke.sh`, and Ben queues one real dependent pair.
- **Depends on**: T11, and Ben's approval of the T03 migration.
- **Files owned**: `docs/design/**`, `docs/adr/0018*` (implementation notes), `README.md`.
- **Acceptance**:
  - [ ] A QA agent finds no doc/code contradiction.
  - [ ] The deploy is recorded in the session log, and the hosted dependent pair behaves as in scenario 1.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.


### M2b-T13 · Daemon: hardware-based admission
- **Scope** (ADR-0018 §6). In `packages/daemon/src/admission.ts` (new) and `daemon.ts` (`maybeRequestWork` only):
  - `Admission` takes `SysInfo` samples (every 10 s, plus one right before each `request_work`) and the config, and returns `{admitting, reason}`:
    - it admits only while `mem_free_mb - reserved_mem ≥ ADMIT_MEM_MB` (default `max(3072, 15 % of total RAM)`) **and** `cpu_free - reserved_cpu ≥ ADMIT_CPU` (1.0);
    - once refused, it admits again only after **two consecutive** samples above the thresholds plus the hysteresis margins (+1024 MB, +0.5 core);
    - each start reserves `RESERVE_MEM_MB` / `RESERVE_CPU` for `ADMIT_SETTLE_MS`;
    - the optional `CONDUCTOR_MAX_SESSIONS` ceiling gives `reason: 'ceiling'`.
  - `maybeRequestWork` asks for **one** session at a time (`free_slots: 1`), and only while `admitting`. The TD-027 site goes, and the start-time `memory_pressure` veto stays as the safety net.
  - Config: `conductor-daemon config admit [--mem-mb N | --mem-fraction F] [--cpu C] [--max-sessions N | --no-max]`, env overrides (`CONDUCTOR_ADMIT_MEM_MB`, `CONDUCTOR_ADMIT_CPU`, `CONDUCTOR_MAX_SESSIONS`). `register.max_sessions` is the ceiling or null.
  - The inventory's `admission` field (T01) is reported, and re-sent when `admitting` flips.
  - `CONDUCTOR_TEST_SYSINFO` (a JSON file path, read only with `CONDUCTOR_ALLOW_LOCAL_REPOS`) fakes resources for e2e.
  - 07 §resources: rewritten to describe admission.
- **Design refs**: ADR-0018 §6; [07](../../design/07-multi-session-isolation.md); [04](../../design/04-scheduler.md) §1; TD-027.
- **Depends on**: T01, T06 (`daemon.ts` in sequence).
- **Files owned**: `packages/daemon/src/admission.ts` (new), `sysinfo.ts` (total RAM), `maybeRequestWork` and the register `max_sessions` in `daemon.ts`, the `config admit` subcommand in `config.ts` / `main.ts`, the inventory's admission field in `inventory/report.ts`, their tests, 07 §resources.
- **Do not touch**: `claude/**`, `workspace.ts`, `actions/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `admission.test.ts` (fake clock and fake `SysInfo`):
    - above both thresholds → admitting;
    - memory below → `memory`;
    - recovering just above the threshold → still refused (hysteresis); two samples above threshold + margin → admitting;
    - a start reserves 2 GB / 1 core for 90 s, so a second claim in that window needs that much more headroom;
    - the ceiling → `ceiling`;
    - no ceiling + plenty of headroom → keeps admitting one at a time.
  - [ ] `daemon.admission.test.ts`: no `request_work` is sent while not admitting (pays TD-027: no claim-then-refuse loop); `register.max_sessions` is null without a ceiling; the inventory's `admission` flips are reported.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T14 · Daemon: run an unblock assessment
- **Scope** (ADR-0018 §2a).
  - On `run_assessment {assessment_id, prompt, schema, timeout_ms}`: run `claude -p --output-format json` with:
    - **no tools** (the ADR-0005 driver's tool policy set to none) and the user's settings (ADR-0006);
    - cwd = an empty private temp dir under `<root>/private` (no repo);
    - the prompt on stdin;
    - one turn, and the `timeout_ms` kill.
  - Parse the final result and validate it against `schema` (`UnblockOutcomeSchema`). Reply `assessment_result {assessment_id, result}`, or `{error}` for a non-zero exit, a timeout, invalid JSON or a schema mismatch.
  - It is admitted like a session (T13's `Admission`), counts as one for the reservation, and is acked and deduped on `command_id` like other commands.
  - The prompt and the result are never logged beyond the existing debug level, and nothing is written to disk except the temp dir, which is deleted.
- **Design refs**: ADR-0018 §2a; ADR-0005 (driver); ADR-0006; ADR-0015 (the same one-shot pattern M4 triage will reuse).
- **Depends on**: T01, T13.
- **Files owned**: `packages/daemon/src/assessment.ts` (new), the `run_assessment` case in `daemon.ts`, their tests.
- **Do not touch**: `claude/outcome-server.ts`, `workspace.ts`, `inventory/**` (except reading admission), other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `assessment.test.ts` with a fake `claude` on `PATH`:
    - a valid `proceed` → `assessment_result.result`;
    - invalid JSON → `error`;
    - a hang → killed at `timeout_ms` with `error: 'timeout'`;
    - the argv has no tool flags beyond "none", and the cwd is an empty temp dir that is gone afterwards;
    - a duplicate `command_id` runs once;
    - not admitting → the command waits (it is not refused) until admission allows it.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2b-T15 · Orchestrator: unblock assessments
- **Scope** (ADR-0018 §2a). In `packages/orchestrator/src/tickets/assessment.ts` (new):
  - **Create.** T08's `onTicketClosed` (extended here) inserts one `unblock_assessment` per live edge pointing at a ticket that became `cancelled` / `failed`, keyed `(edge_id, trigger_event_id)`, in the closing transaction. It writes `assessment.requested` events on both tickets' timelines.
  - **Dispatch.** A sweep (the existing sweep loop) picks `pending` rows:
    - it renders the prompt with T05's `renderUnblockAssessment`;
    - it writes the `run_assessment` outbox row to an online machine of the account that has `claude` (the dispatcher's existing machine targeting), and the row becomes `running`;
    - with no such machine for `ASSESSMENT_MACHINE_WAIT_MS` → escalate.
  - **Apply the result** (the gateway's `assessment_result` case), in one transaction, guarded on `status = 'running'`:
    - `proceed` → clear the edge (`cleared_by = 'system:assessment'`, the reason);
    - `retry_dependency` → if `unblock_retry_used` is false, set it and reopen or re-queue the dependency (ADR-0008 reopen service), else escalate;
    - `replace` or `escalate` → create the `dependency_blocked` request (ticket-level, or `needs_input` on a live dependent session through `applyEvent`);
    - an `error`, or no result within `ASSESSMENT_TIMEOUT_MS` + 60 s (a sweep check) → escalate with the error.

    Each path writes `assessment.finished` events on both timelines, board events, and a system message to a running dependent.
  - **Human decisions**: `POST /api/tickets/:id/dependency-decision` (T01) applies drop / reopen / create the replacement (a new ticket, then the edge moved to it, in one transaction) / cancel, and answers the request. A human acting on the edge first marks a pending or running assessment `failed` (`superseded`), and its late result is ignored.
- **Design refs**: ADR-0018 §2a, §4; ADR-0008 (reopen); 10-contracts §Ticket dependencies, §Outbox state machine.
- **Depends on**: T03, T05, T08, T10 (`gateway/index.ts` and the close hook in sequence).
- **Files owned**: `src/tickets/assessment.ts` (new), the assessment hook in `src/tickets/dependencies.ts` (`onTicketClosed`), the `assessment_result` case in `src/gateway/index.ts`, the sweep registration line, `src/api/dependency-decision.ts` (+ its registration line), `test/tickets/assessment.test.ts`, `test/api.dependency-decision.test.ts`.
- **Do not touch**: `engine/service.ts` (call `applyEvent` only), `gateway/claim.ts`, `engine/board-view.ts`, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/tickets/assessment.test.ts`:
    - cancelling D creates one assessment per edge, and cancelling it again (a re-close) creates no duplicate for the same event;
    - `proceed` clears the edge and C becomes claimable;
    - `retry_dependency` reopens D once, and a second failure plus another retry answer → escalate;
    - `replace` → a `dependency_blocked` request with the draft;
    - an `error`, a timeout (fake clock) and no machine for 30 min each → escalate;
    - a late result after a human drop is ignored;
    - both timelines have `assessment.requested` and `assessment.finished`;
    - every apply is one transaction (a failure injected mid-apply leaves no partial edge or request change).
  - [ ] `test/api.dependency-decision.test.ts`: each action; "create replacement" moves the edge to the new ticket; account B → 404.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

---

## Risks
- **Agents may chat instead of working.** Mitigation: the budget (U-077), the prompt's instruction to agree on the shared part only, and `wait_seconds` so they don't spin.
- **Agreement is advisory**, so two agents can agree and still diverge. Mitigation: the agreed text is in every later prompt, and each ticket's own PR review checks it. Revisit per ADR-0018 if it happens.
- **"Done" isn't "merged"** (U-078): a dependent can start before its dependency's PR is merged and miss the code. Mitigation: in `conductor` v2 a human takes Done after reviewing the PR; revisit with M5's `pr_merged`.
- **Relay transactions touch several sessions.** Mitigation: a lock order (cycle row first, then sessions in id order) and the failure-injection test in T10.
- **A wrong `proceed`** starts a dependent too early. Mitigation: the reason is on both timelines, the dependent's own checks and review still run, and "drop" and "reopen" stay one click away. Revisit if humans often override assessments.
- **Admission thresholds that are wrong for a machine** (idle while it has room, or swapping). Mitigation: per-machine config, the admission state on the Machines page, and the start-time veto as a backstop (U-082).
- **A cycle member no machine can run** blocks its partners' coordination. Mitigation: its own routing badge, and the tool tells the waiting agent `queued`, so it can ask a human.
