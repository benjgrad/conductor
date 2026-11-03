# ADR-0032 · Recurring tickets (schedules)

- **Status**: accepted (Ben approved the plan, 2026-11-03, on ticket "Recurring Tasks")
- **Date**: 2026-11-03
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Amends**: [ADR-0028](0028-simple-oauth-for-mcp.md) / [ADR-0031](0031-mcp-for-conversational-clients.md) §Tools (four more tools, 23 in all)

## Context
Ben wants conductor to run jobs on a schedule. The first one runs every weekday morning on his **work laptop**: bring all his PRs and Jira tickets up to date using the laptop's `mtd` plugins and skills. When the job needs his judgement, it must escalate to him instead of guessing. He also asked that schedules be managed over conductor's MCP, like the rest of conductor (ADR-0030: MCP-first).

Conductor already has the pieces a run needs:
- tickets, the claim and routing, with `ticket.repo_allow_machines` as a hard machine allow-list;
- Needs input with push notifications (UX-15) and permission prompts (ADR-0023);
- agents that inherit the user's Claude Code settings, skills, plugins (ADR-0006) and MCP servers (ADR-0029).

The missing piece was *when* to start a ticket.

## Decision
1. **A schedule makes ordinary tickets.** The new table `ticket_schedule` (account-scoped) holds a ticket template (title, body as the job's instructions, repo, kind, workflow, priority, tags, machines) and a rule. When a run is due, the orchestrator inserts one ticket from the template. Everything after that is the ticket machinery that already exists. `ticket.schedule_id` / `scheduled_for` link each ticket to its run.
2. **Rule format.** A 5-field cron expression read in an IANA timezone (default `UTC`), computed with [`croner`](https://github.com/Hexagon/croner) in `packages/shared`. It has no dependencies, handles DST, and runs in the browser too, so previews ("next 3 runs") and the sweep agree.
3. **At most every 15 minutes.** On write, two of the next 6 runs must not be under 15 minutes apart (`schedule_too_frequent`). This bounds spend and loops.
4. **Overlap policy: skip.** A due run is skipped while the previous run's ticket is still open (`ready` / `claimed` / `in_progress`, which includes waiting on the user). The skip is recorded as `last_skipped_at` with `last_skip_reason = 'previous_run_open'`. An unanswered escalation never piles up duplicate tickets. A manual "run now" is refused in that case unless `force`.
5. **No catch-up.** After a run (or a skip) `next_run_at` becomes the first run after *now*. An orchestrator that was down across several due times fires once.
6. **Exactly once per run.** The sweep locks each due schedule with `FOR UPDATE SKIP LOCKED` in its own transaction. The ticket insert is `ON CONFLICT DO NOTHING` on the partial unique index `(schedule_id, scheduled_for)`, which is the run's idempotency key. The board event is the transaction's last write, as for every ticket. A schedule whose rule stops parsing is disabled (`invalid_schedule`) instead of failing on every tick.
7. **A shipped `routine` workflow.** One agent step (`running`) does the body's instructions with the machine's tools and finishes with `done` and a `report`, or escalates with `needs_decision` (a question) or `ask_user` to Needs input. The human state there can send it back with an answer or mark it done. It has no PR and no checks: the repo checkout is only a working directory. It is seeded like `conductor` (`seedShippedWorkflow`), and schedules default to it.
8. **Runs go to the machine with the tools.** A schedule's `machines` are ids or names, stored as ids and copied to each ticket's `repo_allow_machines`. The session then runs where the `mtd` skills and plugins are installed. The repo must be checked out on that machine.
9. **Managed over MCP and REST.** `list_schedules` (read-only), `save_schedule` (create, or edit including pause/resume), `delete_schedule` (destructive) and `run_schedule_now`, plus `/api/schedules`. Both are thin over one store (`orchestrator/src/schedules/store.ts`). The tool list grows to 23 tools, under 18 KB (the test cap goes from 15 to 18 KB).
10. **Web, minimal.** A card made by a schedule shows "↻ <schedule name>". A Schedules page is a follow-up.

## Alternatives considered
| Option | Why not |
|---|---|
| A cron on the daemon (the work laptop) | The orchestrator is the single decider (ADR-0002). A sleeping laptop would miss runs silently, and two machines could both fire. The orchestrator can still queue a run for when the laptop wakes |
| One long-lived ticket that loops back to its start | It breaks Done's meaning and the board's history, a bounded loop would need a new engine construct, and a run would have no idempotency key |
| A schedule inside the workflow definition | Workflows are instance-wide and editing one stops the shipped-default seed (ADR-0030). A schedule is per account and per job |
| Catching up every missed run | A week offline would queue five identical PR sweeps; the job is "bring things up to date", so one is right |
| Queueing a run behind the open one | Grows without bound while an escalation waits on the user |
| Our own cron parser | More code and DST bugs for no gain over a zero-dependency library |

## Consequences
- **Good**: a recurring job is just a ticket: needs-input, push, MCP `get_ticket` / `answer_input`, routing and permission prompts all work unchanged. Runs are exactly-once and bounded.
- **Bad / accepted cost**: a run still needs a repo (`ticket.repo` is required, and the claim and worktree need it). A pin by machine id breaks when the machine re-enrolls (`pinned_machine_revoked` warns). Every run leaves a Done card. Tools the machine's settings don't pre-allow raise permission prompts on every run. Editing `routine` is an admin `save_workflow`, like `conductor`.
- **Follow-ups**: a Schedules page in the web app; ticket-level required capabilities (e.g. `skill:mtd…`) so routing can pick the machine by tool instead of by pin; repo-less routines; a "supersede the open run" overlap policy; collapsing old routine cards.

## Revisit when
- a second orchestrator replica runs (the sweep is already safe: row locks plus the unique key);
- users need sub-15-minute schedules or event triggers (webhooks) instead of time.
