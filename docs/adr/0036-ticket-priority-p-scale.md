# ADR-0036 · Ticket priority is a P0–P4 scale, lower is more urgent

- **Status**: accepted (ticket "The default ticket priority should not be a P0", Ben approved the data rewrite, 2026-11-05)
- **Date**: 2026-11-05
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)

## Context
Ben: *"P0 should be reserved for when the orchestrator interrupts other running work to get something done. The default should be P3."*

`ticket.priority` was an int where the **higher** number was the more urgent: the claim ordered `priority DESC`, the board sorted the same way, and the default was 0. The board labels it `P<n>`, which readers take as the usual P-scale, where P0 is the most urgent. So every default ticket read as "P0" while it was in fact the least urgent. Changing only the default to 3 would have queued every new ticket ahead of every existing one.

## Decision
1. **Scale.** `priority` is an int in **0–4**. The **lower number is the more urgent** and is claimed first: the claim and the `cannot_take` scan order `priority ASC, created_at, id`, and Queued sorts the same way.
2. **Default P3**, everywhere a ticket is made without one: `POST /api/tickets`, MCP `create_ticket`, schedules (`ticket_schedule.priority`, so each run), and approved proposals.
3. **P0 is reserved** for work the orchestrator runs by interrupting other running work. That pre-emption isn't built: today P0 only sorts first. The web forms offer P1–P4 (and P0 only when the ticket already has it); the API and MCP accept 0, so a person can still set it on purpose.
4. **Validation.** `TicketPrioritySchema` (`shared/src/domain.ts`) on create, PATCH and the schedule requests (400 outside 0–4), and a `CHECK (priority BETWEEN 0 AND 4)` on `ticket` and `ticket_schedule`.
5. **Existing rows are rewritten** by migration `1763200000000_priority-p-scale`: old 0 → 3, 1 → 2, 2 or more → 1, negative → 4. Nothing is mapped to P0. The down migration maps back, which is lossy for old values above 2 or below 0.

## Consequences
- The design target in [04 §2](../design/04-scheduler.md) adds `(4 - t.priority) * 5` to the score instead of `t.priority * 5`.
- A caller that still sends the old "bigger is more urgent" values gets a 400 for 5 or more, rather than its ticket being silently misordered.
- The board shows a `P<n>` badge only when a card isn't at the default P3.

## Revisit
When pre-emption is built, P0 is what triggers it.
