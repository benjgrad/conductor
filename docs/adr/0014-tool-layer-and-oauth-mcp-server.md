# ADR-0014 · One tool layer, served as an OAuth-protected MCP server, with results sized for a model's context

- **Status**: **accepted** (Ben, 2026-10-27, with every proposed default: U-054, U-069, U-092..U-096). Rewritten on 2026-10-27 as a concrete design for [M3](../plan/milestones/M3-mcp.md); implementation notes follow in M3-T16.
- **Amended by**: [ADR-0028](0028-simple-oauth-for-mcp.md) (2026-10-30): a simple subset of §3–§7 and §10 ships first (one scope, a server-rendered consent page, five tools, no audit table or Connected apps). This ADR stays the target design.
- **Date**: 2026-10-26; rewritten 2026-10-27 (M3 detailed plan)
- **Deciders**: Ben (+ Claude planning sessions 2026-10-26 and 2026-10-27)
- **Builds on**:
  - [ADR-0012](0012-hosted-multi-user-github-sign-in.md) §Tenancy (accounts, `AccountScope`, 404 for another account's id);
  - [ADR-0017](0017-own-sign-in-and-self-hosting.md) (conductor's own sign-in, web sessions, CSRF model, nginx on gradyserver);
  - [ADR-0011](0011-transition-rules.md) (named human transitions);
  - [ADR-0008](0008-transcript-history-and-reopen.md) (reopen);
  - [ADR-0018](0018-ticket-dependencies.md) §5 and [ADR-0019](0019-ticket-requirements-and-verification.md) §1 (dependencies, the ticket section format);
  - [ADR-0020](0020-review-and-merge-flow.md) (proposed; Ready to merge, `requires.approvals`).
- **Resolves**: [U-054](../tracking/UNKNOWNS.md) (rate limits), [U-069](../tracking/UNKNOWNS.md) (scopes, confirmation for writes) and U-092..U-096, with the defaults below (Ben, 2026-10-27).

## Context
Ben wants conductor available in the MCP clients he already uses (Claude Code, claude.ai, Claude Desktop), behind OAuth, the way his `reso` and `personal-os` MCP servers on gradyserver work. On 2026-10-27 he scheduled M3 **right after M2r**, before the rest of M2. conductor is live at https://conductor.gradyserver.com for him only.

The REST API returns what a browser needs: full cards, whole definitions, every version. Handed to a model as-is, a board of 200 cards or one workflow definition fills a large part of its context window. A model also can't page through results it was never given a cursor for.

The same operations will drive the in-app assistant later ([ADR-0015](0015-triage-and-assistant-on-the-users-machine.md), M4).

## Decision
**One internal tool layer (`packages/orchestrator/src/tools/`) defines every operation once, with a zod input, a zod output and a size cap. The MCP server at `/mcp` serves it over stateless Streamable HTTP. The orchestrator is its own OAuth 2.1 authorization server, whose login step is conductor's sign-in page and whose consent step is a conductor page. Tokens are opaque, hashed at rest, bound to `/mcp`, scoped to one account and revocable from a Connected apps page.**

### 1 · The tool layer
- A tool is `{name, title, description, input: ZodSchema, output: ZodSchema, scope: 'read' | 'write', annotations, handler(ctx, input)}`.
  - `ctx` is `{scope: AccountScope, via: {kind: 'mcp', grant_id, client_id, client_name} | {kind: 'chat'} | {kind: 'rest'}, now}`.
  - `annotations` are the MCP tool hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint: false`.
- **Handlers call the same services as REST.** M3-T03 moves ticket create, answer, transition, reopen and cancel out of the route handlers into `orchestrator/src/services/tickets.ts`, and the routes call them too. Tools add no rules of their own.
- **Isolation before M2-T19.** Every tool query is scoped to `ctx.scope.account_id`. A write first resolves the ticket inside the account, then calls the engine. Another account's id is "not found", exactly like an unknown id. M2-T19 later scopes `applyEvent` itself; the tools work the same either way.
- **Ticket references.** Every `ticket` input takes the full uuid or its **short id** (ADR-0018: the first 8 hex digits, or more). A prefix that matches several tickets in the account is an error that lists up to 5 candidates. Outputs carry the full `id`.
- **Results.** A tool result carries `structuredContent` (the output schema) plus one text block with the same JSON, as the MCP spec recommends for clients without `outputSchema` support.
- **Errors** are tool errors (`isError: true`) whose JSON is `{error: {code, message, hint?}}`. Messages are short and actionable, for example: `not_found` "No ticket 3f2a91c0 in this account. Try search_tickets."

### 2 · Size bounds (don't flood the caller's context)
| Rule | Value |
|---|---|
| Serialised `structuredContent` of any result | ≤ **8 KB** (`TOOL_RESULT_MAX_BYTES` = 8192) |
| Every tool's `description` | ≤ 700 characters |
| The whole `tools/list` response | ≤ 12 KB |
| The server's `instructions` (at `initialize`) | ≤ 600 characters |
| List page size | `limit`: default 20, max 50. A page also ends early when the next row would cross the byte budget; `next_cursor` is then set |
| Compact row fields | `title` ≤ 120 characters, `question` ≤ 160, `snippet` ≤ 200 |
| `get_ticket` pages | one section per page. A body section that is too long is split, with `next_cursor` |

- **`capResult(output, budget)`** (shared, pure) is the backstop. When a result is still too large, it truncates the longest string fields first, marking each with `…[truncated]`. It sets `truncated: true` and a `hint` that says how to get the rest. The `/mcp` endpoint applies it to every result, so a handler bug can't flood a client.
- **Cursors** are opaque base64url JSON: `{v: 1, k: <keyset>, f: <hash of the filters>}`. A cursor used with different filters gets `invalid_cursor`. Cursors aren't signed: the query is scoped to the account anyway, so a forged cursor only pages through the caller's own data.

### 3 · Tools (M3)
In the table below, a ticket ref is a uuid or short id, and `Row` means `{id, title, column, state, status, kind, repo, badge?, needs_input, question?, updated_at}`.

| Tool | Scope | Hints | Input | Output |
|---|---|---|---|---|
| `list_tickets` | read | read-only | `{column?, kind?, repo?, needs_input?: bool, status?: 'open' \| 'done' \| 'cancelled' \| 'all' = 'open', limit?, cursor?}` | `{tickets: Row[], next_cursor: string \| null}`, ordered by `updated_at desc, id` (keyset) |
| `search_tickets` | read | read-only | `{query: 1..200 chars, status?, limit?, cursor?}` | `{tickets: (Row & {snippet})[], next_cursor}`: Postgres full text over the title (weight A), external ref (A) and body (B), plus a short-id prefix match. At most 200 hits in total |
| `get_ticket_summary` | read | read-only | `{ticket}` | `{id, title, column, state, status, kind, repo, summary: ≤ 1 200 chars, summary_source: 'deterministic', open_question?: {input_request_id, text ≤ 600}, transitions: [{name, label, text: 'required' \| 'optional' \| 'none'}] ≤ 10, waiting_for?: string[] ≤ 10, pr?: {url, merged?}, updated_at}` |
| `get_ticket` | read | read-only | `{ticket, page?: 'overview' \| 'body' \| 'timeline' \| 'context' \| 'output_tail' = 'overview', cursor?}` | `{id, page, content, next_cursor, next_page: string \| null, truncated}` (§3a) |
| `create_ticket` | write | not idempotent without a key | `{title: 1..200, repo, kind?, requirements?: {goal, context?, functional: string[1..30], non_functional?: string[≤ 20], out_of_scope?: string[≤ 20], verification?: string[≤ 50]}, body?: markdown ≤ 20 000, priority?, workflow_id?, external_ref?, idempotency_key?: ≤ 64}`. Exactly one of `requirements` and `body` | `{id, title, column, url, warnings: string[]}`. `url` is the board link |
| `answer_input` | write | idempotent | `{ticket, input_request_id, text: 1..10 000, goto?}` | `{ok: true, already: bool, column, state}`; the same answer again is `already: true`, a different one is `conflict` |
| `take_transition` | write | destructive | `{ticket, name, text?: ≤ 10 000}` | `{ok: true, column, state, waiting_for?: string[]}`. Only the ticket's current `actor: human` transitions for its kind (ADR-0011); an unknown name lists the allowed ones |
| `reopen` | write | — | `{ticket, text: 1..10 000}` | `{ok: true, session_id, column}` (ADR-0008) |
| `cancel` | write | destructive | `{ticket, reason?: ≤ 500}` | `{ok: true, column}` |
| `list_machines` | read | read-only | `{limit?, cursor?}` | `{machines: [{id, name, online, last_seen_at, sessions_running, repos_count, repos: string[≤ 10], capabilities: string[≤ 20]}], next_cursor}` |
| `get_workflow` | read | read-only | `{workflow_id?, version?, state?}` | Without `state`, an outline: `{id, version, columns: [{id, label, states}], states: [{id, type, transitions: [{name, to, actor, when?: ≤ 120}]}]}`. With `state`, that state's full JSON, capped |
| `set_dependencies` | write | idempotent | `{ticket, depends_on: ticket[≤ 20]}` | **Later** (M3-T18, after M2b-T08): `{ticket, depends_on: [{id, title, status}], cycle?: {id, members}}`. It replaces the live set through ADR-0018's service and maps its 409s. `create_ticket` also gains `depends_on` |

#### 3a · `get_ticket` pages
| Page | Content | Paging |
|---|---|---|
| `overview` | metadata, sessions (≤ 5, newest first), open question, PR, the requirement count from the body; dependencies and cycle once M2b lands; the evidence tally once M2c lands | none |
| `body` | the body split at H2 headings (ADR-0019's six sections, or `free_form`), one section per page, each ≤ 6 KB | `cursor` = next section or chunk |
| `timeline` | events newest first, 25 per page, one line each (≤ 200 chars): `{at, type, actor, via?, summary}` | keyset cursor |
| `context` | workflow context keys, each value cut to 500 chars of JSON | cursor by key |
| `output_tail` | the last ≤ 6 KB of the live output ring | none |

- **`create_ticket` and the requirements template.** Given `requirements`, the server writes the body in ADR-0019 §1's format: `## Goal`, `## Context`, `## Functional requirements` with `- **FR-n** …` numbered in order, then NFRs, `## Out of scope` and `## Verification`. The tool description includes the template, so a model knows the shape.
  - A `body` without a Functional requirements section is kept as a free-form ticket, with the warning `free_form_body`.
  - `idempotency_key` deduplicates a retry: same account, same key, within 24 h → the first ticket is returned with `warnings: ['duplicate_ignored']`. This follows the engine invariant "idempotency keys on external side effects", since a model may retry a timed-out call.
  - Tickets go straight to Queued, like the board's create. Triage (ADR-0015) is M4.
  - Until M2c lands, the server only *renders* the template; M2c-T02's `parseTicketBody` parses it. M3-T04's `splitBodySections` is the minimal H2 splitter that `get_ticket` needs, and M2c-T02 reuses or replaces it.
- **Dropped from the 2026-10-26 list: `update_workflow`.** Editing workflow definitions from a model is high-risk and low-value; the editor exists. It is reconsidered with M4's chat.

### 4 · OAuth 2.1: conductor is the authorization server
This follows the MCP authorization spec, RFC 8414, 9728, 7591, 7636, 8707, 7009 and 9207.

**Endpoints** (`ISSUER` = `CONDUCTOR_PUBLIC_URL`'s origin; in local mode, `http://127.0.0.1:<port>`):

| Method | Path | What |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) | RFC 9728: `{resource: ISSUER/mcp, authorization_servers: [ISSUER], scopes_supported, bearer_methods_supported: ['header'], resource_name: 'conductor'}` |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414. `response_types_supported: ['code']`, `grant_types_supported: ['authorization_code', 'refresh_token']`, `code_challenge_methods_supported: ['S256']`, `token_endpoint_auth_methods_supported: ['none']`, `scopes_supported`, `authorization_response_iss_parameter_supported: true`, `client_id_metadata_document_supported: false` (U-092), and the four endpoints below. `/.well-known/openid-configuration` is 404 (conductor is not an OIDC provider) |
| POST | `/oauth/register` | RFC 7591 dynamic client registration (below) |
| GET | `/oauth/authorize` | Validates the request, then sends the user to sign-in or consent |
| POST | `/oauth/token` | `authorization_code` (+ PKCE) and `refresh_token` grants; `application/x-www-form-urlencoded`, as RFC 6749 requires |
| POST | `/oauth/revoke` | RFC 7009; always 200 |
| GET / POST | `/api/oauth/requests/:id`, `/api/oauth/requests/:id/decision` | The consent page's view and its JSON decision (session + Origin, like every `/api`) |
| GET / POST | `/api/oauth/grants`, `/api/oauth/grants/:id/revoke` | The Connected apps page |
| POST / GET / DELETE | `/mcp` | POST is the MCP endpoint. GET and DELETE are 405, because the server is stateless and offers no server-initiated stream |

**Registration** (`POST /oauth/register`):
- Public clients only: `token_endpoint_auth_method: 'none'`, no secret is issued.
- `redirect_uris` (1..5) must be `https://…`, or `http://` on a loopback host (`127.0.0.1`, `[::1]`, `localhost`). Loopback URIs match with any port (RFC 8252 §7.3); every other URI matches exactly. Fragments, userinfo and custom schemes are refused.
- `client_name` (≤ 60 printable characters; default "Unnamed client") is **self-declared**, and the consent page says so.
- Rate-limited (§6). A client that never gets a grant is deleted after 24 h. At most 500 clients without a grant exist at once; registering beyond that prunes the oldest.

**Authorize** (`GET /oauth/authorize`):
1. Check `client_id`, then that `redirect_uri` is registered. If either fails, show an **error page and never redirect**.
2. Check `response_type=code`, `code_challenge` with `code_challenge_method=S256` (`plain` or a missing challenge is refused), `scope` ⊆ supported (empty means both), `resource` (absent or exactly `ISSUER/mcp`) and `state`. A failure here redirects back with `error=…`, `state` and `iss`.
3. **No web session** (password mode): redirect to `/signin?next=<this authorize URL as a path>` (ADR-0017 §Effect on M3; `safeNextPath` allows up to 2 048 chars).
4. With a session: store an `oauth_auth_request` (10 min, bound to the user and the web session) and redirect to the SPA's **`/consent?request=<id>`**.
5. In local mode the local user counts as signed in. Consent is still required.

**Consent** (a real SPA path like `/signin`, outside the app shell):
- **"Allow <client name> to read and write your conductor tickets?"**
  - Below the name: "Name given by the app; conductor can't verify it." Then where it returns to: the redirect host, or "an app on this computer" for loopback.
  - The account (email).
  - Two scope lines: **Read** your tickets, machines and workflows (always granted); **Write**: create tickets, answer questions, move, reopen and cancel tickets (a checkbox, checked when the client asked for it; U-069).
  - Buttons: **Allow** / **Deny**.
- The page fetches `GET /api/oauth/requests/:id` and posts `{approve, scopes}` as JSON to `…/decision`. The response is `{redirect_to}` (the code, `state` and `iss`, or `error=access_denied`), and the page navigates there.
- The JSON POST is covered by ADR-0017's Origin check. Clickjacking is covered by `frame-ancestors 'none'` and nginx's `X-Frame-Options DENY`.
- Consent is **always shown**, even for a client already granted (dynamically registered clients are untrusted).
- A second consent for the same (user, client) **replaces** the earlier grant and revokes its tokens.

**Codes**: 32 random bytes, stored as SHA-256. They are single use and live 60 s, and they are bound to the client, the redirect URI, the PKCE challenge, the resource, the scopes and the grant. A code presented twice revokes every token issued from it (RFC 6749 §4.1.2).

**Tokens**:
- Opaque: `cnd_at_<base64url 32 bytes>` (access) and `cnd_rt_<…>` (refresh). The prefixes help secret scanners.
- **Only SHA-256 hashes are stored** (`oauth_token.token_hash`).
- Each token carries the grant, the account, the user, the client, the scopes and `resource = ISSUER/mcp`.
- **Access tokens** last 1 h.
- **Refresh tokens** last 30 days from issue and **rotate on every use**. A grant stays alive while it is used and dies after 30 idle days.
- **Reuse detection**: presenting a rotated refresh token revokes the whole grant, except within 30 s of its rotation, which is `invalid_grant` only. That window covers a client refreshing twice in parallel (U-094).
- **Audience**: `/mcp` accepts a token only if its `resource` is `ISSUER/mcp`. `/api` never reads a bearer token. `/mcp` never reads the session cookie. Tokens are never passed on to anything else (the spec's "no token passthrough").
- **Validation per request**: one indexed query joins token → grant → user. It requires the token not expired and not revoked, the grant not revoked, and the user not disabled. There is no cache, so revocation is immediate. `last_used_at` is written at most once a minute.
- **401** from `/mcp`: `WWW-Authenticate: Bearer resource_metadata="ISSUER/.well-known/oauth-protected-resource/mcp", scope="conductor:read conductor:write"`, plus `error="invalid_token"` when a token was sent.

**Scopes**: `conductor:read`, `conductor:write`.
- `tools/list` shows only the tools the grant's scopes allow.
- A call to a tool outside the grant is a tool error `insufficient_scope`, with the hint "Reconnect with write access (Settings → Connected apps)".

**Revocation**:
- `POST /oauth/revoke` (either token kind revokes the grant), or **Connected apps → Revoke**.
- Disabling the user, a password reset and `conductor-admin revoke-sessions` revoke all the user's grants as well as their web sessions. A plain password change doesn't (U-094).
- Removing an account member, later (U-051), revokes their grants.

**CSRF and the Origin rule** (amends ADR-0017 §CSRF for these paths only):
- `/oauth/register`, `/oauth/token`, `/oauth/revoke` and `/mcp` are called by MCP clients, not by conductor's SPA. They are **exempt from the Origin-equals-public-origin rule**, and `/oauth/token` and `/oauth/revoke` from JSON-only.
- They are safe because they **never read the session cookie**: they authenticate with PKCE, a refresh token or a bearer token, so there is no ambient credential to forge a request with.
- conductor sends **no CORS headers** (U-096), so a browser page on another origin can't read their responses.
- The Host check still applies.
- `/oauth/authorize` is a `GET`. It only creates a short-lived request row and redirects; nothing is granted until the JSON decision under `/api`.

**Data** (one migration, M3-T02):

| Table | Columns (indicative) | Scope |
|---|---|---|
| `oauth_client` | `id text pk` (random), `name`, `redirect_uris text[]`, `created_at`, `registration_ip`, `last_grant_at null` | instance-level (registered before anyone logs in): on the schema test's allow-list |
| `oauth_auth_request` | `id_hash pk`, `client_id`, `user_id`, `account_id`, `web_session_hash`, `redirect_uri`, `scopes`, `code_challenge`, `resource`, `state`, `created_at`, `expires_at`, `decided_at` | account |
| `oauth_grant` | `id uuid pk`, `account_id`, `user_id`, `client_id`, `client_name` (copied), `scopes text[]`, `created_at`, `last_used_at`, `revoked_at`, `revoked_reason` | account |
| `oauth_code` | `code_hash pk`, `account_id`, `grant_id`, `redirect_uri`, `code_challenge`, `resource`, `scopes`, `expires_at`, `used_at` | account |
| `oauth_token` | `id uuid pk`, `token_hash bytea unique`, `account_id`, `grant_id`, `kind 'access' \| 'refresh'`, `scopes`, `resource`, `created_at`, `expires_at`, `rotated_at`, `revoked_at`, `last_used_at` | account |
| `mcp_tool_call` | `id bigserial`, `account_id`, `user_id`, `grant_id`, `client_name`, `tool`, `ticket_id null`, `session_id null`, `ok`, `error_code`, `duration_ms`, `result_bytes`, `truncated`, `args_digest null` (writes), `at` | account; pruned after 90 days (U-095) |
| `ticket` | adds `create_key text null` (a unique index on `(account_id, create_key)` where it isn't null) and `search tsvector GENERATED ALWAYS AS (…) STORED` with a GIN index | account |

### 5 · Writes and confirmation (U-069, proposed default)
- **No server-side confirmation step.** A two-phase "propose, then confirm" call is confirmed by the same model, so it protects nothing. A human confirms in the **client**: Claude Code, claude.ai and Claude Desktop ask before a tool runs unless the user allows it, and the hints (`destructiveHint` on `take_transition` and `cancel`) make them ask harder.
- **The write scope is opt-in at consent.** A read-only connection is one checkbox away.
- **Approvals stay on the board.** A transition whose `requires.approvals` applies (ADR-0020's migration approval on Merge) is refused over MCP with `approval_required` and the card's URL (U-093). MCP can't approve anything that a human is meant to see first.
- Every write is **audited with the client's name** (§7).

### 6 · Rate limits (U-054, proposed default)
Limits are kept in memory in the orchestrator (one instance, as `@fastify/rate-limit` already is) and answered with **429 + `Retry-After`**. nginx adds coarse per-IP limits.

| What | Limit |
|---|---|
| `/mcp` requests per grant | 120 / min (burst 40) |
| Write tool calls per grant | 30 / min |
| `/mcp` per account, all grants | 300 / min |
| `/oauth/register` per IP | 10 / hour; 100 / hour in total |
| `/oauth/token` per IP and per client | 30 / min |
| `/oauth/authorize` and `/api/oauth/requests/*` per IP | 30 / min |
| Active grants per user | 25. The 26th consent fails with a message that sends the user to Connected apps |
| nginx `conductor_mcp` zone (`/mcp`), per IP | 10 r/s, burst 40 |
| nginx `conductor_oauth` zone (`/oauth/`, `/.well-known/oauth-`), per IP | 60 r/min, burst 20 |

claude.ai calls from Anthropic's shared egress addresses, so the nginx per-IP zones are deliberately generous; the per-grant limits are the real ones.

### 7 · Audit
- **Every tool call** (read and write) writes one `mcp_tool_call` row. It feeds Connected apps' "last used" and "last tool", and forensics. Arguments aren't stored; a write stores a digest and a compact summary of at most 200 chars.
- **Writes land on the ticket's timeline.** The engine event's `actor` is `mcp` and its payload gains `via: {client_id, client_name, user_id, grant_id}`. An answered input request gets `answered_by = 'mcp'`.
- The detail panel shows **"via Claude Code (MCP)"** on those entries. `SessionDetail.mcp_activity` lists the ticket's write calls (≤ 20, newest first), which covers `create_ticket` on a ticket that has no session yet.
- The client name is self-declared and shown as such.

### 8 · Transport
- **Streamable HTTP at `/mcp`**, served by the official TypeScript MCP SDK (`@modelcontextprotocol/sdk`, the version the daemon already pins).
- **Stateless**: `sessionIdGenerator: undefined`, with JSON responses (`enableJsonResponse: true`). Each POST carries the bearer token and is served on its own, so no MCP session is pinned to an instance.
- The Fastify route hands the raw request to the transport (`reply.hijack()`).
- **Only tools**: no resources, prompts or sampling in M3.
- The server's `instructions` (≤ 600 chars) tell the model: start with `list_tickets` or `search_tickets`; prefer `get_ticket_summary` to `get_ticket`; ticket refs accept short ids; writes are recorded under the client's name.

### 9 · nginx (gradyserver)
This follows the pattern of `os.gradyserver.com` and `reso.gradyserver.com`: `limit_req_zone`s in `conf.d/conductor-ratelimit.conf`, and locations in the site. All `add_header`s stay at server level, as the current site does.

```nginx
# conf.d/conductor-ratelimit.conf (additions)
limit_req_zone $binary_remote_addr zone=conductor_mcp:10m   rate=10r/s;
limit_req_zone $binary_remote_addr zone=conductor_oauth:10m rate=60r/m;

# sites-available/conductor.gradyserver.com (additions)
location = /mcp {
    limit_req zone=conductor_mcp burst=40 nodelay;
    limit_req_status 429;
    proxy_pass http://conductor_app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    # Streamable HTTP may answer with an SSE stream: never buffer it or cut it short.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
location ~ ^/(oauth/|\.well-known/oauth-) {
    limit_req zone=conductor_oauth burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://conductor_app;
    # Claude times out discovery, registration and token calls after about 10 s.
    proxy_read_timeout 30s;
}
```

- Request headers (`Authorization`, `Mcp-Protocol-Version`) pass through by default. `Mcp-Session-Id` isn't used (stateless).
- The port-80 server keeps only `/.well-known/acme-challenge/`, so OAuth discovery is served over HTTPS only.

### 10 · Connect Claude (the setup page)
- An in-app page at **`#/connect`**, linked from the account menu and from Connected apps. It has three tabs:
  - **Claude Code**: copy `claude mcp add --transport http conductor https://conductor.gradyserver.com/mcp`, with `--scope user` noted to make it available in every project. Then run `/mcp` in Claude Code, pick conductor, and Authenticate; a browser opens on conductor's sign-in and consent.
  - **claude.ai**: Settings → Connectors → Add custom connector, with the name `conductor` and the URL `https://conductor.gradyserver.com/mcp`. Then Connect, sign in and Allow.
  - **Claude Desktop**: the same custom connector. Connectors added on claude.ai show up in Desktop for the same Claude account.
  - The URL shown is always this instance's `ISSUER/mcp`.
- **Verify it works**: the page polls `GET /api/oauth/grants` every 5 s while it is open. Once a grant appears and makes its first tool call, it shows "Connected: Claude Code · last call `list_tickets` 4 s ago" and suggests a prompt to try ("What's waiting on me in conductor?").
- **Connected apps** (`#/settings/apps`) lists each grant: the client name (self-declared), the redirect host, scopes, connected at, last used and last tool. Each has **Revoke**, which takes effect on the client's next request.

## Alternatives considered
| Option | Why not |
|---|---|
| Expose REST to models (OpenAPI) | Browser-shaped payloads, no size discipline, and every client needs its own auth glue |
| An external AS (Auth0, WorkOS, …), or `oidc-provider` as personal-os uses | An external service, or a large dependency with its own interaction views and adapters, for a few hundred lines of well-specified flows. The discovery documents make a later switch transparent to clients |
| JWT access tokens | Can't be revoked immediately without a lookup, which we'd do anyway. Opaque tokens with a hashed lookup match web sessions (ADR-0017) |
| A server-rendered consent page with an HTML form POST | It would need a form-encoded exception to JSON-only and a CSRF token. The SPA page with a JSON POST reuses the existing CSRF model |
| A stateful MCP session | Pins clients to one instance and needs session storage. Our tools are request and response |
| Server-side two-phase confirmation of writes | The model confirms its own call, so it adds latency and no safety. Client tool approval plus scopes, audit and board-only approvals are the real controls (§5) |
| Client ID Metadata Documents instead of DCR | Newer and not needed by today's Claude clients; U-092 |
| A tool per REST route | About 25 tools, many unhelpful to a model. Eleven task-shaped tools cover the operations |

## Consequences
- **Good:**
  - Claude Code, claude.ai, Claude Desktop and (M4) the assistant use the same tools.
  - Results stay small enough to call repeatedly.
  - Access is per account and per client, audited and revocable on one page.
- **Bad / accepted cost:**
  - conductor is now an OAuth server, with the security surface that brings (M3-T15 reviews it).
  - A new runtime dependency in the orchestrator (the MCP SDK).
  - Summaries are deterministic until M4.
  - The four client-facing endpoints have their own CSRF reasoning (§4).
- **Follow-ups:**
  - M3 tasks;
  - M3-T18 (`set_dependencies`, after M2b) and M3-T19 (requirements and evidence in `get_ticket`, after M2c);
  - U-092..U-096;
  - [ADR-0015](0015-triage-and-assistant-on-the-users-machine.md) for stored summaries and the chat's use of the tool layer.

## Revisit when
- MCP clients need resources or push notifications (stateful sessions);
- a second orchestrator instance is added (the rate limits and validation move to Postgres or a shared cache);
- a client requires CIMD (U-092);
- an enterprise customer requires their own identity provider.
