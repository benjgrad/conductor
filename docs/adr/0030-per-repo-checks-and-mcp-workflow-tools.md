# ADR-0030 · Per-repo pre-PR checks, and MCP-first workflow management

- **Status**: accepted, amended 2026-11-02 for `save_workflow` (Ben, 2026-11-02, on the plan of ticket "Improved repo-specific pre-PR checks and workflows"; supersedes the "workflow reads and edits" item of the 2026-10-30 MCP tool-set decision, ADR-0028 / [10-contracts §OAuth and MCP](../design/10-contracts.md))
- **Date**: 2026-11-02
- **Deciders**: Ben (+ conductor planning and implementing sessions)
- **Resolves**: —

## Context
The shipped `conductor` workflow (v2–v4) runs `npm run build` and `npm test` on every transition that ships code, in a fresh checkout whose `setup` is auto-detected from the root lockfile. A work repo whose JavaScript lives in subfolders (`m-one/`, `MethodUI/`) and whose backend builds with MSBuild/vstest has no root `package.json`, so every ticket on it fails the check at setup. Nothing in that repo can fix it: adding a root `package.json` the team doesn't need would be a conductor-specific commit, which `WORK_COMMIT_REVIEW_ITEM` forbids on work repos. Editing the workflow's checks would change every repo.

Ben also asked that conductor be **MCP-first**: every way to change how workflows run must have an MCP tool, so agents can manage it. Until now, MCP exposed neither workflow reads nor edits (Ben, 2026-10-30).

## Decision
1. **Per-repo check overrides, in their own table.** `repo_checks (account_id, repo, config, updated_at, updated_by)`, primary key `(account_id, repo)`. `config` is `RepoChecksSchema`: `{setup?, checks: [{name, cmd, timeout?}] (1..20, unique names)}`. `repo` is `repoChecksKey(repo)`: canonical `host/org/repo`, lower-cased. A repo that isn't host/org/repo (a local-mode path) is kept as given, trimmed and lower-cased. Overrides are not stored in the workflow definition, because any edit there makes the latest `conductor` version non-shipped, and the seed (`seedConductorWorkflow`) would then stop installing newer defaults.
2. **What an override replaces.** For a ticket on that repo, every gate step that runs at least one real check (a transition's `requires.checks`, or a state's `entry.checks`) runs the override's checks and `setup` instead (`applyRepoChecks`). `setup` keeps its meaning: absent = auto-detect, `''` = none. Gate steps with only the implicit commit-pin check, only conditions, or only a review are unchanged. Per-transition overrides are not supported.
3. **Pinned per step.** The EngineService reads the override with the session (`readRepoChecks`, into `SessionSnapshot.repo_checks`), and a new gate step pins it (`GateStep.repo_checks`). An edit while a step runs can't shift its check index; the next attempt (a retry after an unmet check) uses the new override. A stored config that no longer parses reads as none and is logged, so the ticket falls back to the workflow's checks rather than wedging.
4. **Managed over MCP and REST.** MCP tools (all scoped to the token's account):
   - `list_repo_checks` and `get_repo_checks` (read-only): the override, and the effective checks at each gate of the latest `conductor`;
   - `set_repo_checks`: validated upsert, `updated_by` = `mcp:<email>`;
   - `clear_repo_checks` (destructive).

   `get_workflow` (read-only) outlines a workflow (states, transitions, the gates that run checks), or returns one state in full. REST has the same operations: `GET/PUT/DELETE /api/repo-checks`. Both call the same functions (`orchestrator/src/api/repo-checks.ts`).
5. **MCP-first rule.** A change that adds a way to manage how workflows run ships with an MCP tool for it. Approvals, permission prompts, fresh conversations, machine enrollment, team/admin and transcripts stay off MCP, as before.

## Consequences
- A repo with an unusual build (subfolders, MSBuild, a test filter for DB-dependent tests) is configured once, by a person or an agent, without touching the repo or the workflow.
- Checks run with `sh -c` in a fresh checkout at the repo root (Git Bash on Windows), so .NET steps must be written in bash and their tools must be on PATH or called by full path. The tool description says so.
- The override is account-wide per repo, while workflows are instance-wide. Two accounts working on the same repo can have different checks.
- MCP writes are still recorded under the `ui` engine actor (no MCP attribution yet); `repo_checks.updated_by` does record `mcp:<email>`.
- The settings UI is the web app's Repo checks page ([11-web-ui §Repo checks](../design/11-web-ui.md#repo-checks-adr-0030)), over the same REST routes.
- Saving a whole workflow over MCP (`save_workflow`) came in a follow-up: see [§Amendment (2026-11-02): save_workflow](#amendment-2026-11-02-save_workflow).
- The Rust daemon is unaffected: overrides resolve in the orchestrator's `apply`, and the daemon only sees `run_cmd`.

## Alternatives considered
- **Overrides inside the workflow definition** (`repos: {<repo>: {checks, setup}}`): versioned with the workflow, but any edit stops future default versions from seeding, and it mixes per-account repo settings into an instance-wide definition.
- **A config file in the repo** (`.conductor/checks.json`): forbidden on work repos (conductor-specific commits).
- **Marking the check "not applicable" per ticket:** loses the gate entirely and has to be repeated on every ticket.

## Amendment (2026-11-02): save_workflow
Approved by Ben on the plan of ticket "MCP save workflow tool".

### Security review
`workflow_definition` is instance-wide: its key is `(id, version)`, its `account_id` is always the `local` default (TD-109), and per-account workflows are M2-T12. The latest version of a workflow is what every account's new tickets, reopens and re-pinned parked tickets run. Letting an OAuth-connected agent save one risks:
1. **Cross-account effect.** One account's token would change every other account's prompts, checks and tools.
2. **Code execution.** `requires.checks`, `entry.checks` and `setup` are shell commands, and agent states carry prompts and tool permissions, so a save is command execution on every account's machines. (`set_repo_checks` already allows this, but only inside the caller's account.)
3. **Approval bypass.** Removing a transition's `requires.approvals`, then `take_transition`, gets around ADR-0014 §5 (MCP never takes a move a human must approve).
4. **Prompt injection.** An agent reading untrusted ticket bodies or PR text can be steered into calling the tool.
5. **Seed lock-out.** Any save stops newer shipped defaults from installing themselves, for every account.
6. **Corrupted reads.** MCP results are capped at 8 KB (ADR-0028), so an agent that rebuilds a definition from a cut result would save a cut prompt.

### Decision
- **`save_workflow {definition, base_version?}`** validates (`validateWorkflow`) and saves the next version (max + 1), `created_by` = `mcp:<email>`. An invalid definition returns `invalid_workflow` with each error's `rule`, `path` and `message`; a valid one returns `{id, version, default_available}`.
- **Instance admins only, or local mode.** Both write tools return `forbidden` unless the token's user `is_admin`, or the instance is in local mode (one loopback user, so instance-wide is account-wide). The tools stay listed for everyone; the descriptions say so. When M2-T12 makes workflows per-account, this can relax to the caller's account.
- **No weakening of approvals over MCP** (`approvalsWeakened`, shared). For every human transition of the latest stored version with `requires.approvals`, the new definition must keep that transition with every one of those approvals, and every other transition out of the same state to the same target must carry them too. Otherwise `approval_weakened`, listing the transitions: approvals are changed on the board or REST. It does not catch a detour through another state; the admin gate is the main control.
- **Truncation guard.** A definition whose JSON contains the cap marker `…[truncated]` is refused (`invalid_input`). The whole shipped `conductor` v4 is under 5 KB, so `get_workflow` keeps the 8 KB cap.
- **Optimistic concurrency.** With `base_version`, the save happens only while that is still the latest version, else `conflict` with `latest`.
- Both tools are annotated destructive, so clients confirm with the user.

### The seed
Unchanged: a stored latest version that isn't a shipped one at its own version number stops auto-seeding, whether it came from REST or `save_workflow`. `get_workflow` now carries `default_available` (as `GET /api/workflows/:id`): the newest shipped version when no stored version is it, else null. Right after an edit it is still null, because the shipped version is in the history; it turns non-null when a newer default ships and the seed holds it back. `adopt_default_workflow {base_version?}` (same gate and approval check) saves the newest shipped definition as the next version: the edits are replaced and `default_available` is null again, but auto-seeding stays off, because that version number is not the shipped one. Version-agnostic seed matching is a follow-up.

### Not changed
`POST /api/workflows` keeps its behaviour (no admin gate, no approval guard). Any signed-in user can save there today; that is pre-existing and M2-T12's to fix. MCP saves are still applied as the `ui` engine actor; only `created_by` records `mcp:<email>`.

## Note (2026-11-06): check-config failures, agent proposals, retries

The 2026-11-06 incident (a setup of `git fetch -q origin` in a checkout without a remote) stalled two tickets whose agents could see the problem but not fix it. Since then: a setup that fails on the base branch too reaches a human as a `check_config` request naming the override (who saved it, when) and `set_repo_checks`, without counting against the gate's retries; any change to a repo's checks (REST, MCP, an applied proposal) retries the gates waiting on that repo (`gate.retry`). An agent may **propose** new repo checks with its question (ask_user `proposed_checks`, stored as a `repo_checks` change proposal on its ticket), but never apply them: the gate that judges its work stays a human's. [06](../design/06-human-input.md#check-config-failures-and-agent-proposed-repo-checks).
