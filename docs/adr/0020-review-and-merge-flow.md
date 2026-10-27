# ADR-0020 · Review and merge: In QA, Ready to merge, and Done only through a merge

- **Status**: proposed (design approved by Ben 2026-10-27; this write-up awaits his acceptance)
- **Date**: 2026-10-27
- **Deciders**: Ben (+ Claude planner session https://claude.ai/code/session_01NhmNbZ2iRArH99MxNSABmj)
- **Resolves**: U-083 (Done with an open PR), once accepted. Raises U-085..U-091.
- **Builds on**:
  - [ADR-0009](0009-transition-requirements-review.md): the independent reviewer, forced `dontAsk`, verdict fencing, separate Claude conversations;
  - [ADR-0010](0010-one-workflow-columns-are-states.md): `open_pr`, fresh checkouts of the exact commit, `head_sha` pinning, the hardened gh/git pattern;
  - [ADR-0011](0011-transition-rules.md): named transitions, `requires` / `on_unmet`, actors, kinds, human moves;
  - [ADR-0016](0016-work-connectors-on-the-users-machine.md): `gh` on the user's machine, the `pr_merged` condition, head pinning in `evaluate_conditions`;
  - [ADR-0019](0019-ticket-requirements-and-verification.md): ticket sections, the review evidence layer, the QA post.

## Context
Ben, 2026-10-27: *"We shouldn't be putting the tickets in 'Needs input' and allow the user to mark it as done if it can't be merged. The call to action should match the expected outcome."*

The dogfood flow today (`conductor_dev` v2, the same shape as `conductor` v2):
- `implementing → personal_pr_ready_for_review` (checks, then `open_pr`) → **Needs input**;
- the card then offers **Done** and **Back with this answer**.

The real next step is a QA review, then a merge. The board offered neither. So Ben merged PRs on GitHub and clicked Done before the lead's QA had run. Five PRs were merged before review, and the QA of two of them then found real bugs. U-083 asked whether Done on an open PR should warn; this ADR replaces the warning with the right flow.

Engine invariants bind every choice here: transitions only on outcomes; every loop bounded; every failure path ends at a human; state and commands in one transaction; idempotency keys on external side effects.

## Decision
**After the PR opens, the ticket goes to In QA, where conductor runs an independent QA session on the exact PR commit. A pass moves it to Ready to merge, whose only call to action is Merge (a real merge by conductor, pinned to the commit QA reviewed) or Request changes. Done is reachable only through that merge or through an explicit "Close without merging" with a reason.**

### 1 · The flow

```
Implementing ──pr_ready (checks, open_pr)──▶ In QA (agent, role qa)
In QA ──qa_pass──▶ Ready to merge (human)
In QA ──qa_fail──▶ Implementing (findings attached; ≤ 3 rounds, then Needs input)
In QA ──qa_needs_human──▶ Needs input
Ready to merge ──merge (approvals, merge_pr)──▶ Done (merged)
Ready to merge ──request_changes (text)──▶ Implementing
Needs input ──close_without_merging (reason, close_pr)──▶ Done (closed, not merged)
```

| Column | State (type) | Who acts | Call to action on the card |
|---|---|---|---|
| Implementing | `implementing` (agent) | the worker | — |
| **In QA** | `in_qa` (agent, `role: qa`) | conductor's QA session | none; the card says "Conductor is reviewing · round n/3" (not "needs you") |
| **Ready to merge** | `ready_to_merge` (human) | Ben | **Merge** (primary), Request changes |
| Needs input | `needs_input` (human) | Ben | Back with this answer, Back to Implementing, Close without merging |
| Done | `done` (terminal) | — | badge `merged` or `closed, not merged` |

### 2 · In QA: a full agent state with the reviewer's independence
In QA is an ordinary **agent state**, so it is a column, has a timeout, names its outcome as a transition, and shows its transcript. It is **not** the lightweight `requires.review` step (ADR-0009/0011): that one judges a short list of items inside a move step and leaves no column. QA needs a whole session: it reads the diff, runs targeted tests and grades every requirement.

A new agent-state field **`role: 'qa'`** gives it the ADR-0009 reviewer's independence:
- **Fresh conversation.** Every visit starts a new Claude session (never `--resume`), and its Claude session id is kept in `context.__qa.claude_session_id`, never in `session.claude_session_id`. The worker resumes its own conversation after a `qa_fail`, and a reopen (ADR-0008) never resumes the QA session. The start carries `review: true`, so the daemon also keeps its id out of `PersistedSession.claudeSessionId`.
- **Fenced.** Entering In QA bumps the fencing token, as entering a gate step does (ADR-0010 security notes). A late event from the worker (a second `complete_state`, `no_outcome`) is refused as `stale_fencing_token`, so it can never be taken as the QA's outcome.
- **Forced `dontAsk`** (ADR-0009 implementation notes). Only pre-approved tools run: the new **`qa` tool alias** (Read/Glob/Grep; the exact git inspection commands, plus fixed `qa-base` diff commands; and test runners: `pnpm test:*`, `pnpm vitest:*`, `pnpm exec vitest:*`, `pnpm typecheck`, `pnpm lint`, `npm test:*`, `npm run:*`). It has no Edit/Write, no `git add` / `commit`, no `gh`, and `git push` stays denied. Test runners execute repository code, so this is not a security boundary (U-004, TD-019). What it guarantees is that QA has no tool to change the PR (U-085).
- **Live messages are refused** (`operator.message` → `wrong_status`), as for reviewers. A human who disagrees answers in Needs input or uses Request changes.

**Where it runs: a fresh checkout of the PR head, not the worktree.** On entering In QA the engine sets `context.__qa.head_sha`:
- normally the commit conductor checked and pushed (`step.head_sha` of the move step, which `open_pr` pushed and now records as `context.__pr.head_sha`);
- after a "head moved" refusal (§4), the PR head that `merge_pr` observed.

`start_session.checkout = {sha, setup}` tells the daemon to build a fresh checkout before Claude starts. It reuses `actions/checkout.ts`: an ephemeral 0700 repo under `<root>/private/qa-*` with git's minimal config. The difference is the source: it fetches from the **trusted remote URL** (`cloneSource(ticket.repo)`, the same allow-list as `open_pr`), not the worktree, and the PR head must equal `sha`. It also fetches the default branch and creates the ref `qa-base` at the merge base, so the prompt's diff commands are fixed strings the `qa` alias can pre-approve (`git diff --stat qa-base...HEAD`, `git diff qa-base...HEAD`, `git log --oneline qa-base..HEAD`). Then it runs the state's `setup` (`pnpm i --frozen-lockfile` for `conductor_dev`). The checkout is deleted when the QA process ends.

So QA reads exactly the commit that will be merged. It never sees worktree-only or uncommitted files, and it works the same after someone else pushed to the PR. A tip that differs from `sha`, or a failed fetch or setup, refuses the start; the engine sends that to Needs input with the reason (`agent_question`, not counted).

**The prompt** (`qa_template`, rendered by the engine; it has no repository files):
1. **Role:** "You are the QA reviewer for PR <url> at commit <sha>, round n of 3. You cannot change the code. Find what is wrong and report it."
2. **Checklist:** "If the repository has `.claude/agents/qa-reviewer.md` and `docs/qa/QA_CHECKLIST.md`, read and follow them, except: you report through `complete_state`, not a message, and you don't re-run the full gates." Otherwise, a built-in default checklist: correctness, tests that assert the right thing, scope against Out of scope, design-doc drift, secrets, and unbounded loops or retries.
3. **What conductor already proved:** the names of the checks that passed on this exact commit (the transition's `requires.checks`; with M2c, the persisted `check_run` rows with durations), including "Merges cleanly with main" when the workflow has it. "Don't re-run these; run targeted tests for the changed areas."
4. **The ticket:** title and body. With M2c's parser, the FR / NFR list and the **Verification table** come out parsed. Before M2c, the raw `## Verification` and requirement sections are extracted by heading (§7).
5. **The diff:** the fixed `qa-base` commands above.
6. **On a re-QA:** the previous round's required fixes, so QA checks each one.
7. **How to finish:** the three transitions and the result schema below.

**Outcomes** (agent transitions out of `in_qa`; the agent names one with `complete_state {transition, reason, result}`):

| Transition | Goes to | Result must have |
|---|---|---|
| `qa_pass` | Ready to merge | `verdict: 'pass' \| 'pass_with_debt'`, no `required_fixes` |
| `qa_fail` | Implementing, with the findings attached; counted `in_qa->implementing`, `retries: 3`, `else: needs_input` | `verdict: 'fail'`, ≥ 1 `required_fixes` |
| `qa_needs_human` (`question: true`) | Needs input; the reason is the question | — |
| `ask_user`, `timeout` (fallbacks) | Needs input | — |

**`QaResult`** (shared zod, sizes capped like ADR-0019's claims; model text, no command output, U-045):
- `verdict`;
- `requirements?: [{req, met, reason ≤ 1 000}]` (ADR-0019 §4 shape, ≤ 50);
- `findings: [{severity: blocker|major|minor|nit, text ≤ 1 000, file?, line?}]` (≤ 50);
- `required_fixes: string[]` (≤ 20, each ≤ 1 000);
- `debt: [{text, site?, payoff?}]` (≤ 20);
- `unknowns: [{question, why}]` (≤ 10);
- `tests_run: [{cmd, result: pass|fail, note?}]` (≤ 20);
- `summary` (≤ 2 000).

A result that doesn't parse, or that doesn't match its transition (a `qa_pass` with `verdict: 'fail'`, a `qa_fail` without fixes), gets the reviewer treatment: one nudge that resumes the QA's own conversation and says what was wrong, then Needs input (`retries_exhausted`, "QA produced no usable verdict").

**The bounded loop.** `qa_fail` is a counted failure loop (`isCountedTransition`: it has `retries` / `else`). Rounds 1–3 go back to Implementing. The fourth `qa_fail` goes to Needs input, with a question listing the open required fixes. The loop runs through the move step's checks and `open_pr` on every round, so each round QA reviews a new, checked, pushed commit. A human's **Request changes** or **Back to Implementing** resets the counter, because a human decision opens a new round of three. Every round costs a human or ends at one, so the loop stays bounded (validator rule 4).

**Findings reach the worker** through a new **`attach: 'result'`** value. The target's prompt gets `## Sent back by In QA`, then the QA's reason, the required fixes (numbered), the findings at blocker and major severity, and "Fix every required item, commit, then finish again." It is rendered from `context.in_qa` (the state's stored result), not from a transient attachment, so a requeued visit renders it too. This avoids the `attach: output` TD in apply.ts.

### 3 · Ready to merge: a human state with two transitions
- **`merge`** (actor human) → Done, with `requires: {approvals?, actions: ['merge_pr']}`:
  - `on_unmet: {goto: 'implementing', instruction: 'Merge origin/main into your branch (never rebase), resolve, commit, then finish again.', retries: 2, else: 'needs_input', routes: {head_moved: 'in_qa'}}`.
  - The new optional **`on_unmet.routes`** maps an action's unmet `reason` to a different `goto`. It is bounded by the same counter and validated like `goto`: the target exists, isn't terminal, and has no `entry`.
- **`request_changes`** (actor human, `text: 'required'`) → Implementing. The text reaches the worker as `## Answer from a human`, and the QA round counter resets.

There is no plain Done, no "Back with this answer", and no "Waiting on someone else" while the PR is open.

### 4 · `merge_pr` (and `inspect_pr`, `close_pr`): daemon actions
All three are `run_action` actions on the session's machine, following `open_pr`'s hardening (`packages/daemon/src/actions/open-pr.ts`):
- the PR URL comes from `context.__pr.pr_url`, written only by the engine from `open_pr`'s result and matched against `GITHUB_PR_URL_RE`;
- `--repo <owner>/<name>` comes from the daemon's trusted store (`pushTarget(cloneSource(ticket.repo))`), never from agent-writable git config;
- gh runs in the daemon root, outside every repository, after `gh --version` passes the `GH_MIN_VERSION` floor (raised if `--match-head-commit` needs it);
- they use only gh. No git runs, so nothing an agent planted in the shared clone runs either.

**`merge_pr {pr_url, expected_sha, method: 'merge', approved_paths: string[]}`**, idempotency key `session:merge:<visit>`:
1. `gh pr view <url> --repo R --json state,mergedAt,mergeCommit,headRefOid,mergeable,mergeStateStatus,files`.
2. `state = MERGED` → **success** `{merged: true, already: true, merge_commit_sha, head_sha}`. This is what makes the action idempotent: a retry after a lost ack, or Ben having merged on GitHub, both end in Done. A merged head different from `expected_sha` is recorded as `note: 'merged a different head'` and shown on the Done card.
3. `state = CLOSED` → unmet, reason `closed`, → `else` (Needs input: "The PR was closed on GitHub. Reopen it and answer, or Close without merging").
4. `headRefOid ≠ expected_sha` → unmet, reason `head_moved`, `observed_sha`, → `routes.head_moved` = **In QA**, which reviews the new head (§2). Counted.
5. `mergeable = CONFLICTING` → unmet, reason `conflict`, → Implementing with the instruction. Counted.
6. Any changed file matching the transition's approval `paths` and not in `approved_paths` → unmet, reason `approval_missing` → `else`. This is defence in depth; the engine checks first (§5).
7. `gh pr merge <url> --repo R --merge --match-head-commit <expected_sha>`. GitHub refuses if the head moved in between (→ `head_moved`), and branch protection still applies: required checks and reviews are never bypassed (no `--admin`). A refusal for protection reasons (`mergeStateStatus` BLOCKED, or "required status check") → reason `blocked`, → `else` with gh's message. Other gh errors (auth, network) → reason `error`, → `else`.
8. Success → `{merged: true, already: false, merge_commit_sha, head_sha}`. The engine writes `context.__pr.merged = {at, merge_commit_sha, by: actor}`.

- **The merge method is a merge commit** (`--merge`), matching every merge on `main` today ("Merge pull request #29 …"). It is per-transition data, `args.method`, defaulting to `merge`; squash and rebase can be added when a repo wants them.
- **The branch is not deleted** (no `--delete-branch`), matching today, where conductor branches stay on origin. Worktree and branch GC is M2-T13's.
- **When main moved after QA** (U-087): the merge goes ahead without a re-QA when GitHub says the PR is still mergeable; a conflict goes back to Implementing, then checks, then a fresh QA. QA judged the change, `--merge` doesn't rewrite it, and the "Merges cleanly" check plus GitHub's mergeability cover the integration. Re-QA on every main move would serialise all merges behind QA runs.

**`inspect_pr {pr_url, approval_paths}`** runs on the `qa_pass` transition (`requires.actions: ['inspect_pr']`). It reads `gh pr view --json headRefOid,files,mergeable,state` and returns:
- `{head_sha, files: string[] (≤ 300), files_truncated, mergeable, matched: {<approval id>: string[]}}`;
- the engine stores it as `context.__pr.inspect`.

If `head_sha` differs from `context.__qa.head_sha`, it is unmet with reason `head_moved` (route: In QA). Otherwise Ready to merge opens already knowing the migration file list and whether the PR is mergeable now.

**`close_pr {pr_url, reason}`**: `gh pr close <url> --repo R --comment "<reason> (closed by conductor)"`.
- An already-closed PR is success. An already-merged PR is also success, with `merged: true`: the work landed, so Done is badged `merged`.
- With no `context.__pr` (a ticket that never opened a PR), it is a no-op success.
- The branch is kept (U-089).

**Availability and machines.** The actions run on the session's machine, as `open_pr` does. If it is offline, the `run_action` waits up to `ENTRY_ACTION_TIMEOUT` (10m), then goes to `else`: "No machine online to merge: bring one online and answer". M2 routing can later send it to any of the account's online machines with `cli:gh authed` (U-091).

### 5 · The migration gate
A transition may carry **`requires.approvals: [{id, label, paths: string[] (globs), text?}]`**. These are explicit human checkboxes, allowed only on `actor: human` transitions. For `merge`:

```json
"approvals": [{ "id": "migration", "label": "Approve migration", "paths": ["packages/orchestrator/migrations/**"] }]
```

- **When it applies.** An approval is *active* when `context.__pr.inspect.matched[id]` is non-empty, or when `files_truncated` is true (fail safe). A workflow whose repo keeps migrations elsewhere edits `paths`; these are "the workflow's configured migration globs".
- **The card.** `human_transitions[].approvals = [{id, label, files}]` for active approvals. Ready to merge lists the file names under an "Approve migration" checkbox, and **Merge stays disabled until it is checked**.
- **The API.** `POST /api/sessions/:id/transition {name: 'merge', approvals: ['migration']}`. A missing active approval is ignored by apply (`approval_required`). The route answers **409 `approval_required`** with `{approvals: [{id, label, files}]}`, and nothing changes.
- **Audit.** The approvals, the user and the file list are stored on the move (`event` payload and `step.approvals`), and passed to `merge_pr` as `approved_paths` for its own re-check (§4 step 6).
- No migration is needed for any of this: state lives in `context` jsonb, the outbox kind is still `run_action`, and the event payloads are jsonb.

### 6 · Done only through a merge or "Close without merging"
- **Needs input** loses its plain `done`. It gets **`close_without_merging`** (actor human, `text: 'required'` for the reason) → Done, with `requires.actions: ['close_pr']`. It also gets `back_to_implementing` (resets the QA round counter); `answer` is kept.
- **Validator rule 15** applies to a definition that uses `merge_pr` anywhere ("merge-aware"). Every transition into a terminal state must carry `merge_pr` or `close_pr` in `requires.actions`. The fallbacks never go to a terminal state, so they are unaffected.
- **Engine guard**, for merge-aware definitions. A session whose `context.__pr` is set, and not `merged` or `closed`, never enters a terminal state except through a passed `merge_pr` / `close_pr`. An operator cancel (badge `cancelled`) and failures (`failed` / `lost`) are still allowed, because they are not claims of done.
- **Done badges:** `merged` (with the merge commit) or `closed, not merged` (with the reason). The board can no longer show Done for unmerged work without saying so.
- Old versions (v1, v2) keep their behaviour. Their running tickets finish as they started (05 §Versioning).

### 7 · Recording QA findings and debt
- **Before M2c** (this lands first):
  - the QA result is the state's result, kept as `context.in_qa` (each round overwrites it; the timeline keeps every round's transition and reason);
  - the engine writes `context.__qa = {head_sha, verdict, round, max_rounds, claude_session_id}`, a reserved name under validator rule 8;
  - the card shows `QA pass` / `QA pass with debt` / `QA fail (round n/3)`, and the detail panel shows a **QA** tab with verdict, findings, required fixes, debt, unknowns and tests run.
- **With M2c** (ADR-0019): the `in_qa` result maps onto the **review** evidence layer.
  - `requirements[]` → `record_evidence {layer: 'review', source: 'qa'}`, and `verdict` → the tally's `QA`. This is the same layer an external QA post uses (ADR-0019 §2), so the card's `FR 6/6 · … · QA pass` comes from conductor's own QA.
  - M2c-T04 picks this up (noted in the M2c file).
- **Tracking rows stay human-curated.** Agents never edit `docs/tracking/*`. QA's `debt` and `unknowns` are **proposed** rows: the QA tab shows them, with a "Copy as tracking rows" button that formats them as TD / U table rows without IDs. The lead (or `doc-keeper`) records them with the next IDs, which keeps IDs permanent and unique.

### 8 · What this replaces in the lead's lifecycle
For work that runs as conductor tickets, CLAUDE.md §3 (QA) becomes conductor's job:
- the lead no longer spawns a `qa-reviewer` per branch or merges the PR;
- In QA runs the repository's own `.claude/agents/qa-reviewer.md` checklist on the exact commit;
- Ben's Merge button merges.

The lead still:
- records the QA's proposed TD / U rows and the decisions;
- answers Needs input;
- runs the full gates on `main` after a group of merges;
- QA's branches that don't run as tickets (lead-made docs branches like this one) the old way.

The M2r docs task updates CLAUDE.md §2–3 accordingly.

### 9 · Work and personal tickets
- **Personal tickets:** the flow above.
- **Work tickets** (proposal, U-090):
  - `pr_ready_for_review` (work) also goes to **In QA**. A QA session before a teammate's review is cheap compared with the teammate's time, and it catches what the work-commit reviewer item can't.
  - `qa_pass` for a work ticket is a second transition, `qa_pass_work` (kinds `work`). It carries `requires.conditions: [pr_checks_green, pr_approvals ≥ 1]` with the M1b polling, so Ready to merge on a work ticket means "QA passed, CI green, a teammate approved". Merge is the same action. On a team repo where only others merge, `merge_pr` finds the PR `MERGED` and succeeds.
  - **`ready_for_testing` → Waiting external is unchanged** (no QA), because the testing team is the QA there. Waiting external's `ui.approve` now goes to **Ready to merge**, not Done, so a tested work ticket still ends through the merge (already merged → success).
- If Ben prefers, In QA can be personal-only in v3 by dropping `kinds` from the work branch. That is a definition edit, not an engine change.

### 10 · Default definitions
`conductor` **v3** (shared, npm checks) and `conductor_dev` **v3** (pnpm checks, "Merges cleanly with main"; stored in the pinned and hosted databases, and from now on tracked in the repo as `docs/design/workflows/conductor_dev.v3.json`). The sketch below gives the differences from v2, then the whole of the new states.

**Numbering.** ADR-0019 / M2c-T05 planned *its* prompt line as "conductor v3". M2r lands first, so M2r's definition is **v3** and M2c's prompt-line change becomes **v4** (noted in the M2c file). M5's Jira / Azure enablement is "a later version".

```jsonc
// conductor v3 (shared). Changes from v2 only; planning is unchanged.
"columns": ["planning", "implementing", "in_qa", "ready_to_merge", "needs_input", "waiting_external", "done"],
"states": {
  "implementing": { "on": {
    // personal: the same checks and open_pr as v2, now into In QA (no longer a question)
    "personal_pr_ready_for_review": { "goto": "in_qa", "title": "PR ready for QA", "kinds": ["personal"],
      "when": "The work is done, committed, and ready for review.",
      "requires": { "checks": BUILD_AND_TEST, "actions": ["open_pr"] }, "on_unmet": V2_ON_UNMET },
    "pr_ready_for_review": { "goto": "in_qa", "title": "PR ready for QA", "kinds": ["work"],
      "requires": { "checks": BUILD_AND_TEST, "review": { "items": [WORK_COMMIT_REVIEW_ITEM] }, "actions": ["open_pr"] },
      "on_unmet": V2_ON_UNMET },
    "no_changes_needed": { "goto": "needs_input", "question": true, "title": "No changes needed",
      "when": "The ticket needs no code change (already done, or not a code task). Explain why." },
    // removed: "done" (personal). Kept: ready_for_testing (work), needs_approval_to_message, ask_user, timeout
  }},
  "in_qa": {
    "type": "agent", "role": "qa", "title": "In QA",
    "prompt": "qa_template", "tools": ["qa"], "model": "opus", "timeout": "40m",
    "checkout": { "setup": null },              // null = ADR-0010 auto-detect; conductor_dev: "pnpm i --frozen-lockfile"
    "result": ["verdict", "summary"],
    "on": {
      "qa_pass": { "goto": "ready_to_merge", "title": "QA passed", "kinds": ["personal"],
        "when": "Every requirement is met and nothing blocks a merge (debt may be recorded).",
        "requires": { "actions": ["inspect_pr"] },
        "on_unmet": { "goto": "in_qa", "retries": 2, "else": "needs_input" } },   // unmet = head_moved: re-QA the new head
      "qa_pass_work": { "goto": "ready_to_merge", "title": "QA passed", "kinds": ["work"],
        "when": "Every requirement is met and nothing blocks a merge.",
        "requires": { "actions": ["inspect_pr"],
          "conditions": [{ "type": "pr_checks_green" }, { "type": "pr_approvals", "min": 1 }],
          "condition_timeout": "3d", "condition_poll": "2m" },
        "on_unmet": { "goto": "implementing", "retries": 2, "else": "needs_input", "routes": { "head_moved": "in_qa" } } },
      "qa_fail": { "goto": "implementing", "attach": "result", "retries": 3, "else": "needs_input",
        "title": "Changes required", "when": "At least one required fix: a requirement not met, a bug, a missing test." },
      "qa_needs_human": { "goto": "needs_input", "question": true, "title": "QA needs a human",
        "when": "You can't judge something without a human (a product decision, an environment you can't reach)." },
      "ask_user": "needs_input", "timeout": "needs_input"
    }
  },
  "ready_to_merge": {
    "type": "human", "title": "Ready to merge",
    "on": {
      "merge": { "goto": "done", "title": "Merge", "actor": "human",
        "requires": { "approvals": [{ "id": "migration", "label": "Approve migration", "paths": ["**/migrations/**"] }],
                      "actions": ["merge_pr"] },
        "on_unmet": { "goto": "implementing", "retries": 2, "else": "needs_input", "routes": { "head_moved": "in_qa" },
          "instruction": "Merge origin/main into your branch (never rebase), resolve the conflicts, commit, then finish again." } },
      "request_changes": { "goto": "implementing", "title": "Request changes", "actor": "human", "text": "required" }
    }
  },
  "needs_input": { "on": {
    "answer": { "goto": "$return_to", "title": "Back with this answer", "actor": "human" },
    "back_to_implementing": { "goto": "implementing", "title": "Back to Implementing", "actor": "human", "text": "required" },
    "waiting_on_someone": { "goto": "waiting_external", "title": "Waiting on someone else", "actor": "human" },
    "close_without_merging": { "goto": "done", "title": "Close without merging", "actor": "human", "text": "required",
      "requires": { "actions": ["close_pr"] }, "on_unmet": { "goto": "ready_to_merge", "retries": 0, "else": "needs_input" } }
    // removed: "done"
  }},
  "waiting_external": { "on": {
    "ui.approve": { "goto": "ready_to_merge", "title": "Tested" },   // was → done
    "back_to_implementing": { "goto": "implementing", "title": "Back to Implementing", "actor": "human" }
  }}
}
```

**The `qa_pass` `on_unmet`.** `inspect_pr`'s only *unmet* result is `head_moved`, which goes to `on_unmet.goto` = `in_qa` (the source state; rule 13 only forbids the transition's own target) and re-runs QA on the new head, counted. Its errors are failed actions, so they go straight to `else` (ADR-0010). `routes` is needed only on `merge`, which has two unmet reasons with different destinations.

**`conductor_dev` v3** = `conductor` v3 with `conductor_dev` v2's six checks (Merges cleanly with main, Typecheck, Lint, Unit tests, Build, E2E) and `setup: "pnpm i --frozen-lockfile"` on the transitions into In QA, `in_qa.checkout.setup: "pnpm i --frozen-lockfile"`, and approval paths `["packages/orchestrator/migrations/**"]`.

**Seed.** The ADR-0011 rule, per account (M2-T12): an unedited `conductor` v2 upgrades to v3, and an edited one keeps its version, with `default_available` set. `conductor_dev` is not seeded. The lead posts `conductor_dev.v3.json` to the pinned board and to the hosted instance.

### 11 · Interim on the pinned board (data only, before the code lands)
The pinned board runs `board-pinned` (the M1b build plus UX tickets), far behind `main`. Cherry-picking M2r's engine there would conflict with M2's `apply.ts` work. A **data-only** interim needs no code and stops Done-before-QA today (M2r-T00). It is posted as the next `conductor_dev` version:
- **In QA** is an ordinary agent state: a literal prompt with `{{ticket.title}}` / `{{ticket.body}}`, tools `['review', 'bash']`, `qa_pass` / `qa_fail` (counted, retries 3) / `qa_needs_human`.
  - The findings reach the worker through Implementing's `input: {qa_findings: '$in_qa.required_fixes'}`. On the first visit this renders as "not produced", which is acceptable.
  - Missing in the interim: the independence (it resumes nothing, but its conversation id is stored as the worker's), the fresh checkout and the pinned sha.
- **Ready to merge** (human): `merged_on_github` → Done, with `requires.conditions: [{type: pr_merged}]`, `condition_timeout: 10m`, `condition_poll: 30s`; and `request_changes` → Implementing. Ben merges on GitHub, then clicks; Done waits for GitHub to confirm the merge.
- **Needs input:** `done` is replaced by `close_without_merging` → Done, with no `close_pr` yet.

M2r-T00's acceptance first proves on a throwaway ticket that the M1b build runs conditions on a human move out of a human state. If it doesn't, `merged_on_github` drops its `requires`, and the interim relies on the label.

## Alternatives considered
| Option | Why not |
|---|---|
| Warn on Done with an open PR (U-083's first option) | The call to action still doesn't match the outcome. Ben: the next step is QA, then merge |
| QA as a `requires.review` on the move into Ready to merge | A review step judges a few items and leaves no column or transcript. QA needs a full session (tests, diff, per-requirement grades) and a visible "In QA" column |
| Let the QA agent push fixes itself | It would review its own changes and need push rights, against the ADR-0006 guard and ADR-0009's independence. Fixes go back to the worker (U-085) |
| QA in the agent's worktree | It could see uncommitted or ignored files and miss a head pushed by someone else. A fresh checkout of the PR head is the exact merged commit (the ADR-0010 lesson) |
| Merge by linking to GitHub | Ben: Merge is a real action. A link can't pin the reviewed commit, and the board can't know the merge happened without polling |
| Squash or rebase merges | Today's history uses merge commits; a per-transition `method` leaves room for both later |
| Re-QA whenever `main` moves before the merge | It would serialise every merge behind QA runs. Conflicts, the "Merges cleanly" check and GitHub's mergeability cover integration (U-087) |
| A migration approval as a separate human state | An extra column and an extra click for every PR. A conditional checkbox on Merge appears only when a migration is in the diff |

## Consequences
- **Good:**
  - every card's call to action matches its next real step: In QA is conductor's work, Ready to merge is Ben's Merge, and Done means merged or explicitly closed;
  - QA runs on the exact commit that is merged, the merge is pinned to it, and migrations need an explicit approval;
  - the lead's manual QA and merge loop is gone for ticket work;
  - QA findings live on the ticket (and in ADR-0019's evidence layer once M2c lands).
- **Bad / accepted cost:**
  - **cost:** a QA session per round on Opus (U-086), 3–15 minutes plus a fresh `pnpm i`;
  - **an outward-facing side effect:** conductor merges PRs and closes them with Ben's own `gh` credentials. It is idempotent and pinned, but it is a write to GitHub;
  - **contract changes:** `role`, `checkout`, `attach: 'result'`, `text`, `approvals`, `on_unmet.routes`, three actions, `start_session.checkout`, the transition request's `approvals`, and card fields. All are additive, and no DB migration is needed;
  - QA judgement is an LLM's. It is bounded by three rounds and a human backstop, and Ben can always Request changes.
- **Follow-ups:**
  - M2r (this milestone);
  - M2c-T04 maps the QA result onto the review layer, and its prompt version becomes v4;
  - M2-T13 GC of merged branches and worktrees;
  - routing actions to any online machine (U-091);
  - GitHub webhooks (M5) for merges made outside conductor.

## Revisit when
- QA verdicts prove too flaky or too costly: a cheaper model for round 1, or a majority of two;
- a team repo needs squash merges or a merge queue;
- branch-protection setups make `--match-head-commit` merges fail routinely (then consider `gh pr merge --auto`).
