# M2c · Ticket requirements and verification (ADR-0019)

> **Approved by Ben 2026-10-27** (PR #6), from his design review; [ADR-0019](../../adr/0019-ticket-requirements-and-verification.md) accepted.

> **Note 2026-10-27 ([M2r](M2r-review-merge.md), ADR-0020 proposed).** M2r lands first and takes `conductor` **v3**, so T05's prompt-line version below becomes **v4** (T08 seeds v4 over an unedited v3). T04 also maps the In QA state's result (`role: qa`) onto the **review** layer: its `requirements[]` become `record_evidence {layer: 'review', source: 'qa'}` and its `verdict` feeds the tally's `QA` (ADR-0020 §7). T05's QA prompt switches from heading extraction to `parseTicketBody`.

**Goal** ([ADR-0019](../../adr/0019-ticket-requirements-and-verification.md)):
- A ticket body follows the sections **Goal / Context / FR-n / NFR-n / Out of scope / Verification**. It is written and **edited** in the BlockNote editor and parsed by one shared parser.
- Each requirement's status is built from four recorded layers: the agent's claim, conductor's checks (persisted runs with durations), the reviewer's or QA's grades, and a human sign-off where the Verification line asks for one.
- The card shows **`FR 6/6 · NFR 3/4 · checks ✓ · QA pass`**, and a session's prompt can be viewed.

**Placement and why it is its own milestone**:
- **When**: after M2's engine work.
  - Its shared-engine and web tasks (groups A–B) start once **M2-T20** has merged; M2-T06 and T26 are the only other M2 edits to `apply.ts`, and both are earlier.
  - Its orchestrator tasks (group C) start once **M2-T21** has merged, because T21 owns `src/api/**`.
  - It runs **alongside M2's tail** (T22–T25: e2e, docs, deploy) and ships with M2's deploy or right after it.
- **Not shared with ticket dependencies (M2b)**: the two are independent features under two ADRs, and Ben may approve one and not the other. Verification is more urgent: every M2 dogfood ticket would use it, and UX-1..3 already need the parser, the edit route and the prompt route. Dependencies only pay off once whole milestones are queued.
  - They do touch the same files: `render.ts`, `apply.ts`, the ticket-create handler, `board-view.ts`, the card DTO. Two milestones in sequence, **M2c then M2b**, keep those edits ordered without a combined 22-task chain.
- **The roadmap order is M2 → M2c (overlapping M2's tail) → M2b → M3.**

**Exit criteria**:
- Every task `done` and QA'd; `pnpm test:e2e` green with M2c-T10's scenarios:
  1. a sectioned ticket runs through `conductor` v3, and the agent reports `verification`;
  2. checks are persisted with durations;
  3. the reviewer grades the FRs;
  4. a QA post and a sign-off update the tally;
  5. PATCH edits the body, and the running agent is told;
  6. `GET …/prompt` returns the re-rendered prompt with the output tail omitted.
- A free-form ticket behaves exactly as before (regression scenario).
- The UX-2 Brief card and UX-3 editor use the shared parser, the editor can edit, and the template round-trips (TD-116 paid if it was opened).
- ADR-0019 accepted with implementation notes; the M3 tool outline mentions sections and evidence.

**Not in M2c**:
- requirement grades gating transitions (ADR-0019 §4: opt in with a review item);
- an exact stored prompt (U-039);
- structured requirement forms;
- triage checking a ticket's sections (M4);
- the live-spend investigation (U-079, a separate spike).

**Blocking unknowns**: none. U-045 (model text in Postgres) covers the claim's `evidence` text the same way it covers `ask_user` questions: ≤ 1 000 characters, model text, not terminal output. Noted, not blocking.

## Task board

| ID | Task | Depends on | Group | Migration | Status |
|---|---|---|---|---|---|
| M2c-T01 | **Contracts**: `PatchTicketRequest`, `SessionPromptDto`, verification DTOs and routes, `BoardCard.verification`, `complete_state.verification`, reviewer verdict `requirements`, `record_evidence` / `record_check_run` effects; 10-contracts §Requirements and verification | M2-T20 | A | — | todo |
| M2c-T02 | Shared: `parseTicketBody`, `requirementStatus`, `tallyRequirements` (pure) | M2-T20 | A | — | todo |
| M2c-T03 | Migration: `ticket.requirements`, `requirement_evidence`, `check_run`; row types; backfill `requirements` from existing bodies | T01, T02 | B | **yes** | todo |
| M2c-T04 | Shared engine (apply): claims from `complete_state`, `check_run` records from every check exit, reviewer `requirements` grades → effects | T01 | B | — | todo |
| M2c-T05 | Shared engine (render): `## Requirements` + reporting instructions; reviewer prompt `## Ticket requirements`; `conductor` v3 prompt lines | T01, T02 | B | — | todo |
| M2c-T06 | Daemon: `complete_state.verification` on the outcome server; reviewer verdict pass-through | T01 | B | — | todo |
| M2c-T07 | Orchestrator: ticket create / PATCH parse and store `requirements`, `ticket.updated` event and live notice; `GET /api/sessions/:id/prompt` | T03, T05, M2-T21 | C | — | todo |
| M2c-T08 | Orchestrator: evidence persistence in the wrapper, `POST /api/tickets/:id/verification` (QA, sign-off), `GET …/verification`, board tally; `conductor` v3 seed | T03, T04, M2-T21 | C | — | todo |
| M2c-T09 | Web: shared parser in the Brief card and the editor, edit mode (PATCH), Verification tab, card tally, sign-off, View prompt on the route | T01, T02 | B | — | todo |
| M2c-T10 | E2E: the six scenarios plus the free-form regression | T06, T07, T08, T09 | D | — | todo |
| M2c-T11 | Docs sweep (02, 03, 05, 06, 10; ADR-0019 notes; ticket-writing guide `docs/setup/writing-tickets.md`) | T10 | E | — | todo |

T07 and T08 both touch `src/api/index.ts` registration lines only (different lines; trivial merge), and T08 owns `engine/service.ts`. The web lane (T09) needs only the contracts and the mock.

**Shared files with section ownership**: `shared/src/engine/apply.ts` T04 only; `render.ts` T05 only; `shared/src/api/rest.ts` T01 only (later tasks report changes); `engine/board-view.ts` T08 only; the ticket-create handler in `api/index.ts` T07 only.

---

## Task details

### M2c-T01 · Contracts
- **Scope.** Additive only.
  - **`shared/src/api/tickets.ts`** (new):
    - `PatchTicketRequest {title?, body?, kind?, expected_updated_at}`;
    - `TicketDto` gains `requirements: ParsedRequirement[]` and `body_warnings: string[]`;
    - `SessionPromptDto {state, prompt, reconstructed: true, rendered_from: {ticket_updated_at, workflow_version}, omitted: string[]}`;
    - `VerificationPostRequest {layer: 'review' | 'sign_off', source: 'qa' | 'human', entries: [{req, status, evidence}], verdict?, notes?}`;
    - `RequirementEvidenceDto`, `CheckRunDto`, `TicketVerificationDto {requirements: [{req, kind, text, status, layers: {claim?, check?, review?, sign_off?}}], check_runs: CheckRunDto[], qa: …}`.
  - **`rest.ts`**:
    - `API_PATHS.ticket(id)` (PATCH), `ticketVerification(id)`, `sessionPrompt(id)`;
    - `BoardCard.verification?` (ADR-0019 §3);
    - the error code `conflict` reused for a stale `expected_updated_at`.
  - **`engine/types.ts`**:
    - `complete_state.verification?` (≤ 50 entries, evidence ≤ 1 000 characters);
    - the review verdict gains `requirements?: [{req, met, reason}]`;
    - effects `record_evidence {entries}` and `record_check_run {run}`;
    - the event `ticket.edited {requirements}` (so a running session's snapshot sees the new list).
  - **`protocol/ws.ts`**: the outcome tool schema for `complete_state` gains `verification` (the daemon passes it through).
  - Fixtures for each.
  - **10-contracts §Requirements and verification** (new): the routes, status codes, layers, the status rule, the tally, the reconstruction note.
- **Design refs**: ADR-0019; ADR-0011 (complete_state); ADR-0009 (verdict).
- **Depends on**: M2-T20 merged (apply and the wrapper are settled).
- **Files owned**: `shared/src/api/tickets.ts` (new), the additions in `api/rest.ts`, `engine/types.ts`, `engine/fixtures.ts`, `protocol/ws.ts`, `protocol/fixtures.ts`, one export line, 10-contracts §Requirements and verification.
- **Do not touch**: `apply.ts`, `render.ts`, `tickets/body.ts` (T02), other packages.
- **Acceptance**:
  - [ ] `api/tickets.test.ts`, `engine/verification.types.test.ts`: every fixture parses; a `complete_state` without `verification` and a verdict without `requirements` still parse; evidence of 1 001 characters is refused.
  - [ ] An interface-review agent confirms T03–T09 can be built from these contracts.
  - [ ] Ben approves the 10-contracts diff.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2c-T02 · Shared: body parser and status rules
- **Scope.** `packages/shared/src/tickets/body.ts` and `tickets/verification.ts` (new, pure):
  - `parseTicketBody(md)` (ADR-0019 §1): lenient, with warnings;
  - `TICKET_BODY_TEMPLATE` (the six sections, for the editor and the API docs);
  - `requirementStatus(evidence[])` and `tallyRequirements(reqs, evidence, checkRuns, qa)` (ADR-0019 §2–§3).
- **Depends on**: M2-T20 (the timing only; it uses no M2 code).
- **Files owned**: `shared/src/tickets/{body,verification}.ts` (+ tests), one export line.
- **Do not touch**: everything else (`tickets/graph.ts` is M2b's).
- **Acceptance**:
  - [ ] `tickets/body.test.ts`:
    - the template parses to six sections and no requirements;
    - a full example gives FR-1..3 and NFR-1 with their verification methods;
    - headings match case-insensitively;
    - a free-form body gives no requirements and no warnings;
    - duplicate ids and unknown Verification ids give warnings;
    - an underscore-heavy body (the UX-1 bug's input) parses text intact.
  - [ ] `tickets/verification.test.ts`: the status rule's cases (claim only → `claimed`; a check `met` → `verified`; a later review `not_met` → `failed`; a newer `met` in the same layer clears it; a sign-off requirement isn't `verified` without its sign-off); the tally string inputs.
  - [ ] `tickets/body.property.test.ts`: parse never throws on arbitrary strings (fast-check, 1 000 runs).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2c-T03 · Migration
- **Scope.** `<ts>_requirements-verification.sql`:
  - `ticket.requirements jsonb NOT NULL DEFAULT '[]'`;
  - `requirement_evidence` and `check_run` as in ADR-0019 §2, with `account_id NOT NULL REFERENCES account`, an index on `(ticket_id, req_id, layer, created_at DESC)` and one on `check_run (session_id, started_at)`;
  - a backfill: a companion script `scripts/backfill-ticket-requirements.ts` run by the migration's release step, or on orchestrator start (document which), that parses existing bodies with `parseTicketBody`.

  Add the row types, schema tests and 02 sections.
- **Depends on**: T01, T02.
- **Files owned**: the migration, the backfill script, `db/types.ts` (the new rows), `test/schema*.test.ts`, 02 (the new sections).
- **Do not touch**: `src/api/**`, `src/engine/**`, `shared/**`.
- **Migration**: **yes**. Ben approves.
- **Acceptance**:
  - [ ] Migration up, down, up on a database with M2 rows; the backfill gives every existing sectioned ticket its requirements and leaves free-form ones `[]`.
  - [ ] The schema-isolation test passes with the new tables.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2c-T04 · Shared engine: evidence effects
- **Scope.** In `shared/src/engine/apply.ts` and a new `engine/evidence.ts`:
  - `agent.complete_state` with `verification`: the entries are checked against the snapshot's requirement ids (unknown ids dropped, with a `debug` note) and emitted as one `record_evidence` effect (layer `claim`, source `agent`, ref = state and transition). The transition is planned exactly as today, whatever the claims say.
  - Every check exit in a gate step (pass, fail, timeout, refused, uncommitted) → `record_check_run` (name, cmd, result, exit code, `duration_ms`, `head_sha`, label). A check named by a Verification line also gets `record_evidence` (layer `check`).
  - The reviewer's verdict `requirements` → `record_evidence` (layer `review`, source `reviewer`). The gate decision is unchanged (ADR-0019 §4).
  - `ticket.edited` updates the snapshot's requirement list. There is no transition.
- **Depends on**: T01.
- **Files owned**: `shared/src/engine/{apply.ts, evidence.ts}` (+ tests).
- **Do not touch**: `render.ts`, `types.ts`, other packages.
- **Acceptance**:
  - [ ] `engine/apply.evidence.test.ts`:
    - a `complete_state` with three claims and one unknown id → one `record_evidence` with three entries and the same transition as without them;
    - each check result kind → one `record_check_run` with its duration;
    - a reviewer verdict with `requirements` → review evidence, and the gate's routing is identical with and without the field;
    - `ticket.edited` changes no status.
  - [ ] `apply.property.test.ts` stays green at 1 000 runs with the new fields.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2c-T05 · Shared engine: prompts
- **Scope.**
  - `render.ts`: `## Requirements` (FR, NFR, Verification plan, Out of scope) for sectioned tickets, and the "Report against each requirement in `verification`" paragraph in `## How to finish` / "When you are done".
  - `review.ts`: `## Ticket requirements` in the reviewer prompt, and the verdict instructions for `requirements`.
  - `workflow/conductor.ts` + `docs/design/workflows/conductor.v3.json`: `conductor` v3 = v2 + the one-line instruction in `planning` and `implementing`. The seed rule is unchanged; T08 seeds it.
- **Depends on**: T01, T02.
- **Files owned**: `shared/src/engine/{render.ts, review.ts}`, `shared/src/workflow/conductor.ts`, `docs/design/workflows/conductor.v3.json`, their tests.
- **Do not touch**: `apply.ts`, other packages.
- **Acceptance**:
  - [ ] `engine/render.requirements.test.ts`: a sectioned ticket's prompt lists FR-1..n with ids and the reporting instruction; a free-form ticket's prompt is byte-identical to before (snapshot); the reviewer prompt lists the requirements.
  - [ ] `conductor.v3.json` passes the validator (`validateWorkflow`) and `python3 -m json.tool`.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2c-T06 · Daemon: verification pass-through
- **Scope.** The outcome MCP server's `complete_state` accepts `verification` (T01's schema) and forwards it in the `session_event`. The reviewer's `complete_state` forwards a verdict's `requirements` unchanged. Size limits are enforced with a clear tool error (not a silent drop).
- **Depends on**: T01.
- **Files owned**: `packages/daemon/src/claude/outcome-server.ts` (the `complete_state` schema), its tests.
- **Do not touch**: `workspace.ts`, `inventory/**`, `actions/**`, other packages.
- **Acceptance**:
  - [ ] `outcome-server.verification.test.ts`: `verification` reaches the session_event; 51 entries → a tool error naming the limit; no `verification` → unchanged behaviour.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2c-T07 · Orchestrator: ticket edit and the prompt view
- **Scope.**
  - The ticket-create handler parses the body and stores `requirements`; the response carries `body_warnings`.
  - `PATCH /api/tickets/:id`, scoped (M2-T21):
    - optimistic concurrency on `expected_updated_at` (409 `conflict`);
    - refused for `done` / `cancelled` tickets (409);
    - re-parse and store, then an `event` row `ticket.updated` and `applyEvent(ticket.edited)` on the live session, in one transaction;
    - for a running agent, a `send_message` notice through the ADR-0007 path (`operator.message` from `system`).
  - `GET /api/sessions/:id/prompt?state=`: re-render with `renderPrompt` from the snapshot, the pinned definition and the current ticket; the output attachment is replaced; the response is labelled (ADR-0019 §6). 404 for another account's session.
- **Depends on**: T03, T05, M2-T21.
- **Files owned**: `src/api/tickets.ts` (new: create, PATCH), `src/api/prompt.ts` (new), their registration lines and the moved create handler in `src/api/index.ts`, `test/api.tickets-edit.test.ts`, `test/api.prompt.test.ts`.
- **Do not touch**: `engine/**`, `gateway/**`, `auth/**`, `shared/**`.
- **Acceptance**:
  - [ ] `test/api.tickets-edit.test.ts`:
    - PATCH with the right `expected_updated_at` updates the body and `requirements`;
    - a stale one → 409 and nothing changes;
    - a `done` ticket → 409;
    - a running session gets one `send_message` notice and a `ticket.updated` event;
    - account B → 404.
  - [ ] `test/api.prompt.test.ts`: the prompt for the current state contains the ticket's FR lines; an attached output tail is replaced with the omission marker; `reconstructed: true`; another account → 404.
  - [ ] The M2 route matrix includes both routes.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2c-T08 · Orchestrator: evidence persistence and tally
- **Scope.**
  - `engine/service.ts`: the wrapper writes `record_evidence` / `record_check_run` effects into `requirement_evidence` / `check_run` in the apply transaction, scoped.
  - `src/api/verification.ts`:
    - `POST /api/tickets/:id/verification` (layer `review` + source `qa`, or `sign_off` + source `human`; `actor` = the user);
    - `GET /api/tickets/:id/verification` (`TicketVerificationDto`).
  - `engine/board-view.ts`: `BoardCard.verification` from `tallyRequirements`, and a `card.upserted` after each evidence write.
  - `engine/seed.ts`: seed `conductor` v3 under the per-account upgrade rule.
- **Depends on**: T03, T04, M2-T21.
- **Files owned**: `src/engine/{service.ts (evidence writes), board-view.ts (tally), seed.ts (v3)}`, `src/api/verification.ts` (+ its registration line), `test/engine/evidence.test.ts`, `test/api.verification.test.ts`.
- **Do not touch**: `api/tickets.ts`, `api/prompt.ts` (T07), `gateway/**`, `shared/**`.
- **Acceptance**:
  - [ ] `test/engine/evidence.test.ts`:
    - a `complete_state` with claims writes rows in the same transaction as the state change (a failure injected after apply leaves neither);
    - a check exit writes a `check_run` with its duration and no output;
    - the card tally updates.
  - [ ] `test/api.verification.test.ts`:
    - a QA post with `verdict: 'pass'` shows `QA pass` on the card;
    - a sign-off by a user makes a `sign_off` requirement `verified`;
    - a non-member → 404;
    - an evidence row is never updated (append-only, checked by row counts).
  - [ ] `test/engine/seed.test.ts`: an unedited v2 upgrades to v3; an edited one doesn't.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2c-T09 · Web: sections, editing and the Verification tab
- **Scope.** Against T01's contracts and the mock. This builds on UX-1..3, which are merged by then.
  - The Brief card (UX-2) and the editor (UX-3) use `parseTicketBody` and `TICKET_BODY_TEMPLATE` from shared; any local parser is deleted (pays TD-116).
  - **Edit mode**: "Edit" on the detail panel opens the editor with the current body and saves with PATCH and `expected_updated_at`. A 409 shows "Someone else edited this ticket" with a reload.
  - The template round-trips through BlockNote: the sections and the `**FR-n**` markers survive load and save, and a body that doesn't round-trip opens in a plain markdown box.
  - The detail panel gets a **Verification tab**: one row per requirement with four layer cells, plus the `check_run` history with durations. "Sign off" applies to `sign_off` requirements.
  - The card shows the **tally** ("FR 6/6 · NFR 3/4 · checks ✓ · QA pass"; red when failed, "+n claimed").
  - View prompt (UX-2) calls the real route and shows the "reconstructed, output omitted" note.
- **Depends on**: T01, T02.
- **Files owned**: `packages/web/src/tickets/**` (the editor and the Brief card, where UX-2 and UX-3 put them), `packages/web/src/verification/**` (new), the tally in `components/Board.tsx`, the ticket / verification / prompt parts of `web/src/api/{client,http,mock}.ts`, their tests.
- **Do not touch**: `web/src/auth/**`, `web/src/machines/**`, `web/src/dependencies/**`, other packages.
- **Acceptance**:
  - [ ] `tickets/Editor.roundtrip.test.tsx`: the template and a full example survive load → save byte-equivalently (modulo trailing whitespace); an unsupported construct falls back to the plain box.
  - [ ] `tickets/EditTicket.test.tsx`: save sends `expected_updated_at`; a 409 shows the conflict message.
  - [ ] `verification/VerificationTab.test.tsx`: the layers render per requirement; sign-off posts; the check runs show durations.
  - [ ] `components/Board.tally.test.tsx`: the tally string for a mock card; absent for a free-form ticket.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2c-T10 · E2E
- **Scope.** `e2e/m2c.e2e.test.ts` (password mode). The fake `claude` gains `verification` in its scripted `complete_state`, and the fake reviewer gains `requirements`. It covers the six exit-criteria scenarios and the free-form regression.
- **Depends on**: T06, T07, T08, T09.
- **Files owned**: `e2e/m2c.e2e.test.ts`, additive harness helpers, the additive fake-claude script fields.
- **Acceptance**:
  - [ ] `pnpm test:e2e` green, 3 consecutive runs.
  - [ ] Gates: all, including `pnpm test:e2e`.

### M2c-T11 · Docs
- **Scope.**
  - Update 02, 03, 05, 06 and 10 to what was built, and add ADR-0019 implementation notes.
  - Write **`docs/setup/writing-tickets.md`**: the section convention with a full example, how to write Verification lines, and what the tally means.
  - In CLAUDE.md and the M-file conventions, point the lead's ticket blocks at the convention.
- **Depends on**: T10.
- **Files owned**: `docs/design/**`, `docs/adr/0019*` (notes), `docs/setup/writing-tickets.md`.
- **Acceptance**:
  - [ ] A QA agent finds no doc/code contradiction.
  - [ ] Every link resolves.

---

## Risks
- **BlockNote's markdown round trip is lossy.** Mitigation: markdown stays the source of truth, a round-trip test runs on the template, and a plain-markdown fallback opens anything that doesn't round-trip.
- **Agents may over-claim.** Mitigation: a claim never counts as verified; the card separates "claimed" from "verified".
- **Evidence text is model text in Postgres** (U-045 class). Mitigation: a 1 000-character cap, no command output, and U-045 stays tracked.
- **The re-rendered prompt can differ from what the agent got** (the ticket was edited since, or the output was omitted). Mitigation: the response says it is reconstructed and from which ticket version.
- **Overlap with M2's tail.** Mitigation: the shared and web tasks start after M2-T20, and the orchestrator tasks after M2-T21, so file ownership never overlaps.
