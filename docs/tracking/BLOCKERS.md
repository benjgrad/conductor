# Blockers

Something that **stops a task right now** and needs an action, often from Ben (access, a decision, an external dependency). An unknown is a question. A blocker is a wall. If the wall comes from an unknown, link the U-###.

When a blocker clears, set `Status: cleared`, fill in `Cleared`, and keep the row.

| ID | Blocked task(s) | Blocked on | Since | Unblock action (who does what) | Status | Cleared |
|---|---|---|---|---|---|---|
| B-001 | M1-T12 (group A2), and so M1-T05, M1-T07 | ADR-0005 is `proposed`; the M1 gate after group A requires Ben to accept it before T12 pins the `ClaudeDriver` contract | 2026-10-22 | Ben reads docs/adr/0005-claude-code-driver.md and spikes/claude-driver/README.md, then sets Status to accepted (or requests changes); lead then marks U-001/U-002 resolved | open | |
<!-- example:
| B-001 | M1-T05 | No Claude Code API key on the build server | 2026-10-23 | Ben adds key to ~/.config/conductor/env on build-01 | open | |
-->
