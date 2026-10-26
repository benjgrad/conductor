# M2 · Accounts & machines

> **Outline.** The detailed task breakdown is written when M1b is near done, and Ben approves it before work starts. The task table below is a first cut: IDs, dependencies and groups will change.

**Goal**: conductor runs hosted, over HTTPS, for several people.
- **Accounts** ([ADR-0012](../../adr/0012-hosted-multi-user-github-sign-in.md)): each person signs in with GitHub, and sees and acts only on their own account's tickets, workflows and machines.
- **Machines** ([ADR-0013](../../adr/0013-machine-enrollment-inventory-routing.md)):
  - they enroll with a one-time token, authenticate with a revocable credential, and report their repos and capabilities;
  - they only receive tickets they can finish;
  - sessions run in worktrees off the user's own checkout;
  - a machine that stops responding hands its sessions to a human.

**Exit criteria**:
- A hosted instance (Ben's chosen platform, U-057) serves the board at an HTTPS URL; Ben signs in with GitHub; an allow-listed second GitHub user signs in and sees an empty board.
- The isolation tests pass: the schema test, the route-matrix test generated from `API_PATHS`, the gateway test and the unscoped-query lint ([ADR-0012](../../adr/0012-hosted-multi-user-github-sign-in.md) §Proving isolation).
- Ben enrolls his Mac with the copy-paste `npx` command from the Machines page, following `docs/setup/add-a-machine.md` alone; the page shows its repos and capabilities; revoking it disconnects it within 5 s.
- A ticket for a repo only machine B has is claimed by B, never by A; a ticket needing `az` waits with a "needs a machine with az" badge until a machine with `az` authed connects.
- A session runs in `<root>/wt/<session>` created from the user's checkout of the repo; the ADR-0010 fresh-checkout and private-push e2e assertions still hold; a change to the checkout's `.git/hooks` during a session raises the tamper warning.
- E2E (local mode for the stack, a test auth provider for two accounts): two fake machines in two accounts, routed by repo and capability, isolated; a laptop-sleep scenario (lease lapse → Needs input; reconnect in time → nothing).
- Existing data is migrated into Ben's account (U-056) on his database, after his sign-off.

**Not in M2**:
- shared/team accounts, invitations, moving machines between accounts (U-051);
- a second orchestrator instance;
- RLS (the backstop, ADR-0012);
- the MCP server (M3);
- triage and chat (M4);
- connectors beyond `gh` (M5);
- cross-machine resume (U-011/U-012);
- the OS sandbox (U-004);
- releasing machine slots for parked sessions.

**Blocking unknowns**:
- [U-008](../../tracking/UNKNOWNS.md): resolved by ADR-0012/0013 when accepted.
- Proposed: U-051 (tenancy edge cases), U-056 (migrating existing data), U-057 (hosting platform and domain), U-060 (worktrees off the user's checkout vs reference clones), U-067 (publishing `@conductor/daemon` to npm), U-068 (lost sessions go to a human).
- U-014 (subscription limits) matters once several machines share one person's subscription; not blocking.

## Task board (first cut)

| ID | Task | Depends on | Parallel group | Status |
|---|---|---|---|---|
| M2-T01 | **Contracts**: `AccountScope`; account/user/web_session/enrollment/credential/capability row types; WS upgrade auth and the `inventory` message (replacing `repo_inventory`, dropping `register.enrollment_token`); auth and machine REST DTOs; `requiredCapabilities(def, kind)` signature | M1b done | A | todo |
| M2-T02 | Migrations: account tables; `account_id` on every table with a backfill into a `local` account; `workflow_definition` key change; `machine_credential`, `enrollment_token`, `machine_capability`; `machine_repo` columns | T01, U-056 | B | todo |
| M2-T03 | GitHub OAuth login, session cookies, logout, allow-list; `CONDUCTOR_AUTH=github|local`; the hosted security changes ([ADR-0012](../../adr/0012-hosted-multi-user-github-sign-in.md) table; pays TD-069/TD-070) | T01 | B | todo |
| M2-T04 | Daemon: `enroll` command, credential store, authenticated WS; inventory scanner (repos, skills/agents, MCP names, CLIs + auth, claude version); periodic report | T01 | B | todo |
| M2-T05 | Web: sign-in page, account menu, Machines page (Add a machine with the token command, list, rename, revoke, inventory view) | T01 | B | todo |
| M2-T06 | Scoping: API + SSE (every repository takes `AccountScope`; per-account buses); the route-matrix and SSE isolation tests; the unscoped-query lint | T02, T03 | C | todo |
| M2-T07 | Scoping: gateway, claim, dispatcher, engine service; the enrollment endpoint and credential check on WS upgrade; revoke; the gateway isolation test | T02, T04 | C | todo |
| M2-T08 | Per-account `conductor`: seed on account creation, the ADR-0011 upgrade rule per account; `required_capabilities` computed on save | T02 | C | todo |
| M2-T09 | Routing: claim filters on `machine_repo` and capabilities; "no machine has …" badges on Queued cards; ticket create flags unknown repos (U-048) | T07, T08 | D | todo |
| M2-T10 | Worktrees off the user's checkout: replace the shared clone in `workspace.ts`; push URL from the inventory; worktree GC; the `.git` tamper check; 07 rewritten | T04 | C | todo |
| M2-T11 | Leases and reaper: lease expiry → `lost` → Needs input ("<machine> stopped responding"); revoke uses the same path; TD-088 revisited | T07 | D | todo |
| M2-T12 | Deployment: production config (`CONDUCTOR_PUBLIC_URL`, trusted proxy, `wss`), health endpoint, migration release step, deploy runbook in `docs/setup/`; the actual deploy is Ben's (U-057) | T03, T06 | D | todo |
| M2-T13 | Setup guide `docs/setup/add-a-machine.md`; the `@conductor/daemon` package's bin and `npx` path (publishing is Ben's, U-067) | T04, T05 | D | todo |
| M2-T14 | E2E: two accounts × two fake machines; routing by repo and capability; isolation; laptop sleep; the M1/M1b scenarios in local mode | all | E | todo |

Likely splits when detailed: T02 (one migration per concern), T06 (API vs SSE), T07 (gateway vs claim).
