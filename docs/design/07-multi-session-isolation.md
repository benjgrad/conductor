# 07 · Many sessions on one machine

There are four things to isolate: **code**, **CPU/memory**, **network ports**, and **caches**. The daemon is the local authority.

## Code: one worktree per session
- The daemon keeps one **shared clone** per repo (recorded in `machine_repo`). Agents never edit it.
- Each session gets `git worktree add <root>/wt/<session_id> -b conductor/<ticket>/<short> <base>`. The object store is shared, so checkout is cheap. Five agents on one repo never touch each other's files.
- **Fresh base (M2-T13a, TD-026).** Before creating a *new* session branch the daemon runs `git -c core.hooksPath=/dev/null fetch origin <default_branch>` in the shared clone, serialised per clone (concurrent starts fetch one at a time), and `<base>` is the fetched `origin/<default_branch>` (no upstream tracking), never the clone's own `HEAD`. `<default_branch>` is the caller's value when given (`start_session.working_copy.default_branch` once the contract carries it), else the clone's `origin/HEAD`, set once with `git remote set-head origin --auto` if missing. `base_ref` `HEAD` (the M1 default) means exactly this; another `base_ref` is used as given after the fetch. A failed fetch fails the start with an error naming the repo: no silent stale base. An existing worktree or branch (resume, re-sent start, ADR-0008 reopen) is reused untouched: no fetch into it, no rebase.
- `machine_repo.tree_clean` therefore describes only the shared clone. A dirty main checkout no longer matters.
- Worktree GC: the daemon removes worktrees of sessions that are `done`/`failed`/`lost` after their branch is pushed (or after N days). Policy is TBD in M2.

## Compute: reservations, not live usage
- The machine advertises a budget. Example: 8 cores and 16 GB, minus an **owner reserve** on laptops (default 25 %).
- Each session reserves **1 core / 2 GB** (configurable per workflow later). Eligibility in [04](04-scheduler.md) uses reservations.
- **Build semaphore**: command states (build/test/lint) go through a per-machine semaphore, `max_concurrent_builds` (default 2). Waiting sessions report `waiting_for_build_slot`, so the UI shows "waiting for build slot" and not "stuck".
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
