# M2 · Accounts, machines & hosting (own sign-in, gradyserver)

> **Approved by Ben 2026-10-26.** Deploy at the end (M2-T25), no early deploy. U-073: the server DB starts fresh. U-074: backups stay on the server, 14 days. U-075: the local board stays pinned to the M1b build (2e88cf8) with its own DB for all of M2 and moves to the hosted instance at T25. U-070 is out of M2.

> **Plan update 2026-10-27** (lead alignments after T01/T02 merged, 37df567; branch `docs/m2-plan-update-deps`): T06 moves to group C (after T03); T11 waits for T10 (gh floor); T17 waits for T14; follow-ups from dogfooding placed in T10, T11, T13 and a new M2-T26 (Retry for a failed move step). Where a block and [10-contracts](../../design/10-contracts.md) §Machines protocol v2 disagree, **10-contracts wins**.

**Goal**: conductor runs hosted at **https://conductor.gradyserver.com** for several people, each seeing only their own account, with their machines enrolled by one command.
- **Sign-in** ([ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md)): conductor's own email + password sign-in (argon2id, server-side sessions in an httpOnly cookie), invite-only sign-up, admin-made reset links, a bootstrap admin who claims the existing data.
- **Accounts** ([ADR-0012](../../adr/0012-hosted-multi-user-github-sign-in.md) §Tenancy and §Proving isolation, still in force): every row, query, stream and socket is scoped to an account, proved by four isolation tests. Personal accounts only (U-051).
- **Machines** ([ADR-0013](../../adr/0013-machine-enrollment-inventory-routing.md), amended by U-060 and ADR-0017):
  - enroll with `curl -fsSL https://conductor.gradyserver.com/install.sh | sh -s -- --token <one-time>`, which installs the daemon tarball the orchestrator serves and gets a revocable credential;
  - report their repos and capabilities, and only receive tickets whose repo and required capabilities they have;
  - run sessions in worktrees of a **daemon reference clone** by default, or of the user's own checkout when opted in per repo (with the `.git` tamper check);
  - a machine that stops responding, or is revoked, hands its sessions to a human (U-068).
- **Hosting** (ADR-0017 §Hosting topology): one Docker Compose stack (orchestrator + Postgres 16) on gradyserver, published on `127.0.0.1`, behind the host's nginx and Let's Encrypt cert, with nightly `pg_dump` backups.

**Exit criteria**:
- Every task below is `done` and passed QA ([QA_CHECKLIST](../../qa/QA_CHECKLIST.md)).
- The four isolation tests pass (ADR-0012 §Proving isolation): the schema test (M2-T03), the route-matrix and SSE test generated from `API_PATHS` (M2-T21), the gateway test (M2-T16/T19), and the unscoped-query lint (M2-T21). The temporary `account_id` defaults are gone (M2-T21).
- `pnpm test:e2e` is green with the M2 scenarios (M2-T22, M2-T24: two accounts × two fake machines in `password` mode, routing by repo and capability, isolation, laptop sleep, revoke) and every M1 / M1b scenario still green in `local` mode.
- **Hosted**: `https://conductor.gradyserver.com` serves the board with a valid certificate, HSTS and the ADR-0017 headers; `deploy/gradyserver/smoke.sh` passes against it.
  - Ben runs `conductor-admin bootstrap`, signs up through the printed link, and owns the `local` account (empty on the server: it starts fresh, U-073).
  - Ben invites a second user, who signs up and sees an empty board with their own `conductor` workflow. Sign-up without an invite is refused. Ten bad passwords lock the email (smoke script).
- Ben enrolls his Mac with the one-line command from the Machines page, following `docs/setup/add-a-machine.md` alone (optionally `--service`). The page shows its repos and capabilities. Revoking it disconnects it within 5 s, and a live session goes to Needs input.
- A ticket for a repo only machine B has is claimed by B, never by A; a ticket needing `az` waits with "needs a machine with az" until a machine with `az` authed connects (e2e).
- A session runs in `<root>/wt/<session>` from a reference clone; the user's checkout's `.git` is byte-for-byte unchanged afterwards (test). A repo set to `checkout` mode runs off the user's checkout, and a hook planted during the session raises the tamper warning. The ADR-0010 fresh-checkout and private-push e2e assertions still hold.
- One real dogfood ticket runs end to end on the hosted instance through Ben's Mac and opens a PR on github.com/benjgrad/conductor.
- A nightly backup exists on the server and one restore into a scratch database has been done (runbook).
- Each migration was approved by Ben before merge and applied to the server database at deploy (and to his local database if he chooses).
- Design docs describe what was built (M2-T23); Ben accepts ADR-0012 and ADR-0013 and signs off M2.

**Not in M2**:
- passkeys, outbound email, email verification, self-service password reset, open sign-up (ADR-0017);
- team / shared accounts, several accounts per user, moving machines between accounts, account deletion (U-051);
- a second orchestrator instance; RLS (ADR-0012's backstop);
- the MCP server and OAuth (M3); triage and chat (M4); connectors beyond `gh` (M5);
- cross-machine resume (U-011/U-012): a lost session goes to a human and resumes on the same machine;
- the OS sandbox (U-004); a Windows daemon (U-071); fixed-path runtimes such as IIS (U-070);
- a Node runtime bundled with the daemon; tarball signatures beyond SHA-256 over TLS;
- off-host backups (U-074), unless Ben decides otherwise;
- budgets (U-014); releasing machine slots for parked sessions.

**Blocking unknowns**: none open. Resolved for this plan (2026-10-26):
- U-057 hosting → ADR-0017 (gradyserver, Compose, host nginx);
- U-067 npm publish → superseded by ADR-0017 §Daemon distribution;
- U-051 → personal accounts only through M2;
- U-056 → existing rows go into the `local` account, claimed by the bootstrap admin;
- U-068 → a lost lease or a revoked machine sends the session to a human;
- U-060 (earlier) → a daemon reference clone by default, the user's checkout opt-in per repo.

Not blocking, with the default the plan assumes:
- U-008: web half decided by ADR-0017; machine half by ADR-0013, closed when M2-T09/T17 merge;
- U-048: ADR-0013's answer, a ticket for a repo no machine has is allowed and flagged; the API validates the repo grammar (M2-T17). Ben approves it with the T01 contracts;
- U-014: not blocking (one person's machines share one subscription, as today);
- **U-073**: resolved (Ben, 2026-10-26): the server's database starts fresh;
- **U-074**: resolved (Ben, 2026-10-26): backups stay on the server, kept 14 days;
- **U-075**: resolved (Ben, 2026-10-26): Ben's local board stays pinned to the M1b build (2e88cf8) with its own database for all of M2, and dogfooding moves to the hosted instance at M2-T25.

## How M2 is run (dogfooding)
Each task block below is pasted as the description of a ticket on Ben's conductor board (repo `github.com/benjgrad/conductor`, kind `personal`). The agent works on branch `m2-tNN-<slug>`, ends by opening a PR, and puts its report (new unknowns, tech debt, unfinished items, contract changes it needed) in the PR description. The lead QAs the branch with the `qa-reviewer` checklist, records tracking rows, and merges with `--no-ff`. So every block is self-contained: scope, design refs as paths, files owned, do-not-touch, acceptance with test names and commands, and gates.

Rules for every M2 ticket (copy with the block):
- Do not edit `docs/tracking/*`. Report instead.
- Code against the T01/T02 contracts and their fakes. A needed contract change is reported in the PR, never made locally.
- A shortcut needs a `// TD: <what>` comment at the site and a line in the PR report (the lead assigns the TD number).
- A migration is never merged without Ben's approval; tasks marked **Migration: yes** stop at "PR open, awaiting Ben".
- Standard gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (DB tests need `pnpm db:up`). `pnpm test:e2e` where the block says so.

## Task board

Status values: `todo` · `in_progress` · `in_review` (QA) · `done` · `blocked` (link B-###).

| ID | Task | Depends on | Group | Migration | Status |
|---|---|---|---|---|---|
| M2-T01 | **Contracts (web)**: auth, admin and machines REST DTOs, `API_PATHS`, error codes, `AccountScope`, card routing and tamper fields | M1b done | A | — | done |
| M2-T02 | **Contracts (machines)**: daemon protocol v2 (credential on upgrade, register versions, `inventory`, `alert`), inventory and capability schemas, `requiredCapabilities` signature, `machine.lost` engine event | M1b done | A | — | done |
| M2-T03 | Tenancy + auth schema, `local` backfill, schema isolation test | T01, T02 | B | **yes** | done |
| M2-T04 | Daemon: `enroll`, credential file, authenticated WebSocket, register v2 | T02 | B | — | done |
| M2-T05 | Web: sign-in, sign-up, reset, account menu, admin page | T01 | B | — | done |
| M2-T06 | Shared: `requiredCapabilities` + capability registry; the engine handles `machine.lost` | T02, T03 | C | — | done |
| M2-T07 | Deploy kit: Dockerfile, compose, nginx site, sudo script, deploy / backup / smoke scripts, runbook | T01 | B | — | done |
| M2-T07b | Deploy kit follow-up: `.env` generation fails loudly (pays TD-144) | T07 | D | — | in_progress |
| M2-T08 | Orchestrator auth core: passwords, sessions, login / logout / me / password change, throttling and lockout, hosted security mode | T01, T03 | C | — | done |
| M2-T08b | Change-password follow-up: a wrong `current` counts against the email lockout (`login_throttle`) | T08 | C | — | done |
| M2-T09 | Orchestrator machines: credential and enrollment tables, `enrollMachine`, WS upgrade auth, `revokeMachine` | T02, T03 | C | **yes** | done |
| M2-T09b | Revoke race follow-up: a revoked machine processes nothing more (frames already sent are dropped) | T09 | C | — | done |
| M2-T10 | Daemon: inventory scanner and reports; `config` command (roots, per-repo mode); gh version floor | T04 | C | — | done |
| M2-T10b | Capability names follow-up: one shared name rule, plugin MCP normalisation, invalid names logged | T10 | C | — | done |
| M2-T11 | Web: Machines page, Queued routing badge, tamper alerts, outdated-gh flag | T05, T10 | D | — | todo |
| M2-T12 | Orchestrator: per-account workflows (key change, `required_capabilities` on save, `seedAccount`, per-account upgrade rule) | T03, T06, T08 | D | **yes** | todo |
| M2-T13 | Daemon: working copies (reference clone default, checkout opt-in), push URL from the inventory, GC, tamper check; push credentials via gh | T10 | D | — | todo |
| M2-T14 | Orchestrator: daemon distribution (`/install.sh`, tarball, `/healthz`) and the Dockerfile's tarball stage | T07, T08 | D | — | in_progress |
| M2-T15 | Orchestrator: invites, sign-up, resets, admin routes, `conductor-admin` CLI (bootstrap claims `local`) | T08, T09, T12 | E | — | split → T15a, T15b |
| M2-T15a | Orchestrator: bootstrap admin, `conductor-admin` CLI, reset links (the you-only deploy slice of T15) | T08, T09 | E | — | todo |
| M2-T15b | Orchestrator: invites, sign-up into new accounts, admin routes (the rest of T15) | T12, T15a | E | — | todo |
| M2-T16 | Orchestrator: inventory ingest, routing filters in the claim, routing badge, alert ingest; gateway isolation test | T06, T09, T12, T14 | E | — | todo |
| M2-T17 | Orchestrator: machines REST (enroll endpoint, enrollment tokens, list, rename, revoke); ticket repo check (U-048) | T08, T09, T14 | E | — | todo |
| M2-T18 | Daemon: `service install` (launchd / systemd user), upgrade-in-place, `conductor-launch` launcher, wake reconnect; `docs/setup/add-a-machine.md` | T04, T14 | E | — | in_progress |
| M2-T18b | **Contracts (auto-update)**: `update_available`, `heartbeat.draining`, `alert` kind `update_failed`, `latest.json` DTO, exit codes ([ADR-0021](../../adr/0021-daemon-auto-update.md)) | T02 | E | — | in_progress |
| M2-T18c | Daemon: self-update (stage, verify, drain, switch, exit 75), launcher trial + rollback, `config auto-update`, 4005 → latest.json | T18, T18b | F | — | todo |
| M2-T18d | Orchestrator: send `update_available` after register, `GET /downloads/latest.json`, `draining` heartbeat → `machine.status`, `update_failed` alert ingest | T14, T16, T17, T18b | F | — | todo |
| M2-T18e | Web: Machines page shows updating (draining) and update-failed alerts | T11, T18d | G | — | todo |
| M2-T19 | Orchestrator: engine and stream scoping (`applyEvent(scope, …)`, engine SQL, dispatcher, per-account buses, SSE replay filter) | T08, T09, T12, T16, T17 | F | — | todo |
| M2-T20 | Orchestrator: leases and the reaper (lapse → `machine.lost` → human); revoke reuses it; TD-088 | T06, T19 | G | — | todo |
| M2-T21 | Orchestrator: REST scoping, route-matrix and SSE isolation tests, unscoped-query lint, drop the temporary defaults | T15, T17, T19 | G | **yes** | todo |
| M2-T22 | E2E: password-mode harness, two accounts × two machines, routing, isolation; M1 / M1b in local mode; one daemon auto-update and one rollback | T13, T15, T16, T18, T18c, T18d, T20, T21 | H | — | todo |
| M2-T23 | Docs sweep: 00–10, ADR implementation notes, README "run hosted" | T21 | H | — | todo |
| M2-T24 | E2E: laptop sleep, lease lapse, revoke, reconnect | T22 | I | — | todo |
| M2-T25 | **Deploy** to conductor.gradyserver.com (lead + Ben's sudo script), bootstrap, enroll Ben's Mac, live checks, backup restore test | T22, T23, T24, T26 | J | — | todo |
| M2-T26 | Shared: **Retry** a failed move step (a `$retry` human transition that re-runs the failed phase without an agent turn) | T06 | D | — | todo |
| M2-T13a | Daemon: **fetch per session** (split out of T13; pays TD-026's stale base) | T10 | D | — | in_review (PR #48, QA passed with debt TD-181; merge after #44) |
| M2-T27 | Daemon + shared: `update_branch` MCP tool (all states), planning `inspect` alias, denial counts on session events | T13a | E | — | todo |
| M2-T27b | Orchestrator + web: "Update from main" on an idle session (REST → daemon command → same action) | T27 | F | — | todo |
| M2-T28 | **Contracts (agent settings)**: `machine_settings`, settings REST, `settings_update`, `reported_settings` ([ADR-0022](../../adr/0022-layered-agent-settings.md), proposed) | — | D | — | todo |
| M2-T28b | Shared: `resolveEffectivePolicy` + invariants, settings schemas | T28 | E | — | todo |
| M2-T28c | Orchestrator: `machine_settings` migration, settings routes, audit, push on connect / change | T28b | F | **yes** | todo |
| M2-T28d | Daemon: apply pushed override (ceiling `remote_settings`), report `reported_settings` (pays TD-081) | T28b, T13a, T29b | F | — | todo |
| M2-T28e | Web: Machines drawer **Settings** tab (effective policy per state, override editor) | T28c | G | — | todo |
| M2-T29 | **Contracts (permission prompts)**: `permission_request` / `permission_decision`, `needs_permission`, REST ([ADR-0023](../../adr/0023-permission-prompts-through-conductor.md)) | — | D | — | in_review (PR #47, QA passed with debt TD-178..180; merge after #44) |
| M2-T29b | Daemon: auto mode default, `--permission-prompts host` + `permission` MCP tool held until decision / timeout | T29 | E | — | todo |
| M2-T29c | Orchestrator: store requests, `needs_permission` on the board, decision route → daemon | T29 | E | **yes** | todo |
| M2-T29d | Web: Needs-permission card state with Allow once / Allow always / Deny | T29c | F | — | todo |
| M2-T30 | Daemon + shared: package-manager-aware build checks (pnpm / yarn lockfiles) and pnpm rules in the `bash` alias | — | D | — | done |

**Follow-ups and splits (2026-10-27).** T08b, T09b and T10b came from post-merge QA of T08 (PR #16), T09 (PR #13) and T10 (PR #14) and merged as PR #21 (merge 32e6bb8), PR #17 (merge 881708e) and PR #19 (merge 74abf5f). T07b pays TD-144 and must land before T25's first deploy. Ben chose an early you-only deploy, so T15 is split: **T15a** (bootstrap, CLI, resets; critical path) and **T15b** (invites, sign-up, admin routes; after T12). Critical path for the you-only deploy: T09b, T08b, T14, T15a, T17, T07b. No second account until T16, T19 and T21 (TD-149). Deploy T09 and T17 together: after T09, password-mode gateways refuse every uncredentialed daemon and only T17 adds enrollment. Post-merge QA ran for T06 (OK, every item verified on main), T10 (follow-ups done as T10b) and T09b (security QA passed, 6 attack probes). T20 must settle U-084 (lease renewal for sessions parked in event states) before it starts.

Groups run in order A → J. Tasks within a group own disjoint files and can run in parallel. The longest chain is A → B → C → D → E → F → G → H → I → J; the daemon lane (T04 → T10 → T13 → T18) and the web lane (T05 → T11, T11 after T10 for the gh floor) run beside it. The shared-engine lane is T06 (C) → T26 (D); nothing else edits `shared/src/engine/apply.ts` in M2.

**Migrations** (each needs Ben's approval before merge): T03 (tenancy + auth tables, `account_id` everywhere with a temporary default), T09 (machine credentials, enrollment tokens, capabilities, `machine_repo` columns), T12 (`workflow_definition` key and `required_capabilities`), T21 (drop the temporary defaults). T02 chose a new `input_request_kind` value `machine_lost` (10-contracts §Machines protocol v2), so T03's migration adds it.

**Shared files with section ownership** (several tasks touch them, in different groups unless noted):
- `packages/shared/src/index.ts`: T01 and T02 each add one export line (same group; trivial merge).
- `docs/design/10-contracts.md`: T01 owns a new §Accounts and web auth; T02 owns a new §Machines protocol v2. Both add rows to §REST error map only in their own new sections.
- `packages/orchestrator/src/db/types.ts`: T03 (tenancy/auth rows) → T09 (machine rows) → T12 (workflow rows), in that order.
- `packages/orchestrator/src/api/index.ts`: T08 (security hook and auth plugin registration), T12 (workflow save handler), T17 (machines routes registration and ticket create), T19 (two `applyEvent` call sites), T21 (everything).
- `packages/orchestrator/src/gateway/index.ts`: T09 (upgrade and register), T16 (inventory and alert message cases), T19 (`applyEvent` call sites), T20 (heartbeat lease renewal, revoke hook).
- `packages/daemon/src/daemon.ts`: T04 (connect and register), T10 (inventory reports), T13 (start_session working copy), T18 (none, CLI only).
- `packages/daemon/src/actions/open-pr.ts`: T10 (the gh version check before `gh pr create`), then T13 (push URL source and the push credential helper).
- `packages/shared/src/engine/apply.ts`: T06 (`machine.lost`), then T26 (`$retry`).
- `humanTransitionsOfCard` in `packages/shared/src/api/rest.ts`: T06 (the `machine_lost` title and the revoked "no transitions"), then T26 (the Retry button).
- `packages/orchestrator/src/engine/service.ts`: T19 (scope), then T20 (`machine.lost` in the fencing-bump list).
- `packages/shared/src/machines/capabilities.ts`: T10 adds `GH_MIN_VERSION` and `cliVersionAtLeast` (additive; read by T11).

**Gates (Ben)**:
- before A: review ADR-0017 (accepted from his decisions) and this plan;
- after A: approve the 10-contracts diff (T01, T02), including the U-048 repo rule;
- before T03, T09, T12 and T21 merge: approve each migration;
- T25: read and run `sudo deploy/gradyserver/install-nginx-site.sh` on gradyserver; run `conductor-admin bootstrap` and sign up; enroll his Mac;
- at the end: accept ADR-0012 and ADR-0013, sign off M2.

### Out-of-plan work (2026-10-27)

Web UX and bug tickets run on the dogfood board beside M2 (not M2 tasks; they don't change M2's exit criteria).

| ID | Work | PR | State |
|---|---|---|---|
| UX-1 | Session thread: group tool calls, phase dividers, markdown fix | #8 | merged (c31f1bb) |
| UX-2 | Session Brief card: ticket requirements at the top, View prompt | #9 | merged (b898581) |
| UX-3 | Ticket editor: WYSIWYG (BlockNote) with the requirements template | #10 | merged (04303fb) |
| UX-3b | Board renderer: hard breaks and bold-italic from the editor | — | in_progress (ticket) |
| UX-4 | Board cards: review requests vs questions, clamped previews | #12 | merged (4c09499) |
| UX-5 | Show conductor checks progress instead of a phantom running agent | #20 | merged (a8deac3) |
| UX-6 | Collapsible check output; no internal state labels in the panel | — | in_progress (ticket) |
| BUG-1 | Parked agent process outlives its session (Done / cancel / supersede) | #18 | merged (f7e58a5) |
| BUG-1b | Orphan sweep must never kill a process that isn't provably ours | #22 | merged (8ad36d1) |
| BUG-2 | `apply.property` coverage assertion is flaky (unseeded fast-check) | #23 | merged (7ee5d4c) |
| TD-111 fix | `test(daemon)`: longer teardown retries in reopen-transcript (test-side; production fix still open) | #15 | merged (f6df4f1) |

---

## Task details

### M2-T01 · Contracts (web): auth, admin, machines REST, scope
- **Scope.** Freeze the web-facing seams. Only this task edits these schemas in M2 (later tasks report changes). In `packages/shared/src/api/`:
  - **`auth.ts`** (new): zod schemas and types for
    - `LoginRequest {email, password}`, `MeResponse {user: {id, email, display_name, is_admin}, account: {id, name}}`;
    - `SignupRequest {invite, email, display_name, password}`, `InvitePreview {valid, email?, expires_at}` (for `GET /auth/invites/:token`, which reveals nothing else);
    - `ResetRequest {token, password}`, `PasswordChangeRequest {current, new}`;
    - `PASSWORD_MIN = 12`, `PASSWORD_MAX = 256`, `passwordProblems(password, email): string[]` (pure, shared by web and server);
    - `safeNextPath(next: string | null): string` (same-origin path or `/`; ADR-0017 §`next` redirects).
  - **`admin.ts`** (new): `CreateInviteRequest {email?, days?: 1..30, admin?: boolean}`, `InviteCreated {id, url, expires_at}` (the only time the token is shown), `InviteRow {id, email, is_admin, created_at, expires_at, used_at, revoked_at}`, `AdminUserRow {id, email, display_name, is_admin, disabled_at, created_at, locked: boolean}`, `ResetLinkCreated {url, expires_at}`.
  - **`machines.ts`** (new): `EnrollRequest {token, hostname, os, arch, daemon_version}`, `EnrollResponse {machine_id, credential}`, `EnrollmentTokenCreated {token, command, expires_at}` (`command` is the full `curl … | sh -s -- --token …` line), `MachineRow` (name, status, last seen, daemon and claude versions, `outdated: boolean`, repo count, `revoked_at`), `MachineDetail` (repos with `remote`, `path`, `mode: 'reference' | 'checkout'`, `default_branch`; capabilities by kind; open alerts), `RenameMachineRequest {name}`.
  - **`rest.ts`**:
    - `API_PATHS` gains `authLogin '/auth/login'`, `authLogout`, `authMe '/api/me'`, `authSignup`, `authInvitePreview(token)`, `authReset`, `authPassword`, `adminInvites`, `adminInvite(id)`, `adminUsers`, `adminUserResetLink(id)`, `adminUserDisable(id)`, `adminUserUnlock(id)`, `machinesEnroll '/api/machines/enroll'`, `machineEnrollmentTokens`, `machine(id)`, `machineRevoke(id)`, `installScript '/install.sh'`, `healthz '/healthz'`. Every path the server serves is listed here (the route-matrix test is built from it).
    - `ApiErrorSchema` codes gain `unauthorized`, `forbidden`, `rate_limited`, `unsupported_media_type` (pays TD-070).
    - Board card DTO gains `routing?: {missing_repo?: string, missing_capabilities: string[]}` (Queued only) and `alerts?: {kind: 'git_tamper', files: string[], at}[]`.
    - `canonicalRepo(repo)` (pure): the canonical `host/org/repo` grammar (U-048, ADR-0013 §Routing). The schema itself stays permissive, because `local` mode keeps accepting the M1 local-path test repos the e2e uses; the server applies `canonicalRepo` in `password` mode (T17). The create response may carry `warnings: ['no_machine_has_repo']`.
  - **`packages/shared/src/domain.ts`**: `AccountScope {account_id: string, actor: {kind: 'user', user_id} | {kind: 'machine', machine_id} | {kind: 'system'}}`, `LOCAL_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001'`, `LOCAL_USER_ID = '00000000-0000-4000-8000-000000000002'` (a virtual user, no `app_user` row; `localMeResponse()` in `api/auth.ts`), `localScope(actor)`; `AuthMode = 'local' | 'password'`.
  - **Fixtures and fakes**: `shared/src/api/fixtures.ts` gains one valid example per new DTO; the web mock client (`packages/web/src/api/mock.ts`) is **not** touched here (T05/T11 extend it).
  - **10-contracts** §Accounts and web auth (new): the routes above with status codes (401 no session, 403 Origin / admin-only, 404 other account, 429 throttled), cookie names and the CSRF rule from ADR-0017.
- **Design refs**: [ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md) §Auth, §Invites; [ADR-0012](../../adr/0012-hosted-multi-user-github-sign-in.md) §Tenancy; [ADR-0013](../../adr/0013-machine-enrollment-inventory-routing.md) §Enrollment, §Routing; [03](../../design/03-protocols.md) §REST; [10](../../design/10-contracts.md) §REST error map.
- **Depends on**: M1b done.
- **Files owned**: `packages/shared/src/api/**`, `packages/shared/src/domain.ts`, one export line in `packages/shared/src/index.ts`, 10-contracts §Accounts and web auth.
- **Do not touch**: `shared/src/protocol/**`, `shared/src/engine/**`, `shared/src/workflow/**` (T02/T06), other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `packages/shared/src/api/auth.test.ts`: `passwordProblems` (too short, too long, equals email, 12 chars ok); `safeNextPath` refuses `//evil.com`, `https://x`, `/\\evil`, `javascript:` and returns `/` for null.
  - [ ] `packages/shared/src/api/machines.test.ts`, `admin.test.ts`: every fixture parses; a token-bearing DTO round-trips.
  - [ ] `cards.test.ts`: a card with `routing` and `alerts` parses; an old card without them parses.
  - [ ] A test lists every `API_PATHS` entry and fails if one is a duplicate or doesn't start with `/`.
  - [ ] Existing code still compiles and every existing test passes (additive changes only).
  - [ ] `canonicalRepo` tests: the scp-style SSH form (`git@github.com:org/app.git`), `https://github.com/org/app` and `github.com/org/app` → `github.com/org/app`; `ext::sh -c x`, `../x`, `/tmp/x`, `file:///x` → null.
  - [ ] An interface-review agent confirms T05, T08, T11, T15, T17 and T21 can be built from these contracts alone.
  - [ ] Ben approves the 10-contracts diff.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- **Note**: mostly schemas and fixtures, ~450 lines. If the review asks for more, split the machines DTOs into a T01b in group A.

### M2-T02 · Contracts (machines): protocol v2, inventory, capabilities, lost machine
- **Scope.**
  - **`packages/shared/src/protocol/ws.ts`**:
    - `PROTOCOL_VERSION = 2`; `register` gains `protocol_version` and `daemon_version`; `register.enrollment_token` becomes optional and is documented as "local mode only, ignored" (the field is removed in T21's cleanup, not here);
    - the upgrade request carries `Authorization: Bearer <credential>` (documented constant `DAEMON_AUTH_HEADER`); close codes `CLOSE_REVOKED = 4001`, `CLOSE_UNAUTHORIZED = 4003`, `CLOSE_PROTOCOL = 4005` with reason text;
    - `inventory {repos: InventoryRepo[], capabilities: Capability[], hash}` (daemon → orchestrator), alongside `repo_inventory` (kept until T16 switches; then marked deprecated);
    - `alert {kind: 'git_tamper', repo, session_id?, files: string[]}` (daemon → orchestrator);
    - `start_session` gains `working_copy {repo_path, mode}` (the claim's chosen `machine_repo`; the daemon re-checks it, ADR-0013).
  - **`packages/shared/src/machines/`** (new): `InventoryRepoSchema {path, remote: string | null, default_branch, head_commit, mode: 'reference' | 'checkout'}`; `CapabilitySchema` (discriminated by `kind`: `cli {name, version, authed}`, `mcp {name}`, `skill {name, repo?}`, `agent {name, repo?}`, `claude {version}`); `capabilityKey(c)` → `'cli:gh:authed'`, `'mcp:slack'`, …; `CapabilityRequirement` (a key string). `requiredCapabilities(def, kind): CapabilityRequirement[]` is **declared** here with a stub that returns `[]` and a `// M2-T06` note; T06 implements it.
  - **`packages/shared/src/engine/types.ts`**: a system event `machine.lost {machine_id, reason: 'lease_expired' | 'revoked' | 'pinned_machine_offline'}`; the effect it produces is "needs_input with `input_request.kind = machine_lost`" and the question text `"<machine> stopped responding"` / `"<machine> was revoked"`. Decide whether `machine_lost` is a new `input_request_kind` value (then T03's migration adds it) or reuses `timeout`; record the choice in 10-contracts.
  - **Lost-session semantics** (U-068, frozen here for T06/T20): on `machine.lost` the session goes to needs_input with the transitions "Continue on <machine>" (`$return_to`, re-dispatched to the same machine when it is online, like the ADR-0008 reopen pin) and the existing Cancel operator action. The outbox gets a fenced `kill` for the old worker, delivered if the machine reconnects.
  - Fixtures in `shared/src/protocol/fixtures.ts` for every new message; the daemon's `FakeOrchestrator` and the gateway tests are untouched.
  - **10-contracts** §Machines protocol v2 (new) and [03](../../design/03-protocols.md) §Daemon ↔ orchestrator.
- **Design refs**: [ADR-0013](../../adr/0013-machine-enrollment-inventory-routing.md) §Enrollment, §Inventory, §Routing; [ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md) §Daemon distribution; U-060 and U-068 in [UNKNOWNS](../../tracking/UNKNOWNS.md); [04](../../design/04-scheduler.md) §Leases and fencing.
- **Depends on**: M1b done.
- **Files owned**: `packages/shared/src/protocol/**`, `packages/shared/src/machines/**`, `packages/shared/src/engine/types.ts` and `engine/fixtures.ts`, one export line in `packages/shared/src/index.ts`; 10-contracts §Machines protocol v2; 03 §Daemon ↔ orchestrator.
- **Do not touch**: `shared/src/api/**` (T01), `engine/apply.ts` (T06), `workflow/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `packages/shared/src/protocol/ws.v2.test.ts`: every new message fixture parses; a v1 `register` (with `enrollment_token: null`, no versions) still parses; `capabilityKey` is stable for each kind.
  - [ ] `InventoryRepoSchema` refuses a relative `path` and a `remote` outside the canonical grammar.
  - [ ] Existing code compiles and every existing test passes (additive only).
  - [ ] An interface-review agent confirms T04, T06, T09, T10, T13, T16 and T20 can be built from these contracts alone.
  - [ ] Ben approves the 10-contracts diff.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T03 · Tenancy + auth schema
- **Scope.**
  - One migration `packages/orchestrator/migrations/<ts>_accounts-and-auth.sql` (up and down):
    - tables `account`, `app_user`, `account_member`, `web_session`, `invite`, `password_reset`, `login_throttle` as sketched in [ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md) §Auth: schema sketch (emails unique on `lower(email)`; token hashes `bytea` unique; indexes on `web_session(user_id)`, `web_session(expires_at)`);
    - insert the `local` account (`LOCAL_ACCOUNT_ID`, name `local`);
    - `account_id uuid NOT NULL DEFAULT '<LOCAL_ACCOUNT_ID>' REFERENCES account(id)` on `ticket`, `session`, `machine`, `machine_repo`, `workflow_definition`, `input_request`, `event`, `outbox`, backfilled to `local`; an index on `account_id` (or a leading column in an existing index) for each. The **default is temporary** (so M1 code keeps inserting) and is dropped by T21; leave a `-- TD: dropped in M2-T21` comment and report it;
    - the `machine_lost` `input_request_kind` value if T02 chose one;
    - `workflow_definition`'s primary key is **not** changed here (T12).
  - Row types in `packages/orchestrator/src/db/types.ts` for the new tables and the new columns.
  - **Schema isolation test** `packages/orchestrator/test/schema-isolation.test.ts` (ADR-0012 §Proving isolation 1): every table except the allow-list (`account`, `app_user`, `account_member`, `web_session`, `invite`, `password_reset`, `login_throttle`, `pgmigrations`) has `account_id uuid NOT NULL` with a foreign key to `account`. The existing `test/schema.test.ts` is extended for the new tables.
  - [02](../../design/02-data-model.md): new §account, §app_user, §web_session, §invite, §password_reset, §login_throttle; `account_id` in each existing table section.
- **Design refs**: ADR-0017 §Auth: schema sketch; ADR-0012 §Tenancy, §Proving isolation; [02](../../design/02-data-model.md).
- **Depends on**: T01, T02.
- **Files owned**: the new migration file, `packages/orchestrator/src/db/types.ts`, `packages/orchestrator/test/schema*.test.ts`, 02 (the sections above).
- **Do not touch**: `src/api/**`, `src/engine/**`, `src/gateway/**`, existing migrations, `shared/**`, `docs/tracking/*`.
- **Migration**: **yes**. Ben approves before merge.
- **Acceptance**:
  - [ ] `pnpm db:migrate` then `pnpm db:migrate down` then up again on a database holding M1b rows: every row ends in the `local` account; down restores the M1b schema.
  - [ ] `schema-isolation.test.ts` passes, and fails when a scratch table without `account_id` is added (a self-test using a throwaway table in the test database).
  - [ ] Every existing orchestrator test and `pnpm test:e2e` pass unchanged (the default keeps M1 inserts working).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T04 · Daemon: enroll, credential, authenticated WebSocket
- **Scope.**
  - `conductor-daemon enroll --url <https url> --token <token>` (`packages/daemon/src/commands/enroll.ts`): `POST /api/machines/enroll` with `{token, hostname, os, arch, daemon_version}`; writes `{url, machine_id, credential}` to `<root>/machine.json` (`<root>` = `CONDUCTOR_ROOT`, default `~/.conductor`; file 0600, directory 0700; refuses a symlinked or foreign-owned file or directory, like ADR-0010's private repos). Re-enrolling overwrites only with `--force`. Clear errors for 401 (token expired or used), 429 and network failures. Never prints the credential.
  - `packages/daemon/src/credential.ts`: load and check that file; `CONDUCTOR_ORCHESTRATOR_URL` defaults to the stored `url` (`https` → `wss`, path `API_PATHS.daemonWs`).
  - `ws-client.ts`: sends `Authorization: Bearer <credential>` on the upgrade when a credential exists; on close `4001` (revoked) or `4003` it stops reconnecting, logs why and exits non-zero; on `4005` it logs "update the daemon: re-run the install command".
  - `register` sends `protocol_version` and `daemon_version` (from the package version + `CONDUCTOR_BUILD_SHA` if set); the machine id is the enrolled `machine_id`. **Local mode** (no `machine.json`): unchanged M1 behaviour (`CONDUCTOR_MACHINE_ID`, no header).
  - `main.ts` subcommand dispatch: `run` (default), `enroll`. Unknown subcommands print usage.
- **Design refs**: ADR-0013 §Enrollment; ADR-0017 §Daemon distribution; 10-contracts §Machines protocol v2 (T02).
- **Depends on**: T02.
- **Files owned**: `packages/daemon/src/{commands/enroll.ts, credential.ts, ws-client.ts, main.ts, config.ts}`, the connect/register section of `daemon.ts`, their tests, `packages/daemon/src/test-support/fake-orchestrator.ts` (accepts and records the header).
- **Do not touch**: `workspace.ts`, `claude/**`, `actions/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `packages/daemon/src/commands/enroll.test.ts` against a stub HTTP server: success writes the file with mode 0600 in a 0700 directory; a 401 leaves no file; an existing file without `--force` is refused; a symlinked root is refused.
  - [ ] `ws-client.test.ts`: the upgrade carries the bearer header when enrolled and none in local mode; close 4001 stops reconnects.
  - [ ] `daemon.test.ts`: `register` carries `protocol_version: 2` and `daemon_version`.
  - [ ] Every existing daemon test and `pnpm test:e2e` (local mode) pass.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T05 · Web: sign-in, sign-up, reset, account menu, admin
- **Scope.** Against the T01 contracts and the mock client.
  - Pages: `/signin` (email, password, `next` via `safeNextPath`), `/signup?invite=…` (calls the invite preview; invalid → "This invite link is not valid. Ask the person who sent it for a new one."; pre-fills a pinned email; live `passwordProblems`), `/reset?token=…` (new password twice).
  - **Session handling**: the client calls `GET /api/me` at start; any 401 from the API or SSE sends the user to `/signin?next=<current path>`. In `local` mode `/api/me` returns the local user, so nothing changes for dev.
  - **Account menu** (header): name, "Change password" dialog, "Sign out" (`POST /auth/logout`, then `/signin`). Admins also see "Admin".
  - **Admin page** `/admin`: users list (email, admin, locked, disabled) with "Reset link" (shows the URL once, copy button), "Unlock", "Disable"; invites list with "New invite" (email optional, days, admin checkbox; shows the URL once) and "Revoke".
  - Error states for 429 ("Too many attempts. Try again in a few minutes."), 403 and network errors.
  - `packages/web/src/api/` gains the auth and admin calls in `client.ts`, `http.ts` and `mock.ts` (mock: one admin user, two invites).
- **Design refs**: ADR-0017 §Auth: behaviour, §Invites; 10-contracts §Accounts and web auth (T01).
- **Depends on**: T01.
- **Files owned**: `packages/web/src/auth/**`, `packages/web/src/admin/**` (new), `packages/web/src/api/{client,http,mock}.ts` (auth and admin parts), `App.tsx` and `nav.ts` (routes and header), their tests.
- **Do not touch**: `web/src/board/**`, `web/src/workflow/**`, `web/src/components/**` except the header if it lives there, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `auth/SignIn.test.tsx`: wrong password shows the generic error; 429 shows the throttle message; success navigates to a safe `next` and ignores `//evil.com`.
  - [ ] `auth/SignUp.test.tsx`: an invalid invite shows the message and no form; a pinned email is read-only; a short password blocks submit.
  - [ ] `admin/Admin.test.tsx`: a created invite's URL is shown once and gone after closing; non-admins don't see the menu entry.
  - [ ] `App.test.tsx`: a 401 from `/api/board` redirects to `/signin?next=/`.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T06 · Shared: required capabilities; the engine handles a lost machine
- **Scope.**
  - `packages/shared/src/workflow/capabilities.ts`: the **capability registry** mapping each condition and action to its requirement (ADR-0013 §Routing, ADR-0016): `open_pr`, `pr_checks_green`, `pr_approvals`, `pr_merged` → `cli:gh:authed`; `azure_pipeline_succeeded` → `cli:az:authed`; `jira_fields_set` / `update_jira` → `cli:jira:authed` (placeholder until M5 decides CLI vs MCP, U-065); `slack_message` → `mcp:slack`. Disabled conditions (`enabled: false`) add nothing. Every agent state adds `claude`. Implement `requiredCapabilities(def, kind)` (replacing T02's stub): the union over every transition a ticket of that kind could take (kind filter as in ADR-0011; null kind = both), sorted and de-duplicated.
  - `packages/shared/src/engine/apply.ts` (+ a small `engine/machine-lost.ts`): handle `machine.lost` exactly per the table in [10-contracts](../../design/10-contracts.md#machines-protocol-v2) §Machines protocol v2, "Lost machines" (**the authority; it wins over this block**). In short:
    - `assigned` / `running` / `waiting_external` on the event's machine → (A) needs_input with the `machine_lost` request (`MACHINE_LOST_KIND`, which T03's migration adds to the enum) and "Continue on <machine>"; the `kill {reason: 'machine_lost'}` effect for `lease_expired` / `pinned_machine_offline`, none for `revoked`;
    - the same statuses on **another** machine → ignored `machine_mismatch` for every reason, `pinned_machine_offline` included;
    - `queued` + `pinned_machine_offline` → (A), trusted; `queued` + `revoked` with no `__machine_lost` mark → (A), trusted, no kill (the reaper's pin SQL found a revoked pinned machine); a queued session going to needs_input moves its ticket to `in_progress`;
    - `queued` / `needs_input` with a mark for the event's machine + `revoked` → (B) (the wrapper supersedes the old request, T20);
    - terminal sessions (`done` / `failed`) → ignored **`session_terminal`**; any other `needs_input` / `queued` case → ignored `wrong_status`;
    - **revoked: Cancel only**: while the mark's reason is `revoked`, apply refuses `human.transition` (`transition_not_allowed`) and `input.provided` (`wrong_status`);
    - **card derivation** (`humanTransitionsOfCard` in `shared/src/api/rest.ts`; no task owned it before this update): while the open request's kind is `machine_lost`, the `$return_to` button is titled `machineLostContinueTitle(name)`; when the mark's reason is `revoked` the card offers no transitions (Cancel stays an operator action).
  - Tighten `CapabilityRequirementSchema` (`shared/src/machines/capabilities.ts`) to the key grammar of the 10-contracts table (`cli:<n>`, `cli:<n>:authed`, `mcp:<n>`, `skill|agent:<n>[@<canonical repo>]`, `claude`), so `cli:a:b:c` fails (pays TD-114).
  - apply **never** changes `fencing_token`: the bump on an applied `machine.lost` belongs to the EngineService wrapper (`orchestrator/src/engine/service.ts`), which T20 extends; its test moved to T20.
- **Design refs**: ADR-0013 §Routing; [ADR-0016](../../adr/0016-work-connectors-on-the-users-machine.md); [05](../../design/05-workflow-engine.md); 10-contracts §Machines protocol v2 (T02); U-068.
- **Depends on**: T02, T03 (the `machine_lost` enum value; 10-contracts says T06 emits `MACHINE_LOST_KIND` only once T03 has widened the enum).
- **Files owned**: `packages/shared/src/workflow/capabilities.ts` (+ test), `CapabilityRequirementSchema` in `shared/src/machines/capabilities.ts`, `packages/shared/src/engine/apply.ts`, `engine/machine-lost.ts` (+ tests), `humanTransitionsOfCard` in `shared/src/api/rest.ts` (the `machine_lost` cases only) and `cards` tests for it, 05 §Lost machines (new).
- **Do not touch**: `engine/types.ts`, `protocol/**`, the rest of `api/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `capabilities.test.ts`: `conductor` v2 for `work` needs `cli:gh:authed` and `claude`; a definition with an enabled `azure_pipeline_succeeded` adds `cli:az:authed`, a disabled one doesn't; a personal-only transition's needs don't appear for `work`.
  - [ ] `apply.machine-lost.test.ts`, one case per row of the 10-contracts table: running on the event's machine → needs_input with the question naming the machine and one `kill`; running on another machine with `pinned_machine_offline` → `machine_mismatch`; queued + `pinned_machine_offline` → needs_input and ticket `in_progress`; queued + `revoked` without a mark → needs_input, no kill; parked with a mark + `revoked` → (B); done → ignored `session_terminal`; after a `revoked` lost, `human.transition` → `transition_not_allowed` and `input.provided` → `wrong_status`. (The stale-fencing-token refusal is tested in T20, where the bump lives.)
  - [ ] `api/cards.machine-lost.test.ts`: a `machine_lost` card for `lease_expired` shows "Continue on <machine>" for `$return_to`; a `revoked` one shows no transitions.
  - [ ] The property test (`apply.property.test.ts`) includes `machine.lost` and stays green at 1 000 runs.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T07 · Deploy kit for gradyserver
- **Scope.** Files only; nothing is deployed here (T25 deploys). Settings from [ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md) §Hosting topology.
  - **`Dockerfile`** (repo root), multi-stage: `node:22-bookworm-slim`; pnpm 10 installed with `npm i -g pnpm@10` (never corepack); `pnpm install --frozen-lockfile`; `pnpm build`; a runtime stage with only production deps (`pnpm deploy --prod` of the orchestrator, plus `packages/web/dist` and the migrations); `USER node` (non-root); `EXPOSE 7400`; `HEALTHCHECK` with `node -e "fetch('http://127.0.0.1:7400/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`; `CMD ["node", "packages/orchestrator/dist/bin.js"]` (or the deployed equivalent). Leave a clearly marked stage stub `daemon-tarball` that T14 fills. `.dockerignore` excludes `node_modules`, `.git`, `.claude`, `spikes`, `**/dist`, `.env*`.
  - **`deploy/gradyserver/compose.yml`** (project `conductor`): services `postgres` (`postgres:16`, named volume `pgdata`, no published port, `pg_isready` healthcheck, password from `.env`), `migrate` (same image, `node-pg-migrate up` against `DATABASE_URL`, `restart: "no"`), `orchestrator` (`depends_on: postgres: service_healthy, migrate: service_completed_successfully`; `ports: ["127.0.0.1:${CONDUCTOR_HOST_PORT:-3040}:7400"]`; env `CONDUCTOR_AUTH=password`, `CONDUCTOR_PUBLIC_URL`, `CONDUCTOR_BIND_HOST=0.0.0.0`, `CONDUCTOR_TRUSTED_PROXY`, `DATABASE_URL`; `restart: unless-stopped`); network `conductor` with a fixed subnet (`CONDUCTOR_SUBNET`, default `192.168.80.0/24`).
  - **`deploy/gradyserver/env.example`**: every variable above, commented.
  - **`deploy/gradyserver/nginx/conductor.gradyserver.com.conf`** (site) following the reso pattern listed in ADR-0017, with `location /ws/` (upgrade, `proxy_read_timeout 3600s`), `location /api/stream/` (`proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 3600s`, `proxy_http_version 1.1`, `Connection ""`), `location ~ ^/(auth/|api/machines/enroll)` (strict zone), `location /` (general zone). **`deploy/gradyserver/nginx/conductor-ratelimit.conf`** (http context, installed as `/etc/nginx/conf.d/conductor-ratelimit.conf`, the server's `<app>-ratelimit.conf` pattern, e.g. `reso-ratelimit.conf`): the two `limit_req_zone`s, named `conductor_auth` and `conductor_general`. **`deploy/gradyserver/nginx/conductor-websocket.conf`** (installed into conf.d): `map $http_upgrade $conductor_connection_upgrade`, prefixed so it can't collide with another site's map.
  - **`deploy/gradyserver/install-nginx-site.sh`** (run by Ben with sudo; idempotent; `set -euo pipefail`): checks it runs as root; copies both nginx files (backing up any different existing copy); if `/etc/letsencrypt/live/conductor.gradyserver.com` is missing, first enables an HTTP-only bootstrap server block for the ACME challenge, then runs `certbot certonly --webroot -w /var/www/html -d conductor.gradyserver.com --non-interactive --agree-tos -m <email from an argument>`; links the site into `sites-enabled`; runs `nginx -t` and only then `systemctl reload nginx`; on a failed `nginx -t` it restores the backups and exits non-zero. Prints each step. No other root actions.
  - **`deploy/gradyserver/deploy.sh <git-ref>`** (run by the lead locally): resolves the sha; `git archive` | `ssh -p 1024 bengrady4@gradyserver.com` into `~/deploy/conductor/releases/<sha>`; links `current`; creates `~/deploy/conductor/.env` from `env.example` with a random `POSTGRES_PASSWORD` if it doesn't exist (mode 0600; never overwrites); `docker compose -p conductor -f current/deploy/gradyserver/compose.yml --env-file .env up -d --build`; waits for healthy; runs `smoke.sh`; prints the deployed sha; keeps the last 5 releases.
  - **`deploy/gradyserver/backup.sh`** (bengrady4's crontab, nightly): `docker compose -p conductor exec -T postgres pg_dump -U conductor -Fc conductor` into `~/deploy/conductor/backups/conductor-<UTC timestamp>.dump` (umask 077), deletes dumps older than `BACKUP_KEEP_DAYS` (default 14), exits non-zero on an empty dump. **`deploy/gradyserver/install-cron.sh`** adds the crontab line idempotently.
  - **`deploy/gradyserver/smoke.sh <base-url>`**: HTTPS cert valid; HSTS, `X-Frame-Options`, `nosniff`, CSP present; `/healthz` 200; `/api/board` 401 without a cookie; a `POST /auth/login` without `Origin` → 403; SSE path returns `text/event-stream` headers with a cookie when `SMOKE_COOKIE` is given; the WS path without a credential → 401; `/install.sh` is served.
  - **`docs/setup/deploy-gradyserver.md`** (the runbook): prerequisites; first-time checks (`ss -ltn` for the port, `docker network inspect` for the subnet, and the conf.d `<app>-ratelimit.conf` pattern; the upgrade map always ships as `conductor-websocket.conf` with the prefixed name), with the values the lead verified on 2026-10-26 (port 3040 free; subnet 192.168.80.0/24 free; zones live in `/etc/nginx/conf.d/<app>-ratelimit.conf`); first deploy; Ben's sudo step; bootstrap; routine deploys; rollback; backups, restore into a scratch database, and the restore test; optional copy of a local database (U-073); log locations; how to rotate `POSTGRES_PASSWORD`. Every step that needs Ben is marked **(Ben, sudo)** or **(Ben)**.
- **Design refs**: ADR-0017 §Hosting topology, §Daemon distribution; ADR-0012 §Deployment shape (migrations as a release step).
- **Depends on**: T01 (paths). Uses the env names from ADR-0017; `/healthz` and `/install.sh` come from T14, `CONDUCTOR_BIND_HOST` and `CONDUCTOR_TRUSTED_PROXY` from T08.
- **Files owned**: `Dockerfile`, `.dockerignore`, `deploy/gradyserver/**`, `docs/setup/deploy-gradyserver.md`.
- **Do not touch**: `packages/**`, `docker-compose.yml` (local dev), `scripts/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `bash -n` passes on every script, and `shellcheck` too if installed (the PR says which ran).
  - [ ] `deploy/gradyserver/test/nginx-site.test.sh` (or a vitest test reading the file) asserts the site has the upgrade location, `proxy_buffering off` on `/api/stream/`, both rate-limit zones, the ACME location and the 301.
  - [ ] **QA step (lead, no deploy)**: `git archive` the branch to `~/deploy/conductor-build-test` on gradyserver and run `docker build .` and `docker compose -f deploy/gradyserver/compose.yml config` there; both succeed (no Docker on Ben's Mac). The orchestrator image runs as a non-root uid (`docker run --rm <img> id -u` ≠ 0).
  - [ ] `install-nginx-site.sh` refuses to run without root and, read by the QA agent, performs no step other than those listed.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (unchanged code; proves nothing broke).

### M2-T08 · Orchestrator auth core
- **Scope.** `packages/orchestrator/src/auth/`:
  - `password.ts`: argon2id via `@node-rs/argon2` (new dependency) with the ADR-0017 parameters, `needsRehash`, a fixed dummy hash for unknown emails.
  - `sessions.ts`: create (32 random bytes, SHA-256 stored), look up (absolute 30 d, idle 7 d, `last_seen_at` throttled to 5 min), revoke one, revoke all for a user (optionally except one).
  - `throttle.ts`: per-email `login_throttle` (10 failures → 15 min, doubling, 24 h cap; reset on success); per-IP limits via `@fastify/rate-limit` (new dependency) for login, sign-up, reset and enroll (exported so T15 and T17 apply them).
  - `middleware.ts`: an `onRequest` hook that resolves the cookie to `request.auth = {user, scope: AccountScope}`; `/api/*` without a session → 401 `unauthorized` (except `API_PATHS.machinesEnroll`); `requireAdmin` helper → 403 `forbidden`. In `local` mode it sets the local user and `localScope`.
  - `routes.ts`: `POST /auth/login`, `POST /auth/logout`, `GET /api/me`, `POST /auth/password` (ADR-0017 behaviour; generic 401; cookie flags per mode; `Set-Cookie` cleared on logout).
  - `api/security.ts`: hosted mode (`CONDUCTOR_AUTH=password`): host allow-list = the public URL's host; Origin must equal the public origin (missing Origin allowed only with `Sec-Fetch-Site: same-origin`); 415 for non-JSON unsafe requests; no dev origins (TD-069 closed); error codes `forbidden` / `unsupported_media_type` (TD-070 closed); the ADR-0017 security headers on every response.
  - `main.ts` config: `CONDUCTOR_AUTH` (default `local`), `CONDUCTOR_PUBLIC_URL` (required in `password`; `http` only for loopback), `CONDUCTOR_BIND_HOST` (default `127.0.0.1`; `local` mode refuses a non-loopback bind), `CONDUCTOR_TRUSTED_PROXY` (Fastify `trustProxy` set to exactly that address). Startup errors name the variable. (`CONDUCTOR_ALLOW_LOCAL_REPOS` is a daemon setting; the orchestrator has nothing to refuse.)
  - Register the hook and routes in `api/index.ts` (the registration lines only).
  - [09](../../design/09-security-and-budgets.md): a §Hosted security section replacing "UI auth: TBD".
- **Design refs**: ADR-0017 §Auth: behaviour, §Modes, §Threat model; ADR-0012 §Security changes against M1-T14; 09 §M1 local hardening; 10-contracts §Accounts and web auth (T01).
- **Depends on**: T01, T03.
- **Files owned**: `packages/orchestrator/src/auth/**` (new), `src/api/security.ts`, `src/main.ts`, the registration lines in `src/api/index.ts`, `packages/orchestrator/package.json` (dependencies), `test/auth/**`, `test/api-security.test.ts`, 09 §Hosted security.
- **Do not touch**: other handlers in `api/index.ts`, `src/engine/**`, `src/gateway/**`, migrations, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance** (DB tests via `useTestDatabase()`):
  - [ ] `test/auth/login.test.ts`: success sets `__Host-conductor_session` with `HttpOnly; Secure; SameSite=Lax; Path=/` for an https public URL and `conductor_session` without `Secure` for `http://127.0.0.1`; wrong password, unknown email and disabled user give byte-identical 401 bodies; the unknown-email path calls argon2 verify (spy).
  - [ ] `test/auth/throttle.test.ts`: the 10th failure locks the email; the 11th with the right password is refused; after the lock (fake clock) the right password works and resets the count; an unknown email locks the same way; the 11th login request in a minute from one IP gets 429 with `Retry-After`; `X-Forwarded-For` is honoured only from `CONDUCTOR_TRUSTED_PROXY`.
  - [ ] `test/auth/sessions.test.ts`: idle 7 d and absolute 30 d expiry (fake clock); logout deletes the row; a password change revokes the other sessions, not the current one; the stored id is a hash (the cookie value appears nowhere in the table).
  - [ ] `test/api-security.test.ts` (extended): in `password` mode a `POST` with a foreign Origin → 403 `forbidden`; without Origin and without `Sec-Fetch-Site` → 403; `text/plain` → 415 `unsupported_media_type`; `/api/board` without a cookie → 401; every response has the CSP and `nosniff` headers; the built web app loads under the CSP (no inline script in `packages/web/dist/index.html`).
  - [ ] Startup refuses `CONDUCTOR_AUTH=local` with `CONDUCTOR_BIND_HOST=0.0.0.0`, and `password` without `CONDUCTOR_PUBLIC_URL` (unit test of the config parser).
  - [ ] Every existing test and `pnpm test:e2e` pass (local mode unchanged).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T09 · Orchestrator machines: credentials, enrollment, upgrade auth, revoke
- **Scope.**
  - Migration `<ts>_machine-credentials.sql`: `enrollment_token (id, account_id, token_hash bytea unique, created_by, expires_at, used_at, used_by_machine)`, `machine_credential (id, machine_id, account_id, secret_hash bytea unique, created_at, last_used_at, revoked_at)`, `machine_capability (machine_id, account_id, key text, kind, name, version, detail jsonb, updated_at, pk (machine_id, key))`: one row per element of `capabilityKeys(c)` (an authed cli gives `cli:<name>` and `cli:<name>:authed`; a repo-scoped skill's key carries `@<repo>`); routing reads only `key` (10-contracts §Machines protocol v2, Storage), `machine` gains `name`, `daemon_version`, `protocol_version`, `revoked_at`; `machine_repo` gains `default_branch`, `mode` (default `reference`) and `remote`; `tree_clean` gets `DEFAULT true` and stays until T21 drops it, because the M1 `repo_inventory` handler still writes it until T16; `machine_alert (id, machine_id, account_id, session_id null, kind, detail jsonb, created_at, cleared_at)`. All `account_id NOT NULL REFERENCES account` (no default: new tables have no M1 inserts).
  - `gateway/enroll.ts`: `createEnrollmentToken(scope)` (128-bit, hashed, 30 min) and `enrollMachine(db, {token, hostname, os, arch, daemon_version})` → `{machine_id, credential}` in one transaction (the token is consumed with `used_at IS NULL AND expires_at > now()` in the `UPDATE … RETURNING`; the machine id is server-generated; the credential is 256-bit, only its hash stored). REST exposure is T17's.
  - **Upgrade auth** in `gateway/index.ts`: in `password` mode (gateway option `requireCredential`, default from `CONDUCTOR_AUTH`), the upgrade needs `Authorization: Bearer <credential>`; unknown or revoked → HTTP 401 before the socket is accepted; the connection gets `scope = {account_id, actor: {kind: 'machine', machine_id}}`; `register`'s machine id must equal the credential's (else close 4003). In `local` mode the M1 path stays, with `account_id = LOCAL_ACCOUNT_ID`. Both `// TD:` sites of TD-059 are removed. A `register` with `protocol_version` < 2 in `password` mode → close 4005.
  - `gateway/revoke.ts`: `revokeMachine(scope, machine_id)`, in one transaction, sets `revoked_at` on the machine and its credentials and marks every `pending` / `sent` outbox row targeting `machine:<id>` `failed` with `last_error = 'machine_revoked'` (no engine event; fenced kills from an earlier `lease_expired` included); then it closes the socket with `CLOSE_REVOKED` (4001) within one tick. It returns the live session ids for T20 to hand to a human (T20 wires that). 10-contracts §Machines protocol v2 "Revoke and the outbox (R4)".
  - Use `CLOSE_REPLACED` instead of the literal `4000` in `gateway/index.ts` (pays TD-113).
  - Row types in `db/types.ts` (machine section); 02 §machine, §machine_repo, new §machine_credential, §enrollment_token, §machine_capability, §machine_alert.
- **Design refs**: ADR-0013 §Enrollment, §Inventory; ADR-0017 §Threat model; 10-contracts §Machines protocol v2 (T02); 10-contracts §Gateway details.
- **Depends on**: T02, T03.
- **Files owned**: the new migration, `packages/orchestrator/src/gateway/{index.ts (upgrade + register), enroll.ts, revoke.ts}`, `db/types.ts` (machine rows), `test/gateway/**`, 02 (sections above).
- **Do not touch**: `src/api/**`, `src/auth/**`, `src/engine/**`, `gateway/claim.ts` (T16), `shared/**`, `docs/tracking/*`.
- **Migration**: **yes**. Ben approves before merge.
- **Acceptance**:
  - [ ] `test/gateway/enroll.test.ts`: a token enrolls once; a second use, an expired token and a token from a revoked list fail; two concurrent uses → exactly one machine; the credential's plaintext is in no table.
  - [ ] `test/gateway/upgrade-auth.test.ts` (password mode): no header → 401 and no `machine` row touched; a revoked credential → 401; a valid one registers; `register` with another machine's id → close 4003; `protocol_version: 1` → close 4005. Local mode: an M1 register without a header still works.
  - [ ] `test/gateway/revoke.test.ts`: revoke closes the live socket with 4001 in < 1 s and the credential no longer upgrades; the machine's `pending` and `sent` outbox rows are `failed` with `last_error = 'machine_revoked'`, another machine's rows are untouched.
  - [ ] `test/gateway/capability-rows.test.ts` (or in `upgrade-auth`): the `machine_capability` primary key is `(machine_id, key)`; an authed `gh` stores two rows.
  - [ ] Migration up/down/up on a database with M1b rows; `machine_repo` rows survive with `mode = 'reference'`.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T10 · Daemon: inventory scanner
- **Scope.** `packages/daemon/src/inventory/`:
  - Repo grammar: the scanner canonicalises remotes with T01's shared `canonicalRepo` rather than a fourth copy, and replaces the daemon's private copy where it can (TD-107; T13 finishes the `workspace.ts` side).
  - `repos.ts`: walk the configured roots (depth ≤ 4, no symlink following, skip `node_modules` and dot-directories), find git work trees, read `origin`'s fetch URL (canonicalised to `host/org/repo` with the M1-T14 grammar; else `remote: null`), `default_branch` (`origin/HEAD`, else `main` / `master`), `head_commit`, and the per-repo `mode` from config (default `reference`). All git calls with `-c core.hooksPath=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
  - `capabilities.ts`: `cli` probes with a 5 s timeout each and no shell: `gh --version` + `gh auth status`, `az --version` + `az account show`, `jira version` (if present), `git --version`; `authed` is a boolean only (no account names in the report); `mcp` names from the user's Claude Code config (user scope and enabled plugins: names only, never command, args, env or URL); `skill` / `agent` names from `~/.claude/skills|agents` and each repo's `.claude/skills|agents`; `claude --version`.
  - `report.ts`: build the `inventory` message with a stable `hash`; send after `registered`, on `SIGHUP`, and every 10 min when the hash changed. Until T16 switches the orchestrator over, the daemon **also** sends the old `repo_inventory` (a `// TD: removed in M2-T21` site); T21 removes it.
  - **Test repos**: with `CONDUCTOR_ALLOW_LOCAL_REPOS` (tests only), `CONDUCTOR_TEST_REMOTE_ALIASES` (`<path>=<host/org/repo>,…`) gives local test repos a canonical remote so the e2e can route them; it is ignored without that flag.
  - **gh version floor** (follow-up (b), dogfooding 2026-10-27: gh 2.14 couldn't run `gh pr create` outside a git repository, which `open_pr` does by design): `GH_MIN_VERSION` and a pure `cliVersionAtLeast(version, min)` in `packages/shared/src/machines/capabilities.ts` (additive; T11 reads them). The minimum version that supports `gh pr create --repo --head --base` run outside any git repository is **not verified** (U-076); the floor is **2.40.0** (Dec 2023), a safe floor well past the known-bad 2.14 and below Ben's 2.103.3. The inventory already reports `cli {name: 'gh', version}`; `actions/open-pr.ts` runs `gh --version` first and refuses the action with `"gh ≥ 2.40.0 required (found <v>): upgrade gh, e.g. brew upgrade gh"` (an action error, so the move goes to a human, ADR-0010) when it is older or unparsable. If T10 finds the true minimum (e.g. from gh's changelog), it sets the floor to it and says so in the PR.
  - `config.ts` + `main.ts`: `conductor-daemon config roots <dir…>`, `conductor-daemon config repo <path> --mode reference|checkout`, `conductor-daemon config show`; stored in `<root>/config.json` (0600). `CONDUCTOR_ROOTS` env overrides.
- **Design refs**: ADR-0013 §Inventory; U-060 resolution; 10-contracts §Machines protocol v2 (T02).
- **Depends on**: T04 (the daemon lane; `main.ts`, `config.ts`).
- **Files owned**: `packages/daemon/src/inventory/**` (new), `config.ts`, `main.ts` (the `config` subcommand), the inventory section of `daemon.ts`, the gh version check in `actions/open-pr.ts` (that check only), `GH_MIN_VERSION` / `cliVersionAtLeast` in `packages/shared/src/machines/capabilities.ts` (additive), their tests.
- **Do not touch**: `workspace.ts` (T13), `claude/**`, other `actions/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `inventory/repos.test.ts` on a temp tree: finds repos at depth 1–4, not 5; skips `node_modules`, dot-dirs and symlinks; canonicalises `git@github.com:org/app.git` and `https://github.com/org/app` to `github.com/org/app`; a repo without origin has `remote: null`; a planted `.git/hooks/post-checkout` in a scanned repo is never run (marker file absent).
  - [ ] `inventory/capabilities.test.ts` with fake binaries on `PATH`: `gh` authed → `{authed: true}` with no account name anywhere in the message; a hanging probe is killed at 5 s; MCP names are read from a fixture config and no `command`/`env` value appears in the output.
  - [ ] `inventory/report.test.ts`: sent after `registered`; not re-sent when unchanged; re-sent on `SIGHUP` after a change.
  - [ ] `actions/open-pr.gh-version.test.ts` with a fake `gh` on `PATH`: `gh version 2.14.0` → the action fails with the "gh ≥ 2.40.0 required" message and nothing is pushed; `2.40.0` and `2.103.3` proceed. `cliVersionAtLeast` unit tests in shared (`2.9.0 < 2.40.0`, pre-release suffixes, garbage → false).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T11 · Web: Machines page, routing badge, alerts
- **Scope.** Against the T01 contracts and the mock client.
  - `/machines`: list (name, online, last seen, daemon / claude versions with an "update" mark when `outdated`, repo count, revoked); a detail drawer (repos with remote, path and mode; capabilities grouped by kind; open alerts with changed files); rename inline; **Revoke** with a confirm naming the live sessions that will go to a human.
  - **Add a machine**: calls the enrollment-token route and shows the `command` once with a copy button, the 30-minute expiry, the `--service` variant, and a link to `docs/setup/add-a-machine.md` (served from the repo's GitHub URL).
  - Board: Queued cards with `routing` show "needs a machine with `org/app` and `az`"; cards with `alerts` show a red "`.git` changed" badge listing files.
  - **Outdated gh** (follow-up (b)): a machine whose `cli` capability `gh` has a version below `GH_MIN_VERSION` (T10, `cliVersionAtLeast`) shows "gh <v> is too old for pull requests (needs ≥ <min>)" in the list row and the drawer.
  - `packages/web/src/api/{client,http,mock}.ts`: the machines calls (mock: two machines, one with an alert).
- **Design refs**: ADR-0013 §Enrollment (Machines page), §Routing; ADR-0017 §Daemon distribution; 10-contracts §Accounts and web auth (T01).
- **Depends on**: T05 (web lane: `App.tsx`, api client files); T10 (`GH_MIN_VERSION`, `cliVersionAtLeast`).
- **Files owned**: `packages/web/src/machines/**` (new), the machines parts of `web/src/api/{client,http,mock}.ts`, the card badge in `web/src/components/Board.tsx` (badge only), `App.tsx` / `nav.ts` (route and nav entry), their tests.
- **Do not touch**: `web/src/auth/**`, `web/src/admin/**`, `web/src/workflow/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `machines/Machines.test.tsx`: the install command is shown once and gone after closing; revoke asks for confirmation listing sessions; an outdated daemon shows the update mark; a machine with `gh` 2.14.0 shows the outdated-gh flag, one with 2.103.3 doesn't.
  - [ ] `components/Board.routing.test.tsx`: a Queued card with `routing` shows the missing repo and capabilities; a card with an alert shows the badge and files.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T12 · Orchestrator: per-account workflows
- **Scope.**
  - Migration `<ts>_workflow-per-account.sql`: `workflow_definition` primary key → `(account_id, id, version)`; `ticket` and `session` foreign keys → `(account_id, workflow_id, workflow_version)`; `workflow_definition.required_capabilities jsonb NOT NULL DEFAULT '{}'` (`{work: [...], personal: [...], any: [...]}`), backfilled by the migration's companion script or on start (document which).
  - `engine/seed.ts`: `seedAccount(db, account_id)` inserts the shipped `conductor` (and keeps the `m1_*` / `pr_flow` seeds only for the `local` account); the ADR-0011 upgrade rule ("newer shipped version, and the account hasn't edited it") runs per account on start.
  - The workflow save handler in `api/index.ts` computes `required_capabilities` with `requiredCapabilities(def, kind)` for `work`, `personal` and null, and stores it. Lookups by `(id, version)` in the save and seed paths include `account_id` (from `request.auth.scope`).
  - 02 §workflow_definition; 05 note on per-account seeding.
- **Design refs**: ADR-0012 §Tenancy (per-account `conductor`); ADR-0011 seed-upgrade rule; ADR-0013 §Routing (`required_capabilities`).
- **Depends on**: T03, T06, T08 (`request.auth`).
- **Files owned**: the new migration, `src/engine/seed.ts`, the workflow handlers in `src/api/index.ts`, `db/types.ts` (workflow rows), `test/engine/seed.test.ts`, a new `test/api.workflows.test.ts`, 02 §workflow_definition.
- **Do not touch**: other `api/index.ts` handlers, `engine/**` besides `seed.ts`, `gateway/**`, `auth/**`, `shared/**`, `docs/tracking/*`.
- **Migration**: **yes**. Ben approves before merge.
- **Acceptance**:
  - [ ] `test/engine/seed.test.ts`: `seedAccount(B)` gives B its own `conductor` v2 while `local`'s is untouched; editing B's doesn't block upgrading `local`'s; the per-account upgrade rule is tested for both.
  - [ ] `test/api.workflows.test.ts`: saving a version stores `required_capabilities` (an enabled Azure condition yields `cli:az:authed` under `work`).
  - [ ] Migration up/down/up on a database with M1b rows; tickets pinned to `local`'s v1 still load.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T13 · Daemon: working copies
- **Scope.** Rework `packages/daemon/src/workspace.ts` (ADR-0013 §Sessions run in worktrees, as amended by U-060):
  - When `start_session.working_copy` is absent (an orchestrator before T16, or local mode with test repos), the M1 path stays: `cloneSource` into `<root>/repos`.
  - `start_session.working_copy.repo_path` is re-checked against the daemon's own inventory (path and remote must match `ticket.repo`); a mismatch fails the start with a clear error (never trust the message's path).
  - **`reference` mode (default)**: a daemon clone at `<root>/repos/<slug>` made with `git clone --reference <user checkout> --dissociate <origin fetch URL>` (the user's own URL, so their git credentials work), then `git fetch origin <default_branch>` before **every** session (fixes the stale base, U-030); worktree `<root>/wt/<session>` on `conductor/<ticket>/<short>` from `origin/<default_branch>`. The user's `.git` is never written.
  - **`checkout` mode (opt-in)**: `git -C <checkout> -c core.hooksPath=/dev/null fetch origin <default_branch>` and `worktree add <root>/wt/<session> … origin/<default_branch>`; before the session and after it ends, hash `.git/config`, `.git/hooks/**` and the `core.hooksPath` target; any change sends `alert {kind: 'git_tamper', files}`.
  - All daemon git with `-c core.hooksPath=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
  - `cloneSource`'s repo grammar uses the shared `canonicalRepo` / `isCanonicalRemote` (pays TD-107 with T10).
  - Push URL for the ADR-0010 private push comes from the inventory's recorded remote, re-checked against `ticket.repo`; never read from a checkout's config at push time.
  - **Push credentials** (follow-up (a), dogfooding 2026-10-27): `open_pr` pushes with `GIT_CONFIG_NOSYSTEM=1` (ADR-0010 hardening), so a credential helper configured only in system git config (Homebrew's `/opt/homebrew/etc/gitconfig`: `osxkeychain`) is invisible and HTTPS pushes fail. (Ben's Mac was fixed by hand with `gh auth setup-git`, which writes global config.) Fix: for an `https://github.com/…` push target, the daemon adds `-c credential.helper= -c "credential.helper=!<absolute path to gh> auth git-credential"` to **its own push command only** (the empty value first resets any inherited helper list). `<absolute path to gh>` is resolved once from `PATH` at daemon start (the same `gh` the inventory probed) and must be an absolute, existing, non-symlink-to-worktree path; if `gh` is missing, the push runs unchanged and fails with the existing error plus the hint "run `gh auth login` (and `gh auth setup-git`)". SSH targets are untouched. Nothing is written to any git config.
  - Worktree GC: `git worktree remove` + `prune` against the clone or the checkout; no `<root>/repos` first-use clone from a bare repo name any more (M1's `cloneSource` path is kept only for `CONDUCTOR_ALLOW_LOCAL_REPOS` test repos).
  - [07](../../design/07-multi-session-isolation.md) §Code rewritten.
- **Design refs**: ADR-0013 §Sessions run in worktrees; U-060 resolution; [ADR-0010](../../adr/0010-one-workflow-columns-are-states.md) (fresh checkout, private push); [ADR-0008](../../adr/0008-transcript-history-and-reopen.md) (worktree location, reopen pin); 07 §Code.
- **Depends on**: T10 (inventory store).
- **Files owned**: `packages/daemon/src/workspace.ts`, `src/actions/checkout.ts` (push URL source only), `src/actions/open-pr.ts` (push URL source and the push credential helper; T10's gh version check stays), the start_session section of `daemon.ts`, their tests, 07 §Code.
- **Do not touch**: `inventory/**` (read only), `claude/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] *(Built in **M2-T13a**, 2026-10-28; T13 keeps it passing in both new modes.)* **TD-026 / U-030 (fresh base, actively hurting M2: every dogfood session so far started from a stale main and was rebased by hand; the lead fast-forwards the clone after each merge as a workaround)**: `workspace.fresh-base.test.ts`: the daemon runs `git fetch origin <default_branch>` **before creating each new session's worktree**, in both modes and on the M1 `cloneSource` path too (local test repos), and the session branch is created from the **fetched** `origin/<default_branch>` (not the clone's local `HEAD` or `main`). Test: create clone → push commit X to origin → start a session → the worktree's base contains X; push Y → start a second session → its base contains Y; a resumed session (same session id) reuses its existing worktree and is not rebased. A failed fetch fails the start with a clear error (no silent stale base). Pays TD-026.
  - [ ] `workspace.reference.test.ts`: with a temp "user checkout" and a temp origin, a session's worktree is based on the **fetched** origin default branch (a commit pushed to origin after the clone appears); the user checkout's `.git` directory tree hash is identical before and after two sessions.
  - [ ] `workspace.checkout.test.ts`: a session runs off the checkout; planting `.git/hooks/pre-commit` during it produces an `alert` naming that file; nothing is reported when nothing changed.
  - [ ] A `start_session` whose `repo_path` isn't in the inventory, or whose remote doesn't match the ticket, fails without touching disk.
  - [ ] The ADR-0010 fresh-checkout and private-push tests pass; `pnpm test:e2e` passes (its repos are local test repos via `CONDUCTOR_ALLOW_LOCAL_REPOS`).
  - [ ] `actions/open-pr.credential.test.ts` with a fake `git` that records its argv: an `https://github.com/o/r` push carries `-c credential.helper=` followed by `-c credential.helper=!<abs gh> auth git-credential`, in that order and only on the push (not on the fetch); an `ssh` / `git@github.com:` push carries neither; a missing `gh` leaves the push unchanged and the failure text has the hint.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T14 · Orchestrator: daemon distribution and health
- **Scope.**
  - Build: a script `packages/orchestrator/scripts/build-daemon-tarball.sh` producing `dist/downloads/conductor-daemon-<version>.tgz` and `.sha256` from a self-contained daemon (`pnpm --filter @conductor/daemon deploy --prod <dir>`, with `--legacy` or `inject-workspace-packages` as pnpm 10 requires; the tarball's entry is `bin/conductor-daemon` running `node dist/main.js`). `<version>` = package version + short git sha (`CONDUCTOR_BUILD_SHA`). The Dockerfile's `daemon-tarball` stage (T07's stub) runs it and copies the result into the runtime image.
  - `packages/orchestrator/assets/install.sh.tmpl` (POSIX `sh`, `set -eu`): flags `--token`, `--service`, `--root`; checks `node` ≥ 22, `git`, `claude` (lists what's missing and exits); downloads the tarball over https, checks SHA-256 (`shasum -a 256` or `sha256sum`); unpacks to `<root>/daemon/<version>`, swaps `<root>/daemon/current` atomically, links `<root>/bin/conductor-daemon`; with `--token` runs `conductor-daemon enroll --url <public url> --token …`; with `--service` runs `conductor-daemon service install` (T18); prints the PATH line to add. Without `--token` it upgrades in place.
  - `src/distribution.ts`: `GET /install.sh` (the template filled with `CONDUCTOR_PUBLIC_URL`, version and SHA-256; `text/x-shellscript`; `Cache-Control: no-store`), `GET /downloads/:file` (only the built tarball names), `GET /healthz` (`{ok, db, version}`, 503 when the DB ping fails). Registered from `main.ts`. In dev without a built tarball, `/install.sh` returns 503 with a hint.
  - `register` handling compares `daemon_version` with the served version and marks the machine `outdated` (a field T17's list returns) — implemented as an exported pure helper `isOutdated(daemon, served)`; T16 calls it when ingesting.
- **Design refs**: ADR-0017 §Daemon distribution, §Hosting topology.
- **Depends on**: T07 (Dockerfile stub), T08 (public URL config).
- **Files owned**: `packages/orchestrator/src/distribution.ts`, `packages/orchestrator/assets/**`, `packages/orchestrator/scripts/build-daemon-tarball.sh`, the `daemon-tarball` stage of `Dockerfile`, the route registration in `src/main.ts`, `test/distribution*.test.ts`.
- **Do not touch**: `src/api/**`, `src/auth/**`, `src/gateway/**`, `packages/daemon/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/distribution.test.ts`: `/install.sh` embeds the public URL, version and the right SHA-256; `/downloads/../../etc/passwd` → 404; `/healthz` 200 with a DB and 503 without.
  - [ ] `test/install-script.test.ts`: runs the rendered script with `sh` against a local server serving a small fake tarball, with `HOME` and `--root` in a temp dir and a fake `node`/`git`/`claude` on `PATH`: installs, links `current`, runs the (fake) enroll with the token; a wrong SHA-256 aborts with nothing installed; `node` 20 aborts with the message; a second run without `--token` upgrades and keeps `machine.json`.
  - [ ] `scripts/build-daemon-tarball.sh` produces a tarball whose `bin/conductor-daemon --help` runs from an empty directory with only Node on `PATH` (no workspace links).
  - [ ] **QA step (lead)**: `docker build` on gradyserver (as in T07) includes `/app/.../downloads/conductor-daemon-*.tgz`.
  - [ ] **TD-117 (install side; T18 does the daemon side)**: `install.sh` passes the enrollment token to `conductor-daemon enroll` in the environment variable `CONDUCTOR_ENROLL_TOKEN`, never in argv. `test/install-script.test.ts` asserts that the fake `conductor-daemon`'s recorded argv has no token and its environment has it. The command shown on the Machines page still carries `--token` for `sh -s --`; the script moves it off argv before calling the daemon.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T15 · Orchestrator: invites, sign-up, resets, admin, CLI
- **Scope.** In `packages/orchestrator/src/auth/` (T08's module):
  - `invites.ts`: create (256-bit, hashed, 1–30 days, optional email, optional admin), list, revoke; `GET /auth/invites/:token` preview (`valid`, pinned email, expiry; nothing else).
  - `signup.ts`: `POST /auth/signup` in one transaction: lock the invite row (`FOR UPDATE`), check valid / unused / unexpired / unrevoked / email match, create `app_user` (argon2id), then **either** create a personal account + `account_member(owner)` + `seedAccount` (T12) **or**, for a `claims_account` invite, make the user owner of that account and rename it; mark the invite used; create a web session. Rate-limited (T08).
  - `reset.ts`: create a 1-hour reset link (admin route or CLI); `POST /auth/reset` sets the password and revokes all the user's sessions; rate-limited.
  - `admin-routes.ts` (all `requireAdmin`): the `/api/admin/*` routes from T01 (invites, users, reset link, disable (revokes sessions; the user's machines are revoked through `revokeMachine`), unlock).
  - `packages/orchestrator/src/admin-cli.ts` + `bin` `conductor-admin` in `package.json`: `bootstrap` (refuses if any user exists; prints a 1-hour admin invite with `claims_account = LOCAL_ACCOUNT_ID`), `invite [--email] [--days] [--admin]`, `reset-link <email>`, `unlock <email>`, `revoke-sessions <email>`, `disable <email>`, `list-users`. Uses `DATABASE_URL` and `CONDUCTOR_PUBLIC_URL`; prints only links, never hashes.
  - 09 §Hosted security: the admin and recovery paragraph.
- **Design refs**: ADR-0017 §Invites, sign-up, resets, the admin; ADR-0012 §Tenancy; U-056.
- **Depends on**: T08, T09 (`revokeMachine`), T12 (`seedAccount`).
- **Files owned**: `src/auth/{invites,signup,reset,admin-routes}.ts`, the route registration inside `src/auth/` , `src/admin-cli.ts`, the `bin` entry in `packages/orchestrator/package.json`, `test/auth/{invites,signup,reset,admin,cli}.test.ts`.
- **Do not touch**: `src/api/**`, `src/engine/**`, `src/gateway/**` (call `revokeMachine` only), `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/auth/signup.test.ts`: no invite, a used, expired or revoked invite, or the wrong email → refused with no user created; two concurrent sign-ups with one invite → exactly one user; a normal invite creates a new account seeded with `conductor`; the bootstrap invite makes the user admin and owner of `local`, whose existing ticket is then visible to them via `GET /api/board`.
  - [ ] `test/auth/cli.test.ts`: `bootstrap` prints a URL on an empty database and refuses on a second run; `reset-link` → the link works once and revokes existing sessions; `unlock` clears a lock.
  - [ ] `test/auth/admin.test.ts`: a non-admin gets 403 on every `/api/admin/*` route; an admin's invite URL works; disable revokes sessions and the user's machine credentials.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T16 · Orchestrator: inventory ingest and routing
- **Scope.**
  - `gateway/inventory.ts`: on `inventory`, replace the machine's `machine_repo` and `machine_capability` rows in one transaction (scoped to the connection's account; capability rows keyed `(machine_id, key)`, one per `capabilityKeys` element, T09); ignore repos with `remote: null` for routing but keep them for display. (`outdated` is **not** stored: T17 computes it at read time with T14's `isOutdated`.) On `alert`, dedupe on `(machine_id, seq)` (10-contracts §Daemon seq dedupe), insert `machine_alert` and publish a board update for the session's card. `repo_inventory` handling is removed. This pays TD-112 (the M1 gateway dropped `inventory` / `alert` until now; alerts sent between T13 and T16 were lost, not replayed).
  - `gateway/claim.ts` gains the hard filters (ADR-0013 §Routing; [04](../../design/04-scheduler.md) §2; 10-contracts §Machines protocol v2 "Matching" is the authority): `ticket.account_id = machine.account_id`; `EXISTS machine_repo (this machine, remote not null, lower(remote) = lower(ticket.repo))` (github.com org/repo are case-insensitive); every requirement in the pinned (or latest) version's `required_capabilities` for the ticket's kind is a stored `machine_capability.key` of the machine, or a bare `skill:<n>` / `agent:<n>` met by `skill:<n>@<ticket.repo>` with the `@<repo>` part compared case-insensitively too. A queued session carrying a `__machine_lost` mark is offered **only** to `mark.machine_id` (a hard filter like the reopen pin).
  - **Working copy**: in the claim transaction, before `applyEvent(session.assigned)`, the claim writes the matched `machine_repo` as `{repo_path, mode}` into `session.context.__working_copy` (`WORKING_COPY_CONTEXT_KEY`); `commandPayloadForEffect` copies it into every `start_session`. The short hold is removed.
  - `engine/board-view.ts`: Queued cards get `routing` = what no **online** machine of the account has (the repo, then missing capabilities via `missingCapabilities(caps, reqs, ticket.repo)`; it takes the ticket's repo so repo-scoped skills match), and `alerts` from open `machine_alert` rows.
  - **Gateway isolation test** (ADR-0012 §Proving isolation 3).
  - 04 §2 and §3 rewritten (filters, no short hold).
- **Design refs**: ADR-0013 §Inventory, §Routing; ADR-0012 §Proving isolation; 04 §Claim query; 10-contracts §Claim.
- **Depends on**: T06, T09, T12, T14 (`isOutdated`).
- **Files owned**: `src/gateway/{inventory.ts, claim.ts}`, the `inventory` / `alert` / `repo_inventory` cases in `gateway/index.ts`, `src/engine/board-view.ts`, `test/gateway/{claim,inventory,isolation}.test.ts`, 04 §2–§3.
- **Do not touch**: `api/**`, `auth/**`, `engine/**` besides `board-view.ts`, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/gateway/claim.test.ts`: a ticket for `org/b` is claimed by machine B (has it), never by A; a ticket for `github.com/Org/B` is claimed by a machine reporting `github.com/org/b`; a ticket whose workflow needs `cli:az:authed` isn't claimed by a machine with `az` unauthed, and is claimed once an inventory with `authed: true` arrives; a bare `skill:review` requirement is met by `skill:review@github.com/Org/B` for a ticket on `github.com/org/b`; after the claim, `session.context.__working_copy` holds B's path and mode and the `start_session` outbox row carries `working_copy`; a queued session with a `__machine_lost` mark for B is never claimed by A.
  - [ ] `test/gateway/isolation.test.ts`: a machine of account B can't claim, send events or `complete_state` for, ack commands of, or fetch transcripts of an account-A session (each refused, nothing written).
  - [ ] `test/gateway/inventory.test.ts`: a second inventory replaces the first; an `alert` creates a row and the card shows it.
  - [ ] Board view: a Queued card with no capable online machine has `routing` naming the missing repo / capabilities.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` (the daemon sends both messages since T10, so the M1/M1b e2e keeps working. A ticket whose `repo` is not canonical, which only `local` mode allows, skips the repo filter as in M1; the capability filter always applies. Test both).

### M2-T17 · Orchestrator: machines REST and ticket repo check
- **Scope.** New `packages/orchestrator/src/api/machines.ts`, registered from `api/index.ts`:
  - `POST /api/machines/enroll` (public, rate-limited with T08's limiter, calls T09's `enrollMachine`; 401 `unauthorized` for a bad token);
  - `POST /api/machines/enrollment-tokens` → `EnrollmentTokenCreated` with the full `curl -fsSL <public url>/install.sh | sh -s -- --token <token>` command;
  - `GET /api/machines` (the account's machines, `MachineRow`; `outdated` computed at read time with T14's `isOutdated(machine.daemon_version, served version)`, no column), `GET /api/machines/:id` (`MachineDetail`), `PATCH /api/machines/:id` (rename), `POST /api/machines/:id/revoke` (T09's `revokeMachine`; T20 adds the human hand-off). Another account's id → 404.
  - `POST /api/tickets` in `password` mode: `repo` must pass `canonicalRepo` and is stored canonical (400 otherwise); `local` mode keeps M1's rule (local paths allowed for the e2e fixture repos); when no machine of the account has the repo the ticket is created and the response carries `warnings: ['no_machine_has_repo']` (U-048, ADR-0013).
  - 03 §REST: the machines routes.
- **Design refs**: ADR-0013 §Enrollment, §Routing; ADR-0017 §Daemon distribution; 10-contracts §Accounts and web auth (T01).
- **Depends on**: T08, T09, T14 (`isOutdated` and the served version).
- **Files owned**: `src/api/machines.ts`, its registration line and the ticket-create handler in `src/api/index.ts`, `test/api.machines.test.ts`, `test/api.tickets-repo.test.ts`, 03 §REST (machines).
- **Do not touch**: other handlers in `api/index.ts`, `gateway/**` (call exported functions only), `auth/**`, `engine/**`, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/api.machines.test.ts`: create a token → the command contains the public URL; enroll with it via the REST route → the machine lists; rename; revoke → `revoked_at` set and the socket closed (fake gateway); account B gets 404 on A's machine routes; the 11th enroll in 10 min from one IP → 429.
  - [ ] `test/api.tickets-repo.test.ts` (password mode): `ext::sh -c x`, a local path and `../x` → 400; `github.com/org/app` with no machine → 201 with the warning. Local mode: a local path is still accepted.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T18 · Daemon: service units, upgrade, setup guide
- **Scope.**
  - `conductor-daemon service install | uninstall | status` (`packages/daemon/src/commands/service.ts`): macOS writes `~/Library/LaunchAgents/com.conductor.daemon.plist` (RunAtLoad, KeepAlive, logs to `<root>/logs/`) and `launchctl bootstrap gui/<uid>`; Linux writes `~/.config/systemd/user/conductor-daemon.service` (`Restart=on-failure`) and `systemctl --user enable --now`; both run `<root>/daemon/current/bin/conductor-daemon run`, so upgrades by the install script take effect on restart. Never needs sudo. `install` is idempotent.
  - After an in-place upgrade the install script (T14) calls `conductor-daemon service restart` if a unit is installed (this task provides `restart`).
  - **Launcher ([ADR-0021](../../adr/0021-daemon-auto-update.md) §3)**: the units run `<root>/bin/conductor-launch`, not the daemon directly. In this task it is only `exec "<root>/daemon/current/bin/conductor-daemon" run "$@"` (POSIX `sh`), kept in `packages/daemon/assets/conductor-launch.sh`; `service install` writes it, and `install.sh` writes the same bytes (the template embeds it at tarball build time; a test asserts identical bytes). T18c adds the trial / rollback logic. Both units set `CONDUCTOR_SUPERVISED=launchd|systemd`.
  - **Wake ([ADR-0021](../../adr/0021-daemon-auto-update.md) §5)**: a 5 s tick in `ws-client.ts` that sees wall-clock time jump by more than 30 s resets the backoff and reconnects at once, so opening the lid reconnects in seconds rather than after up to 30 s (`reconnect.maxMs`).
  - **`docs/setup/add-a-machine.md`**: prerequisites (Node 22, `claude` installed and logged in, `gh auth login`; optional `az login`, a Jira CLI or MCP); the one-line install from the Machines page; `--service`; choosing roots (`conductor-daemon config roots ~/code`); per-repo mode (`config repo <path> --mode checkout` and what it risks, U-060); what is reported and what is never reported; upgrading; revoking and re-enrolling; troubleshooting (401 = token expired, 4001 = revoked, 4005 = update).
- **Design refs**: ADR-0013 §Enrollment (setup guide); ADR-0017 §Daemon distribution.
- **Depends on**: T04; T14 (the install script calls this command).
- **Files owned**: `packages/daemon/src/commands/service.ts` (+ test), `packages/daemon/assets/conductor-launch.sh`, the launcher step in `packages/orchestrator/assets/install.sh.tmpl` and `scripts/build-daemon-tarball.sh`, the wake tick in `ws-client.ts`, the `service` subcommand in `main.ts`, `docs/setup/add-a-machine.md`; for TD-117 / TD-118 / TD-119: the token input in `commands/enroll.ts`, `credential.ts`, and the fatal-exit code in `ws-client.ts` (+ their tests).
- **Do not touch**: `workspace.ts`, `inventory/**`, `claude/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `commands/service.test.ts` with `HOME` in a temp dir and fake `launchctl` / `systemctl` on `PATH`: the plist / unit content matches a snapshot; install twice changes nothing; uninstall removes it; no command uses sudo.
  - [ ] **QA step (lead)**: on Ben's Mac, `conductor-daemon service install` against a local orchestrator starts the daemon at login (log in `<root>/logs/`), and `uninstall` stops it.
  - [ ] The plist / unit run `<root>/bin/conductor-launch` and set `CONDUCTOR_SUPERVISED`; the launcher written by `service install` and by the rendered `install.sh` is byte-identical (`commands/service.test.ts`, `install-script.test.ts`).
  - [ ] `ws-client.test.ts` (fake clock): a 60 s wall-clock jump during a 30 s backoff reconnects within one tick and resets the attempt counter; normal ticks don't.
  - [ ] **QA step (lead)**: on Ben's Mac, close the lid for > 1 min with the daemon running, then open it: the orchestrator log shows the machine re-registered within 10 s of wake.
  - [ ] **TD-117 (daemon side)**: `enroll` reads the token from `CONDUCTOR_ENROLL_TOKEN` (or stdin with `--token -`); `--token <value>` still works and prints a warning that argv is visible in `ps`. `commands/enroll.test.ts` covers all three.
  - [ ] **TD-119 (exit code)**: a fatal close (4001, 4003, HTTP 401, HTTP 403) exits with a distinct `EXIT_FATAL_AUTH` (78, `EX_CONFIG`), not 1; `ws-client.test.ts` asserts the code for each.
  - [ ] **TD-118** (here, or in the M2 security pass before T25): `credential.ts` opens with `O_NOFOLLOW` + `fstat`, checks the root is 0700 and owned by the user, `fsync`s on write, and never `chmod`s through a symlink; `credential.test.ts` covers each case.
  - [ ] **TD-119**: a revoked machine doesn't restart-loop. The systemd unit has `RestartPreventExitStatus=<EXIT_FATAL_AUTH>`; the launchd plist uses `KeepAlive {SuccessfulExit: false}` with the daemon's fatal-auth path stopping the job (or `ThrottleInterval` as a floor). `commands/service.test.ts` snapshots both; a fake daemon that exits with `EXIT_FATAL_AUTH` under the fake `systemctl` / `launchctl` is not restarted.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T18b · Contracts: daemon auto-update
- **Scope** ([ADR-0021](../../adr/0021-daemon-auto-update.md) §1–§4; additive, so M1/M2 daemons still parse).
  - `shared/src/protocol/ws.ts`: orchestrator → daemon direct frame `update_available {version, file, sha256, size}` (`UpdateAvailableSchema`; `file` matches `DAEMON_TARBALL_RE` = `^conductor-daemon-[0-9A-Za-z.+-]+\.tgz$` and embeds `version`; `sha256` is 64 lowercase hex; `size` ≤ `DAEMON_TARBALL_MAX_BYTES` 100 MB). `heartbeat.draining?: {reason: 'update', version}`. `alert` gains a second kind `{kind: 'update_failed', version, stage: 'download'|'verify'|'unpack'|'drain_timeout'|'trial', error (≤ 500 chars), at}` (machine-level, no `repo`; still carries `seq`).
  - `shared/src/machines/update.ts`: `LatestDaemonSchema` (`{version, file, sha256, size}`, the `/downloads/latest.json` body), `EXIT_RESTART_FOR_UPDATE` 75, `UPDATE_MAX_DRAIN_MS` 21 600 000, `UPDATE_TRIAL_REGISTER_MS` 120 000, `UPDATE_MAX_DRAIN_ATTEMPTS` 3, `UPDATE_DRAIN_COOLDOWN_MS` 3 600 000, `UPDATE_MAX_TRIAL_ATTEMPTS` 2. (`EXIT_FATAL_AUTH` 78 stays T18's.)
  - Machines list DTO (T01's): `alerts?: {kind: 'update_failed', version, stage, error, at}[]` on a machine.
  - Fixtures: `M2_WS_FIXTURES.update_available`, `.heartbeat_draining`, `.alert_update_failed`; `LATEST_DAEMON_FIXTURE`.
  - `docs/design/10-contracts.md` §Daemon auto-update and the `03-protocols.md` rows: confirm or correct what ADR-0021's docs branch wrote.
- **Design refs**: ADR-0021; 10-contracts §Machines protocol v2, §Daemon auto-update; 03 daemon protocol tables.
- **Depends on**: T02.
- **Files owned**: `packages/shared/src/protocol/ws.ts` (these additions), `packages/shared/src/machines/update.ts` (+ test), the machines DTO field, the fixtures, the two doc sections above.
- **Do not touch**: `packages/daemon/**`, `packages/orchestrator/**`, `packages/web/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] Schema tests: every fixture parses; T02's `git_tamper` alert fixtures still parse; `update_available` with `file` `../x.tgz`, a `version` not in `file`, or an uppercase or short `sha256` is rejected; `heartbeat` without `draining` still parses.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T18c · Daemon: self-update, launcher rollback, opt-out
- **Scope** ([ADR-0021](../../adr/0021-daemon-auto-update.md) §1–§4).
  - `packages/daemon/src/update/` (`updater.ts`, `stage.ts`, `drain.ts`). The daemon acts on `update_available`, and on close 4005 via `GET <enrolled url>/downloads/latest.json`. It skips the update when `auto-update` is `off`, the version is in `<root>/daemon/bad-versions`, the version is already `current`, or a drain for it is cooling down.
  - **Stage** (in the background):
    - download with `redirect: 'manual'` and `isSecureOrLoopback`, under the size cap, and check the SHA-256;
    - list the archive with `tar -tzf` and refuse absolute paths, `..`, links escaping the archive, and devices; unpack with `tar -xzf --no-same-owner`;
    - run `bin/conductor-daemon --version` with a 10 s timeout and check it prints `version`, then rename the result to `<root>/daemon/<version>`;
    - on any failure, delete the staging dir and send `alert update_failed`.
  - **Drain**:
    - stop `request_work`, send `heartbeat.draining`, and keep honouring queued commands;
    - wait until no live Claude turn, `run_cmd` or `run_action` is in flight (parked sessions don't count);
    - give up after `UPDATE_MAX_DRAIN_MS`: resume work, send `alert drain_timeout`, and start the cooldown. Stop trying that version after `UPDATE_MAX_DRAIN_ATTEMPTS`.
  - **Switch**: write `<root>/daemon/trial`, repoint `current` by renaming a temp symlink over it, and exit `EXIT_RESTART_FOR_UPDATE`. When `CONDUCTOR_SUPERVISED` is unset, only stage and log once.
  - Trial in the new version: delete `trial` on the first `registered`. If the socket opened (or an HTTP status came back) but no `registered` arrived within `UPDATE_TRIAL_REGISTER_MS`, exit 75. With no network, keep waiting.
  - At start: if `bad-versions` has an entry not yet reported, send `alert update_failed` stage `trial` once and record it as reported. After a commit, delete every version except `current` and the previous one.
  - `assets/conductor-launch.sh` (T18's launcher) gains the trial logic: `attempts` += 1. When it exceeds `UPDATE_MAX_TRIAL_ATTEMPTS`, repoint `current` to `from`, append `to` to `bad-versions` and delete `trial`; then `exec` the daemon. POSIX `sh` with no bash-isms: it must work with macOS `/bin/sh` and with dash.
  - `conductor-daemon config auto-update on|off` (default `on`) in `commands/config.ts`.
- **Design refs**: ADR-0021; ADR-0017 §Daemon distribution; 10-contracts §Daemon auto-update, §Orphaned processes, §Refusals (resume after `no_live_process`).
- **Depends on**: T18 (launcher, units, exit code 78), T18b.
- **Files owned**: `packages/daemon/src/update/**` (+ tests), `packages/daemon/assets/conductor-launch.sh` (+ its test), the update hooks in `daemon.ts` / `ws-client.ts` (the request_work gate, the heartbeat field, the 4005 branch), `commands/config.ts` (the `auto-update` key).
- **Do not touch**: `workspace.ts`, `inventory/**`, `claude/**`, `credential.ts`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `update/stage.test.ts`, with a local http server and a temp `<root>`: a good tarball lands in `<root>/daemon/<version>`. A wrong SHA-256, an oversize file, a `../evil` entry, an absolute path, a symlink to `/etc` and a `--version` mismatch each leave nothing behind and raise one `update_failed` with the right `stage`. A redirect is not followed.
  - [ ] `update/drain.test.ts` (fake daemon state, fake clock):
    - no `request_work` after the drain starts;
    - a running turn blocks the switch, and its end releases it;
    - a parked (`ask_user`) session doesn't block;
    - at the 6 h limit, work resumes and an alert goes out; the 1 h cooldown and the 3-attempt stop hold;
    - `auto-update off` ignores the frame, and so does a version in `bad-versions`.
  - [ ] Switch: `current` points at the new version, `trial` is written and the process exits 75. Unsupervised: the build is staged, `current` is unchanged and the process doesn't exit.
  - [ ] `assets/conductor-launch.test.ts` runs the launcher under `sh` (and `dash` when present) with a fake daemon:
    - the first and second starts keep the new version;
    - the third start rolls back, writes `bad-versions` and `exec`s the old version;
    - with no `trial` file it is a plain `exec`;
    - the symlink swap is a rename (`current` is never missing).
  - [ ] Trial: `registered` deletes `trial`. Socket open with no `registered` in 120 s exits 75. An unreachable server causes no exit within 10 min (fake clock).
  - [ ] Close 4005 fetches latest.json and runs the same flow.
  - [ ] A parked session survives an update restart: after the restart, an answer is refused `no_live_process` and resumes (the existing path; a daemon-level test with the fake runner).
  - [ ] **QA step (lead)**: on Ben's Mac under launchd, serve a newer build from a local orchestrator. The daemon drains, restarts on it, and the Machines page shows the new version. Then serve a build whose `run` exits 1: after two failed starts it rolls back and the `update_failed` alert is visible.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T18d · Orchestrator: announce updates, latest.json, draining, update alerts
- **Scope** ([ADR-0021](../../adr/0021-daemon-auto-update.md) §1–§3).
  - Gateway: after sending `registered`, if a build is served and `isOutdated(register.daemon_version, servedVersion(build))`, send `update_available` from the served `DaemonBuild`. Not through the outbox.
  - `distribution.ts`: `GET /downloads/latest.json` returns a `LatestDaemonSchema` body with `Cache-Control: no-store`. It returns 503 with the dev hint when no build is served, like `/install.sh`.
  - When `heartbeat.draining` is present, set `machine.status = 'draining'`. When it's absent from a later heartbeat or register, set it back to `online`. Draining machines get no new claims (the claim already takes only `online` machines; confirm and test).
  - `alert` `update_failed` ingest: deduped on seq like `git_tamper` (T16's ingest), stored machine-level, and returned on the machines list (T17) as `alerts`. If T16/T17 storage has no machine-level slot, **stop and report**: a migration needs Ben.
- **Design refs**: ADR-0021; 10-contracts §Daemon auto-update; M2-T14 `distribution.ts`.
- **Depends on**: T14, T16 (alert ingest), T17 (machines list), T18b.
- **Files owned**: the register / heartbeat / alert branches in `src/gateway/**` for these fields, `src/distribution.ts` (latest.json), the machines list's `alerts` field, `test/gateway-update*.test.ts`, the `test/distribution*.test.ts` additions.
- **Do not touch**: `src/auth/**`, `packages/daemon/**`, `packages/web/**`, `docs/tracking/*`.
- **Migration**: no (stop and report if one turns out to be needed).
- **Acceptance**:
  - [ ] `test/gateway-update.test.ts`: an outdated v2 daemon gets exactly one `update_available` per register, with the served file and SHA-256. A current daemon gets none, and so does any daemon when no build is served. Nothing is written to the outbox.
  - [ ] `latest.json` matches the served build, and returns 503 without one.
  - [ ] `heartbeat.draining` sets `draining` and no claim is granted; a clean heartbeat sets `online` again.
  - [ ] An `alert update_failed` is stored once per seq and listed on the machine.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T18e · Web: update states on the Machines page
- **Scope**: on the Machines page (T11):
  - a machine with `status = 'draining'` shows "Updating to <version>: waiting for running work";
  - an `update_failed` alert shows "Update to <version> failed (<stage>), rolled back to <current>" with its error;
  - the existing "outdated" mark stays.
- **Depends on**: T11, T18d.
- **Files owned**: `packages/web/src/machines/**` for these states (+ tests).
- **Do not touch**: other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `Machines.test.tsx` renders all three states from fixtures.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M2-T19 · Orchestrator: engine and stream scoping
- **Scope.** ADR-0012 §Tenancy enforcement for the engine and streams:
  - `contracts.ts`: `EngineService.applyEvent(scope: AccountScope, sessionId, event, opts)`; `BoardBus` and `OutputBus` publish and subscribe per `account_id`; `FakeEngineService` and the in-memory buses updated.
  - `engine/**` (except `seed.ts`): every SQL statement filters or writes `account_id` (the session row is loaded with `WHERE id = $1 AND account_id = $2`; an unknown or foreign id is `not_found`); `event` and `outbox` rows are written with the session's `account_id`; `reopen.ts` and `sweep.ts` scoped; the dispatcher only sends a row to a machine of the row's account (else the row waits and logs).
  - `stream/**`: the board SSE subscribes to the caller's account; `Last-Event-ID` replay filters `event.account_id`; the output stream checks the session's account before streaming.
  - Call sites: `api/index.ts` and `api/sessions.ts` pass `request.auth.scope`; `gateway/*` passes the connection's scope.
  - 10-contracts §EngineService wrapper and §Board events updated.
- **Design refs**: ADR-0012 §Tenancy; 10-contracts §EngineService wrapper, §Board events and the event table, §Outbox state machine.
- **Depends on**: T08, T09, T12, T16, T17 (all their files settled first).
- **Files owned**: `src/contracts.ts`, `src/engine/**` except `seed.ts`, `src/stream/**`, the `applyEvent` call sites in `src/api/*.ts` and `src/gateway/*.ts`, `test/engine/**`, `test/stream/**` (new), 10-contracts sections above.
- **Do not touch**: `auth/**`, `api/machines.ts` (other than call sites), migrations, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/engine/scope.test.ts`: `applyEvent(scopeB, sessionOfA, …)` → `not_found` and no `event` or `outbox` row; a normal event writes rows with A's `account_id`.
  - [ ] `test/stream/board-isolation.test.ts`: account B's board stream receives none of A's events, live or on a `Last-Event-ID` replay; B's output stream for A's session → 404.
  - [ ] `test/engine/dispatcher.test.ts`: an outbox row of A is never sent to B's connected machine.
  - [ ] Every existing engine, API and gateway test and `pnpm test:e2e` pass.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T20 · Orchestrator: leases and the reaper
- **Scope.**
  - **Authority**: [10-contracts](../../design/10-contracts.md#machines-protocol-v2) §Machines protocol v2 "Lost machines", "Fencing (R5)" and "Revoke and the outbox (R4)". Where this block and that section differ, 10-contracts wins.
  - `engine/reaper.ts`, run from the existing sweep loop: a session in `assigned` / `running` / `waiting_external` (**only** those; queued and parked sessions are never lease-reaped) whose `lease_expires_at` + the 2-minute grace has passed (heartbeats renew it, 04 §4) gets `machine.lost {reason: 'lease_expired', machine_name}` through `applyEvent` (T06's engine semantics; human question "<machine> stopped responding"). A reconnect before the lapse changes nothing.
  - **Pin SQL**: a `queued` session pinned to a machine (the reopen pin, TD-088, **or** a `__machine_lost` mark, which counts as a pin to `mark.machine_id`) whose machine has been offline for `PINNED_MACHINE_OFFLINE_AFTER_MS` gets `pinned_machine_offline` (with `offline_ms`); when the pinned machine has `revoked_at` set, it gets reason **`revoked`** at once instead.
  - **Fencing**: add an applied (non-ignored) `machine.lost` to the EngineService wrapper's fencing-bump list in `engine/service.ts`, so the kill row and every later command carry the new token (apply never bumps).
  - **Supersede**: when a `revoked` reaches an already-parked session (case (B)), the wrapper closes the previous open `input_request` as superseded (`answer = '[superseded]'`, `answered_by = 'system'`) in the same transaction.
  - **Revoke**: T09's `revokeMachine` result (it has already failed the machine's pending / sent outbox rows) feeds `machine.lost {reason: 'revoked'}` for each non-terminal session of that machine (wired in `gateway/revoke.ts`' caller). Revoked sessions offer Cancel only.
  - **TD-088**: a reopened ticket pinned to a machine that has been offline longer than `CONDUCTOR_PIN_OFFLINE_MS` (default 15 min) goes to a human with `reason: 'pinned_machine_offline'`.
  - "Continue on <machine>": when the human takes it, the session is re-dispatched to the same machine once it is online (the reopen pin); the fenced `kill` stops a stale worker on reconnect.
  - Heartbeat lease renewal in `gateway/index.ts` checked (renew only for sessions of that machine and account).
  - 04 §4 and [08](../../design/08-failure-modes.md) laptop-sleep row updated.
- **Design refs**: ADR-0013 §Overlap (leases); U-068; 04 §4 Leases and fencing; 08; TD-088.
- **Depends on**: T06, T19.
- **Files owned**: `src/engine/{reaper.ts, sweep.ts}`, `src/engine/service.ts` (the fencing-bump list and the supersede on (B)), the heartbeat and revoke-hook lines in `src/gateway/index.ts` / `gateway/revoke.ts`, `test/engine/{reaper,service.machine-lost}.test.ts`, 04 §4, 08 (laptop sleep).
- **Do not touch**: `api/**`, `auth/**`, `gateway/claim.ts`, migrations, `shared/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `test/engine/reaper.test.ts` (fake clock): lease lapse → needs_input with the machine named; a heartbeat just before the lapse → nothing; a `needs_input` or `queued` session with an expired lease is not reaped; revoke → needs_input at once; a pinned reopen with its machine offline 15 min → needs_input (TD-088) and the ticket `in_progress`; a pinned reopen whose machine is revoked → `revoked` at once (Cancel only); a queued session with a `__machine_lost` mark is treated as pinned; "Continue" re-dispatches to the same machine when it reconnects, and the stale worker gets the fenced `kill`.
  - [ ] `test/engine/service.machine-lost.test.ts`: an applied `machine.lost` bumps `fencing_token` and the kill row carries the new token; a late event from the old worker with the old token is refused `stale_fencing_token` (moved here from T06); an ignored one doesn't bump; a `revoked` on a parked session closes the old request as `[superseded]` in the same transaction.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T21 · Orchestrator: REST scoping, isolation proofs, cleanup
- **Scope.**
  - Every handler in `src/api/**` (`index.ts`, `queries.ts`, `sessions.ts`, `machines.ts`) and `api/queries.ts` takes `request.auth.scope` and every SQL statement filters `account_id`; a foreign id → 404; `answered_by`, `created_by` and `operator.*` actors are the user id (U-042). Split `api/index.ts` into route modules if it helps stay readable.
  - **Route-matrix test** `test/isolation/route-matrix.test.ts` (ADR-0012 §Proving isolation 2), generated from `API_PATHS`: account A creates one of everything (ticket, session, input request, machine, workflow version, invite as admin); for every route, account B calls it with A's ids and gets 404 or an empty list; a route missing from the matrix's table of "how to call it" fails the test; no `GET` writes a row (row counts before and after).
  - **SSE matrix**: B's board and output streams see nothing of A's (reuses T19's helpers).
  - **Unscoped-query lint** `test/isolation/unscoped-sql.test.ts` (ADR-0012 §Proving isolation 4): scans `src/**/*.ts` for SQL touching a scoped table without `account_id`, with a reviewed allow-list (the claim's joins, migrations, instance-level auth tables).
  - Migration `<ts>_drop-account-defaults.sql`: drop the T03 `DEFAULT` on every `account_id` (the `-- TD:` comments go; pays TD-109); drop `machine_repo.tree_clean`; drop `register.enrollment_token` and `repo_inventory` from the protocol schemas, and remove the daemon's `repo_inventory` send (the T10 `// TD:` site; a few lines in `packages/daemon`; pays TD-110). Collapse the duplicated enums `MachineRepoModeSchema` / `MachineAlertKindSchema` (`domain.ts`) onto `machines/`' `WorkingCopyModeSchema` and alert kind, re-exporting one from the other (pays TD-108; T23 fixes the doc).
- **Design refs**: ADR-0012 §Tenancy, §Proving isolation; 10-contracts §REST error map.
- **Depends on**: T15, T17, T19.
- **Files owned**: `src/api/**`, `test/isolation/**`, `test/api*.test.ts`, the new migration, the two deprecated fields in `shared/src/protocol/ws.ts`, the two duplicated machine enums in `shared/src/domain.ts` (TD-108), the `repo_inventory` send in `packages/daemon/src/inventory/report.ts`.
- **Do not touch**: `engine/**`, `gateway/**`, `auth/**` (call only), `docs/tracking/*`.
- **Migration**: **yes**. Ben approves before merge.
- **Acceptance**:
  - [ ] The route-matrix, SSE and unscoped-SQL tests pass, and each fails on a planted bug (a self-test: an unscoped query string in a fixture file; a route added to `API_PATHS` without a matrix entry).
  - [ ] After the migration, an insert without `account_id` fails (test).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T22 · E2E: accounts, machines, routing, isolation
- **Scope.** `e2e/m2.e2e.test.ts` and harness changes in `e2e/harness/**`:
  - the harness can start the orchestrator in `password` mode on loopback (`CONDUCTOR_PUBLIC_URL=http://127.0.0.1:<port>`), run `conductor-admin bootstrap`, sign up admin A, invite and sign up user B (cookies handled by the harness client), create enrollment tokens and enroll fake daemons with `conductor-daemon enroll`;
  - scenarios:
    1. A's machine A1 has `org/a`; B's machine B1 has `org/a` too; a ticket of A is claimed by A1 only, B sees nothing of it on board, SSE or machine list;
    2. A has two machines, A1 with `org/x` and A2 with `org/y` and `gh` authed; a ticket for `org/y` goes to A2; a ticket needing `az` waits with the routing badge, then is claimed after A2 sends an inventory with `az` authed;
    3. sign-up without an invite → refused; a reused invite → refused;
    4. a full `conductor` v2 personal ticket through `Done` in password mode with the fake `claude` and fake `gh` (the M1b path, now authenticated);
  - the M1 and M1b suites still run in `local` mode unchanged.
- **Design refs**: ADR-0012 §Proving isolation; ADR-0013; ADR-0017; [e2e/README.md](../../../e2e/README.md).
- **Depends on**: T13, T15, T16, T18, T20, T21.
- **Files owned**: `e2e/m2.e2e.test.ts`, `e2e/harness/**`, `e2e/README.md`.
- **Do not touch**: `packages/**` (report bugs; the lead routes fixes), `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `pnpm test:e2e` green: the four scenarios plus every M1 / M1b scenario; total run time stays under 3 minutes on Ben's Mac.
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T23 · Docs sweep
- **Scope.** Make the design docs describe what M2 built: [00](../../design/00-overview.md) (tenancy, hosted), [01](../../design/01-architecture.md) (topology diagram with nginx and compose), [02](../../design/02-data-model.md), [03](../../design/03-protocols.md), [04](../../design/04-scheduler.md), [07](../../design/07-multi-session-isolation.md), [08](../../design/08-failure-modes.md), [09](../../design/09-security-and-budgets.md), [10](../../design/10-contracts.md), checked against the code. Implementation notes at the end of ADR-0012, ADR-0013 and ADR-0017 (what differs from the text, with file pointers). `README.md`: "Run hosted" pointing at `docs/setup/deploy-gradyserver.md` and `docs/setup/add-a-machine.md`; CLAUDE.md §Commands gains `conductor-admin` and the deploy scripts.
- **Design refs**: all M2 ADRs and tasks.
- **Depends on**: T21 (the code is final).
- **Files owned**: `docs/design/**`, `docs/adr/0012*`, `0013*`, `0017*` (implementation notes only), `README.md`, `CLAUDE.md` §Commands.
- **Do not touch**: `packages/**`, `e2e/**`, `docs/tracking/*`, `docs/plan/**`.
- **Migration**: no.
- **Acceptance**:
  - [ ] A QA agent reading each doc against the code finds no contradiction (listed per doc in the QA notes).
  - [ ] Every link in the changed docs resolves (`grep -o '](\.\./[^)]*)'` check or a link checker).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (docs are prettier-ignored, so this only proves nothing else changed).

### M2-T24 · E2E: laptop sleep, lease lapse, revoke
- **Scope.** `e2e/m2-leases.e2e.test.ts` with a short lease (`CONDUCTOR_LEASE_MS` or the existing interval setting lowered for the test):
  1. kill the fake machine's socket mid-session and let the lease lapse → the card is in Needs input with "<machine> stopped responding"; reconnect; "Continue on <machine>" → the session resumes and reaches Done;
  2. drop the socket and reconnect **before** the lapse → nothing changes, the session finishes;
  3. revoke a machine with a live session from the Machines REST route → its socket closes within 5 s, the daemon exits and the card is in Needs input with "<machine> was revoked";
  4. a machine with `protocol_version: 1` is refused with close 4005.
- **Design refs**: ADR-0013 §Overlap (laptop-sleep e2e); U-068; 04 §4.
- **Depends on**: T22 (harness).
- **Files owned**: `e2e/m2-leases.e2e.test.ts`; additive helpers in `e2e/harness/**` only.
- **Do not touch**: `packages/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `pnpm test:e2e` green with these four scenarios, no flake in 3 consecutive runs (`for i in 1 2 3; do pnpm test:e2e || exit 1; done`).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T25 · Deploy to conductor.gradyserver.com
- **Who**: the lead, over `ssh -p 1024 bengrady4@gradyserver.com`, with the steps marked **(Ben)** done by Ben. Not a dogfood ticket. Follows `docs/setup/deploy-gradyserver.md` and fixes the runbook wherever reality differs (a docs commit on a `m2-t25-deploy` branch).
- **Steps**:
  1. (lead) First-time checks on the server. **Verified 2026-10-26**:
     - host port 3040 is free;
     - subnet `192.168.80.0/24` (gateway `192.168.80.1`, the `CONDUCTOR_TRUSTED_PROXY`) is free; existing networks are 172.20–172.31/16 (172.31.0.0/16 is interviewme-agent), 192.168.32.0/20 and 192.168.48.0/20;
     - existing sites declare `limit_req_zone` in `/etc/nginx/conf.d/<app>-ratelimit.conf` (e.g. `reso-ratelimit.conf`: `limit_req_zone $binary_remote_addr zone=reso_mcp:10m rate=10r/s;`), so `conductor-ratelimit.conf` there matches the pattern.

     The upgrade map always ships as `conductor-websocket.conf` (`$conductor_connection_upgrade`), whatever other sites define. Still to check at deploy time: re-run `ss -ltn` and `docker network ls` in case something changed; wildcard DNS with `dig +short conductor.gradyserver.com`.
  2. (lead) `deploy/gradyserver/deploy.sh <main sha>`: creates `~/deploy/conductor/.env`, builds, migrates, starts; the orchestrator answers `curl -fsS http://127.0.0.1:3040/healthz` on the server.
  3. **(Ben, sudo)** read, then run `sudo ~/deploy/conductor/current/deploy/gradyserver/install-nginx-site.sh <email for Let's Encrypt>`: nginx files, certificate via `certbot certonly --webroot -w /var/www/html`, `nginx -t`, reload.
  4. (lead) `deploy/gradyserver/smoke.sh https://conductor.gradyserver.com` passes.
  5. (lead) Nothing to copy: the server database starts fresh (U-073). From here on, Ben's dogfood tickets move from the pinned local board to the hosted one (U-075).
  6. **(Ben)** `docker compose -p conductor exec orchestrator conductor-admin bootstrap` (the lead can run it and hand Ben the link); Ben signs up with his email and password.
  7. **(Ben)** Machines page → Add a machine → run the command on his Mac (with `--service` if he wants it at login); the page shows repos and capabilities.
  8. (lead + Ben) One dogfood ticket on the hosted board (a small docs fix in `github.com/benjgrad/conductor`) runs to a PR via Ben's Mac.
  9. (lead) Invite a second user (or a test identity Ben controls); they sign up and see an empty board; ten wrong passwords lock their email.
  10. (lead) `deploy/gradyserver/install-cron.sh`; run `backup.sh` once; restore that dump into a scratch database on the server and count tickets (runbook's restore test).
  11. (lead) Revoke a scratch machine from the page; it disconnects within 5 s.
- **Depends on**: T22, T23, T24, and Ben's approvals of every migration.
- **Acceptance**: each step above recorded with evidence (command output or screenshot) in the session log; the M2 exit criteria for hosting, enrollment and backups ticked.

### M2-T26 · Shared: Retry a failed move step
- **Why** (follow-up (c), dogfooding 2026-10-27): when a move step fails for a reason that isn't the agent's (open_pr errors, e.g. the push-credential and old-gh failures; a refused or timed-out check or action; conditions not met by `condition_timeout`; a reviewer with no verdict), the session goes to `on_unmet.else` with "… Retry, skip, or abort?", but a `conductor` v2 card only offers "Back with this answer" (sends the **agent** back), "Waiting on someone else" and "Done". There is no way to just run the step again.
- **Scope** (decided here; the lead approves the semantics with the PR). In `packages/shared` only:
  - **Retry point**: whenever a gate step (an ADR-0011 move step, or an ADR-0010 entry step; [05](../../design/05-workflow-engine.md) §Transitions, §Requirements to enter a column) leaves for `on_unmet.else` or the fallback human, apply stores `context.__retry = RetryPoint {kind: 'move' | 'entry', from, to, transition?, actor?, reason?, label, failed_phase: 'checks' | 'review' | 'actions' | 'conditions', head_sha | null, input_request_id, attempts}` (`RETRY_CONTEXT_KEY`, no migration; validator rule 8 reserves the name). It is cleared when the session enters any state other than through `$retry`.
  - **`$retry`** (`RETRY_TRANSITION`, a reserved name like `$return_to`; real transition names are lower_snake_case, so it can't collide): a `human.transition {name: '$retry'}` accepted only while `needs_input` with a `__retry` point whose `input_request_id` is the open request and `attempts < MAX_HUMAN_RETRIES` (3). Otherwise `transition_not_allowed` (409). It re-enters the same gate step **without an agent turn** (no `start_session` for the worker, no `send_input`); the wrapper's existing gate-step rule bumps the fencing token:
    - `failed_phase` `actions` or `conditions`, with a `head_sha`: resume **at that phase** with the stored `head_sha` as `expected_sha`. Checks and review that already passed are not re-run: they are bound to that commit, and `open_pr` refuses to push if the branch tip moved, so this is safe. Actions get a fresh idempotency key `<session>:<label>:<visit>:retry<attempts>` (the failed attempt's key may be cached as failed by the daemon). Conditions restart with a fresh `conditions_deadline`;
    - `failed_phase` `checks` or `review`, or no `head_sha`: **re-run the whole step** from the checks phase (the commit is re-pinned).
    - The step's counters (`move:<from>:<name>`, `entry:<to>`) are **not** reset or incremented by `$retry`: an unmet result after a retry routes exactly as before (to `on_unmet.goto` while the counter allows, else to a human). `attempts` increments on each `$retry`; at 3 the button is no longer offered (bounded; Back / Waiting / Done / Cancel remain).
  - **Card**: `humanTransitionsOfCard` (`shared/src/api/rest.ts`) adds `{name: '$retry', title: 'Retry <step label>', needs_text: false}` first when the rule above allows it. The web already renders `human_transitions` as buttons; T26 adds no web code unless that turns out false (then it reports it, and the lead adds a small web task).
  - The `/transition` request's `name` accepts `$retry` (extend the schema in `shared/src/api/` if it doesn't). The open request is answered `[retry]` by the move (the existing human-transition path).
  - Docs: 05 §Transitions (a "Retry" bullet) and [10](../../design/10-contracts.md) §Transitions (`$retry`, `RetryPoint`, `MAX_HUMAN_RETRIES`).
- **Engine invariants**: a human transition (an outcome); bounded by `MAX_HUMAN_RETRIES` and the step's own timeouts; every failure of the retried step still ends at `on_unmet.goto` (counted) or a human; state and commands in one apply; actions keep idempotency keys (new key per retry).
- **Design refs**: [ADR-0011](../../adr/0011-transition-rules.md); [ADR-0010](../../adr/0010-one-workflow-columns-are-states.md) (entry steps, open_pr); 05 §Transitions, §Conditions, §Requirements to enter a column; 10-contracts §Transitions, §EngineService wrapper; [06](../../design/06-human-input.md) (the "Retry, skip, or abort?" questions).
- **Depends on**: T06 (the only other M2 task that edits `shared/src/engine/apply.ts`).
- **Files owned**: `packages/shared/src/engine/{apply.ts, retry.ts (new), types.ts (additive: RetryPoint, RETRY_CONTEXT_KEY, RETRY_TRANSITION, MAX_HUMAN_RETRIES)}`, `shared/src/api/rest.ts` (`humanTransitionsOfCard`, the transition request name), the validator's reserved-name list, their tests; 05 and 10-contracts (the sections above).
- **Do not touch**: `packages/orchestrator/**`, `packages/daemon/**`, `packages/web/**`, `shared/src/machines/**`, `shared/src/protocol/**`, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `engine/apply.retry.test.ts`: an `open_pr` action error on a `personal_pr_ready_for_review` move → needs_input with `__retry {failed_phase: 'actions', head_sha}` and "Retry" first in `humanTransitionsOfCard`; `$retry` → the step resumes at `actions` with the same `expected_sha` and a `:retry1` idempotency key, **no** `start_session` for the worker and no `run_cmd` (checks not re-run); the action succeeding → the target (`needs_input`, PR ready) is entered as for a normal pass.
  - [ ] Conditions timed out → `$retry` restarts the conditions phase with a new deadline, nothing else re-runs. A refused check → `$retry` re-runs the step from the checks phase.
  - [ ] An unmet check after a retry routes to `on_unmet.goto` while the counter allows (counter unchanged by `$retry` itself). After 3 retries `$retry` → `transition_not_allowed` and the card no longer offers it.
  - [ ] `$retry` with no retry point, or for a request that isn't the open one → `transition_not_allowed`; entering any state any other way clears `__retry`.
  - [ ] `apply.property.test.ts` includes `$retry` and stays green at 1 000 runs (bounded: every run ends at a target, a counted goto, or a human).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

---

### Agent permissions and fresh bases (2026-10-28)
Two dogfood sessions stalled on 2026-10-28:
- **M2-T18b ("Hazel")** planned from a base cut before ADR-0021 merged. The daemon clone is never fetched (TD-026), and planning has no shell, so it couldn't refresh.
- **M2-T18 ("Nova")** had 18 calls silently denied (pnpm, chmod, diff, prettier, `git update-index`). The machine has no `defaultMode`, prompts are `none`, and `bash` allows only npm. Its build check also ran npm in a pnpm repo.

Ben's decisions:
- fetch per session now (T13a);
- an agent and human "update from main" (T27, T27b);
- auto mode with prompts to the board (ADR-0023: T29–T29d);
- both-layer settings, viewable and editable per machine (ADR-0022: T28–T28e);
- pnpm-aware checks (T30).

The lead fast-forwarded the daemon clone and Hazel's branch by hand (the interim workaround).

**Order and file ownership:**
- T13a, T28, T29 and T30 can run in parallel.
  - T13a: `workspace.ts` and the start_session section of `daemon.ts`.
  - T28 and T29: shared protocol and design docs, with disjoint sections.
  - T30: `actions/checkout.ts` install/scripts and `tools.ts` `bash`.
- T27 needs T13a.
- T29b owns `claude/cli-driver.ts` and `claude/outcome-server.ts`. T27 also adds an MCP tool there, so **T27 runs after T29b** (or rebases onto it).

### M2-T13a · Daemon: fetch per session
- **Scope.** The "fetch per session" slice of T13, on today's M1 `cloneSource` path (reference and checkout modes stay in T13):
  - In `Workspace.ensureWorktree`, before creating a **new** worktree:
    - run `git -c core.hooksPath=/dev/null fetch origin <default_branch>`;
    - serialise it per repo, so concurrent session starts don't race;
    - branch from `origin/<default_branch>`, not `HEAD`.
  - `<default_branch>` comes from `start_session.working_copy.default_branch` when present. Otherwise it is the clone's `origin/HEAD` (set once with `git remote set-head origin --auto`).
  - A failed fetch fails the start with a clear error. No silent stale base (T13's acceptance).
  - Existing worktrees and branches (resume, reopen) are reused untouched.
  - The `// TD-026` comment is updated.
- **Design refs**: TD-026, U-030; T13 block above (its first acceptance item is this task's); 07 §Code.
- **Depends on**: T10.
- **Files owned**: `packages/daemon/src/workspace.ts`, the start_session section of `daemon.ts`, `workspace*.test.ts`, 07 §Code (one paragraph).
- **Do not touch**: `claude/**`, `actions/**`, other packages, `docs/tracking/*`.
- **Migration**: no.
- **Acceptance**:
  - [ ] `workspace.fresh-base.test.ts`, with a temp bare origin:
    - clone, push X, start a session: its base contains X;
    - push Y, start a second session: its base contains Y;
    - a resumed session (same id) reuses its worktree and is not rebased;
    - an unreachable origin fails the start with an error that names the repo.
  - [ ] Two concurrent `ensureWorktree` calls on one repo run one fetch at a time (no `index.lock` / `shallow.lock` errors).
  - [ ] Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

### M2-T27 · Daemon + shared: `update_branch`
- **Scope.**
  - New `packages/daemon/src/actions/update-branch.ts`. In the session worktree it runs:
    1. `git fetch origin <default_branch>` (T13a's helper);
    2. `git merge --no-edit origin/<default_branch>`.
  - It refuses a dirty tree in a read-only state.
  - On conflict it runs `git merge --abort` and returns the conflicting paths.
  - It returns `{merged, from, to}` or `{conflict: string[]}` or `{refused: reason}`.
  - Conductor MCP tool `update_branch` (`claude/outcome-server.ts`) is offered in every state. It doesn't end the turn.
  - New `inspect` alias in `shared/src/workflow/tools.ts` = `REVIEW_GIT_COMMANDS` (exact rules). `conductor.v1/v2.json` planning becomes `["read","inspect"]`.
  - Planning prompt (`shared/src/engine/render.ts`): "If a file the ticket cites is missing, call `update_branch` before planning."
  - Session events carry `permission_denials {count, tools[]}` from `stream-parser.ts` (today dropped in `daemon.ts`).
- **Design refs**: ADR-0023 §5; 03-protocols §MCP tools; 10-contracts.
- **Depends on**: T13a; after T29b (shares `outcome-server.ts`).
- **Files owned**: `actions/update-branch.ts`, the outcome-server tool registration, `shared/src/workflow/tools.ts` (`inspect` only), `workflows/conductor.v*.json` planning `tools`, `render.ts` plan prompt line, the session-event denial field, their tests, docs sections.
- **Do not touch**: `workspace.ts` (import only), orchestrator, web, `docs/tracking/*`.
- **Acceptance**:
  - [ ] Unit tests: clean fast-forward; true merge; conflict, aborted with the paths listed and the tree clean; dirty tree refused in planning.
  - [ ] e2e: a fake-Claude planning turn calls `update_branch` after a commit lands on origin, then reads the new file.
  - [ ] A denied tool call shows up as `permission_denials.count ≥ 1` on the session event.
  - [ ] Gates.

### M2-T27b · Orchestrator + web: "Update from main"
- **Scope.**
  - `POST /api/sessions/:id/update-branch` (owner of the ticket). Allowed only when the session has no live turn (`needs_input`, `needs_permission`, or between states); otherwise 409.
  - The orchestrator sends daemon command `update_branch {session_id}` with an idempotency key. The daemon runs T27's action and replies with the result.
  - The result goes in the session log and a toast. The ticket drawer gets the button.
- **Depends on**: T27. **Acceptance**: a route test (409 during a live turn; the result is stored); a web test; the e2e path; gates.

### M2-T28 · Contracts: layered agent settings
- **Scope** ([ADR-0022](../../adr/0022-layered-agent-settings.md); Ben approves the ADR before T28b starts):
  - Contract sections in 10-contracts and 03-protocols:
    - `machine_settings` (machine_id PK, override jsonb, version, updated_by, updated_at) plus a `machine_settings_audit` table;
    - `GET/PUT /api/machines/:id/settings`;
    - WS `settings_update {version, override}` and an ack `{version, applied | refused, reason?}`;
    - inventory `reported_settings`.
  - The zod schemas in `shared/src/protocol` and `shared/src/api`, additive, so M1/M2 daemons still parse.
- **Files owned**: those schema files, the doc sections. **Acceptance**: schema round-trip tests; an old daemon's inventory still parses; gates.

### M2-T28b · Shared: effective policy
- `resolveEffectivePolicy(stateTools, override, ceiling)` returns `{builtin, allow, deny, permissionMode}`, with the ADR-0022 invariants. A save-time validator returns field errors.
- **Acceptance**:
  - [ ] `git push` can't be un-denied.
  - [ ] `Bash`, `Bash(*)`, `Bash(git diff:*)` and `Read(//**)` are rejected.
  - [ ] The ceiling values `deny_only` and `off` behave as the ADR says.
  - [ ] Gates.

### M2-T28c · Orchestrator: machine settings
- Migration; routes (owner/admin only, account-scoped); audit rows; push `settings_update` on register and on PUT; store the daemon's ack and `reported_settings`.
- **Acceptance**:
  - [ ] Route tests, including cross-account 404.
  - [ ] A migration up/down test.
  - [ ] The push happens on reconnect.
  - [ ] Gates.

### M2-T28d · Daemon: apply settings
- Persist the override in `<root>/state/settings.json` (0600).
- Apply it in `resolveToolPolicy` and in the permission-mode choice, under the `config.json` `remote_settings` ceiling (`conductor-daemon config remote-settings full|deny_only|off`).
- Report `reported_settings`; remove the credential.
- Pays TD-081.
- **Acceptance**:
  - [ ] The override changes the next session's argv, not a running one.
  - [ ] `off` ignores it and acks `refused`.
  - [ ] Gates.

### M2-T28e · Web: Settings tab
- `MachineDrawer` Settings tab with three parts:
  - **Reported**: read-only `reported_settings`.
  - **Effective per state**: a table of tools, allow, deny and mode.
  - **Override editor**: states, aliases, exact rules, mode (bypass behind a confirm), timeout, limits.

  It shows API validation errors in place, plus the ack status ("applied v3" / "refused: remote_settings off").
- **Acceptance**: component tests against the mock API; gates.

### M2-T29 · Contracts: permission prompts
- **Scope** ([ADR-0023](../../adr/0023-permission-prompts-through-conductor.md)):
  - WS `permission_request {session_id, request_id, tool, input, suggestions?, expires_at}` (daemon → orchestrator).
  - `permission_decision {request_id, behavior: allow|deny, scope: once|always, message?}` (orchestrator → daemon).
  - Session sub-status `needs_permission`.
  - `GET /api/sessions/:id/permission-requests`, `POST /api/permission-requests/:id/decision`.
  - Doc sections in 10-contracts, 03-protocols and 08-failure-modes (timeout, daemon restart while held: deny on reconnect).
- **Acceptance**: schema tests; gates.

### M2-T29b · Daemon: auto mode + prompt tool
- `cli-driver.ts`:
  - `--permission-mode auto` for working agents (reviewers stay `dontAsk`);
  - `--permission-prompts host --permission-prompt-tool mcp__conductor__permission`;
  - an unsupported Claude version falls back to today's flags and raises a machine alert.
- `outcome-server.ts` `permission` tool:
  - sends `permission_request` and awaits the decision;
  - on timeout (default 30 min) or daemon shutdown, returns a deny with a reason;
  - returns the Claude permission-prompt-tool JSON (`{behavior, updatedInput?, message?}`).
- ADR-0006 notes updated.
- **Acceptance**:
  - [ ] argv tests.
  - [ ] A held call resolves on allow, on deny and on timeout.
  - [ ] `git push` never reaches the tool (deny first).
  - [ ] A real-Claude probe noted in the PR: one prompt round-trip with haiku.
  - [ ] Gates.

### M2-T29c · Orchestrator: permission requests
- Store requests; set and clear `needs_permission` in the same transaction as the board update (SSE); decision route (ticket owner) → `permission_decision` with an idempotency key.
- "Always" appends an exact rule: to the ticket's `session_allow` until T28c, then to the machine override.
- **Acceptance**: route tests; idempotent double decision; the card leaves `needs_permission` after a decision or expiry; gates.

### M2-T29d · Web: Needs permission
- Card badge and drawer panel. They show the tool and its input (a command shown as code; long input collapsed) and three buttons: **Allow once**, **Allow always**, **Deny** (with a note).
- **Acceptance**: component tests; gates.

### M2-T30 · Package-manager-aware checks
- `actions/checkout.ts` picks the install step from the lockfile:

  | Lockfile | Install command |
  |---|---|
  | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
  | `yarn.lock` | `yarn install --immutable` |
  | `package-lock.json` | `npm ci` |
  | none | `npm install` |

  Workflow check scripts run with the same manager (`pnpm run <script>`).
- The `tools.ts` `bash` alias adds `Bash(pnpm run:*)`, `Bash(pnpm test:*)`, `Bash(pnpm install)`, `Bash(pnpm i)`, `Bash(pnpm exec vitest:*)`, `Bash(pnpm exec prettier:*)` and `Bash(chmod +x:*)`, with the same TD-019 caveat.
- **Files owned**: `actions/checkout.ts` (install and script runner only; T13 owns its push URL source), `shared/src/workflow/tools.ts` (`bash` only), tests.
- **Acceptance**:
  - [ ] Checkout tests for each lockfile.
  - [ ] Alias rule tests.
  - [ ] A pnpm fixture repo's build check passes in e2e.
  - [ ] Gates.

## Risks
- **No Docker on Ben's Mac**: the Dockerfile and compose file are first built on gradyserver. Mitigation: T07 and T14 have a lead QA step that runs `docker build` there before merge, and T25 starts with a dry build.
- **Scoping is spread across T03 → T21**: the temporary `account_id` defaults let a missed scope slip until T21. Mitigation: no second user exists until T25; T21's route matrix, SSE matrix and SQL lint are the gate, and drop the defaults.
- **A long chain (ten groups)** for one milestone run as dogfood tickets. Mitigation: three lanes (orchestrator, daemon, web) run side by side; contracts first so lanes don't wait on each other's code.
- **The dogfood instance and main's migrations** (U-075): if Ben's local conductor ran on `main`, M2 migrations would land under it mid-milestone. Mitigation: run it pinned to the M1b build with its own database until T25.
- **Shared nginx on a multi-site server**: a bad config could take Ben's other sites down. Mitigation: conductor-prefixed names, `nginx -t` before reload, backups restored on failure, Ben reads the script before running it.
