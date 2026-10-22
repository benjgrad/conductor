# Decisions log

One line per decision, newest first. Big or reversible-only-at-cost decisions get an ADR. Small ones live only here.

| Date | Decision | Ref |
|---|---|---|
| 2026-10-22 | ADR-0005 accepted: stream-json CLI driver + daemon-hosted MCP outcome tools | [ADR-0005](../adr/0005-claude-code-driver.md) |
| 2026-10-22 | Agents run isolated (`--setting-sources ""`); the target repo's CLAUDE.md is injected via `appendSystemPrompt`, its hooks/permissions are not loaded (U-013) | Ben |
| 2026-10-22 | Node 22 LTS for the repo; nvm default on Ben's Mac set to 22 (U-019) | Ben |
| 2026-10-22 | Local Postgres without Docker: one shared cluster on 54329, a database per worktree / test run (U-020) | Ben |
| 2026-10-22 | New task M1-T13 (toolchain: Node 22 majors, shared-cluster DB per worktree, `DATABASE_URL` loading) runs in group A2 alongside T12 | lead |
| 2026-10-22 | M1 group A (T00, T01) merged to main via `integrate/A` (`--no-ff` per task) after `scripts/ci.sh` passed on the merged tree | M1-T00, M1-T01 |
| 2026-10-22 | **Proposed, not yet accepted**: daemon spawns installed `claude` in bidirectional stream-json mode (one long-lived child per session); `complete_state`/`ask_user` via daemon-hosted HTTP MCP server, non-blocking; answers as user messages (live stdin, else `--resume`); Agent SDK rejected for now | [ADR-0005](../adr/0005-claude-code-driver.md) (proposed) |
| 2026-10-22 | Migration tool: node-pg-migrate 9.0.0 with TypeScript migrations (bundled jiti) in packages/orchestrator/migrations | M1-T01, [ADR-0004](../adr/0004-typescript-monorepo.md) |
| 2026-10-22 | Toolchain held at Node 20.18-compatible majors (vitest 4, vite 6 via pnpm override, eslint 9, TS ~6.0) until U-019 is decided | M1-T01, TD-005 |
| 2026-10-22 | Workspace packages export a `source` condition (src/index.ts) used by vitest/vite, so tests run on a clean clone without a build; `spikes/**` is outside every gate | M1-T01 |
| 2026-10-22 | Homebrew Postgres fallback is TCP-only on localhost:54329 with trust auth and unix sockets off (worktree paths exceed the macOS socket-path limit) | M1-T01 |
| 2026-10-22 | M1 executed contracts-first: new tasks M1-T12 (contracts, group A2) and M1-T11 (orchestrator daemon gateway + single-machine claim); groups B–D build against the contract fakes. Each group runs as one Workflow (implement → QA → fix → integrate) | [M1](../plan/milestones/M1-single-machine.md) |
| 2026-10-22 | Agents push `m1-tNN-*` task branches to `origin`; `main` merges locally, and only Ben pushes it | Ben |
| 2026-10-22 | Local Postgres: `db:up` uses docker-compose when Docker is available, otherwise Homebrew `postgresql@16` in a repo-local cluster; tests read `DATABASE_URL` | M1-T01 |
| 2026-10-22 | `await_approval.wait_for` includes `pr.changes_requested` (board routed on it but never waited for it) | [pr_flow.v1.json](../design/workflows/pr_flow.v1.json) |
| 2026-10-22 | Added explicit failure routes the board omitted: `open_pr` fail/ask_user → needs_input; connector `error` → needs_input; agent timeouts | [05](../design/05-workflow-engine.md) |
| 2026-10-22 | Connector idempotency key = `session:state:visit_n`; Jira dedupes via `conductor-idem:<key>` label | [05](../design/05-workflow-engine.md#idempotency) |
| 2026-10-22 | Slack duplicate posts accepted (skill-based, can't dedupe) | [08](../design/08-failure-modes.md) |
| 2026-10-22 | M1 uses the smaller `m1_basic.v1` workflow; `pr_flow.v1` is M3 | [M1](../plan/milestones/M1-single-machine.md) |
| 2026-10-22 | TypeScript pnpm monorepo | [ADR-0004](../adr/0004-typescript-monorepo.md) |
| 2026-10-22 | Project lives at `~/code/backlog/conductor` ("conductor" is a working name) | — |
| 2026-10-21 | Users author workflow JSON directly; a visual editor later emits the same JSON | workshop |
| 2026-10-21 | Pull scheduler; keep leases + fencing; drop leader | [ADR-0001](../adr/0001-pull-scheduler.md) |
| 2026-10-21 | Orchestrator single decider; daemons dial out | [ADR-0002](../adr/0002-orchestrator-single-decider.md) |
| 2026-10-21 | Postgres + outbox; no broker | [ADR-0003](../adr/0003-postgres-outbox-no-kafka.md) |
