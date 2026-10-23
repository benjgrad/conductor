# Status

> Living dashboard. Rewritten (not appended) by the lead session at the end of every session. Keep it under one screen.

**Updated**: 2026-10-23 · session [2026-10-23-agent-inherit-settings](sessions/2026-10-23-agent-inherit-settings.md) (continued)

## Now
- **Milestone**: [M1 · Single machine](../plan/milestones/M1-single-machine.md) **complete, pending Ben's sign-off**. Since then:
  - real-run fixes;
  - [ADR-0006](../adr/0006-agents-inherit-claude-code-settings.md): Ben's own Claude Code settings plus hard guards;
  - the env allowlist;
  - the Claude-Code-style live output;
  - [ADR-0007](../adr/0007-live-messages-to-agents.md): live messages to running agents, with slash commands;
  - a session panel with Messages and Details tabs, plus agent names and avatars.
- **Phase**: M1 sign-off, then M2 planning
- **Next action**:
  - Ben tries a ticket on the board: chat with the running agent, try `/context`, check Details.
  - Ben signs off M1.
  - Ben rules on U-045 and U-048.
  - Lead:
    - fixes U-046 and U-049 (property-test counterexample);
    - pays TD-068 and TD-082 before M3;
    - decides U-047 and U-043.
  - Then plan M2.
  - Main is ahead of origin; Ben pushes.

## In flight
| Task | Branch | Agent | State |
|---|---|---|---|
| — | — | — | nothing in flight |

## Health
| Open unknowns | Open blockers | Tech debt items | Unfinished handoffs |
|---|---|---|---|
| 29 open of 49 ([UNKNOWNS](UNKNOWNS.md)) | 0 of 4 ([BLOCKERS](BLOCKERS.md)) | 65 open of 87 ([TECH_DEBT](TECH_DEBT.md)) | 1 ([UNFINISHED](UNFINISHED.md)) |

## Milestone progress
M1: 18 / 18 tasks done. Exit criteria met; awaiting Ben's sign-off.

## Last session
- **Live messages**, ADR-0007 (backend agent):
  - REST → engine event (no state change) → outbox `send_message` (enum migration, Ben approved) → the daemon writes into the live process;
  - slash commands pass through;
  - e2e `live_message`.
- **Session panel** (web agent): tabs, composer, slash menu, jump-to-latest, readable Details/context, per-ticket names and avatars.
- **QA:** both branches PASS WITH DEBT; they merged cleanly (586 tests, e2e 7).
- **Deployed:** the migration applied and the orchestrator and daemon were restarted on main.
- **The WhatsApp session's branch** was pushed and opened as personal-os PR #15.
- **New debt:** TD-085..087, U-049.
