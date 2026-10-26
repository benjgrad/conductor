# ADR-0014 · One tool layer, served as an OAuth-protected MCP server, with results sized for a model's context

- **Status**: proposed (Ben approved the plan 2026-10-26; this ADR is accepted when he signs off milestone M3)
- **Date**: 2026-10-26
- **Deciders**: Ben (+ Claude planning session 2026-10-26)
- **Builds on**: [ADR-0012](0012-hosted-multi-user-github-sign-in.md) (accounts, the GitHub session), [ADR-0011](0011-transition-rules.md) (named transitions, `POST /api/sessions/:id/transition`).
- **Note (2026-10-26)**: [ADR-0017](0017-own-sign-in-and-self-hosting.md) replaces GitHub login with conductor's own email + password sign-in. Wherever this ADR says "GitHub login" or "GitHub session", read conductor's sign-in page and web session: `/oauth/authorize` without a session redirects to `/signin?next=…`. M3's e2e uses a test user, not a fake GitHub (ADR-0017 §Effect on M3).

## Context
Ben wants the board's operations available to any MCP client (Claude Code, claude.ai, Claude Desktop) behind OAuth, and the same operations to drive the in-app assistant ([ADR-0015](0015-triage-and-assistant-on-the-users-machine.md)). The REST API returns what a browser needs: full cards, whole definitions, every version. Handed to a model as-is, a board of 200 cards or one workflow definition fills a large part of its context window, and a model can't page through what it was never offered a cursor for.

## Decision
**One internal tool layer (`packages/orchestrator/src/tools/`) defines every operation once, with a zod input, a compact output, and a size cap. The MCP server at `/mcp` and the assistant both call it. The orchestrator is its own OAuth 2.1 authorization server: people log in with GitHub, and tokens are scoped to one account.**

### The tool layer
- A tool is `{name, description, input: ZodSchema, output: ZodSchema, mutates: boolean, scope: 'read' | 'write', handler(ctx, input)}`. `ctx` is `{account, actor, via: 'mcp' | 'chat' | 'rest'}` ([ADR-0012](0012-hosted-multi-user-github-sign-in.md) `AccountScope`).
- Handlers call the **same services as REST** (engine `applyEvent`, ticket create, reopen, workflow save). REST routes that overlap are refactored to call those services too, so the rules can't diverge. Tools add no behaviour of their own.
- **Context-friendly results:**
  - **Compact lists**: one line of fields per item: `{id, title, column, kind, badge, question?: first 200 chars, updated_at}`. No bodies, contexts or definitions.
  - **Stored summaries**: `get_ticket_summary` returns the ticket's stored summary (≤ 1 200 chars, written by the user's machine, ADR-0015) or, when there is none or it is stale, a **deterministic** one built from state, last transition and reason, open question and pending checklist. It never blocks on a model.
  - **Pagination**: lists take `limit` (default 20, max 50) and an opaque `cursor`. `get_ticket` returns one section per page (`overview`, `timeline`, `context`, `output_tail`), each capped, with `next_page` when there is more.
  - **A hard cap**: each serialised result ≤ 8 KB (`TOOL_RESULT_MAX_BYTES`). A handler that would exceed it truncates the longest text fields and says so (`truncated: true`, plus how to get the rest). A test checks the cap for every tool against a board seeded with 500 tickets.
  - **Errors** are short and actionable ("No ticket t_12 in this account. Use search_tickets.").
- **Tools** (M3):

| Tool | Scope | Notes |
|---|---|---|
| `list_tickets {column?, kind?, needs_input?, limit, cursor}` | read | compact rows |
| `search_tickets {query, limit, cursor}` | read | title/body/external ref, Postgres full text |
| `get_ticket_summary {ticket_id}` | read | stored or deterministic summary |
| `get_ticket {ticket_id, page}` | read | one capped section per page |
| `create_ticket {title, body, repo, kind?}` | write | goes through triage (ADR-0015) when fields are missing |
| `answer_input {ticket_id, input_request_id, text}` | write | `POST …/input` semantics, idempotent per request |
| `take_transition {ticket_id, name, text?}` | write | only `actor: human` transitions for the ticket's kind (ADR-0011) |
| `reopen {ticket_id, text}` | write | ADR-0008 |
| `cancel {ticket_id, reason?}` | write | |
| `get_workflow {version?, section?}` | read | an outline (columns, transitions with `when`) by default; full JSON of one state on request |
| `update_workflow {patch}` | write | a JSON merge patch over the latest version, validated, saved as a new version; the response is the validator's errors or the new version number |
| `list_machines` | read | name, online, repos (count + first 10), capabilities |

### OAuth 2.1, with the orchestrator as authorization server
Following the MCP authorization spec:
- **Discovery**: `/.well-known/oauth-protected-resource` (RFC 9728) names the resource `https://<host>/mcp` and its authorization server; `/.well-known/oauth-authorization-server` (RFC 8414) lists the endpoints. A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata=…`.
- **Dynamic client registration** (RFC 7591): `POST /oauth/register` stores `oauth_client (id, name, redirect_uris, created_at)`. A client registers before anyone logs in, so it has no account and is on the ADR-0012 schema test's allow-list; the grants and tokens carry the account. Public clients only (no client secret); redirect URIs must be `https` or loopback `http`. Registration is rate-limited per IP.
- **Authorization code + PKCE (S256 required)**: `GET /oauth/authorize` needs a GitHub session ([ADR-0012](0012-hosted-multi-user-github-sign-in.md)). Without one it sends the user through GitHub login first. A consent page names the client, the account and the scopes. The code is single use, lives 60 s, and is bound to the client, the redirect URI, the PKCE challenge and the `resource` (RFC 8707).
- **Tokens**: opaque random strings, stored hashed in `oauth_token (account_id, user_id, client_id, scopes, kind: access|refresh, expires_at, revoked_at)`. Access tokens last 1 h and refresh tokens 30 days, rotated on every use; reuse of a rotated refresh token revokes the whole grant. The audience is `/mcp` only, so they are useless against `/api`.
- **Scopes**: `conductor:read` and `conductor:write` (U-069). The tool's `scope` must be granted.
- **Revocation**: `POST /oauth/revoke` (RFC 7009), plus a **Connected apps** page listing each grant (client, scopes, last used) with a Revoke button. Revoking an account member revokes their grants.

### Transport
**Streamable HTTP at `/mcp`**, using the official TypeScript MCP SDK in **stateless** mode: each POST carries the bearer token and is served on its own; there is no server-held MCP session to pin to an instance. Only tools are offered in M3: no resources, prompts or sampling. Per-token and per-account rate limits apply (U-054); a limited request gets 429 with `Retry-After`.

## Alternatives considered
| Option | Why not |
|---|---|
| Expose REST to models (OpenAPI) | Browser-shaped payloads, no size discipline, and every client needs its own auth glue |
| Pass GitHub's token through as the MCP token | Ties MCP access to GitHub scopes and lifetimes; the server would hold GitHub tokens. The spec expects the MCP server's own AS (or a delegated one) |
| An external AS (Auth0, WorkOS, …) | A new external service and cost, and account mapping lives elsewhere. Possible later; the discovery documents make the switch transparent to clients |
| Summaries generated on the server | Needs a model API key on the server; Ben chose the user's machine (ADR-0015) |
| A stateful MCP session | Pins clients to one instance and needs session storage. Our tools are request/response |
| A tool per REST route | About 25 tools, many unhelpful to a model. Twelve task-shaped tools cover the operations |

## Consequences
- **Good:**
  - Claude Code, claude.ai and the assistant use the same twelve tools;
  - results stay small enough to call repeatedly;
  - access is per account, per client, and revocable.
- **Bad / accepted cost:**
  - conductor is now an OAuth server, with the security surface that brings (redirect validation, code and refresh-token handling, consent);
  - a new dependency (the MCP SDK);
  - summaries are only as fresh as the last machine run (deterministic fallback).
- **Follow-ups:** M3 tasks; U-054 (rate limits), U-069 (scopes, and confirmation for writes made over MCP); [ADR-0015](0015-triage-and-assistant-on-the-users-machine.md) for summaries and the chat's use of `/mcp`.

## Revisit when
MCP clients need resources or push notifications (stateful sessions), a second orchestrator instance is added (token cache), or an enterprise customer requires their own identity provider.
