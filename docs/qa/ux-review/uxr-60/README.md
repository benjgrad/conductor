# UXR-60 / UXR-63: the transition editor's summary and sections

Taken with `node scripts/ui-screenshots.js --out uxr-60 --only wf-rules-full,wf-rules-new,wf-arrow-group`
on the mock API. The before shot is the UI review's
[`wf-rules-full-1440x900-light.png`](https://github.com/benjgrad/conductor/blob/24ec23fbea0564179cc53234b70197e8766530bd/docs/qa/ux-review/full-2026-11/wf-rules-full-1440x900-light.png).

| Shot | Shows |
|---|---|
| `wf-rules-full-1440x900-light` | Implementing → Waiting external at full height: the summary sentence, then six sections, each with its count or status. The not-met policy follows Conditions. The panel is about 600 px wide (`clamp(560px, 42vw, 640px)` from 1100 px). |
| `wf-rules-new-1440x900-light` | Planning → Implementing, no requirements: Checks, Review, Actions and Conditions closed, and "Nothing is required: the move happens as soon as it's taken". |
| `wf-arrow-group-1440x900-light` | Planning → Needs input: the transition tabs above the summary. |
| `*-375x812-light` | The phone, unchanged in layout: the panel still overflows the screen (UXR-44, separate). |
