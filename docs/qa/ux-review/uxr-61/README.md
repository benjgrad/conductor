# UXR-61, UXR-62, UXR-78: the rules builder's fields

Taken with `node scripts/ui-screenshots.js --out uxr-61 --only wf-rules-full,rc-override-full,rc-invalid`
(mock API). Before: [full-2026-11/rc-invalid-1440x900-light.png](../full-2026-11/rc-invalid-1440x900-light.png).

- `rc-override-full`, `rc-invalid` (Repo checks) and `wf-rules-full` (the transition editor's Checks):
  the setup comes first, then the checks as a table under Name · Command · Timeout. A row's
  problems are listed under it, each naming its column ("Check 1: Timeout: use a duration…").
  The move and remove buttons are at least 24 px.
- `wf-rules-full` Conditions: each condition reads as a sentence with its inputs inline. Its card
  label is behind "Rename on the card". Jira and Azure (not available yet) are read-only:
  "Not available yet: skipped". "Add condition…" offers only the available types.
- `wf-rules-full` Actions: every action has a label (Check / Merge / Close the pull request).
