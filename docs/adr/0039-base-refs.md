# ADR-0039 · Base refs: where a ticket's branch starts and where its PR goes

- **Status**: proposed
- **Date**: 2026-11-06
- **Deciders**: Ben (+ conductor ticket B1 "Base refs")
- **Amends**: [10 §Machines protocol v2](../design/10-contracts.md#machines-protocol-v2) ("`base_ref` is informational"), from B2. Follows [ADR-0037](0037-workflow-primitives-for-self-healing-process.md)'s principle and its rule-14 rollout. Supersedes nothing.
- **Draft config**: [`conductor.v7.draft.json`](../design/workflows/conductor.v7.draft.json)

## Context

Ben's rules for work tickets (2026-11-06):
- a ticket branches off the latest sprint branch, `<sprint>-sb-1` or `<sprint>-sb-2`;
- a large body of work spanning several Jira tickets branches off `master`;
- a hotfix branches from the exact commit running in production (found from Azure, with the Claude skills on the work laptop), and its PR targets `master`.

None of these can be configured today:
- the daemon adds every worktree from `origin/<default_branch>`; `start_session.base_ref` is informational (10 §Machines protocol v2);
- `open_pr` takes `{title, body}` only, so a PR always targets the default branch;
- the repo checks and the `resync_main` instruction hard-code `origin/main`.

The principle is ADR-0037's: the engine gains general primitives, and the rules above are configuration. Another user with a release-branch process uses the same fields with different values.

## Decision

Four fields, one substitution and one session record. Each lands behind rule 14's "not available yet" (feature `bases`) in B1, and becomes available when B2 implements it.

### The fields

- **Workflow `bases`**: `Record<BaseName, BaseSpec>`. `BaseName` is a slug (`/^[a-z][a-z0-9_-]*$/`, ≤ 40). A `BaseSpec` is one of:
  - `{ref}`: a branch, or `$default_branch` (the repo's `origin/HEAD`);
  - `{cmd, timeout?, pr_into?}`: a command run on the claiming machine, in the repo. It prints one ref on stdout: a branch name or a 40-hex sha. `pr_into` names the PR target for when the ref is not a branch (a prod commit → `master`).
- **Workflow `base_default`**: `Partial<Record<'work' | 'personal', BaseName>>`. A kind it doesn't list starts from `$default_branch`.
- **Ticket `base`**: `BaseName | {ref, pr_into?}`. It is stored in `ticket.base` (jsonb), set by `create_ticket` / POST, and editable by PATCH while the card is Queued. Once a session starts, the base is fixed. A sha `ref` needs `pr_into`.
- **Planning result `base`**: `{name? | ref?, pr_into?, reason}`. This lets the planner choose `master` for a multi-ticket body of work from the Jira context. It is an optional result key, like `files`, read by `planBaseOf`.

### Resolution order (B2)

1. The ticket's `base`.
2. Else the planning result's `base`.
3. Else `base_default[ticket.kind]`.
4. Else `$default_branch`.

The result is recorded once, at start, as `session.base_ref = {name, ref, sha, pr_into}` (jsonb). `BoardCard.base_ref` and `TicketDetail.base_ref` expose it (B3 renders it). A sha result from a base without `pr_into` is refused at run time: conductor can't open a PR into a commit.

A planner's choice arrives after the first start. B2 decides how it applies: it either re-bases the still-empty branch before implementing starts, or plans before the worktree is cut.

### Substitution

In check `cmd`s (`requires.checks`, `entry.checks`), `cmd` condition `cmd`s (`requires.conditions`, `watch.conditions`), the `instructions` texts and literal `on_unmet` / `on_broken` instructions:
- `$base` expands to the resolved base branch, or to `pr_into` when the base is a commit;
- `$base_sha` expands to the resolved commit.

The substitution is literal (`substituteBase`). `$basement` and `${base}` are left alone, so a shell variable named `base` is written `${base}`. Repo checks (ADR-0030) get the same substitution in B2.

### Routing

A `cmd` base runs on the claiming machine, so its tool is a routing capability. `requiredCapabilitiesOf(def, kind)` adds `cmdBaseCapability(cmd)` for the kind's `base_default`: `cli:az:authed` when the command runs `az`, otherwise none. Kind null counts every default.

A base named by one ticket or plan can't be known per workflow version. B2 checks it when it resolves the base. The capability is not spread over every kind, because that would make every personal ticket need `az`.

### Validation on save (rules 26–27)

26. **Base names.** `base_default` needs `bases`, and each of its values names a key of `bases` (`base_default.<kind>`). A ticket's or plan's base name is checked against the same map when it is set (`ticketBaseProblems`, `planBaseProblems`).
27. **`$base` placement.** A `$base` / `$base_sha` use at any substitution site needs the workflow's `bases`. This is how B1 reads the ticket's "refused for a workflow with no bases and no default branch": a definition can't know a repo's default branch, so declaring `bases` (at least `{"default": {"ref": "$default_branch"}}`) is the opt-in.

**Warnings.** `validateWorkflow` gains `warnings`, which have the same shape as errors and never block a save. A `cmd` base without `pr_into` warns (`bases.<name>.pr_into`): a sha from it will be refused at run time. The save routes don't return warnings yet; that is B3.

**Rule 14** refuses `bases`, `base_default` and every `$base` use while the feature `bases` is not in `AVAILABLE_WORKFLOW_FEATURES`. The create and PATCH routes refuse a ticket `base` the same way (400 at path `base`). `validateWorkflow(def, {allowUnavailable: true})` skips the workflow refusals, as for ADR-0037.

### Draft v7

[`conductor.v7.draft.json`](../design/workflows/conductor.v7.draft.json) is the v6 draft plus:
- `bases`:
  - `default {ref: $default_branch}`;
  - `sprint {cmd: git ls-remote … | grep -E -- '-sb-[12]$' | sort -V | tail -n 1}`, which has no `pr_into` and so warns;
  - `master {ref: master}`;
  - `hotfix {cmd: az pipelines runs list … sourceVersion, pr_into: master}`, a placeholder that B5 replaces with the real resolver.
- `base_default {work: sprint, personal: default}`.
- `resync_main` merges `origin/$base` and checks `HEAD..origin/$base`; `fix_and_resubmit` merges `origin/$base`.
- A "Merges cleanly with the base branch" check (`git merge-tree --write-tree HEAD origin/$base`) on the three PR gates. Per-repo checks still replace the workflow's checks where a repo has them (ADR-0030).

It passes `validateWorkflow(draft, {allowUnavailable: true})` with one warning. Without that option, only rule 14 refuses (`conductor.v7-draft.test.ts`).

### Coverage table (Ben's rules, 2026-11-06)

| Rule | Covered by | Config line |
|---|---|---|
| Work tickets branch off the latest `<sprint>-sb-1` / `-sb-2` | `cmd` base + `base_default.work` | `bases.sprint.cmd`, `base_default.work: sprint` |
| A large body of work spanning several Jira tickets branches off `master` | planning `base` result, or a ticket `base` | `bases.master {ref: master}`; the planner returns `base: {name: master, reason}` |
| A hotfix branches from the prod commit and its PR goes to `master` | `cmd` base with `pr_into` (B5 resolver) + ticket `base` | `bases.hotfix {cmd: az …, pr_into: master}`, ticket `base: hotfix` |
| `resync_main` / repo checks say `origin/main` | `$base` substitution | `instructions.resync_main`, the merge check (B2 for repo checks) |

### Implementation tickets

| # | Ticket | Acceptance | Depends on |
|---|---|---|---|
| B1 | Schema, validator, columns, docs, all "not available yet" | Each rule has a passing and a failing case; v1–v6 validate unchanged; v7 validates with `allowUnavailable` | none |
| B2 | Resolve and use the base: claim / start resolves it, records `session.base_ref`, the daemon cuts the worktree from it, `open_pr` targets `pr_into` / the base branch, `$base` substitution (repo checks too); mark `bases` available | A ticket with `base: master` gets a worktree from `origin/master` and a PR into `master`; a sha base without `pr_into` ends at a human | B1 |
| B3 | UI: base on the ticket form and card, `base_ref` on the card and detail, validator warnings on save | The board shows where each branch started | B2 |
| B4 | Live config: save v7 (with the work repos' real sprint command) | `get_workflow` shows `bases` | B2 |
| B5 | Prod-commit resolver for `hotfix` (Azure, run with the work laptop's skills) | `hotfix` resolves to the commit in production | B2 |

## Alternatives considered

| Option | Why not |
|---|---|
| A `branch_from` field per transition or state | The base is a property of the ticket's whole run, not of a move; a per-state field would let two states disagree. |
| Hard-code "sprint branch" / "hotfix" in the engine | It is Ben's process, not conductor's. ADR-0037's principle: general primitives, configured rules. |
| Resolve `cmd` bases on the orchestrator | It has no checkout, and no `az` login. The claiming machine has both. |
| `$base` refused only when no default branch is known | The definition can't know it. An explicit `bases` keeps rule 27 decidable on save. |

## Consequences

- Two nullable jsonb columns (`ticket.base`, `session.base_ref`, migration `1764000000000_ticket-base`); existing rows have neither.
- `validateWorkflow` has a warnings channel. That is the first one. From B3 the save routes return it (`SaveWorkflowResponse.warnings`, MCP `save_workflow`), and the editor shows it after a save and in the Bases section.
- `$base` and `$base_sha` become reserved spellings in the substitution sites, once B2 lands.

## Revisit when

- A repo needs a base per repo rather than per kind. Repo checks (ADR-0030) are the precedent for a per-repo override.
- A capability other than `az` is needed by a `cmd` base. Then `cmdBaseCapability` becomes a declared field instead of a sniff.
