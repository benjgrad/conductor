# ADR-0038 · Pages: a host-neutral result kind, hosted by conductor by default

- **Status**: accepted (Ben approved the plan, 2026-11-05, on ticket "P9 · Planning artifacts")
- **Date**: 2026-11-05
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Extends**: [ADR-0037](0037-workflow-primitives-for-self-healing-process.md) (general primitives, config decides; the rule-14 "not available yet" pattern), [ADR-0034](0034-agent-proposed-follow-up-tickets.md) (optional keys on the `complete_state` result), 06 §Attachments (the daemon posts with its machine credential)

## Context

Planning has `tools: ["read"]` and `result: ["plan", "summary"]`. The agent can't write a file, and the card shows nothing but text. A mockup, a diagram or a data walkthrough has nowhere to go. Ben does not want plan artifacts committed to the repo.

Two hosts were considered:
- **Claude's online artifacts.** These need the claude-artifacts MCP in every daemon's Claude login. They are owned by that account, have no TTL, and the orchestrator can't read them back.
- **A page hosted by conductor.** It is ephemeral, lives in the account, and conductor serves it.

Ben decided (2026-11-05): **the primitive is host-neutral, and the default host is conductor itself.** A Claude artifact URL is just another page URL to the engine.

## Decision

1. **A result kind, not a key.**
   - An agent state's `result` may list, at most once, `{"pages": {"max": 1..5}}` (`PagesResultSchema`) next to its required string keys.
   - The agent may then add `"pages": [{"url", "title", "expires_at"?}]` (`PageRef`) to its `complete_state` result.
   - It is optional, like `proposed_tickets`: the engine stores it in `context[<state>]` like any extra key and never fails on it. A question transition (`plan_needs_approval`) keeps its result too, so Plan review sees the pages.
   - `resultKeys(state)` (the string entries) is what "missing result keys", the prompts and rule 5 read. `pagesSpec(state)` is the kind.
2. **Read back, never trusted.**
   - `pagesOfContext(context, pageLimitsOf(def))` (api/pages.ts) reads each state's `pages` up to its `max`. It drops entries that don't parse and keeps a URL once.
   - A `PageRef.url` is `https:`, or `http:` only on a loopback host (a local-mode conductor serves `http://127.0.0.1`). It never carries credentials. The title is 1–200 characters.
3. **Hosting is a tool.**
   - The workflow tool alias `pages` (an empty tool-policy fragment) gives the agent the daemon's `publish_page {title, html, ttl_days?, share?}` MCP tool.
   - The daemon POSTs it to `API_PATHS.daemonSessionPages` with its machine credential, as `attach_file` does. The orchestrator stores it in `page` and returns `{id, url, share_url, expires_at}`. The daemon never serves a page.
   - `html` is one document of at most 2 MiB (UTF-8 bytes). `ttl_days` defaults to 7, at most 30. A ticket has at most 30 live pages.
   - The tool and the result kind are separate on purpose: an artifact URL from another host needs no tool. The builder's "Pages" checkbox sets both.
4. **Serving untrusted HTML on our own origin.**
   - `GET /p/:id` is outside `/api`, so the SPA fallback never claims it (`API_PATHS.page`).
   - It replaces the app's security headers with:
     - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
     - `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`.
   - The CSP `sandbox` directive is the key line. It gives the document an opaque origin **even when the page is opened top-level from a link**, so its script can't read the app's storage or act as the signed-in user. `default-src 'none'` (with no `connect-src`) leaves it no network: an external `<script src>`, stylesheet, font or `fetch` is blocked. That is the "inline only" rule, enforced.
   - The card embeds a page only when it is ours (`<origin>/p/<uuid>`) and not expired, in `<iframe sandbox="allow-scripts">` without `allow-same-origin`. Any other host is a link; the app's own CSP would refuse to frame it anyway.
5. **Access.**
   - A page needs a session of its account (always the case in local mode, which is loopback only), or its share token: `/p/:id?t=<token>`, compared in constant time.
   - The token is 32 random bytes, base64url. It is minted by `publish_page {share: true}` (`shared_by = 'agent'`) or by the card's Share action (`POST API_PATHS.pageShare`, `shared_by = 'user'`), once. Later Shares return the same link, never a silently rotated one.
   - Without a session or token the page answers 401. A wrong token, or another account's page, answers 404, so ids aren't confirmed. Sharing is off by default.
   - The token is stored, not hashed. It is a read capability for one page that dies with it, and storing it lets the card copy the link again.
6. **Expiry.** Past `expires_at` the page answers 410. The workers delete expired rows once a day (`sweepExpiredPages`), after which the page answers 404.
7. **Old daemons.**
   - The Rust daemon advertises `DAEMON_FEATURE_PAGES`; the frozen TS daemon doesn't (TD-216).
   - At `start_session`, a machine without the feature gets the state's `tools` without `pages` and a note in the prompt (`withPagesFeature`, like `withStartAttachments`). An older daemon's tool policy would otherwise refuse the unknown alias.
8. **Insights.** `processMetrics.pages` counts pages per state and per ticket, read from the window's session contexts. It is not read from `page`: rows are swept after at most 30 days, and the window goes back 180. There is no other metric.
9. **Rule 14.**
   - `AVAILABLE_TOOL_ALIASES` and `AVAILABLE_RESULT_KINDS` list what a definition may use. `checkAvailability` refuses a known alias or kind that isn't listed: "not available yet".
   - Both land available in this change, because the whole feature lands with it.
   - Rule 5 refuses the string key `pages` as a required result key.

## Consequences

- The shipped v1–v4 and the live v5 parse and validate unchanged, and their prompts are byte-identical: no state lists the kind. The v6 draft (ADR-0037, still on PR #188 when this landed) turns pages on for planning and implementing: `"pages"` in their `tools` and `{"pages": {"max": 3}}` in their `result`, so screenshots stop being stashed in PRs. That edit follows once #188 merges.
- The HTML lives in Postgres (TD-215, as attachments' bytes do under TD-212).
- One iframe check can't be automated: a sandboxed iframe without `allow-same-origin` still sends the SameSite=Lax session cookie on a same-origin navigation, so a hosted page renders in password mode. Verify it once by hand on the hosted deployment.
- Out of scope: multi-file pages, editing a page after publish (publish a new one), and a Claude-artifacts publishing tool (its URL already satisfies the result kind).
