# UXR-69 / UXR-71 / UXR-70: save bar, calm validation, old-version warning

Taken with `node scripts/ui-screenshots.js --out uxr-69 --only wf-rules-new,wf-unsaved-guard,wf-version-old`
on the mock API. The before shot is the UI review's
[`wf-rules-new-1440x900-light.png`](https://github.com/benjgrad/conductor/blob/24ec23fbea0564179cc53234b70197e8766530bd/docs/qa/ux-review/full-2026-11/wf-rules-new-1440x900-light.png).

| Shot | Shows |
|---|---|
| `wf-rules-new-1440x900-light` | Planning → Implementing after Add condition, then Add check (its name field focused). The condition starts valid (`Conditions (1 · wait 3d, poll 2m)`), and the blank check shows no problems until it loses focus or Save is pressed. The sticky save bar is at the bottom: Unsaved changes · Discard · Save as v4. With problems, the bar adds "N problems ▾", which opens the list above the bar. |
| `wf-unsaved-guard-1440x900-light` | Leaving with a draft (the Board link): a modal dialog, "Leave without saving" / "Keep editing" (focused). |
| `wf-version-old-1440x900-light` | v1 being edited: "This starts from v1: saving undoes the changes in v2–v3." under the toolbar, and again in the bar. |
| `*-375x812-light` | The phone: no horizontal overflow; the bar wraps. |
