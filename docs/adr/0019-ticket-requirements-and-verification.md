# ADR-0019 · Ticket requirements and verification

- **Status**: accepted (Ben, 2026-10-27; PR #6)
- **Date**: 2026-10-27
- **Deciders**: Ben (design review 2026-10-27, relayed by the lead) (+ Claude planner session https://claude.ai/code/session_01NhmNbZ2iRArH99MxNSABmj)
- **Resolves**: nothing yet. Raises U-079 (live spend; related).
- **Builds on**: [ADR-0009](0009-transition-requirements-review.md) (the reviewer), [ADR-0010](0010-one-workflow-columns-are-states.md) (checks in a fresh checkout), [ADR-0011](0011-transition-rules.md) (`complete_state {transition, reason, result}`), [ADR-0003](0003-postgres-outbox-no-kafka.md) and U-039 (no raw terminal output in Postgres; prompts are scrubbed).

## Context
Ben's design review, 2026-10-27:
- A ticket body is free text today. Agents read it however they like. The only things that check the result are a workflow's fixed check commands and review items, and the card shows a transient badge while checks run.
- Whether a ticket's *own* requirements were met lives only in a GitHub PR description or in the lead's QA notes.

Ben's decisions:
- Ticket bodies use markdown sections: **Goal / Context / Functional requirements (FR-n) / Non-functional requirements (NFR-n) / Out of scope / Verification** (each FR and NFR mapped to how it is proved).
- They are written in a WYSIWYG editor (BlockNote or similar).
- The web-only parts are running now as tickets UX-1 (thread grouping, phase dividers, a markdown underscore bug), UX-2 (a Brief card with the parsed sections, plus View prompt) and UX-3 (a BlockNote create-ticket editor with the section template).

This ADR makes those sections the **ticket contract** and defines how each requirement's status is established and shown.

Engine invariants bind every choice here: transitions only on outcomes; every loop bounded; every failure path ends at a human; state and commands in one transaction; idempotency keys on external side effects.

## Decision

### 1 · The ticket body convention
The body stays **markdown**, and the markdown is the source of truth. The editor is a view of it; nothing is stored as editor blocks. The recognised sections are H2 headings, matched case-insensitively:

```markdown
## Goal
One or two sentences.

## Context
Why, links, constraints.

## Functional requirements
- **FR-1** The card shows "blocked by #…" for every unmet dependency.
- **FR-2** …

## Non-functional requirements
- **NFR-1** The claim query stays under 5 ms on 10 000 tickets.

## Out of scope
- …

## Verification
- FR-1: test `Board.dependencies.test.tsx`
- FR-2: check "Tests pass"
- NFR-1: review
- FR-3: sign-off
```

- **`parseTicketBody(md)`**, a pure function in `packages/shared/src/tickets/body.ts`, returns `{sections: {goal, context, functional, non_functional, out_of_scope, verification}, requirements: [{id: 'FR-1', kind: 'functional' | 'non_functional', text, verification: {method: 'test' | 'check' | 'review' | 'sign_off' | 'manual', ref?: string} | null}], problems: string[]}`.
  - It is lenient. A body without these sections is a **free-form ticket**: no requirements and no tally, behaving exactly as today.
  - `problems` lists warnings, never errors: duplicate ids, a Verification line for an unknown id, a requirement with no Verification line, ids out of order. Create and edit return them as `warnings`.
- **The UX tickets' local parsing** (UX-2's Brief card) moves onto this shared parser in M2c-T09, so the web and the server never disagree about what a requirement is. That is TD-116, if UX-2 ships its own parser before then.
- **The editor** (UX-3, BlockNote): it loads the markdown into blocks and saves blocks back to markdown. BlockNote's markdown export is lossy for some constructs, so the template's sections and the `**FR-n**` markers must survive a round trip (a test in M2c-T09), and a body the editor can't round-trip opens as plain markdown instead.
- **Ticket edit**: `PATCH /api/tickets/:id {title?, body?, kind?, expected_updated_at}`.
  - A stale `expected_updated_at` → 409 `conflict`.
  - It re-parses the body, stores `ticket.requirements` (a cached parse, jsonb), and writes an `event` row `ticket.updated` (who, when, a hash of the old and new body) on the ticket's live session if there is one, else with a null session.
  - A running agent is told through ADR-0007's `send_message` ("The ticket was edited; re-read ## Functional requirements …"). Nothing else changes: an edit never transitions anything.
  - Allowed while the ticket isn't `done` or `cancelled`.

### 2 · Four layers of evidence per requirement
Each requirement's status is built from layers. Every layer is recorded **append-only**: rows are never updated, and the current status is the latest row per (requirement, layer).

| Layer | Who | How it's recorded |
|---|---|---|
| **claim** | the agent | `complete_state` gains `verification?: [{req: 'FR-1', status: 'met' \| 'not_met' \| 'partial' \| 'not_applicable', evidence: string ≤ 1 000}]` (≤ 50 entries). apply validates it against the ticket's requirement ids: unknown ids are dropped, with a note on the timeline. It is never a reason to fail a transition. It is recorded with the session, state and transition. |
| **check** | conductor | Every check that conductor runs (entry and move steps, ADR-0010/0011) is persisted as a `check_run`: name, command, pass / fail / timeout / refused, `exit_code`, `duration_ms` (already in `cmd_exit`), `head_sha`, the step label, `started_at`. **No output** is stored (ADR-0003): the output tail stays in the transcript and in the unmet question. A check named in a Verification line (`check "Tests pass"`) counts as evidence for that requirement. |
| **review** | conductor's reviewer (ADR-0009/0010), or an external QA | The reviewer's prompt gains the ticket's requirements, and its verdict gains `requirements: [{req, met, reason}]` next to the workflow's own `verdict` items (§4). An external QA (the lead's `qa-reviewer` today, the M3 tools later) posts findings with `POST /api/tickets/:id/verification {layer: 'review', source: 'qa', entries: [{req, status, evidence}], verdict?: 'pass' \| 'pass_with_debt' \| 'fail', notes?}`, so the QA result lives on the ticket and not only in a GitHub PR. |
| **sign-off** | a human | A requirement whose Verification line says `sign-off` needs a human click ("Sign off FR-3", optional note) on the card or the detail panel: `POST /api/tickets/:id/verification {layer: 'sign_off', entries: [{req, status: 'met' \| 'not_met', evidence: note}]}`, with `actor` = the user (U-042). |

**Storage**: one append-only table, **`requirement_evidence`** `(id, account_id, ticket_id, session_id null, req_id, layer: claim | check | review | sign_off, source: agent | reviewer | qa | human | check, status, evidence text ≤ 1 000, ref jsonb (check_run id, transition, state, verdict id), actor, created_at)`, plus **`check_run`** `(id, account_id, session_id, step_label, name, cmd, result, exit_code null, duration_ms, head_sha null, started_at, finished_at)`, plus **`ticket.requirements jsonb`** (the cached parse). Engine effects carry the records, and the EngineService wrapper writes them in the apply transaction, so state and evidence commit together, the same as outbox rows. apply stays pure: it emits `record_evidence` / `record_check_run` effects and does no I/O. A migration is needed (M2c-T03).

**The status of one requirement** (`requirementStatus(evidence)`, pure, shared):
- `failed`: the latest review, check or sign-off row says `not_met` / fail (a newer `met` in the same layer clears it);
- `verified`: at least one independent layer (check, review or sign-off) says `met` and none says `not_met`. A `sign_off` requirement needs its sign-off row to be verified;
- `claimed`: only the agent's claim says `met`;
- `open`: nothing yet, or the claim says `not_met` / `partial`.

### 3 · The card tally
- A card of a ticket with requirements shows **`FR 6/6 · NFR 3/4 · checks ✓ · QA pass`**:
  - FR and NFR count `verified`, out of the total. A `failed` requirement turns its count red, and `claimed` ones show as a lighter "+2 claimed";
  - `checks` is the latest step's `check_run` results (✓ all passed, ✗ one failed, … running);
  - `QA` is the latest review-layer verdict (the reviewer's all-met, or the QA post's `verdict`).
- The detail panel has a **Verification** tab: one row per requirement with its four layers (status, evidence, who, when, the check's duration), plus the `check_run` history, so these runs no longer exist only as a transient badge.
- `BoardCard.verification?: {fr: {verified, claimed, failed, total}, nfr: {…}, checks: 'passed' | 'failed' | 'running' | null, qa: 'pass' | 'pass_with_debt' | 'fail' | null}`. It is absent for free-form tickets.

### 4 · The reviewer grades requirements
- When a gate step with `review` runs (ADR-0009 transition review, ADR-0010 entry review, ADR-0011 move review) and the ticket has requirements, `renderReviewPrompt` adds `## Ticket requirements` (the FR and NFR lines and their Verification lines). The verdict schema gains `requirements: [{req, met, reason}]`.
- **The workflow's items still decide the gate**, exactly as now: unmet items → `on_unmet` (counted), and so on. The per-requirement grades are **recorded** (review layer), but they don't move the session.
  - Making a requirement grade gate the transition would change the meaning of every existing workflow.
  - A workflow that wants it adds the review item "Every FR is met (see Ticket requirements)". That is a workflow edit, not engine behaviour.
- A verdict without `requirements` is still valid (old reviewers, free-form tickets).

### 5 · Prompts
- `render.ts`: an agent prompt for a ticket with requirements gets `## Requirements`, which shows the parsed FR and NFR list with ids, the Verification plan, and the Out of scope list. `## How to finish` gains: "Report against each requirement in `verification`: `met` / `not_met` / `partial` / `not_applicable` with one line of evidence (a test name, a command and its result, a file). Don't claim `met` without evidence."
- Free-form tickets render as today (snapshot test).
- The `conductor` workflow's `implement_template` and `planning` prompts get one line, "Read the ticket's sections; your plan and your work are judged against FR-n / NFR-n", in a new `conductor` v3 seed. This follows the ADR-0011 per-account upgrade rule (M2-T12): unedited copies upgrade, edited ones keep their version.

### 6 · View prompt (UX-2's need)
- No route exposes a session's prompt today, and none can return it exactly. `start_session.prompt` is **scrubbed** when its outbox row turns terminal (U-039), because it can carry a command output tail.
- So `GET /api/sessions/:id/prompt?state=<agent state>` (default: the current agent state, else the last one) **re-renders** the prompt with the same pure `renderPrompt`, from the session's current snapshot, the pinned workflow version and the ticket as it is now. Any `attach: output` tail is replaced with `[command output omitted: see the transcript]`.
- The response says so: `{state, prompt, reconstructed: true, rendered_from: {ticket_updated_at, workflow_version}, omitted: ['attachment_output']}`.
- It is close enough for a human to read what the agent was told, and it keeps U-039's rule. Storing an exact copy would put raw output back into Postgres.

## Alternatives considered
| Option | Why not |
|---|---|
| Store the body as editor JSON (BlockNote blocks) | Locks the data to one editor; agents, the API, MCP and git-friendly tooling all want markdown |
| Separate structured requirement rows edited in a form | Heavier UI and API. Ben chose a markdown convention plus a WYSIWYG editor, and the parser gives the same structure |
| Requirement grades gate transitions by default | Changes every existing workflow's behaviour; a review item opts in instead |
| Store the exact rendered prompt | Re-introduces raw output into Postgres (U-039); a labelled re-render is enough to read |
| Mutable status columns per requirement | Loses who said what and when; append-only evidence is the audit trail the card summarises |
| Record QA only in the GitHub PR | Ben's point: the board should show it, and not every ticket has a PR |

## Consequences
- Good: every ticket with sections carries its own definition of done, and the board shows how far each requirement is proved and by whom, with check runs kept.
- Good: no change to how transitions fire; agents, reviewers, QA and humans add evidence alongside.
- Bad / accepted cost: a migration (two tables, a column); `complete_state` and the reviewer verdict gain optional fields; a `conductor` v3 seed; a re-rendered (not exact) prompt view.
- Bad / accepted cost: agent claims are self-reported. They are shown as "claimed", never as "verified".
- Follow-ups: [M2c](../plan/milestones/M2c-requirements-verification.md); TD-116 if UX-2's parser lands first; M3's `create_ticket` / `get_ticket` tools carry the sections and the evidence; M4 triage can check that a new ticket has FRs and a Verification section.

## Revisit when
- Teams want requirement grades to gate transitions without editing workflows (a workflow-level `requires.requirements: all_verified`).
- Bodies drift from the convention often enough that a structured form beats the parser.
- The re-rendered prompt misleads someone (it shows something the agent never got).
