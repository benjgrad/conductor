# ADR-0013 · Machines enroll once, report what they have, and get only the tickets they can do; sessions run off the user's own checkout

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M2)
- **Amended**: by the [U-060](../tracking/UNKNOWNS.md) resolution (2026-10-26, Ben): sessions run in worktrees of a daemon **reference clone** by default, and off the user's own checkout only when opted in per repo (with the tamper check); and by [ADR-0017](0017-own-sign-in-and-self-hosting.md) §Daemon distribution: enrollment uses `curl -fsSL https://<host>/install.sh | sh -s -- --token <token>` (no npm package, U-067 superseded), and the credential lives in `~/.conductor/machine.json`. Implemented by [M2](../plan/milestones/M2-accounts-machines.md).
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26)
- **Resolves**: the machine half of [U-008](../tracking/UNKNOWNS.md) (TD-059); [U-030](../tracking/UNKNOWNS.md) (repo → clone URL, stale base) and [U-048](../tracking/UNKNOWNS.md) (a ticket for a repo no machine can work), by replacing daemon-owned clones.
- **Amends**:
  - [ADR-0001](0001-pull-scheduler.md) / [04](../design/04-scheduler.md): routing becomes a hard filter on repo and capabilities; the short hold is dropped;
  - [07](../design/07-multi-session-isolation.md) §Code: no daemon-owned shared clone;
  - [ADR-0010](0010-one-workflow-columns-are-states.md)'s push URL source, and [ADR-0008](0008-transcript-history-and-reopen.md)'s worktree location (details below).

## Context
In M1 the daemon is started by hand with a machine id, `register` carries an `enrollment_token` nobody checks (TD-059), and the daemon clones each ticket's repo into `<root>/repos` on first use, over https without auth, never fetching again (U-030). Any machine may claim any ticket.

Once hosted ([ADR-0012](0012-hosted-multi-user-github-sign-in.md)), a machine must prove which account it belongs to. Ben also wants (2026-10-26):
- a clear "add a machine" path with setup instructions;
- each machine to report its repos (with their paths), skills, agents and MCP tools;
- that report to decide which machine takes which ticket;
- sessions to work from the checkouts the user already has, not from fresh clones.

## Decision
**A machine enrolls once with a one-time token and gets a long-lived, revocable credential. It reports an inventory of repos and capabilities, never secrets. A ticket is offered only to machines of its account that have its repo and every capability its workflow's transitions need. Sessions run in worktrees created from the user's own checkout of that repo.**

### Enrollment
1. On **Add a machine** the web app creates an `enrollment_token` row: 128-bit random, stored hashed, single use, 30-minute expiry, scoped to the account. It shows the token once, inside a command:
   `npx @conductor/daemon enroll --url https://<host> --token <token>`
2. `enroll` calls `POST /api/machines/enroll {token, hostname, os, arch}` over HTTPS. The server consumes the token in one transaction, creates the `machine` row (`account_id`, a server-generated id) and a `machine_credential` (256-bit random, stored hashed, `revoked_at null`), and returns `{machine_id, credential}` once.
3. The daemon stores them in `~/.config/conductor/machine.json` (mode 0600, directory 0700, lstat- and owner-checked like the private repos in ADR-0010). `CONDUCTOR_MACHINE_ID` and the M1 `enrollment_token: null` path exist only in local mode.
4. **Every WS connection** sends `Authorization: Bearer <credential>` on the upgrade. The gateway resolves the machine and account before accepting the socket. `register.enrollment_token` is removed from the protocol. A revoked or unknown credential is 401 at the upgrade.
5. **Machines page**: list (name, status, last seen, claude version, repo count), rename, and **revoke**. Revoking sets `revoked_at`, closes the socket (4001), and treats the machine's live sessions like a lost lease: each goes to a human (below). Re-enrolling the same computer creates a new machine.
6. **Setup guide** (`docs/setup/add-a-machine.md`, linked from the page): Node 22; `claude` installed and logged in; `gh auth login`; optional `az login` and a Jira CLI or MCP; choosing repo roots (`conductor-daemon config --roots ~/code`); running the daemon at login (launchd / systemd user unit); what is reported and what is never reported.

### Inventory
Reported in `register` and again whenever it changes (a rescan every 10 minutes and on `SIGHUP`), as `inventory {repos, capabilities}`. It replaces `repo_inventory`.
- **Repos**: for each git work tree under the configured roots (depth ≤ 4, no symlink following, `node_modules` and dot-directories skipped): `path`, `remote` (the `origin` fetch URL canonicalised to `host/org/repo`, the M1-T14 grammar), `default_branch` (`origin/HEAD`, else `main`/`master`), `head_commit`. Repos without a GitHub/allowed-host remote are reported with `remote: null` and can't be routed to. Stored in `machine_repo (machine_id, account_id, repo, path, default_branch, head_commit, updated_at)`; `tree_clean` is dropped.
- **Capabilities**, stored in `machine_capability (machine_id, account_id, kind, name, detail jsonb, updated_at)`:
  - `cli`: `gh`, `az`, `jira`, `git`, with `version` and `authed: true|false` from a read-only probe (`gh auth status`, `az account show`, …). Never the account names or tokens;
  - `mcp`: server **names** from the user's Claude Code config (user scope and plugins). Never the command, args, env or URL;
  - `skill` and `agent`: names from `~/.claude/skills` and `~/.claude/agents`, plus each repo's `.claude/skills|agents` names under that repo;
  - `claude`: the CLI version (already `machine.claude_code_version`).
- The scanner reads file names and `--version` / auth-status output only. It runs no repo code and loads no repo settings.

### Routing
- **A ticket names its repo by remote** (`host/org/repo`). Creating a ticket for a repo that no machine of the account has is allowed but flagged: the card shows "no machine has <repo>", which answers U-048 at creation instead of at claim time.
- **Required capabilities** come from the pinned workflow version and the ticket's kind: `requiredCapabilities(def, kind)` (pure, in `shared`) collects what every transition the ticket could take needs, e.g. `cli:gh authed` for `open_pr` or `pr_checks_green`, `cli:az authed` for `azure_pipeline_succeeded`, `mcp:slack` for `slack_message` (the connector registry in [ADR-0016](0016-work-connectors-on-the-users-machine.md) maps each condition and action to its capability). It is computed when a workflow version is saved and stored with it, per kind (`workflow_definition.required_capabilities {work: [...], personal: [...]}`), so the claim's SQL can read it for the latest version or the pinned one.
- **The claim** gains two hard filters: `EXISTS machine_repo (this machine, ticket.repo)`, and every required capability present on this machine. Priority and age order the rest. The short hold ([04](../design/04-scheduler.md) §3) is dropped: a machine without the repo can no longer take the ticket at all.
- A ticket no online machine can take stays in Queued with a badge naming what is missing ("needs a machine with `org/app` and `az`").
- **Amendment 2026-10-30 (Ben approved; repo rules).** Having a checkout isn't the same as being able to run it: the work laptop alone has IIS, the local databases and the hosts file. So each machine also carries two rules, kept on the orchestrator (not in the daemon's config: the TS daemon is frozen and the Rust inventory not ported, ADR-0026) and edited from the Machines drawer: `repo_allow` (the repo patterns it may take; null = any) and `repo_exclusive` (patterns only it takes; every other unrevoked machine of the account skips them, **even while it is offline**, so those tickets wait in Queued). A pattern is `host/org/repo` or `host/org/*`. The claim applies both as hard filters; the badge says "only <machine> takes this repo". Details: [10 "Matching"](../design/10-contracts.md#machines-protocol-v2), [04 §2](../design/04-scheduler.md#2--claim-query-ticket-side).

### Sessions run in worktrees off the user's own checkout
- `start_session` carries the `machine_repo.path` the claim matched. The daemon re-checks that path against its own inventory (never trusting a path from the message), then:
  `git -C <checkout> -c core.hooksPath=/dev/null fetch origin <default_branch>` and
  `git -C <checkout> -c core.hooksPath=/dev/null worktree add <root>/wt/<session> -b conductor/<ticket>/<short> origin/<default_branch>`.
  The worktree stays under the daemon's root, outside the user's checkout. The base is always the remote default branch, never the user's current branch or uncommitted files.
- **What this changes:**
  - **[07](../design/07-multi-session-isolation.md)**: no shared clone, no `<root>/repos`, no first-use clone; `tree_clean` is meaningless. Worktree GC uses `git worktree remove` + `prune` against the user's checkout.
  - **[ADR-0010](0010-one-workflow-columns-are-states.md) fresh checkout**: unchanged; the checks fetch from the session worktree into an ephemeral private repo, as now.
  - **ADR-0010 private push**: unchanged, except that the push URL comes from the **inventory's remote**, recorded in the daemon's store at scan time and re-checked against `ticket.repo`. It is still never read from the checkout's config at push time.
  - **[ADR-0008](0008-transcript-history-and-reopen.md) transcripts**: unchanged; the cwd is still `<root>/wt/<session>`.
  - **ADR-0008 reopen pin**: unchanged in effect. It still pins to the machine that ran the branch, and the worktree is still found with `git worktree list`, now run in the user's checkout.
- **The cost (U-060).** The worktree's git directory lives inside the user's checkout (`.git/worktrees/<name>`), and it shares that checkout's `config` and `hooks/`. With the agent's unconfined Bash (U-004, TD-083) an agent can plant a hook or a config change that later runs when **the user** works in their own repo. Daemon-owned clones kept that inside conductor. Mitigations in M2:
  - daemon git runs with hooks off and `GIT_CONFIG_NOSYSTEM`;
  - the daemon hashes the checkout's `.git/config`, `.git/hooks/` and `core.hooksPath` target before each session and after it ends; any change becomes a red card warning and a machine-page alert, listing the changed files.

  The sandbox (U-004) is the real fix.

### Overlap with the old M2 "Fleet" scope
| Old M2 item | Now |
|---|---|
| ≥ 2 machines, pull claim | M2, with the routing filters above |
| Short hold | Dropped: the hard repo filter removes the case it softened |
| Daemon enrollment tokens | This ADR (M2) |
| Leases, heartbeats, fencing, reaper | M2. A lost lease puts the session in Needs input ("<machine> stopped responding"), not an automatic requeue, because the work and the transcript live on that machine (U-068; U-011/U-012 stay open) |
| Daemon disk buffer + seq replay | Already in M1 (TD-025 bound) |
| Laptop-sleep chaos test | M2, as an e2e: kill the fake machine's socket, let the lease lapse, expect a human question; reconnect before the lapse, expect nothing |

## Alternatives considered
| Option | Why not |
|---|---|
| Keep daemon-owned clones | Multi-minute clones, a second copy per repo, a stale base (U-030), and auth to set up for every private repo. Ben chose the user's own checkout |
| A daemon clone borrowing objects from the user's checkout (`clone --reference`) | Keeps the user's `.git` untouched, but adds a clone per repo to keep fetched. Recorded as the fallback if U-060's detection fires in practice |
| Long-lived enrollment tokens typed into config | A leaked token enrolls forever; one-time tokens plus revocable credentials keep the leak window to 30 minutes |
| mTLS for daemons | Certificate issuance and rotation for laptops; a bearer credential over TLS gives the same assurance at this scale |
| Report MCP server configs | They hold secrets. Names are all routing needs |
| Score repo locality instead of filtering | With checkouts owned by the user there is no clone path to fall back on; the ticket can only run where the repo is |

## Consequences
- **Good:**
  - machines are authenticated and revocable, which closes TD-059;
  - tickets go only where they can finish;
  - no clone waits, and the base branch is fresh at every session start;
  - the inventory UI shows each user what conductor can use.
- **Bad / accepted cost:**
  - conductor writes into the user's checkout (worktree metadata, `conductor/*` branches, fetched refs);
  - an agent can tamper with the user's `.git` (U-060; detected, not prevented);
  - a ticket can wait forever for a machine that has its repo (shown on the card);
  - protocol changes: `register` loses `enrollment_token`, and `inventory` replaces `repo_inventory`.
- **Follow-ups:** M2 tasks; U-060, U-067 (publishing `@conductor/daemon` to npm), U-068 (lost sessions). [ADR-0016](0016-work-connectors-on-the-users-machine.md) owns the capability names.

## Revisit when
U-060's detection fires on a real machine (switch to reference clones), a team needs to share machines across accounts (U-051), or the sandbox lands (U-004).
