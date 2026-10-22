# E2E suite (M1-T10)

`pnpm test:e2e` runs `e2e/run.sh`: `scripts/db.sh up` (idempotent), `tsc -b` (builds the bins), then
`vitest run --config e2e/vitest.config.ts`. One run takes about 15 s with the fake Claude. The limit is 3 minutes.

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
  from `FAKE_CLAUDE_SCENARIO_DIR`, which holds the `SCENARIOS` from `m1.e2e.test.ts`.

All driving and observing goes through the public API. Workflows are saved with
`POST /api/workflows` (the shipped `m1_basic`) and tickets are created with `POST /api/tickets`. The
board SSE stream (`/api/stream/board?last_event_id=0`) is watched for card states. Questions are
answered with `POST /api/sessions/:id/input`, and the run also uses `GET /api/sessions/:id`,
`GET /api/machines` and the session output SSE stream.

| Scenario | Checks |
|---|---|
| happy path | implement → build → test → done; agent output on the output SSE stream; spend; CLI version from `--version` |
| test fails twice | three implement/build/test loops, `test->implement: 2`, and the retry prompt carries the failed output (`attach: output`) |
| build retries exhausted | 4 failed builds → `needs_input` (`retries_exhausted`, the question includes the output); answering "retry" → build → test → done; a second answer → 409 |
| ask/answer | `ask_user` → Needs input card → REST answer → the live agent (`send_input`) completes with the answer |
| no outcome (U-028) | say-only turns → exactly one nudge (two fake turns) → Needs input `agent_question` with the no-outcome question and `Last output:` → REST answer → done |
| shutdown | stopping the daemon kills a parked Claude process; no process is left running from the temp dir |

Teardown stops the daemon (SIGTERM, which kills its Claude processes) and then the orchestrator.
After that it kills anything still running from the temp dir, drops the database and removes the
temp dir. When a test fails, the tail of each process log is printed.

## Real Claude

`E2E_REAL_CLAUDE=1 pnpm test:e2e` runs only the ask/answer scenario, against the installed `claude`.
It uses a copy of `m1_basic` saved as `m1_basic_haiku`, with `implement.model = "haiku"`. This mode
spends money (about a cent), so it never runs in CI: `scripts/ci.sh` unsets the variable.
