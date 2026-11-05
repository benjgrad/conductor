# UXR-70 / UXR-73: version history, Compare, readable proposal diffs

Taken with `node scripts/ui-screenshots.js --out uxr-70 --only wf-proposal-open,wf-version-old`
on the mock API. The before shot is the UI review's
[`wf-proposal-open-1440x900-light.png`](https://github.com/benjgrad/conductor/blob/24ec23fbea0564179cc53234b70197e8766530bd/docs/qa/ux-review/full-2026-11/wf-proposal-open-1440x900-light.png)
(raw JSON in Before / After columns).

| Shot | Shows |
|---|---|
| `wf-proposal-open-1440x900-light` | The mock's open workflow proposal: its changes in the editor's words ("Check **Typecheck** added", "Waits for **before/after screenshots**", the column's new title), the transition's sentence before and after, and Waiting external with its incoming arrow highlighted on the diagram. The version picker shows date, author and note. |
| `wf-version-old-1440x900-light` | v2 picked: "You're viewing v2, saved 2 Oct 2026 by ben@example.com: …", then *Compare with latest*: columns and transitions added, removed and changed between v2 and v3, highlighted on the diagram below. |
| `*-375x812-light` | The same on a phone; the version picker stays inside the screen. |
