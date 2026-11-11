# ADR-0037 · Workflow primitives for a self-healing process

- **Status**: proposed
- **Date**: 2026-11-05
- **Deciders**: Ben (+ conductor spike ticket "workflow primitives for self-healing process")
- **Amends**: [ADR-0011](0011-transition-rules.md) (the move record on `state_entered`), the notification rules of UX-15 / "Configurable Notifications" (091cbc80). Supersedes nothing.
- **Draft config**: [`conductor.v6.draft.json`](../design/workflows/conductor.v6.draft.json), [`conductor.repo-checks.draft.json`](../design/workflows/conductor.repo-checks.draft.json)

## Context

The 60-day process review (2026-11-05: 130 tickets, 1,423 moves, 702 check runs) found three problems that a person fixes by hand today:

- **Merge conflicts in review.** A PR waits in In review, another PR on the same repo merges, and the first one no longer merges. Ben notices and types the same `request_changes` recipe each time. Two things let this through:
  - the PR gates treat "no CI after 5 min" as a pass, and a conflicting PR often gets no CI;
  - `in_review` is a human state with nothing that keeps watching.
- **Waiting on a human.** `needs_input` holds 301 h over 213 stays, and `in_review` 89 h. Single questions sit for 37–52 min while the session idles.
- **Notification volume.** Covered under FR-5 below.

The principle (proposal §1): the engine gains only general primitives. The merge-conflict loop, the question SLA and the notification policy are workflow edits that a user with a different process could reuse for something else.

### What exists today (read from the code)

- **Conditions** are a closed union (`ConditionSchema`, `packages/shared/src/workflow/schema.ts`) and run only inside a transition's `requires` move step. A state has nothing that runs while a ticket sits in it.
- **Engine moves don't say why.** `state_entered` carries `{transition, reason, actor}` (`MoveRecord`, `engine/transitions.ts`) only for a *named* transition. Gate failures, `on_unmet` legs, timeouts, `else` legs and budget routes enter with no move, which is the `null/null/null` in Insights finding 2.6.6.
- **`question: true`** marks both "the agent is blocked" and "the agent hands a PR over" (`pr_ready_for_review` and `personal_pr_ready_for_review` in the live v5). Both create an `agent_question` input_request.
- **Prompt templates** (`plan_template`, `implement_template`) are code constants (`engine/render.ts`, `web/src/workflow/columns.ts`), not stored data.
- **The live v5** ([fixture](../../packages/shared/src/engine/fixtures/conductor.v5.live.json)) is a version Ben edited and saved, not a shipped default. So v6 is a `save_workflow` edit, and the shipped `CONDUCTOR_V1..V4` stay as they are.

### FR-5: is 091cbc80's `notify` flag already the P6 surface? No.

`TransitionObject.notify: boolean` (schema.ts) exists and `get_workflow` returns it. v5 shows none because **no transition sets it, and absent means off**. The flag can only *add* a `push_transition` push (`orchestrator/src/push/enqueue.ts` `enqueueTransitionPush`); it can't suppress anything.

The volume comes from the other path: `enqueueNeedsInputPush` fires on **every input_request**, whatever the definition says, keyed only by the request id. Every PR hand-off into In review (503 `personal_pr_ready_for_review` moves), every rework lap back into it, and every `retries_exhausted` and `timeout` therefore pushes. P6 below puts both paths under one policy. The existing boolean keeps its meaning: `true` means `every`, `false` `never`, and absent means `inherit`.

## Decision

Add eight general primitives (P1–P8) to the workflow definition, the engine and the designer. Each one is off, or behaves exactly as today, until a definition sets it. They land behind the rule-14 "not available yet" pattern: the schema parses a field as soon as T1 lands, and the validator refuses it until the ticket that implements it marks it available. The answers to the spike's open questions are in §Open questions settled.

### Open questions settled

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | `watch` events: poll or webhooks? | **Poll plus internal triggers, no webhooks.** Watches are re-evaluated every `watch.poll` (default 2m, minimum 30s; the interval doubles after an unchanged answer, capped at 15m, as conditions do today). The orchestrator also re-evaluates at once, and releases P4 holds, when (a) a ticket on the same repo has its PR merged (a `merge_pr` action succeeded, or a human move into a terminal state from a state whose `context.__pr` is set), or (b) the session's branch is pushed by conductor (`open_pr`). | Conductor already knows when the merges it performs happen, and that is the common case for this repo. Webhooks would be a new inbound external service per repo (ADR-0017 self-hosting, ADR-0012 auth). The 2-minute poll covers merges done outside conductor. Revisit if P4 release latency shows up in Insights (U-row in §Consequences). *Amended 2026-11-11 (R11), see below.* |
| 2 | `concurrency`: on the transition or on the target state? | **On the transition, as `requires.concurrency`, the first phase of the move step** (before checks). The card shows "Queued behind #N" from the hold record. | It reuses the move-step machinery: the timeout goes to `on_unmet.else`, the counter rules apply, and the card checklist is already there. Running it first means the checks, review and `open_pr` run on the branch as it is *after* the release, not on one that went stale while waiting. The display issue is solved by a card field (`BoardCard.checking.phase = 'held'`), not by an extra state. |
| 3 | Where do `instructions` live? | **A workflow-level `instructions` map**, referenced as `$instructions.<slug>`. It is not shared across workflows, and it does not reuse the prompt-template mechanism. | Templates are code, not data. There is one workflow (ADR-0010; `routine` is the only other), so cross-workflow sharing has no user. Keeping the text inside the definition means it is versioned with the transitions that use it. |
| 4 | `handoff: true` flag, or `question` as an enum? | **A new boolean `handoff`**, exclusive with `question`. | Additive. Turning `question` into an enum would rewrite every stored definition and every reader of `question === true`. |
| 5 | Coalescing in the engine or the notifier? | **The engine decides *whether*, the notifier coalesces.** Pure `apply()` evaluates the policy and records `notify: {via, mode, decision}` on `state_entered` and on the input_request (amended by T4: `mode` is `once` / `every` / `never`). `push/enqueue.ts` coalesces with an idempotency bucket `notify:<ticket>:<state>:<floor(now / coalesce)>`. | Whether to notify is a pure function of the definition and the move, so it is testable in `apply.notify.test.ts`. Coalescing needs wall-clock windows and the outbox's unique index, which are notifier concerns. |
| 6 | Are 091cbc80's flags the P6 surface? | **No**, see FR-5. The boolean is kept and folded into P6 as described there. | |

> **Amended 2026-11-11 (R11): optional GitHub webhooks.** Q1 stands: polling plus the internal nudges are still how every watch and condition is re-checked, and nothing depends on a webhook. What changed is that a repo *may* add a GitHub webhook as an accelerator. A signed `check_run` / `check_suite` (`completed`), `pull_request` or `pull_request_review` delivery to `POST /api/webhooks/github/<account>` brings a matching session's next check forward to now:
> - `state_deadline` for a move step in its conditions phase;
> - `watch_deadline` for a watched state;
> - a merged PR wakes every watch on the repo, like the internal merge nudge.
>
> The delivery never decides anything: the sweep fires the timer and the normal evaluation runs. This answers Q1's two objections without reversing it:
> - it is opt-in per repo, not a required inbound service;
> - it is authenticated by an HMAC with a per-account secret rather than ADR-0012's session auth.
>
> Merges and CI completions made outside conductor now reach a watched or gated ticket in seconds when the repo has the webhook, and at the next poll when it doesn't. Setup: [github-webhooks.md](../setup/github-webhooks.md); contracts: [10 §GitHub webhooks](../design/10-contracts.md#github-webhooks).

### P1 · `watch` on human and event states

A state keeps checking conditions while a ticket sits in it, and moves the ticket (or escalates) when one stops holding.

```ts
export const WatchSchema = z.strictObject({
  poll: DurationSchema.optional(),                        // default DEFAULT_CONDITION_POLL (2m), min 30s
  conditions: z.array(ConditionSchema).min(1).max(10),    // same union as requires.conditions (P2)
  on_broken: z.union([
    z.strictObject({
      goto: StateNameSchema,
      instruction: InstructionTextSchema.optional(),      // text or `$instructions.<slug>` (P5)
      return_to: z.union([StateNameSchema, z.literal('$self')]).optional(),
      retries: z.number().int().min(0).max(10).default(2),
      else: StateNameSchema.default('needs_input'),
    }),
    z.strictObject({ notify: z.literal('escalate') }),    // no move: one P6 escalation per stay
  ]),
});
// HumanStateSchema and EventStateSchema gain `watch: WatchSchema.optional()`.
```

- **Engine.**
  - On entering a watched state, the engine arms a watch timer (`watch_deadline` on the snapshot) and sends `run_action evaluate_conditions` exactly as the conditions phase does. It sends nothing for engine-only conditions (`age_below`, P2).
  - **In order, short-circuit.** A watch's conditions are evaluated in declared order, and each poll stops at the first condition that is not `met`:
    - `failed` fires `on_broken`;
    - `pending`, `error` or `unsupported` re-arms.

    A later condition therefore runs only when every earlier one is met. List the cheap one first: `pr_mergeable` before a `cmd`, so the `cmd` runs only once GitHub says the PR is mergeable.
    - The engine evaluates `age_below` itself. If it comes first and fails, nothing is sent to the daemon.
    - `evaluate_conditions` gains `short_circuit: true`. The daemon stops at the first non-`met` result and reports the rest as `skipped`.
    - `requires.conditions` keep today's evaluate-all behaviour, because the gate's checklist shows every item.
  - **Met** (all of them) means nothing happens and the timer re-arms. **Pending, error or no machine** means the timer re-arms and a note is shown; the watch never fires on missing evidence.
  - **Failed** (a condition is definitely false) means `on_broken` runs:
    - **The move form** enters `goto` as a system move with `cause: 'watch_broken'` (P7) and the failed conditions as evidence. The move is counted under `watch:<state>`; when the count exceeds `retries` it goes to `else`.
    - The instruction goes to the agent the way `on_unmet.instruction` does.
    - `return_to: '$self'` sets `session.return_to` to the watched state, so the agent's next completion, through `$return_to` or a hand-off, comes back to it.
      *As built (T6):* agent transitions can't name `$return_to` (rule 10), so the way back is the hand-off: the move also stores `context.__watch_return`, and the agent's next `handoff: true` transition lands in the watched state instead of its own `goto`, after its `requires`. The marker is cleared on any landing in a human or terminal state and by a human's move. The first check after entry is one poll later (entry only arms the timer).
  - **The escalate form** emits one notification with `via: 'watch_escalate'` per stay. The counter resets on re-entry.
  - Leaving the state disarms the watch. A watch never kills a running process, because human and event states have none.
- **Where a `cmd` condition runs.** In the fresh, conductor-owned checkout of the PR head that `requires.checks` uses (ADR-0030). Never in the agent's worktree, which on a human state may belong to the next visit. Its `needs` field (P2) decides how much is prepared:
  - `checkout` gets the checkout only;
  - `setup`, the default, also runs the repo `setup`.

  A `git merge-tree` check needs no dependencies, so it uses `needs: checkout` and skips `pnpm install` on every poll.
- **Cost.** A `cmd` in a watch still costs a checkout per poll on the session's machine. That is why the v6 draft's `in_review.watch` carries only `pr_mergeable` (one `gh` call), and "Merges cleanly with main" stays a pre-PR repo check (§Draft v6). The `cmd` form remains the escape hatch, for a repo without GitHub mergeability or for a check GitHub can't make.
- **Builder.** A "While here, keep checking" panel on human and event columns: a condition list (the existing `ConditionFields` editor), a poll field, and an "if it breaks" choice between *send back to* (goto, instruction preset, come-back toggle, retries, else) and *notify me*.
- **Insights.** Each firing is a `state_entered` with `cause: 'watch_broken'`, or a notify with `via: 'watch_escalate'`. Re-entries are counted per cause. A loop of `watch_broken` laps is reported as a re-sync loop, not as rework.
- **v5 migration.** Absent means no watch, so nothing changes.

### P2 · Open condition types

```ts
// added to ConditionSchema's discriminated union
z.strictObject({ type: z.literal('cmd'), name: z.string().trim().min(1).max(200),
                 cmd: z.string().trim().min(1), timeout: DurationSchema.optional(),
                 needs: z.enum(['checkout', 'setup']).default('setup'), ...conditionCommon }),
z.strictObject({ type: z.literal('pr_mergeable'), ...conditionCommon }),
z.strictObject({ type: z.literal('age_below'), max: DurationSchema, ...conditionCommon }),
```

- **`cmd`** is met when the command exits 0 and failed otherwise, run in the fresh checkout described under P1. `needs: checkout` skips the repo `setup`; `needs: setup`, the default, matches `requires.checks`. The extensibility escape hatch is any later need (a label present, behind-by-N, a Jira field), which becomes a workflow edit.
- **`pr_mergeable`** runs `gh pr view --json mergeable,mergeStateStatus`:
  - `MERGEABLE` means met;
  - `CONFLICTING` means failed;
  - `UNKNOWN` means pending (GitHub is still computing).

  It needs no checkout.
- **`age_below`** is evaluated by the engine, never sent to the daemon. It is met while the time in the current state (`now − state_entered_at`) is below `max`. It is meaningful only in a `watch` (rule 24).
- **Daemon.** `crates/conductor-daemon/src/actions/conditions.rs`, with the TS twin in `packages/daemon/src/actions/conditions.ts` (PARITY.md) and the protocol JSON regenerated.
- **Builder.** Three new entries in the condition-type select, with their fields.
- **Insights.** Each condition result is stored with `type` and `label` on the checklist, as today. `failing_check`-style findings are titled with `label`/`name`, never the command (2.6.4).
- **v5 migration.** New types only, so nothing changes.

### P3 · `no_checks` policy on `pr_checks_green`

```ts
const NoChecksPolicySchema = z.strictObject({
  policy: z.enum(['pass', 'fail', 'require_mergeable']),
  after: DurationSchema,
});
// pr_checks_green gains `no_checks: NoChecksPolicySchema.optional()`; exclusive with `no_checks_after` (rule 25).
```

- **Engine.** After `after` with no checks reported:
  - `pass` means met, which is today's `no_checks_after`;
  - `fail` means failed;
  - `require_mergeable` means met only if the same evaluation reports `mergeable: MERGEABLE`. The daemon adds `mergeable` to its `gh pr view` when this policy is set. `CONFLICTING` is failed, and `UNKNOWN` is pending.
- **Builder.** The "no CI" field becomes a policy select plus a duration.
- **v5 migration.** `foldLegacyConditions` reads `no_checks_after: X` as `{policy: 'pass', after: X}`, so stored v5 behaves identically. The designer saves the new spelling with `require_mergeable` as the default for a newly added condition only.

### P4 · Concurrency on a key

```ts
export const ConcurrencySchema = z.strictObject({
  key: z.enum(['$repo', '$repo+$kind']),
  max_in_flight: z.number().int().min(1).max(10),
  scope: z.array(StateNameSchema).min(1).max(10),        // count tickets whose session is in these states
  order: z.literal('oldest_first').default('oldest_first'),
  overlap: z.literal('planned_files').optional(),        // hold only when file lists intersect
  hold_timeout: DurationSchema,                          // then on_unmet.else (rule 20)
});
// TransitionRequiresSchema gains `concurrency: ConcurrencySchema.optional()`.
```

- **Engine.**
  - Phase `held` runs before `checks`. The orchestrator computes the holders, meaning sessions with the same key that are in a `scope` state, are not `done/failed/lost`, and, with `overlap`, whose `files` intersect.
  - At or above `max_in_flight`, the step waits: status `waiting_external`, no worker, no machine slot, as in the conditions phase. The hold record (`step.hold = {behind: [ticket ids], since}`) shows on the card as "Queued behind #N".
  - Release happens on the P1 Q1 triggers (a holder leaving scope), plus a poll at `condition_poll`. Ties go oldest first by `step.started_at`.
  - Release continues the move with `cause: 'concurrency_released'` recorded on the eventual `state_entered`. `hold_timeout` goes to `on_unmet.else`, kind `timeout`.
  - The check is pure over a holders list the wrapper passes in as an event (`concurrency.checked {holders}`), so `apply()` stays pure.
- **`overlap: planned_files`** reads a `files: string[]` key from the planning result. Planning prompts ask for it (T7).
  - **It holds only when both sides have `files` and the lists intersect** (path globs, matched like `PathGlobSchema`).
  - A session without `files`, or a holder without them, makes no overlap claim, so there is no hold. Until planning reliably emits `files`, the primitive does nothing rather than serialising the repo.
  - Without `overlap`, the hold is by key alone, which is the explicit "one at a time" for a user who wants it.
  - *Alternative (recorded, not chosen):* treat missing `files` as overlapping everything, and leave `requires.concurrency` out of v6 until T7 has seen `files` on 20 consecutive plans. Rejected because the safe default is "no evidence, no hold". A primitive that silently serialises five parallel tickets fails worse than one that occasionally lets a conflict through to the P1 watch.
- *As built (T7):*
  - **The wrapper translates the timer.** apply keeps a held step's `state_deadline` armed ("check me"); the EngineService wrapper replaces that `timer.fired` with `concurrency.checked {holders}`, computed in its transaction under a per-repo advisory lock, so two held tickets are never released by racing transactions. No new sweep and no nested apply.
  - **In flight** means (a) in a `scope` state, (b) in a move step past `held` on its way into one, or (c) held too and ahead in the queue (older `step.started_at`). (c) is what makes release oldest first.
  - **Nudge on any departure.** Not only the T6 triggers: any same-repo session leaving a real state or ending brings the held moves' check to now, so "Merged, done", a send-back or a cancel releases within one sweep tick.
  - **Notify.** A released move notifies as its own transition (`concurrency_released` is not an engine move for P6), so v6's PR-ready `once` push still reaches Ben; the hold itself is silent.
  - **Overlap of two globs** is approximate (TD-220): equal, one matches the other as a path, or two wildcard globs whose literal leading segments are prefix-compatible.
- **Builder.** A "One at a time" section on a transition: key, max, scope (column picker), "only when files overlap", hold timeout.
- **Insights.** Held time is its own bucket, "queued", not counted as a slow state. Releases are counted by cause.
- **v5 migration.** Absent means no hold, so nothing changes.

### P5 · Named instructions and canned human replies

```ts
const InstructionSlugSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(40);
const InstructionTextSchema = z.string().trim().min(1).max(4_000);   // literal, or `$instructions.<slug>`
// WorkflowDefinitionSchema gains `instructions: z.record(InstructionSlugSchema, z.string().trim().min(1).max(4_000)).optional()`.
// OnUnmetSchema.instruction and watch.on_broken.instruction accept a `$instructions.<slug>` ref.
// TransitionObjectSchema gains `presets: z.array(InstructionSlugSchema).min(1).max(10).optional()`.
```

- **Engine.** A ref is resolved when the move is taken, against the session's **pinned** definition, so later edits don't change a ticket that is in flight. The rendered prompt shows the text, never the ref.
- **Builder.**
  - The workflow settings gain an "Instructions" list.
  - Every instruction field gets a "use a saved instruction" picker.
  - A human button with `text` and `presets` shows the presets as chips that fill the text box, e.g. "Re-sync with main" on Request changes. The human can still edit the text.
- **Insights.** `request_changes` texts that equal a preset are counted per preset. That is the measure of whether the recipe is still typed by hand.
- **v5 migration.** Absent means none, and literal instruction strings keep working.

### P6 · Notification policy in the definition

> **Amended 2026-11-06 (T4).** The first version of P6 had a `when_waiting_on_you` mode plus an "engine-lap" rule. The M3 baseline (`scripts/analysis/notification-baseline.sql` on live history) showed it would cut pushes only 5 % (356 → 337): 54 % of pushes are hand-offs, and 51 % are returns to a state the ticket already waited in after Ben's own `request_changes`, which the lap rule deliberately still notified. Ben decided to make the policy per transition instead: a transition notifies **once** per ticket, **every** time, or **never**. `once` on the hand-offs gives "no push when the PR comes back after my review" without a lap rule, and `every` on real questions keeps each new question visible. `when_waiting_on_you`, `always`, the lap rule and the `notify_lap` snapshot field are gone. Replayed on the same history (380 pushes by then, 2026-09-07 → 2026-11-06), the v6 policy below sends 222 (−42 %): hand-offs 209 → 134, questions 86 → 79, engine stops 76 → 0.

```ts
const NotifyModeSchema = z.enum(['never', 'once', 'every']);
export const NotifyPolicySchema = z.strictObject({
  default: NotifyModeSchema,
  engine_moves: z.enum(['never', 'inherit']).default('never'),
  coalesce: DurationSchema.optional(),     // ≤ 1d (rule 23)
});
// WorkflowDefinitionSchema gains `notify: NotifyPolicySchema.optional()`.
// TransitionObjectSchema.notify widens to `z.union([z.boolean(), NotifyModeSchema, z.literal('inherit')])`:
// legacy `true` means `every`, `false` means `never`, absent means `inherit`.
// The decision: NotifyDecision = {via: string, mode: NotifyMode, decision: 'push' | 'silent'}.
```

- **Engine.**
  - **Without the top-level `notify` block**, the engine runs in **legacy mode**, which is exactly today's behaviour: every input_request pushes, and `notify: true` transitions also push. No decision is recorded.
  - **With the block,** pure `notifyDecision(def, notified_transitions, move)` (`shared/src/engine/notify.ts`) judges each real landing once, in `enter()` (a gate step that hasn't passed is not a landing):
    - a move with `cause: 'transition'` (taken by an agent, a human or an event) uses the transition's own mode, or `default` when it inherits;
    - `once` pushes the first time that transition **name** is taken on the ticket; later takes are silent. The names that pushed are kept in `notified_transitions` (the snapshot, `session.notified_transitions`), which a reopen copies, so `once` is per ticket across sessions and re-opens;
    - `every` pushes on each take; `never` never;
    - **engine moves** (any other `cause`, P7, including `start`, `answer_routed` and `fallback`): under `engine_moves: never` they are silent, even when they land at a human state through `on_unmet.else`, `retries_exhausted` or a `timeout` (those are visible on the board; Ben chose not to be pushed for them). Under `inherit` they take the mode of the transition the move was taken for (the gate's, the counted loop's), if the state left has one, else `default`;
    - a machine-lost re-ask (no move) is an engine move with via `machine_lost`.
  - The decision is recorded as `notify_decision` on the `state_entered` effect (the event payload's `notify`) and on the `create_input_request` it opens (`input_request.notify`). `watch_escalate` (P1, T6) always pushes, because the user asked for it.
  - Permission prompts (UXR-32) are not moves and always push; they are outside the policy.
- **Notifier.** One outbox row per positive decision: the question (`push_needs_input`) when the landing opens an input request, else the transition (`push_transition`, with its `transition.notified` board event); never both. A silent decision writes no row. With `coalesce`, the idempotency key is `notify:<ticket>:<state>:<floor(now / coalesce)>` (Q5), so a ticket that bounces into the same state inside the window sends one push.
- **Builder.** A Notify select (Inherit / Once per ticket / Every time / Never) beside the Plain / Asks / Hands off choice on every transition; without the block only Inherit / Every time / Never, stored as the legacy boolean (rule 23). A workflow-level Notifications section turns the policy on and sets the default, engine moves and the coalesce window; turning it off folds string modes back into the boolean.
- **Insights.** `get_process_metrics` reports `pushes`: moves that pushed and kept silent, pushes per ticket, and decisions per `via` and mode.
- **v5 migration.** No block means legacy mode, so nothing changes until Ben adds the block.

### P7 · Engine moves carry a cause

```ts
export const MoveCauseSchema = z.enum([
  'transition',            // a named transition taken by an agent, a human or an event
  'start',                 // T2: the first entry into the start state (actor system)
  'check_failed', 'review_unmet', 'action_failed', 'condition_unmet', 'condition_timeout',
  'watch_broken', 'concurrency_released', 'timeout', 'retry', 'retries_exhausted',
  'budget_exceeded', 'machine_lost', 'answer_routed',
  'fallback',              // T2: no route for an outcome, sent to the fallback human state
]);
// MoveRecord / state_entered gain `cause: MoveCause` (always set from T2 on) and keep
// `{transition, reason, actor}`; engine moves set actor 'system' (TransitionActor has it already),
// transition = the move-step's transition name when there is one, reason = one line.
// StateEnteredPayloadSchema (api/rest.ts) and MoveDto gain `cause: MoveCause | null` (null = before T2).
```

- **Engine.** Every `enter()` call site passes a cause, and `moveFields` stops returning `{}` for unnamed entries. A unit test enumerates every `enter` call in `apply.ts` and fails on a missing cause.
- **As built (T2).**
  - The 2026-11 metric fixes (FR-5) had already recorded most engine routes, as actor `engine` with an `ENGINE_MOVE` transition name. T2 adds `cause` to every entry and writes new engine moves with actor `system` and the gate's (or engine outcome's) transition name. Rows written before T2 keep actor `engine` and have no cause. Readers go through `isEngineMove` / `isNamedMove`, which accept both. They never use `actor === 'system'` alone, because an event's transition is a named `system` move.
  - Two causes were added to the list above:
    - `start`, because a first entry is neither a transition nor an engine route;
    - `fallback`, for an outcome with no route (today's `ENGINE_MOVE.fallback`) and for a name the agent may not take.
  - The mapping:
    - a failed agent, command or connector outcome (`fail`/`error`) taking the workflow's route is `retry`, and its counted loop's `else` is `retries_exhausted`;
    - an unmet gate's cause comes from the phase that found it (checks, review, conditions);
    - a gate that cannot finish is `action_failed`, `timeout`, `condition_timeout` or `review_unmet`;
    - an unnamed legacy outcome (`done`, `exit_0`, an event's name) is `transition`, under its own name and the state's actor.
  - `answer_routed` is a human's move (actor `human`), but not a named transition: under P6 (T4) it is an engine move, silent under `engine_moves: never` (it lands back in the asking agent, so nobody waits on Ben).
- **Builder.** None. The card history shows "Sent back: checks failed (Tests pass)".
- **Insights** (feeds bb5e7d0d):
  - Re-entry loops are keyed by `(from, transition name, cause)`, never by the versioned `goto`. This fixes 2.6.2, where the same gate before and after v5 was counted twice.
  - Moves with `cause: null` show as "unrecorded (before ADR-0037)" instead of feeding re-entry counts (2.6.6).
  - Check runs are attributed to the move step's source state and transition, not `unknown` (2.6.3).
- **v5 migration.** Additive on the payload (jsonb, no migration); old rows read as `null`.

### P8 · A hand-off is not a question

```ts
// TransitionObjectSchema gains `handoff: z.boolean().optional()`; exclusive with `question` (rule 22).
// InputRequestKindSchema gains 'handoff' (additive DB value).
```

- **Engine.** A `handoff` transition into a human state opens an input_request of kind `handoff` with the agent's `reason` as the summary, and is otherwise identical to `question: true` (result kept, `return_to` set).
- **Status line.** `status_line` reads "Ready for review: <summary>", not "the agent asks: …".
- **Builder.** The transition's "asks a question" toggle becomes a three-way choice: Plain / Asks a question / Hands off for review.
- **Insights.** "Questions" counts only `agent_question`. Hand-offs get their own count (fixes 2.6.1).
- **Notifications.** Under P6 a hand-off is a normal named move; v6 sets the hand-offs to `once`, so a ticket's first hand-off pushes and the returns after `request_changes` don't.
- **v5 migration.** `question: true` keeps its meaning, so nothing changes until a transition is switched to `handoff`.

### Validation on save (new rules 19–25)

Rule numbers continue [05 §Validation on save](../design/05-workflow-engine.md#validation-on-save-m1-t03) (1–18 on `main` today). Paths follow the existing style.

19. **Watch.**
    - Only on `human` and `event` states, which the schema enforces.
    - `on_broken.goto` exists, is not the watched state, and has no ADR-0010 `entry`.
    - `on_broken.else` is a `human` state.
    - `return_to` is `$self` or an existing state.
    - Every `cmd` condition has a unique `name`.
    - For rule 4, `on_broken.goto` is a bounded edge (counter `watch:<state>`) and `else` is an edge.
20. **Concurrency.**
    - Only in a transition's `requires`, on an agent-actor transition.
    - `scope` names existing non-terminal states.
    - `hold_timeout` is set.
    - `on_unmet` is present (rule 13 already requires it when `requires` is).
21. **Instructions.**
    - Every `$instructions.<slug>` reference in `on_unmet.instruction`, `on_broken.instruction` and `presets` names a key of `instructions`.
    - `presets` appears only on a human-actor transition with `text`.
    - An unused instruction is allowed.
22. **Hand-off.**
    - `question` and `handoff` are not both true.
    - `handoff` appears only on a transition into a `human` state.
    - Rule 12 is unchanged: a hand-off doesn't count as the state's way to ask.
23. **Notify.**
    - Transition `notify` string values (`'inherit'`, `'once'`, `'every'`, `'never'`) need the top-level `notify` block. Without it, only the legacy boolean is meaningful.
    - `coalesce` ≤ 1d.
24. **Condition placement.**
    - `age_below` is allowed only inside a `watch`, where the age is the stay.
    - `cmd` conditions need a repo, so they are refused in a workflow whose tickets can have no repo. That is none today; the check is kept for the routine workflow.
25. **No-CI policy.** `no_checks` and `no_checks_after` are not both set on one condition.

**Rule 14 grows** the "not available yet" list. Until its ticket marks it available, each of these is refused at its path:
- `watch` (T6);
- the `cmd` / `pr_mergeable` / `age_below` conditions and `no_checks` (T5);
- `requires.concurrency` (T7, available);
- `instructions` refs and `presets` (T8);
- the `notify` block and string notify values (T4, available);
- `handoff` (T3).

`validateWorkflow(def, {allowUnavailable: true})` skips that refusal, for tests and for the v6 draft.

### Draft v6 and repo checks (FR-3)

[`conductor.v6.draft.json`](../design/workflows/conductor.v6.draft.json) is the live v5 plus only the fields above:
- `instructions` holds `resync_main` (the recipe Ben typed four times on 2026-11-05) and `fix_and_resubmit` (v5's `on_unmet` text, now referenced from all three PR gates).
- Top-level `notify {default: once, engine_moves: never, coalesce: 15m}` (T4). `personal_pr_ready_for_review`, `pr_ready_for_review` and `ready_for_testing`: `once`; `ask_user`, `plan_needs_approval`, `scope_changed`, `needs_product_context`, `impossible` and `needs_approval_to_message`: `every`.
- `pr_ready_for_review` and `personal_pr_ready_for_review` change from `question: true` to `handoff: true`. Each gains `requires.concurrency` (`$repo`, 1, scope `[in_review]`, `planned_files`, 1d). Under P4's "both sides have `files`" rule this holds nothing until planning emits `files`, so it is safe to save before T7 has evidence that `files` are reliable.
- All three PR gates move from `no_checks_after: 5m` to `no_checks: {policy: require_mergeable, after: 5m}`.
- `in_review.watch`:
  - its only condition is `pr_mergeable`, one `gh` call per poll with no checkout. "Merges cleanly with main" stays a pre-PR repo check (below) rather than a watch `cmd`: in review, GitHub's mergeability answers the same question for free. The `cmd` form (`needs: checkout`) remains available for a repo where it doesn't;
  - `on_broken` sends the ticket to `implementing` with `$instructions.resync_main`, `return_to: $self`, 3 retries, else `needs_input`.
- `in_review.request_changes` gets `presets: [resync_main]`.
- `needs_input.watch`: an `age_below 2h` condition with `on_broken: {notify: escalate}` (the question SLA).

**Saved (T9).** The live `conductor` v6 is this draft without `requires.concurrency`: [`conductor.v6.json`](../design/workflows/conductor.v6.json), checked by `conductor.v6.test.ts`. U-120 (are planning `files` reliable?) is undecided, so concurrency comes in a v7 edit once it passes.

[`conductor.repo-checks.draft.json`](../design/workflows/conductor.repo-checks.draft.json) is the `set_repo_checks` payload for `github.com/benjgrad/conductor`:
- setup: `pnpm install --frozen-lockfile && git fetch -q origin && git branch -f main origin/main`, which fixes 2.3's stale local `main`;
- checks: typecheck, lint, test, build, and "Merges cleanly with main". The ticket template's promise that this check runs becomes true.

**Verification.** The draft can't go through `validateWorkflow` until T1 lands the schema. Until then, `packages/shared/src/workflow/conductor.v6-draft.test.ts` does two things:
- it lowers every ADR-0037 field to today's spelling and checks that the result validates with the current `validateWorkflow`;
- it asserts the exact list of proposed fields (so the draft is "v5 plus this ADR" and nothing else), and hand-checks rules 19–22 on the raw JSON.

T1's acceptance replaces that test with `validateWorkflow(draft, {allowUnavailable: true}).ok`.

**Nothing in 2.1, 2.2 or 2.5 needed an engine special case.** One gap turned up and is closed by an existing primitive rather than a widened special case:
- `cmd` on a human state needs a checkout, which the check runner already provides (P1, "where a `cmd` condition runs"). Its cost is bounded by `needs: checkout` and the in-order short-circuit, and the draft avoids it by using `pr_mergeable`.

Two behaviours are deliberately *not* expressed:
- **"Proceed with the recommended answer after 2h"** would also be expressible: `needs_input.watch.on_broken.goto: $return_to` with an instruction. The draft uses `escalate` instead, because auto-answering is a product decision for Ben, not a spike default. A watch `goto: "$return_to"` would need rule 19 to accept `$return_to` as a target; that small extension is recorded as an option, not added.
- **Throttling repeated hand-off notifications** for a ticket that bounces is covered by P6's `once` on the hand-off transitions (only a ticket's first hand-off pushes) and, for other bounces, by `coalesce`. No per-ticket cap was needed.

### Coverage table (every item in the review's §2)

| Item | Covered by | Config line (v6 draft / repo checks / other) |
|---|---|---|
| 2.1 PR waits in In review while main moves | P1 + P2 | `in_review.watch` with `pr_mergeable` (the `cmd` merge-tree form stays available) |
| 2.1 Ben retypes the re-sync recipe | P5 | `instructions.resync_main`, `on_broken.instruction`, `request_changes.presets` |
| 2.1 Thrash: #174 re-synced, #177 merged, again | P4 (prevention) + P1 retries bound | `requires.concurrency` on both PR-ready transitions, `overlap: planned_files`; `on_broken.retries: 3 → needs_input` |
| 2.1 No CI on a conflicting PR counted as a pass | P3 | `no_checks: {policy: require_mergeable}` on the three PR gates |
| 2.1 `on_unmet` "merge main first" never fires for a conflict | P3 + P1 | the gate now fails on a conflict, so `on_unmet` runs; in review the watch sends it back |
| 2.1 Template promises "Merges cleanly with main", never configured | config | repo checks draft: "Merges cleanly with main" check |
| 2.1 `in_review` can't keep watching | P1 | `watch` on human states |
| 2.2 `needs_input` 301 h, questions idle 37–52 min | P1 + P2 (`age_below`) + P6 | `needs_input.watch` `age_below 2h → notify: escalate` |
| 2.2 `needs_input` re-entries inflated by hand-offs | P8 | `handoff: true` on PR-ready transitions (they land in `in_review`, not counted as questions) |
| 2.2 `in_review` 89 h / 52 re-entries | P1 + P4 | conflict re-syncs happen without Ben; held tickets queue instead of conflicting |
| 2.3 Stale local `main` in worktree | config | repo-checks `setup` … `git branch -f main origin/main` |
| 2.3 `pnpm install` / `cargo-nextest` missing | config | repo-checks `setup` (pnpm); cargo-nextest is a machine-setup task, not a primitive |
| 2.3 method-platform-ui MSBuild setup, `mtd build` | not a primitive | repo-checks for that repo (fix the elevated IIS stop); out of scope here |
| 2.3 fitness-coach ruff | not a primitive | prompt / pre-commit for that repo |
| 2.3 Checks named `npm test` on a Rust repo | config | per-repo checks (ADR-0030) with real names |
| 2.4 Oversized tickets, unrelated fixes, late test updates | not a primitive | prompt and ticket-template edits (proposal §4); `proposed_tickets` already exists (ADR-0034) |
| 2.5 Too many notifications | P6 | top-level `notify` block, `engine_moves: never`, `coalesce: 15m` |
| 2.5 Each rework / re-sync lap re-notifies | P6 `once` (T4) | the hand-offs are `once`: a return to `in_review` after `request_changes` or a watch re-sync is silent; engine moves never push |
| 2.5 PR summary notified as a question | P8 + P6 | `handoff: true`; one push for the ticket's first hand-off |
| 2.5 No notify flags in `get_workflow` | FR-5 | explained above; P6 replaces the opt-in boolean with a policy |
| 2.6.1 Hand-offs counted as questions | P8 | Insights counts `agent_question` only |
| 2.6.2 Same gate counted per versioned goto | P7 | loops keyed by `(from, transition, cause)` |
| 2.6.3 Check runs in state `unknown` | P7 | move step's source + transition on every check run |
| 2.6.4 Findings titled with the shell command | P2 labels | bb5e7d0d uses `name`/`label` |
| 2.6.5 Waiting-by-design states flagged slow | P4 "queued" bucket + bb5e7d0d | bb5e7d0d: "waiting on others" tile |
| 2.6.6 Null engine moves | P7 | `cause` on every `state_entered` |
| 2.6.7–2.6.9 Status mismatch, spend 0, 6 % sample | bb5e7d0d | not a workflow primitive |
| 2.6.10 "Merges cleanly" invisible to Insights | config + P2 | the check and the `cmd` condition both carry the name |

### Implementation tickets (FR-4)

Order: T1 (schema) first; P7 and P8 next, because Insights and notifications read them; P6 before anything that adds engine moves (P1, P4); P1 and P2 before the v6 config.

| # | Ticket | Files owned | Acceptance | Depends on |
|---|---|---|---|---|
| T1 | Schema + validator for P1–P8, all "not available yet" | `packages/shared/src/workflow/schema.ts`, `validate.ts`, `validate-transitions.ts`, `packages/shared/protocol-json/**`, `crates/conductor-protocol/src/generated.rs`, `docs/design/10-contracts.md` (drop "proposed") | Every schema above parses; rules 19–25 each have a failing and a passing case; rule 14 refuses each field; `validateWorkflow(v6 draft, {allowUnavailable: true}).ok`; the v6-draft test switches to that; v1–v5 still validate unchanged | none |
| T2 | P7 move causes | `packages/shared/src/engine/apply.ts`, `engine/transitions.ts`, `api/rest.ts` (`StateEnteredPayloadSchema`, `MoveDto`), orchestrator insights grouping (`orchestrator/src/advisor/**`) | Every `enter()` call passes a cause (enumerating test); engine moves record `actor: system`; Insights loops keyed by `(from, transition, cause)`; old rows parse as `cause: null` | T1 |
| T3 | P8 hand-off | `apply.ts`, `domain.ts` (`InputRequestKindSchema`), an additive orchestrator migration for `handoff`, `api/cards*.ts` (`status_line`), web request preview / designer toggle | A `handoff` transition opens a `handoff` input_request; status line "Ready for review: …"; Insights question count excludes it; `question: true` behaves as before | T1 |
| T4 | P6 notify policy | `engine/notify.ts` + `apply.ts` (decision), `orchestrator/src/push/*` (coalescing), `orchestrator/src/engine/service.ts`, `web/src/workflow/TransitionEditor.tsx` (select) | Legacy mode byte-for-byte today's pushes (existing push tests unchanged); with the block, `once` pushes a transition's first take per ticket, `every` each take, engine moves never push under `engine_moves: never`; coalesce bucket dedupes. `apply.notify.test.ts`: (a) a `once` hand-off pushes, then not after `request_changes` or a reopen; (b) `every` pushes each take; (c) two `ask_user` push twice; (d) `retries_exhausted` silent under `never`, the transition's mode under `inherit`; (e) legacy mode; (f) the coalesce key | T2, T3 |
| T5 | P2 conditions + P3 no-CI policy | `packages/shared/src/engine/conditions.ts`, `crates/conductor-daemon/src/actions/conditions.rs`, `packages/daemon/src/actions/conditions.ts`, `crates/conductor-daemon/PARITY.md`, `web/src/workflow/ConditionFields.tsx` | `cmd` runs in the fresh checkout, with no repo setup for `needs: checkout`; watch evaluation short-circuits in order (a `cmd` after a failing `pr_mergeable` is never sent); `pr_mergeable` maps MERGEABLE/CONFLICTING/UNKNOWN; `age_below` engine-side; `no_checks_after` folds to `{pass}`; `require_mergeable` fails a conflicting PR with no checks | T1 |
| T6 | P1 watch | `apply.ts` (watch timer, `watch_broken`), `orchestrator/src/engine/service.ts` + scheduler (same-repo merge trigger), web column panel | Watch fires only on `failed`; bounded by `retries` then `else`; disarmed on leave; same-repo merge re-evaluates within one tick; property test: every watch path ends at a human | T2, T4, T5 |
| T7 | P4 concurrency holds | `engine/move-step.ts`, `apply.ts`, orchestrator holders query, planning prompt `files` key, `api/cards*.ts` ("Queued behind #N") | Held at max; released oldest-first on the shared trigger; `hold_timeout` → `else`; with `planned_files`, no hold unless both sessions have `files` and they intersect (a session without `files` is never held, nor holds others) | T2, T4, T6 |
| T8 | P5 instructions + presets | schema refs (from T1), `engine/render.ts` (resolve), web human-button presets and workflow settings | Refs resolve against the pinned version; presets fill the text box; unresolved refs refused (rule 21) | T1 |
| T9 | Config: save v6, set repo checks | none (MCP `save_workflow`, `set_repo_checks`); ticket template line | v6 saved from the draft; `get_repo_checks` shows the five checks; Insights shows how often holds happen once `files` appear; a conflicting PR in review is sent back without Ben | T5, T6, T7, T8 |

## Alternatives considered

| Option | Why not |
|---|---|
| Special-case "re-sync on conflict" in the engine | Fails the §1 test: only useful for one process, invisible in the builder. |
| GitHub webhooks for merge events | A new inbound service per repo (auth, self-hosting); conductor already knows about its own merges. Kept as a revisit. *R11 (2026-11-11) added them as an optional accelerator on top of polling, not a replacement (see the amendment under Q1).* |
| `concurrency` on the target state | Holding *after* the checks ran means checking a branch that goes stale while held; a state-level hold also has no natural timeout leg. |
| Make `question` an enum | Rewrites stored definitions and every `question === true` reader for no gain over an exclusive flag. |
| Coalesce in the engine | Needs wall-clock windows and DB state in the pure `apply()`. |
| Reuse prompt templates for instructions | Templates are code constants, not definition data; they can't be edited in the builder. |

## Consequences

- **Good.**
  - The three manual fixes become workflow edits that the designer can show and change.
  - Engine moves are explainable (P7), which unblocks bb5e7d0d.
  - Notifications follow one written policy instead of two hidden paths.
- **Bad / accepted cost.**
  - A `cmd` watch on a human state costs a fresh checkout per poll on the session's machine. That is bounded by `needs: checkout`, the in-order short-circuit and polling backoff, and the v6 draft uses only `pr_mergeable`.
  - With `planned_files`, concurrency prevents nothing until planning emits `files`; until then the P1 watch is the only defence against conflicts.
  - The definition grows. The designer has to stay readable, so each primitive gets a collapsed panel.
- **Follow-ups (Tracking, for the daily sync).**
  - U-row: webhooks for watch and concurrency-release latency (deferred by Q1).
  - U-row: does planning reliably emit `files` for `overlap: planned_files`?
  - U-row: should a watch be able to `goto: $return_to` (auto-proceed on a stale question)?
  - Tickets T1–T9 above.
  - Recorded alternative to P4's "both sides have `files`" rule: missing `files` overlaps everything, with concurrency added to v6 only after `files` appear on 20 consecutive plans.

## Revisit when

- Insights shows median P4 release latency above 5 min, or the merges that break watched PRs mostly happen outside conductor. Either is the trigger to reconsider webhooks. *(R11 added optional webhooks for watches and conditions; a held P4 move is still released only by the internal triggers and its poll.)*
- A second workflow needs the same `instructions`, which would make shared instructions worth having.
- Users ask for a notify mode other than the three listed.
