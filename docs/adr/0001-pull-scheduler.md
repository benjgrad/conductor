# ADR-0001 · Pull-based scheduler, keeping leases and fencing

- **Status**: accepted
- **Date**: 2026-10-21 (workshop), recorded 2026-10-22
- **Deciders**: Ben, workshop coach

## Context
The workshop first designed a push scheduler: a central placement loop with leader election, filter/score/claim, and per-machine reservation counters. At ~50 machines that is more machinery than we need. The hard requirement is recovering sessions from sleeping laptops, and leases plus fencing tokens cover that, not the leader.

## Decision
Daemons **pull**: when a daemon has a free slot it sends `request_work` with its repo inventory and live resources. The orchestrator claims the best-matching `ready` ticket in one transaction (`FOR UPDATE SKIP LOCKED`), with tags and repo allow-lists as SQL filters and repo locality, affinity and priority as the score. A **short hold** (`retry_after`) stops a weak machine from grabbing a ticket when a much better machine is online. **Kept**: leases, heartbeats, fencing tokens, per-session branches. **Dropped**: leader election and central reservation counters. Each daemon's own sessions define its reservations.

Details: [04-scheduler](../design/04-scheduler.md).

## Alternatives considered
| Option | Why not |
|---|---|
| Push: central filter/score/claim loop with a leader | Better global placement, but needs leader election and central accounting. Not needed at this scale. |
| Pure greedy pull, no hold | Machines without the repo steal tickets and pay multi-minute clones |

## Consequences
- Good: no leader, and any orchestrator replica can serve claims. Simpler to build and test.
- Bad: placement is greedy, and the short hold is a heuristic.
- Follow-ups: the hold state is in-memory in v1 (log as TD when built).

## Revisit when
Clone time or contention visibly hurts throughput. For example, > 20 % of claims need a fresh clone, or the needs-input queue grows because machines are mismatched.
