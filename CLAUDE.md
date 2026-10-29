# CLAUDE.md: conductor

Conductor is an orchestrator that runs Claude Code sessions autonomously across a fleet of machines. Tickets move through user-defined FSM workflows, and a kanban UI surfaces sessions that need a human. Start at [docs/design/00-overview.md](docs/design/00-overview.md).

This file is the **operating manual for every Claude session in this repo**. The repo is developed doc-first: design docs are the source of truth, and the files in `docs/tracking/` carry state between sessions. Follow the lifecycle below every time, unless you are a conductor agent (next section).

### Running as a conductor agent
If you were started by conductor on a ticket (your system prompt says "running unattended as a conductor session"), the workflow replaces the lifecycle:
- **Skip steps 0 and 4.** Don't brief Ben or wait for a go-ahead: the ticket is the go-ahead. Don't edit `docs/tracking/*` on the ticket branch. Put new unknowns, tech debt and follow-ups in your `complete_state` summary, and a human copies them onto `main`.
- **Skip the merge and push in step 3.** Conductor runs the gates, pushes and opens the PR. Commit your work and finish the step.
- **"Ask Ben" means `ask_user`**, never AskUserQuestion. **Commands that need approval** (installing a toolchain or package, curl, a new tool): just run them. The permission prompt reaches Ben on the board ([ADR-0023](docs/adr/0023-permission-prompts-through-conductor.md)). A rule here is a reason to ask, never a reason to give up on the ticket.

---

## Map

| Path | What |
|---|---|
| `docs/design/` | Design source of truth (00–09, `workflows/*.json`); change it in the same branch as code that changes behaviour |
| `docs/adr/` | Decisions that are costly to reverse (after Ben agrees) |
| `docs/plan/ROADMAP.md`, `docs/plan/milestones/M*.md` | Milestones → tasks (IDs, deps, parallel groups, acceptance) |
| `docs/tracking/STATUS.md` | One-screen dashboard; **rewritten** each session |
| `docs/tracking/UNKNOWNS.md` | Open questions U-### |
| `docs/tracking/BLOCKERS.md` | Walls needing action B-### |
| `docs/tracking/TECH_DEBT.md` | Deliberate shortcuts TD-### |
| `docs/tracking/UNFINISHED.md` | WIP handoffs between sessions |
| `docs/tracking/DECISIONS_LOG.md` | One-line decisions, newest first |
| `docs/tracking/sessions/` | One log per session |
| `docs/qa/` | QA checklist + test strategy |
| `docs/templates/` | Task, session-log, unknown, ADR templates |

### Every agent updates the tracking docs
The docs are how we track the status of work, so **every agent keeps them current**: a lead session, a local subagent, or a conductor ticket. Write the tracking changes on the same branch as the work they describe, so they land on `main` when it merges. A session with no task branch (planning, QA, reconcile) uses a `docs/<slug>` branch.
- **Your task's row** in the milestone table: `done` in the branch that finishes it (it becomes true when that branch merges), or `blocked` plus a B-### row. Update ROADMAP if the milestone changes state.
- **New rows** for what you find: U-### unknowns, B-### blockers, TD-### shortcuts (with `// TD-###` at the site), and one line per decision in DECISIONS_LOG.
- **UNFINISHED.md**: add an entry for anything you leave unmerged; remove your own entry when it lands.
- **A session log** in `docs/tracking/sessions/<YYYY-MM-DD>-<slug>.md`. It is a new file, so it never conflicts.
- **STATUS.md**: on a task branch, add, update or remove **only your own *In flight* row**. The full rewrite (now / health / progress / last session) belongs to the lead, at session end.

Parallel branches touch the same files, so:
- **IDs**: `git fetch origin`, then take the next free number after the highest on `origin/main` *and* on open PRs. If merging `origin/main` shows a collision, renumber **yours** (the row, `// TD-###` comments, references), never the one already on `main`.
- **Conflicts** in tracking files are resolved by keeping both sides' rows. Never drop or rewrite rows that came from `main`.

---

## Lifecycle

### 0 · Session start (always, before anything else)
1. Read, in order: `docs/tracking/UNFINISHED.md` → `STATUS.md` → `BLOCKERS.md` → open rows of `UNKNOWNS.md` that block the current milestone → the current milestone file.
2. Run `git worktree list` and `git branch --no-merged main`. Reconcile them with UNFINISHED and STATUS, and flag anything orphaned.
3. Tell Ben **in 3 lines**: where we are, what's in the way, and what you propose to do this session. Then wait for a go-ahead, unless Ben already gave the session a goal.

### 1 · Plan
1. Pick the next tasks from the milestone file: lowest parallel group with every dependency `done`.
2. **Unknowns gate**: if a task depends on an `open` U-###, resolve it first. Use a spike task, or ask Ben with AskUserQuestion. Record the answer in the U-### row, plus an ADR if it's costly to reverse. Never guess at a costly-to-reverse unknown and carry on.
3. A task that is bigger than one session (roughly > 400 lines changed, or touches > 1 package in non-trivial ways) is split into sub-tasks in the milestone file first.
4. Planning a new milestone means writing its file from [the task template](docs/templates/task.md): goal, exit criteria, "not in this milestone", blocking unknowns, task table with deps and parallel groups, task details. Ben approves it before work starts.
5. Set the chosen tasks to `in_progress` in the milestone table and in STATUS → *In flight*.

### 2 · Build
1. One task, one branch: `m<N>-t<NN>-<slug>`. Work on it directly; parallelize only when tasks are independent and big enough to be worth it.
2. Record new unknowns, blockers, tech debt and unfinished items in the tracking files **on your branch** as you go ([§Every agent updates the tracking docs](#every-agent-updates-the-tracking-docs)). A blocked task gets a B-### row and status `blocked`; tell Ben if the unblock action is his.
3. **Run only targeted tests while you work**: the files and package you touched, e.g. `pnpm vitest run --project daemon src/actions/open-pr.test.ts`, plus `pnpm typecheck`. Never run the full `pnpm test` or `pnpm lint` to check progress: the full gate runs **once per branch**, in step 3, or as conductor's own checks when a conductor ticket leaves `implementing` (they run in a fresh checkout under the daemon's build slots, so running them yourself first only doubles the load). If a targeted run reports `test slot: waiting…`, it is queued behind other runs on the machine: wait, don't retry or kill it (M2-T32).

### 3 · Check and merge
1. Before merging, check the branch against the task's acceptance criteria and [docs/qa/QA_CHECKLIST.md](docs/qa/QA_CHECKLIST.md): read the diff, run the gates once (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, Bash `timeout: 600000`: it may queue for a test slot). When a QA subagent runs them, the lead doesn't run them again.
2. Check that the branch carries its own tracking updates (task row, TD/U rows, session log) and add anything missing to the branch, then `git merge --no-ff` into `main`, set the task to `done`, and remove the worktree. **Never merge with a red gate.**

### 4 · Session end (always, even if the session was short or failed)
1. Every branch not merged gets an entry in `UNFINISHED.md` with the **exact next step**. Commit WIP on its branch (never leave uncommitted work in a worktree).
2. **Rewrite** `STATUS.md`: now / in flight / health counts / milestone progress / last session.
3. Write `docs/tracking/sessions/<YYYY-MM-DD>-<slug>.md` from the template.
4. Update the milestone table statuses and ROADMAP if a milestone changed state.
5. Commit the tracking updates on the branch the work is on, or on a `docs/<slug>` branch for a session without one: `docs(tracking): session <date> <slug>`.
6. End with a short report to Ben: done, merged, open, and the next command to run.

---

## Rules

- **Design docs are the source of truth.** If code needs to differ from a design doc, update the doc in the same branch. If it reverses an ADR, write a new ADR that supersedes it. Code and docs never knowingly disagree on `main`.
- **IDs are permanent.** U-, B-, TD-, ADR-, M?-T?? numbers are never reused, and rows are never deleted (they get a status instead).
- **Ask Ben** before anything hard to reverse or outward-facing: new external services, schema changes after M1, pushing to a remote, spending money, deleting data. Use AskUserQuestion with a recommended option.
- **Shortcuts are allowed only when recorded.** Add a TD-### row and leave a `// TD-###` comment at the site.
- **Raise unknowns early.** If you notice yourself guessing, write the U-### row.
- Workflow-engine invariants (enforced in review): transitions only on outcomes; every loop bounded; every failure path ends at a human; state + commands in one transaction; idempotency keys on external side effects.
- Prefer small PR-sized branches. One task, one branch.
- Commit messages: conventional style (`feat(daemon): …`, `docs(design): …`), with the session's attribution trailer.
- Remote: `origin` = github.com/benjgrad/conductor. Push task branches (`m<N>-t<NN>-*`) after QA. **Never push `main`**; Ben does that himself.
- Toolchain on Ben's Mac: Node 22 (`.nvmrc`; `.npmrc` `use-node-version=22.22.0` makes pnpm run scripts on Node 22 even if the shell's PATH has Node 20) and pnpm 10 (global npm install; never corepack). There is no Docker runtime. Postgres 16 is Homebrew `postgresql@16`, which is keg-only: `/opt/homebrew/opt/postgresql@16/bin`.

---

## Commands

Verified in M1-T13 on Node 22.22 / pnpm 10 (TypeScript 7, vitest 5, vite 8, eslint 10). Keep this section in sync with `package.json` scripts.

```bash
pnpm i                 # install (never corepack)
pnpm db:up             # start Postgres 16 on localhost:54329: docker-compose if `docker info` works, else
                       #   ONE shared Homebrew postgresql@16 cluster for all worktrees, data in
                       #   ~/.local/share/conductor/pgdata (idempotent, safe to run concurrently)
pnpm db:down           # stop it for every worktree (data kept; delete the pgdata dir to reset)
scripts/db.sh status   # is it up?   scripts/db.sh url  # print the resolved DATABASE_URL
pnpm db:migrate        # node-pg-migrate up, migrations in packages/orchestrator/migrations
pnpm db:migrate down   # roll back one; `scripts/db.sh migrate create <name>` makes a new one
pnpm build             # tsc -b (all packages) + vite build (web)
pnpm typecheck         # tsc -b across the workspace (project references; emits to gitignored dist/)
pnpm lint              # eslint (type-aware, in a test slot) + prettier --check
pnpm format            # prettier --write
pnpm test              # vitest, one project per package (DB tests need db:up), in a test slot
pnpm test:e2e          # db up + tsc -b + e2e/ suite: real orchestrator + daemon bins, fake Claude (~15 s)
E2E_REAL_CLAUDE=1 pnpm test:e2e   # ask/answer only, real `claude` on haiku (spends money; not in CI)
scripts/ci.sh          # all gates, in order: install, typecheck, lint, cargo fmt/clippy/nextest, parity, deploy kit (deploy/gradyserver/test/run.sh), db:up, test, build, test:e2e
```

The Rust daemon (ADR-0026, milestone MR) is a Cargo workspace at the root (`crates/*`, toolchain pinned in `rust-toolchain.toml`), outside the pnpm workspace:
```bash
cargo fmt --all [--check]                                  # rustfmt
cargo clippy --workspace --all-targets -- -D warnings      # lint; warnings fail
node scripts/test-slot.js cargo nextest run --workspace    # every Rust test, in a test slot
cargo nextest run -p conductor-daemon <filter>             # targeted while iterating (e.g. `seam`)
cargo build --release -p conductor-daemon                  # target/release/conductor-daemon
node scripts/test-parity.js [--files <glob>]… [--write]    # crates/conductor-daemon/PARITY.md vs the TS tests
```

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `scripts/ci.sh` as the `gates` check on every PR; a PR runs only the slow test tiers its diff reaches (`CONDUCTOR_CI_TIERED=1` → `pnpm test`), and `main` runs `test:all`. `daemon-windows.yml` runs the daemon tests on Windows only when the diff reaches the daemon (`scripts/test-affected.js`). `daemon-rust.yml` runs the cargo gates and a release build on ubuntu, macos and windows only when the diff reaches `crates/**`, `Cargo.*`, `rust-toolchain.toml` or `packages/shared/**`. Every push to `main` that passes it is deployed to gradyserver by `deploy/gradyserver/deploy.sh` (runbook [§12](docs/setup/deploy-gradyserver.md#12-cicd-github-actions)), so merging to `main` ships.

**Test slots (M2-T31).** Every vitest run (however it is started) and `pnpm lint` first takes one of `CONDUCTOR_TEST_SLOTS` (default 2) machine-wide slots, shared by every worktree and agent (`scripts/test-slot.js`: a localhost port from 54330, freed when the holder exits), and vitest uses only its share of the CPUs (`maxWorkers`). If both are taken it prints `test slot: waiting…` with the holders and starts by itself; that is a queue, not a hang, so give long test commands a long Bash timeout (`timeout: 600000`) rather than retrying. Watch mode takes no slot.

`DATABASE_URL` is resolved the same way by `scripts/db.sh` and `vitest.config.ts`: process env, else `.env`, else `.env.example`. The orchestrator itself reads only `process.env.DATABASE_URL`; whatever launches it sets it. DB tests never use that database directly: `useTestDatabase()` / `createTestDatabase()` in `packages/orchestrator/test/db.ts` create `conductor_test_<branch>_<random>` on the same server, migrate it, and drop it afterwards, so worktrees can run DB tests at the same time. `tsc` is TypeScript 7 (the `typescript7` alias); the `typescript` module is `@typescript/typescript6` because typescript-eslint needs the TS 6 JS API. Workspace packages resolve each other from source in vitest/vite via the `source` export condition, so tests run without a build. `spikes/**` is outside the workspace, lint and typecheck.

Validate workflow JSON before the validator exists:
```bash
python3 -m json.tool docs/design/workflows/pr_flow.v1.json > /dev/null
```

---

## Stack

TypeScript (strict) pnpm monorepo: `packages/shared` (zod schemas, validator, FSM `apply()`), `packages/orchestrator` (Fastify, pg, SSE, outbox), `packages/daemon` (WS client, worktrees, Claude Code driver), `packages/web` (React + Vite). Postgres 16. See [ADR-0004](docs/adr/0004-typescript-monorepo.md).
