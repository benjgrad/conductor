# UXR-37: desktop detail layout

Taken with `node scripts/ui-screenshots.js --only detail,detail-review,detail-checks` (before, from
the base commit with this branch's script) and with the three `*-focus` screens added (after), on the
mock API. `before-*` and `after-*` are the 1440×900 and 1280×800 light shots; `metrics.json` has
their numbers. Ben chose both options: the narrower panel beside the board by default (A), and a
focus toggle in the panel header for the ticket list (B). Design: 11-web-ui §Desktop detail layout.

| Shot | Before | After |
|---|---|---|
| Panel width at 1440 / 1280 | 640 / 576 px | 520 / 512 px beside the board; 1116 / 956 px in focus mode |
| Board columns | 180 px, 4 of 6 in view at 1440, 3 at 1280 | 200 px, 4 of 6 in view at 1440, 3 at 1280, the rest a sideways scroll away |
| Focus mode list | — | 14 rows: every open ticket (Done is a collapsed group) |
| Page height | fits the window | fits the window (UXR-26) |

- `detail`, `detail-review`, `detail-checks`: the request and its evidence (the failed run's output,
  the review's report) come first, then the conversation, then the transition buttons, then
  Proposed follow-up tickets and Check output, each a collapsed disclosure. Before, the check run
  sat above the request inside the chat and the follow-ups at the very bottom.
- `detail-checks`: the Check output disclosure opened (before: the run's row in the chat opened).
- `*-focus`: the board becomes the ticket list. Each column is a collapsible group; the open
  ticket's row is highlighted. The panel's text is capped at 880 px.

**Not met as written:** "every board column header is visible with the panel open (option A)". Six
columns at 200 px need about 1250 px, and the board gets about 876 px at 1440 beside a 520 px panel.
That is why focus mode exists; the list there shows every open ticket.

Phone (375, 360) and tablet (768) `detail` shots are unchanged: their metrics match the base
exactly, so they are not copied here.
