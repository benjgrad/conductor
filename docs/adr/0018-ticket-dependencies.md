# ADR-0018 · Ticket dependencies, and cycles the agents resolve together

- **Status**: accepted (Ben, 2026-10-27), with two amendments made before acceptance: a cancelled or failed dependency first gets an orchestrator **unblock assessment** (§2a), and concurrency limits are **hardware-based** (§6), with no cycle-size cap
- **Date**: 2026-10-27
- **Deciders**: Ben (+ Claude planner session https://claude.ai/code/session_01NhmNbZ2iRArH99MxNSABmj)
- **Resolves**: none yet. Raises U-077 (message budget numbers), U-078 (does "finished" need a merged PR), U-081 (the assessment's model and cost) and U-082 (admission thresholds).
- **Builds on**: [ADR-0001](0001-pull-scheduler.md) (the claim is the only scheduler), [ADR-0007](0007-live-messages-to-agents.md) (`send_message` to a running agent), [ADR-0005](0005-claude-code-driver.md) (the daemon's outcome MCP server), [ADR-0011](0011-transition-rules.md) (transitions only on outcomes), [ADR-0012](0012-hosted-multi-user-github-sign-in.md) §Tenancy, [ADR-0013](0013-machine-enrollment-inventory-routing.md) §Routing, [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md) (M3 tools).

## Context
Ben, 2026-10-27: *"add ticket dependencies to our feature roadmap (including orchestrator reasoning that doesn't pick up tickets that have other tickets that they are dependent on, unfinished. The exception if there's a circular dependency, which the orchestrator must facilitate the resolution between the implementing agents)"*.

Today every `ready` ticket is claimable as soon as a machine asks. M2 itself shows the problem: its 26 tasks run as conductor tickets, and the lead has to hold back group C's tickets by hand until group B merges. With dependencies, Ben can queue a whole milestone (M3 → M5) at once, and the claim starts each ticket only when what it needs is finished.

Real work also has mutual dependencies: two tickets that must agree on a shared interface (a contract and its consumer, a client and a server change). A plain "wait until finished" rule deadlocks on them. Ben's rule: a cycle doesn't deadlock; the orchestrator gets the agents working on the cycle to talk to each other.

Engine invariants that bind every choice here: transitions only on outcomes; every loop bounded; every failure path ends at a human; state and commands in one transaction; idempotency keys on external side effects.

## Decision
A ticket may depend on other tickets of the same account. **The claim never starts a ticket that has an unfinished dependency**, except on dependencies inside a **cycle**: the tickets in one cycle are claimable together, and the orchestrator relays bounded messages between their agents until they agree on what they share. When a message budget runs out, a human gets the thread. A cancelled or failed dependency gets an orchestrator **unblock assessment** first (§2a), then a human. How many sessions run at once, cycle members included, is decided by each machine's measured headroom (§6).

### 1 · Data
- **`ticket_dependency`** `(id uuid pk, account_id, ticket_id, depends_on_ticket_id, created_at, created_by, cleared_at null, cleared_by null)`. A live edge has `cleared_at IS NULL`, with a partial unique index on `(ticket_id, depends_on_ticket_id) WHERE cleared_at IS NULL`. Rows are never deleted: dropping a dependency sets `cleared_at` / `cleared_by`, so the board can show who removed it and when.
  - Both tickets are in the row's account: composite foreign keys `(account_id, ticket_id)` and `(account_id, depends_on_ticket_id)` → `ticket (account_id, id)` (a unique index on `ticket (account_id, id)` is added). A cross-account edge can't exist, even in a bug.
  - A self-edge is refused (`CHECK (ticket_id <> depends_on_ticket_id)`).
- **`dependency_cycle`** `(id, account_id, members uuid[], message_budget int, messages_used int, agreement jsonb null, created_at, dissolved_at null)`, plus **`ticket.cycle_id uuid null`**. This is the cached result of the cycle computation in §3. It is rewritten in the same transaction as every edge change.
- **`cycle_message`** `(id, account_id, cycle_id, from_ticket_id, from_session_id, to_ticket_id null (= all partners), kind: 'message' | 'proposal' | 'agree' | 'human', text, proposal_version null, relayed_at null, created_at)`. This is the cycle's thread: what the human sees, and what goes into a partner's prompt. Each message also writes an `event` row on the sender's and receiver's sessions, so both timelines show it.
- `input_request_kind` gains **`cycle_coordination`** and **`dependency_blocked`** (§2a).
- **`unblock_assessment`** `(id, account_id, edge_id, dependent_ticket_id, dependency_ticket_id, trigger_event_id, status: 'pending' | 'running' | 'done' | 'failed', outcome null, reason text null, replacement jsonb null, machine_id null, created_at, finished_at null)`, unique on `(edge_id, trigger_event_id)` (§2a). `ticket.unblock_retry_used bool NOT NULL DEFAULT false` on the dependency's ticket.
- `event` gains a nullable **`ticket_id`**, so a ticket with no session (a queued dependent) has a timeline for dependency and assessment events.
- All tables carry `account_id` (ADR-0012), so the M2 schema-isolation test covers them.
- **Short id**: tickets have no human number today. "#…" in this ADR is the ticket's **short id**: the first 8 hex digits of its uuid, as `sessionBranch` already uses for sessions. Within a cycle, where agents use it, a collision between members is checked when the cycle is computed; colliding members get 12 hex digits instead. Anywhere else it could be ambiguous (the API, the picker), the full uuid is used.

**Ways to set a dependency:**
- the REST API: `POST /api/tickets` takes `depends_on: uuid[]`, `POST /api/tickets/:id/dependencies {depends_on_ticket_id}` adds one, and `DELETE /api/tickets/:id/dependencies/:dep_id` drops one;
- the board: "Blocked by…" on the create form and the detail panel (a ticket picker), with a "drop" control on each dependency;
- **M3**: a `set_dependencies` tool (and `depends_on` on `create_ticket`) in the ADR-0014 tool layer, calling the same service;
- **M4**: triage may propose dependencies, but a human confirms them.

Edges can be added at any time. Adding one to a ticket that has already been claimed changes nothing for the running session; the gate is checked only at claim time. The card shows the edge.

### 2 · What "finished" means, and the claim
- A dependency is **finished** when its ticket's `status = 'done'`.
- **`cancelled` and `failed` are not finished.** Ben's word is "unfinished": a cancelled ticket's work didn't happen, so starting its dependents on the assumption that it did would build on missing foundations. The dependent never unblocks silently.
- **Instead the orchestrator tries to unblock it first, then escalates to a human** (Ben, 2026-10-27: "Try and unblock using the orchestrator, otherwise escalate to human"). That is the unblock assessment, §2a. Until it finishes, the dependent's card shows `blocked by #1234 (cancelled) · assessing…`.
  - Alternatives: treating `cancelled` as finished (silently wrong when the work was really needed); failing the dependents (a cascade nobody asked for); or always waiting for a human (Ben's first-draft default, which he amended: many cancelled dependencies are obviously irrelevant or obviously worth one retry, and a model can tell).
- **The claim** (`gateway/claim.ts`, [04](../design/04-scheduler.md) §2) adds one hard filter:
  ```sql
  AND NOT EXISTS (
    SELECT 1 FROM ticket_dependency d
      JOIN ticket u ON u.id = d.depends_on_ticket_id AND u.account_id = d.account_id
     WHERE d.ticket_id = t.id AND d.account_id = t.account_id AND d.cleared_at IS NULL
       AND u.status <> 'done'
       AND (t.cycle_id IS NULL OR u.cycle_id IS DISTINCT FROM t.cycle_id))  -- edges inside the ticket's own cycle never block
  ```
  It runs at every claim, so a ticket becomes claimable the moment its last dependency reaches `done`. There is no polling, timer or event hook. An index on `ticket_dependency (ticket_id) WHERE cleared_at IS NULL` keeps it cheap.
- **Board**: a Queued card with an unmet dependency carries `blocked_by: [{ticket_id, short_id, title, status, assessment?: {status, outcome?, reason?}}]` and shows "blocked by #… ". The card stays in Queued (not Needs input): nothing is wrong, it is waiting. A dependency that is `cancelled` or `failed` is shown in red with the assessment's state. "Drop this dependency" is always available to a human.
- **Routing** (ADR-0013) is unchanged and applies on top. A ticket is claimed only by a machine that has its repo and capabilities, **and** only when its dependencies are finished.

### 2a · The unblock assessment (a cancelled or failed dependency)
**Trigger.** In the transaction that moves a ticket to `cancelled` or `failed`, the orchestrator inserts one `unblock_assessment` (status `pending`) per live edge that points at it. The key is `(edge_id, trigger_event_id)`, so the same close event never assesses an edge twice. A dependent that is already running (a claimed cycle member) is assessed too: its agent gets the outcome as a system message.

**Where it runs.** On an online machine of the account that has the `claude` capability, as a one-shot `claude -p --output-format json` on the user's subscription (ADR-0006, like M4 triage, ADR-0015). It has no tools and no repo access; everything it needs is in the prompt. It is sent as a machine-level outbox command `run_assessment {assessment_id, prompt, schema, timeout_ms}` (new outbox kind; the idempotency key is the assessment id). The daemon runs it under the same resource admission as sessions (§6), with a 5-minute timeout, and answers `assessment_result {assessment_id, result | error}`. U-081 covers the model and cost; the default is the account's default model (Sonnet class), max 1 turn.

**Inputs** (rendered by a pure `renderUnblockAssessment` in shared):
- the dependency's title, body (≤ 4 000 chars), final status, and the reason for its cancel or failure (the cancel note, the last `input_request` question, the failure detail);
- its partial work, as metadata only: its branch, `context.__pr.pr_url` and PR state if any, and whether its last check run passed. No diff, no output (ADR-0003);
- the dependent's title, its Goal and its FR / NFR lines (ADR-0019 sections, if present, else the body ≤ 4 000 chars);
- whether `unblock_retry_used` is already set (then `retry_dependency` is not offered).

**Outcome** (strict JSON schema, one of):
- **`proceed {reason}`**: the dependent doesn't need it. The edge is cleared (`cleared_by = 'system:assessment'`, the reason stored), and the dependent becomes claimable if nothing else blocks it.
- **`retry_dependency {reason}`**: the dependency failed for a reason a second attempt can fix. If `unblock_retry_used` is false, it is set, and the dependency is **reopened once** (ADR-0008 reopen, or re-queued if it had no session), with the reason as a note on its timeline. The edge stays, so the dependent keeps waiting for it. If the retried dependency is cancelled or fails again, the next assessment can't choose retry. A retry answer at that point is treated as `escalate`.
- **`replace {reason, title, body}`**: a replacement ticket should do the work. Creating it is outward-facing, so it is **never automatic**. It escalates (below) with the draft prefilled, and "Create replacement" makes the ticket and moves the edge onto it in one transaction.
- **`escalate {reason}`**: a human decides.

**Escalation (a human).** The dependent gets a decision request with the assessment's reason and the options: drop the dependency, reopen the dependency, create the replacement (when proposed), or cancel the dependent.
- If the dependent has a live session (a running cycle member), it goes to `needs_input` with kind `dependency_blocked`.
- Otherwise (the usual case: an unclaimed Queued ticket) it is a **ticket-level** `input_request` (`session_id` null, `ticket_id` set, kind `dependency_blocked`). The card shows "needs your decision" in Queued and appears in the needs-attention list. This is the same ticket-level request shape that M4 triage needs (U-064); M2b builds it first, and M4 reuses it.

**Bounds and failure paths** (every one ends at a human):
- One assessment per (edge, close event). One `retry_dependency` per dependency ticket, ever.
- No eligible machine for 30 minutes (`ASSESSMENT_MACHINE_WAIT`) → escalate, with "no machine could assess this".
- A daemon error, a timeout, invalid JSON, or a schema mismatch → escalate with the error. There is no automatic re-run.
- A human acting on the edge first (drop, reopen) → the pending assessment is cancelled (`failed`, reason `superseded`) and its late result is ignored.

**Recorded on both timelines**: `event` rows (by `ticket_id`) on the dependency and the dependent for `assessment.requested`, `assessment.finished {outcome, reason}` and the action taken. Each relays to the board as `card.upserted`.

**Invariants.** An assessment changes no workflow state. Its outcomes act on edges and tickets through the same services a human uses (clear edge, reopen, create ticket), in the transaction that records the result, with the assessment id as the idempotency key.

### 3 · Cycles
**Detection.** On every edge change, the service takes a per-account `pg_advisory_xact_lock`, loads the account's live edges between tickets that are not `done`, and computes the strongly connected components (Tarjan; a pure function `dependencyCycles(edges)` in `packages/shared`, property-tested). It then rewrites `dependency_cycle` / `ticket.cycle_id` in the same transaction. A **cycle** is an SCC with two or more tickets.
- **No size cap** (Ben, 2026-10-27: "I don't care about max tickets per cycle"). How many members run at once is decided by hardware (§6), like every other session.
- The response to an edge change reports the cycle (`cycle: {id, members}`), and the UI says: "These tickets depend on each other. They will start together and agree on what they share."

**Claim.** Edges inside a cycle don't block (the SQL above). Edges from a cycle member to tickets outside the cycle still do. So a cycle starts once every dependency it has on the outside world is finished.

**Co-scheduling without deadlock** (§6 decides capacity):
- Members are claimed independently, on any machine of the account with headroom, at different times if need be. "Together" means they become *claimable* together.
- The claim **prefers** an unclaimed member whose partner is already running: a soft score, not a filter. That way capacity flows to an open cycle first.
- Nothing holds a slot while waiting for a partner to start:
  - messages to a partner that isn't running are **queued** in its inbox, and the tool says so;
  - a `wait_seconds` wait is ≤ 600 s and counts toward the state's timeout.
- A running member can therefore always make progress or finish its state, and capacity frees up for the rest.
- If a partner stays unclaimed for `CYCLE_PARTNER_START_TIMEOUT` (default 60 min) while another member runs, the running members' cards and the cycle badge show "#… waiting for capacity". The cycle's normal bounds then apply:
  - a member whose state times out goes to a human as usual;
  - a member that asks gets `queued` answers it can act on (proceed against the proposal, or `ask_user`).
- There is no lockstep start that could wait forever for a whole cycle to fit.

**Facilitation: the agents talk through the orchestrator.**
1. **Prompt.** Every agent state of a cycle member renders a `## Cycle partners` section: each partner's short id, title, the first 1 000 characters of its body, its repo, its current column, and, once agreed, the `## Agreed interface`. It ends with how to use `message_peer`, and the instruction to agree on anything shared **before** depending on it.
2. **Tool: `message_peer {to: <short id> | 'all', kind: 'message' | 'proposal' | 'agree', text, proposal_version?, wait_seconds?: 0..600}`**, on the daemon's outcome MCP server (ADR-0005, next to `complete_state` / `ask_user`). The daemon forwards it as a durable `session_event peer_message` (seq-deduped like every session event).
   - The gateway calls the EngineService wrapper, which in **one transaction** applies `agent.peer_message` to the sender's session and, if the budget allows, `peer.message_received` to each recipient's session. It also writes the `cycle_message` row and the `event` rows.
   - For a recipient whose agent process is live and not parked, apply emits ADR-0007's `send_message` with an additive `from_peer {ticket_id, short_id, kind}` field: the same outbox kind, retries, `command_id` dedupe and fencing. `command_id` = a hash of `(sender session, daemon seq, recipient)`, so a redelivered event never relays twice.
   - For a recipient that isn't running yet, is parked, or is between processes, the message stays in its **inbox** (`cycle_message.relayed_at IS NULL`). It is rendered into the next `start_session` prompt for that session ("Messages from your cycle partners") and marked relayed in the same transaction as that start.
   - The tool returns at once with `relayed` / `queued (partner not running)` / `partner finished` / `budget exhausted`. With `wait_seconds > 0` it returns when a reply from that partner arrives or the wait ends. The daemon resolves the waiting tool call with an incoming `send_message` whose `from_peer` names that partner, instead of writing it as a user message. This lets an agent wait for an answer inside its turn, without parking (the ADR-0007 nudge rules are unchanged).
3. **Agreement artifact.** A `proposal` carries the shared interface as text (types, an API shape, a file list) and gets `proposal_version` n+1 on the cycle. Partners answer `agree {proposal_version}` or a counter-`proposal`. When every member has agreed to the latest version, `dependency_cycle.agreement = {version, text, proposer, agreed_at}`. It goes into every member's later prompts as `## Agreed interface`, appears on all their timelines, and a badge on their cards says "interface agreed (v3)". A new proposal after agreement reopens it (the badge goes back to "negotiating"). The agreement is **advisory**: the engine never blocks a transition on it. Each ticket still finishes through its own workflow and its own review. Making agreement a hard requirement would need the ADR-0011 `requires` machinery to read cross-ticket state, which is more than this first version needs.
4. **Bounds** (every loop bounded):
   - `message_budget` per cycle: **20** relayed messages, `agree` included (`CONDUCTOR_CYCLE_MESSAGE_BUDGET`). At most **5** proposal versions. `wait_seconds` ≤ 600, and the wait counts toward the state's own timeout and budget, as always.
   - **Why the message budget stays while the size cap went** (for Ben): the budget is **not a concurrency limit**. It doesn't decide how many agents run; hardware does (§6). It bounds the **conversation**. Agent-to-agent chatter is a loop with no outcome at each step: two agents can trade proposals forever. The engine invariant "every loop bounded" needs a counter that ends that loop at a human. The size of a cycle doesn't create a loop, so the size cap could go; the chatter does, so the budget stays. Its numbers are tunable (U-077); its existence isn't.
   - **Budget exhausted** (a message that would be the 21st, or a 6th proposal): it is not relayed. The wrapper applies `cycle.budget_exhausted` to the **sender's** session, which goes to `needs_input` with kind `cycle_coordination`. The question holds the thread (the last 10 messages, the latest proposal, and who agreed to which version). The human can:
     - answer (`$return_to`): the answer goes to the sender as usual, **and** is relayed to every partner as `kind: 'human'` guidance (not counted). The budget gets a fresh **10** messages, granted only by this human act;
     - **"Agree on v<n> for everyone"**: writes the agreement;
     - **drop a dependency** in the cycle, which may dissolve it;
     - or Cancel.
   - Only the sender parks. The partners keep working and get a system message: "Coordination is waiting on a human (#1234's card)."
5. **Members finishing at different times.** A member that reaches `done` leaves the cycle's live edges (the computation only counts not-`done` tickets). The others get a system message: "#1234 finished; its last summary: …". A `message_peer` to it returns `partner finished` with that summary, uncounted. If the remaining members still form a cycle, it carries on; if not, it dissolves (`dissolved_at`), and their prompts stop rendering the section. A member that is **cancelled or failed** also leaves the cycle. Its partners' edges to it now **block** (§2) if they haven't been claimed yet; running partners carry on, and their cards show "partner #1234 was cancelled".
6. **Breaking a cycle by hand.** Any member's card has "drop this dependency" on each edge. Dropping an edge recomputes the cycles. Running sessions are untouched (they get a system message). A queued member that is no longer in a cycle waits for its remaining dependencies as usual.

### 4 · Engine invariants
- **Transitions only on outcomes.** `message_peer` is not an outcome: `agent.peer_message` and `peer.message_received` change no state and no status. They only emit `send_message` or nothing. The one route they can trigger is `cycle.budget_exhausted` → `needs_input`, a system route to a human, like `budget.exceeded`.
- **Every loop bounded**: the per-cycle message budget, the proposal-version cap, `wait_seconds` ≤ 600, human-only budget grants, one unblock assessment per close event, and one dependency retry ever.
- **Failure paths end at a human**: budget exhausted → `needs_input`; a cancelled or failed dependency → an assessment, whose `escalate` / `replace` outcomes, errors, timeouts and missing machine all end in a `dependency_blocked` request; a partner that never starts (no machine can run it) → its own routing badge, and the waiting agent's messages are `queued` (the tool says so, so the agent can `ask_user`). A relay that the daemon refuses (ADR-0007 `message_refused`) keeps the message in the inbox for the next start, instead of losing it.
- **One transaction**: an edge change, the cycle recompute and the board events; a relay, i.e. the sender's event, every recipient's event, the `cycle_message` row and the outbox rows.
- **Idempotency**: an edge add is idempotent on the live-edge unique index. An assessment is unique on `(edge_id, trigger_event_id)`, and its result is applied once (a `status` guard). Relayed `send_message` `command_id`s are derived from `(sender session, seq, recipient)`. The daemon dedupes on `command_id` (ADR-0007).

### 5 · Interaction with M2 and M3
- **M2 (accounts)**: every table is account-scoped, and the composite foreign keys forbid cross-account edges. The REST routes join the M2-T21 route matrix, and the relay runs inside the account-scoped EngineService (M2-T19), so a message can't cross accounts. Partners may be on different machines of the same account. The relay goes through the orchestrator, so nothing about machines changes.
- **M2 (routing)**: dependencies filter on top of the ADR-0013 routing filters in the same claim query (a `NOT EXISTS`, cheap).
- **M3**: `set_dependencies {ticket, depends_on[]}` and `create_ticket.depends_on` in the tool layer, using the same service and the same 409s. `get_ticket` shows the dependencies and the cycle. With these, an MCP client (or Ben in Claude Code) can queue a milestone's tickets with their dependencies in one go.
- **M4**: triage may *suggest* dependencies ("this looks like it needs #12"); a human confirms them.

### 6 · Hardware-based admission (all sessions, cycles included)
Ben, 2026-10-27: *"The limits should be hardware-based — our daemon should monitor ram, CPU usage, etc."*

**Today:**
- The daemon has a static `max_sessions`.
- It reports `cpu_free` (idle cores from the 1-minute load average) and `mem_free_mb` (available memory, from `vm_stat` on macOS) in `heartbeat` and `request_work` (`packages/daemon/src/sysinfo.ts`).
- It refuses a `start_session` below `CONDUCTOR_MIN_FREE_MEM_MB`. TD-027: it still asks for work under pressure, then refuses it.

**Decision: the daemon admits work by measured headroom.**
- **Asking for work.** The daemon asks for work (`request_work` with `free_slots = 1`) only while **both** hold:
  - `mem_free_mb ≥ ADMIT_MEM_MB`, default `max(3072, 15 % of RAM)`;
  - `cpu_free ≥ ADMIT_CPU`, default `1.0` core.
- **Hysteresis.** Once below a threshold, it doesn't ask again until both are above the threshold plus a margin (`+1024 MB`, `+0.5` core) for two consecutive samples, 10 s apart. Admission can't flap.
- **Reservation while a session starts.** A just-started session takes a while to load (Claude, a build). For `ADMIT_SETTLE_MS` (90 s) after each start, the daemon subtracts a reservation from the measured numbers (`RESERVE_MEM_MB` 2048, `RESERVE_CPU` 1.0). Several claims can't all fit into the same momentary headroom.
- **`max_sessions`** becomes an **optional hard ceiling** (`CONDUCTOR_MAX_SESSIONS`, unset = no ceiling). The register field stays (nullable, or a large sentinel; M2b-T13 decides with the contract).
- **The start-time veto stays** as a safety net (a session whose start finds memory below `CONDUCTOR_MIN_FREE_MEM_MB` is refused and requeued). With admission in front of it, it should almost never fire. TD-027 is paid.
- All thresholds are daemon config (`conductor-daemon config admit --mem … --cpu …`, env overrides) and are reported in the inventory, so the Machines page shows "admitting: yes / no (memory)". U-082 covers the defaults.
- **The orchestrator stays a pull scheduler** (ADR-0001). It doesn't model machine capacity: the daemon only asks when it has room, and the claim's `max_sessions` filter applies only when a ceiling is set. The soft cycle-partner preference (§3) is the only claim change.
- **Cycles** get nothing special: each member is one session admitted like any other, on whichever machine has room. Co-scheduling is the "claim as headroom allows, relay queues the rest" rule in §3.

## Alternatives considered
| Option | Why not |
|---|---|
| Refuse cycles at add time | Ben's rule: cycles happen in real work (contract + consumer) and must not deadlock |
| Break a cycle automatically (start one member, make the others wait) | It guesses which side defines the interface; the agents on both sides are better placed to agree, and a human gets the thread when they can't |
| Cancelled counts as finished | Silently starts work on missing foundations; Ben's word is "unfinished" |
| A cancelled dependency always waits for a human | Ben amended it: try an orchestrator assessment first; many cases are obvious |
| Auto-create replacement tickets | Outward-facing (it starts new agent work); the assessment proposes, a human creates |
| A cap on cycle size, or a static `max_sessions` as the main limit | Ben: limits are hardware-based; a cycle of any size runs as headroom allows |
| Start a cycle only when all its members fit at once | Can wait forever on a big cycle or a busy machine; claiming as headroom allows plus queued messages never deadlocks |
| A new outbox kind for peer messages | ADR-0007's `send_message` already has delivery, fencing, dedupe and scrubbing; an additive `from_peer` field is enough |
| Agents share one branch or worktree | Crosses repos and machines; breaks ADR-0010's one-session, one-branch rule |
| Make the agreement a hard gate on finishing | Needs cross-ticket `requires`; the advisory agreement plus each ticket's own review is enough to start with (revisit below) |
| Poll for unblocked tickets and flip them to `ready` | The claim query already sees every change at the moment it matters; an extra status would be a second source of truth |

## Consequences
- Good: a whole milestone can be queued at once, and the claim starts each ticket when it can run. Mutual dependencies become a supervised conversation instead of a deadlock or a lead juggling tickets.
- Good: no new scheduler, no new outbox kind, no change to how transitions work.
- Bad / accepted cost: a migration (three tables, a column, an index, an enum value); a new agent tool and engine events; the `send_message` payload gains a field.
- Bad / accepted cost: agreement is advisory; agents can still diverge after agreeing, and the review at each ticket's PR has to catch that.
- Bad / accepted cost: an unblock assessment spends a little of the user's subscription on each cancelled or failed dependency (U-081). A wrong `proceed` starts a dependent too early; the reason is on both timelines, and the dependent's own review catches missing foundations.
- Bad / accepted cost: hardware admission depends on the quality of the daemon's measurements (load average lags; macOS memory accounting). The hysteresis, the start reservation and the start-time veto absorb it.
- Follow-ups: [M2b](../plan/milestones/M2b-ticket-dependencies.md) implements this. U-077 (the budget numbers), U-078 (should "finished" require the PR merged), U-081 (the assessment's model and cost), U-082 (admission thresholds). TD-027 is paid by M2b-T13.

## Revisit when
- Real cycles exhaust the budget often (raise it, or change the protocol), or never use more than a few messages (lower it).
- Agents diverge after agreeing often enough that a hard agreement gate is worth the cross-ticket `requires`.
- A dependent starts before its dependency's PR is merged and fails because the code isn't on the default branch (U-078: "finished" becomes "done and merged", using M5's `pr_merged`).
- Teams (U-051): dependencies across accounts.
- Assessments are often overridden by humans (tighten the prompt, or drop `proceed` and keep only retry / escalate).
- Admission leaves a machine idle while it has room (thresholds too high), or swaps (too low).
