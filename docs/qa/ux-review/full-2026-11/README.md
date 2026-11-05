# UI review: the whole platform (2026-11-04)

The "UX" ticket: *"Do a full design review of our platform. Capture screenshots. I want you to give me your thoughts and list improvements you recommend for our UI."* The [mobile review](../README.md) (UXR-01..21, 2026-10-29) rebuilt the phone layout. This one looks at **every screen and state**, on desktop as much as on a phone, and ends with a prioritised list of recommendations. Ben then asked for three deeper looks, each with its own section: [the workflow designer's rules builders and navigation](#the-workflow-designer-in-depth), [repo checks overrides](#repo-checks-overrides-in-depth) (with a proposed redesign), and [the MCP tools that still have no web UI](#mcp-tools-without-a-web-ui). This is a review only: nothing here is built yet. Changes to the desktop layout need Ben's OK before anyone builds them.

**Examples:** [`examples.html`](examples.html) is a self-contained page (open it in a browser) that puts a crop of today's screen next to an HTML mock-up of the proposed fix, for the main findings in each area.

**How the shots were made**: `node scripts/ui-screenshots.js --out full-2026-11`.
- The script starts the web app on the still mock API (`VITE_API=mock VITE_MOCK_STATIC=1`) and drives Chrome through playwright-core.
- Sizes: 375×812 and 360×740 (phones, touch, 2×), 768×1024 (tablet) and 1440×900 (desktop). Every shot is in light mode, and the key screens are also in dark.
- Output: 111 PNGs plus [`metrics.json`](metrics.json), which records the page width against the device width, the page height, and the visible controls smaller than 44×44 px.
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

## The workflow designer in depth

Ben asked for a closer look at the rules builders for transitions, and at how you get around the workflow designer. These shots are desktop-only (1440×900); the phone editor is UXR-44. Shots with *(full height)* let the editor panel grow to its full height, so every field is visible at once. In the app, the panel scrolls inside a box about 800 px tall.

| Shot | What it shows |
|---|---|
| [wf-arrow-group](wf-arrow-group-1440x900-light.png) | The ×5 arrow from Implementing to Needs input: five transitions as tabs above one form |
| [wf-rules-full](wf-rules-full-1440x900-light.png) *(full height)* | `ready_for_testing`, the richest transition: every section of the builder filled in |
| [wf-rules-new](wf-rules-new-1440x900-light.png) *(full height)* | `plan_ready` after Add check, Add review item and Add condition: the problems list, the inline errors, and "When not met" appearing |
| [wf-name-error](wf-name-error-1440x900-light.png) | Renaming a transition to `Plan ready!` |
| [wf-column-human](wf-column-human-1440x900-light.png), [workflow-column](workflow-column-1440x900-light.png), [wf-column-done](wf-column-done-1440x900-light.png) | The column editor for a person column, an agent column and the final column |
| [wf-diagram-end](wf-diagram-end-1440x900-light.png) | The diagram scrolled to its right-hand end |
| [wf-version-old](wf-version-old-1440x900-light.png) | v1, with the old "requirements to enter" drawn inside its column |
| [wf-unsaved-guard](wf-unsaved-guard-1440x900-light.png) | A draft, then a click on Board |
| [wf-proposal-open](wf-proposal-open-1440x900-light.png) | An advisor proposal opened, with its diff |
| [wf-keyboard-focus](wf-keyboard-focus-1440x900-light.png) | Keyboard focus on a column |

### How it works today

You get around the designer by clicking:
- **Clicking a column** opens the column editor on the right. It shows Title, "People can edit the ticket", Work (prompt template, model, tools, follow-ups) and the list of transitions *out of* that column.
- **Clicking a transition** in that list, or an arrow in the diagram, replaces the column editor with the transition editor.
- **Inside the transition editor**, the fields run top to bottom:
  1. Name and Title.
  2. Goes to.
  3. When to take it.
  4. Taken by.
  5. For tickets (Work / Personal).
  6. Asks a question.
  7. Notify me.
  8. **Requires**: Checks (with the setup before them), Review (items and a reviewer model), Actions, and Conditions (with "Wait at most" and "Check every").
  9. **When not met**: Back to, With instruction, Up to (times), Then.
  10. Remove transition.

  Every change goes into one draft. *Save as new version* sits at the top of the page.

What works:
- **The order of Requires matches the order things run**: checks, then review, then actions, then conditions. The intro sentence says so.
- **The problems list** at the top names each problem by column and transition, and has a *Show* button that jumps to it. The diagram turns the broken arrow red ([wf-rules-new](wf-rules-new-1440x900-light.png)).
- **The rename check** is plain and specific: "use a name without spaces, e.g. ready_for_review" ([wf-name-error](wf-name-error-1440x900-light.png)).
- **Column titles update the diagram as you type**, and a draft is guarded against navigating away ([wf-unsaved-guard](wf-unsaved-guard-1440x900-light.png)).
- **Running tickets are safe**: "Saving creates v4. Running tickets keep the version they started on" is exactly the reassurance an editor needs.

### Findings

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-60 | S1 | **The most consequential settings in the product are the hardest to read.** A transition with rules is a single column about 2,000 px tall, inside a 380 px panel that scrolls on its own. There is no summary anywhere: to learn what `ready_for_testing` does, you scroll through 30 fields and assemble it in your head. The diagram only adds a "✓" to the arrow. | [wf-rules-full](wf-rules-full-1440x900-light.png) | Put a **plain-language summary** at the top of the editor, generated from the fields. For example: "When the agent says *Ready for testing* (work tickets): set up with auto-detect, run *Build passes* and *Tests pass*, have a reviewer check 1 item, open a PR, then wait up to 3 d for PR checks and 1 approval → **Waiting external**. If not met: back to Implementing with your instruction, up to 3 times, then **Needs input**." Below it, **collapsible sections**, each with a count in the header: *Who and when* · *Checks (2)* · *Review (1)* · *Actions (1)* · *Conditions (4)* · *When not met*. Widen the editor to about 600 px, or open it as a full-width sheet under the diagram. |
| UXR-61 | S2 | **Fields without labels.** A check is three stacked inputs (name, command, timeout); a condition is a type select plus one to three unlabeled inputs. Once filled in, the placeholder that explained each one is gone. "5 m" (the PR-checks condition), "1" (approvals), "resolution" (Jira fields), "ci" (pipeline) and "10 m" (a timeout) can only be read by someone who already knows. When a name is cleared, the error "check 1 needs a name" points at a box you can no longer identify. | [wf-rules-full](wf-rules-full-1440x900-light.png), [rc-invalid](rc-invalid-1440x900-light.png) | **Checks as a table**, one row per check, with headers *Name · Command · Timeout*. The command field is wide; the timeout is a small field with a unit. **Conditions as sentences**, with the inputs inline: "PR checks are green (count *no CI after [5 m]* as green)", "At least [1] PR approval", "Jira fields [resolution] are set", "Azure pipeline [ci] succeeded". The optional checklist label goes behind a "Rename on the card" link. |
| UXR-62 | S2 | **It offers what doesn't exist yet, and names some of it by id.** Condition types "(not available yet)" can be picked, with a checkbox labelled "Enabled (declare it disabled until it is available)". The Actions list shows `inspect_pr`, `merge_pr` and `close_pr` as raw ids next to "Open a pull request (by conductor)", because `ACTION_TEXT` (`workflow/transitions.ts:153`) has labels for only three actions. | [wf-rules-full](wf-rules-full-1440x900-light.png) | Hide unavailable types and actions, unless the loaded version already uses them; then show them read-only with "Not available yet: this condition is skipped". Add labels: *Check the pull request*, *Merge the pull request*, *Close the pull request*. |
| UXR-63 | S2 | **"When not met" appears by surprise, at the bottom.** It isn't in the form until the first requirement is added. Then it appears already filled in (back to the agent column, 3 times, then Needs input) as the last section, after the conditions, and it adds a dashed arrow to the diagram. That section is the retry and escalation policy, the rule that keeps a ticket from looping forever, but it is the least visible part of the form. | [wf-rules-new](wf-rules-new-1440x900-light.png) | Put it directly under Requires, as "If the requirements aren't met…", with the default spelled out: "back to Planning with no instruction, up to 3 times, then Needs input". When there are no requirements, say "Nothing is required: the move happens as soon as it's taken". |
| UXR-64 | S2 | **The id comes first, and renaming it takes effect on every keystroke.** *Name* (`plan_ready`) is the first field. Each valid keystroke renames the transition in the draft (`TransitionEditor.tsx:189`). These names are what agents report and what prompts refer to, so renaming one changes the agent protocol, and nothing warns you. | [wf-arrow-group](wf-arrow-group-1440x900-light.png), [wf-name-error](wf-name-error-1440x900-light.png) | Title first, as the field people edit. Move Name under an *Advanced* disclosure, with a warning: "Agents report this name; prompts and history refer to it." Rename on blur or Enter, not per keystroke. |
| UXR-65 | S2 | **Several transitions on one arrow can't be told apart.** The ×5 arrow from Implementing to Needs input opens on whichever comes first. The tabs are raw ids (`needs_approval_to_message`, `pr_ready_for_review`, `personal_pr_ready_for_review`, `ask_user`, `timeout`) and nothing shows how they differ. `pr_ready_for_review` and `personal_pr_ready_for_review` differ only in Work vs Personal, which you discover by opening both. | [wf-arrow-group](wf-arrow-group-1440x900-light.png) | Open an arrow on a **list of its transitions**: title, who takes it, which ticket kinds, and a rule count ("Ready for review · agent · Work · 3 rules"). Pick one to edit. Label the arrow on the diagram with the count and the first title, not a truncated id. |
| UXR-66 | S2 | **You get lost between the column and its transitions.** Picking a transition replaces the column editor, and there is no way back except closing the panel and clicking the column again. The column's transition list is raw `name → Column` chips. Remove transition (red, at the very bottom, no confirmation) drops you onto the column. | [wf-column-human](wf-column-human-1440x900-light.png), [workflow-column](workflow-column-1440x900-light.png) | A breadcrumb in the editor header: "Implementing › Ready for testing", with a back arrow. The column's transition list shows titles and the same one-line summary as UXR-65. Remove asks for confirmation. Discard in the toolbar can undo it, but a person doesn't know that. |
| UXR-67 | S2 | **You can't change the shape of the workflow.** There's no way to add, remove or reorder a column (`workflow/columns.ts` has no add or remove), and no way to draw an arrow. *Add transition* creates `new_transition` to the next column, which you must rename and point somewhere else. Every structural change needs the API or an advisor proposal. | [workflow-column](workflow-column-1440x900-light.png) | Decide whether the shape is meant to be editable here. If it is: *Add column* between two columns, drag from a column's edge to draw a transition, and open a new transition with *Title* focused and *Goes to* open. If it isn't: say so ("Columns come from the workflow template") so people stop looking. |
| UXR-68 | S2 | **The diagram's visual language isn't defined.** Box styles mean different things: Queued is grey dashed, Needs input red dashed, Waiting external yellow, Done green. The legend says dashed means "requirements not met". Edges carry raw ids, truncated ("scope_changed …", "needs_approval_to_message …"), and an event id (`ui.approve`). The `done` line crosses the `ready_for_testing` label. At 1440, the right-hand third of the diagram is off-screen inside its own scroll box. | [workflows](workflows-1440x900-light.png), [wf-diagram-end](wf-diagram-end-1440x900-light.png) | Style a column by its **kind**, with an icon: agent (bot), person (hand), waiting (clock), end (flag). Dashed means only "not met". Label edges with titles; fit the diagram to the width by default (UXR-45). |
| UXR-69 | S2 | **Validation shouts at you before you've typed.** Adding a blank check, review item and condition immediately produces four errors in a red list. That list pushes the diagram down about 70 px, and the same errors repeat inline. "Conditions need a timeout" fires even though the placeholder already suggests 3 d. | [wf-rules-new](wf-rules-new-1440x900-light.png) | Validate a new item when it loses focus, or on Save, not when it's created. Prefill defaults that make a new item valid (*Wait at most* 3 d, a check timeout of 10 m). Keep the problems list in the toolbar as a count ("2 problems ▾"), so the layout doesn't jump. |
| UXR-70 | S3 | **Versions are just numbers.** The select lists "v1 … v3 (latest)", with no date, author or note, and no way to compare versions. If you open v1 and edit it, *Save* creates v4 **from v1**, silently undoing v2 and v3: the only warning is "Saving creates v4". Save itself has no review step and no message. | [wf-version-old](wf-version-old-1440x900-light.png), [wf-unsaved-guard](wf-unsaved-guard-1440x900-light.png) | Version history with the date, who saved it and a note; *Compare with latest*. When editing an older version: "This starts from v1: saving undoes v2–v3." Save opens a short review: a human-readable diff (reuse the proposals diff, see UXR-73) and an optional note. |
| UXR-71 | S3 | **Save is far from where you edit.** Save is in the page toolbar, so after editing *When not met* at the bottom of the panel you scroll back up to save. The unsaved-changes guard is a banner at the top of the page, far from the Board link you clicked, and its Discard is a second Discard button on the screen. | [wf-unsaved-guard](wf-unsaved-guard-1440x900-light.png) | A sticky bottom bar while a draft exists: "Unsaved changes · 2 problems · Discard · Review and save". The guard becomes a modal dialog, with "Leave without saving" and "Keep editing". |
| UXR-72 | S3 | **Keyboard focus looks exactly like selection** (the same blue border), so a keyboard user can't tell which column is focused and which is open. | [wf-keyboard-focus](wf-keyboard-focus-1440x900-light.png) | A distinct focus ring (offset, 2 px dashed) on top of the selection border (UXR-56). |
| UXR-73 | S3 | **Proposals are hard to judge.** The diff's Before and After columns show raw JSON (`{"name":"Web build","cmd":"cd m-one && …"}`). A repo-checks proposal is listed on the **Workflow** page, not on Repo checks. Nothing on the diagram highlights what a proposal would change. "Apply…" is the only way to see the result. | [wf-proposal-open](wf-proposal-open-1440x900-light.png) | Show proposal diffs in the same form the editor uses (check rows, condition sentences), with the affected column or arrow highlighted on the diagram. List repo-checks proposals on the Repo checks page for that repo, too. |
| UXR-74 | S3 | **The help text is on the page itself.** Three paragraphs of 12 px muted text explain the diagram, *Requires* and each column's default, in every visit. | [workflow-transition](workflow-transition-1440x900-light.png) | A "How workflows work" Help page, plus "?" tooltips next to *Requires*, *When not met* and *Taken by*. Keep one line on the page. |

## Repo checks overrides in depth

Ben asked for a review of the repo-checks overrides UX too. An override (ADR-0030) replaces the workflow's checks and setup at **every** gate that runs checks, for one repo.

| Shot | What it shows |
|---|---|
| [rc-override-full](rc-override-full-1440x900-light.png) | `acme/shop`, which has an override: the list, the per-gate table and the editor |
| [rc-new-override](rc-new-override-1440x900-light.png) | `acme/api`, which has none: the editor starts from the workflow's checks |
| [rc-invalid](rc-invalid-1440x900-light.png) | A cleared check name and a cleared command |
| [rc-clear-confirm](rc-clear-confirm-1440x900-light.png) | Clear override, asking for confirmation |
| [repo-checks-list](repo-checks-list-1440x900-light.png), [repo-checks 375](repo-checks-375x812-light.png) | The list with no repo open, and the phone |

What works:
- **"What runs at each gate"**, with a *Repo override* or *Workflow default* badge on each row, answers the right question.
- **Starting a new override from the workflow's checks** (rather than from nothing) is the right default.
- **Clearing asks for confirmation**, and says what will happen: "Use the workflow's checks for this repo again?"
- **The check editor is the same component** as the workflow's (`ChecksFields`), so whatever is fixed in UXR-61 fixes both.

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| UXR-75 | S2 | **An override is invisible everywhere except its own page.** The workflow's transition editor shows its Checks with no hint that `acme/shop` replaces them. The ticket's "Conductor is running checks" panel doesn't say the list came from a repo override; no component outside the repo-checks page mentions overrides. So someone who edits the workflow's checks, or wonders why a ticket ran `pnpm build`, has no way to find out. | [wf-rules-full](wf-rules-full-1440x900-light.png), [detail-checks](detail-checks-1440x900-light.png) | In the transition editor's Checks: "1 repo uses its own checks instead: acme/shop ›". In the ticket's checks panel: a "Repo checks" badge linking to the override. |
| UXR-76 | S2 | **One click freezes the defaults.** On a repo with no override, *Set override* is enabled before anything has changed. Clicking it copies today's workflow checks into an override, and from then on, changes to the workflow's checks silently stop applying to that repo. | [rc-new-override](rc-new-override-1440x900-light.png) | Keep *Set override* disabled until the list differs from the workflow's, or confirm: "This repo will stop following the workflow's checks." |
| UXR-77 | S2 | **The per-gate table repeats itself in ids, and doesn't preview your edit.** Gates are raw ids (`implementing.pr_ready_for_review`, `implementing.personal_pr_ready_for_review`, `implementing.ready_for_testing`). With an override, all three rows are identical by design. The table shows what is saved, not your draft, so you can't see the effect of an edit before saving it. | [rc-override-full](rc-override-full-1440x900-light.png), [rc-invalid](rc-invalid-1440x900-light.png) | Gate titles: "Implementing → Needs input (PR ready for review)". Collapse identical rows into one ("All 3 gates"). While a draft exists, preview it with the changed rows marked. Near the editor, say once: "This list runs at all 3 gates." |
| UXR-78 | S2 | **The setup is listed after the checks but runs before them.** *Before the checks (in a fresh checkout)* sits under the check list, and it has the same unlabeled three-field check rows as UXR-61. | [rc-override-full](rc-override-full-1440x900-light.png) | Setup first, then the checks table. Apply the same fix in the transition editor. |
| UXR-79 | S3 | **The page doesn't say what you're editing.** The open repo is a 12 px monospace line under the repo picker. The selected row in the list is highlighted in warning yellow. The picker ("Repo" + "Open") doesn't say you can open any repo, and repos without an override only appear as you type. | [rc-override-full](rc-override-full-1440x900-light.png), [repo-checks-list](repo-checks-list-1440x900-light.png) | Two panes. Left: every known repo (from the machines' inventories), marked *Own checks* or *Workflow checks*. Right: the editor, with the repo name as its heading. Show the selection in the accent colour. |
| UXR-80 | S3 | **There's no evidence to guide an override.** The page doesn't show how this repo's checks have been doing. The advisor's proposal knew "6 of 6 runs failed in 30 days", but the page that edits those checks doesn't show it, and there is no way to try a list before saving it. | [wf-proposal-open](wf-proposal-open-1440x900-light.png) | Show the last runs of each check for the repo (pass or fail, duration). Add "Try these checks" on an online machine that has the repo. Link any open proposal for this repo. |
| UXR-81 | S3 | **Edits can be lost.** Unlike the Workflow page, this page has no unsaved-changes guard: navigating away drops the draft. The clear confirmation's buttons say "Confirm" and "Cancel" rather than naming the action. | [rc-clear-confirm](rc-clear-confirm-1440x900-light.png) | Reuse the workflow's draft guard. Name the buttons "Use workflow checks" and "Keep own checks". |
| UXR-82 | S3 | **The introduction is written for engineers.** It mentions "ADR-0030", "`sh -c`" and "Git Bash on Windows". | [repo-checks-list](repo-checks-list-1440x900-light.png) | One sentence ("Give a repo its own build and test commands, instead of the workflow's"), with a Help link for the details. |

### A better repo checks page (proposed design)

Today the page stacks a list, a picker, a per-gate table and an editor. The proposal is a two-pane page that answers three questions in order: *which repos have their own checks*, *what runs for this one*, and *how is it doing*.

```
┌ Repo checks ─────────────────────────────────────────────────────────────────────────┐
│ Give a repo its own build and test commands instead of the workflow's.  (?) Help     │
├──────────────────────────────┬───────────────────────────────────────────────────────┤
│ 🔍 Filter repos              │ github.com/acme/shop                 [Own checks]     │
│                              │ Runs at all 3 check gates · set 2d ago by Ben         │
│ OWN CHECKS                   │                                                       │
│ ● acme/shop     2 checks  ✓  │ 1 SETUP   [Custom ▾] pnpm install --frozen-lockfile   │
│                              │ 2 CHECKS  Name        Command              Timeout    │
│ WORKFLOW CHECKS              │         ⋮ Build       pnpm build           —     ✕    │
│ ○ acme/api      ✗ 6/6 failed │         ⋮ Tests       pnpm test            10 m  ✕    │
│ ○ benjgrad/conductor         │           + Add check                                 │
│ ○ benjgrad/fixture-app       │                                                       │
│   (from your machines)       │ RECENT RUNS  Build ✓✓✓✓✗  Tests ✓✓✓✓✓   [Try now ▸]   │
│                              │ PROPOSAL     "Build the web app inside m-one" ›       │
│                              │ ▸ Compare with the workflow's checks                  │
│                              ├───────────────────────────────────────────────────────┤
│                              │ Unsaved changes   [Discard] [Save]   Use workflow… ⋯  │
└──────────────────────────────┴───────────────────────────────────────────────────────┘
```

- **Left pane:** every repo the machines report, grouped *Own checks* / *Workflow checks*, with a health hint (the last runs). This replaces the table and the picker (UXR-79), and makes a failing repo without an override visible.
- **Right pane, in run order:** setup, then the checks as a table with headers (UXR-61, UXR-78). One line says where the list runs ("all 3 check gates", UXR-77). The per-gate table becomes *Compare with the workflow's checks*: a disclosure showing a side-by-side diff of the draft against the workflow, which also previews the draft.
- **Evidence:** recent runs per check, *Try now* on an online machine, and any open advisor proposal for this repo (UXR-80, UXR-73).
- **A sticky footer** with Discard and Save, plus a draft guard (UXR-81). *Use workflow checks* (clear) goes in an overflow menu with a named confirmation. *Save* on a repo without an override is enabled only after an edit (UXR-76).
- **The other direction:** the workflow's transition editor links here ("1 repo uses its own checks instead: acme/shop ›"), and the ticket's checks panel shows a *Repo checks* badge (UXR-75).

### Recommendations for the designer and repo checks

**Quick wins** (each a small change):
- **D1.** Labels for the three missing actions in `ACTION_TEXT`, and hide unavailable conditions and actions (UXR-62). `workflow/transitions.ts`, `TransitionEditor.tsx`. **S.**
- **D2.** Column headers on the check rows, and the setup moved above the checks, in `ChecksFields` (UXR-61, UXR-78). This fixes both the workflow editor and Repo checks. **S.**
- **D3.** Breadcrumb and back arrow in the editor header; confirmation on *Remove transition* (UXR-66). **S.**
- **D4.** Disable *Set override* until the list changes, and name the clear buttons (UXR-76, UXR-81). `RepoChecksPage.tsx`. **S.**
- **D5.** "N repos use their own checks" in the transition editor (UXR-75). It needs `listRepoChecks` in `WorkflowsView`. **S.**

**Next:**
- **D6.** A generated summary sentence at the top of the transition editor, and collapsible sections with counts (UXR-60, UXR-63). This is the biggest win for understanding a workflow. **M.**
- **D7.** Conditions as sentences, with inline inputs (UXR-61). **M.**
- **D8.** Arrows with several transitions open on a summary list (UXR-65); Name moved under *Advanced* and renamed on blur (UXR-64). **M.**
- **D9.** Repo checks in two panes, with gate titles, collapsed identical rows and a draft preview (UXR-77, UXR-79). **M.**

**Bigger bets:**
- **D10.** Version history with notes, *Compare*, and a review step before Save (UXR-70, UXR-71), sharing a human-readable diff with the proposals panel (UXR-73). **L.**
- **D11.** Structural editing: add a column, draw a transition (UXR-67). This needs a product decision first: should the workflow's shape be editable in the UI at all? **L.**
- **D12.** Check history per repo, and "Try these checks" (UXR-80). It needs server support. **L.**

## MCP tools without a web UI

Ben: *"we still need to build the UI for some of the MCP tools we've implemented."* The orchestrator's MCP server (`packages/orchestrator/src/mcp/tools.ts`) registers 31 tools and the `workflow_advisor` prompt. I matched each one against the web client (`packages/web/src/api/client.ts`) and the components that call it.

**Covered in the web app:**
- *Tickets:* `list_tickets`/`get_ticket` (the board and panel), `create_ticket`, `answer_input`, `take_transition`, `message_agent` (the composer), `reopen_ticket`, `decide_proposed_ticket` (Proposed follow-ups).
- *Machines:* `list_machines`.
- *Repo checks:* `list/get/set/clear_repo_checks`.
- *Workflow:* `get_workflow`, `save_workflow`.
- *Proposals:* `list_change_proposals` and `apply_change` (Proposed changes).
- *Not needed in the web:*
  - `wait_for_updates`: the web uses the SSE board stream.
  - `propose_change`: only the advisor calls it.

**Missing, or only partly there:**

| ID | MCP tools | What they do | Web today | Server for the web? | Recommendation | Size |
|---|---|---|---|---|---|---|
| UXR-83 | `list_schedules`, `save_schedule`, `delete_schedule`, `run_schedule_now` | Recurring jobs: cron and timezone, enabled, next runs, last run's ticket, why a run was skipped | **None.** A card made by a schedule shows a "Recurring" tag (`Board.tsx` `card.schedule`), and that's all | **Yes:** `api/schedules.ts` has the REST routes; `ApiClient` has no methods yet | A **Schedules** page (top bar, next to Workflow). It lists name, "Weekdays at 09:00 (Toronto)", next run, the last run's ticket (linked) and its state, and a pause toggle. *New / Edit* opens a sheet with name, repo, kind, title and body (the ticket editor), a schedule picker that writes the cron (presets plus Advanced: raw cron), timezone and pinned machines. *Run now* asks for confirmation if the last run is still open. The card's "Recurring" tag links to its schedule. | M |
| UXR-84 | `get_process_metrics`, `list_findings`, `get_process_report`, `get_insight` | Time per state/repo/machine/check (median, p90), re-entries, check failures, questions, permission denials; ranked inefficiencies with evidence; the analyst's frictions; one session's summary | **None.** The proposals panel quotes a finding ("6 of 6 runs failed in 30 days"), but nothing lists them | **No:** MCP only, so it needs REST routes over the same queries | An **Insights** page: a window selector (7/30/90 days) and a group-by (state / repo / machine / check). A table of time per state with median and p90 bars. The top findings as cards, each linked to example tickets and to *Propose a fix* (which starts the advisor, or shows its proposal). The process report's frictions grouped by category. On a finished ticket's Details tab, the session's insight (summary and frictions). | L |
| UXR-85 | `search_tickets` (any status), `list_tickets status=done/cancelled` | Find a ticket by title, ref, body or id prefix, including closed ones | **None.** The board shows open tickets and a Done column; cancelled and older tickets can't be reached | **No:** needs `GET /api/tickets?q=` | A search box in the top bar (`/` to focus), with results grouped Open / Done / Cancelled, each opening the panel. An *Archive* filter on the board for done and cancelled tickets. | M |
| UXR-86 | `cancel_ticket` | Stop the agent and cancel the ticket | **Partly.** A running session has Abort (`DetailPanel.tsx:554`) and Cancel (`details-sections.tsx:250`), but a **queued** ticket's panel has no Cancel (UXR-42) | Check: the web's `cancel` is per session | A Cancel ticket button on every ticket panel, with a reason field and a confirmation; a cancelled ticket can be reopened. | S |
| UXR-87 | `get_workflow` → `default_available`, `adopt_default_workflow` | A newer shipped default workflow exists; save it as the next version | **None.** `WorkflowDetail.default_available` (shared `rest.ts:1438`) is never shown | **No** route for adopt | On the Workflow page, for admins: a banner, "A newer default workflow (v5) is available. *Compare* · *Adopt*". Adopt asks for confirmation and warns that local edits are replaced. | S–M |
| UXR-88 | `get_ticket_artifacts` (`plan`, `results`, `output`, `transcript`, `proposals`) | Each step's result (plan, implementer summary, check results), the live tail, the whole conversation | **Partly.** The panel has the transcript, the plan for plan approval, and proposals. **Each step's recorded result** (the `complete_state` result per state) has no view | Check: `getSession`/`getTranscript` may already carry it | A *Steps* section on the Details tab: one row per state the ticket went through (Planning → Implementing → …), with time, outcome and its result (plan, summary, tracking rows) as rendered markdown. This also replaces the "Step complete / Recorded…" noise in the transcript (UXR-38). | M |
| UXR-89 | (`GET /api/team`, UX-13a) | The agent team: names, hired, last assigned, active ticket | **None:** UX-13b FR-3 is still todo | Yes | A *Team* section on Machines (or its own page): avatars, names, what each is working on. | S |

**Order I'd build them in:**
1. **Schedules (UXR-83).** The server is done, so it's web work only, and it's the biggest blind spot: jobs run with no way to see or pause them from the app.
2. **Cancel a queued ticket (UXR-86)** and **adopt default workflow (UXR-87).** Both are small.
3. **Search and archive (UXR-85).**
4. **Steps (UXR-88).**
5. **Insights (UXR-84).** It needs REST routes first. It's the most valuable for improving the process, but also the biggest.

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

The workflow designer and repo checks have their own list (D1–D12), in [§The workflow designer in depth](#the-workflow-designer-in-depth) and [§Repo checks overrides in depth](#repo-checks-overrides-in-depth). The MCP tools that still need a web UI, in build order, are in [§MCP tools without a web UI](#mcp-tools-without-a-web-ui).

## Not captured

- **An error or offline state** (the board stream disconnected, an API failing). The mock can't fail on demand. A `VITE_MOCK_SCENE=offline` would let a later review shoot it.
- **Loading states.** The still mock answers instantly.
- **The first-run *board*:** with no machines, the guide replaces the board, so there is no "empty board" to see.
- **The Team list (UX-13b FR-3)**: not built yet.
- **A real iPhone** (keyboard, standalone mode): carried over from the [mobile review](../README.md#still-to-check-on-a-real-phone).
