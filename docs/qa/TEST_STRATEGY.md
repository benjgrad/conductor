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
