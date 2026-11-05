# UI review: the whole platform (2026-11-04)

The "UX" ticket: *"Do a full design review of our platform. Capture screenshots. I want you to give me your thoughts and list improvements you recommend for our UI."* The [mobile review](../README.md) (UXR-01..21, 2026-10-29) rebuilt the phone layout. This one looks at **every screen and state**, on desktop as much as on a phone, and ends with a prioritised list of recommendations. This is a review only: nothing here is built yet. Changes to the desktop layout need Ben's OK before anyone builds them.

**How the shots were made**: `node scripts/ui-screenshots.js --out full-2026-11`.
- The script starts the web app on the still mock API (`VITE_API=mock VITE_MOCK_STATIC=1`) and drives Chrome through playwright-core.
- Sizes: 375×812 and 360×740 (phones, touch, 2×), 768×1024 (tablet) and 1440×900 (desktop). Every shot is in light mode, and the key screens are also in dark.
- Output: 96 PNGs plus [`metrics.json`](metrics.json), which records the page width against the device width, the page height, and the visible controls smaller than 44×44 px.
- This review added the full set of screens (`FULL_REVIEW` in the script).
- It also added four mock **scenes** (`api/select.ts`, dev-only env flags) for states the default mock can't show:
  - accounts mode, signed in as admin;
  - accounts mode, signed out;
  - a first run with no machines;
  - a pending tool-permission request.

File names are `<screen>-<w>x<h>-<theme>.png`. Below, the bare screen name means the 1440 light shot unless a size is given.

Severity: **S1** blocks the job or looks broken to everyone · **S2** slows the job down or confuses · **S3** polish.

## My overall take

**What works, and should be kept**
- The **board is the product**, and it reads well. The columns are the workflow, Needs input is red and counted, and each card says who (agent avatar and name), how much ($), and how long ago. The agent avatars give the board personality without getting in the way.
- **The phone layout from the last review holds up.** No page pans sideways at 375 or 360. The board opens on Needs input, and the ticket opens full-screen with Back and a pinned composer ([board 375](board-375x812-light.png), [detail 375](detail-375x812-light.png)).
- **The guided setup is the best-designed screen.** It has a numbered stepper, OS tabs, one command per row with Copy, and a check command after each install ([first-run](first-run-1440x900-light.png)).
- **Dark mode is solid.** Every token pair I measured passes AA (accent 6.2:1, muted 5.6:1, ask 6.9:1 on their surfaces), and the accent buttons use `--on-accent` ([detail-review dark](detail-review-1440x900-dark.png)).
- The **checks panel** for a gate step (✓ Typecheck · passed, ◌ Unit tests · running, ☐ to do), with the sentence "Mateo has finished its part; it isn't running…", is exactly the right amount of explanation ([detail-checks](detail-checks-1440x900-light.png)).

**What holds it back.** The app was built ticket by ticket, and it shows. Each screen is reasonable on its own, but there's no shared visual grammar across screens, and the engine's vocabulary leaks into the UI. The four biggest problems:

1. **Raw engine ids are everywhere a person reads.** Cards say `implement`, `build`, `await_approval` and `conductor`; the panel header says "needs input · needs_input" and "done · done". Transitions show as `ready_for_testing`, `needs_approval_to_message …`, `personal_pr_ready_for_review`, and `inspect_pr` / `merge_pr` / `close_pr` sit next to "Open a pull request (by conductor)". UXR-13 deferred this last time; it's now the single biggest source of noise, on every screen.
2. **Every request for a human is styled as an alarm.** A question, a finished agent asking for a PR review, and a permission prompt all get the same pink "ACTION NEEDED" block, with a red bar, red caps and red chips ([detail](detail-1440x900-light.png), [detail-review](detail-review-1440x900-light.png), [detail-permission](detail-permission-1440x900-light.png)). Only one of the four Needs-input cards is actually a failure. When everything is red, nothing is. This is UXR-16, still open, and it now covers three more request kinds.
3. **The detail panel crushes the board on desktop.** Opening a ticket takes about 640 px. The board keeps four columns at about 160 px, so titles wrap onto three lines and Waiting external and Done drop out of view ([detail](detail-1440x900-light.png)). Meanwhile the panel is mostly empty white space below a short request.
4. **There's no shared pattern for overlays, editors and forms.** The machine drawer has no backdrop and covers the top bar. Change password floats over the board with no scrim. The workflow editors are side panels, the new-ticket form pushes the board down, and Add a machine is a yellow inline box. Checkboxes in the workflow editor float centred above their labels. Each overlay solves the same problem a different way.

## Measurements

From [`metrics.json`](metrics.json), compared with the previous review's [`after/metrics.json`](../after/metrics.json) where the shot exists in both.

| Shot | Page width / device | Page height (after → now) | Controls < 44 px in view (after → now) |
|---|---|---|---|
| board 1440 | 1440 / 1440 | 941 → **1231** | 36 → 34 |
| detail 1440 | 1440 / 1440 | 1122 → **1458** | 39 → 41 |
| new-ticket 1440 | 1440 / 1440 | 1650 → **2010** | 28 → 26 |
| board 768 (tablet) | **1146** / 768 | 1528 → 1625 | 14 → 16 |
| detail 768 | **1146** / 768 | 1985 → 2397 | 14 → 16 |
| machines 768 | **1018** / 768 | — (new) | 3 |
| workflows 768 | 768 / 768 | — (new) | 1 |
| board 375 | 375 / 375 | 986 → 812 | 6 → 6 |
| detail 375 | 375 / 375 | 812 → 812 | 0 → 0 |
| workflow-transition 375 | 375 / 375 (but its panel is clipped, UXR-38) | — (new) | 5 |
| help 375 | 375 / 375 | 6270 → 9765 | 1 → 1 |

- **Regression (UXR-26):** on desktop, the page itself now scrolls on the board, the detail panel and the form (941 → 1231 px). The board columns no longer fit the viewport, so the top bar scrolls away with the cards and the panel's composer can sit below the fold.
- The phones are clean: no horizontal overflow on any of the 54 phone shots.
- Tablet is still the weak size: the board, the detail panel and now the machines table all pan sideways (UXR-46).
- Help is 55% longer than in the last review. The content grew (Connect Claude, more steps), and there's no table of contents (UXR-41).

## Findings

IDs continue the series from the [mobile review](../README.md); UXR-01..21 are not reused.

### 1 · Visual language and tokens

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-22 | S2 | The tokens from UXR-01 exist but are barely used: 102 `var(--space/--text/--radius)` uses in 4,359 lines of CSS. There are still **17 font sizes** (`12px` ×78, `13px` ×18, `11px` ×14, `10px` ×6, `10.5px` ×2, plus 15/16/17/18/19/20/24) and 134 raw-pixel paddings. Workflow alone has 35 `font-size` rules. You can see it: the workflow editor's Title input is 12 px, its Prompt template input is 15 px, and the Repo/Priority inputs on the new-ticket form are 12 px. | [workflow-column](workflow-column-1440x900-light.png), [new-ticket](new-ticket-1440x900-light.png) | Finish the token migration (the TD that UXR-01 deferred). Map 10/10.5/11 → `--text-xs`, 12/13 → `--text-sm`, and 15/16/17 → `--text-md`. Add a stylelint rule that rejects a raw `font-size`/`padding` px outside `:root`. |
| UXR-23 | S2 | Most of the information is 10–12 px: badges ("Retries exhausted · 20m ago", "Ready for review"), card meta, column headers, the workflow legend and field labels. At 1440 the board reads as a wall of tiny bold text. Card titles are 15 px **extra bold**, so a card is a heavy title over tiny grey type, with nothing in between. | [board](board-1440x900-light.png) | A three-step type ramp: card title 14 px/600, body 13 px/400, meta 12 px. Badges no smaller than 11 px, and not bold-uppercase on top of a coloured pill. |
| UXR-24 | S2 | Colour carries too many meanings. **Yellow** means warning (daemon update), a neutral panel (Add a machine), "waiting for build slot", a routing note on a queued card, and "Step failed". **Red/pink** means a failure, a question, a review request and a permission prompt (UXR-27). **Blue** means link, primary button, "Ready for review" and "2 proposed". | [add-machine](add-machine-1440x900-light.png), [board](board-1440x900-light.png) | Write the colour semantics down in 11-web-ui and give each meaning one token: `--attention` (a person is needed, not an error: blue or violet), `--danger` (failed or lost), `--warn` (degraded or waiting), `--info` (neutral notes). The Add-a-machine box becomes a plain panel. |
| UXR-25 | S3 | There's no primary-button style outside a few places. "Create ticket", "Create account", "Change password", "Save rules", "New invite" and "Open" are all the default outline button, and they look disabled even when enabled. Only "Review pull request" and "Open pull request" are filled. | [signup](signup-1440x900-light.png), [change-password](change-password-1440x900-light.png), [admin](admin-1440x900-light.png) | A `.primary` button (accent fill, `--on-accent` text) for the one main action per form or dialog, used consistently. |

### 2 · Information architecture and navigation

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-26 | S2 | **Regression:** on desktop the whole page scrolls (board 941 → 1231 px tall). The top bar scrolls away, the board's columns don't scroll on their own, and the detail panel's composer is pinned to the panel, not the viewport. | [metrics.json](metrics.json) `board-1440x900-light` | Make the app shell `height: 100dvh` with the top bar fixed and each column (and the panel) scrolling on its own, as it was before. Add a metrics check (page height ≤ viewport on the desktop board) to the screenshot script, so this can't regress unseen again. |
| UXR-27 | S2 | **Navigation is split across four places with no rule.** The top bar has Board, Workflow, Machines, Add a machine, Help and New ticket. The account menu has Add a machine and Help again (on a phone), Connect Claude, **Repo checks**, **Admin**, Notifications, Change password and Sign out. The Machines page has *Add a machine*, *Guided setup* and *Help: add a machine*: three ways to the same thing, plus the top bar's. Repo checks and Admin are whole pages that only the account menu leads to. | [account-menu-admin 375](account-menu-admin-375x812-light.png), [machines](machines-1440x900-light.png) | Top bar: **Board · Workflow · Machines · Repo checks** (pages), then **+ New ticket**, Help (?), and the account menu. The account menu holds only account things: Notifications, Change password, Admin (admins), Sign out. Add a machine lives on the Machines page (and in the first-run guide), not in the top bar. |
| UXR-28 | S3 | The top bar changes per page: New ticket shows only on the board, and on the first-run guide **both** Board and Add a machine are highlighted as current. | [workflows](workflows-1440x900-light.png), [first-run](first-run-1440x900-light.png) | New ticket on every page (it opens the form over the board); exactly one `aria-current` item. |
| UXR-29 | S3 | Internal references leak into the UI: "New accounts arrive with M2-T15b" (Admin), "See ADR-0030" (Repo checks), "(an MCP client with the `workflow_advisor` prompt)" (Workflow), and "(open_pr)" in the engine's error text ("Conductor could not open the pull request (open_pr) to …", `shared/src/engine/apply.ts` `actionLabel`). | [admin](admin-1440x900-light.png), [repo-checks-list](repo-checks-list-1440x900-light.png), [workflows](workflows-1440x900-light.png) | Replace them with user words or remove them. Link to a Help page instead of an ADR. Drop the `(open_pr)` suffix from `actionLabel`. |

### 3 · Board

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-30 | S2 | **Raw state ids on cards** (UXR-13, deferred). "implement", "build", "await_approval", "conductor" (the workflow id, on queued cards), and "implementing → waiting_external (move: ready_for_testing)". These are the noisiest words on the board, and they repeat what the column already says. | [board](board-1440x900-light.png) | Show the state's `title` from the workflow, and only when it differs from the column. Show the workflow name only when the account has more than one. Write a pending move as "Moving to Waiting external · Ready for testing". |
| UXR-31 | S2 | **Badges wrap into blobs** (UXR-08, deferred). "Ready for review · 19m ago", "Retries exhausted · 20m ago" and "Step failed · 12m ago" break over two lines inside the pill whenever the panel is open. The age also repeats the card's own "19m ago". | [detail](detail-1440x900-light.png) | `white-space: nowrap` with ellipsis; drop the age from the badge (the card meta has it). |
| UXR-32 | S2 | **A permission prompt doesn't move the card to Needs input.** The agent is blocked, but the card stays in Implementing with Allow once / Deny / Review in the card, and the panel header says "running". So the Needs-input count (6) understates what's waiting on a person. | [board-permission](board-permission-1440x900-light.png), [detail-permission](detail-permission-1440x900-light.png) | Count permission prompts in the Needs-input badge and the title count (or show them in a pinned "Waiting on you" strip above the columns). In the header say "waiting for permission", not "running". |
| UXR-33 | S3 | Card actions are inconsistent: "Back with this answer…", "Waiting on someone else…" and "Done" are full-width outline buttons stacked on question cards; the review card has a filled "Review pull request ↗"; the permission card has "Allow once", "Deny" and a "Review" link. On desktop the stacked buttons make question cards twice as tall as the others. | [board](board-1440x900-light.png) | At most one action on a card (the recommended one), plus "Open" for the rest; put the full set in the panel. |
| UXR-34 | S3 | The routing note on a queued card ("needs a machine with acme/shop and az (signed in)") is monospace, yellow and squeezed into three lines, while the panel for the same ticket doesn't mention it at all. | [ticket-queued](ticket-queued-1440x900-light.png) | The panel shows the routing problem with a link to Machines; on the card, a single "No machine can take this" line. |

### 4 · Ticket and detail panel

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-35 | S2 | **Every request looks like an error** (UXR-16, deferred, now wider). Question, review request, permission and retries-exhausted all share the pink "ACTION NEEDED" block. A finished agent asking for a review is good news, but it's styled like a failure. | [detail](detail-1440x900-light.png), [detail-review](detail-review-1440x900-light.png), [detail-permission](detail-permission-1440x900-light.png), [detail-failed](detail-failed-1440x900-light.png) | One "request" card with a neutral or attention style and a kind label: Question (blue), Review (green), Permission (violet), Failure (red, the only red). Drop the "ACTION NEEDED" caps; the column already says it. |
| UXR-36 | S2 | **The composer doesn't know what it's answering.** The review request says "Reply in the box below to answer", and the box says "Answer the question… (Enter to send, Shift+Enter for a new line)". There's no Approve / Request changes, only a link to the PR. On a phone, the Enter/Shift+Enter hint is meaningless. On a gate step the reason is shown twice: as the placeholder and as a caption under it. | [detail-review](detail-review-1440x900-light.png), [detail-review 375](detail-review-375x812-light.png), [detail-checks](detail-checks-1440x900-light.png) | Per-kind placeholders ("Ask Olga for changes…", "Answer Avery…"). Explicit buttons on a review: **Approve**, **Request changes** (which focuses the box). The keyboard hint only on a fine pointer. The disabled reason shown once. |
| UXR-37 | S2 | The **panel wastes its space**. The request block takes 150–300 px, and the rest of an 800 px panel is empty. Meanwhile "Check output · Command (finished) · 1 line ▸" sits above the request, "Proposed follow-up tickets" sits at the very bottom, and the failure's "Last output attached" output is collapsed at the top, far from the question that refers to it. | [detail-review](detail-review-1440x900-light.png), [detail-failed](detail-failed-1440x900-light.png) | Order the panel as: the request (with its evidence inline, so a failure shows its output), then the conversation, then the follow-ups. Narrow the panel to about 520 px, or let it take the board's width with the board collapsed to a ticket list, so the board isn't crushed (top problem 3). |
| UXR-38 | S2 | Protocol and engine text reaches the transcript. "Step complete ⎿ Recorded. Stop now: do not call any other tool and end your turn." is shown as a step. "History loaded from Claude's transcript on mbp-ben" sits flush against the left edge with no padding. The ticket body is shown as raw markdown (`# Ticket:`, backticks). The timeline line reads "Implementing → Checks before Needs input · personal_pr_ready_for_review — Implemented and tested". | [detail-done](detail-done-1440x900-light.png), [detail-checks](detail-checks-1440x900-light.png) | Hide `complete_state`-style tool calls (or show them as "Finished planning"). Render the first user message as markdown. Pad the history note like the other notices. Use transition titles in the timeline. |
| UXR-39 | S3 | The retries-exhausted controls are hard to read: "Retry test", then a `skip to…` select, then a disabled "Skip", then "Abort" in red text, all the same size in one row. | [detail-failed](detail-failed-1440x900-light.png) | Make "Retry" primary. Put "Skip to…" behind a menu button that skips on choice. Separate "Abort" to the right as a danger button with a confirm. |
| UXR-40 | S3 | Panel header: the status appears twice ("needs input" chip and "Needs input" / "needs_input" / "done done"); "Brief ⚠ 4" has no explanation; the pencil icon (edit brief) has no label. | [detail-permission](detail-permission-1440x900-light.png), [detail-done](detail-done-1440x900-light.png) | One status chip; a tooltip and `aria-label` on ⚠ ("4 hints"); label the pencil "Edit brief". |

### 5 · Create and edit ticket

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-41 | S2 | The desktop form is unchanged since UXR-14 was deferred. It has no heading. Title, Repo and Priority are equal-width thirds. Kind floats as two small radios. The form pushes the board down (the page is 2,010 px tall). "Create ticket" is a disabled outline button at the bottom, with no reason given (the phone sheet says "Still needed: …"; the desktop form doesn't). | [new-ticket](new-ticket-1440x900-light.png) | Use the phone's sheet pattern on desktop too: a centred dialog or right-hand sheet titled "New ticket" with Close. Title full width; Repo, Priority and Kind (segmented) on one row. The editor scrolls inside. A sticky footer holds the primary **Create ticket** and the "Still needed" line. |
| UXR-42 | S3 | The queued ticket panel is sparse: Repo, Priority, Reference, Created, then "(no description)" and one "Edit ticket" button. There's no way to cancel the ticket or bump it up the queue from there. | [ticket-queued](ticket-queued-1440x900-light.png) | Add Cancel ticket and Priority ± to the panel; hide the empty description. |

### 6 · Workflow editor

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-43 | S1 | **Checkboxes float above their labels.** "People can edit tickets in the Queued column", "People can edit the ticket in this column" and "Agents may propose follow-up tickets" show a lone checkbox centred above the text. Cause: `.wf-check` is `flex-direction: column` (`workflow/workflow.css:513`), meant for the Checks rows in `ChecksFields.tsx`, but it is also used on checkbox labels in `ColumnEditor.tsx:115,302` and `WorkflowsView.tsx:303`. | [workflows](workflows-1440x900-light.png), [workflow-column](workflow-column-1440x900-light.png) | Give the checkbox labels their own class (`wf-toggle` already exists: `display: flex; align-items: center`). It's a 3-line fix. |
| UXR-44 | S1 | **On a phone the transition editor can't be closed.** The side panel overflows the right edge, the Close button is cut off, and the page text behind it squeezes into a one-word-wide column. | [workflow-transition 375](workflow-transition-375x812-light.png), [workflow-column 375](workflow-column-375x812-light.png) | On phones, open the editors as full-screen sheets with a Back button (the ticket panel's pattern). The "Best on a larger screen" note can stay. |
| UXR-45 | S2 | The diagram is the editor's whole point, but at 1440 it's cut off on the right (Waiting external and Done are off-screen), the edge labels are raw ids truncated with "…", and three green lines cross. With an editor open, it shrinks to about 1,000 px and shows four columns. | [workflows](workflows-1440x900-light.png), [workflow-transition](workflow-transition-1440x900-light.png) | Fit to width by default (the zoom exists). Label edges with transition titles. Show "×6" groups as one labelled edge, with the list in the editor. Collapse the explanatory paragraphs into a "How this works" disclosure. |
| UXR-46 | S3 | Editor fields mix ids and words. Name is `plan_ready` next to Title "Plan ready". Actions show "Open a pull request (by conductor)" next to `inspect_pr`, `merge_pr` and `close_pr`. The transitions list is `needs_approval_to_message → Needs input`. | [workflow-transition](workflow-transition-1440x900-light.png), [workflow-column](workflow-column-1440x900-light.png) | Lead with the title, and keep the id as a small secondary field under "Advanced". Give every action a human label. |

### 7 · Machines, setup and help

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-47 | S2 | The **machine drawer** has no backdrop, covers the top bar (Help and the account menu disappear) and cuts off the table behind it mid-column. Its own Repos table is clipped (the Mode column is cut off). | [machine-drawer](machine-drawer-1440x900-light.png) | A standard sheet: a scrim, below the top bar, `overflow-x: auto` on its tables, Esc and click-outside to close. Reuse it for the workflow editors and the new-ticket sheet (top problem 4). |
| UXR-48 | S2 | The machine table puts long warnings (gh too old; no git identity, with the full fix) as red paragraphs **in the Name cell**, which makes the row about 130 px tall and the table hard to scan. The row actions (Details / Rename / Revoke) sit outside the row's border line. At 768 the actions are off-screen (page 1,018 px wide). | [machines](machines-1440x900-light.png), [machines 768](machines-768x1024-light.png) | A one-line "⚠ 2 problems" chip in the row; the detail (and the fix) goes in the drawer. Rename and Revoke move into the drawer or an overflow menu, so the table fits 768. |
| UXR-49 | S3 | First-run step 1 says "Node.js 22 or newer: the daemon is a Node.js program". The daemon is moving to a Rust binary (ADR-0026, milestone MR); if that has shipped, this prerequisite is out of date. | [first-run](first-run-1440x900-light.png) | Check against the current installer and drop the Node step if the Rust daemon is what `install.sh` installs. |
| UXR-50 | S3 | The Help pages are long single columns (9,765 px at 375) with no table of contents or "on this page" links. | [help 375](help-375x812-light.png) | A short contents list at the top, plus anchors on every `h2`. |

### 8 · Auth and admin

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-51 | S2 | **Dialogs have no scrim.** Change password floats over the live board, which stays fully visible and clickable behind it. | [change-password](change-password-1440x900-light.png) | Use a `<dialog>` with `showModal()`, which gives a backdrop, focus trapping and Esc for free. |
| UXR-52 | S3 | Sign up and Reset: the main button is the plain outline style and disabled with no reason; no password rules are shown; there's no "Already have an account? Sign in" link; the only link is "Help: add a machine", which a new user can't act on yet. | [signup](signup-1440x900-light.png), [reset](reset-1440x900-light.png) | A primary button, the minimum password length under the field, a Sign-in link instead of the machine help. |
| UXR-53 | S3 | Admin is a bare page: two tables with Yes/No/— cells, an invite row whose "Admin" checkbox sits lower than the inputs beside it, and the M2-T15b note (UXR-29). The row actions sit outside the row border (the same table bug as UXR-48). | [admin](admin-1440x900-light.png) | Status chips (Admin, Locked) instead of Yes/No columns; align the invite row; fix the shared table action cell. |

### 9 · Empty, loading and error states, and feedback

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-54 | S3 | An empty column is a tall empty box with only "PLANNING 0" in its header (it's 0 on the seeded board); the first-run board isn't shown at all, because the guide replaces it. Nothing explains what a column is for. | [board](board-1440x900-light.png) | Empty columns collapse to a narrow strip by default (UX-9 has the mechanics), or show one muted line ("Agents plan tickets here"). |
| UXR-55 | S3 | There's no shared feedback pattern. Saves, copies and invites change inline text (or nothing); there's no toast or status region visible in any shot. The only place that shows a disabled reason is the phone ticket sheet. | — | One `role="status"` toast for completed actions ("Copied", "Invite created", "Saved v4"), and a rule that every disabled primary button says why. |

### 10 · Accessibility

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-56 | S2 | Focus styles are custom in only a few places: card preview, column toggle, diagram nodes, ticket editor toggles. The workflow diagram and onboarding set `outline: none` and replace it. Everything else relies on the browser default, which is hard to see on the pale blue active-nav pill and on filled buttons. | `grep focus-visible` over `packages/web/src/**/*.css` | A global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`, and remove the one-off rules. |
| UXR-57 | S3 | Contrast passes for every text token I measured: muted 5.7:1, accent 5.3:1, ask 6.3:1, warn 5.4:1 and the "Personal" tag (`--tool`) 4.6:1 in light; muted 5.6:1 and accent 6.2:1 in dark. But card borders (`--border` on `--panel`) are 1.3:1, so cards separate only by the background colour. On a bright screen the board reads as one sheet. | [board](board-1440x900-light.png) | Give cards a 1 px `--border-strong` at 50% opacity, or the `--shadow-1` token, so cards read as objects. |
| UXR-58 | S3 | The pencil (edit brief) and the "▸" disclosures in the transcript are icon-only, with no visible label. The account menu's "Admin" item has no icon while the others do. | [detail](detail-1440x900-light.png), [account-menu-admin 375](account-menu-admin-375x812-light.png) | `aria-label` plus a tooltip on icon-only controls; an icon for Admin, for consistency. |

### 11 · Tablet (768)

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-59 | S2 | The tablet still gets the desktop layout with no room for it. The board is 1,146 px on a 768 px screen; the detail panel opens below the board (page 2,397 px tall); the machines table pans (1,018 px); and "Add a machine" wraps onto two lines in the top bar. | [board 768](board-768x1024-light.png), [detail-review 768](detail-review-768x1024-light.png), [machines 768](machines-768x1024-light.png) | Move the phone breakpoint up to about 900 px for the board and panel: one column with a switcher, and a full-screen panel. That's the phone layout on a bigger canvas, with no new component. Or, at minimum, start with Queued, Planning and Done collapsed on tablets. |

## The earlier review's deferred items

| ID | Still true? | Where it lives now |
|---|---|---|
| UXR-08 badges wrap | **Yes**, and more visible with the panel open | UXR-31 |
| UXR-13 raw state ids | **Yes**, and it has spread to the workflow editor and the timeline | UXR-30, UXR-38, UXR-46 |
| UXR-14 desktop create form | **Yes**, unchanged | UXR-41 |
| UXR-16 question styled like an error | **Yes**, and it now also covers review, permission and failure requests | UXR-35 |
| Tablet board pans | **Yes**, and now the machines table and the detail panel too | UXR-59 |
| CSS onto tokens | **Mostly not done** (102 token uses in 4,359 lines) | UXR-22 |

## Recommendations, in order

**Quick wins** (each about an hour, low risk):
1. **Fix the floating checkboxes** (UXR-43): `ColumnEditor.tsx`, `WorkflowsView.tsx`, `workflow.css`. **S.**
2. **Remove the internal references** (UXR-29): `admin/Admin.tsx` `NEW_ACCOUNTS_NOTE`, `repo-checks/RepoChecksPage.tsx`, the `WorkflowsView` advisor sentence, and `shared/src/engine/apply.ts` `actionLabel`. **S.**
3. **One primary-button style and a scrim for dialogs** (UXR-25, UXR-51): `styles.css`, `ChangePasswordDialog.tsx`, `SignUp.tsx`, `Reset.tsx`, `Admin.tsx`. **S.**
4. **Badges don't wrap, and the duplicate age goes** (UXR-31): `Board.css`, `Board.tsx`. **S.**
5. **A global `:focus-visible` ring** (UXR-56): `styles.css`. **S.**

**Next** (a ticket each):

6. **State and transition titles instead of ids, everywhere** (UXR-30, UXR-38, UXR-40, UXR-46): `cardMeta` in `Board.tsx`, the `DetailPanel` header and timeline, the workflow editors. This is the biggest readability win. **M.**
7. **Request cards by kind** (UXR-35, UXR-36, UXR-39): one neutral request component with Question, Review, Permission and Failure variants. Review gets Approve / Request changes; placeholders depend on the kind. Files: `DetailPanel.tsx`, `ReviewRequest.tsx`, `PermissionRequests.tsx`, `QuestionOptions.tsx`, and the colour tokens (UXR-24). **M.**
8. **Restore the fixed app shell on desktop** (UXR-26), and add a page-height check to `scripts/ui-screenshots.js`. **S–M.**
9. **One sheet component** for the machine drawer, workflow editors (full-screen on phones, which fixes UXR-44), new ticket on desktop (UXR-41) and change password (UXR-47, UXR-51). **M.**
10. **Navigation cleanup** (UXR-27, UXR-28): Repo checks into the top bar, account-only items in the account menu, one Add-a-machine entry, New ticket on every page. `App.tsx`, `AccountMenu.tsx`. **S–M.**
11. **Permission prompts count as "waiting on you"** (UXR-32): the board's Needs-input count, the title count, the panel header. **S–M.**

**Bigger bets:**

12. **Rethink the desktop detail layout** (UXR-37, top problem 3): either a narrower panel with the request at the top and evidence inline, or a "focus" mode where the board collapses to a list on the left. Prototype both against the 1440 shots before picking. **L.**
13. **Finish the token migration with a lint rule** (UXR-22, UXR-23): a type ramp, then move each CSS file over, with stylelint to keep it there. **L**, but it can be done file by file.
14. **Tablet layout** (UXR-59): move the phone breakpoint to about 900 px and check the board, the panel and the machines table. **M.**
15. **Workflow diagram readability** (UXR-45): fit to width, titled edges, grouped parallel edges. **M–L.**

## Not captured

- **An error or offline state** (the board stream disconnected, an API failing). The mock can't fail on demand. A `VITE_MOCK_SCENE=offline` would let a later review shoot it.
- **Loading states.** The still mock answers instantly.
- **The first-run *board*:** with no machines, the guide replaces the board, so there is no "empty board" to see.
- **The Team list (UX-13b FR-3)**: not built yet.
- **A real iPhone** (keyboard, standalone mode): carried over from the [mobile review](../README.md#still-to-check-on-a-real-phone).
