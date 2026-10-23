# ADR-0010 · One workflow; its states are the board columns; requirements to enter a column

- **Status**: accepted (Ben, 2026-10-23)
- **Date**: 2026-10-23
- **Deciders**: Ben (+ Claude session 2026-10-23-agent-inherit-settings, continued)
- **Supersedes**:
  - [06](../design/06-human-input.md)'s status-derived board columns;
  - [ADR-0009](0009-transition-requirements-review.md)'s per-transition gates, for the one workflow. The reviewer agent, its forced `dontAsk` mode, verdicts and bounded retries all stay.
  - Per-ticket workflow choice.

## Context
After ADR-0009 landed, Ben looked at the Workflows view and the board side by side. Two things were wrong. First, the board's columns came from session **status** (Queued, Running, Needs input, Waiting, Done, Failed), while the workflow's **states** (implement, build, test, …) never appeared on it, so the diagram and the board described different things. Second, there were three workflows (`m1_basic`, `m1_basic_haiku`, `m1_reviewed`); there should only ever be one.

Ben's decisions (2026-10-23):
- **The states are the columns:** Queued → Planning → Implementing → Done, with Needs input and Waiting external.
- **Build and test are requirements to enter a column**, alongside "PR created" and plain-language items. They are not columns.
- **Conductor creates the PR**, as part of a column move. Agents stay unable to push (ADR-0006 guard).
- **Failed or cancelled tickets land in Done** with a badge.

## Decision
**There is one workflow, `conductor`, which is still versioned. Each of its states is a board column. A ticket moves between columns only on outcomes, and entering a column can require checks, a reviewer's judgement and conductor actions. When a requirement isn't met, the ticket goes back with the evidence, bounded, then to a human.**

### Definition
The new fields are additive (packages/shared/src/workflow/schema.ts):
- `columns` — the board's columns, left to right, as state names. An implicit **Queued** column is always shown first.
- Every state may have `title` (the column title) and `entry` (the requirements to enter it).
- `entry`:
  - `checks: [{name, cmd, timeout?}]` — deterministic; `cmd` runs in the worktree and must exit 0.
  - `review: {items[], model?}` — plain language, judged by the ADR-0009 reviewer.
  - `actions: ['open_pr']` — performed by conductor.
  - `on_unmet: {goto, instruction?, retries, else}` — the same shape as ADR-0009.
- `CONDUCTOR_WORKFLOW_ID = 'conductor'`.

The default `conductor` v1 (`docs/design/workflows/conductor.v1.json`):

| Column | State (type) | Work | Requirements to enter |
|---|---|---|---|
| Queued | (implicit) | waiting for a machine | — |
| Planning | `planning` (agent, start) | read the repo, write a plan into the result; no code changes | — |
| Implementing | `implementing` (agent) | change the code, following `$planning.plan` | — |
| Needs input | `needs_input` (human) | a person answers or approves | — |
| Waiting external | `waiting_external` (event, `wait_for: ['ui.approve']`) | wait for the PR to be approved (the Approve button for now; a GitHub webhook later) | checks: "Build passes" `npm run build`, "Tests pass" `npm test`; actions: `open_pr`; on_unmet: back to `implementing`, retries 3, else `needs_input` |
| Done | `done` (terminal) | — | — |

Outcomes:
- `planning`: done → implementing.
- `implementing`: done → waiting_external.
- `waiting_external`: `ui.approve` → done.
- Every agent: `ask_user` and `timeout` → needs_input.

`columns`: planning, implementing, needs_input, waiting_external, done. The board prepends Queued.

### Engine: entering a column
When an outcome selects a target state that has `entry`, the session enters an **entry step** instead of the target. It stays in its source column, and the card is badged "checking requirements for <title>". The step runs three phases in order:
1. **Checks**, one at a time: a `run_cmd` per check in the worktree, with the check's timeout or a default. The first non-zero exit is unmet. Its output tail is the evidence; the remaining checks don't run.
2. **Review**, if `review` is set: the ADR-0009 reviewer, which is fresh, read-only, forced `dontAsk`, and reports a verdict per item. Any unmet item is unmet; the reasons are the evidence.
3. **Actions**, in order, through the outbox with idempotency key `session + state + visit`.
   - `open_pr`: the daemon pushes the session branch to the clone's `origin`, then opens a PR against the default branch with `gh pr create` (title = ticket title, body = the implementing result's summary + the ticket ref), or reuses an existing PR for the branch.
   - The PR URL is stored in the target state's context (`context.<state>.pr_url`) and shown on the card.
   - A failed action (no `gh`, no auth, a local-path repo, a network error) is not the agent's fault, so it goes straight to `on_unmet.else` with the error as the question.

All phases pass → the session enters the target state and the card moves.

**When something is unmet** → `on_unmet.goto`. Its next prompt gets: "Requirements to enter <title> were not met:", then the evidence (failed check names and output tails, or unmet items and reasons), then the `instruction`. Retries are counted per target (`entry:<state>`). When exhausted → `on_unmet.else` (a human state), with a question listing what is unmet.

**Invariants hold:**
- the step's outcomes (exit codes, the verdict, action results) are the only things that move the ticket;
- every loop is bounded;
- every failure path ends at a human;
- the state and its commands are written in one transaction;
- actions carry idempotency keys.

**Interactions:**
- Live messages (ADR-0007) to an entry step are refused.
- A reopen (ADR-0008) of a session that ended mid-entry strips the step.
- Budget counts the reviewer's spend and the step's wall time.

### Board
- `GET /api/board` returns `columns` as an **ordered list**: `[{id, title, kind, cards}]`, built from the `conductor` workflow's latest version. Queued comes first, with `id: 'queued'`.
- **A card's column:**
  - no session yet, or status `queued`/`assigned` before any state → `queued`;
  - otherwise its `workflow_state`;
  - in an entry step → its source column, with badge `checking` and `checking: {to, phase}`;
  - status `failed` / `lost`, or ticket `cancelled` → the terminal column (Done), badged `failed` / `lost` / `cancelled`.
- Cards from older workflow versions or old workflows (`m1_*`) whose state isn't a column map by state type:
  - terminal → Done;
  - human → Needs input;
  - event → Waiting external;
  - agent / command → Implementing.
- `BoardCard.column` becomes a column id (a string). `card.moved` and other SSE events carry column ids.

### One workflow
- `POST /api/tickets` defaults `workflow_id` to `conductor`, and the web form has no picker.
- On startup the orchestrator seeds `conductor` v1 from the shipped JSON if no `conductor` version exists.
- The Workflows view edits only `conductor`:
  - it is drawn as columns, left to right;
  - clicking a column edits its title, its work (prompt / tools / model) and its requirements to enter;
  - saving creates a new version; running tickets keep theirs.
- Older workflows stay in the database so finished tickets still render, and are hidden everywhere else.
- Per-transition `requirements` (ADR-0009) remain valid in old versions. The engine keeps supporting them, but the editor no longer offers them.

## Alternatives considered
| Option | Why not |
|---|---|
| Keep status columns and add a "stage" badge | The board and the workflow would still describe different things |
| Build and Test as their own columns | Ben: they are requirements to enter a column, not stages |
| The agent pushes and opens the PR | Lifting the push deny widens what an unattended agent can do; conductor doing it keeps the ADR-0006 guard (Ben's choice) |
| Several workflows, one per repo | Ben: "there should only ever be one". Per-repo variation, if it's ever needed, comes from the repo's commands and CLAUDE.md, not from a second workflow |

## Consequences
- **Good:**
  - The board *is* the workflow.
  - The rules for moving between columns are explicit, versioned, and enforced by commands and a reviewer, not by the working agent.
  - PRs are opened by conductor, so agents still can't push.
- **Bad / accepted cost:**
  - **Contract change.** `BoardResponse.columns` changes from a fixed record to an ordered list, and `BoardColumn` becomes a string: web, orchestrator and SSE all change together.
  - **Status is now a badge.** "Running" is a badge, not a column.
  - **Outward-facing side effect.** `open_pr` pushes to the remote and opens a PR. It uses the daemon machine's `git`/`gh` credentials, which are Ben's own.
  - **Old tickets map imperfectly.** Their columns come from the state-type fallback.
- **Follow-ups:**
  - a GitHub webhook to `pr.merged`/approved instead of the Approve button;
  - TD-091 (the reviewer's base diff) matters more now that review gates the whole branch.

## Revisit when
A second team or repo truly needs a different process (then per-repo column variants), or the board needs swimlanes.
