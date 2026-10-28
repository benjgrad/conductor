# M3 · Tool layer & MCP server (ADR-0014)

> **Approved by Ben 2026-10-27**, as written and with every proposed default (U-054, U-069, U-092..U-096 resolved). [ADR-0014](../../adr/0014-tool-layer-and-oauth-mcp-server.md) is accepted. M3 runs **right after M2r**, before the rest of M2.
>
> **The hosted instance stays single-account until M2-T21** (confirmed by Ben 2026-10-27; TD-149). No second account is created on https://conductor.gradyserver.com until T21's route matrix (with `/mcp` and `/api/oauth/*`) is merged. M3's own two-account tests run only in test databases.

**Goal** ([ADR-0014](../../adr/0014-tool-layer-and-oauth-mcp-server.md)):
- one internal tool layer exposes conductor's operations, with compact, size-capped, paginated results (ADR-0014 §1–§3);
- an MCP client (Claude Code, claude.ai, Claude Desktop) reaches it at `https://conductor.gradyserver.com/mcp` over stateless Streamable HTTP. It first completes OAuth 2.1 with conductor as the authorization server: discovery, dynamic registration, PKCE S256, conductor's own sign-in, then a consent page;
- tokens are opaque, hashed, bound to `/mcp`, scoped to one account, rate-limited, audited and revocable from **Connected apps**;
- a **Connect Claude** page shows how to connect each client and confirms the connection works.

**Placement and M2 dependencies**:
- **After M2r** (ADR-0020). `take_transition` must know Ready to merge and `requires.approvals`, and M2r edits the same transition handler that M3-T03 refactors.
- **Before the rest of M2** (T12, T13, T15b, T16, T18–T24, T26) and before M2c and M2b.
- What M3 needs from M2 is already merged: auth core (T08, T08b), bootstrap and CLI (T15a), machines REST (T17), distribution (T14), admin routes (T15b1), and the live you-only deploy.
- **Not needed**: M2-T15b (general sign-up). Grants belong to existing users.
- **Needed before any second account** (not before M3): M2-T16 / T19 / T21 isolation (TD-149). M3's tools scope every query themselves (ADR-0014 §1) and M3-T13 adds a two-account tool test. Still, no second account is created on the hosted instance until T21's route matrix covers `/mcp` and `/api/oauth/*`. M2-T21 must add them, and this file adds that note to its scope.
- **Overlap with M2-T22 (password-mode e2e harness)**: M3-T14 builds the minimum it needs (bootstrap, sign-up, log in). M2-T22 reuses or replaces it.
- **Overlap with M2b-T03**: none. M3 audits writes in `mcp_tool_call` and the event payload, and doesn't add `event.ticket_id`.
- **Overlap with M2c-T02**: M3-T04's `splitBodySections` / `renderRequirementsBody` are the minimum. M2c-T02's `parseTicketBody` builds on them, in the same `shared/src/tickets/` folder.

**Exit criteria**:
- Every task below except T18 and T19 (later) is `done` and QA'd.
- The eleven tools exist with zod input and output schemas. The REST routes that overlap call the same services (T03).
- Against a board seeded with 500 tickets, every tool's serialised result is ≤ 8 KB (a test per tool), and `tools/list` is ≤ 12 KB.
- `pnpm test:e2e` is green with M3-T14's scenario: the official TypeScript SDK client discovers, registers, signs in, consents, gets tokens, calls tools, refreshes, is refused after revocation, and a read-only grant can't write.
- Two-account isolation over `/mcp` (T13): account A's token sees nothing of account B.
- M3-T15's security review of the authorization server passes, with its fixes merged.
- **Ben**, on https://conductor.gradyserver.com:
  - connects Claude Code (`claude mcp add --transport http conductor https://conductor.gradyserver.com/mcp`) and lists his tickets;
  - adds the claude.ai custom connector and creates a ticket from it;
  - sees both on Connected apps, revokes one, and the next call is refused.

**Not in M3**:
- `set_dependencies` / `create_ticket.depends_on` (T18, after M2b-T08), and requirement evidence in `get_ticket` plus a `record_verification` tool (T19, after M2c-T08);
- `update_workflow` (dropped, ADR-0014 §3);
- stored model summaries (M4; M3 serves the deterministic one);
- MCP resources, prompts, sampling, elicitation, and server-initiated streams (GET `/mcp` is 405);
- Client ID Metadata Documents (U-092) and CORS for browser-based clients (U-096);
- an external identity provider;
- a second orchestrator instance.

**Blocking unknowns**: none. Ben resolved each of these on 2026-10-27 with its default:
- [U-054](../../tracking/UNKNOWNS.md) rate limits (ADR-0014 §6), used by T13 and T07;
- [U-069](../../tracking/UNKNOWNS.md) scopes and confirmation (ADR-0014 §5), used by T05, T08 and T10;
- U-092 CIMD (T08: metadata says `false`);
- U-093 approvals over MCP (T10: refused);
- U-094 grant lifetime, the refresh-reuse grace and the password-change cascade (T12);
- U-095 audit retention and logging reads (T02, T13);
- U-096 CORS (T08: none).

## Task board

| ID | Task | Depends on | Group | Migration (Ben approves) | Status |
|---|---|---|---|---|---|
| M3-T01 | **Contracts**: tool input/output schemas, size constants, cursor and ticket-ref formats, OAuth DTOs and metadata schemas, consent and grants DTOs, `SessionDetail.mcp_activity`, `API_PATHS`; 10-contracts §Tool layer and MCP | M2r done | A | — | todo |
| M3-T02 | Migration: OAuth tables, `mcp_tool_call`, `ticket.create_key`, `ticket.search` + GIN; row types; schema allow-list | T01 | B | **yes** | todo |
| M3-T03 | Orchestrator: ticket services (create, answer, transition, reopen, cancel) extracted from the routes; REST calls them | T01 | B | — | todo |
| M3-T04 | Shared: pure helpers (`capResult`, cursor codec, `parseTicketRef`, `deterministicSummary`, `splitBodySections`, `renderRequirementsBody`) | T01 | B | — | todo |
| M3-T05 | Web: the consent page `/consent?request=` | T01 | B | — | todo |
| M3-T06 | Web: Connect Claude (`#/connect`) and Connected apps (`#/settings/apps`) | T01 | B | — | todo |
| M3-T07 | Deploy kit: nginx `/mcp` and OAuth locations, zones, smoke checks, nginx tests | T01 | B | — | todo |
| M3-T11 | Web: "via <client> (MCP)" on the timeline and the MCP activity list in the detail panel | T01 | B | — | todo |
| M3-T08 | Orchestrator OAuth (1): discovery metadata, registration, authorize, consent REST, Origin exemptions | T02 | C | — | todo |
| M3-T09 | Orchestrator: the read tools and the tool registry; the 500-ticket size tests | T02, T04 | C | — | todo |
| M3-T10 | Orchestrator: the write tools on T03's services; audit (`via`, `mcp_tool_call`), `SessionDetail.mcp_activity` | T02, T03, T04 | C | — | todo |
| M3-T12 | Orchestrator OAuth (2): token endpoint (code + PKCE, refresh rotation and reuse), revoke, grants REST, revocation cascades, `verifyAccessToken` | T08 | D | — | todo |
| M3-T13 | Orchestrator: `/mcp` (SDK stateless transport, bearer, scopes, cap, rate limits, audit hook), two-account isolation test | T09, T10, T12 | E | — | todo |
| M3-T14 | E2E: the official SDK client through OAuth and the tools, in password mode | T05, T06, T13 | F | — | todo |
| M3-T15 | Security review of the authorization server and `/mcp`, with fixes | T13 | F | — | todo |
| M3-T16 | Docs sweep: 01, 02, 09, 10, ADR-0014 accepted with notes, `docs/setup/connect-claude.md`, M2-T21 scope note | T14, T15 | G | — | todo |
| M3-T17 | **Deploy** (lead + Ben): migrate prod, nginx, smoke, Ben connects Claude Code and claude.ai | T07, T14, T15, T16 | H | runs T02's migration on prod | todo |
| M3-T18 | **Later**: `set_dependencies`, `create_ticket.depends_on`, dependencies and cycle in `get_ticket` | T13, M2b-T08 | later | — | todo |
| M3-T19 | **Later**: requirements and evidence page in `get_ticket`, the `record_verification` tool | T13, M2c-T08 | later | — | todo |

IDs follow ADR-0014's order; groups decide the order of work. Each task is one conductor ticket (≲ 400 lines changed, one package), except T17, which is the lead's.

**Ticket waves** (2026-10-28, TD-172): with no `depends_on` until M2b, a ticket goes on the hosted board only when every task it depends on is merged. `scripts/create-m3-tickets.js <ids>` posts each `### M3-Tnn` block below with the M3 rules appended (workflow `conductor_dev`, repo `github.com/benjgrad/conductor`, kind `personal`; T02 at priority 1). The waves are: A T01 (after M2r) · B T02 T03 T04 T05 T06 T07 T11 · C T08, T09, T10, each as its own deps merge · D T12 · E T13 · F T14 T15 · G T16. T17 is the lead's; T18/T19 are later.

**Shared files and ownership**:
- `shared/src/mcp/**`, `shared/src/api/oauth.ts`, `shared/src/api/rest.ts` (additions): T01 only. Later tasks report needed changes to the lead.
- `orchestrator/src/api/index.ts`:
  - T03 owns the ticket and session write handlers;
  - T08, T12 and T13 each add **one** `app.register(...)` line;
  - T10 adds the `mcp_activity` field in `api/sessions.ts` (the detail query), not in `index.ts`.
- `orchestrator/src/api/security.ts`: T08 only (the path exemptions).
- `orchestrator/src/oauth/**`: T08 creates it, T12 extends it (in sequence).
- `orchestrator/src/tools/**`:
  - T09 creates `registry.ts`, `read/*` and the `READ_TOOLS` export;
  - T10 creates `write/*` and `WRITE_TOOLS`;
  - T13 composes them in `mcp/*`.
- `orchestrator/src/auth/{admin-commands.ts, reset.ts, admin-routes.ts}`: T12 adds one call each (revoke grants).
- Web: T05 (`src/oauth/Consent*`, one route line in `App.tsx` / `main.tsx`), T06 (`src/connect/**`, `src/settings/**`, nav entries), T11 (`components/DetailPanel*` activity, `details-sections.tsx`). Only the router lines overlap; whichever lands second rebases.

**Migration**: **one**, in M3-T02. It adds five OAuth tables, the audit table and two `ticket` columns (`create_key`; `search` as a generated tsvector with a GIN index). Ben approves the SQL in T02's PR before it merges, and again before T17 runs it on the hosted database (backup first, as M2-T25's runbook says).

**Gates (Ben)**:
- before A: ~~accept ADR-0014, the defaults and this file~~ done 2026-10-27;
- after A: approve the 10-contracts diff (T01);
- T02: approve the migration;
- T17: run the sudo step for nginx, then connect Claude Code and claude.ai, and sign off.

---

## Task details

Each block below pastes into a ticket as-is. The **Goal / Context / Functional requirements / Non-functional requirements / Out of scope / Verification** sections follow ADR-0019. The fields after them (depends, files, acceptance) are for the lead.

### M3-T01 · Contracts
## Goal
Freeze every seam M3 needs, additively, so groups B–E build in parallel.

## Context
ADR-0014 §1–§4, §7 and §10. 10-contracts §Accounts and web auth is the pattern. Only this task edits these schemas in M3.

## Functional requirements
- **FR-1** `shared/src/mcp/constants.ts`:
  - `TOOL_RESULT_MAX_BYTES` 8192, `TOOLS_LIST_MAX_BYTES` 12288, `TOOL_DESCRIPTION_MAX` 700, `MCP_INSTRUCTIONS_MAX` 600;
  - `LIST_LIMIT_DEFAULT` 20, `LIST_LIMIT_MAX` 50, `SEARCH_MAX_HITS` 200;
  - the field caps (title 120, question 160, snippet 200, summary 1 200, page 6 KB, timeline page 25);
  - `MCP_SCOPES` (`conductor:read`, `conductor:write`).
- **FR-2** `shared/src/mcp/tools.ts`: the zod input and output schema of every tool in ADR-0014 §3:
  - `list_tickets`, `search_tickets`, `get_ticket_summary`, `get_ticket` (with the page union, §3a), `create_ticket` (`requirements` xor `body`, `idempotency_key`), `answer_input`, `take_transition`, `reopen`, `cancel`, `list_machines`, `get_workflow`;
  - the compact `TicketRowSchema`;
  - `ToolErrorSchema {error: {code, message, hint?}}` with the codes `not_found`, `ambiguous_ref`, `invalid_cursor`, `insufficient_scope`, `approval_required`, `conflict`, `invalid_input`, `rate_limited`, `wrong_state`;
  - `TOOL_META`: name → `{scope, annotations}`.
- **FR-3** `shared/src/mcp/refs.ts` (types only): the ticket ref grammar (a uuid, or 8..32 hex) and the cursor envelope `{v: 1, k, f}`.
- **FR-4** `shared/src/api/oauth.ts`:
  - `ProtectedResourceMetadataSchema`, `AuthorizationServerMetadataSchema`;
  - `ClientRegistrationRequest` / `Response` (RFC 7591 subset);
  - `TokenResponse`, `OAuthErrorResponse`;
  - `AuthRequestView {id, client_name, redirect_host, loopback, scopes_requested, account_email, expires_at}`;
  - `ConsentDecisionRequest {approve, scopes}` and `ConsentDecisionResponse {redirect_to}`;
  - `OAuthGrantRow {id, client_name, redirect_host, scopes, created_at, last_used_at, last_tool, revoked_at}`.
- **FR-5** `api/rest.ts`:
  - `API_PATHS`: `mcp`, `oauthRegister`, `oauthAuthorize`, `oauthToken`, `oauthRevoke`, `wellKnownAuthServer`, `wellKnownProtectedResource` (both forms), `oauthRequest(id)`, `oauthRequestDecision(id)`, `oauthGrants`, `oauthGrantRevoke(id)`;
  - `SessionDetail.mcp_activity?: [{at, tool, client_name, ok, summary}]` (≤ 20);
  - `apiPathTemplates()` includes them, so `isApiPath` and the route matrix see them;
  - `/consent` stays an SPA path.
- **FR-6** Fixtures for each, and **10-contracts §Tool layer and MCP (ADR-0014)**.

## Non-functional requirements
- **NFR-1** Additive only: every existing fixture and DTO still parses.
- **NFR-2** Every string field from a model or a client has a cap.

## Out of scope
Handlers, migrations, UI.

## Verification
- FR-1..FR-5: `mcp/tools.test.ts`, `api/oauth.test.ts` and `rest.paths.test.ts`. Fixtures parse, boundary sizes are refused, and `requirements` + `body` together is refused.
- NFR-1: the existing contract tests pass unchanged.
- An interface-review agent confirms that T02–T13 can be built from these contracts. Ben approves the 10-contracts diff.

- **Depends on**: M2r done. **Files owned**: `shared/src/mcp/**`, `shared/src/api/{oauth.ts, rest.ts (additions), fixtures.ts}`, export lines, `docs/design/10-contracts.md` §Tool layer and MCP. **Do not touch**: other packages, `docs/tracking/*`.
- **Acceptance**: [ ] the Verification tests; [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### M3-T02 · Migration: OAuth, audit and ticket search
## Goal
Create the tables ADR-0014 §4 and §7 describe, in one reversible migration.

## Context
ADR-0014 §4 (Data). ADR-0012's schema-isolation test: every table carries `account_id`, except the instance-level allow-list. **This migration needs Ben's approval.**

## Functional requirements
- **FR-1** The tables:
  - `oauth_client` (instance-level, added to the allow-list);
  - `oauth_auth_request`, `oauth_grant`, `oauth_code`, `oauth_token` and `mcp_tool_call`, each with `account_id NOT NULL` and foreign keys;
  - indexes: `oauth_token (token_hash)` unique, `oauth_token (grant_id)`, `oauth_grant (account_id, user_id) WHERE revoked_at IS NULL`, `mcp_tool_call (account_id, at)`, `mcp_tool_call (ticket_id, at)`.
- **FR-2** `ticket.create_key text NULL`, with a unique index on `(account_id, create_key) WHERE create_key IS NOT NULL`.
- **FR-3** `ticket.search tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title,'')), 'A') || setweight(to_tsvector('simple', coalesce(external_ref,'')), 'A') || setweight(to_tsvector('english', coalesce(body,'')), 'B')) STORED`, with a GIN index.
- **FR-4** Row types in `orchestrator/src/db/rows.ts` (or a new `db/oauth-rows.ts`).
- **FR-5** A down migration that drops everything it added.

## Non-functional requirements
- **NFR-1** On a copy of a 10 000-ticket database, the migration takes < 5 s (the generated column rewrites `ticket`). The time is recorded in the PR.
- **NFR-2** Token, code and auth-request columns hold only hashes (`bytea`, 32 bytes).

## Out of scope
Queries and handlers.

## Verification
- FR-1..FR-3: `schema-isolation.test.ts` passes with the new tables (only `oauth_client` on the allow-list); `migrations.m3.test.ts` checks up, down, up.
- NFR-1: a timing note in the PR. NFR-2: a schema test on the column types.

- **Depends on**: T01. **Files owned**: `orchestrator/migrations/17619…_mcp-oauth.sql`, `orchestrator/src/db/*rows*.ts`, `test/schema-isolation.test.ts` (the allow-list line). **Do not touch**: other migrations, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates; [ ] **Ben approves the SQL** in the PR.

### M3-T03 · Orchestrator: ticket services
## Goal
One implementation of each ticket write, called by REST now and by the tools in T10.

## Context
ADR-0014 §1. `api/index.ts` handles create, input, transition (with M2r's `approvals`), reopen and cancel inline. A pure refactor: no behaviour change.

## Functional requirements
- **FR-1** `orchestrator/src/services/tickets.ts`:
  - `createTicket(deps, scope, input, via)`, `answerInput(…)`, `takeTransition(…)` (finds the open input request, passes `approvals`), `reopenTicket(…)`, `cancelTicket(…)`;
  - each returns a result union (`ok` / `not_found` / `conflict` / `bad_request` / `approval_required`) instead of writing a reply;
  - each publishes board events as the routes do now.
- **FR-2** Each takes `via` and passes `actor` (`ui` for REST, `mcp` later) plus an optional `via` payload into the engine event. REST passes `{kind: 'rest'}` and keeps `actor: 'ui'`.
- **FR-3** Every service resolves the ticket or session **inside `scope.account_id`** first. Another account's id is `not_found`.
- **FR-4** The REST routes become thin: parse, call the service, map the result to HTTP exactly as today.

## Non-functional requirements
- **NFR-1** No change to any REST status, body or event. The existing API and e2e tests pass unchanged.

## Out of scope
New routes, tools, the engine's own scoping (M2-T19).

## Verification
- FR-1..FR-3: `services/tickets.test.ts` (DB), including a two-account `not_found` case for each service.
- FR-4 / NFR-1: `pnpm test` and `pnpm test:e2e` green with no test edits beyond imports.

- **Depends on**: T01. **Files owned**: `orchestrator/src/services/**`, the write handlers in `orchestrator/src/api/index.ts`. **Do not touch**: `engine/**`, `gateway/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates incl. `pnpm test:e2e`.

### M3-T04 · Shared: pure helpers for tool results
## Goal
The pure building blocks every tool uses to stay small and well-formed.

## Context
ADR-0014 §2 and §3; ADR-0019 §1 (the section format). M2c-T02 later builds `parseTicketBody` next to these.

## Functional requirements
- **FR-1** `capResult(value, budget = TOOL_RESULT_MAX_BYTES)` returns `{value, truncated, bytes}`:
  - it truncates the longest string fields first, with an `…[truncated]` marker, and then drops trailing array items while recording the count;
  - it never returns more than the budget.
- **FR-2** `fillPage(rows, budget)` takes rows until the next one would cross the budget, and reports whether it stopped early.
- **FR-3** `encodeCursor` / `decodeCursor({k, f})` (base64url JSON) and `filterHash(filters)`. A bad or mismatched cursor gives `invalid_cursor`.
- **FR-4** `parseTicketRef(s)` → `{uuid}` | `{prefix}` | error.
- **FR-5** `deterministicSummary(view)` → ≤ 1 200 chars. `view` holds the state, column and since-when, the last transition and its reason, the open question, `waiting_for`, the PR and the requirement count. The text is stable and readable, and has no markdown headings.
- **FR-6** `splitBodySections(md)` → ordered `[{key: 'goal' | 'context' | 'functional' | 'non_functional' | 'out_of_scope' | 'verification' | 'free_form' | 'other', heading, text}]`, using ADR-0019's case-insensitive H2 matching.
- **FR-7** `renderRequirementsBody(req)` writes ADR-0019's template with numbered `**FR-n**` / `**NFR-n**`.

## Non-functional requirements
- **NFR-1** All pure, with no I/O, in `shared/src/mcp/` and `shared/src/tickets/`.
- **NFR-2** `capResult` uses property-based tests: for random nested values, `bytes ≤ budget`.

## Out of scope
DB queries and tool handlers.

## Verification
- FR-1, FR-2, NFR-2: `mcp/cap.test.ts` (fast-check).
- FR-3, FR-4: `mcp/cursor.test.ts`, `mcp/refs.test.ts`.
- FR-5: `mcp/summary.test.ts`, with snapshots for six states.
- FR-6, FR-7: `tickets/sections.test.ts` (round trip: render → split gives the same sections).

- **Depends on**: T01. **Files owned**: `shared/src/mcp/{cap,cursor,refs-impl,summary}.ts`, `shared/src/tickets/sections.ts`, tests. **Do not touch**: T01's schema files, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T05 · Web: the consent page
## Goal
The user approves or denies an MCP client clearly, on a page that can't be framed or spoofed into a grant.

## Context
ADR-0014 §4 (Consent), §5 (write opt-in). ADR-0017 (CSRF via Origin + JSON). The page is a real path like `/signin`, outside the app shell.

## Functional requirements
- **FR-1** `/consent?request=<id>` loads `GET /api/oauth/requests/:id`. If there is no session, go to `/signin?next=` this path. An expired or unknown request shows "This request has expired. Start again from your app."
- **FR-2** The page shows:
  - "Allow **<client name>** to read and write your conductor tickets?" (the wording follows the scopes);
  - below the name, "Name given by the app; conductor can't verify it";
  - the redirect host, or "an app on this computer" for loopback;
  - the account email;
  - a Read line (always on) and a **Write** checkbox (checked when requested, absent when not requested).
- **FR-3** **Allow** / **Deny** post `ConsentDecisionRequest` and then `window.location.assign(redirect_to)`. Both buttons are disabled while the request is in flight.
- **FR-4** The web API client (`api/http.ts`, `api/mock.ts`) gains the consent calls.

## Non-functional requirements
- **NFR-1** Accessible: keyboard-only use works, the focus starts on Deny, and the labels are real labels.
- **NFR-2** No external assets. The page works under the existing CSP.

## Out of scope
Connected apps and the Connect page (T06).

## Verification
- FR-1..FR-3: `Consent.test.tsx` covers read only, read + write, write unchecked → scopes sent, deny, expired, no session → sign-in redirect.
- FR-4: `http.oauth.test.ts`.
- NFR-1: a keyboard test in `Consent.test.tsx`.

- **Depends on**: T01. **Files owned**: `web/src/oauth/**`, the `/consent` route line, the consent calls in `web/src/api/*`. **Do not touch**: `components/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates; [ ] a screenshot in the PR.

### M3-T06 · Web: Connect Claude and Connected apps
## Goal
Ben can connect Claude Code, claude.ai or Claude Desktop by copy and paste, see that it worked, and revoke any connection.

## Context
ADR-0014 §10. The copy buttons follow the Machines page's `CopyCommand` pattern (M2-T11 / UX-8).

## Functional requirements
- **FR-1** `#/connect` (account menu: "Connect Claude") has three tabs:
  - **Claude Code**: `claude mcp add --transport http conductor <ISSUER>/mcp` with a copy button, a note on `--scope user`, then "In Claude Code run `/mcp`, choose conductor, Authenticate";
  - **claude.ai**: Settings → Connectors → Add custom connector, with the name `conductor` and the URL `<ISSUER>/mcp` (copy);
  - **Claude Desktop**: the same connector, which syncs from the Claude account.
  - `ISSUER` is `window.location.origin`.
- **FR-2** **Verify**: while the page is open, it polls `GET /api/oauth/grants` every 5 s.
  - A grant created since the page opened shows "Connected: <client> · waiting for its first call".
  - After its first call, it shows "last call `<tool>` <n> s ago", with a suggested prompt ("What's waiting on me in conductor?").
- **FR-3** `#/settings/apps` (**Connected apps**) lists the grants: client (self-declared), redirect host, scopes, connected, last used and last tool.
  - Each has **Revoke**, with a confirm dialog, which then calls `POST /api/oauth/grants/:id/revoke` and removes the row.
  - The empty state links to `#/connect`.
- **FR-4** Nav entries (`nav.ts` routes `connect` and `settings/apps`), and mock data for both.

## Non-functional requirements
- **NFR-1** Polling stops when the page is hidden or closed.
- **NFR-2** The commands are exact strings, with no shell-unsafe characters and nothing hard-coded to gradyserver.

## Out of scope
Per-tool permissions and editing scopes (reconnect instead).

## Verification
- FR-1: `Connect.test.tsx` checks that the command text for an origin is exact.
- FR-2, NFR-1: `Connect.verify.test.tsx` (fake timers).
- FR-3: `ConnectedApps.test.tsx` covers list, revoke, empty state.
- FR-4: `nav` tests.

- **Depends on**: T01. **Files owned**: `web/src/connect/**`, `web/src/settings/**`, `nav.ts` (two routes), `AccountMenu.tsx` (one link), the grants calls in `web/src/api/*`. **Do not touch**: `oauth/**` (T05), `components/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates; [ ] screenshots.

### M3-T07 · Deploy kit: nginx for `/mcp` and OAuth
## Goal
nginx on gradyserver serves `/mcp` unbuffered and rate-limits the OAuth surface, using the same pattern as `os.gradyserver.com`.

## Context
ADR-0014 §9. `deploy/gradyserver/nginx/*`, `install-nginx-site.sh`, `smoke.sh`, `test/nginx-site.test.sh`. Ben runs the sudo step at deploy (T17).

## Functional requirements
- **FR-1** `conductor-ratelimit.conf` adds the `conductor_mcp` (10 r/s) and `conductor_oauth` (60 r/min) zones.
- **FR-2** The site gets `location = /mcp` (buffering and cache off, 300 s read and send timeouts, the five forwarding headers) and `location ~ ^/(oauth/|\.well-known/oauth-)` (30 s read timeout). No `add_header` inside a location.
- **FR-3** `smoke.sh` adds:
  - the two metadata documents return 200 JSON with `issuer` = the public URL;
  - `POST /mcp` without a token → 401 with `WWW-Authenticate` containing `resource_metadata=`;
  - `GET /mcp` → 405.
- **FR-4** `nginx-site.test.sh` asserts the new locations, the zones and the header inheritance rule.

## Non-functional requirements
- **NFR-1** `nginx -t` passes in the existing test container or harness.

## Out of scope
Running it on the server (T17).

## Verification
FR-1..FR-4, NFR-1: `deploy/gradyserver/test/run.sh` green.

- **Depends on**: T01 (paths). **Files owned**: `deploy/gradyserver/**`. **Do not touch**: `packages/**`, `docs/tracking/*`.
- **Acceptance**: [ ] the deploy tests; [ ] gates.

### M3-T08 · Orchestrator OAuth (1): discovery, registration, authorize, consent
## Goal
A client can discover conductor's authorization server, register itself, and get a signed-in user to a consent decision that yields a code.

## Context
ADR-0014 §4 (Endpoints, Registration, Authorize, Consent, Codes, CSRF), §6 (limits). ADR-0017 §Effect on M3.

## Functional requirements
- **FR-1** The metadata documents, exactly as ADR-0014 §4. `openid-configuration` is 404.
- **FR-2** `POST /oauth/register` (JSON):
  - validates the redirect URIs (https, or loopback http with any port; no fragment, userinfo or custom scheme) and the name;
  - returns 201 `{client_id, client_name, redirect_uris, token_endpoint_auth_method: 'none', grant_types, response_types}`;
  - errors use RFC 7591's `invalid_redirect_uri` / `invalid_client_metadata`;
  - the per-IP and global limits apply, and the pruning of clients with no grant.
- **FR-3** `GET /oauth/authorize`:
  - checks the client and redirect first (an error page, never a redirect);
  - then response type, S256 PKCE, scopes, resource and state (a redirect with `error`, `state` and `iss`);
  - with no session (password mode), 302 to `/signin?next=`;
  - with a session, stores `oauth_auth_request` (10 min, bound to the user and the web session) and 302s to `/consent?request=<id>`;
  - in local mode, the local user counts as signed in.
- **FR-4** `GET /api/oauth/requests/:id` → `AuthRequestView` (only for the same user and session; otherwise 404).
- **FR-5** `POST /api/oauth/requests/:id/decision`:
  - approve: create or replace the (user, client) grant (revoking the old one), issue a code (60 s, hashed), and answer `{redirect_to: redirect_uri?code&state&iss}`;
  - deny: `error=access_denied`;
  - a request decides once;
  - the 25-active-grants cap applies.
- **FR-6** `security.ts`: `/oauth/register`, `/oauth/token`, `/oauth/revoke` and `/mcp` skip the Origin rule; `/oauth/token` and `/oauth/revoke` accept `application/x-www-form-urlencoded`. The auth hook ignores the session cookie on those four paths.

## Non-functional requirements
- **NFR-1** Every secret is 32 random bytes, stored as SHA-256 and compared in constant time.
- **NFR-2** Responses on `/oauth/*` carry `Cache-Control: no-store`.

## Out of scope
The token and revoke endpoints and grants REST (T12); `/mcp` (T13).

## Verification
- FR-1: `oauth/metadata.test.ts`.
- FR-2: `oauth/register.test.ts` (each bad URI, limits, pruning).
- FR-3: `oauth/authorize.test.ts`. It covers every error branch, including a bad redirect that is never redirected to, `plain` PKCE refused, a foreign `resource` refused, and no session → sign-in.
- FR-4, FR-5: `oauth/consent.test.ts`. It covers another user's request → 404, decide twice → 409, replace a grant, deny, the cap.
- FR-6: `security.oauth.test.ts` (cookie ignored on `/mcp`; the Origin rule still enforced on `/api/oauth/*`).
- NFR-1/2: assertions in the same tests.

- **Depends on**: T02. **Files owned**: `orchestrator/src/oauth/{metadata,register,authorize,consent,secrets}.ts`, `api/security.ts`, one register line in `api/index.ts`, tests. **Do not touch**: `tools/**`, `services/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T09 · Orchestrator: the read tools
## Goal
Six read tools that answer from the account's data in compact, paginated results of at most 8 KB.

## Context
ADR-0014 §1–§3a. The board's column mapping (`toBoardCard`, `cardView`) is reused per workflow version and cached in memory per `(workflow_id, version)`.

## Functional requirements
- **FR-1** `tools/registry.ts`: `defineTool(...)` with the T01 schemas, and `READ_TOOLS`.
- **FR-2** `list_tickets`: a keyset over `(updated_at desc, id)`, with the filters column, kind, repo, `needs_input` and status. It returns compact rows (latest session, open input request, column) and pages with `fillPage`.
- **FR-3** `search_tickets`: `websearch_to_tsquery` over `ticket.search`, plus a short-id prefix match, ranked. It returns `snippet` (`ts_headline`, ≤ 200) and stops at 200 hits.
- **FR-4** `get_ticket_summary`: `deterministicSummary`, `transitions` (the current human transitions for the kind, with their `text` need), `waiting_for` and `pr`.
- **FR-5** `get_ticket`: the five pages of ADR-0014 §3a, with cursors.
- **FR-6** `get_workflow`: the outline or one state; `list_machines`: as in the table, with cursors.
- **FR-7** Ticket refs: a uuid, or a prefix of ≥ 8 hex. An ambiguous prefix gives `ambiguous_ref` with ≤ 5 candidates `{id, title}`.

## Non-functional requirements
- **NFR-1** Seeded with 500 tickets (long titles and bodies, 200 events each on 20 of them, 30 machines), every tool's every page is ≤ `TOOL_RESULT_MAX_BYTES` (a test per tool).
- **NFR-2** Each call runs ≤ 3 queries and takes < 50 ms on that seed (logged, not asserted in CI).
- **NFR-3** Every query has `account_id = $scope`.

## Out of scope
Writes, transport, audit.

## Verification
- FR-2..FR-7: `tools/read/*.test.ts` (DB).
- NFR-1: `tools/size.test.ts`.
- NFR-3: `tools/isolation.test.ts`: two accounts, and every tool given B's ids answers `not_found` or empty.

- **Depends on**: T02, T04. **Files owned**: `orchestrator/src/tools/{registry.ts, read/**, queries.ts}`, tests. **Do not touch**: `tools/write/**`, `api/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T10 · Orchestrator: the write tools and audit
## Goal
Five write tools that do exactly what the board's buttons do, recorded with the client's name.

## Context
ADR-0014 §3, §5, §7. T03's services. M2r's `requires.approvals`.

## Functional requirements
- **FR-1** `create_ticket`:
  - `requirements` → `renderRequirementsBody`;
  - `body` without a Functional requirements section → the warning `free_form_body`;
  - `idempotency_key` → `ticket.create_key` (a hit within 24 h returns the first ticket with `duplicate_ignored`);
  - the default `workflow_id` is the account's default;
  - returns `url` = `ISSUER/#/?ticket=<id>` (or the board's existing deep link).
- **FR-2** `answer_input`: idempotent. The same text again → `already: true`; a different text → `conflict`.
- **FR-3** `take_transition`:
  - an unknown or non-human name → `wrong_state`, listing the allowed names;
  - a transition whose `requires.approvals` applies → `approval_required` with the card URL (U-093).
- **FR-4** `reopen` and `cancel` call the services.
- **FR-5** Audit:
  - services get `actor: 'mcp'` and `via {client_id, client_name, user_id, grant_id}` in the engine event payload, and `answered_by = 'mcp'`;
  - `recordToolCall(...)` writes `mcp_tool_call` (with `args_digest` and a summary of at most 200 chars for writes).
- **FR-6** `api/sessions.ts`: `SessionDetail.mcp_activity` = the ticket's write calls (≤ 20, newest first).
- **FR-7** `WRITE_TOOLS` export with the annotations from `TOOL_META`.

## Non-functional requirements
- **NFR-1** Each write's result is ≤ 1 KB.
- **NFR-2** No rule is duplicated from the services; the tool only maps inputs and results.

## Out of scope
Transport, scope checks, rate limits (T13).

## Verification
- FR-1..FR-4: `tools/write/*.test.ts` (DB). They cover the template rendering, the duplicate key, answer twice, approval refused, cancel.
- FR-5, FR-6: `tools/audit.test.ts` (the event payload has `via`; detail lists the activity).
- NFR-1: assertions in the same tests.

- **Depends on**: T02, T03, T04. **Files owned**: `orchestrator/src/tools/{write/**, audit.ts}`, the `mcp_activity` part of `api/sessions.ts`, tests. **Do not touch**: `services/**` (T03; report needed changes), `tools/read/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T11 · Web: MCP activity on the ticket
## Goal
Ben can see which writes came from an MCP client, and which client, on the ticket.

## Context
ADR-0014 §7. `SessionDetail.mcp_activity` (T01), and `via` in the event payloads.

## Functional requirements
- **FR-1** Timeline entries whose payload has `via.kind = 'mcp'` show "via <client name> (MCP)", with a tooltip saying the name is self-declared.
- **FR-2** The Details tab gets an "MCP activity" list from `mcp_activity` (time, client, tool, summary, a failure mark), hidden when empty.
- **FR-3** Mock data includes one ticket created via MCP.

## Non-functional requirements
- **NFR-1** Pre-M3 details (no field) render unchanged.

## Out of scope
Filtering the board by client.

## Verification
FR-1..FR-3, NFR-1: `DetailPanel.mcp.test.tsx`.

- **Depends on**: T01. **Files owned**: `web/src/components/{DetailPanel.mcp.test.tsx, details-sections.tsx (one section), mcp-activity.tsx}`. **Do not touch**: `oauth/**`, `connect/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T12 · Orchestrator OAuth (2): tokens, revocation, grants
## Goal
Codes become tokens, tokens refresh safely, and any grant can be revoked from anywhere, immediately.

## Context
ADR-0014 §4 (Tokens, Revocation), §6. U-094's defaults.

## Functional requirements
- **FR-1** `POST /oauth/token` (form-encoded):
  - `authorization_code` checks the code (unused, unexpired), client, redirect URI, S256 verifier and resource. It issues an access token (1 h) and a refresh token (30 d). A reused code revokes the grant's tokens;
  - `refresh_token` rotates. A rotated token presented again within 30 s → `invalid_grant`; later → the grant is revoked;
  - responses `{access_token, token_type: 'Bearer', expires_in, refresh_token, scope}` with `no-store`; RFC 6749 error bodies.
- **FR-2** `POST /oauth/revoke` (RFC 7009): either token kind revokes its grant. It is always 200.
- **FR-3** `GET /api/oauth/grants` → `OAuthGrantRow[]` for the signed-in user. `POST /api/oauth/grants/:id/revoke` → `OkResponse` (another user's id → 404).
- **FR-4** Cascades: user disable, `POST /auth/reset` and `conductor-admin revoke-sessions` revoke all the user's grants. Password change does not.
- **FR-5** `verifyAccessToken(db, raw, now)` → `{scope, grant, client_name, scopes}` | `{error: 'invalid_token'}`. It is one query, requires the resource to be `ISSUER/mcp`, and touches `last_used_at` at most once a minute.
- **FR-6** Idle grants (30 days with no use) are refused, and are marked revoked lazily on use.

## Non-functional requirements
- **NFR-1** Token issue and rotation happen in one transaction per request, so two parallel refreshes can't both succeed.
- **NFR-2** Limits: `/oauth/token` 30/min per IP and per client.

## Out of scope
The `/mcp` endpoint (T13).

## Verification
- FR-1: `oauth/token.test.ts`. It covers a wrong verifier, wrong redirect, expired code, reused code → revoked, refresh rotation, reuse within and after 30 s, and a foreign resource.
- FR-2, FR-3: `oauth/revoke.test.ts`, `oauth/grants.test.ts`.
- FR-4: `oauth/cascade.test.ts`.
- FR-5, FR-6: `oauth/verify.test.ts`.
- NFR-1: a concurrent-refresh test.

- **Depends on**: T08. **Files owned**: `orchestrator/src/oauth/{token,revoke,grants,verify}.ts`, one call each in `auth/{admin-commands,reset,admin-routes}.ts`, one register line, tests. **Do not touch**: `tools/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T13 · Orchestrator: the `/mcp` endpoint
## Goal
MCP clients call the tools at `/mcp` with a bearer token, limited, capped and audited.

## Context
ADR-0014 §5–§8. `@modelcontextprotocol/sdk`, the version the daemon pins (1.32.1 today), as an orchestrator dependency.

## Functional requirements
- **FR-1** `POST /mcp`: the SDK `McpServer` with `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), handed the raw request through `reply.hijack()`. A new server instance is built per request from the grant's tools. GET and DELETE → 405.
- **FR-2** Bearer:
  - no token or a bad one → 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="conductor:read conductor:write"`, plus `error="invalid_token"` when a token was sent;
  - the cookie is never read.
- **FR-3** Scopes:
  - `tools/list` shows only the granted tools, each with its title, description, `inputSchema`, `outputSchema` and annotations;
  - a call outside the scopes → a tool error `insufficient_scope`.
- **FR-4** Every result goes through `capResult` and returns `structuredContent` plus one JSON text block. Handler exceptions → `{error: {code: 'internal'}}`, which is logged and isn't leaked.
- **FR-5** The server `instructions` (≤ 600 chars) as ADR-0014 §8 describes.
- **FR-6** Rate limits per ADR-0014 §6 (per grant, writes per grant, per account) → HTTP 429 + `Retry-After`.
- **FR-7** Every tool call records `mcp_tool_call` (`ok`, `error_code`, `duration_ms`, `result_bytes`, `truncated`, and `ticket_id` when there is one); daily pruning after 90 days (U-095).

## Non-functional requirements
- **NFR-1** `tools/list` ≤ 12 KB, and every description ≤ 700 chars (a test).
- **NFR-2** **Isolation**: two accounts, each with a grant. Every tool with B's ids under A's token → `not_found` or empty, and `list_tickets` / `search_tickets` / `list_machines` never show B's rows.
- **NFR-3** The Origin header is never needed and never trusted for auth.

## Out of scope
Stateful sessions, server-initiated streams, resources and prompts.

## Verification
- FR-1..FR-5: `mcp/endpoint.test.ts`, using the SDK **client** in-process against the Fastify server with a token issued by T12.
- FR-6: `mcp/ratelimit.test.ts` (fake clock).
- FR-7: `mcp/audit.test.ts`.
- NFR-1: `mcp/list-size.test.ts`. NFR-2: `mcp/isolation.test.ts`.

- **Depends on**: T09, T10, T12. **Files owned**: `orchestrator/src/mcp/**`, `orchestrator/package.json` (the SDK), one register line, tests. **Do not touch**: `tools/**` (report changes), `oauth/**`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates.

### M3-T14 · E2E: a real MCP client end to end
## Goal
Prove the whole flow with the official TypeScript SDK client against the real orchestrator bin, in password mode.

## Context
`e2e/` (M1-T10 harness). The SDK client uses `StreamableHTTPClientTransport` and an `OAuthClientProvider`. The "browser" part is driven over HTTP with a cookie jar.

## Functional requirements
- **FR-1** Harness:
  - the orchestrator runs with `CONDUCTOR_AUTH=password` and `CONDUCTOR_PUBLIC_URL=http://127.0.0.1:<port>`;
  - `conductor-admin bootstrap --email` gives an invite, then `POST /auth/signup` and `POST /auth/login` give a cookie;
  - a fake daemon or fake Claude as M1's e2e has, so `take_transition` can be exercised.
- **FR-2** Scenario 1, the full flow:
  1. the client connects → 401 → discovers both metadata documents → registers (loopback redirect);
  2. `redirectToAuthorization(url)` → the test follows the authorize URL with the cookie → `/consent?request=` → `GET` view → `POST` decision (Origin set) → follows `redirect_to` to the client's loopback listener → `finishAuth(code)`;
  3. it calls `create_ticket` (with `requirements`), `list_tickets`, `search_tickets`, `get_ticket_summary`, `get_ticket` (body page 2 via cursor), `answer_input` (after the fake agent asks), `take_transition`;
  4. it checks each result is ≤ 8 KB and the board shows the ticket "via e2e-client (MCP)".
- **FR-3** Scenario 2: the access token expires (short TTL via a test-only env var, or a clock), the client refreshes transparently, and the replayed old refresh token after 30 s revokes the grant.
- **FR-4** Scenario 3: revoke from `POST /api/oauth/grants/:id/revoke`, and the next call → 401.
- **FR-5** Scenario 4: a read-only consent. `tools/list` has no write tools, and calling `create_ticket` → `insufficient_scope`.

## Non-functional requirements
- **NFR-1** It adds < 20 s to `pnpm test:e2e` and needs no network (no real Claude, no GitHub).

## Out of scope
Real claude.ai or Claude Code (Ben's manual check, T17).

## Verification
FR-2..FR-5: `e2e/mcp-oauth.e2e.test.ts` green in `scripts/ci.sh`.

- **Depends on**: T05, T06, T13. **Files owned**: `e2e/mcp-*.ts`, `e2e/harness/password-mode.ts` (new, small). **Do not touch**: `packages/**` (report bugs), `docs/tracking/*`.
- **Acceptance**: [ ] e2e green; [ ] gates.

### M3-T15 · Security review of the authorization server
## Goal
An independent review of the OAuth server and `/mcp`, with every finding fixed or recorded as debt.

## Context
ADR-0014 §4–§6, the MCP spec's Security Best Practices (confused deputy, token passthrough, session hijacking), RFC 9700 (OAuth 2.0 Security BCP). The review is run by the `qa-reviewer` agent with a security brief.

## Functional requirements
- **FR-1** Review and test each of:
  - redirect URI validation (exact match; loopback port only; no open redirect from an error);
  - code reuse; PKCE downgrade (`plain`, missing, mismatched);
  - refresh rotation and reuse detection;
  - `resource` binding (a token used against `/api`; a foreign resource);
  - the consent page against clickjacking (headers) and CSRF (Origin);
  - the `next` path from authorize;
  - registration spam and the pruning;
  - timing-safe compares; token values never in logs;
  - the rate limits;
  - the cookie never read on `/mcp` and `/oauth/token`.
- **FR-2** Each issue found gets a failing test, then a fix, in this task's branch (orchestrator `oauth/**` and `mcp/**` only). Anything bigger becomes a TD row in the report.

## Non-functional requirements
- **NFR-1** The report lists each FR-1 item with its evidence (a test name or a command).

## Out of scope
Pen-testing the live server (T17 runs smoke checks only).

## Verification
FR-1, FR-2: `oauth/security.review.test.ts` plus the report in the PR body.

- **Depends on**: T13. **Files owned**: `orchestrator/src/{oauth,mcp}/**` (fixes), `oauth/security.review.test.ts`. **Do not touch**: `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates; [ ] the report.

### M3-T16 · Docs sweep
## Goal
The design docs and setup docs match what M3 built.

## Context
CLAUDE.md: "code and docs never knowingly disagree on `main`".

## Functional requirements
- **FR-1** 01 (components: tool layer, MCP), 02 (data model: the new tables and columns), 09 (security: OAuth, the Origin exemptions, rate limits) and 10 (any drift from T01).
- **FR-2** ADR-0014: implementation notes, with the status set to accepted once Ben signs off.
- **FR-3** `docs/setup/connect-claude.md` (the same steps as the Connect page) and the README link.
- **FR-4** M2-T21's scope gains `/mcp` and `/api/oauth/*` in the route matrix (a note in `M2-accounts-machines.md`).

## Non-functional requirements
None.

## Out of scope
Tracking files (the lead's).

## Verification
FR-1..FR-4: the qa-reviewer checks each doc claim against the code.

- **Depends on**: T14, T15. **Files owned**: `docs/design/**`, `docs/adr/0014-*`, `docs/setup/connect-claude.md`, `README.md`, the M2 note. **Do not touch**: `docs/tracking/*`.
- **Acceptance**: [ ] review passes.

### M3-T17 · Deploy (lead + Ben)
## Goal
MCP is live at https://conductor.gradyserver.com/mcp, and Ben uses it from Claude Code and claude.ai.

## Context
M2's deploy runbook (`deploy/gradyserver/`). nginx changes need Ben's sudo (`install-nginx-site.sh`).

## Functional requirements
- **FR-1** Lead: `backup.sh`, then deploy (`deploy.sh`), which runs T02's migration (Ben approved it).
- **FR-2** Ben: run `sudo deploy/gradyserver/install-nginx-site.sh`, which installs the zones and locations and runs `nginx -t` and a reload.
- **FR-3** `smoke.sh` is green, including T07's checks.
- **FR-4** Ben connects Claude Code (`claude mcp add --transport http conductor https://conductor.gradyserver.com/mcp`, then `/mcp` → Authenticate) and asks it to list his tickets.
- **FR-5** Ben adds the claude.ai custom connector and creates a throwaway ticket, which shows "via Claude (MCP)".
- **FR-6** Ben revokes the claude.ai grant on Connected apps, and claude.ai's next call fails and asks to reconnect.

## Non-functional requirements
- **NFR-1** The hosted instance stays single-account until M2-T21 (TD-149).

## Out of scope
Second accounts.

## Verification
FR-1..FR-6: recorded in the session log, with the smoke output.

- **Depends on**: T07, T14, T15, T16. **Files owned**: none (operations). **Acceptance**: the Verification above; Ben's sign-off of M3.

### M3-T18 · Later: dependencies over MCP
## Goal
An MCP client can queue a set of tickets with their dependencies in one go (ADR-0018 §5).

## Context
It needs M2b-T08's dependency service and its 409s.

## Functional requirements
- **FR-1** The `set_dependencies {ticket, depends_on[≤ 20]}` tool (write, idempotent) replaces the live set through the service and maps its 409s to tool errors.
- **FR-2** `create_ticket.depends_on?: ticket[≤ 20]`.
- **FR-3** `get_ticket` overview gains `depends_on`, `blocked_by` and `cycle`; list rows gain `blocked: bool`.

## Non-functional requirements
- **NFR-1** The size tests are extended, and every result is still ≤ 8 KB.

## Out of scope
Cycle messaging over MCP.

## Verification
`tools/write/dependencies.test.ts`, plus the extended size and isolation tests.

- **Depends on**: T13, M2b-T08. **Files owned**: `tools/write/dependencies.ts`, additions to T01's schemas (with the lead's approval).

### M3-T19 · Later: requirements and evidence over MCP
## Goal
An MCP client (Ben's QA in Claude Code) reads requirement status and posts verification (ADR-0019 §2).

## Context
It needs M2c-T08 (`POST /api/tickets/:id/verification`, the tally).

## Functional requirements
- **FR-1** The `get_ticket` page `requirements`: each FR/NFR with its status and layers (capped).
- **FR-2** The `record_verification {ticket, verdict?, entries[], notes?}` tool (write), through the M2c service.
- **FR-3** The `get_ticket_summary` summary includes the tally line.

## Non-functional requirements
- **NFR-1** ≤ 8 KB.

## Out of scope
Grading by the model on the server.

## Verification
`tools/read/requirements.test.ts`, `tools/write/verification.test.ts`.

- **Depends on**: T13, M2c-T08.

---

## Risks
- **Client quirks**: Claude Code, claude.ai and Desktop differ in discovery fallbacks, scope requests and the loopback redirect port. Mitigation: T14 uses the official SDK client, and T17 tests the real clients; fixes go in T15 or as a follow-up.
- **Context flooding by a chatty model**: the cap is per result, not per conversation. Mitigation: compact rows, `get_ticket_summary` first, the server `instructions`.
- **The MCP spec revision changes auth** (CIMD, scope step-up). Mitigation: metadata-driven discovery; U-092.
- **M2-T19/T21 land after M3** and touch the same services. Mitigation: T03 already scopes the services; T19 swaps `applyEvent` underneath them.
- **One instance, in-memory limits**: a restart resets the counters. This is acceptable for you-only; revisit at the second instance (ADR-0014 §Revisit).
