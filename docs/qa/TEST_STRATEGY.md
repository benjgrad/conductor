# Test strategy

The design concentrates risk in three places: the **workflow engine** (determinism), **claims/leases** (concurrency), and the **daemon ↔ orchestrator contract** (delivery under failure). Tests target those.

| Layer | What | Tooling | Where |
|---|---|---|---|
| Unit | Workflow validator (one failing fixture per rule); FSM `apply()` (table-driven over every transition of both reference workflows); idempotency-key derivation; column mapping | vitest | `packages/shared`, `packages/web` |
| Property | Random event sequences into `apply()` never produce an undefined state, never exceed retry caps, always end able to reach terminal/human | vitest + fast-check | `packages/shared` |
| Integration (DB) | Migrations; transactional apply + outbox; dispatcher re-send after crash; claim query with `SKIP LOCKED` under N concurrent claimers (M2); reaper + fencing (M2) | vitest + real Postgres (docker-compose; **no SQL mocks**) | `packages/orchestrator` |
| Integration (daemon) | Daemon against a fake orchestrator WS: register, heartbeat, start → worktree, command runner, semaphore, dedupe `command_id`, reconnect + seq replay (M2) | vitest | `packages/daemon` |
| Contract | Protocol message schemas (zod in `shared`) used by both sides; snapshot of message catalog | vitest | `packages/shared` |
| E2E | Postgres + orchestrator + daemon + **fake Claude** (scripted binary honouring ADR-0005 contract) on a fixture repo: happy path; build/test fail-then-pass; retries exhausted → needs_input; ask_user answered via REST; no outcome reported → one nudge → needs_input (U-028). Optional `E2E_REAL_CLAUDE=1` | vitest or playwright (UI), `pnpm test:e2e` | `e2e/` |
| Chaos (M2) | **Laptop sleep**: SIGSTOP daemon past lease grace → requeue with token+1 on second daemon → SIGCONT → stale events rejected + kill. Orchestrator kill -9 mid-transition. WS drop < grace (no lost session) | e2e harness | `e2e/chaos/` |

## Principles
- The fake Claude is a first-class test fixture. Most E2E runs never call the real model: deterministic, fast, free.
- Every bug fix lands with a test that would have caught it.
- Flaky tests are bugs. Quarantine them with a TD-### row, never by silently retrying.

## Running on a shared machine (M2-T31)
Many worktrees, conductor sessions and Claude subagents run gates on the same box. Unthrottled, a dozen parallel runs pushed the load average past 40 on 4 cores and tests failed on their 5 s timeouts. So every vitest run (root and e2e configs, via `globalSetup`) and `pnpm lint` takes one of `CONDUCTOR_TEST_SLOTS` (default 2) machine-wide slots first (`scripts/test-slot.js`), and vitest's `maxWorkers` is the CPU count divided by the slots.
- A slot is a localhost port (`CONDUCTOR_TEST_SLOT_PORT`, default 54330, +1 per slot). The OS frees it when the holder exits, even on SIGKILL, so there's no stale lock.
- A waiter prints who holds the slots every 30 s and gives up after `CONDUCTOR_TEST_SLOT_WAIT_S` (default 1800) with the holders in the error.
- A holder sets `CONDUCTOR_TEST_SLOT_HELD=1` for its children, so nested runs don't deadlock. Watch mode takes no slot. `CONDUCTOR_TEST_SLOTS=0` turns the limit off (a dedicated CI runner).

## Keeping the suite fast (M2-T33)
- **Tiers** (`scripts/test-tiers.js`): `pnpm test` skips the slow tiers (web jsdom, daemon tests that drive real git / node children, orchestrator Postgres tests, engine property tests) unless the branch changed something they test since its merge-base with `main`. It prints what it skipped. Global files (configs, lockfile, test helpers), test files named on the command line, or no merge-base run everything. `pnpm test:all` (`vitest run --mode all`, used by `scripts/ci.sh`) always runs every tier, and the property tests at their full run counts (a fifth otherwise; they are unseeded, so every run still explores new cases). A new expensive test file belongs in `SLOW_TIERS`: the cost guard (`scripts/test-tiers.test.js`, in every `pnpm test`) fails while a test file outside the tiers mounts `<App>`, imports `node:child_process`, creates a database or opens jsdom. It's a static check on purpose: a time budget would flake on a shared machine.
- **No per-file isolation**: projects run with `isolate: false`, so a worker imports each module once (`shared` went from 61 s to 21 s). A file that mocks modules (`vi.mock` / `vi.doMock`) is detected when the config loads and runs in a `<package>-isolated` project; `--project '<package>*'` selects both. Fake timers and spies must be restored per test, as they already are.
- **Render the component, not `<App>`**, unless the test is about navigation or the board: an `<App>` mount costs about 1 s per test in jsdom.
