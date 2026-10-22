# 07 · Many sessions on one machine

There are four things to isolate: **code**, **CPU/memory**, **network ports**, and **caches**. The daemon is the local authority.

## Code: one worktree per session
- The daemon keeps one **shared clone** per repo (recorded in `machine_repo`). Agents never edit it.
- Each session gets `git worktree add <root>/wt/<session_id> -b conductor/<ticket>/<short> <base_ref>`. The object store is shared, so checkout is cheap. Five agents on one repo never touch each other's files.
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
