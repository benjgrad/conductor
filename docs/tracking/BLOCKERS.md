# Blockers

Something that **stops a task right now** and needs an action, often from Ben (access, a decision, an external dependency). An unknown is a question. A blocker is a wall. If the wall comes from an unknown, link the U-###.

When a blocker clears, set `Status: cleared`, fill in `Cleared`, and keep the row.

| ID | Blocked task(s) | Blocked on | Since | Unblock action (who does what) | Status | Cleared |
|---|---|---|---|---|---|---|
| B-001 | M1-T12 (group A2), and so M1-T05, M1-T07 | ADR-0005 is `proposed`; the M1 gate after group A requires Ben to accept it before T12 pins the `ClaudeDriver` contract | 2026-10-22 | Ben reads docs/adr/0005-claude-code-driver.md and spikes/claude-driver/README.md, then sets Status to accepted (or requests changes); lead then marks U-001/U-002 resolved | cleared | 2026-10-22 (Ben accepted ADR-0005) |
| B-002 | M1 group B (T02, T03, T05, T09) and everything after | M1-T12 contracts not merged: QA failed the interface review (13 gaps, 6 of which force a contract edit or cross-task guess in group C), and the A2 gate needs Ben's approval of docs/design/10-contracts.md | 2026-10-22 | Lead runs T12 fix round 3 on `m1-t12-contracts` for the gaps Ben wants fixed now (see UNFINISHED); Ben reviews 10-contracts on the branch and approves; integrator merges T12 | open | |
<!-- example:
| B-001 | M1-T05 | No Claude Code API key on the build server | 2026-10-23 | Ben adds key to ~/.config/conductor/env on build-01 | open | |
-->
