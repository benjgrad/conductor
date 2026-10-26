# M1b · Transition rules (ADR-0011)

**Goal**: rules live on transitions ([ADR-0011](../../adr/0011-transition-rules.md)). Each outgoing edge of a state is a named transition with `when`, `actor`, `kinds`, `requires` and `on_unmet`:
- an agent finishes by naming the transition it takes, with a reason;
- a human moves a Needs-input card with one button per allowed transition;
- checks, review, actions and external **conditions** run on the move, and the card stays in its column with a live "waiting for …" checklist until they pass or fail to a human;
- tickets have a `kind` (work / personal) that filters transitions;
- `conductor` v2 encodes Ben's rules.

Everything runs locally, with no auth (M1 local mode).

**Exit criteria**:
- Every task below is `done` and passed QA ([QA_CHECKLIST](../../qa/QA_CHECKLIST.md)).
- `pnpm test:e2e` is green, with the four ADR-0011 scenarios (M1b-T10) and every M1 / ADR-0007..0010 scenario still green (the ADR-0010 one on conductor v2).
- `conductor` v2 is seeded on a fresh database, and an unedited v1 database is upgraded to v2 on start.
- An old ticket pinned to `conductor` v1 or `m1_*` still runs to Done (regression test).
- 02, 03, 05, 06 and 10 describe what was built; ADR-0011 gets implementation notes; Ben accepts ADR-0011.
- The ticket-kind migration has been applied to Ben's database after his sign-off.

**Not in M1b**:
- auth, accounts, enrollment (M2);
- routing by capability (M2): conditions are evaluated on the session's own machine;
- Jira, Azure and Slack conditions and actions (M5): declared in v2 but `enabled: false`, and the daemon reports them `unsupported`;
- webhooks (M5): polling only;
- triage (M4): the create form requires `kind`;
- the MCP `take_transition` tool (M3): the REST route only;
- releasing the machine slot while conditions are pending (TD, see U-059);
- parallel condition sets, and per-account workflow variants.

**Blocking unknowns**: the proposed rows below must be answered by Ben (through the lead) **before M1b-T01 freezes the contracts**. Each has a recommended answer, which the task text assumes.
- **U-061**: human transitions:
  - `answer` returns to the asking state through `goto: "$return_to"`, allowed only on human-state transitions;
  - `cancel` is not a transition: it stays the existing operator route, shown as a button next to them;
  - `ask_user` stays a declared outcome on every agent state (the built-in fallback), alongside any `question: true` transitions.
- **U-062**: existing tickets get `kind = null`, which matches transitions for both kinds; new tickets must set it.
- **U-063**: a `condition_timeout` goes straight to `on_unmet.else` (a human), like an action failure. A condition that turns `failed` (checks red, changes requested) goes to `on_unmet.goto` with the evidence and counts against `retries`.
- **U-059**: while conditions are pending:
  - the session status is `waiting_external`, so the card shows in its source column with the checklist;
  - wall time is not counted, as for event states;
  - the worker process is ended, as in an entry step;
  - the machine slot stays held, as for Waiting external today (TD).
- **U-058**: with no machine online the `evaluate_conditions` command waits in the outbox, the checklist says "waiting for a machine to check", and `condition_timeout` still runs.

## Task board

Status values: `todo` · `in_progress` · `in_review` (QA) · `done` · `blocked` (link B-###).

| ID | Task | Depends on | Parallel group | Status | Branch / owner |
|---|---|---|---|---|---|
| M1b-T01 | **Contracts**: transition schema, engine events/effects/step, WS, REST, card and detail DTOs, `ticket.kind` row type, legacy fold, fixtures and fakes | U-058, U-059, U-061..U-063 answered | A | todo | |
| M1b-T02 | Validator: transition rules (actor/type, question targets, conditions bounded, ask_user present, kinds) | T01 | B | todo | |
| M1b-T03 | Engine: pick and check a transition; actor/kind filter; `requires` as a move step (checks → review → actions); human transitions; prompt lists transitions; the `moves` record | T01 | B | todo | |
| M1b-T04 | Orchestrator: `ticket.kind` migration; create requires kind; `POST /api/sessions/:id/transition`; detail `moves`; card fields served | T01 | B | todo | |
| M1b-T05 | Daemon: `complete_state {transition, reason}` with the allowed list; the `evaluate_conditions` action via `gh`; the fake claude reports transitions | T01 | B | todo | |
| M1b-T06 | Web editor: clickable arrows and the transition panel; the column panel keeps title and work | T01 | B | todo | |
| M1b-T07 | Web board: the "waiting for" checklist, Needs-input transition buttons, a moves timeline, kind on the create form and card | T01 | B | todo | |
| M1b-T08 | Engine: the conditions phase (polling through the deadline, met / pending / failed, timeout, no machine) | T03 | C | todo | |
| M1b-T09 | `conductor` v2 and the seed upgrade | T02, T03 | C | todo | |
| M1b-T10 | E2E: the four ADR-0011 scenarios + regression on v1 and a fake `gh`; docs sweep and ADR-0011 implementation notes | all | D | todo | |

Groups run in order A → B → C → D. Tasks within a group own disjoint files and go to parallel implementer agents ([CLAUDE.md](../../../CLAUDE.md) › Orchestrate). Groups B–D code against the T01 contracts and their fakes; a needed contract change is reported to the lead, never made locally.

**Shared doc ownership** (the files several tasks touch, by section, so merges don't collide):
- 05-workflow-engine: T01 owns §Definition schema, T02 owns §Validation on save, T03 owns a new §Transitions, T08 owns a new §Conditions;
- 10-contracts: T01 only;
- 06-human-input: T07 owns §Kanban columns and §Session detail panel;
- 02 / 03: T01 for the shapes, T04 for the migration and route notes.

**Gates (Ben)**:
- before A, answer U-058, U-059, U-061..U-063;
- after A, approve the 10-contracts changes, as in M1;
- before T04 merges, approve the `ticket.kind` migration;
- at the end, accept ADR-0011 and sign off M1b.

---

## Task details

### M1b-T01 · Contracts
- **Scope.** Freeze every seam the parallel group B needs. Only this task edits these files in M1b (later tasks report changes to the lead):
  - **`shared/src/workflow/schema.ts`**: `TransitionObjectSchema` gains:
    - `title?` (the button and timeline label; default: the name, humanised);
    - `when?` (≤ 1 000 chars);
    - `actor?: 'agent' | 'human' | 'system'`;
    - `kinds?: ('work' | 'personal')[]` (non-empty; omitted = both);
    - `question?: boolean`;
    - `requires?: {checks?, setup?, review?: {items, model?}, actions?, conditions?, condition_timeout?, condition_poll?}` (`condition_poll` defaults to 2m; tests set it lower);
    - `on_unmet?` (the existing `OnUnmetSchema`).

    Also:
    - `ConditionSchema` is a discriminated union: `pr_checks_green`, `pr_approvals {min ≥ 1}`, `pr_merged`, `azure_pipeline_succeeded {pipeline}`, `jira_fields_set {fields[1..20]}`, each with `enabled?: boolean` (default true) and `label?`;
    - `actions` accepts `open_pr` now; `update_jira` and `slack_message` are parsed but refused by the validator until M5;
    - `goto: "$return_to"` (`RETURN_TO`) is a valid target;
    - `TicketKindSchema` (`'work' | 'personal'`).

    Old definitions parse unchanged.
  - **Actor inference** (`transitionActor(def, state, name, t)`): explicit `actor`; else `system` for `timeout`, `exit_0`, `fail`, `ok`, `error`, an event state's `wait_for` names and `budget_exceeded`; else `human` from a human state; else `agent`.
  - **`foldLegacyRequirements(def)`** (`shared/src/workflow/fold.ts`): returns an equivalent definition in which:
    - each `states.<s>.entry` is moved to `requires` + `on_unmet` on every non-fallback transition whose `goto` is `s`;
    - each ADR-0009 `requirements` becomes `requires.review` + `on_unmet`.

    The editor calls it when it saves; the engine keeps executing old versions as they are.
  - **`shared/src/engine/types.ts`**:
    - `agent.complete_state` gains `transition: string | null` and `reason: string | null`;
    - a new event `human.transition {name, text: string | null, actor}`;
    - `GateStep.kind` gains `'move'`, with `transition` (the name), `phase` gaining `'conditions'`, and `conditions: ConditionStatus[]` (`{type, label, status: 'todo' | 'running' | 'met' | 'pending' | 'failed' | 'disabled' | 'unsupported', value, detail, checked_at}`), `conditions_deadline`;
    - `state.entered` payload gains `transition`, `reason`, `actor`;
    - a counter key `moveCounterKey(from, name)` = `"move:<from>:<name>"`;
    - new apply ignore reasons `unknown_transition`, `transition_not_allowed`.
  - **`shared/src/protocol/ws.ts`**:
    - `session_event complete_state` data gains `transition?` and `reason?`;
    - `start_session` gains `transitions: [{name, when, question}]`, the agent-actor transitions for the ticket's kind;
    - `run_action.action` gains `evaluate_conditions` (args `{conditions, pr_url, branch}`), whose `action_result.result` is `{results: [{type, status, value, detail}]}`. No new outbox kind, so no enum migration.

    One fixture per new shape.
  - **`shared/src/protocol/outcome.ts`** (new): `CompleteStateInputSchema` `{transition?, reason?, result}`, shared by the daemon's outcome server and the fake.
  - **`shared/src/api/rest.ts`**:
    - `CreateTicketRequest.kind` is required;
    - `TransitionSessionRequest {name, text?}` and `API_PATHS.sessionTransition`;
    - `BoardCard` gains:
      - `kind`;
      - `pending: {transition, to, title, items: [{label, status, detail}]} | null`, which supersedes `checking` (kept, filled from it, for one release);
      - `human_transitions: [{name, title, goto, needs_text}]`, filled for a session in a human or event state;
    - `SessionDetail.moves: [{at, from, to, transition, reason, actor}]` (the last 50);
    - `toBoardCard` fills the new fields.
  - **`orchestrator/src/db/types.ts`**: `TicketRow.kind: 'work' | 'personal' | null`.
  - **`orchestrator/src/contracts.ts`**: nothing new expected. If the transition route needs an `EngineService` change, it is made here.
  - **Docs**: 10-contracts (a new §Transitions seam row and section), 05 §Definition schema, 02 (`ticket.kind`), 03 (the route, the WS fields).
- **Design refs**:
  - ADR-0011 (all);
  - [05](../../design/05-workflow-engine.md) §Requirements to enter a column;
  - [10](../../design/10-contracts.md) §Requirements review and entry steps;
  - M1-T12 (for the contract-task shape).
- **Depends on**: U-058, U-059, U-061, U-062, U-063 answered.
- **Files owned**: the files listed above, plus their fixtures (`shared/src/*/fixtures.ts`), their tests, and `shared/src/index.ts` exports.
- **Do not touch**: `docs/tracking/**`; `apply.ts`, `validate.ts` (stubs only if a type forces it); `packages/web/**`; `packages/daemon/src/**` except type-only fallout.
- **Acceptance**:
  - [ ] Every new WS and REST fixture round-trips through its schema (`pnpm test --project shared`).
  - [ ] `conductor.v1.json`, `m1_*.json` and `pr_flow.v1.json` still parse; `foldLegacyRequirements(CONDUCTOR_V1_DEF)` puts v1's entry on `implementing.on.done` (unit test), and the result parses.
  - [ ] `transitionActor` table test: `timeout` → system, `ui.approve` on an event state → system, `done` on an agent → agent, a key on a human state → human, explicit wins.
  - [ ] `toBoardCard` tests: a move step in `conditions` yields `pending.items` with statuses; a needs_input card yields `human_transitions` filtered by kind.
  - [ ] All gates are green.
  - [ ] An interface-review agent confirms T02–T09 can each be built from the contracts plus fakes alone.
  - [ ] Ben approves the 10-contracts diff.
- **Note**: this is mostly schemas, fixtures and docs, and may run to ~500 lines. If the interface review asks for more, split the REST/card half into a T01b before group B starts.

### M1b-T02 · Validator: transition rules
- **Scope.** New `shared/src/workflow/validate-transitions.ts`, called from `validate.ts`, adding:
  - **Rule 10, actor fits the state:**
    - `actor: agent` only on agent states;
    - `actor: human` only on human and event states;
    - `$return_to` only on human-state transitions.
  - **Rule 11, questions:** `question: true` only on a transition to a human state.
  - **Rule 12, every agent state can ask:** it declares `ask_user` (to a human state) or at least one agent-actor `question: true` transition.
  - **Rule 13, bounded conditions:**
    - a transition with `requires.conditions` has `condition_timeout` and `on_unmet` whose `else` is human;
    - `requires` with checks, review or actions has `on_unmet`;
    - `on_unmet.goto` has no `requires` of its own (no nested steps, as rule 9).
  - **Rule 14, actions:**
    - `update_jira` and `slack_message` are errors until M5 ("not available yet");
    - a `requires` on a transition into the start state is an error.
  - Rule 4's loop analysis counts a `move:` on_unmet goto leg as bounded (its counter) and the else leg as unbounded.
  - Rule 9 keeps checking old `entry` fields.
  - The REST error paths point at the transition: `states.<s>.on.<name>.requires.conditions.1`.
- **Design refs**: ADR-0011 §How the agent picks a transition; [05](../../design/05-workflow-engine.md) §Validation on save.
- **Depends on**: T01.
- **Files owned**: `packages/shared/src/workflow/validate.ts`, `validate-transitions.ts`, `validate*.test.ts`; 05 §Validation on save.
- **Do not touch**: `schema.ts` (contract), `engine/**`, other packages.
- **Acceptance**:
  - [ ] Table-driven tests with at least one failing fixture per rule 10–14, each asserting the exact error path.
  - [ ] Every shipped workflow (v1, `m1_*`, `pr_flow`) still validates; `foldLegacyRequirements(v1)` validates.
  - [ ] The draft v2 fixture from T01 validates (if T09 lands later, T09 re-runs this test against the final v2).

### M1b-T03 · Engine: transitions
- **Scope.** In `apply()`, keeping it pure. New logic goes in `shared/src/engine/transitions.ts` and `move-step.ts`; `apply.ts` only dispatches.
  - **Agent outcomes:** `agent.complete_state {transition, reason}`:
    - a null transition means `done`;
    - the name must exist in the current state's `on`, be agent-actor, and match the ticket's kind (null kind matches both, U-062). Otherwise it is ignored with `unknown_transition` / `transition_not_allowed` and the session goes to the U-028 path (`needs_input`, `agent_question`, with "The agent named an unknown transition '<x>'"). The daemon has already refused it once (T05).
    - `question: true` → `needs_input` with the reason as the question. `ask_user` is unchanged.
  - **Human transitions:** `human.transition {name, text}` from a human state (or event state, for `actor: human`). Kind filter as above. `$return_to` resolves to `return_to`. `text` is delivered like an answer when the target is the asking agent state (the existing pending-answer path). It closes the open `input_request` with `answered_by` = actor, and is ignored (`wrong_status`) outside those states. `/input` keeps working: it is `human.transition` to `$return_to` (or the `goto` state for "skip to").
  - **`requires` on any taken transition → a move step** (`kind: 'move'`). It reuses the entry-step machinery (fresh-checkout checks, the reviewer, `run_action` actions, fencing bumps, the worker kill, failures straight to `else`), with these differences:
    - the counter is `move:<from>:<name>`;
    - the feedback heading is "Requirements for <title> were not met:".

    The conditions phase is a stub that passes when there are no conditions; T08 builds the real phase.
    Human moves run requirements too (ADR-0010 "skip to"); the routes to a human (fallbacks, budget, `on_unmet`) never do.
  - **Prompt** (`render.ts`): an agent prompt ends with "## How to finish", listing each allowed transition as `- <name>: <when>`, and how to call `complete_state` with `transition` and `reason`. `start_session.transitions` is filled from the same list.
  - **Moves:** `state.entered` events carry `transition`, `reason`, `actor`.
  - Old versions still run unchanged: entry steps and ADR-0009 gates.
- **Design refs**: ADR-0011 §Who takes a transition, §Requirements on the move; [05](../../design/05-workflow-engine.md) §Requirements to enter a column (the machinery reused); [10](../../design/10-contracts.md) §Pending answer.
- **Depends on**: T01.
- **Files owned**: `packages/shared/src/engine/{apply.ts, transitions.ts, move-step.ts, render.ts}` and their tests (`apply.transition.test.ts` new); 05 §Transitions (new).
- **Do not touch**: `engine/types.ts` (contract), `workflow/**`, other packages.
- **Acceptance**:
  - [ ] Unit tests: each conductor v2 agent transition is taken by name; a work-only transition named on a personal ticket → `transition_not_allowed` → needs_input; a null transition → `done`; `scope_changed` → needs_input with the reason as the question.
  - [ ] A human `waiting_on_someone` from needs_input enters `waiting_external` with the text as the reason; `answer` with `$return_to` resumes the asking agent with the text as the pending answer.
  - [ ] A move with checks red once → back with the evidence (counter `move:implementing:ready_for_testing` = 1), then green → actions → target entered.
  - [ ] The property test (`apply.property.test.ts`) is extended with transition events and stays green with 1 000 runs.
  - [ ] `apply.entry.test.ts` and `apply.review.test.ts` pass unchanged (old versions).
  - [ ] The prompt snapshot test shows the "How to finish" list filtered by kind.

### M1b-T04 · Orchestrator: kind, the transition route, moves
- **Scope**:
  - **Migration** `packages/orchestrator/migrations/<ts>_ticket-kind.sql`: `CREATE TYPE ticket_kind AS ENUM ('work','personal')`; `ALTER TABLE ticket ADD COLUMN kind ticket_kind NULL`. The down migration drops both.
  - `POST /api/tickets` requires `kind` (400 without it).
  - `POST /api/sessions/:id/transition {name, text?}` → `human.transition` with the actor `ui` (202; 409 `conflict` when ignored; 404 for an unknown session; 400 for a bad body).
  - `GET /api/sessions/:id` fills `moves` from `state.entered` event rows (one indexed query, last 50).
  - The board and SSE serve the T01 card fields (`toBoardCard` already computes them; the API passes the ticket's kind and the definition).
  - The schema test (`test/schema.test.ts`) covers the new column and enum.
- **Design refs**: ADR-0011 §Ticket kind, §Who takes a transition; [03](../../design/03-protocols.md) §REST; [02](../../design/02-data-model.md) §ticket.
- **Depends on**: T01. Ben approves the migration before merge.
- **Files owned**: `packages/orchestrator/migrations/**` (new file only), `src/api/**`, `src/db/**` (except `types.ts`), `test/**` for these; 02 and 03 notes for the route and column.
- **Do not touch**: `src/contracts.ts`, `src/db/types.ts`, `src/engine/**` (except a call site if the route needs one, reported), `src/gateway/**`.
- **Acceptance**:
  - [ ] Migration up/down on an empty DB and on a DB with M1 data (existing tickets end with `kind = null`).
  - [ ] API tests: create without kind → 400; transition → 202 and the session moves (with the real engine against the T01 fake definition); an ignored transition → 409; an unknown session → 404.
  - [ ] Session detail returns `moves` in order with transition, reason and actor.
  - [ ] The M1-T14 guards apply to the new route (test: a foreign Origin → 403, non-JSON → 415).

### M1b-T05 · Daemon: transitions and `gh` conditions
- **Scope**:
  - **Outcome server** (`claude/outcome-server.ts`): `complete_state` accepts `transition` and `reason` (`CompleteStateInputSchema`). When `start_session.transitions` is non-empty:
    - an unknown name returns corrective text listing the allowed names, not emitted (the ADR-0011 "one corrective nudge", done at the tool call);
    - a second unknown name is emitted as-is, and the engine routes it to a human.

    The tool description lists the transitions.
  - **Forwarding**: `session_event complete_state` carries `transition` and `reason`.
  - **`evaluate_conditions`** (`actions/conditions.ts`, new): for `pr_checks_green`, `pr_approvals`, `pr_merged`, run `gh pr view <pr_url> --json statusCheckRollup,reviewDecision,reviews,state,mergedAt`:
    - outside any repository, with the open_pr hardening (no inherited `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`);
    - a 60 s timeout, output capped at 16 KB;
    - map to `met` / `pending` / `failed` per [ADR-0016](../../adr/0016-work-connectors-on-the-users-machine.md)'s table;
    - other types → `unsupported`;
    - a missing `gh` or no auth → every condition `pending` with the detail "gh not available: …".

    It returns `action_result {result: {results}}`. Read-only, so it doesn't use the open_pr idempotency rules.
  - **Fake claude** (`test/fixtures/fake-claude.mjs`): script steps can name `transition` and `reason`.
- **Design refs**: [ADR-0005](../../adr/0005-claude-code-driver.md) §Contract; ADR-0010 implementation notes (open_pr hardening); ADR-0011 §Requirements on the move; ADR-0016 §The connector registry.
- **Depends on**: T01.
- **Files owned**: `packages/daemon/src/claude/outcome-server.ts`, `src/actions/conditions.ts` (new), `src/daemon.ts` (the run_action dispatch and forwarding only), `test/fixtures/fake-claude.mjs`, and their tests.
- **Do not touch**: `src/claude/driver.ts` (contract), `packages/shared/**`, the e2e harness.
- **Acceptance**:
  - [ ] Outcome-server tests: a valid name is emitted with its reason; an unknown name gets corrective text once, then is emitted; no list → any name passes (old workflows).
  - [ ] Condition tests with a fake `gh` (`/bin/sh` script, the ADR-0010 pattern): checks success / failure / in-progress → met / failed / pending; approvals 0/1 → pending, 1/1 → met, changes requested → failed; `gh` missing → pending with detail; output over 16 KB is truncated.
  - [ ] A daemon test: `run_action evaluate_conditions` → one `action_result` with a result per condition, acked `accepted`.

### M1b-T06 · Web editor: transition arrows
- **Scope.** The Workflow view keeps columns ([ADR-0010](../../adr/0010-one-workflow-columns-are-states.md)); arrows between columns become clickable again (`ColumnsDiagram`).
  - **An arrow's panel** (`TransitionEditor.tsx`, new) edits:
    - name (rename, unique per state) and title;
    - `when`, actor and kinds;
    - `question`;
    - requires: checks (name, cmd, timeout), setup, review items, actions (`open_pr`), conditions (type, args, enabled) with `condition_timeout`;
    - `on_unmet` (goto, instruction, retries, else).
  - Several transitions between the same two columns are drawn as one arrow with a count badge; the panel lists them.
  - "Add transition" from a column's panel.
  - **The column panel** (`ColumnEditor`) keeps title and work (prompt, tools, model) and loses "requirements to enter": a version that still has `entry` shows a notice, "Saved as transition requirements" (save calls `foldLegacyRequirements`).
  - Validator errors map to the arrow by path (`states.<s>.on.<name>…`).
- **Design refs**: ADR-0011 §Editor and board; ADR-0010 §One workflow (the view).
- **Depends on**: T01.
- **Files owned**: `packages/web/src/workflow/**`.
- **Do not touch**: `packages/web/src/components/**`, `src/board/**`, `src/api/**` (T07), other packages.
- **Acceptance**:
  - [ ] Component tests:
    - click an arrow → the panel shows its transitions;
    - edit `when` and kinds, then save → the POSTed definition has them;
    - add a condition with no timeout → the server's rule-13 error is shown on that arrow;
    - a v1 definition saves with entry folded onto `implementing.on.done`.
  - [ ] A QA screenshot of the v2 diagram, with the arrow panel open.

### M1b-T07 · Web board: checklist, buttons, timeline, kind
- **Scope**:
  - **Card**: when `pending` is set, a compact checklist "waiting for: ✓ Tests pass · ✓ PR opened · ◻ approvals 1/2 · ◻ pipeline", with each item's status icon and the detail on hover. Disabled and unsupported items are greyed. The kind is shown as a small tag.
  - **Needs-input card and detail panel**: one button per `human_transitions` entry. `needs_text` opens a text box first (e.g. "Waiting on someone else" asks who or what). The button posts `/transition`. The answer box remains for `$return_to`. The quick actions (retry, skip to, abort) stay for old versions only.
  - **Detail panel**: a "Moves" list from `moves`: "<time> <from> → <to> · <title of transition> — <reason>".
  - **Create form**: a required Work / Personal choice.
  - **Mock API** (`api/mock.ts`, `mock-data.ts`): the new fields, so the board runs with no server.
- **Design refs**: ADR-0011 §Editor and board; [06](../../design/06-human-input.md) §Kanban columns, §Session detail panel.
- **Depends on**: T01.
- **Files owned**: `packages/web/src/components/**`, `src/board/**`, `src/api/**`, `src/App.tsx`; 06 §Kanban columns and §Session detail panel.
- **Do not touch**: `packages/web/src/workflow/**` (T06), other packages.
- **Acceptance**:
  - [ ] Component tests:
    - a card with `pending` renders each item and status;
    - the needs-input buttons post `{name, text}` exactly (a body assertion, unlike TD-038);
    - a `needs_text` button requires text;
    - the create form can't submit without a kind;
    - moves render with their reasons.
  - [ ] A QA screenshot of the board against the mock: a card held in Implementing with its checklist, and a Needs-input card with three buttons.

### M1b-T08 · Engine: the conditions phase
- **Scope.** Replaces T03's stub, in `shared/src/engine/conditions.ts` plus the move-step handler:
  - After actions, if any enabled condition exists:
    - set status `waiting_external` (U-059), with the card in the source column;
    - emit `run_action evaluate_conditions` (args: the conditions and `context.__pr.pr_url`);
    - arm `state_deadline` = min(next poll, `condition_timeout`).
  - **`action.completed`**: store each status in `step.conditions`, then:
    - all met → enter `to`;
    - any failed → `on_unmet.goto` with the evidence (the condition and its last value), counted under `move:<from>:<name>`; exhausted → `else`;
    - else pending → re-arm the next poll: `condition_poll` (default 2 min), doubling after each unchanged result up to 15 min.
  - **`timer.fired`**:
    - past `condition_timeout` → kill nothing, go to `on_unmet.else` with kind `timeout` and the checklist as the question (U-063);
    - else re-emit `evaluate_conditions`.
  - **A refused or failed action** (no machine, ack timeout): keep pending, mark the checklist "waiting for a machine to check", and re-arm (U-058). Not a requeue.
  - `wall_seconds` doesn't count while conditions are pending.
  - Disabled conditions are skipped. `unsupported` counts as pending, and a validator warning in the editor flags it.
  - An `external.event` named in the event state's `wait_for` while conditions are pending (e.g. `ui.approve` on Waiting external) is still taken: a human approve overrides.
- **Design refs**: ADR-0011 §Requirements on the move (Conditions); [ADR-0016](../../adr/0016-work-connectors-on-the-users-machine.md) §Execution.
- **Depends on**: T03 (same files).
- **Files owned**: `packages/shared/src/engine/{conditions.ts, move-step.ts, apply.ts}` and tests (`apply.conditions.test.ts`); 05 §Conditions.
- **Do not touch**: contracts, other packages.
- **Acceptance**:
  - [ ] Unit tests: approvals pending → pending (re-armed at 2, then 4 min) → met → target entered; checks failed → back to implementing with "pr_checks_green: failed (…)" in the feedback; the timeout → needs_input `timeout` listing the checklist; a refused evaluation → still pending, re-armed, card detail says "waiting for a machine".
  - [ ] Property test: every move step with conditions ends at the target or a human within `condition_timeout` + one poll (bounded).
  - [ ] `wall_seconds` doesn't grow across a 3-day fake-clock wait.

### M1b-T09 · `conductor` v2 and the seed upgrade
- **Scope**:
  - `docs/design/workflows/conductor.v2.json` and `CONDUCTOR_V2` in `shared/src/workflow/conductor.ts` (kept equal by the existing test), per ADR-0011 §Default conductor v2. The sketch below is non-normative; T09 writes the full file.
  - **Seed**: on start, if the latest `conductor` version equals the shipped v1 (deep-equal to `CONDUCTOR_V1_DEF`, so unedited), insert v2 as the next version. If the user has edited it, insert nothing and log "A newer default conductor workflow is available". `GET /api/workflows/conductor` carries `default_available: 2`; the editor's notice is T06's follow-up, not this task.
  - The idempotent single-statement seed pattern of ADR-0010 is kept.
- **Design refs**: ADR-0011 §Default conductor v2; ADR-0010 §Implementation notes (Seed).
- **Depends on**: T02 (it must validate), T03 (its transitions must run).
- **Files owned**: `docs/design/workflows/conductor.v2.json`, `packages/shared/src/workflow/conductor.ts` (+ test), `packages/orchestrator/src/engine/seed.ts` (+ test); 00-overview's design-index line.
- **Do not touch**: `schema.ts`, `validate*.ts`, `apply.ts`, the web.
- **Acceptance**:
  - [ ] v2 validates; `python3 -m json.tool` accepts the file.
  - [ ] Seed tests: an empty DB → v1 and v2 (v2 latest); an unedited v1 → v2 added; an edited v1 (v2 by the user) → nothing added; concurrent starts → exactly one v2.
  - [ ] A unit test walks v2 for a work ticket and a personal ticket and asserts the transition list each kind sees from each state.

```json
{
  "implementing": {
    "type": "agent",
    "title": "Implementing",
    "prompt": "implement_template",
    "tools": ["edit", "bash", "git"],
    "on": {
      "needs_approval_to_message": {
        "goto": "needs_input",
        "when": "You are about to message a person and need approval of the text first.",
        "question": true
      },
      "pr_ready_for_review": {
        "goto": "needs_input",
        "when": "The work is done and you want the user to review the PR.",
        "question": true,
        "requires": { "checks": [{ "name": "Tests pass", "cmd": "npm test" }], "actions": ["open_pr"] },
        "on_unmet": { "goto": "implementing", "retries": 3, "else": "needs_input" }
      },
      "ready_for_testing": {
        "goto": "waiting_external",
        "when": "The work is complete and should go to testing.",
        "kinds": ["work"],
        "requires": {
          "checks": [
            { "name": "Build passes", "cmd": "npm run build" },
            { "name": "Tests pass", "cmd": "npm test" }
          ],
          "actions": ["open_pr"],
          "conditions": [
            { "type": "pr_checks_green" },
            { "type": "pr_approvals", "min": 1 },
            { "type": "jira_fields_set", "fields": ["resolution"], "enabled": false },
            { "type": "azure_pipeline_succeeded", "pipeline": "ci", "enabled": false }
          ],
          "condition_timeout": "3d"
        },
        "on_unmet": { "goto": "implementing", "retries": 3, "else": "needs_input" }
      },
      "done": {
        "goto": "done",
        "when": "The work is complete.",
        "kinds": ["personal"],
        "requires": {
          "checks": [
            { "name": "Build passes", "cmd": "npm run build" },
            { "name": "Tests pass", "cmd": "npm test" }
          ],
          "actions": ["open_pr"]
        },
        "on_unmet": { "goto": "implementing", "retries": 3, "else": "needs_input" }
      },
      "ask_user": "needs_input",
      "timeout": "needs_input"
    }
  }
}
```

### M1b-T10 · E2E and docs sweep
- **Scope**: new scenarios in `e2e/m1b.e2e.test.ts`, with the fake claude naming transitions and a fake `gh` whose answers a test can change between polls (a state file, the `fakeState` pattern). The test saves a workflow version with `condition_poll: "1s"` through the API, so polling is fast without a test-only env knob. Scenarios:
  1. Planning → Needs input via `scope_changed`, with its reason as the question; answered → back to Planning → `plan_ready` → Implementing.
  2. A work ticket: Implementing → `ready_for_testing` → checks pass → `open_pr` (fake gh) → held in **Implementing** with checklist approvals 0/1. The fake flips to 1/1 → the card moves to Waiting external, and the SSE `card.upserted` history shows the checklist changing.
  3. Needs input → Done by a human `done` button (`POST /transition`).
  4. A personal ticket runs Planning → Implementing → `done` → Done, with no conditions and no Waiting external.
  5. Regression: a ticket pinned to conductor v1 still runs the ADR-0010 path.

  The existing ADR-0010 scenario moves to v2.

  **Docs sweep**: ADR-0011 gets §Implementation notes; 00-overview and 01 are checked for stale "entry requirements" language.
- **Design refs**: ADR-0011 §Verification (in the approved plan); [M1-T10](M1-single-machine.md#m1-t10--e2e).
- **Depends on**: all.
- **Files owned**: `e2e/**`, ADR-0011 §Implementation notes, 00/01 wording fixes.
- **Do not touch**: `packages/**` (report fixes back to the owning task's branch, or open a fix task).
- **Acceptance**:
  - [ ] `pnpm test:e2e` is green, with scenarios 1–5 plus every earlier scenario, in fake mode in < 3 min.
  - [ ] Scenario 2 asserts the card's column stayed `implementing` until the flip, and the timeline shows `ready_for_testing — <reason>`.
  - [ ] `scripts/ci.sh` is green on the merged tree.
