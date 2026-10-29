# UI review: mobile and the design system (2026-10-29)

The "Mobile-friendly UX" ticket (replaces UX-12, ahead of UX-9). Ben: *"You can't see a ticket easily without scrolling around everywhere, the top nav is almost unusable, the create ticket form is terrible."* This review goes from the theme up to the user flows, then proposes the changes. Ben approves the proposals here, then the "after" set at the end.

**How the shots are made**: `node scripts/ui-screenshots.js --out before|after` starts the web app on the still mock API (`VITE_API=mock VITE_MOCK_STATIC=1`), drives Chrome (playwright-core) at 375×812 and 360×740 (phones, touch, 2×), 768×1024 (tablet) and 1440×900 (desktop), light and some dark, and writes the PNGs and [`metrics.json`](before/metrics.json): the page width against the device width, and the visible controls smaller than 44×44 px. Controls are clicked through the DOM, so a state behind an unreachable control is still captured.

Severity: **S1** blocks the job on a phone · **S2** slows it down or looks broken · **S3** polish.

## Measurements (before)

| Shot | Page width / device | Page height | Controls < 44 px in view |
|---|---|---|---|
| board 375 | **1146** / 375 | 2482 | 5 |
| board 360 | **1146** / 360 | 2356 | 5 |
| machines 375 | **763** / 375 | 1653 | 6 |
| workflows 375 | **734** / 375 | 1590 | 4 |
| setup 375 | **731** / 375 | 1583 | 41 |
| help 375 | 375 / 375 | 6270 | 1 |
| board 768 (tablet) | **1146** / 768 | 1528 | 25 |
| board 1440 | 1440 / 1440 | 941 | 30 |

Every app page is wider than a phone, so the whole page pans sideways, the top bar included. Only Help and Sign in fit.

## Findings

### 1 · Tokens (theme)

| ID | Sev | Finding | Evidence | Proposal |
|---|---|---|---|---|
| UXR-01 | S2 | Only colours are tokens. The CSS has **13 font sizes** (10, 10.5, 11, 12 ×70, 13, 14, 15, 16, 18, 19, 20, 24 px), **10 radii**, **48 distinct paddings**, 6 one-off shadows and 6 unrelated z-indexes. Nothing lines up between components. | `grep` over `packages/web/src/**/*.css` (3,118 lines) | Spacing `--space-1..6` (4/8/12/16/24/32), type `--text-xs/sm/base/md/lg/xl` (11/12/14/15/18/20), radius `--radius-sm/md/lg/pill` (4/6/10/999), `--shadow-1/2`, `--z-sticky/sheet/menu`, `--tap: 44px`. Use them in every rule this ticket touches; the rest of the CSS moves over in a TD follow-up. |
| UXR-02 | S1 | The base font is 14 px and inputs inherit it. **iOS Safari zooms the page on focus into any input under 16 px**, so every field (title, composer, repo) zooms and pans. | `styles.css :root font-size: 14px` | On phones, `input, select, textarea` get 16 px. Add `-webkit-text-size-adjust: 100%`. |
| UXR-03 | S2 | Dark mode: **white text on `--accent` is 2.65:1** (AA needs 4.5): Approve plan, Review pull request, the send arrow, Reopen. | contrast calc; `detail-1440x900-dark.png` | A `--on-accent` token: `#fff` in light, `#12151c` in dark (6.9:1). |
| UXR-04 | S3 | `--muted` `#6b7385` is 4.44:1 on `--bg` and **4.05:1 on the question block** (`--ask-bg`), under AA. Column headers and "Reply in the box below" use it. | contrast calc | `--muted: #5f6779` (5.3:1 on bg, 4.8:1 on ask-bg). Dark mode already passes. |
| UXR-05 | S3 | Input and card borders are 1.3:1 against the panel. Fields are hard to see (WCAG 1.4.11 asks for 3:1 for a control's edge). | `new-ticket-1440x900-light.png` | `--border-strong` for inputs, selects and textareas (about 3:1); `--border` stays for dividers and cards. |
| UXR-06 | S3 | Links have no style of their own: "Guided setup" and "Help: add a machine" are browser-default blue and underlined, next to `--accent` links elsewhere. | `machines-375x812-light.png` | A global `a { color: var(--accent) }`. |

### 2 · Primitives

| ID | Sev | Finding | Evidence | Proposal |
|---|---|---|---|---|
| UXR-07 | S1 | Buttons are about 26 px tall (`padding: 4px 10px`); the account button is 26 px; the radio buttons are 13 px; tabs, `×` close, `Copy` and quick actions are all under 44 px. | `metrics.json` samples: `button "local" 77×26`, nav links ×24 | On touch (`pointer: coarse`) and on phones, buttons, nav links, tabs and the close button are at least `--tap` tall, and radio/checkbox labels become 44 px rows. Desktop is unchanged. |
| UXR-08 | S3 | Badges are 11 px and wrap inside their pill ("Ready for review · 19m ago" breaks over two lines and the pill turns into a blob). | `detail-1440x900-light.png` (Needs input column) | Badges `white-space: nowrap` with ellipsis in narrow columns; the age moves out of the badge into the meta row. *(Desktop change: needs Ben's OK.)* |
| UXR-09 | S3 | The disabled Create ticket button gives no reason (it's disabled until Title and Kind are set). | `new-ticket-1440x900-light.png` | A one-line hint next to it: "Add a title and choose Work or Personal". |

### 3 · Components

| ID | Sev | Finding | Evidence | Proposal |
|---|---|---|---|---|
| UXR-10 | S1 | **Top bar**: 7 labelled controls plus the "Conductor" title in one row that doesn't wrap. On a phone only Board and Workflow show; Machines is cut off; **Add a machine, Help, New ticket and the account menu are off-screen.** UX-11's icon-only mode exists but is never turned on. | `board-375x812-light.png`, `account-menu-375x812-light.png` (the menu opens off-screen) | Below 700 px: icon-only mode, the title becomes the logo mark, and Add a machine + Help move into the account menu. That leaves 5 targets of 44 px. Safe-area padding at the top. |
| UXR-11 | S1 | **Board**: six columns of at least 180 px make the board 1,146 px wide. A phone shows one and a half columns; **Needs input is the 4th column**, about 2.5 screens to the right. | `board-375x812-light.png`, `board-scrolled-375x812-light.png` | Below 700 px: one column at a time, a scrollable switcher above it (title + count, Needs input in red), opening on **Needs input** when it has cards, swipe left/right to change column. |
| UXR-12 | S1 | **Detail panel**: tapping a card changes nothing on screen. Under 900 px the panel is laid out **below the whole board** (page height 2,482 px), so you have to know to scroll about 2 screens down to find it, and back up to get to the board. | `detail-375x812-light.png` (looks exactly like the board), `detail-scrolled-375x812-light.png` | Below 700 px the panel opens **full-screen** over the board, with a 44 px **Back** button; the composer is pinned above the keyboard (`dvh` + `visualViewport`). |
| UXR-13 | S2 | Panel header shows the status twice and once as a raw id: "needs input" chip, then "needs_input". Cards do the same with raw state ids: `conductor`, `implement`, `build`, `await_approval`. | `detail-1440x900-light.png`, `board-1440x900-light.png` | Show the state's title from the workflow, not its id; drop the duplicate in the header. *(Desktop change: needs Ben's OK; it touches `cardMeta`.)* |
| UXR-14 | S1 | **Create ticket form**: pushed in above the board with no heading and no close button (closing is the top-bar button, off-screen on a phone). Phone: Title, Repo, Priority and Kind, then a 60vh editor; **Create ticket is below the fold** and disabled with no reason. Desktop: a 4-column row of equal-width fields where Title is no bigger than Priority, and the Kind radios float on their own. | `new-ticket-375x812-light.png`, `new-ticket-bottom-375x812-light.png`, `new-ticket-1440x900-light.png` | Phones: a full-screen sheet ("New ticket" heading, Close), stacked fields, Kind as two big segmented buttons, Priority with a numeric keypad, and a **sticky footer with Create ticket** plus the reason it's disabled. Desktop *(needs Ben's OK)*: the same heading and Close; Title full width; Repo, Priority and Kind on one row. |
| UXR-15 | S2 | The rich editor (BlockNote) reserves a 48 px gutter on the left for its drag handle, which costs 13% of a phone's width. BlockNote also warns that the viewport meta lacks `interactive-widget=resizes-content`. | `new-ticket-375x812-light.png`; the console warning in the run | Narrow the gutter on phones; add `interactive-widget=resizes-content` to the viewport meta (it also keeps the composer above the keyboard on Android). |
| UXR-16 | S2 | **The pending question** is styled like an error (pink block, red text) even when it's a normal question. | `detail-scrolled-375x812-light.png` | Out of scope for this ticket; noted for a follow-up. |
| UXR-17 | S3 | Hover-only information: the full card preview, the agent's idle state and the badge details are `title=` tooltips, which a touch screen never shows. | `Board.tsx` `title=` | Acceptable once the panel opens full-screen in one tap (it shows the full text). No change. |

### 4 · Layout

| ID | Sev | Finding | Evidence | Proposal |
|---|---|---|---|---|
| UXR-18 | S1 | One breakpoint (900 px) that only stacks things; no phone layout at all. | `styles.css` | A phone breakpoint at 700 px (`(max-width: 699.98px)`) driven by one `useMediaQuery`, plus `pointer: coarse` for touch sizes. Desktop above 700 px is unchanged. |
| UXR-19 | S2 | `100vh` (detail panel, workflow page) is taller than the visible area on mobile browsers, so the bottom (the composer) hides behind the browser bar. | `styles.css .detail`, `workflow.css` | `100dvh`, and `--vvh` from `visualViewport` while the keyboard is up. |
| UXR-20 | S2 | No `viewport-fit=cover`, no safe-area insets, no `theme-color`. On an iPhone in standalone mode (UX-16) the top bar would sit under the notch. | `index.html` | Viewport meta `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`; `env(safe-area-inset-*)` on the top bar, the full-screen panel and the sheet footer; `theme-color` for light and dark. |
| UXR-21 | S2 | Machines: the table is 763 px wide, so the page pans. Workflow: the diagram is cut off on the right. Setup guide: the OS tabs and code rows push the page to 731 px. | `machines-375x812-light.png`, `workflows-375x812-light.png`, `setup-375x812-light.png` | Each wide block scrolls inside its own box (`overflow-x: auto`), never the page. Workflow page: a "Best on a larger screen" note on phones. |

### 5 · Flows on a 375 px phone

| Flow | Today | After the proposals |
|---|---|---|
| **(a) Triage**: notification → open the ticket → read the question → answer → move on | Open the board → pan right about 2.5 screens to find Needs input → tap the card → **nothing visible happens** → scroll down about 2 screens to find the panel → read → tap the composer (the page zooms, UXR-02) → answer → scroll back up and pan back left for the next one. About **8 gestures**, two of them blind. | Board opens on Needs input → tap the card → full-screen panel → answer in the pinned composer → Back. **3 taps**, nothing hidden. |
| **(b) Create a ticket** | Pan the top bar to find New ticket (off-screen) → the form opens above the board → each field zooms on focus → scroll past the editor → Create ticket is disabled with no reason. | Tap + → full-screen sheet → fill it in → Create ticket is always in the sticky footer, with the reason when it's disabled. |
| **(c) Machines** | Pan the top bar to reach Machines (cut off) → pan the table sideways. | Machines icon in the bar → the table scrolls inside its own box. Add a machine and Help are in the account menu. |

## Proposed changes (for Ben's approval)

**Phones (below 700 px); desktop above it unchanged** (UX-12 NFR-1):
1. Tokens (UXR-01) and 16 px inputs (UXR-02); the contrast fixes UXR-03 (`--on-accent`), UXR-04 (`--muted`), UXR-05 (`--border-strong`), UXR-06 (link colour). The colour fixes apply on desktop too: they're token values, nothing moves.
2. Top bar (UXR-10): icon-only, logo mark, Add a machine + Help in the account menu, safe area.
3. Board (UXR-11): one column, switcher, opens on Needs input, swipe.
4. Detail panel (UXR-12, UXR-19): full-screen with Back, composer above the keyboard.
5. Create ticket (UXR-14, UXR-15, UXR-09): full-screen sheet, segmented Kind, sticky Create with its reason, a narrower editor gutter.
6. Touch sizes (UXR-07) on `pointer: coarse` and phones.
7. `index.html` (UXR-20).
8. Other pages (UXR-21): wide blocks scroll in their own box; the Workflow note.

**Desktop changes, only if Ben says yes:**
- UXR-14 desktop: the form gets a heading and Close, Title full width, Repo + Priority + Kind on one row.
- UXR-08: badges don't wrap.
- UXR-13: state titles instead of raw ids on cards and the panel header.

**Not in this ticket** (follow-ups): UXR-16 (question styling), moving the remaining CSS onto the tokens, browser Back closing the panel, UX-9's collapsible columns (desktop only now).

## After

*(Filled in after the implementation: one row per finding with the before and after shots and a status.)*
