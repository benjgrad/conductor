# M3 · Tool layer & MCP server

> **Outline.** The detailed task breakdown is written when M2 is near done, and Ben approves it before work starts. The task table below is a first cut.

**Goal** ([ADR-0014](../../adr/0014-tool-layer-and-oauth-mcp-server.md)):
- one internal tool layer exposes conductor's operations with compact, size-capped, paginated results;
- an MCP client (Claude Code, claude.ai, Claude Desktop) reaches it at `/mcp` over Streamable HTTP, after OAuth 2.1 with conductor as the authorization server and conductor's own sign-in as the login ([ADR-0017](../../adr/0017-own-sign-in-and-self-hosting.md) §Effect on M3);
- tokens are scoped to one account and revocable.

**Exit criteria**:
- All twelve tools exist with zod input and output schemas. The REST routes that overlap call the same services (no duplicated rules).
- Against a board seeded with 500 tickets, every tool's serialised result is ≤ 8 KB (`TOOL_RESULT_MAX_BYTES`, a test per tool); lists paginate with cursors; `get_ticket` pages by section.
- An MCP client in e2e:
  1. discovers the metadata;
  2. registers dynamically;
  3. completes authorization code + PKCE through conductor's sign-in page (a test user made with `conductor-admin` in e2e; Ben's own account in his manual check);
  4. calls `create_ticket`, `list_tickets`, `get_ticket_summary` and `take_transition`;
  5. refreshes its token;
  6. is refused after revocation.
- Ben connects Claude Code (`claude mcp add --transport http conductor https://conductor.gradyserver.com/mcp`) to the hosted instance and lists his tickets.
- A token from account A sees nothing of account B (the route-matrix test extended to tools).
- Security review of the authorization server: redirect URI validation, code reuse, refresh rotation and reuse detection, PKCE downgrade, `resource` binding, and the consent page against clickjacking.

**Not in M3**:
- the chat and stored model summaries (M4; M3 serves the deterministic summary);
- MCP resources, prompts and sampling;
- an external identity provider;
- per-tool confirmation for MCP writes (U-069);
- a second instance.

**Added 2026-10-27 (ADR-0018 / ADR-0019 accepted)**: `create_ticket` takes `depends_on` and the sectioned body (ADR-0019 template); a `set_dependencies` tool (ADR-0018 §5) joins the write tools, making thirteen; `get_ticket` returns dependencies, the cycle, the requirements and their evidence tally. Both call the M2b / M2c services.

**Blocking unknowns**: proposed U-054 (rate limits and quotas), U-069 (scopes, and whether MCP writes need confirmation). The M2 exit is required, because tokens are account-scoped.

## Task board (first cut)

| ID | Task | Depends on | Parallel group | Status |
|---|---|---|---|---|
| M3-T01 | **Contracts**: `ToolDef`, the tool context, result caps and truncation helper, cursor format; OAuth tables' row types; `ticket_summary` row type (written in M4); `API_PATHS` for `/mcp`, `/oauth/*`, `/.well-known/*` | M2 done | A | todo |
| M3-T02 | Migrations: `oauth_client`, `oauth_grant`/`oauth_token`, `ticket_summary`; full-text index for `search_tickets` | T01 | B | todo |
| M3-T03 | Read tools: `list_tickets`, `search_tickets`, `get_ticket_summary` (deterministic), `get_ticket` (pages), `get_workflow` (outline / one state), `list_machines`; the 500-ticket size test | T01 | B | todo |
| M3-T04 | Write tools: `create_ticket`, `answer_input`, `take_transition`, `reopen`, `cancel`, `update_workflow` (merge patch + validator); refactor the overlapping REST routes onto the same services | T01 | B | todo |
| M3-T05 | OAuth authorization server: metadata (RFC 8414, RFC 9728), DCR (RFC 7591), authorize + consent (conductor web session; `/signin?next=` without one), token (code + PKCE, refresh rotation), revoke (RFC 7009), `resource` (RFC 8707) | T02 | C | todo |
| M3-T06 | `/mcp` endpoint: the MCP SDK in stateless Streamable HTTP; bearer validation; scope check per tool; rate limits; 401 with `resource_metadata` | T03, T04, T05 | D | todo |
| M3-T07 | Web: consent page and the Connected apps page (list grants, revoke) | T05 | D | todo |
| M3-T08 | E2E: OAuth with a test user, tool calls, refresh, revocation, size bounds, cross-account refusal; a setup note for Claude Code | T06, T07 | E | todo |
