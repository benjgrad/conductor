# CLAUDE.md: conductor

Conductor is an orchestrator that runs Claude Code sessions autonomously across a fleet of machines. Tickets move through user-defined FSM workflows, and a kanban UI surfaces sessions that need a human. Start at [docs/design/00-overview.md](docs/design/00-overview.md).

This file is the **operating manual for every Claude session in this repo**. The repo is developed doc-first: design docs are the source of truth, and the files in `docs/tracking/` carry state between sessions. Follow the lifecycle below every time.

---

## Map

| Path | What | Who writes it |
|---|---|---|
| `docs/design/` | Design source of truth (00–09, `workflows/*.json`) | Lead, in the same branch as code that changes behaviour |
| `docs/adr/` | Decisions that are costly to reverse | Lead (after Ben agrees) |
| `docs/plan/ROADMAP.md`, `docs/plan/milestones/M*.md` | Milestones → tasks (IDs, deps, parallel groups, acceptance) | Lead / `planner` agent |
| `docs/tracking/STATUS.md` | One-screen dashboard; **rewritten** each session | Lead / `doc-keeper` |
| `docs/tracking/UNKNOWNS.md` | Open questions U-### | Lead / `doc-keeper` |
| `docs/tracking/BLOCKERS.md` | Walls needing action B-### | Lead / `doc-keeper` |
| `docs/tracking/TECH_DEBT.md` | Deliberate shortcuts TD-### | Lead / `doc-keeper` |
| `docs/tracking/UNFINISHED.md` | WIP handoffs between sessions | Lead / `doc-keeper` |
| `docs/tracking/DECISIONS_LOG.md` | One-line decisions, newest first | Lead / `doc-keeper` |
| `docs/tracking/sessions/` | One log per session | Lead / `doc-keeper` |
| `docs/qa/` | QA checklist + test strategy | Lead |
| `docs/templates/` | Task, session-log, unknown, ADR templates | — |
| `.claude/agents/` | `planner`, `implementer`, `qa-reviewer`, `doc-keeper` | — |

**Implementer agents never edit `docs/tracking/*`.** They report; the lead (or `doc-keeper`) records. That keeps parallel branches free of merge conflicts in tracking files.

---

## Lifecycle

### 0 · Session start (always, before anything else)
1. Read, in order: `docs/tracking/UNFINISHED.md` → `STATUS.md` → `BLOCKERS.md` → open rows of `UNKNOWNS.md` that block the current milestone → the current milestone file.
2. Run `git worktree list` and `git branch --no-merged main`. Reconcile them with UNFINISHED and STATUS, and flag anything orphaned.
3. Tell Ben **in 3 lines**: where we are, what's in the way, and what you propose to do this session. Then wait for a go-ahead, unless Ben already gave the session a goal.

### 1 · Plan
1. Pick the next tasks from the milestone file: lowest parallel group with every dependency `done`.
2. **Unknowns gate**: if a task depends on an `open` U-###, resolve it first. Use a spike task, or ask Ben with AskUserQuestion. Record the answer in the U-### row, plus an ADR if it's costly to reverse. Never guess at a costly-to-reverse unknown and carry on.
3. A task that is bigger than one agent session (roughly > 400 lines changed, or touches > 1 package in non-trivial ways) is split into sub-tasks in the milestone file first. The `planner` agent can do this.
4. Planning a new milestone means writing its file from [the task template](docs/templates/task.md): goal, exit criteria, "not in this milestone", blocking unknowns, task table with deps and parallel groups, task details. Ben approves it before work starts.
5. Set the chosen tasks to `in_progress` in the milestone table and in STATUS → *In flight*.

### 2 · Orchestrate (multi-agent)
The lead session is the orchestrator. It delegates and integrates, and doesn't do large implementation itself.

1. For each independent task in the current parallel group, spawn one **`implementer`** agent with `isolation: "worktree"`, all in **one message** so they run concurrently. Branch name: `m<N>-t<NN>-<slug>`.
2. The brief is the only context the agent gets. It must include:
   - the task block copied from the milestone file (scope, acceptance, files owned, do-not-touch)
   - the design doc sections to read (paths, not pasted text)
   - relevant resolved unknowns/ADRs
   - "Do not edit docs/tracking/*. End with the report format in your agent definition."
3. Don't run two agents that own overlapping files. If tasks would overlap, run them in sequence.
4. When an agent reports back:
   - Record its **new unknowns, blockers, tech debt, unfinished items** in the tracking files, directly or through `doc-keeper`.
   - Send the branch to QA (step 3).
5. If an agent comes back blocked, add a B-### row, mark the task `blocked`, and move on to other tasks. Tell Ben if the unblock action is his.

### 3 · QA
1. For each finished branch, spawn a **`qa-reviewer`** agent on that branch with the task's acceptance criteria. It runs [docs/qa/QA_CHECKLIST.md](docs/qa/QA_CHECKLIST.md) and returns a verdict with evidence.
2. `FAIL` → send the findings back to a new `implementer` on the same branch (SendMessage to the original agent if it's still available). Re-QA afterwards.
3. `PASS` / `PASS WITH DEBT` → the lead records the TD rows, then merges the branch into `main` (`git merge --no-ff`). It sets the task to `done` and removes the worktree. **Never merge with a red gate.**
4. After merging a group, run the full gates on `main` once (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`).

### 4 · Session end (always, even if the session was short or failed)
1. Every branch not merged gets an entry in `UNFINISHED.md` with the **exact next step**. Commit WIP on its branch (never leave uncommitted work in a worktree).
2. **Rewrite** `STATUS.md`: now / in flight / health counts / milestone progress / last session.
3. Write `docs/tracking/sessions/<YYYY-MM-DD>-<slug>.md` from the template.
4. Update the milestone table statuses and ROADMAP if a milestone changed state.
5. Commit the tracking updates on `main`: `docs(tracking): session <date> <slug>`.
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
- No remote is configured yet. When one is, push task branches and never push to `main` without Ben's say-so.

---

## Commands

> Valid once M1-T01 lands. Update this section in the same branch if the scaffold differs.

```bash
pnpm i                 # install
pnpm db:up             # start Postgres (docker-compose)
pnpm db:migrate        # apply migrations
pnpm build             # build all packages
pnpm typecheck         # tsc --noEmit across workspace
pnpm lint              # eslint
pnpm test              # unit + integration (needs db:up)
pnpm test:e2e          # orchestrator + daemon + fake Claude end to end
scripts/ci.sh          # all gates, in order
```

Validate workflow JSON before the validator exists:
```bash
python3 -m json.tool docs/design/workflows/pr_flow.v1.json > /dev/null
```

---

## Stack

TypeScript (strict) pnpm monorepo: `packages/shared` (zod schemas, validator, FSM `apply()`), `packages/orchestrator` (Fastify, pg, SSE, outbox), `packages/daemon` (WS client, worktrees, Claude Code driver), `packages/web` (React + Vite). Postgres 16. See [ADR-0004](docs/adr/0004-typescript-monorepo.md).
