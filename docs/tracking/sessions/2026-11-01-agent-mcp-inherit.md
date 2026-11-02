# Session 2026-11-01 · agent-mcp-inherit

- **Lead**: Claude (Opus 5.5) with Ben · background job "Eamon session stuck in queued"
- **Milestone / phase**: M2 · Orchestrate (out-of-plan task M2-T37)
- **Goal for this session**: get NCNG-2630 (method-platform-ui, PC115) running, then give agents Ben's MCP servers

## What happened
- NCNG-2630 sat in Queued: no online machine reported `github.com/methodcrm/method-platform-ui`. PC115 and the MacBook Air had no repo roots (0 `machine_repo` rows). Ben set PC115's roots; it reported 105 repos and claimed the ticket.
- The first start looped on `ack_timeout` 5 times in 3.5 min (the daemon acks only after the first clone + worktree) before it ran: TD-200.
- The agent then ran 60 s with no output at all until the daemon was restarted; a manual `claude -p` in the worktree worked, and the retry ran: U-119.
- The agent had no Jira access: ADR-0006's `--strict-mcp-config` + `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Ben chose per-workflow control defaulting to inherit everything. Built M2-T37 / ADR-0029 on `m2-t37-agent-mcp-inherit` (off origin/main 91aefb8).
- Found: local `main` (unpushed M2-T29e, promptable push) has an ADR-0027 that collides with origin/main's ADR-0027 (messages while waiting on PR checks), plus TD-196/197 overlap. Left for Ben's reconcile; this branch took ADR-0029, TD-199/200, U-119, which are free on both.
- No global pnpm on gradyserver: ran the corepack-cached pnpm 10.34.7 directly with node (`~/.cache/node/corepack/v1/pnpm/10.34.7/bin/pnpm.cjs`), the same binary that installed the main checkout. No `cargo nextest` either: `cargo test -p conductor-protocol`.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| — (single session) | M2-T37 | `m2-t37-agent-mcp-inherit` | targeted tests pass; full gates not run |

## Tracking changes
- Unknowns raised / resolved: U-119 (silent agent on Windows)
- Blockers raised / cleared: —
- Tech debt added / paid: TD-199 (no MCP allow-list / per-repo), TD-200 (start_session ack after the clone, unbounded requeue)
- ADRs: ADR-0029 (supersedes part of ADR-0006)
- Unfinished handoffs written: — (branch is in review)

## Next session should start with
Gates on `m2-t37-agent-mcp-inherit` (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, cargo gates), PR, then deploy and upgrade PC115's daemon. Then TD-200 (ack on acceptance, bounded requeue).
