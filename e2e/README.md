# E2E suite (M1-T10)

`pnpm test:e2e` runs `e2e/run.sh`: `scripts/db.sh up` (idempotent), `tsc -b` (builds the bins), then
`vitest run --config e2e/vitest.config.ts`. Two files, one stack (database, bins, fixture repo) each,
run one after the other: `m1.e2e.test.ts` (M1, ADR-0007..0010) and `m1b.e2e.test.ts` (ADR-0011
transition rules). A full run takes about 50 s with the fake Claude. The limit is 3 minutes.

## What runs

- **Database**: a fresh `conductor_test_<branch>_<random>` database on the shared local Postgres,
  created and migrated by `packages/orchestrator/test/db.ts`, and dropped at the end.
- **Orchestrator**: the real `conductor-orchestrator` bin (`packages/orchestrator/dist/bin.js`) on an
  ephemeral port. It serves the API only, with no web app.
- **Daemon**: one real `conductor-daemon` bin (`packages/daemon/dist/main.js`) with
  `CONDUCTOR_ALLOW_LOCAL_REPOS=1` and its root in the run's temp dir. `CONDUCTOR_CLAUDE_BIN` points
  at a symlink to `packages/daemon/test/fixtures/fake-claude.mjs` inside that temp dir.
- **Fixture repo**: a local git repo (`harness/fixture-repo.ts`) where `npm run build` and `npm test`
  pass, unless the counter `.e2e/<step>-fail` in the session's worktree holds N > 0. In that case the
  step fails and decrements N. The fake Claude writes the counter in its first turn (`write_file`).
- **Scenarios**: each ticket body names its fake scenario (`fake-scenario: <name>`). The fake loads it
  from `FAKE_CLAUDE_SCENARIO_DIR`, which holds the file's `SCENARIOS`. A step may name an ADR-0011
  transition (`{"complete_state": {…}, "transition": "plan_ready", "reason": "…"}`). A requirements
  reviewer plays `<name>_review`.
- **Fake `gh`** (`FAKE_GH` in `harness/stack.ts`), first on the daemon's PATH in every run: no
  GitHub, ever. `pr create` numbers PRs from 42 (`…/fixture-app/pull/42`); `pr view <url> --json …`
  (evaluate_conditions) answers gh's JSON with `headRefOid` = the commit conductor pushed to the
  fixture repo, one CI check and the approvals from `stack.setFakePr(title, {approvals, checks})`,
  which a test rewrites between polls. It always adds the PR author's own approval and a drive-by
  (association NONE), which must never count.

All driving and observing goes through the public API. Workflows are saved with
`POST /api/workflows` (the shipped `m1_basic`) and tickets are created with `POST /api/tickets`. The
board SSE stream (`/api/stream/board?last_event_id=0`) is watched for card states. Questions are
answered with `POST /api/sessions/:id/input`, a live message is sent with `POST /api/sessions/:id/messages`, and the run also uses `GET /api/sessions/:id`,
`GET /api/machines` and the session output SSE stream.

| Scenario | Checks |
|---|---|
| happy path | implement → build → test → done; agent output on the output SSE stream; spend; CLI version from `--version` |
| test fails twice | three implement/build/test loops, `test->implement: 2`, and the retry prompt carries the failed output (`attach: output`) |
| build retries exhausted | 4 failed builds → `needs_input` (`retries_exhausted`, the question includes the output); answering "retry" → build → test → done; a second answer → 409 |
| ask/answer | `ask_user` → Needs input card → REST answer → the live agent (`send_input`) completes with the answer |
| no outcome (U-028) | say-only turns → exactly one nudge (two fake turns) → Needs input `agent_question` with the no-outcome question and `Last output:` → REST answer → done |
| live message (ADR-0007) | `POST /api/sessions/:id/messages` while the agent's turn runs (409 until its process is live) → the fake folds `/context` into that turn (no turn of its own) and completes with it; a `user` chunk on the output stream; one process; 409 once done |
| history and reopen (ADR-0008) | a done ticket's `GET /api/sessions/:id/transcript` comes from the transcript the fake wrote under the run's `CLAUDE_CONFIG_DIR` (thinking skipped, synthetic seq); `POST /reopen` → a new session on the same branch and the same (reused) worktree, the fake started with `--resume <same id>` and the human's text as prompt, implement → build → test → done again; 409 for a session that is no longer the latest; the new session's transcript holds both passes |
| requirements gate (ADR-0009) | `m1_reviewed`: the fake reviewer (scenario `gated_review`, picked because its prompt starts with `# Requirements review`) checks the worktree with `if_exists`: no test file → unmet → implement resumes with "Requirements for implement → build were not met" and the reason in its prompt → the second (fresh) reviewer finds the test → build → test → done. Asserts the board labels, the counter, two fresh never-resumed reviewer sessions with read-only `--tools`, and that the transcript stays the worker's |
| the one workflow (ADR-0010, on v2) | a ticket with no `workflow_id` runs `conductor` v2 (seeded as latest): Planning → `plan_ready` → Implementing (its first pass leaves its work uncommitted and `npm test` red once) → `ready_for_testing` → the dirty-tree check sends it back → it commits (fake action `git_commit`) → `npm test` fails → back to Implementing with the output → checks pass → the reviewer (`conductor_review`) passes → `open_pr` (conductor pushes the branch to the fixture repo and calls the **fake `gh`** the stack always puts first on the daemon's PATH: no GitHub, ever) → the conditions, which the fake gh reports green and approved at the first poll → Waiting external → Approve → Done. Asserts the columns, the `checking` badge and checklist in every phase, the `move:` counter, the PR URL on the card, gh's `--repo/--head/--base`, and the `pr view <url> --json` conditions call |
| shutdown | stopping the daemon kills a parked Claude process; no process is left running from the temp dir |

`m1b.e2e.test.ts` (M1b-T10) saves `conductor` v2 again with `condition_poll: "1s"` (version 3,
which its tickets pin), so the conditions poll fast with no test-only knob.

| Scenario | Checks |
|---|---|
| 1. question transition | Planning → `scope_changed`: Needs input with the reason as the question and the human buttons `answer` / `waiting_on_someone` / `done` → answered (`/input`) → the planner resumes → `plan_ready` → Implementing → `needs_approval_to_message` → the human takes "Waiting on someone else" (`POST /transition`) → Approve → Done. Asserts `return_to` and the moves record (transition, reason, actor) |
| 2. conditions (work) | `ready_for_testing` → checks → review → `open_pr` → held in **Implementing** (status `waiting_external`) with the checklist: checks met, `PR checks green (1/1 passed)` met, `PR approved (0/1)` pending ("no approvals yet": the author's and the drive-by approvals don't count), Jira / Azure disabled → the fake flips to 1/1 → Waiting external. Asserts no card left Implementing before the flip, the SSE history of the approvals item (todo → running → pending), several `gh pr view` polls, and the `ready_for_testing — <reason>` move |
| 3. human done | Planning → `needs_product_context` → Needs input → `POST /transition {name: "done"}` → Done; a name that isn't a transition of Needs input → 409 |
| 4. personal | a `kind: personal` ticket: Planning → Implementing → `done` (checks, `open_pr`, no review, no conditions) → Done, never Waiting external; its implementing prompt lists `personal_pr_ready_for_review`, not the work transitions |
| 5. v1 regression | conductor v1's definition saved as the latest version, a ticket pins it, v2 is saved back; the pinned ticket runs the ADR-0010 path (unnamed `done`s, the `(entry)` step, `open_pr`, Waiting external, Approve, Done) with M1 move records |

Teardown stops the daemon (SIGTERM, which kills its Claude processes) and then the orchestrator.
After that it kills anything still running from the temp dir, drops the database and removes the
temp dir. When a test fails, the tail of each process log is printed.

## Real Claude

`E2E_REAL_CLAUDE=1 pnpm test:e2e` runs only the ask/answer scenario, against the installed `claude`.
It uses a copy of `m1_basic` saved as `m1_basic_haiku`, with `implement.model = "haiku"`. This mode
spends money (about a cent), so it never runs in CI: `scripts/ci.sh` unsets the variable.
