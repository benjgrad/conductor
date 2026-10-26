# M5 · Work connectors

> **Outline.** The detailed task breakdown is written when M4 is near done, and Ben approves it before work starts. The task table below is a first cut.

**Goal** ([ADR-0016](../../adr/0016-work-connectors-on-the-users-machine.md)): Ben's work-ticket rules hold end to end:
- PR checks green and approvals in;
- Jira updated with the solution and its status read back;
- the Azure pipeline built for the branch;
- a Slack message sent only after a human approved its text.

Every connector runs on the user's machine through its CLIs and MCP servers, routed by capability, with no third-party secrets on the server. Webhooks make GitHub updates near-immediate.

**Exit criteria**:
- The connector registry in `shared` is the single source for the validator, `requiredCapabilities()`, the daemon and the editor.
- GitHub: `pr_checks_green`, `pr_approvals`, `pr_merged` complete (M1b built the basics); changes requested → `on_unmet` with evidence; webhook hints trigger an evaluation within 5 s of a signed delivery; a forged or unsigned delivery changes nothing (test).
- Jira: `jira_fields_set` and `update_jira` work through a Jira CLI or, when only an MCP server is configured, through the daemon's direct MCP client (U-065); idempotent re-runs.
- Azure: `azure_pipeline_succeeded` reads the latest run for the branch and the PR head commit.
- Slack: `slack_message` only on human transitions (validator); the e2e drafts a message, the human edits it and presses "Send and continue", and exactly one post is made with the approved text.
- `conductor` v3 enables the Jira and Azure conditions for work tickets, with per-account settings (Jira project, pipeline) editable in the Workflow view.
- E2E with fake `gh`, `az`, `jira` and a fake Slack MCP server; Ben's manual check against one real repo, Jira project and pipeline.

**Not in M5**:
- ticket sources (Jira or GitHub issues → tickets, U-003);
- Slack answering of input requests (U-007);
- central service accounts;
- Azure DevOps and Jira push hooks (poll only);
- connectors for other systems.

**Blocking unknowns**: proposed U-052 (webhook ingress: per-repo hooks vs a GitHub App), U-058 (evaluation with no machine online, revisited for any-machine routing), U-065 (MCP-backed connectors). Also which Jira CLI to support, and the minimum `gh`/`az` versions (to be raised as U-rows when detailed).

## Task board (first cut)

| ID | Task | Depends on | Parallel group | Status |
|---|---|---|---|---|
| M5-T01 | **Contracts**: the connector registry (types, args, capabilities, idempotency); `evaluate_conditions` routed to any capable machine; webhook route and account hook settings; per-account connector settings | M4 done | A | todo |
| M5-T02 | GitHub: complete the conditions (merged, changes requested, per-reviewer counting); webhook ingress with signature check and evaluation scheduling | T01, U-052 | B | todo |
| M5-T03 | Daemon MCP client for connectors (stdio and HTTP servers from the user's config, one named tool, fixed args, timeouts) | T01, U-065 | B | todo |
| M5-T04 | Azure Pipelines condition via `az` | T01 | B | todo |
| M5-T05 | Jira condition and `update_jira` action (CLI, then the MCP client) | T03 | C | todo |
| M5-T06 | Slack `slack_message` action (MCP client or CLI), the validator's human-only rule, and the Send-and-continue flow on the board | T03 | C | todo |
| M5-T07 | Orchestrator: route condition evaluation to any capable online machine; backoff and per-account caps | T01 | B | todo |
| M5-T08 | `conductor` v3 and connector settings in the editor | T02, T04, T05 | D | todo |
| M5-T09 | E2E with fake CLIs and a fake Slack MCP; the manual real-systems check documented | all | E | todo |
