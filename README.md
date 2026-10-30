# conductor

An autonomous orchestrator for Claude Code. Machine daemons on developer laptops and build servers dial out to a central control plane. That control plane claims tickets, runs them through user-defined FSM workflows (implement → build → test → PR → notify → approve → update tickets), and shows every session on a kanban board. Sessions that need a human go to a *Needs input* column. You answer there and the agent continues.

**Status**: M1 (single machine) complete. See [docs/tracking/STATUS.md](docs/tracking/STATUS.md).

- Design: [docs/design/00-overview.md](docs/design/00-overview.md)
- Roadmap: [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md)
- Add a machine (install and run the daemon): [docs/setup/add-a-machine.md](docs/setup/add-a-machine.md), also in the app at `/help/add-a-machine`
- Connect Claude Code, claude.ai or Claude Desktop over MCP: [docs/setup/connect-claude.md](docs/setup/connect-claude.md)
- How we work (planning, multi-agent sessions, QA): [CLAUDE.md](CLAUDE.md)

## Run it locally

Needs Node 22, pnpm 10, Postgres 16 (Docker, or Homebrew `postgresql@16`), and a logged-in `claude` CLI.

```bash
pnpm i && pnpm build                 # builds the packages and the web app
pnpm db:up && pnpm db:migrate        # local Postgres on :54329, database `conductor`

# 1. Orchestrator: API + kanban on http://127.0.0.1:7400
DATABASE_URL=postgres://conductor:conductor@localhost:54329/conductor \
  node packages/orchestrator/dist/bin.js

# 2. Daemon (another terminal): dials the orchestrator and runs `claude` in git worktrees
CONDUCTOR_ALLOW_LOCAL_REPOS=1 node packages/daemon/dist/main.js
```

Then save a workflow once:

```bash
curl -X POST -H 'content-type: application/json' http://127.0.0.1:7400/api/workflows \
  -d "{\"definition\": $(cat docs/design/workflows/m1_basic.v1.json)}"
```

Open http://127.0.0.1:7400, click **New ticket**, point **Repo** at a git repo (a local path needs `CONDUCTOR_ALLOW_LOCAL_REPOS=1`) whose `npm run build` and `npm test` work, and describe the change. The card moves Queued → Running → Done. When the agent asks something it lands in **Needs input**: click it, answer, and the same Claude process carries on.

Notes:
- **Agents use your Claude Code setup** ([ADR-0006](docs/adr/0006-agents-inherit-claude-code-settings.md)):
  - they sign in the way your `claude` does, so on a subscription there is no per-token bill (the card's `$` is Claude Code's estimate);
  - with no `model` in the workflow, they use your account's default model (Opus on Max);
  - they follow your `~/.claude/settings.json` permission mode, rules, hooks and skills, plus the repo's CLAUDE.md;
  - a repo's own `.claude/settings.json` is ignored, because the repo is untrusted.
- **Conductor always enforces these guards**, whatever your settings say:
  - file edits stay inside the session worktree;
  - `git push` is denied;
  - agents see no MCP servers but conductor's (your claude.ai connectors are hidden);
  - a `bypassPermissions` default runs agents in `auto` instead.
- **Keep `ANTHROPIC_API_KEY` out of the daemon's environment.** If it's set, `claude` bills the API instead of your subscription.
- Keep `CONDUCTOR_ROOT` (default `~/.conductor`) **outside any `.claude` directory**; Claude Code treats files there as protected config.
- Run one daemon per `CONDUCTOR_MACHINE_ID` (default: the hostname).
- Daemon env vars are listed in `packages/daemon/src/config.ts`; the orchestrator takes `DATABASE_URL`, `CONDUCTOR_PORT` (7400) and `CONDUCTOR_WEB_DIR`.
- `pnpm test:e2e` runs the whole loop against a fake `claude`; `E2E_REAL_CLAUDE=1 pnpm test:e2e` uses the real one on haiku (on a subscription it uses quota, not money).
