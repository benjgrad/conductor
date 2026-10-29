# M2r · Review and merge (ADR-0020)

> **Proposed 2026-10-27** (branch `docs/adr-0020-review-merge`). Ben approved the design the same day and asked for it **next, before the early you-only deploy**, so the hosted instance runs it. [ADR-0020](../../adr/0020-review-and-merge-flow.md) is proposed, and Ben approves this file before work starts.

**Goal** ([ADR-0020](../../adr/0020-review-and-merge-flow.md)):
- After the PR opens, a ticket goes to **In QA**: conductor runs an independent QA session on a fresh checkout of the exact PR commit. Its outcomes are `qa_pass` → Ready to merge; `qa_fail` → Implementing with the findings (≤ 3 rounds, then a human); and `qa_needs_human`.
- **Ready to merge** offers only **Merge** (conductor merges, pinned to the reviewed commit, behind a migration approval when the diff has migrations) and **Request changes**.
- **Done** is reachable only through a merge or "Close without merging" with a reason.

**Placement**:
- **Before the early you-only deploy** (Ben, 2026-10-27). It runs alongside the M2 critical path (T14, T15a, T17, T07b), and the deploy waits for M2r-T11.
- **Before M2c.** M2c-T05's prompt-line version becomes **conductor v4**, and M2c-T04 maps the QA result onto the review evidence layer (ADR-0020 §7).
- **No DB migration.** State lives in `context` jsonb, actions use the existing `run_action` outbox kind, and event payloads are jsonb.

**Exit criteria**:
- Every task `done` and QA'd. `pnpm test:e2e` is green with M2r-T11's scenarios:
  1. pass → Merge → Done `merged`;
  2. fail → fix → pass;
  3. three fails → Needs input;
  4. head moved → re-QA;
  5. conflict → Implementing;
  6. the migration gate (409 without the approval, merges with it);
  7. Close without merging;
  8. already merged on GitHub → Done;
  9. PR closed on GitHub → Needs input;
  10. a v2 regression.
- `conductor` v3 is seeded (an unedited v2 upgrades), and `conductor_dev` v3 is posted to the pinned board, ready to post to the hosted instance at deploy.
- Ben merges at least one real dogfood PR with the Merge button.
- CLAUDE.md §2–3 describe conductor's QA and merge for ticket work. ADR-0020 is accepted with implementation notes, and U-083 is resolved.

**Not in M2r**:
- squash or rebase merges, merge queues, `gh pr merge --auto`;
- deleting merged branches and worktree GC (M2-T13);
- running actions on any online machine of the account (U-091; M2 routing);
- closing the GitHub PR on operator cancel;
- GitHub webhooks for merges made outside conductor (M5);
- requirement grades gating the merge (ADR-0019 §4: a review item opts in);
- writing tracking rows automatically (they stay human-curated).

**Blocking unknowns**:
- **None block A–C.** U-085..U-091 (below) each have a proposed default the tasks build to. Ben confirms or changes them when he accepts ADR-0020; a changed default is a small, local edit.
- U-090 (In QA for work tickets) changes only M2r-T10's definition, so it must be answered before T10 merges.

## Task board

| ID | Task | Depends on | Group | Hot-swap to the pinned board | Status |
|---|---|---|---|---|---|
| M2r-T00 | **Lead (no ticket)**: interim `conductor_dev` version on the pinned board, data only (ADR-0020 §11) | — | now | **yes** (it is the hot-swap) | todo |
| M2r-T01 | **Contracts**: schema fields, `QaResult`, action args and results, WS / engine / REST / card fields; 10-contracts §Review and merge | — | A | no | done (PR #40, 61e2696) |
| M2r-T02 | Shared: validator rules for the new fields (rule 15 Done-only-via-merge), the `qa` tool alias | T01 | B | no | done (PR #55, a76c9ce) |
| M2r-T03 | Shared engine: the QA state (`role: qa` start, fencing, `__qa`, result checks and nudge, the counted `qa_fail` loop, `attach: 'result'`, counter reset) | T01 | B | no | in_review (PR #56) |
| M2r-T05 | Daemon: `inspect_pr`, `merge_pr`, `close_pr` (gh only, hardened, idempotent) | T01 | B | no | todo |
| M2r-T06 | Daemon: the QA start in a fresh checkout of the PR head (`start_session.checkout`, `qa-base`, setup, forced dontAsk) | T01 | B | no | todo |
| M2r-T07 | Shared engine: the `qa_template` prompt | T01 | B | no | todo |
| M2r-T09 | Web: In QA and Ready to merge cards, Merge and the migration approval, Request changes, Close without merging, the QA tab, Done badges | T01 | B | no | todo |
| M2r-T04 | Shared engine: the merge path (approvals gate, `inspect_pr` / `merge_pr` / `close_pr` results, `on_unmet.routes`, `__pr.merged` / `closed`, the Done guard) | T03 | C | no | todo |
| M2r-T10 | Definitions: `conductor` v4 (`CONDUCTOR_V4` + JSON; v3 went to ADR-0025 / M2-T31a, build on it) and `conductor_dev.v3.json` | T02, U-090 | C | JSON only (posted by the lead after T11) | todo |
| M2r-T08 | Orchestrator: the transition route's `approvals` (409 `approval_required`), card and detail fields, the v3 seed | T04, T10 | D | no | todo |
| M2r-T11 | E2E: the ten scenarios with the fake gh and fake Claude | T05, T06, T07, T08, T09 | E | — | todo |
| M2r-T12 | Docs: 05, 06, 10, ADR-0020 notes, CLAUDE.md §2–3, M2c notes | T11 | F | — | todo |

IDs follow the ADR's order of concerns; groups decide the order of work. Each task (except T00) is sized for **one conductor ticket** (≲ 400 lines changed, one package).

**Shared files with section ownership**:
- `shared/src/engine/apply.ts`: T03, then T04. Both keep their logic in new modules (`engine/qa.ts`, `engine/merge.ts`) and add only routing lines to `apply.ts`.
- `render.ts`: T07 adds one dispatch line; T03 adds the `attach: 'result'` section. They touch different functions, so the merge is trivial.
- `shared/src/workflow/schema.ts`, `api/rest.ts`, `engine/types.ts`, `protocol/ws.ts`: T01 only. Later tasks report needed changes.
- `daemon/src/daemon.ts`: T05 adds the `run_action` dispatch lines and T06 the start path. Different functions.
- `orchestrator/src/engine/seed.ts`: T08. M2-T12 (per-account seeding) also edits it; whichever lands second rebases.

**Interactions with M2** (the same files):
- M2-T26 (Retry a failed move step) edits `apply.ts` / `move-step.ts`, so run it after M2r-T04.
- M2-T20 and M2-T19 edit orchestrator `engine/**`; M2r-T08 touches only `board-view.ts`, `seed.ts` and the transition handler, so M2r goes first.
- M2r doesn't touch the you-only critical path's files (T14 distribution, T15a admin CLI, T17 machines REST, T07b): only the `api/index.ts` transition handler, which none of them own.

**Hot-swap and deploy order** (recommendation):
1. **Now: M2r-T00 on the pinned board.** The data-only interim stops Done-before-QA immediately. It adds In QA (a plain agent state), Ready to merge with "Merged on GitHub" gated by the `pr_merged` condition, and "Close without merging".
2. **No code cherry-picks to `board-pinned`.** It is the M1b build plus UX tickets, about 25 000 lines behind `main`. M2r's engine changes build on M2's `apply.ts`, so cherry-picks would conflict and give a third code line to QA.
3. **Group A, then B in parallel** (six tickets) alongside the M2 critical path. Then C, D, E, F.
4. The **early deploy** waits for M2r-T11 (e2e green). The hosted instance starts with a fresh database (U-073), so it seeds `conductor` v3, and the lead posts `conductor_dev.v3.json` to it with the first account.
5. Dogfooding moves to the hosted instance. The pinned board's interim stays only for tickets already running there.

**Gates (Ben)**:
- before A: accept ADR-0020 (or amend it), answer U-085..U-091 or take the defaults, and approve this file;
- after A: approve the 10-contracts diff (T01);
- T10: confirm U-090 (In QA for work tickets);
- at the end: the first real Merge-button merge, and sign-off.

---

## Task details

Each block below pastes into a ticket as-is. The **Goal / Context / Functional requirements / Non-functional requirements / Out of scope / Verification** sections follow ADR-0019; the template fields after them (depends, files, acceptance) are for the lead.

### M2r-T00 · Lead: interim `conductor_dev` on the pinned board (data only)
## Goal
Stop Done-before-QA on the pinned board today, with no code change.

## Context
ADR-0020 §11. The pinned build (`board-pinned` @ d75d320) supports agent states with literal prompts, counted failure loops, human transitions with `requires`, and the `pr_merged` condition.

## Functional requirements
- **FR-1** A new `conductor_dev` version, posted with `POST /api/workflows`. It is `conductor_dev` v2 with these changes:
  - `personal_pr_ready_for_review` and `pr_ready_for_review` → `in_qa` (not a question), with the same checks and `open_pr`;
  - `done` (personal) is removed from Implementing;
  - `no_changes_needed` (question) → Needs input.
- **FR-2** `in_qa`:
  - an agent state with a literal QA prompt: read `.claude/agents/qa-reviewer.md`, don't edit or commit, targeted tests only, report `required_fixes`;
  - tools `['review', 'bash']`, timeout 40m, `result: ['verdict', 'summary']`;
  - transitions: `qa_pass` → `ready_to_merge`; `qa_fail` → `implementing` (`retries: 3`, `else: needs_input`); `qa_needs_human` (question) → Needs input; `ask_user`, `timeout`.
- **FR-3** Implementing gets `input.qa_findings = '$in_qa.required_fixes'`.
- **FR-4** `ready_to_merge` (human):
  - `merged_on_github` → Done, with `requires.conditions: [{type: 'pr_merged'}]`, `condition_timeout: '10m'`, `condition_poll: '30s'`, and `on_unmet {goto: 'ready_to_merge', retries: 0, else: 'needs_input'}`;
  - `request_changes` → Implementing.
- **FR-5** Needs input: `done` is replaced by `close_without_merging` → Done. `columns` gains `in_qa` and `ready_to_merge`.

## Non-functional requirements
- **NFR-1** Running tickets keep their pinned version.

## Out of scope
Code changes; the hosted instance.

## Verification
- FR-1..FR-5: the save returns 201 (the validator accepts it); a throwaway ticket on a scratch repo reaches In QA, then Ready to merge.
- FR-4: "Merged on GitHub" before merging waits, then goes to Needs input after 10m; after merging, it goes to Done. If the pinned build doesn't run conditions on a human move, drop the `requires` and record a TD.
- NFR-1: a ticket started on v2 still shows v2's buttons.

- **Depends on**: none. **Files owned**: none (a DB write). **Acceptance**: the Verification above, recorded in the session log.

### M2r-T01 · Contracts
## Goal
Freeze every seam M2r needs, additively, so groups B–D build in parallel.

## Context
ADR-0020 §2–§7, §10. 10-contracts §Transitions is the pattern. Only this task edits these schemas in M2r; later tasks report needed changes to the lead.

## Functional requirements
- **FR-1** `workflow/schema.ts`:
  - the agent state gains `role?: 'qa'` and `checkout?: {setup?: string | null}`;
  - the transition gains `text?: 'required' | 'optional'`, and `attach` accepts `'result'`;
  - `requires` gains `approvals?: [{id (slug), label ≤ 60, paths: glob[1..20], text? ≤ 500}] (≤ 5)`;
  - `on_unmet` gains `routes?: Record<reason, state>`;
  - `TransitionActionSchema` gains `inspect_pr`, `merge_pr`, `close_pr` (not yet in `AVAILABLE_TRANSITION_ACTIONS`; T02 adds them);
  - `RESERVED_CONTEXT_KEYS` gains `__qa`.
- **FR-2** `engine/qa.types.ts` (new): `QaResultSchema` (ADR-0020 §2: verdict, requirements, findings, required_fixes, debt, unknowns, tests_run, summary, with the caps). `QaContextSchema` (`__qa`: head_sha, verdict, round, max_rounds, claude_session_id).
- **FR-3** `protocol/actions.ts` (or wherever `open_pr`'s args live):
  - `InspectPrArgs {pr_url, approval_paths: Record<id, glob[]>}` and `InspectPrResult {head_sha, files ≤ 300, files_truncated, mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN', state, matched}`;
  - `MergePrArgs {pr_url, expected_sha, method: 'merge', approved_paths}` and `MergePrResult` = `{ok: true, merged: true, already, merge_commit_sha, head_sha, note?}` | `{ok: false, unmet: 'head_moved' | 'conflict', observed_sha?, detail}` | `{ok: false, error: 'closed' | 'blocked' | 'approval_missing' | 'error', detail}`;
  - `ClosePrArgs {pr_url | null, reason}` and `ClosePrResult {closed, merged, already}`;
  - `OpenPrResult` gains `head_sha` (the pushed commit).
- **FR-4** `protocol/ws.ts`: `start_session.checkout? {sha, pr_url, setup}`; `run_action.action` accepts the three actions.
- **FR-5** `engine/types.ts`: `human.transition` gains `approvals: string[]`; ignore reason `approval_required`; `GateStep.approvals?` (who, ids, files).
- **FR-6** `api/rest.ts`:
  - `TransitionSessionRequest.approvals?`; the error code `approval_required` with `details.approvals [{id, label, files}]`;
  - `BoardCard.qa? {verdict, round, max_rounds}`, `BoardCard.pr? {url, merged, closed}`;
  - `human_transitions[]` gains `approvals [{id, label, files}]` and `text`;
  - badges gain `merged` and `closed_unmerged`;
  - `SessionDetail.qa?` (the latest `QaResult` and `head_sha`).
- **FR-7** Fixtures for each, and **10-contracts §Review and merge (ADR-0020)**.

## Non-functional requirements
- **NFR-1** Additive only: every v2 definition, pre-M2r card and WS payload still parses.
- **NFR-2** Every text field is capped (model text, U-045).

## Out of scope
Validator rules (T02), engine behaviour (T03, T04).

## Verification
- FR-1..FR-6: `workflow/schema.m2r.test.ts`, `engine/qa.types.test.ts`, `protocol/actions.m2r.test.ts`. Each fixture parses, and the boundary sizes are refused.
- NFR-1: `conductor.test.ts` still parses v1 and v2 unchanged; old card fixtures parse.
- An interface-review agent confirms T02–T09 can be built from these contracts. Ben approves the 10-contracts diff.

- **Depends on**: none.
- **Files owned**: `shared/src/workflow/schema.ts` (additions), `shared/src/engine/{types.ts, qa.types.ts, fixtures.ts}`, `shared/src/protocol/{ws.ts, actions*.ts, fixtures.ts}`, `shared/src/api/{rest.ts, fixtures.ts}`, one export line, 10-contracts §Review and merge.
- **Do not touch**: `apply.ts`, `render.ts`, `validate*.ts`, other packages.
- **Acceptance**:
  - [ ] the tests named in Verification;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T02 · Shared: validator rules and the `qa` tool alias
## Goal
Saved definitions using M2r's fields are checked, and QA gets a pre-approvable, edit-free tool set.

## Context
ADR-0020 §2, §5, §6. 05 §Validation on save (rules 10–14 are the pattern, in `validate-transitions.ts`).

## Functional requirements
- **FR-1** `AVAILABLE_TRANSITION_ACTIONS` gains `inspect_pr`, `merge_pr` and `close_pr`.
- **FR-2** **Rule 15**: in a definition that names `merge_pr` anywhere, every non-fallback transition into a terminal state carries `merge_pr` or `close_pr` in `requires.actions`.
- **FR-3** **Rule 16**:
  - `role: 'qa'` only on agent states, never the start state;
  - a `qa` state's tools are exactly `['qa']`;
  - `checkout` only on `qa` states;
  - `attach: 'result'` only on transitions out of agent states;
  - `text` only on `actor: human` transitions;
  - `approvals` only on `actor: human` transitions that carry `merge_pr`;
  - `on_unmet.routes` targets exist, aren't terminal and have no `entry`;
  - route keys are known reasons (`head_moved`, `conflict`).
- **FR-4** Rule 4 (bounded loops) treats `routes` legs as bounded by the move counter.
- **FR-5** `tools.ts`: the `qa` alias:
  - the read base, `REVIEW_GIT_COMMANDS`, and the exact commands `git diff --stat qa-base...HEAD`, `git diff qa-base...HEAD`, `git log --oneline qa-base..HEAD`;
  - test-runner prefixes `pnpm test:*`, `pnpm vitest:*`, `pnpm exec vitest:*`, `npm test:*`, `npm run:*`, and the exact `pnpm typecheck`, `pnpm lint`;
  - deny `Edit`, `Write`, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(gh:*)`.

## Non-functional requirements
- **NFR-1** v1, v2 and every existing fixture still validate (no rule fires on a definition without the new fields).

## Out of scope
The definitions themselves (T10).

## Verification
- FR-2: `validate.m2r.test.ts` "rule 15: a terminal transition without merge_pr/close_pr in a merge-aware definition is refused; v2 is unaffected".
- FR-3, FR-4: one test per sub-rule, error paths at the field (`states.in_qa.role`, …).
- FR-5: `tools.test.ts` "qa alias has no edit tools and denies commit/push/gh".
- NFR-1: the existing validator tests stay green.

- **Depends on**: T01.
- **Files owned**: `shared/src/workflow/{validate.ts, validate-transitions.ts, tools.ts}` and their tests, 05 §Validation on save (rules 15–16).
- **Do not touch**: `schema.ts` (T01), `engine/**`, other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T03 · Shared engine: the QA state
## Goal
An agent state with `role: 'qa'` runs as an independent, fenced, fresh QA session, and its outcomes move the ticket as ADR-0020 §2 says.

## Context
ADR-0020 §2. ADR-0009 implementation notes (fencing, separate conversations, the nudge) and 10-contracts §Requirements review are the pattern to reuse.

## Functional requirements
- **FR-1** Entering a `qa` state:
  - bumps the fencing token and kills the previous agent process (`kill.target_command_id`);
  - writes `__qa {head_sha, round, max_rounds}`. `head_sha` is `__pr.head_sha`, or the `observed_sha` T04 recorded. `round` = the `in_qa->implementing` counter + 1, and `max_rounds` = that transition's `retries` + 1;
  - emits `start_session` with `resume_claude_session_id: null`, `review: true`, `checkout {sha, pr_url, setup}` and `tools: ['qa']`.
  - With no `__pr` (no PR), it goes to Needs input ("nothing to QA: no pull request"), uncounted.
- **FR-2** A `qa` state's `agent.claude_session_id` goes to `__qa.claude_session_id`, never `session.claude_session_id`.
- **FR-3** `complete_state` from a `qa` state:
  - the result is parsed with `QaResultSchema` and checked against the transition: `qa_pass` / `qa_pass_work` need verdict pass or pass_with_debt and no `required_fixes`; `qa_fail` needs verdict fail and ≥ 1 fix;
  - a mismatch or parse failure → one nudge resuming the QA's own conversation, then Needs input (`retries_exhausted`);
  - on success, `__qa.verdict` is set.
- **FR-4** `attach: 'result'` renders `## Sent back by <title>` (reason, numbered `required_fixes`, blocker and major findings, the instruction) from `context[<from>]` in the target's prompt (render.ts `renderSentBack`).
- **FR-5** A human transition into the `qa_fail` target (`request_changes`, `back_to_implementing`) resets the `<qa state>-><goto>` counter.
- **FR-6** `operator.message` to a `qa` state is refused (`wrong_status`).
- **FR-7** A start refused by the daemon (the checkout failed, the head differs) → Needs input with the daemon's reason, uncounted.

## Non-functional requirements
- **NFR-1** apply stays pure. `apply.property.test.ts` stays green at 1 000 runs with `qa` states in the generated definitions.
- **NFR-2** Definitions without `role` behave byte-for-byte as before (the existing tests are unchanged).

## Out of scope
The merge path (T04); the prompt text (T07).

## Verification
- FR-1, FR-2, FR-6, FR-7: `engine/apply.qa.test.ts` "entering in_qa bumps the token, kills the worker and starts a fresh review start with checkout", "the QA's claude id never becomes the session's", "a late worker complete_state after entering in_qa is fenced", "a refused start goes to needs_input".
- FR-3: "qa_pass with verdict fail → nudge → needs_input", "valid qa_pass → ready_to_merge".
- FR-4, FR-5: "three qa_fail → implementing with `## Sent back by In QA`; the fourth → needs_input listing the fixes", "request_changes resets the round".
- NFR-1: `apply.property.test.ts`.

- **Depends on**: T01.
- **Files owned**: `shared/src/engine/qa.ts` (new), the QA routing lines in `apply.ts`, `renderSentBack` in `render.ts`, `engine/apply.qa.test.ts`, additions to `apply.testkit.ts`.
- **Do not touch**: `merge.ts` (T04), `qa-prompt.ts` (T07), the schema files (T01), other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T04 · Shared engine: the merge path
## Goal
Merge, Close without merging and the post-QA inspection move the ticket only on their action results. Done can't be claimed for an open PR.

## Context
ADR-0020 §3–§6. The move-step machinery (05 §Transitions, `move-step.ts`) runs the actions. This task adds the approval gate in front of it, and the result routing behind it.

## Functional requirements
- **FR-1** The approvals gate:
  - a `human.transition` whose transition has `requires.approvals` computes the active approvals from `__pr.inspect` (`matched[id]` non-empty, or `files_truncated`);
  - a missing active id → ignored with `approval_required`, and no state change;
  - otherwise the move step records `step.approvals {ids, files, actor}`.
- **FR-2** `open_pr`'s `action.completed` also writes `__pr.head_sha`.
- **FR-3** `inspect_pr` result:
  - stored as `__pr.inspect`;
  - `head_sha ≠ __qa.head_sha` → unmet `head_moved`: route to `on_unmet.routes.head_moved` ?? `goto`, with `__qa.next_sha = head_sha`, counted.
- **FR-4** `merge_pr` result:
  - `ok` → `__pr.merged {at, merge_commit_sha, by, note?}` and enter `done`, badge `merged`;
  - `unmet: head_moved` → `routes.head_moved` (In QA, which then reviews `observed_sha`);
  - `unmet: conflict` → `on_unmet.goto` with the instruction, counted under `move:ready_to_merge:merge`;
  - `error` → `else`, with the detail as the question.
  - `merge_pr` args come from context only: `pr_url`, `expected_sha = __qa.head_sha`, and `approved_paths` from the step.
- **FR-5** `close_pr` result → `__pr.closed {at, reason, by}` (or `merged` when the PR had been merged), then `done`, badge `closed_unmerged` (or `merged`).
- **FR-6** The Done guard. In a merge-aware definition (one that names `merge_pr`), a session with `__pr` set and neither `merged` nor `closed` can't enter a terminal state except through a passed `merge_pr` / `close_pr`, an operator cancel, or a failure. Any other route is refused: an agent's goes to Needs input (`agent_question`), a human's is ignored with `pr_open`.

## Non-functional requirements
- **NFR-1** Every failure path ends at a human. Every loop is counted (rule 4 / `isCountedTransition` plus the move counter).
- **NFR-2** Idempotency keys are `session:<action>:<visit>`, the same as `open_pr`.

## Out of scope
gh calls (T05); the API's 409 shape (T08).

## Verification
- FR-1: `engine/apply.merge.test.ts` "merge with a migration file and no approval is ignored (approval_required)", "with the approval → merge_pr carries approved_paths".
- FR-3: "inspect head differs → back to in_qa with next_sha".
- FR-4: "merge ok → done badge merged"; "already merged → done"; "conflict → implementing, counted; the third → needs_input"; "head_moved → in_qa"; "closed → needs_input".
- FR-5: "close_without_merging with no PR → done closed_unmerged".
- FR-6: "an agent naming a terminal transition with an open PR → needs_input"; "v2 Done unaffected".
- NFR-1: `apply.property.test.ts` green.

- **Depends on**: T03 (the same `apply.ts`, in sequence).
- **Files owned**: `shared/src/engine/merge.ts` (new), the merge routing lines in `apply.ts` / `move-step.ts`, `engine/apply.merge.test.ts`.
- **Do not touch**: `qa.ts` (T03), the schema files, other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T05 · Daemon: `inspect_pr`, `merge_pr`, `close_pr`
## Goal
Conductor can inspect, merge and close the ticket's PR on the user's machine, safely and idempotently.

## Context
ADR-0020 §4. Follow `packages/daemon/src/actions/open-pr.ts` exactly: `pushTarget`, `run`, `cleanEnv`, the gh version floor, gh run in the daemon root, the `--repo` from the trusted store. ADR-0016's head pinning is the precedent.

## Functional requirements
- **FR-1** `inspect_pr`: `gh pr view <url> --repo R --json headRefOid,files,mergeable,state`, with `files` capped at 300 (`files_truncated`) and `matched` per approval id (minimatch-style globs, the same matcher as T02's validation).
- **FR-2** `merge_pr` follows ADR-0020 §4 steps 1–8:
  - already `MERGED` → success `already: true`;
  - `CLOSED` → `error: closed`;
  - the head differs → `unmet: head_moved` with `observed_sha`;
  - `CONFLICTING` → `unmet: conflict`;
  - an unapproved path → `error: approval_missing`;
  - otherwise `gh pr merge <url> --repo R --merge --match-head-commit <sha>`, never `--admin` or `--delete-branch`;
  - gh's output is mapped: head mismatch → `head_moved`, protection or required checks → `blocked`, anything else → `error` with the tail.
- **FR-3** `close_pr`:
  - no URL → success (no-op);
  - `MERGED` → `{merged: true}`;
  - `CLOSED` → `already`;
  - otherwise `gh pr close <url> --repo R --comment "<reason> (closed by conductor)"`.
- **FR-4** The PR URL must match `GITHUB_PR_URL_RE`, and its owner/name must equal the trusted `--repo`. Anything else is refused.
- **FR-5** Dispatch lines in `daemon.ts` and an args parse error message, like `evaluate_conditions`.

## Non-functional requirements
- **NFR-1** No git command runs. Nothing is read from the shared clone's config.
- **NFR-2** It is idempotent: the same command id is deduped, and a repeated merge after success returns `already: true`.

## Out of scope
Engine routing (T04); branch deletion.

## Verification
- FR-2: `actions/pr-merge.test.ts` (fake gh as `/bin/sh` scripts, the `open-pr.test.ts` pattern): "merges with --merge --match-head-commit and never --admin", "already merged → success", "closed → error closed", "head differs → head_moved", "conflicting → conflict", "protection failure → blocked", "unapproved migration → approval_missing".
- FR-1, FR-3: "inspect matches the migration glob", "close with no PR is a no-op".
- FR-4: "a PR URL for another repo is refused".
- NFR-1: "no git process spawned" (spawn spy).
- FR-5: `daemon.test.ts` "run_action merge_pr round trip".

- **Depends on**: T01.
- **Files owned**: `packages/daemon/src/actions/pr-merge.ts` (new) and its tests, the three dispatch cases in `daemon.ts`.
- **Do not touch**: `open-pr.ts` beyond `head_sha` in its result (one line), `checkout.ts` (T06), other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2r-T06 · Daemon: the QA session in a fresh checkout of the PR head
## Goal
A `start_session` with `checkout` runs Claude in a fresh, conductor-owned checkout of exactly the PR commit, with a `qa-base` ref and setup done, under forced dontAsk.

## Context
ADR-0020 §2 "Where it runs". `actions/checkout.ts` (ADR-0010) is the base. The difference is the source: the trusted remote URL (`cloneSource(ticket.repo)`, open_pr's allow-list) instead of the worktree. `review: true` already forces dontAsk and keeps the Claude id out of `PersistedSession`.

## Functional requirements
- **FR-1** With `start_session.checkout {sha, pr_url, setup}` the daemon:
  - creates `<root>/private/qa-*` (0700, lstat and owner checked);
  - fetches the PR head (`refs/pull/<n>/head`) and the default branch from the trusted URL with the hardened fetch;
  - requires the PR head to equal `sha`;
  - checks out `sha` detached and creates `qa-base` at `merge-base(default, sha)`;
  - runs `setup` (null → the ADR-0010 auto-detect);
  - starts Claude with that directory as its cwd.
- **FR-2** Any failure (fetch, sha mismatch, setup) refuses the start with a reason the engine shows (`start_refused {reason}` or the existing refusal path, as T01 fixed).
- **FR-3** The checkout is deleted when the process exits, is killed or is superseded, and the startup sweep covers `qa-*`.
- **FR-4** The edit guard and `--setting-sources user` apply as for reviewers. The repo's CLAUDE.md is read from the checkout.

## Non-functional requirements
- **NFR-1** No agent-writable git state is read: the source is the trusted URL, hooks are off, the config is minimal.
- **NFR-2** Setup output is never stored in Postgres (ADR-0003).

## Out of scope
The QA prompt (T07); the `qa` alias (T02).

## Verification
- FR-1: `actions/qa-checkout.test.ts` "checks out the PR head with qa-base at the merge base", "the setup runs once".
- FR-2: "a head ≠ sha refuses the start with the reason".
- FR-3: "the checkout is removed on exit and on kill"; "the sweep removes leftovers".
- NFR-1: "a planted hook and insteadOf in the shared clone don't run or redirect" (the `open-pr.test.ts` plants).
- FR-4: `daemon.test.ts` "a review start with checkout runs in dontAsk in the checkout dir".

- **Depends on**: T01.
- **Files owned**: `packages/daemon/src/actions/qa-checkout.ts` (new, reusing `checkout.ts` exports), the start-path branch in `daemon.ts` / `workspace.ts`, their tests.
- **Do not touch**: `pr-merge.ts` (T05), `open-pr.ts`, `claude/cli-driver.ts` beyond passing cwd, other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2r-T07 · Shared engine: the QA prompt
## Goal
The QA session is told exactly what to review, what is already proved, and how to report.

## Context
ADR-0020 §2 "The prompt". The engine has no repository files, so the prompt points at them. M2c's parser isn't merged yet: extract the sections by H2 heading, case-insensitively, and switch to `parseTicketBody` in M2c-T05.

## Functional requirements
- **FR-1** `qa_template` (`QA_TEMPLATE` in `PROMPT_TEMPLATES`) renders, in order:
  - role (PR URL, `__qa.head_sha`, round n of max);
  - the checklist pointer (`.claude/agents/qa-reviewer.md`, `docs/qa/QA_CHECKLIST.md`), plus the built-in default checklist;
  - "already proved": the names of the passed checks of the transition that entered the state;
  - the ticket (title, body; the extracted `## Functional requirements`, `## Non-functional requirements`, `## Verification`, `## Out of scope`);
  - the three fixed `qa-base` diff commands;
  - on round > 1, the previous round's `required_fixes` to re-check;
  - how to finish: the three transitions, the `QaResult` schema with a JSON example, and "grade every FR/NFR in `requirements`".
- **FR-2** A body without the sections renders its body as-is and says "no requirement sections: judge against the title and body".

## Non-functional requirements
- **NFR-1** The prompt holds no command output (U-039). It stays under 24 KB for a 10 KB ticket body.

## Out of scope
Changes to `.claude/agents/qa-reviewer.md` itself; M2c's parser.

## Verification
- FR-1: `engine/qa-prompt.test.ts` "lists the passed checks, the FR/NFR/Verification sections, the qa-base commands and the result schema" (snapshot); "round 2 lists the previous fixes".
- FR-2: "a free-form body falls back".
- NFR-1: "size bound".

- **Depends on**: T01.
- **Files owned**: `shared/src/engine/qa-prompt.ts` (new), its test, the `QA_TEMPLATE` dispatch line in `render.ts`.
- **Do not touch**: `apply.ts`, `qa.ts`, other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T08 · Orchestrator: approvals on the transition route, card fields, v3 seed
## Goal
The REST and board surfaces carry the new flow, and new accounts get `conductor` v3.

## Context
ADR-0020 §3, §5, §7, §10. The existing `POST /api/sessions/:id/transition` (`api/index.ts`), `engine/board-view.ts` and `engine/seed.ts` are extended.

## Functional requirements
- **FR-1** The transition route passes `approvals` through. An `approval_required` ignore → **409** `approval_required` with `details.approvals [{id, label, files}]`, and nothing written. A `pr_open` ignore → 409 `pr_open`.
- **FR-2** Board card:
  - `qa` (from `__qa`) and `pr` (from `__pr`);
  - `human_transitions[].approvals` (the active ones, with files) and `.text`;
  - the `merged` / `closed_unmerged` badges on Done.
- **FR-3** `SessionDetail.qa` = `context.in_qa` (the latest `QaResult`) plus `__qa`.
- **FR-4** The seed inserts `conductor` v3 over an unedited v2 (parsed deep-equal to `CONDUCTOR_V2_DEF`), with the same `ON CONFLICT DO NOTHING`. An edited v2 keeps its version and gets `default_available`.

## Non-functional requirements
- **NFR-1** Every route stays account-scoped where M2's scoping has landed (the `request.auth.scope` pattern).

## Out of scope
The web UI (T09); per-account seeding (M2-T12; rebase onto it if it lands first).

## Verification
- FR-1: `test/api.transition-approvals.test.ts` "merge without the migration approval → 409 with the files; with it → 202 and a merge_pr outbox row".
- FR-2: `test/engine/board-view.m2r.test.ts` "In QA card shows round; Ready to merge offers merge with approvals; Done badge merged".
- FR-3: `test/api.session-detail.qa.test.ts`.
- FR-4: `test/engine/seed.test.ts` "unedited v2 → v3; edited v2 untouched".

- **Depends on**: T04, T10.
- **Files owned**: the transition handler in `src/api/index.ts` (or `api/sessions.ts`), `src/engine/board-view.ts` (M2r fields), `src/engine/seed.ts` (v3), their tests.
- **Do not touch**: `shared/**`, `gateway/**`, `auth/**`, other api handlers.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2r-T09 · Web: In QA, Ready to merge, and the QA tab
## Goal
Each card's call to action matches its next step: In QA reads as conductor working, and Ready to merge's primary action is Merge.

## Context
ADR-0020 §1, §5, §7. Build against T01's contracts and the mock client. `components/transitions.tsx` renders `human_transitions` today.

## Functional requirements
- **FR-1** In QA card: "Conductor is reviewing · round n/3", styled as conductor work (not "needs you"). Its detail panel shows the live QA transcript.
- **FR-2** Ready to merge card:
  - **Merge** is the primary button;
  - Request changes opens a required text box;
  - when an approval is active, the card lists its files under an "Approve migration" checkbox, Merge stays disabled until it is checked, and the request carries `approvals`;
  - a 409 `approval_required` re-renders the list.
- **FR-3** Needs input: "Close without merging" asks for a required reason; "Back to Implementing" asks for text.
- **FR-4** A **QA** tab in the detail panel:
  - verdict, round, summary, findings by severity, required fixes, tests run, debt, unknowns;
  - "Copy as tracking rows", which formats debt and unknowns as TD / U table rows without IDs.
- **FR-5** Done badges: `merged` (with the merge commit, short) and `closed, not merged` (with the reason in a tooltip).

## Non-functional requirements
- **NFR-1** Keyboard-accessible buttons and checkbox, with a labelled file list.
- **NFR-2** No layout shift when the approval appears.

## Out of scope
The workflow editor's panels for the new fields (shows raw JSON for them until a later UX ticket).

## Verification
- FR-1: `components/Board.m2r.test.tsx` "In QA card shows conductor working and the round".
- FR-2: `components/transitions.merge.test.tsx` "Merge is disabled until Approve migration is checked; posts approvals"; "request_changes requires text"; "a 409 approval_required re-renders the list".
- FR-3: `transitions.close.test.tsx`.
- FR-4: `components/QaTab.test.tsx` "renders findings and copies rows".
- FR-5: `Board.m2r.test.tsx` "Done badges".

- **Depends on**: T01.
- **Files owned**: `packages/web/src/components/{transitions.tsx, QaTab.tsx (new), Board.tsx (QA / merge parts), DetailPanel.tsx (the tab)}`, the M2r parts of `web/src/api/{client,mock}.ts`, their tests.
- **Do not touch**: `web/src/auth/**`, `web/src/admin/**`, `web/src/workflow/**`, other packages.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T10 · Definitions: `conductor` v3 and `conductor_dev` v3
## Goal
The default workflow and the dogfood workflow encode ADR-0020.

## Context
ADR-0020 §9–§10. `CONDUCTOR_V2` in `packages/shared/src/workflow/conductor.ts` mirrors `docs/design/workflows/conductor.v2.json`, and a test keeps them equal. The `conductor_dev` v2 definition lives only in the pinned database: export it with `GET /api/workflows/conductor_dev?version=2` as the base.

## Functional requirements
- **FR-1** `CONDUCTOR_V3` / `CONDUCTOR_V3_DEF` and `docs/design/workflows/conductor.v3.json`, exactly ADR-0020 §10, with U-090's answer for the work branch.
- **FR-2** `docs/design/workflows/conductor_dev.v3.json`: v3 with `conductor_dev` v2's six checks and setup, `in_qa.checkout.setup: "pnpm i --frozen-lockfile"`, and approval paths `["packages/orchestrator/migrations/**"]`.
- **FR-3** 05 §Reference workflows lists v3.

## Non-functional requirements
- **NFR-1** Both pass `validateWorkflow` and `python3 -m json.tool`.

## Out of scope
The seed (T08); posting to the hosted instance (the lead, at deploy).

## Verification
- FR-1, FR-2, NFR-1: `workflow/conductor.test.ts` "v3 equals the JSON", "v3 and conductor_dev v3 validate", "every path to done carries merge_pr or close_pr".
- `python3 -m json.tool docs/design/workflows/conductor.v3.json`.

- **Depends on**: T02; U-090 answered.
- **Files owned**: `shared/src/workflow/conductor.ts` (v3), `conductor.test.ts`, the two JSON files, 05 §Reference workflows.
- **Do not touch**: everything else.
- **Acceptance**:
  - [ ] the Verification tests;
  - [ ] gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2r-T11 · E2E
## Goal
The whole review-and-merge flow runs end to end with the real bins, a fake Claude and a fake gh.

## Context
`e2e/m1b.e2e.test.ts` and its fake gh, whose PR state a test rewrites, are the pattern. The fake gh gains `pr merge` (honouring `--match-head-commit`), `pr close`, `pr view --json files,mergeable,state,mergedAt,mergeCommit`, and `refs/pull/<n>/head` in the local fixture remote.

## Functional requirements
- **FR-1** `e2e/m2r.e2e.test.ts`:
  1. pass → Merge → Done `merged`;
  2. fail → Implementing with `## Sent back by In QA` → pass → merge;
  3. three fails → Needs input;
  4. the PR head moves after QA → Merge → In QA again on the new head;
  5. conflicting → Implementing;
  6. a migration file: Merge without the approval → 409, with it → merged;
  7. Close without merging → Done `closed, not merged`, PR closed;
  8. already merged on (fake) GitHub → Merge → Done;
  9. PR closed on GitHub → Merge → Needs input;
  10. a v2 regression (Done without a merge still works on v2).

## Non-functional requirements
- **NFR-1** No real GitHub or Claude call. Green 3 runs in a row; under 60 s added.

## Out of scope
`E2E_REAL_CLAUDE` QA runs.

## Verification
- FR-1: the ten named `it(...)` cases.
- NFR-1: `pnpm test:e2e` three consecutive green runs (logged in the PR).

- **Depends on**: T05, T06, T07, T08, T09.
- **Files owned**: `e2e/m2r.e2e.test.ts`, additive harness and fake-gh / fake-claude changes.
- **Acceptance**:
  - [ ] the Verification above;
  - [ ] gates: all, including `pnpm test:e2e`.

### M2r-T12 · Docs
## Goal
The docs describe what was built, and the lead's lifecycle uses it.

## Context
ADR-0020 §8.

## Functional requirements
- **FR-1** 05 (role qa, approvals, routes, rule 15–16, the Done guard), 06 (the In QA and Ready to merge columns and buttons), 10 (§Review and merge final) match the code.
- **FR-2** ADR-0020 implementation notes.
- **FR-3** CLAUDE.md §2–3: for conductor tickets, QA and merge are conductor's (In QA, Merge). The lead records the QA's proposed rows and still QAs non-ticket branches.
- **FR-4** The M2c file's notes (v4, the QA → review-layer mapping) are confirmed.

## Non-functional requirements
- **NFR-1** Every link resolves.

## Out of scope
New design.

## Verification
- FR-1..FR-4: a QA agent finds no doc/code contradiction.
- NFR-1: a link check.

- **Depends on**: T11.
- **Files owned**: `docs/design/**`, `docs/adr/0020*` (notes), CLAUDE.md §2–3.
- **Acceptance**:
  - [ ] the Verification above.

---

## Proposed unknowns (recorded in UNKNOWNS.md on this branch)
- **U-085** May the QA agent push fixes itself? Default: **no**. It is read-only by tools, the start is forced dontAsk, the checkout is discarded, and fixes go back to the worker.
- **U-086** The QA model, timeout and cost. Default: **opus**, 40m timeout, counted in the session budget (not enforced yet). Revisit with the first 20 QA runs.
- **U-087** `main` moves after QA, before the merge. Default: **merge when GitHub says mergeable**; a conflict goes back to Implementing, then checks, then a new QA. No re-QA for a clean base move.
- **U-088** Where QA runs. Default: **a fresh checkout of the PR head from the trusted remote**. The alternative, the worktree, is cheaper but sees uncommitted and ignored files.
- **U-089** Close without merging closes the GitHub PR and keeps the branch? Default: **close with a comment, keep the branch**.
- **U-090** Does In QA apply to work tickets? Default: **yes for `pr_ready_for_review`**, plus PR checks and an approval before Ready to merge. `ready_for_testing` is unchanged, and Waiting external's approve → Ready to merge.
- **U-091** Which machine runs `merge_pr` when the session's machine is offline? Default: **the session's machine**; after 10m, Needs input "no machine online". Any online account machine with `cli:gh authed` once M2 routing lands.

## Risks
- **The QA verdict is an LLM's**, so a false pass can still merge a bug. Mitigations: Opus, an exact-commit checkout, the repo's own checklist, Ben's Merge click, and the debt and findings on the card.
- **Contract surface.** Six schema additions across four packages. Mitigation: T01 freezes them with an interface review before group B starts.
- **`apply.ts` contention** with M2-T19, T20 and T26. Mitigation: T03 → T04 in sequence, logic in new modules, and M2-T26 after T04.
- **The fresh `pnpm i` per QA round** costs 30–90 s and disk. Mitigation: the checkout is deleted on exit; a shared pnpm store keeps installs warm.
- **GitHub merge semantics differ by repo** (branch protection, merge methods disabled). Mitigation: `blocked` / `error` go to a human with gh's message; a per-transition `method` exists for later.
