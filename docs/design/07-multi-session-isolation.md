# 07 · Many sessions on one machine

There are four things to isolate: **code**, **CPU/memory**, **network ports**, and **caches**. The daemon is the local authority.

## Code: one worktree per session
- The daemon keeps one **shared clone** per repo (recorded in `machine_repo`). Agents never edit it.
- Each session gets `git worktree add <root>/wt/<session_id> -b conductor/<ticket>/<short> <base>`. The object store is shared, so checkout is cheap. Five agents on one repo never touch each other's files.
- **Fresh base (M2-T13a, TD-026).** Before creating a *new* session branch the daemon runs `git -c core.hooksPath=/dev/null fetch origin <default_branch>` in the shared clone, serialised per clone (concurrent starts fetch one at a time), and `<base>` is the fetched `origin/<default_branch>` (no upstream tracking), never the clone's own `HEAD`. `<default_branch>` is the caller's value when given (`start_session.working_copy.default_branch` once the contract carries it), else the clone's `origin/HEAD`, set once with `git remote set-head origin --auto` if missing. `base_ref` `HEAD` (the M1 default) means exactly this; another `base_ref` is used as given after the fetch. A failed fetch fails the start with an error naming the repo: no silent stale base. An existing worktree or branch (resume, re-sent start, ADR-0008 reopen) is reused untouched: no fetch into it, no rebase.
- `machine_repo.tree_clean` therefore describes only the shared clone. A dirty main checkout no longer matters.
- Worktree GC: the daemon removes worktrees of sessions that are `done`/`failed`/`lost` after their branch is pushed (or after N days). Policy is TBD in M2.

## Worktree setup (R2)
An agent starts in a worktree whose dependencies are installed (workflow retrospective R2: missing `node_modules`, corepack download prompts and the like were a third of implementing's friction).
- **When.** Every working-agent `start_session` (not a requirements reviewer, `review: true`, and not a QA start with `checkout`, which runs its own setup in its checkout), on a new worktree or one reused after a reclaim or reopen, after the worktree and attachments and before Claude is spawned.
- **What.** `start_session.worktree_setup`: the repo checks override's `setup` ([ADR-0030](../adr/0030-per-repo-checks-and-mcp-workflow-tools.md)), set by the orchestrator only when the repo has an override; absent or null = the check checkout's lockfile auto-detect ([05](05-workflow-engine.md#requirements-to-enter-a-column-adr-0010)), `''` = none. One difference from the check checkout: a bare `package.json` (no lockfile) runs `npm install --no-package-lock --no-audit --no-fund`, because a plain `npm install` would leave an untracked `package-lock.json` in the worktree and fail every later `require_clean` entry check. A workflow's own `entry.setup` is not used here.
- **Skipped while unchanged.** A successful run writes a marker, `<git dir>/conductor-worktree-setup` (the worktree's own git dir from `git rev-parse --absolute-git-dir`, so it is never in the work tree, never committed, never dirty), holding a sha256 over the command and the content of `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `package.json` and `Cargo.lock`. The next start skips the setup while the key matches (a debug line says so). A failed run removes the marker.
- **How it runs.** Through the command runner, so under the build semaphore (a waiting setup reports `build_slot`), with a 15 minute timeout (`WORKTREE_SETUP_TIMEOUT`), env `CONDUCTOR_SESSION_ID`, `CONDUCTOR_TICKET_ID`, the git identity and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. Its output and `conductor: worktree setup …` lines go to the session output. A kill or a superseding start cancels it.
- **Ack.** A setup can outlast the orchestrator's ~35 s ack window (TD-200), so a start that runs one is acked `accepted` before the setup, once the spawn's own refusal checks (worktree in use, superseded or killed, `no_conversation`) have passed. From then on the start never becomes a refusal: if it ends without a process (killed, superseded, a spawn error) the daemon reports `session_event exit {command_id, code: null, signal: null, stderr_tail: <why>}`, which apply handles as an agent that exited (`start_failed: …` included, so it is not counted like a `start_failed` refusal). A daemon restart during the setup reports `exit {signal: daemon_restart}` for it. A start with nothing to run (no setup, or up to date) is acked at the spawn, as before.
- **Failures** are triaged like the check checkout's ([05 §Setup failures](05-workflow-engine.md#requirements-to-enter-a-column-adr-0010)) and the agent is started anyway, with a `## Setup failed` section appended to its prompt.
- **Every agent** (reviewers included) also gets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`: one of the driver's fixed agent-env pins (`agent_env_pins`, ADR-0006's `AGENT_ENV`), so the state-env allowlist never drops it.

## Compute: reservations, not live usage
- The machine advertises a budget. Example: 8 cores and 16 GB, minus an **owner reserve** on laptops (default 25 %).
- Each session reserves **1 core / 2 GB** (configurable per workflow later). Eligibility in [04](04-scheduler.md) uses reservations.
- **Build semaphore**: command states (build/test/lint), entry checks and their setup, and the agent-worktree setup below go through a per-machine semaphore, `max_concurrent_builds` (default 2). Waiting sessions report `waiting_for_build_slot` (`session_event build_slot`), so the UI shows "waiting for build slot" and not "stuck".
- Enforcement uses cgroups or container limits where available (Linux). On macOS, `nice` plus a watchdog that kills commands over a memory limit ([U-004](../tracking/UNKNOWNS.md)).
- **Daemon veto**: under high memory pressure the daemon refuses `start_session` (`command_ack accepted=false`), and the ticket returns to `ready`.

## Ports
- The daemon allocates each session a port range (default 10 ports from a pool, e.g. 41000–48999). It passes the range as env: `CONDUCTOR_PORT_BASE`, `PORT`, `CONDUCTOR_PORT_COUNT`.
- Later: container per session with its own network namespace.

## Caches
- Package caches and build outputs live per worktree.
- Shared, content-addressed caches are safe to share read-mostly (pnpm store, Docker layer cache).

## Logical conflicts
Two tickets editing the same files is a merge-time problem, not a machine problem. Later the scheduler can penalise co-placing tickets tagged with the same area, and a workflow `rebase` state handles the rest. Not in M1.
