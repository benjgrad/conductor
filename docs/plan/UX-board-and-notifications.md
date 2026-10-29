# UX · Board polish, agent team, notifications (UX-9 … UX-16)

> Raised by Ben on 2026-10-28 from using the hosted board. These are out-of-plan UX tickets, like UX-1..UX-8. Each block below pastes into a ticket as-is: `scripts/create-tickets.js --file docs/plan/UX-board-and-notifications.md <ids>`. The fields after **Verification** are for the lead.
>
> Decisions (Ben, 2026-10-28):
> - **Agent names**: there are two pools. The **team** is the agents this account has already hired. A new ticket gets a teammate who is free, and only when nobody on the team is free does conductor **hire** from the much larger hiring pool (today's `AGENT_NAMES`), adding the new agent to the team.
> - **Notifications**: in-tab notifications plus Web Push (service worker + VAPID; it goes through the browsers' push services, with no new vendor or account).

## Task board

| ID | Task | Depends on | Wave | Migration (Ben approves) | Status |
|---|---|---|---|---|---|
| UX-10 | Card cleanup: no state or status that repeats the column | — | 1 | — | todo |
| UX-11 | Top-nav icons (lucide-react) | — | 1 | — | todo |
| UX-13a | Agent team (server): team and hiring pools, the assignment, `agent_name` on the DTOs | — | 1 | **yes** | todo |
| UX-14 | Notifications (in-tab): browser notification, title count, favicon dot | — | 1 | — | todo |
| UX-15 | Notifications (Web Push, server): subscriptions, VAPID, the send on needs-input | — | 1 | **yes** | todo |
| UX-9 | Collapsible board columns | UX-10 | 2 | — | todo |
| UX-13b | Agent team (web): show the stored name and face, the Team list | UX-13a | 2 | — | todo |
| UX-16 | Notifications (Web Push, web): service worker, manifest, subscribe toggle | UX-14, UX-15 | 2 | — | todo |
| UX-12 | Mobile-friendly view | UX-9, UX-11 | 3 | — | todo |

**Ticket waves**: post a wave only when everything it depends on is merged (TD-172: no `depends_on` until M2b). The reasons for the order:
- UX-9, UX-10 and UX-12 all edit `components/Board.tsx` / `Board.css`, so they run in sequence.
- UX-11 and UX-14 each add to `App.tsx`'s top bar. That's a small overlap; whichever lands second merges `origin/main`.
- UX-13a and UX-15 both add to `shared/src/api/rest.ts`, in separate sections and additively.

## Task details

### UX-10 · Card cleanup: no state or status that repeats the column
## Goal
A card says only what its column doesn't. A card in **Needs input** no longer reads "Needs input · needs input".

## Context
`packages/web/src/components/Board.tsx`, `Card`: the meta row shows `stateLabel(card.workflow_state)` and then `STATUS_LABELS[card.status]` (`components/format.ts`). Columns are workflow states (ADR-0010), so the state label usually repeats the column title. The session status repeats it again in human and event columns (`needs_input`, `waiting_external`). Design: docs/design/06-human-input.md (the board), ADR-0010.

## Functional requirements
- **FR-1** Hide the state label when it equals the card's column title, compared after `stateLabel`. Keep it when the state differs from the column (for example in Queued, or for a state the board folds into another column).
- **FR-2** Hide the status pill when it adds nothing to the column:
  - `needs_input` in a column of kind `human`;
  - `waiting_external` in a column of kind `event`;
  - `running` in a column of kind `work`;
  - `queued` in Queued.

  Keep the pill for every other pair. `failed`, `lost` and `cancelled` still show as badges, as today.
- **FR-3** Put the rule in one pure helper, `cardMeta(card, column) → {stateLabel?, statusLabel?}`, in `components/format.ts`. The detail panel header is unchanged: it shows the state and status in full.
- **FR-4** Remove any other text duplicated in the same card. Today `checkingSummary` and the `checking` badge can say the same thing. Each piece of information appears once, and every removal is listed in the PR.

## Non-functional requirements
- **NFR-1** No layout shift: the meta row keeps its height when items are hidden.
- **NFR-2** Screen readers still hear the status: the hidden pill becomes a `visually-hidden` span, since the column heading carries it visually.

## Out of scope
Collapsing columns (UX-9), mobile (UX-12), agent names (UX-13b).

## Verification
- FR-1..FR-3: `format.test.ts` gets a table test of `cardMeta` over every column kind × status, and `Board.test.tsx` checks that a needs-input card in Needs input renders "needs input" once (visible text) and not at all in the meta row.
- FR-4: the PR lists each removed duplicate with a before/after screenshot of the board.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/src/components/{Board.tsx, Board.css, format.ts, format.test.ts, Board.test.tsx}`. **Do not touch**: other packages, `App.tsx`, `docs/tracking/*`.
- **Acceptance**: [ ] the tests above; [ ] screenshots in the PR; [ ] gates green.

### UX-11 · Top-nav icons
## Goal
Every top-nav control has an icon from a public icon library, so the bar is quick to scan and can shrink to icons on a phone (UX-12).

## Context
`packages/web/src/App.tsx` (`header.topbar`): text links Board, Workflow, Machines, then "Add a machine" and `HelpLink` (`help/HelpPage.tsx`), then the New ticket button and `AccountMenu` (`auth/AccountMenu.tsx`). The web package has no icon library yet.

## Functional requirements
- **FR-1** Add `lucide-react` (ISC licence, tree-shaken per icon) as a `packages/web` dependency. Pin an exact version and record the reason in the PR.
- **FR-2** Icons:
  - Board → `LayoutDashboard` (or `KanbanSquare`)
  - Workflow → `Workflow`
  - Machines → `Server`
  - Add a machine → `ServerCog` / `PlusCircle`
  - Help → `CircleHelp`
  - New ticket → `Plus`; while the form is open it reads "Close form" with `X`
  - the account menu button → `CircleUser`, keeping the user's initial or email as its label

  Each icon sits before its visible label, `aria-hidden="true"`, 16 px, `currentColor`.
- **FR-3** One `NavIcon` wrapper (`components/NavIcon.tsx`) sets the size, stroke and alignment, so every icon matches.
- **FR-4** Add a `.topbar.compact` style that hides the labels and keeps the icons. Icon-only links keep an accessible name (`aria-label` = the label) and a `title` tooltip. UX-12 turns it on below its breakpoint; this ticket ships it behind a test-only prop. (Built: `App`'s `compact` prop, passed to `Shell` and `AccountMenu`; in compact mode each control gets `aria-label` + `title`, so UX-12 should flip that prop rather than only adding the class in CSS.)

## Non-functional requirements
- **NFR-1** The web bundle grows by at most 15 KB gzipped. Report the before/after `vite build` sizes in the PR.
- **NFR-2** Icons read well in light and dark themes and with `aria-current` (the active tab).

## Out of scope
Icons anywhere else in the app (cards, detail panel); the mobile layout itself (UX-12).

## Verification
- FR-2: `App.test.tsx` checks that each nav control renders an `svg` and still has its accessible name ("Board", "Workflow", "Machines", "Add a machine", "Help", "New ticket", the account menu).
- FR-4: a compact-mode test checks that the labels are hidden and the accessible names stay.
- NFR-1: the bundle sizes are in the PR.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/package.json`, `pnpm-lock.yaml`, `packages/web/src/App.tsx` (top bar only), `auth/AccountMenu.tsx`, `help/HelpPage.tsx` (`HelpLink` only), `components/NavIcon.tsx`, `styles.css` (topbar rules). **Do not touch**: `components/Board.*`, other packages, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] bundle sizes; [ ] gates green.

### UX-13a · Agent team (server): team and hiring pools
## Goal
The agents feel like a real team. Each account has a **team** of named agents who are reused across tickets, and conductor **hires** a new one from the larger hiring pool only when nobody on the team is free.

## Context
Today `packages/web/src/components/agent-identity.tsx` derives a name and avatar from the ticket id (FNV-1a over `AGENT_NAMES`, about 160 names). Nothing is stored, so names rarely repeat. Ben, 2026-10-28: two pools. The team is the agents already hired. A ticket gets a free teammate, and hiring happens only when no teammate is free. Claiming: `packages/orchestrator/src/gateway/claim.ts`. Data model: docs/design/02-data-model.md. Contracts: docs/design/10-contracts.md.

## Functional requirements
- **FR-1** Move `AGENT_NAMES` (the hiring pool) to `packages/shared/src/agents/names.ts`. `web` re-exports it, so the old import keeps working.
- **FR-2** Migration (Ben approves):
  - `agent (id, account_id, name, hired_at, last_assigned_at)` with `UNIQUE (account_id, name)`;
  - `ticket.agent_id uuid NULL REFERENCES agent`.

  It is reversible, and existing tickets keep `agent_id NULL`.
- **FR-3** The assignment happens in the claim transaction, when work starts. A queued ticket holds no one.
  1. If the ticket already has an agent, keep it, so retries, reopen and resume keep the same agent.
  2. Otherwise pick the teammate with **no other active ticket** (a ticket whose session is not `done`, `failed`, `lost` or `cancelled`), with the oldest `last_assigned_at`, ties broken by `hired_at`.
  3. If nobody is free, **hire**: insert a new `agent` with a name from the hiring pool that isn't on the team yet. Choose it deterministically from a hash of the ticket id, then walk forward, so tests can predict it.
  4. If the whole pool is on the team and busy, reuse the least-recently-assigned teammate and log it.

  Set `last_assigned_at = now()`. Concurrent claims must never give one free teammate to two tickets: use `SELECT … FOR UPDATE SKIP LOCKED` on the team rows, or a partial unique index.
- **FR-4** DTOs, additive and optional on the wire:
  - `agent_name: string | null` on `BoardCard`, `SessionDetail` and `TicketDto`;
  - `GET /api/team` → `[{name, hired_at, last_assigned_at, active_ticket_id | null}]`, for UX-13b.

  `null` means "not assigned yet" (queued, or a ticket from before this change).
- **FR-5** 10-contracts and 02-data-model get the new fields, table and route.

## Non-functional requirements
- **NFR-1** Everything is scoped by account: one account's team is never visible to or used by another (it's tested).
- **NFR-2** The claim's latency is unchanged within noise. The team query uses the `(account_id)` index.

## Out of scope
The web changes (UX-13b); renaming or firing agents; per-user teams.

## Verification
- FR-3: orchestrator DB tests:
  - a ticket reuses a free teammate;
  - two concurrent claims get two different agents (run 20×);
  - a busy team hires a new name from the pool;
  - a reopened ticket keeps its agent;
  - two accounts get independent teams.
- FR-2: `schema.test.ts` migrates up, down and up.
- FR-4: contract tests; old fixtures without `agent_name` still parse.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Migration: stop at "PR open, awaiting Ben".

- **Files owned**: `packages/shared/src/agents/**`, `shared/src/api/rest.ts` (the additions), the new migration, `orchestrator/src/gateway/claim.ts` (the assignment call), `orchestrator/src/agents/**` (new), the board, detail and ticket queries for `agent_name`, `docs/design/{02-data-model.md, 10-contracts.md}`. **Do not touch**: `packages/web` (except the re-export line in `agent-identity.tsx`), `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] Ben approves the migration; [ ] gates green.

### UX-13b · Agent team (web): stored names and the Team list
## Goal
The board shows each ticket's real teammate, with the same face everywhere, and Ben can see who is on the team.

## Context
UX-13a adds `agent_name` to `BoardCard`, `SessionDetail` and `TicketDto`, plus `GET /api/team`. Today `components/agent-identity.tsx` (`agentName(ticketId)`, `AgentAvatar ticketId=`) derives both from the ticket id. They're used on the board card (`Board.tsx`), the panel header (`DetailPanel.tsx`) and Details.

## Functional requirements
- **FR-1** The name shown is `agent_name` when it's set. When it's null:
  - a queued card shows "Unassigned", with a neutral avatar;
  - a ticket from before UX-13a falls back to the old hash name.
- **FR-2** The avatar is derived from the **name**, not the ticket id, so a teammate has the same face on every ticket. `AgentAvatar` takes `seed`; existing call sites pass the name.
- **FR-3** A **Team** section on the Machines page (or `#/team` if that reads better; say which in the PR) lists each teammate with their avatar, when they were hired, and what they're working on now, linking to the card.

## Non-functional requirements
- **NFR-1** No extra requests per card: the name comes on the board DTO. The Team list makes one request.

## Out of scope
Server assignment (UX-13a); editing the team.

## Verification
- FR-1/FR-2: `agent-identity` and `Board.test.tsx` tests: the same `agent_name` on two cards gives the same avatar SVG; null gives "Unassigned" when queued and the hash name for an old ticket.
- FR-3: a component test of the Team list against a fixture.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/src/components/agent-identity.tsx`, its call sites in `Board.tsx` / `DetailPanel.tsx` / `details-sections.tsx` (the name and avatar only), `packages/web/src/team/**` (new), one nav or route line. **Do not touch**: other packages, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates green.

### UX-14 · Notifications (in-tab)
## Goal
When an agent needs feedback, Ben finds out without watching the board, as long as a conductor tab is open anywhere.

## Context
The board stream (`packages/orchestrator/src/stream/board.ts`, consumed in `packages/web/src/board/`) already carries card changes. A card needs feedback when it has an open `input_request` (needs-input cards: docs/design/06-human-input.md). Web Push for a closed tab is UX-15/UX-16; this ticket only covers what the open page can do.

## Functional requirements
- **FR-1** `packages/web/src/notify/useNeedsInputNotifications.ts`: it watches board updates and fires once per **new** open input request, keyed by `input_request.id` so a reconnect or re-render never fires twice. Requests that are already open when the page loads don't fire; they're counted (FR-3).
- **FR-2** When the browser `Notification` permission is `granted` and the page is hidden or unfocused, show a notification:
  - title: "<agent> needs input";
  - body: the ticket title and the question, clipped to 120 characters;
  - `tag`: the input request id.

  Clicking it focuses the tab and opens that ticket's detail panel.
- **FR-3** The document title becomes `(N) Conductor` while N cards need input, and the favicon gets a dot (a canvas or SVG favicon swap). Both clear at zero.
- **FR-4** The account menu gets a **Notifications** item:
  - it shows the state (off, on, or blocked by the browser);
  - it asks permission only from that click, never on page load;
  - the choice is stored per browser in `localStorage`, wrapped in try/catch.

## Non-functional requirements
- **NFR-1** No notification for the user's own action (an answer they just sent doesn't re-fire).
- **NFR-2** Works in Chrome, Firefox and Safari; when `Notification` doesn't exist the toggle is hidden and the title count still works.

## Out of scope
Web Push and the service worker (UX-15, UX-16); sounds; email.

## Verification
- FR-1..FR-3: vitest with a mocked `Notification` and board stream:
  - a new request fires once;
  - a reconnect replaying the same request doesn't fire;
  - a request already open at load doesn't fire;
  - the title count follows the cards;
  - clicking calls the select handler.
- FR-4: an AccountMenu test covering the permission states.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/src/notify/**` (new), one hook line in `App.tsx`, the menu item in `auth/AccountMenu.tsx`, `packages/web/index.html` (the favicon link id). **Do not touch**: `components/Board.*`, other packages, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] Ben gets a notification on the hosted board with the tab in the background; [ ] gates green.

### UX-15 · Notifications (Web Push, server)
## Goal
Conductor pushes "needs input" to Ben's subscribed browsers and phone even when no conductor tab is open.

## Context
Web Push: VAPID (RFC 8292) and message encryption (RFC 8291), sent to the endpoint each browser's push service gives. There's no new account or vendor (Ben, 2026-10-28). Outbox and idempotency: ADR-0003, `packages/orchestrator/src/engine/outbox.ts`. The engine invariants (CLAUDE.md §Rules): idempotency keys on external side effects; state and commands in one transaction. Security: docs/design/09-security-and-budgets.md.

## Functional requirements
- **FR-1** Migration (Ben approves): `push_subscription (id, user_id, endpoint UNIQUE, p256dh, auth, user_agent, created_at, last_ok_at, failures)`. It is reversible.
- **FR-2** REST, signed in, with the same CSRF/Origin rules as every `/api/*` write. Add these to `API_PATHS` and 10-contracts:
  - `GET /api/push/vapid-public-key`;
  - `POST /api/push/subscriptions {endpoint, keys:{p256dh, auth}}`, an upsert by endpoint;
  - `DELETE /api/push/subscriptions` (by endpoint);
  - `POST /api/push/test`, which sends "Notifications are on" to the caller's subscriptions.
- **FR-3** Config:
  - `CONDUCTOR_VAPID_PUBLIC_KEY`, `CONDUCTOR_VAPID_PRIVATE_KEY` and `CONDUCTOR_VAPID_SUBJECT` (a `mailto:`);
  - if they're missing, push is disabled: the routes return 404 `push_disabled` and nothing is sent;
  - `conductor-admin vapid-keys` prints a new key pair;
  - the deploy kit (`deploy/gradyserver/`) gets the env names and a runbook line. Generating the prod keys is a lead + Ben step after merge.
- **FR-4** Sending:
  - When an `input_request` row is created, the same transaction enqueues an outbox row `push_needs_input` with the idempotency key = the input request id, for each of the account's users who have subscriptions.
  - A dispatcher sends with the `web-push` library (pin an exact version): payload `{title, body, url: "/#/?ticket=<id>", tag: <input_request_id>}`, TTL 1 hour, urgency `high`.
  - A 404 or 410 deletes the subscription. Other failures count `failures`; after 5 the subscription is dropped.
- **FR-5** The payload carries no secrets and nothing beyond the ticket title, the agent name, and the question clipped to 120 characters.

## Non-functional requirements
- **NFR-1** The send never blocks the engine: it goes through the outbox, and a slow push service only delays pushes.
- **NFR-2** Subscriptions are per user and account-scoped. An endpoint can't be read back through the API.

## Out of scope
The service worker and the subscribe UI (UX-16); email; quiet hours.

## Verification
- FR-4: DB tests with a fake push sender:
  - one input request gives exactly one push per subscription, even across a dispatcher retry (idempotency);
  - a 410 deletes the subscription;
  - five failures drop it;
  - nothing is sent when VAPID isn't configured.
- FR-2: route tests (auth, CSRF, upsert, delete, test push).
- FR-1: `schema.test.ts` migrates up, down and up.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Migration: stop at "PR open, awaiting Ben".

- **Files owned**: the new migration, `orchestrator/src/push/**` (new), its outbox kind and dispatcher registration, one `app.register` line, `auth/admin-commands.ts` (`vapid-keys`), `shared/src/api/rest.ts` (the push additions), `deploy/gradyserver/` (env and runbook), `docs/design/{02-data-model.md, 10-contracts.md}`. **Do not touch**: `packages/web`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] Ben approves the migration; [ ] gates green.

### UX-16 · Notifications (Web Push, web)
## Goal
Ben turns on push once per device and gets "needs input" notifications with the tab closed, including on his phone.

## Context
UX-15 provides the VAPID public key, the subscription routes and the test push. UX-14 provides the account-menu Notifications item and the click-to-open behaviour. iOS Safari delivers Web Push only to a site added to the Home Screen, which needs a web app manifest.

## Functional requirements
- **FR-1** `packages/web/public/sw.js`, served at `/sw.js` with scope `/`:
  - the `push` handler shows the notification (title, body, `tag`, icon);
  - `notificationclick` focuses an open conductor tab or opens `data.url`.

  It caches nothing; it isn't an offline app.
- **FR-2** The UX-14 Notifications item becomes "This device: on/off":
  - turning it on asks permission, registers the service worker, subscribes with the server's VAPID key and POSTs the subscription;
  - turning it off unsubscribes and sends the DELETE;
  - "Send test" calls `POST /api/push/test`.
- **FR-3** Add `manifest.webmanifest` (name, icons, `display: standalone`, theme colour) and link it from `index.html`. On iOS, when push isn't available outside standalone mode, the menu says "Add Conductor to your Home Screen to get notifications".
- **FR-4** When push is subscribed on this device, UX-14's in-tab notification doesn't double-fire: the service worker's `tag` replaces it.

## Non-functional requirements
- **NFR-1** If the server says push is disabled (404 `push_disabled`), the toggle is hidden and UX-14 still works.
- **NFR-2** nginx serves `/sw.js` with `Cache-Control: no-cache` (a deploy kit line plus its nginx test).

## Out of scope
Server sending (UX-15); offline caching; per-ticket mute.

## Verification
- FR-2/FR-4: vitest with mocked `serviceWorker`, `PushManager` and `fetch`: subscribe and unsubscribe call the routes; a disabled server hides the toggle.
- FR-1: a unit test of the `sw.js` handlers with a fake `self`.
- Manual check by Ben on the hosted board: desktop with the tab closed, and iPhone from the Home Screen. Both show a notification for a real needs-input ticket, and tapping it opens that ticket.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/public/{sw.js, manifest.webmanifest, icons}`, `packages/web/index.html`, `packages/web/src/notify/push.ts` (new), the push part of the Notifications menu item, the `deploy/gradyserver/` nginx line for `/sw.js`. **Do not touch**: other packages, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] Ben's manual check on desktop and iPhone; [ ] gates green.

### UX-9 · Collapsible board columns
## Goal
Ben can collapse the columns he doesn't need right now (for example Done), so the ones that matter get the width.

## Context
`packages/web/src/components/Board.tsx`: each column is a `section.column` with an `h2` (title + count). Columns are workflow states (ADR-0010). Runs after UX-10, which edits the same file.

## Functional requirements
- **FR-1** Each column heading gets a collapse toggle (a button with `aria-expanded` and `aria-controls`).
- **FR-2** A collapsed column is a narrow vertical strip showing the rotated title and the card count. Clicking the strip or the button expands it.
- **FR-3** Collapsed columns are remembered per browser and per workflow, by column id, in `localStorage` (wrapped in try/catch). A column id that no longer exists is ignored.
- **FR-4** A collapsed **human** column (Needs input) still shows an attention dot when its count rises, so a new question isn't hidden.
- **FR-5** "Expand all" appears when any column is collapsed.

## Non-functional requirements
- **NFR-1** Keyboard: Tab reaches each toggle; Enter/Space toggles; focus stays on the toggle.
- **NFR-2** It doesn't re-render cards in other columns when a column toggles.

## Out of scope
Reordering or hiding columns permanently; mobile (UX-12, which builds on this).

## Verification
- FR-1..FR-5: `Board.test.tsx`:
  - toggling hides the cards and shows the strip with the count;
  - the state survives a remount via `localStorage`;
  - an unknown id is ignored;
  - a rising count in a collapsed human column shows the dot;
  - Expand all works.
- NFR-1: keyboard test.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/src/components/{Board.tsx, Board.css, Board.test.tsx}`, `components/board-layout.ts` (new, the stored layout). **Do not touch**: other packages, `App.tsx`, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] gates green.

### UX-12 · Mobile-friendly view
## Goal
Ben can triage conductor from his phone: see what needs him, read the question, answer, and move the ticket on.

## Context
The board is a row of columns (`components/Board.tsx`, `Board.css`), with the detail panel beside it (`.app.with-detail`). The top bar (`App.tsx`) has the icons and the compact mode from UX-11. Columns collapse (UX-9). Pair it with Web Push (UX-16) for the "phone buzzes, answer it" loop.

## Functional requirements
- **FR-1** Below 700 px wide:
  - the board shows **one column at a time**, with a scrollable column switcher (title + count per column);
  - it opens on **Needs input** when that column has cards, else the first non-empty column;
  - swiping left or right moves between columns.
- **FR-2** The detail panel opens full-screen with a back button. The composer and the transition buttons stay reachable above the on-screen keyboard (`dvh` units, `visualViewport` where needed).
- **FR-3** The top bar uses UX-11's compact mode (icons only). New ticket opens a full-screen form.
- **FR-4** Touch targets are at least 44×44 px. There's no horizontal page scroll at 360 px; the long tokens in a card wrap.
- **FR-5** `index.html` has `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, and safe-area insets are respected.

## Non-functional requirements
- **NFR-1** The desktop layout is unchanged above the breakpoint (existing tests still pass).
- **NFR-2** It works in iOS Safari and Android Chrome, including standalone (Home Screen) mode.

## Out of scope
A native app; offline; editing workflows on mobile (the Workflow page may stay desktop-first, with a "best on a larger screen" note).

## Verification
- FR-1..FR-4: vitest with a mocked `matchMedia` at 375 px: one column renders; it defaults to Needs input; switching works; the panel is full-screen with Back.
- The PR has screenshots at 375×812 and 360×740 (board, panel, new ticket).
- Ben's manual check on his phone against the hosted board.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

- **Files owned**: `packages/web/src/components/{Board.tsx, Board.css}`, `DetailPanel` layout CSS, `styles.css` (the responsive rules), `App.tsx` (layout switch only), `index.html` (viewport meta), `components/useMediaQuery.ts` (new). **Do not touch**: other packages, `docs/tracking/*`.
- **Acceptance**: [ ] tests; [ ] screenshots; [ ] Ben's phone check; [ ] gates green.
