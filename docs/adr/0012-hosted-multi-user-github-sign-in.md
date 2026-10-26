# ADR-0012 · Hosted multi-user: Sign in with GitHub, and every row belongs to an account

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M2)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26)
- **Resolves**: the web-user half of [U-008](../tracking/UNKNOWNS.md) and [U-042](../tracking/UNKNOWNS.md) (who answered). The machine half of U-008 is [ADR-0013](0013-machine-enrollment-inventory-routing.md).
- **Supersedes**:
  - [00-overview](../design/00-overview.md)'s "Tenancy: one organization";
  - [ROADMAP](../plan/ROADMAP.md)'s "Multi-tenancy" out-of-scope line;
  - [09](../design/09-security-and-budgets.md)'s "UI auth: TBD, M1 runs on localhost only", for hosted installs.

## Context
M1 runs on Ben's laptop: no login, one implicit owner, and M1-T14's localhost guards (Host allow-list, Origin check, JSON-only POSTs) are the only protection. Ben decided (2026-10-26) that conductor will be **hosted and multi-user**, with **Sign in with GitHub**. Agent work, chat and summaries still run on each user's **own machines** with their own Claude subscription ([ADR-0011](0011-transition-rules.md) machine-first conditions, [ADR-0015](0015-triage-and-assistant-on-the-users-machine.md)).

So the server holds tickets, workflows, events and machine records for people who must never see each other's. It holds no third-party credentials ([ADR-0016](0016-work-connectors-on-the-users-machine.md)).

## Decision
**The orchestrator is a GitHub OAuth client used only to identify people. Each person signs in, belongs to an account, and every row, query, stream and socket is scoped to that account. The scoping is proved by a test that runs every route and message as a second account.**

### Sign-in
- A GitHub **OAuth App** (not a GitHub App), with no scopes beyond reading the public profile (`read:user`). The server never calls GitHub on a user's behalf after login. The access token GitHub returns is used once to read `id` and `login`, then discarded.
- Flow: `GET /auth/github` (state + PKCE, stored in a short-lived signed cookie) → GitHub → `GET /auth/github/callback` → upsert `app_user (github_id, login, name, avatar_url)` → create a web session.
- **Session cookie**: an opaque 256-bit random id, stored as a SHA-256 hash in `web_session (id_hash, user_id, account_id, created_at, last_seen_at, expires_at)`. Cookie `__Host-conductor_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. 30 days sliding, revoked by `POST /auth/logout` or by deleting the row.
- **Allow-list**: `CONDUCTOR_ALLOWED_GITHUB_LOGINS` (or an `invite` row) decides who may sign up at first. Open sign-up is a later decision.
- **Local mode** stays: `CONDUCTOR_AUTH=local` keeps today's loopback-only behaviour with one implicit account `local`. Dev and `pnpm test:e2e` use it. A hosted install must set `CONDUCTOR_AUTH=github` and refuses to start with `local` on a non-loopback bind.

### Tenancy
- New tables: `account (id, name, created_at)`, `account_member (account_id, user_id, role: owner|member)`. On first sign-in a user gets a personal account where they are `owner`. Shared (team) accounts use the same tables but are not built in M2 (U-051).
- **`account_id uuid NOT NULL` with a foreign key** on `ticket`, `session`, `machine`, `workflow_definition`, `input_request`, `event` and `outbox`, and on every later table (enrollment tokens, OAuth clients, summaries, chat). Child rows also carry it (denormalised), so each query filters on its own table without a join. `workflow_definition`'s primary key becomes `(account_id, id, version)`.
- **Per-account `conductor`**: each account has its own versioned `conductor` workflow, seeded from the shipped default when the account is created. The ADR-0011 seed-upgrade rule ("newer shipped version, and the account hasn't edited it") applies per account.
- **Enforcement in code**, not in the database:
  - every repository function takes an `AccountScope {account_id, actor}` as its first argument, and every SQL statement in it filters or writes `account_id`;
  - REST and SSE get the scope from the session cookie (or, in M3, from the OAuth access token); the WS gateway gets it from the machine credential ([ADR-0013](0013-machine-enrollment-inventory-routing.md));
  - an id from another account is **404**, never 403, so ids leak nothing;
  - `BoardBus` and `OutputBus` publish per account; the SSE `Last-Event-ID` replay filters `event.account_id`;
  - the claim only matches `ticket.account_id = machine.account_id`;
  - the outbox dispatcher only sends to a machine of the row's account.
- Postgres row-level security is **not** used at first. It is the backstop if a scoping bug ever ships (revisit).
- **Audit**: `answered_by`, `created_by` and `operator.*` events record the user id, not `'ui'` (closes U-042).

### Proving isolation (the test strategy)
1. **Schema test**: every table except an explicit allow-list (`app_user`, `web_session`, `account`, `account_member`, migration bookkeeping) has `account_id NOT NULL` with a foreign key to `account`.
2. **Route matrix test**: built from `API_PATHS`, so a new route is covered automatically or the test fails. Account A creates one of everything (ticket, session, input request, machine, workflow version). For every route, account B calls it with A's ids and expects 404 (or an empty list); for SSE, B's board stream receives none of A's events, before or after a replay.
3. **Gateway test**: a machine of account B can't claim, report events for, ack commands for, or fetch transcripts of account A's sessions.
4. **Unscoped-query lint**: a test that fails if a SQL string under `orchestrator/src/` touches a scoped table without `account_id` (with a reviewed allow-list for the claim's joins and migrations).

### Deployment shape
- One orchestrator process (it already serves the API, SSE, the daemon WebSocket and the static web app on one port). TLS terminates at a reverse proxy or the platform's edge; the orchestrator trusts `X-Forwarded-*` only from the configured proxy.
- Managed Postgres 16, with backups. Migrations run as a separate release step, never at boot.
- Daemons dial `wss://<host>/ws/daemon`.
- One instance at first. ADR-0001's row-lock claims are already replica-safe, but the in-memory `OutputBus` and `BoardBus` are not (ADR-0003's revisit trigger); a second instance waits until that trigger fires.
- The platform (and its cost) is Ben's choice (U-057).

### Security changes against M1-T14
| M1-T14 guard | Hosted (`CONDUCTOR_AUTH=github`) |
|---|---|
| Host must be loopback or `CONDUCTOR_ALLOWED_HOSTS` | Host must be the host of `CONDUCTOR_PUBLIC_URL` |
| Origin check on unsafe methods | Kept; the only allowed origin is `CONDUCTOR_PUBLIC_URL` (no Vite ports, TD-069 gone) |
| 415 unless `application/json` | Kept: with `SameSite=Lax` it is the CSRF defence |
| WS upgrade: Origin check only | A machine credential is **required** (ADR-0013); closes TD-059 |
| No user identity | Every `/api/*` route needs a valid session cookie (401 otherwise); static files stay public |
| `CONDUCTOR_ALLOW_LOCAL_REPOS` for tests | Refused at startup in github mode |

Login, callback and enrollment routes get per-IP rate limits. Error bodies gain the codes `unauthorized` and `forbidden` (pays TD-070).

## Alternatives considered
| Option | Why not |
|---|---|
| Email + password, or magic links | Passwords to store and mail to send. Every user already has GitHub, and their machines already use `gh` |
| A GitHub App with repo permissions | Would let the server touch repos; Ben's rule is that the work happens on the user's machine. Sign-in needs only identity |
| A database per account, or a schema per account | Many migrations and pools for a few users; the shared schema with `account_id` is simpler and is what the isolation tests check |
| Row-level security from day one | Needs `SET LOCAL` on every pooled connection, and gives confusing failures in tests. Kept as the backstop |
| Keep single-tenant and host one instance per user | Ben asked for multi-user; one instance each multiplies hosting cost and upgrades |

## Consequences
- **Good:**
  - conductor can leave localhost;
  - every action has a named actor;
  - one test catches scoping mistakes in new routes, because it is generated from `API_PATHS`.
- **Bad / accepted cost:**
  - a migration touching every table, with a backfill into a `local` account (U-056);
  - every repository signature changes;
  - a hosted service has its own running cost and an operator (Ben).
- **Follow-ups:** M2 tasks; U-051 (shared accounts), U-056 (migrating existing data), U-057 (hosting platform); [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md) reuses the session for OAuth consent.

## Revisit when
A scoping bug reaches `main` (turn on RLS), a team wants a shared account (U-051), or a second orchestrator instance is needed (ADR-0003's trigger).
