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
  - *Updated by [ADR-0011](0011-transition-rules.md) / M1b-T09:* it then also inserts the shipped v2 when the latest version is the unedited v1, so an empty database gets v1 then v2; an edited `conductor` is never touched.
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

## Implementation notes (backend, branch `ow-backend`)
The decision above stands; these are the choices made implementing it. Details: [05 §Requirements to enter a column](../design/05-workflow-engine.md#requirements-to-enter-a-column-adr-0010), [06 §Kanban columns](../design/06-human-input.md#kanban-columns-the-workflows-states), [10 §Requirements review and entry steps](../design/10-contracts.md#requirements-review-adr-0009-and-entry-steps-adr-0010).
- **conductor v1** is `docs/design/workflows/conductor.v1.json`, mirrored as `CONDUCTOR_V1` in `packages/shared/src/workflow/conductor.ts` (a test keeps them equal) so the orchestrator bin needs no docs at runtime. Budget 5 USD / 120 min, `max_loop_retries` 3; `planning` (tools `['read']`, prompt `plan_template`, result `[plan, summary]`, timeout 20m), `implementing` (tools `['edit','bash','git']`, prompt `implement_template`, input `plan: $planning.plan`, timeout 30m), entry checks with a 10m timeout each, `on_unmet` retries 3. Titles: Planning, Implementing, Needs input, Waiting external, Done.
- **Seed.** `seedConductorWorkflow` runs at the start of `composeOrchestrator().start()`, and again (idempotently) when `POST /api/tickets` defaults to `conductor`, so a bare test database works. One `INSERT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING`: idempotent, safe on concurrent starts, never touches a saved v2. *Updated by [ADR-0011](0011-transition-rules.md) / M1b-T09:* the seed now inserts the shipped v2 over an **unedited** v1 (its parsed definition deep-equals `CONDUCTOR_V1_DEF`), with the same `ON CONFLICT DO NOTHING`, so concurrent starts insert one v2. A user's own version is still never touched: the start logs that a newer default exists, and `GET /api/workflows/conductor` carries `default_available`.
- **Hiding old workflows.** `GET /api/workflows` lists only `conductor`; `?all=1` lists every id. `GET /api/workflows/:id` still serves any id (an old ticket's Details panel needs its definition). `POST /api/tickets` still accepts another existing id (tests, scripts).
- **One step representation.** ADR-0009's review step became the gate step: `session.step` (`GateStepSchema`), `kind: 'transition' | 'entry'`, plus `phase` and `index`. Stored in `context.__entry` (no migration); rows with the old `context.__review` are still read. The entry step's label is `"<from> → <to> (entry)"`; ADR-0009 gates on old versions run through the same code with `phase: 'review'`. A passed transition review whose target has `entry` then starts the entry step.
- **Which routes run entry requirements.** Every route into a state with `entry` from a real state: an outcome, and also a human's answer or "skip to" (otherwise a human could skip the PR). Not: the claim into `start` (rule 9 forbids `entry` there), the routes to a human (fallback, budget, `on_unmet`), and a passed entry step. A human answer carried into an agent target through an entry step is not delivered (the step keeps no answer); with conductor v1 the only entry target is an event state.
- **Validator rule 9**: see 05. `entry` on the start state ("the start column is entered by a claim, not an outcome, so entry requirements would never run") and on human states is an error; on the terminal state it is allowed. `on_unmet.goto` may not have its own `entry` (no nested steps).
- **Failures.** A failed check (non-zero exit or the daemon's timeout) and unmet review items are unmet (counter `entry:<to>`). A refused check or action, an action error, an action or review timeout, and no verdict go straight to `else`. The not-met question and the worker's feedback include each failed check's output tail.
- **Migration (approach pre-approved by Ben; listed for sign-off):** `packages/orchestrator/migrations/1761400000000_outbox-run-action.sql` adds the `outbox_kind` value `run_action` (one engine Effect `run_action`, one WS command `run_action`, one `session_event action_result` → EngineEvent `action.completed`). Additive; its down migration rebuilds the enum without it, deleting `run_action` rows (transport only). Generic `run_action` rather than `open_pr`, so a later action needs no new enum value.
- **Board.** `toBoardCard` takes a `CardView {columns, def}`: the latest `conductor`'s columns and the session's pinned definition (for the state-type fallback); `placeCard` is the one rule. A session `queued` / `assigned` with a state already entered shows in that state's column (a claimed card leaves Queued as soon as the claim enters `start`). `card.moved` is emitted whenever the card's column changes, not on status. Cards gain `checking {to, title, phase}` and `pr_url`; badges gain `checking`, `failed`, `lost`, `cancelled`. A ticket cancelled before any session ran now shows in Done (badged); it used to be hidden.
- **Security: gate steps are fenced** (security review 2026-10-23). apply already ignored agent events outside the review phase and detached the worker on entering a step, but worker and reviewer ran under the same fencing token, so a worker event after its `complete_state` (a second `complete_state`, `ask_user`, `no_outcome`) could have been taken as the reviewer's verdict. The EngineService now bumps the token whenever apply enters, leaves or switches a gate step; the gateway refuses the fenced-off process's events (`stale_fencing_token`) and kills it, and the reviewer's start (a higher token) supersedes the worker on the daemon. `spend` is the one exception: a fenced-off process's last cumulative spend still counts, without a kill. **The ADR-0009 path on `main` had the same gap**; this branch fixes it for both.
- **Security: open_pr never trusts agent-writable git state** (security reviews 2026-10-23). The worktree's `.git` points into the shared clone, whose `config` and `hooks/` any session's agent can write at any time, so checking that config first would be a check-then-use race. `packages/daemon/src/actions/open-pr.ts`:
  1. fetch the session branch into a daemon-private bare repo `<root>/private/<sha256(repo)[:16]>.git` (git's minimal config, created by the daemon, no agent cwd inside) with `core.hooksPath=/dev/null`, only the file protocol, `--upload-pack=git-upload-pack` (upload-pack in the source runs no hooks and honours `uploadpack.packObjectsHook` only from protected config);
  2. verify the fetched tip is a commit;
  3. push from the private repo to the URL from the daemon's own store (`cloneSource(ticket.repo)`), allow-listed to `https://github.com/<o>/<r>` / `git@github.com:<o>/<r>` (or an `allowedRepoHosts` host), never the config `origin`, with `--no-verify`, `core.hooksPath=/dev/null`, only https/ssh, `GIT_CONFIG_NOSYSTEM=1` and no inherited `GIT_*` variables. Credentials and `insteadOf` come only from Ben's global git config; his global credential helper is kept (it is his own setup, and nothing repo-local can add one);
  4. `gh pr view|create --repo <o>/<r> --head <branch> --base <default branch from gh repo view>`, run in the daemon root, outside every repository.
  The branch and repo come from the daemon's store, not the message. Tests plant a pre-push hook, rewritten `remote.origin.url` / `pushurl`, `url.*.insteadOf` / `pushInsteadOf`, `core.hooksPath`, `credential.helper`, `core.sshCommand`, `core.fsmonitor`, `uploadpack.packObjectsHook` and `include.path` in the clone, before the call and between the fetch and the push: the push still lands only on the trusted repo, and nothing planted runs.
  - **Residual risk.** Agents run as the same uid with unconfined Bash (U-004, TD-083): an agent could still write the private repo, Ben's global git config, or put a `gh` / `git` earlier on the daemon's PATH. The OS sandbox is the real boundary. What is gone is the check-then-use race on a shared, agent-used repository.
  - A local-path repo (the E2E fixture, tests) is allowed only with `allowLocalRepos` (`CONDUCTOR_ALLOW_LOCAL_REPOS`, the existing test-only knob); gh then gets `--repo local/<name>`, which only the fake `gh` accepts. A missing `gh` is "gh (the GitHub CLI) is not on PATH: install it and run `gh auth login`"; any other repo is "… is not a GitHub repository conductor may push to".
- **Security fix round (2026-10-26, Ben-approved migration and "skip to always runs the requirements").**
  - **The PR URL can't be spoofed by agent output.** It is recorded only as `context.__pr = {pr_url, state}`, by the engine from open_pr's `action.completed`. Agents' results live under their state's name, and `__pr` is a reserved state name (rule 8), so an agent can't produce it. A `pr_url` anywhere else is ignored. The URL must match `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$` (`GITHUB_PR_URL_RE`), checked by the daemon before it reports, by the engine (anything else is a failed action → `else`), and by `BoardCardSchema` (invalid → null).
  - **The pushed commit is the checked commit.** When a gate step starts, the engine kills exactly the worker's process (`kill.target_command_id`) as well as fencing it off. The daemon reports the worktree `HEAD` with every `cmd_exit` (`head_sha`). The first check's becomes `step.head_sha`, a later check seeing another `HEAD` is unmet, and the review prompt names the commit. `run_action.expected_sha` carries it, and open_pr refuses unless the fetched branch tip equals it, then pushes `<sha>:refs/heads/<branch>`. An entry with checks but no recorded commit pushes nothing (→ `else`).
  - **Only committed changes are checked** (security review, 2026-10-26). Checks ran on the working tree while only `HEAD` was pushed, so uncommitted fixes could pass build/test while the PR held failing code. Each entry check is now a `require_clean` `run_cmd`. The daemon first runs `git -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain --untracked-files=all` (`GIT_CONFIG_NOSYSTEM=1`, no inherited `GIT_*`). A dirty tree is reported as `cmd_exit.dirty` (the status lines) and the check doesn't run; only a clean tree reports `head_sha`. The engine treats a dirty tree as **unmet**, not a human error: "Uncommitted changes in the worktree: commit your work; only committed changes are checked and pushed", with the status list as evidence. It goes back to `on_unmet.goto` and counts under `entry:<to>`, since committing is the agent's job. `implement_template` says to commit everything before finishing. .gitignore'd files (build outputs such as `dist/`, `node_modules/`) don't count: `--untracked-files=all` respects .gitignore, which is the intended behaviour. The e2e fake can now commit (`{"git_commit": msg}`), and the conductor scenario first leaves its work uncommitted (→ unmet → back → commits → passes).
  - **An ephemeral private repo.** Each push gets a fresh `mkdtemp` dir under `<root>/private` (0700). Both it and `<root>/private` are lstat-checked (a directory, not a symlink, owned by this uid), and it is deleted after the push. This pays the "private repos never GC'd" debt.
  - **No unique index on `outbox(idempotency_key)` for `run_action`.** It wasn't trivial: a requeue during the actions phase legitimately re-emits the same action with the same key (same visit), so a unique index would fail that transaction. Dedupe stays with the daemon's command_id dedupe and open_pr's reuse of the existing PR (TD).
  - Test fakes run gh as `/bin/sh <script>` (`OpenPrInput.gh`, `DaemonOptions.ghCommand`, test-only), because spawning node per call stalled for seconds under load on Ben's Mac. Production always runs `gh` from PATH.
- **Clean-check hardening (final QA, 2026-10-26, branch `ow-clean-hardening`).** A plain `git status` reported "clean" on a dirty tree in four agent-controllable cases: an `--assume-unchanged` file, a `--skip-worktree` file, an untracked file listed in the shared clone's `.git/info/exclude`, and one matched by a repo-config `core.excludesFile`. `checkClean` now treats the tree as dirty if any of these is true:
  1. `status --porcelain --untracked-files=all` with `-c core.ignoreStat=false -c core.untrackedCache=false -c core.excludesFile=` (plus fsmonitor and hooks off) lists anything;
  2. `git ls-files -v` shows a hidden index bit: a lowercase tag (assume-unchanged) or `S` (skip-worktree);
  3. `git ls-files --others --exclude-per-directory=.gitignore` lists anything. This honours only the `.gitignore` files in the tree, so build outputs (`dist/`, `node_modules/`) ignored by a committed `.gitignore` still count as clean.
  - **A later check with an unknown HEAD is unmet** (QA a). Every check after the first must report the same, known commit.
  - **Every entry pins its commit** (QA b). An entry with no checks (review-only, action-only) gets an implicit first check `PIN_CHECK` = "Committed work" (`true`, `require_clean`). The tree must be clean, its `HEAD` is recorded, the reviewer is told it, and open_pr always gets `expected_sha`.
  - **Residual (QA c, TD-083 class).** `checkClean` and `resolveHead` still run git in the worktree, so they read the agent-writable repo config for whatever status and rev-parse need: filter drivers (`filter.*.clean` / `process`) and attributes can run commands or change what "modified" means. Hooks and fsmonitor are off, and the push itself never reads that config (it runs from the private repo). The real boundary is the sandbox (U-004).
- **Checks run on a fresh checkout (Ben, 2026-10-26).** This replaces the clean worktree as the gate. QA kept finding ways to hide changes from `git status` in an agent-writable repo: a self-ignoring uncommitted `.gitignore`, `submodule.<name>.ignore`, and filter drivers. So the checks no longer run in the agent's worktree at all. For an entry step's checks the daemon:
  - creates an ephemeral 0700 repo under `<root>/private/check-*` (lstat/owner-checked like open_pr's push repo; git's minimal config, so only Ben's global config applies: no repo-config filter drivers, hooks off);
  - fetches the session branch in with the open_pr hardening (`--upload-pack=git-upload-pack`, file protocol only, `GIT_CONFIG_NOSYSTEM`, inherited `GIT_*` dropped);
  - requires the tip to equal the commit to check (the worktree's clean `HEAD` for the first check, `step.head_sha` after), and checks that commit out detached;
  - runs the setup, then every check, with that checkout as cwd, in order, on that one commit.
  - **Lifecycle.** The checkout is kept between the checks of one step (`run_cmd.checkout.last` marks the final one) and deleted after the last check, after any failure, and when a check for another commit arrives. A daemon start sweeps leftovers. open_pr keeps its own fresh push repo, so nothing is reused between them.
  - **Setup.** The schema gains `entry.setup?: string`, run once in the fresh checkout before the checks. Omitted means auto-detect: `package-lock.json` → `npm ci`, else `package.json` → `npm install`, else nothing. `''` means no setup. A failed setup is unmet, with its output as evidence ("Setup: the setup in a fresh checkout failed…"). Validator rule 9 requires checks for a setup. No new conductor version: auto-detect covers v1.
  - **checkClean** stays as an early, friendly pre-check (dirty → unmet "commit your work") and is no longer the security boundary. It also catches QA's last two tricks: `--ignore-submodules=none`, and any untracked-and-ignored `.gitignore` (`ls-files --others --ignored --exclude-per-directory=.gitignore -- .gitignore ':(glob)**/.gitignore'`).
  - **Residual.** The pre-check and `resolveHead` still run git in the worktree, so an agent-planted filter driver can still run there, as the same uid, with nothing gained over the agent's own Bash (TD-083 / U-004). The checks themselves are the agent's code and run unconfined as before. What can no longer happen: checking content other than the commit that is pushed, or a check seeing worktree-only files (ignored or uncommitted).
  - **What the fresh checkout does not guard against.**
    - Committed symlinks and test code can still read outside the checkout, including the agent's worktree. That is visible in the PR diff, so the fresh checkout guards against drift between what is checked and what is pushed, not against an adversarial agent (U-004).
    - LFS and any other filters from Ben's *global* git config still apply in the checkout.
    - The setup (`npm ci` / `npm install`) runs the commit's npm lifecycle scripts with Ben's npm config and credentials: the same exposure as the agent's own Bash.
  - **Cleanup.** A session kill (cancel, step timeout, budget) or a new agent start for the session removes a checkout kept between checks. A run only ever removes its own checkout, never a newer visit's. The startup sweep lstat/owner-checks `<root>/private` and never follows a symlink.
  - **The e2e** proves it: a gitignored `.e2e/override-test` that makes `npm test` pass in the worktree doesn't help, because the fresh checkout doesn't have it. The fixture fails `npm test` while a committed `fail-test` exists. The fresh checkout's auto-detected `npm install` runs with `npm_config_offline` set, so nothing touches the network.
- **E2E.** The stack always puts a fake `gh` first on the daemon's PATH (also under `E2E_REAL_CLAUDE=1`), so no run reaches GitHub. The conductor scenario: Planning → Implementing → entry checks (tests red once → back with the output) → open_pr (fake gh) → Waiting external → Approve → Done.
