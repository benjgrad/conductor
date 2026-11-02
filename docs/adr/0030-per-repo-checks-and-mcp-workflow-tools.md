# ADR-0030 · Per-repo pre-PR checks, and MCP-first workflow management

- **Status**: accepted (Ben, 2026-11-02, on the plan of ticket "Improved repo-specific pre-PR checks and workflows"; supersedes the "workflow reads and edits" item of the 2026-10-30 MCP tool-set decision, ADR-0028 / [10-contracts §OAuth and MCP](../design/10-contracts.md))
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
- There is no settings UI yet: REST and MCP only. A follow-up ticket adds one.
- Saving a whole workflow over MCP (`save_workflow`) is a follow-up ticket: it is a larger write surface and interacts with the seed's `default_available`.
- The Rust daemon is unaffected: overrides resolve in the orchestrator's `apply`, and the daemon only sees `run_cmd`.

## Alternatives considered
- **Overrides inside the workflow definition** (`repos: {<repo>: {checks, setup}}`): versioned with the workflow, but any edit stops future default versions from seeding, and it mixes per-account repo settings into an instance-wide definition.
- **A config file in the repo** (`.conductor/checks.json`): forbidden on work repos (conductor-specific commits).
- **Marking the check "not applicable" per ticket:** loses the gate entirely and has to be repeated on every ticket.
