# Ticket panel on a phone: before / after

Ben: *"On mobile, the ticket messages UX isn't mobile-friendly. The brief takes up too much space. Also the plan isn't as accessible as I'd like it."* The aim is to keep as much height as possible for the chat.

**How the shots are made**: `node scripts/ui-screenshots.js --out ticket-mobile/<before|after> --only ticket-messages,ticket-plan,ticket-plan-sheet,ticket-brief-sheet`. This runs the web app on the still mock API (`VITE_API=mock VITE_MOCK_STATIC=1`) in Chrome through playwright-core: phones at 375×812 and 360×740 (touch, 2×), plus 1440×900 desktop. **Before** is the branch's first commit, which adds only the mock seed (*Add rate limiting to /login*, a plan to approve) and the screens. **After** is the change. `chatHeight` in `metrics.json` is the visible height of the chat (`.output`), in CSS px.

| Shot | Before | After |
|---|---|---|
| Messages, a running ticket with a brief (375) | [before](before/ticket-messages-375x812-light.png): the Brief is open by default and takes about 40% of the screen | [after](after/ticket-messages-375x812-light.png): one 44 px strip (Brief ⚠ 4); the chat fills the rest |
| A plan to approve (375) | [before](before/ticket-plan-375x812-light.png): Edit ticket row + Brief, and the plan squeezed underneath | [after](after/ticket-plan-375x812-light.png): strip with **Plan to approve**; the plan clamped to ~8 lines in the chat, with **Open plan** |
| The plan (375) | [before](before/ticket-plan-sheet-375x812-light.png): scrolled into view inside the chat, under the Brief | [after](after/ticket-plan-sheet-375x812-light.png): the Plan sheet shows the whole plan, with Approve plan / Request changes… in the footer |
| The brief (360) | [before](before/ticket-brief-sheet-360x740-light.png): inline, capped at 40vh | [after](after/ticket-brief-sheet-360x740-light.png): the Brief sheet, the whole height below the tabs |
| Dark (375) | [before](before/ticket-plan-375x812-dark.png) | [after](after/ticket-plan-375x812-dark.png) |
| Desktop 1440 | [messages](before/ticket-messages-1440x900-light.png), [plan](before/ticket-plan-1440x900-light.png) | [messages](after/ticket-messages-1440x900-light.png), [plan](after/ticket-plan-1440x900-light.png): **byte-identical** to before |

## Chat height (`chatHeight`)

| Shot | Before | After |
|---|---|---|
| Messages 375×812 | 264 | **588** |
| Plan to approve 375×812 | 202 | **582** |
| Messages 360×740 | 215 | **510** |
| Plan to approve 360×740 | 159 | **510** |
| Desktop 1440×900 | 278 / 240 | 278 / 240 (unchanged) |

The sheet shots are measured with the sheet open, so their `chatHeight` is the height of the chat underneath the sheet.
