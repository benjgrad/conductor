# Unknowns

Open questions whose answer changes what we build. **Raise one** whenever you'd otherwise guess at something hard to reverse. **Resolve one** with a spike, a decision from Ben, or an ADR, and record the resolution in place. Never delete rows. IDs are never reused.

Status: `open` · `investigating` · `resolved` · `wont_resolve`
Blocks: the task(s) that cannot finish until this is resolved.

| ID | Question | Why it matters | Blocks | Owner | Status | Resolution |
|---|---|---|---|---|---|---|
| U-001 | How does the daemon drive Claude Code: headless `claude -p --output-format stream-json` + `--resume`, the Claude Agent SDK, or an interactive PTY? | Decides how we get the session id, stream output, inject answers mid-session, read cost, and restrict tools | M1-T05, M1-T07 | M1-T00 | open | |
| U-002 | How does the agent signal `complete_state` / `ask_user`: an MCP server exposed by the daemon, SDK custom tools, or parsing structured output? | "Transitions fire on outcomes": we need a reliable structured channel | M1-T07 | M1-T00 | open | |
| U-003 | Ticket source for v1: manual UI entry, or Jira/GitHub webhook? | Shapes `ticket` ingestion and `external_ref` | M3 | Ben | open | Default for M1: manual entry via UI/REST |
| U-004 | Sandboxing on macOS laptops: containers per session, or worktree-only + tool allow-lists? | Safety vs. friction on dev machines | M3 | — | open | |
| U-005 | Terminal output: in-memory ring buffer only? Size? Any durable history? | Memory budget of orchestrator; debugging after the fact | M1-T08 | — | open | Proposed: 256 KB ring per session, no durable history (ADR-0003) |
| U-006 | Visual workflow editor: in scope, or JSON-only? | UI scope | M4 | Ben | open | Assumed JSON-only until M4 |
| U-007 | Answer input requests from Slack on day one, or later? | Overnight blocking vs. scope | M4 | Ben | open | Assumed later (M4). Note: in the workshop PDF (p.20) the coach recommended Slack answering **on day one** and Ben didn't respond, so this is not agreed. Ben's call. |
| U-008 | Auth: web UI users, and daemon enrollment (per-machine tokens? mTLS?) | Security before leaving localhost | M2 | — | open | M1 runs on localhost only |
| U-009 | Do we need `ticket.repo_allow_machines` as a hard constraint, or are `required_tags` enough? | Claim query shape ([04](../design/04-scheduler.md)) | M1-T02 | — | open | |
| U-010 | Triage/plan states and child tickets: schema for `child_tickets[]` and the parent's `children.done` wait | Ticket breakdown requirement from the brief | M4 | — | open | |
| U-011 | Checkpoint policy for resume: when does an agent state commit + push to its session branch (on park, every N min, on each `complete_state`)? | Determines how much work is lost on laptop sleep | M2 | — | open | |
