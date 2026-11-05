# Desktop "New ticket" sheet (UXR-41): before / after

UXR-41 (S2, the November review), the desktop half of UXR-14: the create form had no heading and no Close of its own; Title, Repo and Priority were equal thirds; Kind was two small radios; the form pushed the board down; and Create ticket was a disabled outline button that gave no reason.

**How the shots are made**: `node scripts/ui-screenshots.js --out uxr-41/<before|after> --only new-ticket,new-ticket-bottom`. **Before** is `main` at 7148f24, served from a separate worktree and shot with `--url`. **After** is this branch. Both runs use the same script, so both have `new-ticket-bottom` at 768 and 1440.

| Shot | Before | After |
|---|---|---|
| Desktop 1440×900 | [form](before/new-ticket-1440x900-light.png): inline above the board, no heading | [sheet](after/new-ticket-1440x900-light.png): a centred "New ticket" modal over a backdrop, with Close; Title full width; Repo, Priority and segmented Kind on one row |
| Desktop 1440×900, scrolled to Create ticket | [bottom](before/new-ticket-bottom-1440x900-light.png): a disabled outline Create ticket, no reason | [bottom](after/new-ticket-bottom-1440x900-light.png): sticky footer with the primary Create ticket and "Still needed: a title, Work or Personal" |
| Tablet 768×1024 | [form](before/new-ticket-768x1024-light.png), [bottom](before/new-ticket-bottom-768x1024-light.png) | [sheet](after/new-ticket-768x1024-light.png), [bottom](after/new-ticket-bottom-768x1024-light.png) |
| Phones 375 / 360, light and dark | [375](before/new-ticket-375x812-light.png), [375 bottom](before/new-ticket-bottom-375x812-light.png), [375 dark](before/new-ticket-375x812-dark.png), [360](before/new-ticket-360x740-light.png), [360 bottom](before/new-ticket-bottom-360x740-light.png) | **byte-identical** to before (the phone layout is out of scope) |

`pageHeight` at 1440 goes from 2,010 px to 1,216 px, and the 1,216 is the board under the sheet, which no longer scrolls (`html.modal-open`).

**Known, not from this change**: at 768 the board is already 1,146 px wide (`horizontalOverflow` in `board-768x1024-light`). Chrome's mobile emulation widens the layout viewport to fit it, so the fixed sheet is centred in 1,146 px and its right edge is outside the 768 shot. The board's overflow at tablet widths is a separate issue.
