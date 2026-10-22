# ADR-0004 · TypeScript pnpm monorepo

- **Status**: accepted
- **Date**: 2026-10-22
- **Deciders**: Ben

## Decision
One language end to end, pnpm workspaces:

```
packages/
  shared/        # workflow schema + validator, FSM apply(), protocol types (zod)
  orchestrator/  # Node + Fastify, pg, SSE, outbox dispatcher, connectors
  daemon/        # Node; WS client, worktrees, spawns `claude`, command runner
  web/           # React + Vite kanban
```

Tooling: TypeScript strict, vitest, eslint, prettier, zod for runtime schemas, Postgres 16 via docker-compose, node-pg-migrate 9 (chosen in M1-T01).

## Alternatives considered
| Option | Why not |
|---|---|
| Go orchestrator + daemon | Easier daemon distribution (a static binary), but two toolchains and the workflow types get duplicated |

## Consequences
- Good: `packages/shared` gives the engine, UI and daemon one definition of workflow JSON and protocol messages.
- Bad: the daemon needs Node on every machine. That's acceptable because Claude Code already requires it.

## Revisit when
Daemon install friction becomes real (e.g. packaging for non-dev build servers).
