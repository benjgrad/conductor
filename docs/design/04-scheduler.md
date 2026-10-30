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
    O->>P: ticket→claimed; INSERT (or re-use) session (queued, lease, fencing_token); applyEvent(session.assigned) → assigned + outbox start_session; COMMIT
    O-->>D: work_assignment (direct reply; start_session follows via the outbox)
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

Then, in the **same transaction** (pinned in [10](10-contracts.md#claim)):
1. `UPDATE ticket SET status='claimed'`.
2. If the ticket has a non-terminal session (`queued`, e.g. after a refused `start_session`), `UPDATE` that session: `fencing_token = nextval('fencing_seq')`, `lease_expires_at = now() + interval '2 minutes'`. Otherwise `INSERT session (status='queued', workflow_state=null, machine_id=null, fencing_token = nextval('fencing_seq'), lease_expires_at = now() + interval '2 minutes', branch = sessionBranch(ticket_id, session_id))`, i.e. `conductor/<ticket_id>/<first 8 of session_id>`. One session per ticket at a time, so one card.
3. `EngineService.applyEvent(session.assigned {machine_id}, {tx})`: sets `machine_id`, `status = 'assigned'`, enters `def.start` and writes the `start_session` outbox row.
4. `COMMIT`, then publish the returned board events. The dispatcher sends the command. The daemon must `command_ack` within ~30 s, otherwise the dispatcher fails the row (`ack_timeout`) and applies `command.refused`: the session goes back to `queued` and the ticket to `ready`.

`ticket.repo_allow_machines` is a nullable `text[]` in [02](02-data-model.md) (null = any machine; [U-009](../tracking/UNKNOWNS.md) resolved: keep).

**Reopen pin ([ADR-0008](../adr/0008-transcript-history-and-reopen.md)).** A reopened ticket's new session is `queued` on the branch of the session it reopens. That branch's worktree and Claude's transcript (which `--resume` needs, [ADR-0005](../adr/0005-claude-code-driver.md)) exist only on the machine that ran it, so the claim treats it as a **hard** filter, not as the +50 affinity score: a ticket with a `queued` session whose `branch` an earlier session of the same ticket ran on a machine is claimable only by that machine. The M1 claim (`gateway/claim.ts`) adds:
```sql
AND NOT EXISTS (SELECT 1 FROM session q
                  JOIN session p ON p.ticket_id = q.ticket_id AND p.id <> q.id AND p.branch = q.branch
                 WHERE q.ticket_id = t.id AND q.status = 'queued'
                   AND p.machine_id IS NOT NULL AND p.machine_id <> $1)
```
It holds across requeues (it reads the earlier session, not the queued one's `machine_id`). If that machine never comes back, the card waits in Queued until a human cancels it (TD: cross-machine reopen would need the branch pushed and the transcript shipped, ADR-0005 revisit).

**Routing filters (M2-T16a, [ADR-0013](../adr/0013-machine-enrollment-inventory-routing.md) §Routing).** The claim as built has no soft score yet (the query above is the target); it orders by `priority DESC, created_at, id` and adds these hard filters to the tag, allow-list and pin filters ([10 §Machines protocol v2](10-contracts.md#machines-protocol-v2) "Matching" is the authority):
- **Account**: `t.account_id` = the machine's.
- **Repo**: the machine has a `machine_repo` with `remote IS NOT NULL AND lower(remote) = lower(t.repo)` (github.com org/repo are case-insensitive). A ticket whose `repo` is not canonical (`CANONICAL_REMOTE_RE`, no `.git`; only `local` mode allows it) skips this filter, as in M1.
- **Capabilities**: every requirement of the ticket's effective workflow version (pinned, else latest) for its `kind` is a stored `machine_capability.key` of the machine; a key with `@<repo>` compares case-insensitively, and a bare `skill:<n>` / `agent:<n>` is also met by `…@<t.repo>`. The requirements come from `requiredCapabilities(def, kind)`, cached in memory per (workflow, version, kind) until M2-T12 stores them on save. One pre-pass per claim reads the distinct (workflow, version, kind) of the account's ready tickets and passes the requirement rows as arrays; a ticket whose combination isn't in that set is not picked. The inner lookups use the `(machine_id, …)` primary keys, so no new index.
- **Machine-lost pin**: a ticket with a `queued` session whose `context.__machine_lost.machine_id` names another machine is not offered ([10](10-contracts.md#machines-protocol-v2) "Lost machines").
- **Repo rules** ([ADR-0013](../adr/0013-machine-enrollment-inventory-routing.md) amendment 2026-10-30): the machine's own `repo_allow` (null = any) has a pattern matching `t.repo`, and no other unrevoked machine of the account, online or not, has a matching `repo_exclusive` pattern. So "only the work laptop takes `github.com/work/*`" is one rule on the laptop, and those tickets wait in Queued while it is offline.

In the same transaction, before `session.assigned`, the claim writes the matched `machine_repo` (by `path`) as `{repo_path, mode}` into `session.context.__working_copy` (none, and any old one removed, for a non-canonical repo), so every `start_session` carries `working_copy`.

The board's Queued card gets `routing` when no **online** machine of the account passes the repo, capability and repo-rule filters (`gateway/routing.ts`, the same rules in TypeScript): `missing_repo` when none has the repo, and the capabilities the closest machine (fewest missing, among those with the repo when any has it) lacks, both among the machines the repo rules allow; `exclusive_to` / `excluded_by_rule` when a rule is why. The machine drawer's "Can't take" list (`MachineDetail.cannot_take`) uses the same rules per machine. TD: routing is recomputed on the card's own events and on board load, not when a machine or inventory changes.

## 3 · Short-hold rule (softening greedy pull)

> **Not built, and not needed for now (M2-T16a).** Routing is a hard repo filter, so a machine without the repo never takes the ticket. The rule below stays as the design if a soft score (clone penalty) ever replaces the hard filter.

A pull scheduler is greedy. A machine without the repo might grab a ticket a second before a machine that has it. The fix:

- If the best score for this daemon is **< 100** (no repo locality), and some *other* machine with a fresh heartbeat, free slots **and** that repo exists, reply `retry_after 3s` instead of claiming.
- A ticket may be held this way at most **3 times / 30 s**. After that, any eligible machine may claim it. A `ticket.hold_count` / `hold_until` pair or an in-memory map tracks this. In-memory is fine for one orchestrator, so record it as TD if chosen.
- Move to a central scorer only when placement quality visibly hurts ([ADR-0001](../adr/0001-pull-scheduler.md), revisit trigger).

## 4 · Leases and fencing

> Superseded for lost machines by [10-contracts §Machines protocol v2](10-contracts.md#machines-protocol-v2) (no automatic requeue; M2-T20 rewrites this section).

- Each heartbeat renews `lease_expires_at` for every session it lists, provided its token matches.
- A **reaper** (periodic query, safe to run on any replica) finds sessions with `lease_expires_at < now() - grace` (grace **2 min**, which covers network blips). It marks them `lost`, writes an event, then **requeues**: a new assignment gets a higher `fencing_token`. It prefers resuming from `claude_session_id` when the branch was pushed. See [08](08-failure-modes.md#laptop-sleep).
- Any event or ack carrying an older token is rejected, and the orchestrator sends `kill`.
- **Heartbeat backstop**: a heartbeat that lists a session under a token lower than `session.fencing_token` gets the same direct `kill {target_command_id: null, reason: stale_fencing_token}` with the listed token in the envelope. It kills an orphan that sends no further events ([10](10-contracts.md#orphaned-processes)).
- Fencing protects **our DB only**, not the git remote. That's why each session pushes to its **own branch name**.

## The Queued column
On the board ([ADR-0010](../adr/0010-one-workflow-columns-are-states.md)) a ticket is in **Queued** until a machine's claim has entered the workflow's start state: no session yet, or a session `queued` / `assigned` with no `workflow_state`. A session that goes back to the queue mid-flight (a refused `start_session`) keeps its state's column; its status shows as a badge.

## Parked sessions

States with `release_machine: true` (e.g. `await_approval`) set `machine_id = NULL` and free the reservation. When the event arrives, the session goes back to `queued` with affinity to its old machine. The next state can run on any machine, by resuming from the pushed branch plus `claude_session_id`.
