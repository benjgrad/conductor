# 11 · Web UI: tokens, breakpoint, phone layouts

The web app (`packages/web`) has one desktop layout and, below a phone breakpoint, a phone layout. This doc covers the design tokens, the breakpoint, what changes on a phone, and the touch rules. The review behind it, with before and after screenshots, is [docs/qa/ux-review/README.md](../qa/ux-review/README.md) (the "Mobile-friendly UX" ticket, which replaced UX-12).

## Tokens

`packages/web/src/styles.css :root` holds every token. Colours follow `prefers-color-scheme` (a dark block re-sets them), so components never need their own dark rules.

Every stylesheet uses the tokens (UXR-22, UXR-57). `pnpm lint` runs `scripts/lint-css.js` first, which rejects, outside `:root`:
- a raw `font-size` length (px, rem, pt). Use `var(--text-*)`; `inherit`, `em` and `%` are fine;
- a `padding*`/`margin*` px value other than `0`, `1px` or `2px`. Use `var(--space-*)` (or `var(--tap)`), with `calc(-1 * …)` for a negative margin;
- a hex colour anywhere. Add a colour token instead.

Custom properties (`--tone: …`) are exempt. A real exception goes in `scripts/lint-css.allow.json` with its reason. An entry that no longer matches anything fails the lint.

| Group | Tokens | Values |
|---|---|---|
| Spacing | `--space-1` … `--space-8` | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px |
| Type | `--text-xs/sm/base/md/lg/xl` | 11 / 12 / 13 / 14 / 16 / 20 px: badges and chips xs (never smaller), meta lines sm, body base, card titles and section headings md at 600, page and sheet titles lg, hero headings xl |
| Radius | `--radius-sm/md/lg/pill` | 4 / 6 / 10 / 999 px |
| Shadow | `--shadow-1` (floating pill), `--shadow-2` (menus) | |
| Card edge | `--card-edge` (UXR-24): `--border-strong` mixed 55% into `--border` | about 2.0:1 on `--panel` light, 2.2:1 dark (`--border` alone is 1.3:1) |
| Layers | `--z-sticky` 5, `--z-menu` 20, `--z-sheet` 40 | |
| Touch | `--tap` | 44 px (WCAG 2.5.5) |
| Colour | `--bg --panel --text --muted --border --border-strong --accent --on-accent --accent-bg`, the semantic pairs ([§Colour semantics](#colour-semantics)), `--perm`/`--perm-bg` (an alias of the attention pair), `--diff-*`, `--user-*`, `--tool`, `--code-*` | |

Contrast rules:
- `--muted` text meets AA (4.5:1) on `--bg` and on every semantic `-bg`.
- Text on an `--accent` fill uses `--on-accent`: white in light mode, `--bg` in dark mode, where white on the lighter accent is only 2.65:1.
- Field edges use `--border-strong` (about 3:1, WCAG 1.4.11). `--border` is for dividers and cards.
- Each request kind's text on its own `-bg` meets AA (§Requests).
- `packages/web/src/tokens.test.ts` checks these ratios for both schemes, so a token change that breaks AA fails the tests.

Focus (UXR-56, UXR-58, UXR-72):
- `styles.css` draws one global `:focus-visible` ring (`2px solid var(--accent)`, offset 2px). A component may restyle it but never remove it. Where a field turns its own outline off, its wrapper draws an equivalent edge instead (the composer box, the rich ticket editor). The phone create-ticket sheet is a focused container, not a control, so it draws no ring.
- In the workflow diagram, SVG controls draw their own ring: a focused lane shows a dashed ring 4 px outside its box, and a focused arrow shows a dashed halo. Selection stays the solid accent border, so focus and selection can be told apart and can be shown together.
- Every icon-only control has an `aria-label` and a matching `title`, for example the Edit pencil ("Edit ticket") and the Brief button's `⚠ n` ("n hints"). Disclosure rows with a text summary keep that text as their name and get a "Show output" / "Hide output" tooltip.

Workflow diagram (UXR-45, UXR-68):
- The columns diagram fits the width of its box by default (all six columns show at 1440 px). The Fit / − / + bar above it zooms, and the box scrolls when zoomed.
- A column's kind is its border colour and icon: agent (accent, ✦), person (attention, ●), waiting (warn, ◷), queue (muted, ≡), end (ok, ■). The legend lists them. Column boxes are never dashed: dashed means only an arrow for "requirements not met".
- Arrows are labelled with transition titles (an event with its title, e.g. "Approved"), or "N ways" when several transitions share an arrow. A ✓ marks an arrow where some transition has rules. Labels sit on a solid background and slide along their line to a spot no other line crosses.

## Colour semantics

One meaning per colour (UXR-23). Each meaning has its own pair: the colour for text, icons and edges, and a `-bg` for its boxes and badges.

| Meaning | Tokens | Used for | Never for | Contrast light / dark (on its `-bg`, on `--panel`) |
|---|---|---|---|---|
| A person is needed | `--attention` / `--attention-bg` (violet) | the Needs input column (title, tab, dot, the waiting pill and count), `needs_input` and permission status, permission requests, the workflow's person lanes and states | failures | 5.8, 6.7 / 7.5, 8.1 |
| Failed or lost | `--danger` / `--danger-bg` (red) | failed or lost status, step-failed and `.git` alert badges, failure requests, form and workflow errors, a lost machine and its problems, destructive buttons | anything that is only waiting | 6.3, 7.4 / 6.9, 7.5 |
| Degraded or waiting | `--warn` / `--warn-bg` (amber) | routing (queued, no machine can take it), a draining machine, an update available, unsaved edits, unmet requirements on an arrow | failures | 5.4, 5.9 / 8.4, 9.7 |
| Information | `--info` / `--info-bg` (blue) | Question and plan-approval requests and badges, running status, proposals, conductor's own tool calls, notices | controls | 4.7, 5.3 / 5.4, 6.2 |
| Done or passed | `--ok` / `--ok-bg` (green) | done status, ready-for-review requests, passed checks | | 4.7, 5.3 / 7.3, 8.4 |

`--accent` is for controls only: primary buttons, links, selection, focus rings and active tabs. `--info` starts from the same blue, but the two are separate tokens so they can be told apart later. `--muted` is at least 4.5:1 on every `-bg` in both schemes. Diff colours (`--diff-*`) and the changed-in-a-version purple (`--tool`) are their own domains.

## Requests

A request waiting on a human sits at the end of the chat in one frame, `RequestCard` (`components/RequestCard.tsx`, `.pending.request-<kind>` in `styles.css`). The kind sets the box colour (a `--tone-bg` box with a 4 px `--tone` bar) and a sentence-case chip that names it, so colour is never the only cue. There are no "Action needed" caps. **Red (`--danger`) is only for failures.** `requestTone` (`request-preview.ts`) picks the kind.

| Kind | Tokens | Chip | When | Text on its bg (light / dark) |
|---|---|---|---|---|
| Question | `--info` / `--info-bg` | Question, Plan to approve, Budget exceeded… | an agent's question, a plan approval, any other decision | 4.7 / 5.4 |
| Ready for review | `--ok` / `--ok-bg` | Ready for review | a `*ready_for_review` move | 4.7 / 7.3 |
| Permission | `--attention` / `--attention-bg` (violet; `--perm` is an alias) | Needs permission | a held tool call (ADR-0023) | 5.8 / 7.5 |
| Failure | `--danger` / `--danger-bg` | Step failed, Retries exhausted, Timed out, Machine lost | `step_failed`, or a retries-exhausted, timeout or machine-lost request | 6.3 / 6.9 |

`--muted` (the "Avery asks" after the chip) is 4.9–5.2:1 on every `-bg`. The chip itself is `--tone` on `--panel` (5.3–8.4:1). The board card's request badges use the same pairs.

- **Review**: **Approve** (`button.primary`) takes `reviewApproveOption`, the state's one no-text human transition into a terminal state (`done`, "Merged, done"), so the button under the chat drops it. With none, or several, there is no Approve. **Request changes…** focuses the composer, whose answer goes back to the agent. *Open PR ↗* and *Full report* (a toggle) follow.
- **Failure**: its output sits under the question (`failureOutput`: the failed check's last run in the log, else the output the question quotes, else the last run), clamped to 12 lines behind "Show all". On old versions the quick actions are **Retry** (primary), **Skip to…** (a menu: choosing a state skips there) and **Abort…** (a separate danger button that asks first: *Abort session* or *Keep it*).
- **Composer** (`composerPlaceholder`): "Answer Avery…" on a question, "Ask Olga for changes…" on a review, "Tell Conductor what to do…" on a failure conductor raised, "Message Femi… (/ for commands)" while an agent runs. "Enter to send · Shift+Enter for a new line" is a line under the box, only on `(pointer: fine)`. When the composer is disabled, the placeholder is empty and the reason is shown once, under the box, as the textarea's description.

## Breakpoint

`MOBILE_QUERY = '(max-width: 899.98px)'` (`components/useMediaQuery.ts`): the phone layout below 900 px, desktop from 900 px (UXR-59; it was 700 px).
- **JS** uses `useIsMobile()`, which returns false without `matchMedia`, so jsdom tests render the desktop layout unless they call `mockViewport(width)` from `src/test/match-media.ts`.
- **CSS** uses the same `@media (max-width: 899.98px)`, and `(min-width: 900px)` for desktop-only rules.
- **Desktop** above the breakpoint keeps its layout, apart from the token colour fixes, the shell and the New ticket sheet ([§Create ticket on desktop](#create-ticket-on-desktop-uxr-41)). On the board (`.app.board-view`, UXR-26) the document never scrolls: the shell is `100dvh`, so the top bar stays put, each column's card list scrolls on its own, and the session panel fills the height beside the board with its composer pinned at the bottom. Other pages keep document scrolling under a sticky top bar; `useElementHeightVar` sets `--topbar-h` on `<html>` from the bar's measured height (taller on a coarse pointer, CSS fallback 49 px). `scripts/ui-screenshots.js` prints a `WARN` line when a board, detail or new-ticket shot above the breakpoint is taller than its window.
- Tablets in portrait (768–899 px) get the phone layout: one column with the switcher, the full-screen panel, the compact top bar, the full-screen New ticket sheet and tables that scroll in their own box (UXR-59: at 768 the desktop board was 1,146 px wide, the panel stacked under it and Add a machine wrapped in the top bar). Wider tablets (iPad landscape, 1024) get the desktop layout, plus the touch sizes on a coarse pointer. A two-column tablet board is not planned.

While the phone layout is on, `useVisualViewportHeight` sets `--vvh` and `--vvt` on `<html>` from `visualViewport.height` and `offsetTop`, rounded to whole pixels (`floor` and `round`: iOS reports fractions, and a fixed layer at a sub-pixel offset draws its text blurry). Full-screen surfaces use `top: var(--vvt, 0); height: var(--vvh, 100dvh)`, so they end above the on-screen keyboard and stay in view when iOS pans the layout viewport to a focused field. `100vh` is always paired with a `100dvh` override.

**The document never scrolls on a phone.** While the signed-in shell renders at phone width, `useDocumentClass('app-shell', mobile)` puts `app-shell` on `<html>`. Then `html` and `body` are `overflow: hidden; overscroll-behavior: none`, and `.app.mobile` is a fixed box the size of the visual viewport that does the scrolling (the sticky top bar sticks inside it). Inner scrollers (chat, Details tab, the sheet's form, menus) have `overscroll-behavior: contain`, so a fling never chains out to the page. While the create sheet is open, `.app` also has `creating` and stops scrolling. The auth pages and the help page render outside the shell and scroll the document as before.

## Navigation

One rule (UXR-27, UXR-28): pages in the top bar, account things in the account menu.
- **Top bar**, in order: Board · Workflow · Machines · Repo checks · Schedules (the `Main` nav), then **New ticket**, **Help** (a "?" icon at every width, the add-a-machine guide) and the account menu. Every control has an icon before its label; compact mode shows only the icon and names it by `aria-label`/`title`.
- **New ticket** is on every page. It opens the New ticket sheet over the board ([§Create ticket on desktop](#create-ticket-on-desktop-uxr-41)); anywhere else, or over the first-run guide, it goes to the board first, through the workflow editor's draft guard (a held-back navigation opens nothing), and opens the form there. Leaving the board closes the form.
- **Account menu**: the email, Notifications (or This device / Send test, UX-16), Change password, Admin (admins only) and Sign out. No page links.
- **Add a machine** is on the Machines page (the button, and the Guided setup link to `#/setup`) and in the first-run guide only. The Machines page also links **Connect Claude** (`/help/connect-claude`).
- **`aria-current="page"`**: at most one at a time (`currentNav` in `App.tsx`). `#/setup` counts as Machines and the first-run guide as Board; on `#/admin` no bar link is current and the menu's Admin item is.

## Phone layout

| Surface | Phone behaviour |
|---|---|
| Top bar | UX-11's compact mode: `App`'s `compact` prop defaults to `useIsMobile()`, and the prop still overrides it. The title becomes the logo mark; the text "Conductor" stays as the heading's accessible name. Every control stays in the bar, icon-only (see [§Navigation](#navigation)): nothing moves into the account menu. The page tabs abut (`gap: 0`) and the left padding is 8 px. Eight 44 px targets don't fit 360 px, so the `Main` nav scrolls sideways in its own box (no scrollbar) and the current tab is scrolled into view; New ticket, Help and the account menu stay in view. The bar is sticky (as it is at every width) and padded by `env(safe-area-inset-top)`. |
| Board | One column at a time, chosen in a `role=tablist` switcher that scrolls sideways (title and count per column; the active tab is scrolled into view). It opens on Needs input when that column has cards or a permission prompt is waiting ([§Waiting on you](#waiting-on-you-uxr-32)), else the first non-empty column, until the user picks one. A horizontal swipe (more than 50 px, and 1.5× more sideways than vertical) moves to the next or previous column. The board is `touch-action: pan-y`, so vertical scrolling is never blocked. |
| Detail panel | `DetailPanel fullScreen`: fixed over the whole screen with safe-area padding. The board isn't laid out behind it. A 44 px Back button ("Back to board") replaces `×`, the tabs share the width, and the composer is pinned at the bottom of `--vvh`. It can't be scrolled away: the document under it never scrolls, and it follows `--vvt`. The header is one line (the title is ellipsed; the full title is in Details) with a 32 px avatar. **Ticket buttons** (`TicketButtons`, `TicketStrip.tsx`, at every width): nothing sits above the chat. The tab row holds the Messages and Details tabs (the `role=tablist`) and, on its right, a `role=group` "Ticket" with **Brief** (with a short tally: `3/5 ✓`, or `⚠ n` requirements without a verification), **Plan** when the session has one (`latestPlan`: the asking state's plan, else any state's text plan; labelled **Plan to approve** while a plan approval is open) and an **Edit** icon when the ticket is editable. On a phone the tabs share the rest of the row, **Plan to approve** shows as a highlighted "Plan" (its name stays "Plan to approve"), and the row scrolls sideways if it still doesn't fit. Each opens a sheet (`TicketSheet`: `role=dialog`, a heading and a 44 px Close; Escape closes it and focus returns to its button) over the tab bodies, chat and composer included, so the content gets the whole height below the tabs. Picking a tab closes the sheet (focus stays on the tab). The Brief sheet starts with the full tally ("FR 5 · NFR 5 · 4 without verification"). The Plan sheet shows the whole plan, with Approve plan and Request changes… in its footer while an approval is open. In the chat, the plan-approval card clamps the plan to about 8 lines and adds **Open plan**. The desktop panel has the same buttons and sheets; its plan-approval card keeps the "Show full plan" clamp instead of **Open plan**. |
| Create ticket | `CreateTicketForm` (the same dialog at every width; desktop below): a full-screen modal dialog ("New ticket", with Close, and Escape also closes it). The fields are stacked, Kind is two segmented buttons (the radios stay for keyboard and screen readers), Priority has a numeric keypad, Repo's list of suggestions sits under its field with tap-tall rows, and the footer is sticky. The footer holds Create ticket and, while it is disabled, what's still needed. The editor's max height is half of `--vvh`, with a narrower BlockNote gutter. Like the panel, it follows `--vvt` and the shell under it doesn't scroll. |
| Machines, Admin | Tables scroll inside their own box (`display: block; overflow-x: auto; position: relative`), never the page. At every width (UXR-48), a machine row is one line: name, hostname, the alert badge and, when the machine has problems (`machineProblems`: gh too old, no git identity), a `⚠ N problems` chip that opens its drawer. The row's only action is Details; Rename and Revoke are in the drawer ([§Sheet](#sheet-side-panel)), whose Problems section has the full text and fixes. Admin shows what is true of a user as chips in one Status column (Admin, Locked, Disabled <date>), an invite's Admin as a chip after its email, and its status as a chip (UXR-53). The New invite row's Admin checkbox has the inputs' padding and border, so it lines up with them. An action cell is a real table cell (`td.table-actions` with a flex `.table-actions-inner` inside), so row borders are continuous: `display: flex` on a `<td>` broke them. |
| Workflow | A "best on a larger screen" note; the diagram already scrolls in its own box. The column, arrow and transition editors open full-screen (`fullScreen`, like the detail panel, UXR-44): fixed over `--vvh`/`--vvt` with safe-area padding, and a 44 px Back replaces `×`. Back goes to the parent panel (transition → arrow or column), and the column's goes back to the workflow; the breadcrumb still jumps. The page stays laid out under the panel, `inert`, so its scroll position survives. |
| Agent markdown (chat, plans, ticket) | At every width, GFM tables and code blocks scroll sideways in their own box (`.md-table-wrap`, `.md-code`), and long words and inline code wrap. The chat (`.output`) never scrolls sideways. |

`index.html` sets `viewport-fit=cover` and `interactive-widget=resizes-content`, and has a `theme-color` meta for each scheme.

## Touch rules

In `@media (pointer: coarse), (max-width: 899.98px)`. The coarse-pointer half applies at every width, as before; the width half follows the breakpoint, so the phone layout always has tap sizes (its Back button has no padding and relies on the `--tap` minimum):
- Buttons, nav links, tabs, menu items, inputs and selects are at least `--tap` tall. The card's title and preview buttons are excluded: they are text inside a tappable card.
- The panel's Back and Close buttons, the workflow editors' Back, and the sheet's Close, are at least `--tap` wide.
- The Kind labels are 44 px rows, and the composer's send button is 44 × 44.
- The side sheet's Close ([§Sheet](#sheet-side-panel)) is at least 44 × 44.

On a phone, every `input`, `select` and `textarea` is 16 px, because iOS Safari zooms into any field smaller than that.

There must be no horizontal page scroll at 360 px or 768 px. `scripts/ui-screenshots.js` checks it in `metrics.json` (`horizontalOverflow`). That also counts overflow clipped inside the phone shell (`.app.mobile`) or a panel (`clippedOverflow` names which), since the shell's `overflow-x: hidden` hides it from the document's width.

## Create ticket on desktop (UXR-41)

At 900 px and up, the same `CreateTicketForm` dialog is a centred modal (at most 760 px wide and 90 vh tall) over a backdrop. The top bar's New ticket button only opens it (the sheet covers the bar). Close, Escape or a click on the backdrop closes it. Title is full width; Repo, Priority and Kind share one row, with Kind as the phone's two segmented buttons. The form scrolls inside the sheet, under a sticky footer that holds the primary Create ticket and, while it is disabled, "Still needed: …". While the sheet is open, `<html>` has `modal-open` and the page under it doesn't scroll.

At every width, closing with unsaved input (a title, a description that differs from the untouched template, or attachments) asks first. "Discard this ticket?" replaces Create ticket in the footer, with **Discard** and **Keep editing**, and Escape there means Keep editing. It is inline, like the workflow editor's discard prompt: no browser dialogs. Repo, Priority and Kind alone don't count as unsaved input.

## Sheet (side panel)

UXR-47. `components/Sheet.tsx` is the shared side panel: `<Sheet title onClose ariaLabel? className?>{children}</Sheet>`. It renders through a portal into `document.body`, so no page container clips it.
- **Desktop:** a right-hand panel, `min(560px, 100vw)` wide, from below the top bar (`top: var(--topbar-h)`) to the bottom, so Help and the account menu stay visible. A dimmed backdrop covers the page under the bar. Layer: `--z-sheet`.
- **Phone:** full screen on `--vvt`/`--vvh`, like the create sheet, with no backdrop and safe-area padding in the head.
- A `role=dialog aria-modal` named by its heading (an `h2`), or by `ariaLabel`. The head has the heading and an icon Close (accessible name "Close").
- Focus moves to Close on open and goes back to the opener on close. Tab and Shift+Tab wrap inside the panel.
- Escape closes it, unless an inner widget handled that Escape first and called `preventDefault()` (the machine rename field does, so Escape leaves the form, then the sheet). A `pointerdown` anywhere outside the panel closes it, the top bar included, so a click on Help or the account button closes the sheet and then works.
- The body scrolls (`overscroll-behavior: contain`); the page under it is not scroll-locked on desktop, the backdrop only blocks clicks. Tables inside scroll sideways in their own box (`.table-scroll`, a shared utility in `styles.css`; a table not wrapped in one gets `display: block; overflow-x: auto`), so they never widen the panel.
- Used by the machine drawer (`machines/MachineDrawer.tsx`): hostname, Rename and Revoke…, Problems, the update notice, alerts, repos, repo rules and capabilities. The workflow editors, the new-ticket form and the ticket panel's `TicketSheet` can adopt it later.

`scripts/ui-screenshots.js` shoots `machine-drawer` (old-linux-box's drawer) and `admin` (the mock in password mode, through `?mock-auth=password`, read by `api/select.ts` in mock mode only) at 375, 768 and 1440.

## Create ticket: Repo field

At every width, Repo is a free-text ARIA combobox (`components/RepoCombobox.tsx`, the composer's slash-menu idiom). Its list is `GET /api/repos` ([10-contracts §Repo suggestions](10-contracts.md#repo-suggestions)): most used first, with a recency bias. Each option shows its ticket count.
- The field starts on the top repo, unless the user typed first. If the list fails to load, it stays a plain text field.
- Focusing the field lists every repo, and typing filters them (a case-insensitive substring match, ranked order kept). Arrow keys move through the list, and Enter or a click picks a repo without submitting the form. Escape closes the list without closing the sheet.
- After a create, the repo stays chosen and the list is fetched again.

## Attachments

The create form and the ticket editor have an attachment picker under the body (`components/AttachmentPicker.tsx`). It has an *Attach images or videos* button (the hidden file input accepts `ATTACHMENT_ACCEPT`), a drop zone (the whole picker), and paste: an image pasted into the body field is uploaded instead of pasted. Each file shows a thumbnail, its name, *uploading…* or the reason it was refused, and a Remove button. Create ticket / Save wait for uploads to finish (the sheet's hint says so). In the editor, existing attachments have Remove / Keep toggles, applied on Save. The gallery (`components/AttachmentGallery.tsx`) is a grid of 110 px tiles. A tile opens a full-screen lightbox, closed by Close, Escape or a click outside. Buttons keep the 44 px touch target, and names are ellipsized so nothing widens a 360 px page. Details: [06 §Attachments](06-human-input.md#attachments).

## Repo checks (ADR-0030)

`#/repo-checks[/<repo>]` (`repo-checks/RepoChecksPage.tsx`), a page in the top bar ([§Navigation](#navigation)). It manages per-repo check overrides ([ADR-0030](../adr/0030-per-repo-checks-and-mcp-workflow-tools.md)) over `GET/PUT/DELETE /api/repo-checks`, the same functions as the MCP tools:
- Two panes (UXR-76). **Left:** every repo the machines or tickets know (`GET /api/repos`) plus every repo with an override, one row per repo (`repoChecksKey`), grouped *Own checks* (by name, with check names and when it was set) and *Workflow checks* (in `/api/repos` order), with a filter. A filter that is a valid repo nobody knows offers "Open <repo>". The selected row uses the accent colour. **Right:** the repo as the heading, an *Own checks* / *Workflow checks* chip and "Runs at all N check gates · set … by …". On a phone the panes stack: the list, or the editor with "← Repos".
- The editor is in run order (UXR-77): Setup, then Checks (`workflow/ChecksFields.tsx`, the labelled check table of UXR-61), with the transition editor's rules (`checkListIssues`: unique names, non-blank commands, durations like `10m`) plus at least one check. Setup is auto-detect, none, or a command. Without an override, the draft starts from the workflow's first gate, and *Set override* stays disabled until the draft differs from it, so one click can't freeze today's defaults. The server's 400 details show at their fields.
- *Compare with the workflow's checks* is a disclosure: per gate (by title, "Implementing → Needs input (PR ready for review)"), the workflow's own checks (`checksGatesOf` of the latest `conductor` version) and what runs for this repo once the draft is saved. Identical gates share one row, "All N gates"; a row the draft changes is marked *Changed*.
- A sticky footer holds Discard and Save / Set override (UXR-79). Clearing is in its overflow menu ("Use workflow checks…") and asks with named buttons: "Use workflow checks" / "Keep own checks".
- Unsaved checks hold navigation away from the repo (UXR-81), through the workflow editor's draft guard (`workflow/draft-guard.tsx`, `DirtyDraft` kind `repo-checks`): the same "Unsaved changes" dialog, "Leave without saving" / "Keep editing". The advisor's proposals for the repo (UXR-73) sit between the compare disclosure and the footer.
- A note says that commands run with `sh -c` at the repo root of a fresh checkout (Git Bash on Windows), with a link to ADR-0030.
- The workflow advisor's open proposals for the repo's checks, with their readable diff, Apply and Reject (UXR-73; see [Version history](#version-history-compare-and-the-save-review-uxr-70-uxr-73)).

## Version history, Compare and the Save review (UXR-70, UXR-73)

The workflow editor's diffs are in the editor's words (`workflow/version-diff.ts`, rendered by `VersionDiff.tsx`): one item per column, transition or workflow setting, marked Added, Removed or Changed. A changed field is a line such as "Title: Planning → Plan", "Goes to **Done** instead of **Review**", "Check **test**: `npm test` → `pnpm test`", "Waits for **PR checks**" or "If not met: …", and a transition shows its `describeTransition` sentence before and after. Commands (setup, checks, a command column) are never clipped, since they run. A field without words still shows as "Other setting changed: `<key>`", so no change is hidden.
- **Version picker and History**: each version reads `v3 · 3 Oct 2026 · ben@example.com · <note>`. *History* lists every version (saved, by, note) with *View* and *Compare with latest*, and a From / To form compares any two. A comparison shows above the diagram and highlights the columns and arrows it changes (purple, dashed; `ColumnsDiagram` `changedStates` / `changedEdges`). Viewing an old version shows who saved it and *Compare with latest*.
- **Save review**: *Save as new version…* opens a dialog (`SaveReviewDialog.tsx`) with the changes from the **latest** version, which is what the save replaces even when the draft started from an older one, and an optional note (≤ 500 chars). A draft with no change from the latest cannot be saved. Cancel or Escape keeps the draft.
- **Advisor proposals** (`ProposalsPanel.tsx`): the detail shows the same readable diff from the proposal's whole change (`base_definition` / `proposed_definition`, `checks_before` / `checks_after`); a server without them falls back to the raw path table. An open workflow proposal highlights the columns and arrows it changes on the diagram. The Repo checks page lists the open proposals for that repo's checks (`kind=repo_checks&target=<repo>`) under its editor, and applying one there reloads the repo.

## Schedules (ADR-0032, UXR-83)

`#/schedules[/<id>]` (`schedules/SchedulesPage.tsx`), a top-bar tab after Repo checks (icon-only on a phone, like the others). It manages recurring jobs over `/api/schedules` ([10 §Schedules](10-contracts.md#schedules-adr-0032)), the same functions as the MCP tools `list_schedules` / `save_schedule` / `delete_schedule` / `run_schedule_now`. Nothing here is new server behaviour.
- **Rows** (a table that scrolls inside its box on a phone, as Repo checks): the name (opens Edit), repo and kind tag, any `warnings` in words; the rule in words (`schedules/cron-words.ts` `describeSchedule`: "Weekdays at 09:00 (Toronto)", or "Custom: `cron`" when no preset reads it); the next run in the viewer's time with how soon, or *Paused*; the last run's ticket as a link (`#/?ticket=<id>`, which opens it on the board, by its session or, for a queued run, its ticket) with its status, and "Skipped: last run still open" when the latest due run was skipped for that reason; an on/off switch (PATCH `enabled` with `expected_updated_at`; a conflict reloads the list), *Run now* and *Edit*.
- **Run now** sends `force: false`. A 409 `previous_run_open` becomes an inline prompt that says why (runs are skipped while the last one is open, so they don't pile up), links that ticket, and offers **Run anyway** (`force: true`) or Cancel. Success shows "Started" with a link to the new ticket.
- **New / Edit** (`schedules/ScheduleSheet.tsx`) is the New ticket sheet's shell (Close, Escape, backdrop, discard prompt, a sticky footer with "Still needed: …"): name, repo (`RepoCombobox`), kind, ticket title, the instructions (`TicketBodyField`), *When*, timezone (free text with the browser's IANA list; a new schedule starts on the browser's zone), pinned machines (checkboxes; none = any machine) and, for a new one, Enabled. *When* is a preset (Daily, Weekdays, Weekly on chosen days, Monthly on a day) plus a time, which writes the cron (`cronFromPreset`; an existing cron opens on its preset, `presetFromCron`), or *Advanced* with the raw cron. The rule is checked as the server checks it (`validateSchedule`: 5 fields, a known timezone, runs at least 15 minutes apart) and previews the next three runs. Edit sends only the changed fields with `expected_updated_at`; a 409 conflict offers **Reload**, and the server's 400 details show at their fields. **Delete…** asks first ("Its past tickets stay on the board").
- A card a schedule made links its ↻ chip to `#/schedules/<id>` (`components/Board.tsx`).

## Follow-up tickets in the workflow editor (ADR-0034)

An agent column's panel has the checkbox "Agents may propose follow-up tickets" (`FollowUpsFields`, `workflow/ColumnEditor.tsx`). It shows the effective setting (`followUpsOf`): ticked for `plan_template` / `implement_template` while `follow_ups` is unset ([05 §Follow-up tickets](05-workflow-engine.md#follow-up-tickets-adr-0034)). Ticked, it shows At most (1–10) and Guidance, and editing either stores `follow_ups {enabled: true, …}`. Unticking it stores `enabled: false` where unset means on, and removes the key elsewhere (`setFollowUps(…, null)`). The proposals themselves are decided in Needs input ([06 §Proposed tickets](06-human-input.md#proposed-tickets)).

## Waiting on you (UXR-32)

Two things wait on a person: an open question (`input_request`, the card is in Needs input) and a pending tool permission (ADR-0023, `sub_status: needs_permission`; the card stays in its agent's column with Allow once / Deny / Review). Every count of what waits on Ben counts both, through one helper (`board/waiting.ts` `waitingOnYou`); a card with both counts once, as a question.

Chosen presentation: a **"+N waiting for permission" note on the Needs-input header**, not a pinned strip. A held card keeps its column, so the column count stays the number of cards in it, and the note adds the rest:
- Desktop: a button under the Needs-input heading, shown even when the column is empty. It opens the oldest held card's session panel (oldest by `permission.expires_at`; every request has the same timeout). Collapsed, the strip shows `+N` after the count, and the FR-4 attention dot counts held cards too.
- Phone: the Needs-input tab of the switcher shows `+N` after its count (its accessible name spells it out), the column shows the same note, and the board opens on Needs input when only permissions wait ([§Phone layout](#phone-layout)).
- The tab title `(N) Conductor` and the favicon dot count questions plus held cards; a new permission prompt notifies like a question ([06 §In-tab notifications](06-human-input.md#in-tab-notifications-ux-14), [10 §Web Push](10-contracts.md#web-push)).
- The session panel header's one chip (UXR-40, `panelStatusLabel`) says **Waiting for permission** instead of the running state while a request is pending (`headStatus`, `components/format.ts`).

## Arrows, transitions and the breadcrumb (UXR-64, UXR-65, UXR-66)

The workflow editor has three panels: a column, an arrow and a transition.
- **Arrows**: clicking an arrow that stands for one transition opens it. One that stands for several opens the arrow panel (`ArrowEditor.tsx`). The panel lists them as rows (`TransitionList.tsx`): the title, who takes it, the ticket kinds ("Work only") and the rule count (checks, review items, actions and enabled conditions: `ruleCount`), so `pr_ready_for_review` and `personal_pr_ready_for_review` are told apart. The column panel lists its transitions with the same rows, plus where each goes.
- **Breadcrumb**: the arrow and transition panels open on a back arrow and a breadcrumb, Column › arrow › Transition (`EditorHead.tsx`). The arrow crumb shows only when the arrow stands for several transitions. Back goes to that list, else to the column (`parentOf`).
- **Name**: Title is the transition's first field. Its name is under **Advanced**, with "Agents report this name; prompts and history refer to it." A rename applies on blur or Enter, never per keystroke, and Escape puts the name back.
- **Remove transition** asks for a confirmation.

## Session transcript and Steps (UXR-38, UXR-88)

The Messages tab reads as a conversation (`OutputLog.tsx`). Protocol calls are not shown as steps: an accepted `complete_state` (its result is the daemon's "Recorded. Stop now: …") collapses to one muted line, "✓ Finished <state>", where the state is the one the session was in at that time (from `moves`). A refused or failed call stays a normal tool row, and **Debug lines** brings every raw call back. The conversation's opening user message (Claude's prompt, which carries the ticket) is labelled **Ticket** and rendered as markdown. Later messages from a person stay plain text. Phase dividers name the transition by its title (`moveTitle`), never its id. The "History loaded from Claude's transcript" notice is a bordered notice inset like the chat.

The Details tab has a **Steps** section between Action and Result (`steps.ts`): one row per state the ticket entered (from `SessionDetail.moves`), showing the state's title, its outcome (the title of the transition that left it; "In progress" while current; "Ended here" in a terminal state) and its duration. A row whose state recorded a result (`SessionDetail.context[state]`, the same data MCP `get_ticket_artifacts what=results` reads) has a **Result** disclosure that renders it as markdown: the summary, then the plan, then the other fields by name. Context keeps only a state's latest result, so an earlier visit of a revisited state says "Result replaced by a later visit". There is no separate route: `GET /api/sessions/:id` already carries both.

## Install (UX-16)

Conductor installs to a phone's Home Screen and opens standalone (`manifest.webmanifest`; iOS Safari: Share → Add to Home Screen). The status bar is `default` (opaque), so the web view starts below it: under `black-translucent` iOS blurred the top bar even though the document never scrolls on a phone ([§Breakpoint](#breakpoint)). The top bar keeps its `env(safe-area-inset-top)` padding (0 under an opaque bar) for Safari tabs and landscape, and `html` is painted `--panel` so any inset band matches the top bar. iOS reads the status-bar style when the app is added, so an installed copy must be removed and re-added to pick up a change. On iOS, push notifications work only from the installed app: in a Safari tab the account menu says so. In the installed app the menu also says when the server has push off or the permission is denied. The in-tab notifications (UX-14) go through the service worker, because iOS has no `new Notification()`. iOS suspends a backgrounded app, though, so only Web Push reaches a phone whose app is closed. Web Push details: [10 §Web Push](10-contracts.md#web-push).

## Help pages: contents (UXR-50)

Every help page (`/help/…`, `HelpPage.tsx`) has a short **Contents** list (`<nav aria-label="Contents">`) right under its title, with one link per `##` section. It is two columns from 700 px up. In the semantic heading mode, `Markdown` gives every `h2` an id (`headingId`: the text without markup, lowercased, other characters as `-`), and the links are plain `#id` anchors. Help pages render outside the shell, so no hash router sees them. `h3`s get no ids: "On Windows" repeats.

## Empty columns (UXR-54)

An expanded column with no cards shows one muted line saying what it is for (`board/column-purpose.ts`): "Tickets waiting for a machine." for Queued, "Agents plan tickets here." for Planning, "Finished tickets." for Done, and so on. A workflow's own columns fall back by state type ("An agent works on tickets here.", "Checks run here."). The line doesn't show in a collapsed strip, or in Needs input while its "+N waiting for permission" note is there. The phone's single column shows it too.

**Decided: a purpose line, not a strip by default.** UX-9's collapse is the user's choice, remembered per workflow. Collapsing every empty column automatically would make columns jump wider and narrower as cards come and go, and would fight FR-4's "new since collapsed" baselines. The phone layout never collapses. Anyone who wants an empty column out of the way can still collapse it.

## Feedback toasts (UXR-55)

A completed action is confirmed in one shared toast (`components/Toast.tsx`). `ToastProvider` wraps the whole app (`App`), so every page has it, and it always renders one region: `role="status"`, `aria-live="polite"`, `aria-atomic`, named "Notifications". The live region exists before any text arrives. The toast sits fixed at the bottom centre, above the safe area, and ignores the pointer. It shows one message at a time: a new one replaces the old one and restarts the timer. It clears after 3 s (`TOAST_MS`), and the same text twice is re-keyed so it is announced again. `useToast()` outside a provider does nothing.

It is for success only. A failure stays inline next to what failed (`role="alert"`). The messages:
- **Copy** (`useCopy`): "Copied", from every Copy button (install and setup commands, invite and reset links, IDs in Details, check output). The button keeps the label "Copy".
- **Save**: "Saved as v4" (workflow), "Ticket saved", "Checks saved" / "Checks cleared" (repo checks), "Repo rules saved" (machine), "Schedule created" / "Schedule saved".
- **Admin**: "Invite created", "Invite revoked", "Reset link created", "<email> unlocked", "<email> disabled". The one-time link still opens as before.

## Not covered

- Browser Back doesn't close the panel or the sheet.
- The iOS keyboard, `dvh`, `visualViewport.offsetTop`, standalone mode and the status-bar blur can't be verified in Chromium emulation; they need a real phone. The opaque status bar and the whole-pixel `--vvh`/`--vvt` (the fixes for the blurry top bar) still need checking on a real iPhone.
- BlockNote on touch is unverified. The Plain markdown toggle is the fallback.
