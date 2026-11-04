# MA · Workflow advisor

> Ben approved the plan on 2026-11-03 (ticket "AI workflow agent"). P1 (MA-T01) ships first. The later tasks are a first cut: each gets its detail when it's picked up, and its dependencies must be `done` first.

**Goal** ([ADR-0033](../../adr/0033-workflow-advisor.md)): an AI agent the user talks to (claude.ai, Claude Code, later the M4 chat) that:
- reads the account's past sessions without filling its own context;
- finds process inefficiencies;
- proposes one small, reversible change at a time;
- configures the workflow, transition rules, repo checks and machine rules through conductor's existing guarded tools, after the user confirms.

Analysis is layered:
- deterministic SQL and pure metrics (P1);
- analyst sub-agents: one-shot, schema-validated `claude -p` jobs on the user's machines (P2);
- change proposals with a before/after review (P3);
- the in-app chat (P4, = M4).

**Exit criteria**:
- P1: `get_process_metrics` and `list_findings` return deterministic, account-scoped results under 8 KB; the `workflow_advisor` prompt is served; the tool list is ≤ 20 KB.
- P2: a finished session produces at most one `session_insight` per schema version. The result is zod-validated (malformed results are dropped, never retried in a loop). Jobs run in a light slot and are capped at 20 a day per account. Insights are kept 180 days.
- P3: a proposal shows its diff, evidence, expected effect and rollback. Applying it re-checks the base version, the admin gate and `approvalsWeakened`. The review (`list_change_proposals` with an id, ADR-0033 §Amendment: P3 as built) compares metrics before and after. `bypassPermissions` can't be set over MCP.
- E2E: fake claude returns a canned insight; the coordinator lists findings, proposes a repo-checks change, and it is applied after a confirm.

**Not in MA**:
- a model on the server (ADR-0015);
- auto-applied changes;
- per-account workflows (M2-T12);
- the chat panel itself (M4);
- Slack or voice-specific clients.

**Blocking unknowns**: none for P1. U-055 (light slot, 20 jobs a day) and U-066 (store insights, 180 days) are answered in ADR-0033. U-014 (subscription rate limits) still applies to P2.

## Task board

| ID | Task | Depends on | Parallel group | Status |
|---|---|---|---|---|
| MA-T01 | **P1**: `advisor/metrics.ts` (shared, pure), `advisor/queries.ts` (orchestrator), MCP `get_process_metrics` / `list_findings`, the `workflow_advisor` prompt, ADR-0033, docs | — | A | done (PR #115) |
| MA-T02 | Contracts: WS `assistant_job` / `assistant_result` (zod → `emit:protocol` → codegen, fixture parity pair), `SessionInsightSchema`; shared with M4-T01/T04 | T01 | B | done (P2 branch) |
| MA-T03 | Rust daemon one-shot runner: `claude -p --output-format json --json-schema`, `--tools ""`, empty `--strict-mcp-config`, ADR-0006 env guards, empty private cwd, kill_tree on a 120 s timeout; light-slot semaphore (default 1, outside `max_sessions`); transcript tail read locally; PARITY rows | T02 | C | done (P2 branch; wired in by MR-T12 FR-4, live once machines run the Rust daemon, MR-T15/T16) |
| MA-T04 | Orchestrator: `session_insight` migration; a scheduler on session end (outbox, idempotency key `insight:<session_id>:<schema_version>`, 20 a day per account, backfill limit, prefers the machine that ran the session); zod re-validation; 180-day retention; MCP `get_process_report` and `get_insight`; findings merged into `list_findings` | T02, T03 | D | done (P2 branch; dormant until a daemon advertises `assistant_job`) |
| MA-T05 | `change_proposal` migration; `advisor/diff.ts` (shared: structural diff of workflow and repo checks; machine settings with T06); MCP `propose_change`, `list_change_proposals` (with `id`: reviews an applied one), `apply_change` (destructive, through the existing guards); REST `/api/change-proposals` | T01 | B | done (ticket "AI workflow agent") |
| MA-T06 | Machine settings over MCP: `get_machine_settings` and machine-settings proposals, owner/admin only, `resolveEffectivePolicy` invariants, never `bypassPermissions`; suggested allow rules from `alwaysRuleFor` | T05, M2-T28c, MR-T17b | E | blocked (M2-T28c, MR-T17b) |
| MA-T07 | Web: Proposals list on the Workflows page (diff, evidence, Apply / Reject, review result) | T05 | C | done (ticket "AI workflow agent") |
| MA-T08a | E2E: findings → proposal → confirm → apply → review, over `/mcp` on the real bins | T05 | F | done (ticket "AI workflow agent") |
| MA-T08b | E2E: fake-claude insight job through the Rust daemon; `recurring_friction` in `list_findings` | T04, MR-T16 | F | blocked (MR-T16) |

## Task details

### MA-T01 · P1: deterministic metrics, findings and the advisor prompt
- **Scope**: pure metrics and heuristics (`stateDurations`, `loopCounts`, `checkFailureRates`, `inputStats`, `permissionStats`, `processMetrics`, `rankFindings`), account-scoped window queries, two read-only MCP tools and one MCP prompt. No migration, no daemon change, no writes.
- **Design refs**: [ADR-0033](../../adr/0033-workflow-advisor.md), [10-contracts §OAuth and MCP](../../design/10-contracts.md).
- **Acceptance**:
  - [x] Every metric and heuristic is covered by pure tests, including empty windows and running sessions (`packages/shared/src/advisor/metrics.test.ts`).
  - [x] Queries see only the caller's account, inside the window, filtered by repo case-insensitively (`packages/orchestrator/test/advisor.queries.test.ts`).
  - [x] The tools are listed last, are read-only, clamp `window_days`, page findings, and stay under the 8 KB cap; the prompt is served (`packages/orchestrator/src/mcp/tools.unit.test.ts`).
  - [x] The tool list stays ≤ 20 KB and `MCP_INSTRUCTIONS` ≤ 600 characters (`oauth-mcp.test.ts`, `tools.unit.test.ts`).

### MA-T02..T04 · P2: analyst sub-agents (one branch, three commits)
- **Scope**: ADR-0033 §Amendment. Ben approved shipping it dormant until the Rust daemon cutover: MR-T12 FR-4 wires `claude/oneshot.rs` in and advertises `features: ["assistant_job"]`.
- **Acceptance**:
  - [x] T02: the WS frames, `register.features`, outbox kind `assistant_job`, `SessionInsightSchema` and its JSON Schema; fixtures, `protocol-json`, generated Rust types and round-trip goldens (`ws.assistant.test.ts`, `advisor/insight.test.ts`, `protocol-json.test.ts`, `crates/conductor-protocol/tests/roundtrip.rs`).
  - [x] T03: the runner's args, output parsing, transcript fence, light slot and queue, and the timeout tree kill against a fake `claude` (`crates/conductor-daemon/src/claude/oneshot/tests.rs`).
  - [x] T04: one job per session and version, the cap of 20 a day, account isolation, the feature and online gates, stored / dropped / failed results never retried, expiry, 180-day retention, ticket cascade (`test/advisor.insights.test.ts`); the gateway path from register to insight (`test/gateway/assistant-jobs.test.ts`); the MCP tools (`tools.unit.test.ts`, `oauth-mcp.test.ts`).
  - [ ] Live: insights appear once a Rust daemon runs MR-T12 FR-4 (MA-T08's e2e needs MR-T16).

### MA-T05, MA-T07, MA-T08a · P3: change proposals
- **Scope**: ADR-0033 §Amendment: P3 as built. Machine settings (T06) and the insight-job e2e (T08b) are blocked.
- **Acceptance**:
  - [x] T05: the structural diff and the metric comparison (`shared/src/advisor/diff.test.ts`, `proposal.test.ts`); propose validation, the cap of 20, account isolation, apply once under concurrency, the admin gate, base and snapshot conflicts, weakening refused at propose and apply, reject, review windows (`test/advisor.proposals.test.ts`, `advisor.queries.test.ts`); the REST routes (`test/api.change-proposals.test.ts`); the tools, their order, annotations and `confirm` (`tools.unit.test.ts`), the flow over `/mcp` and the 22 KB tool list (`oauth-mcp.test.ts`); the table (`schema.test.ts`).
  - [x] T07: the list, the detail, Apply behind a confirm, Reject, the review, refusals, the workflow warning and the editor reload (`web/src/workflow/ProposalsPanel.test.tsx`, `WorkflowsView.test.tsx`).
  - [x] T08a: `e2e/advisor.e2e.test.ts`.
