# 11 · Web UI: tokens, breakpoint, phone layouts

The web app (`packages/web`) has one desktop layout and, below a phone breakpoint, a phone layout. This doc covers the design tokens, the breakpoint, what changes on a phone, and the touch rules. The review behind it, with before and after screenshots, is [docs/qa/ux-review/README.md](../qa/ux-review/README.md) (the "Mobile-friendly UX" ticket, which replaced UX-12).

## Tokens

`packages/web/src/styles.css :root` holds every token. Colours follow `prefers-color-scheme` (a dark block re-sets them), so components never need their own dark rules.

| Group | Tokens | Values |
|---|---|---|
| Spacing | `--space-1` … `--space-6` | 4 / 8 / 12 / 16 / 24 / 32 px |
| Type | `--text-xs/sm/base/md/lg/xl` | 11 / 12 / 14 / 15 / 18 / 20 px |
| Radius | `--radius-sm/md/lg/pill` | 4 / 6 / 10 / 999 px |
| Shadow | `--shadow-1` (floating pill), `--shadow-2` (menus) | |
| Layers | `--z-sticky` 5, `--z-menu` 20, `--z-sheet` 40 | |
| Touch | `--tap` | 44 px (WCAG 2.5.5) |
| Colour | `--bg --panel --text --muted --border --border-strong --accent --on-accent` and the status pairs (`--warn`/`--warn-bg`, `--ask`/`--ask-bg`, `--ok`, `--diff-*`, `--user-*`, `--tool`, `--code-*`) | |

Contrast rules:
- `--muted` text meets AA (4.5:1) on `--bg` and on `--ask-bg`.
- Text on an `--accent` fill uses `--on-accent`: white in light mode, `--bg` in dark mode, where white on the lighter accent is only 2.65:1.
- Field edges use `--border-strong` (about 3:1, WCAG 1.4.11). `--border` is for dividers and cards.

Only the rules this design touched use the spacing, type and radius tokens so far. Moving the rest of the CSS onto them is a follow-up.

## Breakpoint

`MOBILE_QUERY = '(max-width: 699.98px)'` (`components/useMediaQuery.ts`).
- **JS** uses `useIsMobile()`, which returns false without `matchMedia`, so jsdom tests render the desktop layout unless they call `mockViewport(width)` from `src/test/match-media.ts`.
- **CSS** uses the same `@media (max-width: 699.98px)`.
- **Desktop is unchanged** above the breakpoint, apart from the token colour fixes and the top bar, which is sticky at every width. `useElementHeightVar` sets `--topbar-h` on `<html>` from the bar's measured height (it is taller on a coarse pointer), so the sticky desktop session panel sits 12 px below the bar. The CSS falls back to 49 px.
- Tablets (700 px and up) get the desktop layout, plus the touch sizes on a coarse pointer.

While the phone layout is on, `useVisualViewportHeight` sets `--vvh` and `--vvt` on `<html>` from `visualViewport.height` and `offsetTop`, rounded to whole pixels (`floor` and `round`: iOS reports fractions, and a fixed layer at a sub-pixel offset draws its text blurry). Full-screen surfaces use `top: var(--vvt, 0); height: var(--vvh, 100dvh)`, so they end above the on-screen keyboard and stay in view when iOS pans the layout viewport to a focused field. `100vh` is always paired with a `100dvh` override.

**The document never scrolls on a phone.** While the signed-in shell renders at phone width, `useDocumentClass('app-shell', mobile)` puts `app-shell` on `<html>`. Then `html` and `body` are `overflow: hidden; overscroll-behavior: none`, and `.app.mobile` is a fixed box the size of the visual viewport that does the scrolling (the sticky top bar sticks inside it). Inner scrollers (chat, Details tab, the sheet's form, menus) have `overscroll-behavior: contain`, so a fling never chains out to the page. While the create sheet is open, `.app` also has `creating` and stops scrolling. The auth pages and the help page render outside the shell and scroll the document as before.

## Phone layout

| Surface | Phone behaviour |
|---|---|
| Top bar | UX-11's compact mode: `App`'s `compact` prop defaults to `useIsMobile()`, and the prop still overrides it. The title becomes the logo mark; the text "Conductor" stays as the heading's accessible name. Add a machine and Help move into the account menu (`AccountMenu extraItems`), above Connect Claude, which the menu carries at every width and which opens `/help/connect-claude` (the MCP setup guide, a second page of UX-8's help page). The bar is sticky (as it is at every width) and padded by `env(safe-area-inset-top)`. |
| Board | One column at a time, chosen in a `role=tablist` switcher that scrolls sideways (title and count per column; the active tab is scrolled into view). It opens on Needs input when that column has cards, else the first non-empty column, until the user picks one. A horizontal swipe (more than 50 px, and 1.5× more sideways than vertical) moves to the next or previous column. The board is `touch-action: pan-y`, so vertical scrolling is never blocked. |
| Detail panel | `DetailPanel fullScreen`: fixed over the whole screen with safe-area padding. The board isn't laid out behind it. A 44 px Back button ("Back to board") replaces `×`, the tabs share the width, and the composer is pinned at the bottom of `--vvh`. It can't be scrolled away: the document under it never scrolls, and it follows `--vvt`. The header is one line (the title is ellipsed; the full title is in Details) with a 28 px avatar. **Ticket buttons** (`TicketButtons`, `TicketStrip.tsx`, at every width): nothing sits above the chat. The tab row holds the Messages and Details tabs (the `role=tablist`) and, on its right, a `role=group` "Ticket" with **Brief** (with a short tally: `3/5 ✓`, or `⚠ n` requirements without a verification), **Plan** when the session has one (`latestPlan`: the asking state's plan, else any state's text plan; labelled **Plan to approve** while a plan approval is open) and an **Edit** icon when the ticket is editable. On a phone the tabs share the rest of the row, **Plan to approve** shows as a highlighted "Plan" (its name stays "Plan to approve"), and the row scrolls sideways if it still doesn't fit. Each opens a sheet (`TicketSheet`: `role=dialog`, a heading and a 44 px Close; Escape closes it and focus returns to its button) over the tab bodies, chat and composer included, so the content gets the whole height below the tabs. Picking a tab closes the sheet (focus stays on the tab). The Brief sheet starts with the full tally ("FR 5 · NFR 5 · 4 without verification"). The Plan sheet shows the whole plan, with Approve plan and Request changes… in its footer while an approval is open. In the chat, the plan-approval card clamps the plan to about 8 lines and adds **Open plan**. The desktop panel has the same buttons and sheets; its plan-approval card keeps the "Show full plan" clamp instead of **Open plan**. |
| Create ticket | `CreateTicketForm sheet`: a full-screen modal dialog ("New ticket", with Close, and Escape also closes it). The fields are stacked, Kind is two segmented buttons (the radios stay for keyboard and screen readers), Priority has a numeric keypad, Repo's list of suggestions sits under its field with tap-tall rows, and the footer is sticky. The footer holds Create ticket and, while it is disabled, what's still needed. The editor's max height is half of `--vvh`, with a narrower BlockNote gutter. Like the panel, it follows `--vvt` and the shell under it doesn't scroll. |
| Machines, Admin | Tables scroll inside their own box (`display: block; overflow-x: auto; position: relative`), never the page. |
| Workflow | A "best on a larger screen" note; the diagram already scrolls in its own box. |
| Agent markdown (chat, plans, ticket) | At every width, GFM tables and code blocks scroll sideways in their own box (`.md-table-wrap`, `.md-code`), and long words and inline code wrap. The chat (`.output`) never scrolls sideways. |

`index.html` sets `viewport-fit=cover` and `interactive-widget=resizes-content`, and has a `theme-color` meta for each scheme.

## Touch rules

In `@media (pointer: coarse), (max-width: 699.98px)`:
- Buttons, nav links, tabs, menu items, inputs and selects are at least `--tap` tall. The card's title and preview buttons are excluded: they are text inside a tappable card.
- The panel's Back and Close buttons, and the sheet's Close, are at least `--tap` wide.
- The Kind labels are 44 px rows, and the composer's send button is 44 × 44.

On a phone, every `input`, `select` and `textarea` is 16 px, because iOS Safari zooms into any field smaller than that.

There must be no horizontal page scroll at 360 px. `scripts/ui-screenshots.js` checks it in `metrics.json` (`horizontalOverflow`).

## Create ticket: Repo field

At every width, Repo is a free-text ARIA combobox (`components/RepoCombobox.tsx`, the composer's slash-menu idiom). Its list is `GET /api/repos` ([10-contracts §Repo suggestions](10-contracts.md#repo-suggestions)): most used first, with a recency bias. Each option shows its ticket count.
- The field starts on the top repo, unless the user typed first. If the list fails to load, it stays a plain text field.
- Focusing the field lists every repo, and typing filters them (a case-insensitive substring match, ranked order kept). Arrow keys move through the list, and Enter or a click picks a repo without submitting the form. Escape closes the list without closing the sheet.
- After a create, the repo stays chosen and the list is fetched again.

## Repo checks (ADR-0030)

`#/repo-checks[/<repo>]` (`repo-checks/RepoChecksPage.tsx`), opened from the account menu at every width. It manages per-repo check overrides ([ADR-0030](../adr/0030-per-repo-checks-and-mcp-workflow-tools.md)) over `GET/PUT/DELETE /api/repo-checks`, the same functions as the MCP tools:
- The account's overrides in a table (repo, check names, setup, updated). A repo is opened from the table or from a Repo combobox (`GET /api/repos`), so one without an override can be opened too.
- For one repo, the checks that run at each gate of the latest `conductor` workflow that runs checks (`RepoChecksDetail.effective`), marked *Repo override* or *Workflow default*.
- The override editor is the transition editor's check list (`workflow/ChecksFields.tsx`), with the same rules (`checkListIssues`: unique names, non-blank commands, durations like `10m`) plus at least one check. Setup is auto-detect, none, or a command. Without an override, the draft starts from the workflow's first gate. The server's 400 details show at their fields. *Clear override* asks for a confirmation.
- A note says that commands run with `sh -c` at the repo root of a fresh checkout (Git Bash on Windows), with a link to ADR-0030.

## Follow-up tickets in the workflow editor (ADR-0034)

An agent column's panel has the checkbox "Agents may propose follow-up tickets" (`FollowUpsFields`, `workflow/ColumnEditor.tsx`). It shows the effective setting (`followUpsOf`): ticked for `plan_template` / `implement_template` while `follow_ups` is unset ([05 §Follow-up tickets](05-workflow-engine.md#follow-up-tickets-adr-0034)). Ticked, it shows At most (1–10) and Guidance, and editing either stores `follow_ups {enabled: true, …}`. Unticking it stores `enabled: false` where unset means on, and removes the key elsewhere (`setFollowUps(…, null)`). The proposals themselves are decided in Needs input ([06 §Proposed tickets](06-human-input.md#proposed-tickets)).

## Install (UX-16)

Conductor installs to a phone's Home Screen and opens standalone (`manifest.webmanifest`; iOS Safari: Share → Add to Home Screen). The status bar is `default` (opaque), so the web view starts below it: under `black-translucent` iOS blurred the top bar even though the document never scrolls on a phone ([§Breakpoint](#breakpoint)). The top bar keeps its `env(safe-area-inset-top)` padding (0 under an opaque bar) for Safari tabs and landscape, and `html` is painted `--panel` so any inset band matches the top bar. iOS reads the status-bar style when the app is added, so an installed copy must be removed and re-added to pick up a change. On iOS, push notifications work only from the installed app: in a Safari tab the account menu says so. In the installed app the menu also says when the server has push off or the permission is denied. The in-tab notifications (UX-14) go through the service worker, because iOS has no `new Notification()`. iOS suspends a backgrounded app, though, so only Web Push reaches a phone whose app is closed. Web Push details: [10 §Web Push](10-contracts.md#web-push).

## Not covered

- Browser Back doesn't close the panel or the sheet.
- The iOS keyboard, `dvh`, `visualViewport.offsetTop`, standalone mode and the status-bar blur can't be verified in Chromium emulation; they need a real phone. The opaque status bar and the whole-pixel `--vvh`/`--vvt` (the fixes for the blurry top bar) still need checking on a real iPhone.
- BlockNote on touch is unverified. The Plain markdown toggle is the fallback.
