# ADR-0028 · A simple OAuth server and MCP endpoint, now (amends ADR-0014)

- **Status**: **accepted** (Ben, 2026-10-30: "If it hasn't been implemented, then implement it… Prioritize simplicity of the solution.")
- **Date**: 2026-10-30
- **Deciders**: Ben (+ the conductor planning and implementing sessions on the "Set up a simple OAuth" ticket)
- **Amends**: [ADR-0014](0014-tool-layer-and-oauth-mcp-server.md) §3–§7 and §10, for what ships now. ADR-0014 stays the target design; its cut parts are follow-ups (below).

## Context
Ben wants to connect Claude Code, claude.ai and Claude Desktop to conductor over MCP, securely, soon. ADR-0014 designed this as milestone M3: 17 tasks, a tool layer with eleven tools and size budgets, an SPA consent page, Connected apps, an audit table and per-grant rate limits. None of it was built, and M3 waits on M2r. The ticket asked for "a simple OAuth server (ideally an open-source project) we can quickly roll out".

## Decision
**Ship a minimal OAuth 2.1 authorization server and a stateless `/mcp` endpoint inside the orchestrator, in one branch.** It keeps ADR-0014's choices: conductor is its own authorization server, the login step is conductor's sign-in, and tokens are opaque and hashed. It cuts everything that isn't needed to connect Claude securely.

### What ships
| Piece | What |
|---|---|
| Discovery | `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix; RFC 9728) and `GET /.well-known/oauth-authorization-server` (and `/mcp` suffix; RFC 8414). Issuer = `CONDUCTOR_PUBLIC_URL`'s origin (the request's origin in local mode) |
| Registration | `POST /oauth/register` (RFC 7591), public clients only (`token_endpoint_auth_method: none`). Redirect URIs: `https://`, or `http://` on a loopback host; no fragment, no userinfo; 1..5 of them. The client name is self-declared |
| Authorize | `GET /oauth/authorize`: an unknown client or redirect URI is an error page, never a redirect. `response_type=code` and PKCE `S256` are required (`plain` is refused); `resource`, if sent, must be `ISSUER/mcp`. No session → `/signin?next=<this URL>` |
| Consent | A **server-rendered** page (no script) with Allow / Deny. Its form posts back to `POST /oauth/authorize`, which keeps the Origin rule (CSRF) and redirects to the client with `code`, `state` and `iss`, or `error=access_denied`. Its CSP adds the redirect origin to `form-action`, because browsers apply `form-action` to the redirect after a form post |
| Codes | 32 random bytes, stored as SHA-256; single use, 60 s; bound to the client, the redirect URI and the PKCE challenge. A replayed code revokes every token issued from it |
| Tokens | `POST /oauth/token` (form-encoded or JSON): `authorization_code` + PKCE, and `refresh_token`. Opaque `cnd_at_…` (1 h) and `cnd_rt_…` (30 d) tokens, stored as SHA-256. Refresh tokens rotate: a used one is refused |
| One scope | `conductor`: read and write |
| `/mcp` | `POST`, MCP Streamable HTTP, stateless with JSON responses, served by the official `@modelcontextprotocol/sdk` (1.32.1, the daemon's version). Bearer token only, never the cookie. No or bad token → 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`. `GET` / `DELETE` → 405 |
| Tools | `list_tickets`, `get_ticket`, `create_ticket`, `answer_input`, `take_transition`; since the MCP ticket (Ben approved the set, 2026-10-30) also `search_tickets`, `list_machines`, `reopen_ticket` and `cancel_ticket`. `take_transition` takes only the card's current buttons and refuses one with `requires.approvals` (`approval_required`). Never exposed: approvals, permission prompts, fresh conversations, messages to an agent, workflows, enrollment, admin, transcripts. Every one is scoped to the token's account (another account's ticket is "not found"). Ticket refs take the id or its first 8+ hex characters. Results are JSON text capped at 8 KB. Writes call the same code as REST (`createTicket`, `engine.applyEvent`) |
| Revocation | Password reset, disabling the user and `conductor-admin revoke-sessions <email>` revoke the user's tokens. A plain password change doesn't |
| Security hook | `POST /mcp`, `/oauth/register` and `/oauth/token` skip the Origin rule: they never read the session cookie, and conductor sends no CORS headers. `/oauth/token` and `POST /oauth/authorize` also take `application/x-www-form-urlencoded`. The Host check applies everywhere |
| Limits | 30 / min per IP on each of register, authorize and token (`@fastify/rate-limit`) |
| Data | One migration: `oauth_client` (instance-level), `oauth_code` and `oauth_token` (account-scoped; `user_id` has no FK, like `push_subscription`, because the local user is virtual) |

nginx needs no change: the site's catch-all location already proxies these paths, and JSON responses need no unbuffering.

### Cut from ADR-0014 (follow-ups)
- The read / write scope split and the write opt-in at consent.
- The SPA consent page, Connect Claude (`#/connect`) and Connected apps (`#/settings/apps`); `POST /oauth/revoke`.
- The refresh-reuse grace window and whole-grant revocation on refresh reuse.
- `mcp_tool_call` audit, the `mcp` actor and "via <client> (MCP)" on the timeline: MCP writes are recorded as `ui`.
- Per-grant and per-account rate limits; the 25-grants cap; pruning of unused clients and expired codes and tokens.
- The rest of the tools (`get_ticket_summary`, paged `get_ticket`, `get_workflow`; `search_tickets` ships without full-text search, TD-200), cursors and the per-field budgets.

## Alternatives considered
| Option | Why not |
|---|---|
| An external identity provider (Auth0, WorkOS, Keycloak) | A new service and an account bridge to conductor's users; the login must be conductor's own sign-in anyway |
| `oidc-provider` | A large dependency with its own interaction views, adapters and session store, for four small routes |
| The MCP SDK's `mcpAuthRouter` | Express-only; mounting Express inside Fastify (`@fastify/express`) costs more than the routes it would replace, and conductor's users and sessions still need a custom provider |
| All of ADR-0014 (M3) first | 17 tasks behind M2r; Ben wants a working connection now |

## Consequences
- **Good**: Claude Code, claude.ai and Claude Desktop can connect today with standard discovery, registration and PKCE; tokens are hashed, short-lived, account-scoped and revocable; the cut parts can be added without changing what clients see.
- **Bad / accepted cost**: revocation is coarse (per user, from the CLI or a password reset); every connection can write; MCP writes are not attributed to the client; a client refreshing twice in parallel may have to reconnect.

## Revisit when
- a second account goes live on the hosted instance (TD-149: the route matrix must cover `/mcp` and `/oauth/*`);
- Ben wants to see or revoke one connection, or a read-only one (Connected apps, scopes);
- M3's remaining tasks are scheduled.
