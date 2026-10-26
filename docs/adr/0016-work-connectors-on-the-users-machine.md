# ADR-0016 · Work connectors run on the user's machine: GitHub, Jira, Azure Pipelines, Slack

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M5)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26)
- **Builds on**:
  - [ADR-0011](0011-transition-rules.md): `requires.conditions` and `requires.actions`, `evaluate_condition`, pending checklists;
  - [ADR-0013](0013-machine-enrollment-inventory-routing.md): capabilities and routing;
  - [ADR-0010](0010-one-workflow-columns-are-states.md): `run_action`, the `open_pr` hardening.
- **Supersedes**:
  - [01](../design/01-architecture.md) §Credentials split ("connector states run in the orchestrator with its stored secrets");
  - [09](../design/09-security-and-budgets.md)'s "Connector secrets: only in the orchestrator" row;
  - [05](../design/05-workflow-engine.md)'s `connector` state type for new definitions. Old versions still parse, and TD-044's undispatched `connector_call` rows are retired.
- **Touches**: [U-003](../tracking/UNKNOWNS.md) (ticket source: still manual), [U-007](../tracking/UNKNOWNS.md) (Slack answering: not this ADR).

## Context
The workshop design ran connectors in the orchestrator with stored secrets. Since then:
- conductor became hosted and multi-user ([ADR-0012](0012-hosted-multi-user-github-sign-in.md)), so a central secret store would hold every user's Jira, Azure and Slack credentials;
- ADR-0011 made external facts **conditions** on transitions, evaluated on the user's machine;
- Ben chose machine-first execution for chat and summaries too.

His Implementing → Waiting external rule for work tickets needs:
- PR checks green;
- peer approvals;
- the Jira ticket updated;
- the Azure pipeline built;
- and, on another edge, an approved Slack message.

## Decision
**Every connector condition and action runs on one of the user's machines, through the CLIs and MCP servers already logged in there. The server stores no third-party credentials. A connector declares the capability it needs; routing ([ADR-0013](0013-machine-enrollment-inventory-routing.md)) only sends a ticket to machines that have it. Webhooks are only hints that trigger a re-evaluation, never the source of truth. A message to a person (Slack) is an action that only a human transition can take.**

### The connector registry
- `shared/src/connectors/registry.ts` lists every condition and action type: its args schema, its capability, and its idempotency rule. It is the single source for the validator, `requiredCapabilities()` and the editor.
- The daemon implements each in `daemon/src/connectors/<name>.ts`. A condition returns `{status: 'met' | 'pending' | 'failed', value, detail}`: `pending` keeps waiting, `failed` goes to `on_unmet` (ADR-0011).

| Type | Kind | Capability | Machine command (read-only unless noted) |
|---|---|---|---|
| `pr_checks_green` | condition | `cli:gh authed` | `gh pr view <url> --json statusCheckRollup`: all success → met; any failure → failed; else pending |
| `pr_approvals {min}` | condition | `cli:gh authed` | `gh pr view --json reviewDecision,reviews,author,headRefOid`. Per **eligible** reviewer (`authorAssociation` OWNER / MEMBER / COLLABORATOR, never the PR author), in review order: `CHANGES_REQUESTED` on any commit blocks; `APPROVED` on the current head (`commit.oid` = `headRefOid`) approves and clears a block; `APPROVED` on an older commit is stale (no approval, and a block stays); `DISMISSED` clears the verdict. Then: `reviewDecision` `CHANGES_REQUESTED` or any blocked reviewer → failed; `REVIEW_REQUIRED` → pending; otherwise met when approvals ≥ `min`, else pending (M1b-T05) |
| `pr_merged` | condition | `cli:gh authed` | `gh pr view --json mergedAt,state` |
| `azure_pipeline_succeeded {pipeline}` | condition | `cli:az authed` (devops extension) | `az pipelines runs list --branch <b> --pipeline-ids/--name … --top 1`, then the run's `result` for the PR's head commit |
| `jira_fields_set {fields}` | condition | `cli:jira authed` or `mcp:<atlassian>` | read the issue named by `ticket.external_ref`; each listed field non-empty (or equal to a value) |
| `open_pr` | action | `cli:gh authed` | unchanged from ADR-0010 (writes) |
| `update_jira {fields, transition?}` | action | as `jira_fields_set` | sets fields from the source state's result; idempotent (setting values) |
| `slack_message {channel, text_from}` | action | `mcp:<slack>` or `cli:slack` | posts the approved text (writes; human transitions only) |

Head pinning (M1b-T05): when `evaluate_conditions` carries `head_sha` (the commit conductor checked and pushed) and the PR's `headRefOid` differs, every PR condition fails ("someone pushed to the branch").

### Execution
- Conditions run as ADR-0011's `evaluate_conditions` `run_action`, through the outbox to a machine of the account that has the capability. That is the session's machine when it is online, else **any** online machine of the account with the capability, because conditions read remote state and need no worktree. All the conditions of one transition go in one command; results are per condition.
- Polling every 2 minutes per pending transition, with backoff to 15 minutes after an hour, and capped per account.
- **CLI first.** Where a connector can use an MCP server instead (Jira, Slack), the daemon talks to the user's configured server directly as an MCP client, calling one named tool with fixed arguments. It does **not** run `claude` for it, so the result stays deterministic (U-065).
- Every connector runs with a 60 s timeout, outside any repository, with `GIT_*` and repo config dropped. Output is capped at 16 KB and kept as evidence on the checklist.
- **Idempotency**: actions keep ADR-0010's key `<session>:<state>:<visit>`. `update_jira` is naturally idempotent. `slack_message` checks the channel history for a message carrying the key before posting, where the transport allows it; otherwise an occasional duplicate is accepted, as [05](../design/05-workflow-engine.md) already records.

### Slack messages need a human transition first
- The validator only allows `slack_message` in the `requires.actions` of an **`actor: human`** transition.
- The pattern (conductor defaults): the agent takes `needs_approval_to_message` → Needs input, with the draft and the recipient as its result. The human sees them, edits if needed, and presses **Send and continue** (a human transition back to Implementing whose `requires.actions` is `slack_message`). The posted text is the human-approved one.

### Webhooks (hosted)
- `POST /hooks/github/<account_hook_id>`: each account gets a random hook id and a signing secret (conductor's own secret, not a GitHub credential). The user adds it to a repo or org as a webhook for `pull_request`, `pull_request_review`, `check_suite` and `status` events.
- The handler verifies `X-Hub-Signature-256`, finds pending transitions of that account whose PR matches, and **schedules an immediate evaluation**. It never sets a condition from the payload: an unauthenticated-looking or replayed hook can at most cause an extra poll.
- Azure DevOps service hooks follow the same pattern later; Jira has no reliable push in this design (poll only). U-052 decides between per-repo webhooks and a GitHub App.

### Defaults
`conductor` v3 turns on the Jira and Azure conditions that v2 declares disabled. Their settings (Jira project, pipeline name) live in an account setting the editor writes, because they differ per user.

## Alternatives considered
| Option | Why not |
|---|---|
| Connectors in the orchestrator with stored OAuth tokens (the workshop design) | Every user's third-party credentials on one hosted server; per-service OAuth apps to register. The machines already hold working logins |
| Agents call Jira, Azure and Slack themselves from their session | Nondeterministic, unaudited, and needs MCPs inside agent sessions, which ADR-0006 forbids. Conditions must be facts, not claims |
| Trust webhook payloads as condition values | A forged or replayed payload could approve a PR's gate; re-checking on the machine costs one CLI call |
| Let agents send Slack messages after review | A message to a person can't be taken back; Ben wants a human to approve it |
| Run `claude -p` with the MCP server to read Jira | Model in the loop for a field read; slower and not deterministic |

## Consequences
- **Good:**
  - no third-party secrets on the server;
  - each connector is a small, testable CLI wrapper with fake binaries in e2e;
  - routing guarantees the machine can actually do what the workflow asks.
- **Bad / accepted cost:**
  - conditions need some machine of the account online;
  - CLI output formats drift (pin minimum versions and parse leniently, as U-015 did for `claude`);
  - users must configure webhooks themselves for fast updates;
  - an MCP client is needed in the daemon.
- **Follow-ups:** M5 tasks; U-052 (webhook ingress), U-058 (no machine online), U-065 (MCP-backed connectors).

## Revisit when
An organisation wants central service accounts (connectors in the orchestrator, per account, with a secret store), or a CLI proves too unstable to parse.
