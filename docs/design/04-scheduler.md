# 04 · Scheduler (pull model)

> Decision: [ADR-0001](../adr/0001-pull-scheduler.md). Daemons ask for work; the orchestrator answers with the best-matching ready ticket, claimed in one transaction. No placement loop and no leader. **Leases, heartbeats and fencing tokens stay**, because they recover sessions from sleeping laptops.

## Flow

```mermaid
sequenceDiagram
  participant D as Daemon
  participant O as Orchestrator
  participant P as Postgres
  D->>O: request_work {free_slots, repos[], live cpu/mem, tags}
  O->>O: hard filters on machine (online, slots, headroom)
  O->>P: BEGIN; claim query (FOR UPDATE SKIP LOCKED)
  P-->>O: candidate tickets + score
  alt best candidate is a strong match, or no better machine is waiting
    O->>P: INSERT session (assigned, lease, fencing_token); ticket→claimed; outbox start_session; COMMIT
    O-->>D: work_assignment (via outbox dispatcher)
    D-->>O: command_ack accepted
  else a much better machine is online with headroom
    O->>P: ROLLBACK
    O-->>D: retry_after {ms: 3000}   (short hold)
  end
```

## 1 · Filter (machine side, cheap)

The daemon is eligible to receive work only if all of these hold:
- `status = 'online'` and the heartbeat is fresh (< 30 s).
- `running_sessions < max_sessions`.
- Reserved resources leave room: `budget_cpu - Σ reserved_cpu ≥ 1` and `budget_mem_mb - Σ reserved_mem ≥ 2048`. The per-session reservation defaults to **1 core, 2 GB**. The sum comes from the machine's own active sessions, so there are no central counters ([07](07-multi-session-isolation.md)).
- Live memory pressure is not critical. The daemon reports it and may also refuse a `start_session`.

## 2 · Claim query (ticket side)

The daemon's repo inventory and tags arrive in the request. Hard constraints filter in SQL; the soft score orders the result.

```sql
-- $1 machine_id, $2 machine_tags text[], $3 repos jsonb  [{repo, head_commit, tree_clean}]
WITH inv AS (
  SELECT r->>'repo' AS repo, (r->>'tree_clean')::bool AS tree_clean
  FROM jsonb_array_elements($3) r
)
SELECT t.id,
       ( CASE WHEN inv.repo IS NOT NULL THEN 100 ELSE 0 END          -- repo locality (biggest weight)
       + CASE WHEN inv.tree_clean THEN 10 ELSE 0 END                 -- clean shared clone
       + CASE WHEN aff.machine_id = $1 THEN 50 ELSE 0 END            -- affinity: prior session of this ticket here
       + t.priority * 5
       - CASE WHEN inv.repo IS NULL THEN 40 ELSE 0 END               -- clone penalty
       ) AS score
FROM ticket t
LEFT JOIN inv ON inv.repo = t.repo
LEFT JOIN LATERAL (
  SELECT s.machine_id FROM session s
  WHERE s.ticket_id = t.id ORDER BY s.created_at DESC LIMIT 1
) aff ON true
WHERE t.status = 'ready'
  AND t.required_tags <@ $2                                           -- hard: tags (gpu, os, …)
  AND (t.repo_allow_machines IS NULL OR $1 = ANY(t.repo_allow_machines)) -- hard: allow-list
ORDER BY score DESC, t.priority DESC, t.created_at
LIMIT 1
FOR UPDATE OF t SKIP LOCKED;
```

Then, in the **same transaction**:
1. `UPDATE ticket SET status='claimed'`.
2. `INSERT session (status='assigned', machine_id, fencing_token = nextval('fencing_seq'), lease_expires_at = now() + interval '2 minutes', branch = 'conductor/<ticket>/<short>')`.
3. Insert the `start_session` command into the `outbox`.
4. `COMMIT`. The dispatcher sends the command. The daemon must `command_ack` within 30 s, otherwise the session goes back to `queued` and the ticket to `ready`.

> `ticket.repo_allow_machines` isn't in [02](02-data-model.md) yet. It gets added in M1-T02 or dropped. Tracked in [U-009](../tracking/UNKNOWNS.md).

## 3 · Short-hold rule (softening greedy pull)

A pull scheduler is greedy. A machine without the repo might grab a ticket a second before a machine that has it. The fix:

- If the best score for this daemon is **< 100** (no repo locality), and some *other* machine with a fresh heartbeat, free slots **and** that repo exists, reply `retry_after 3s` instead of claiming.
- A ticket may be held this way at most **3 times / 30 s**. After that, any eligible machine may claim it. A `ticket.hold_count` / `hold_until` pair or an in-memory map tracks this. In-memory is fine for one orchestrator, so record it as TD if chosen.
- Move to a central scorer only when placement quality visibly hurts ([ADR-0001](../adr/0001-pull-scheduler.md), revisit trigger).

## 4 · Leases and fencing

- Each heartbeat renews `lease_expires_at` for every session it lists, provided its token matches.
- A **reaper** (periodic query, safe to run on any replica) finds sessions with `lease_expires_at < now() - grace` (grace **2 min**, which covers network blips). It marks them `lost`, writes an event, then **requeues**: a new assignment gets a higher `fencing_token`. It prefers resuming from `claude_session_id` when the branch was pushed. See [08](08-failure-modes.md#laptop-sleep).
- Any event or ack carrying an older token is rejected, and the orchestrator sends `kill`.
- Fencing protects **our DB only**, not the git remote. That's why each session pushes to its **own branch name**.

## Parked sessions

States with `release_machine: true` (e.g. `await_approval`) set `machine_id = NULL` and free the reservation. When the event arrives, the session goes back to `queued` with affinity to its old machine. The next state can run on any machine, by resuming from the pushed branch plus `claude_session_id`.
