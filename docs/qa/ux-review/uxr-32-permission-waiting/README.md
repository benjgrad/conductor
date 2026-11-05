# UXR-32: permission prompts count as "waiting on you"

Shots of the web app on the static mock API with the permission scene (`VITE_API=mock VITE_MOCK_STATIC=1 VITE_MOCK_PERMISSION=1`, light theme): "Add pagination to /orders" is held on a `Bash` permission. Taken with `node scripts/ui-screenshots.js --out uxr-32-permission-waiting --only board-permission,detail-permission` (the script sets the scene itself when `--only` lists only `*-permission` screens).

**Before**: the [full UI review](https://github.com/benjgrad/conductor/blob/24ec23fbea0564179cc53234b70197e8766530bd/docs/qa/ux-review/full-2026-11/board-permission-1440x900-light.png). The held card sits in Implementing, the Needs-input count leaves it out, and the panel header says "running".

**After** ([11-web-ui §Waiting on you](../../../design/11-web-ui.md#waiting-on-you-uxr-32)):

| Shot | What changed |
|---|---|
| `board-permission-1440x900-light.png` | Needs input carries a "+1 waiting for permission" note (a button that opens the held card). Its count is still the cards in it. |
| `detail-permission-1440x900-light.png` | The panel header chip says "waiting for permission" instead of "running". |
| `board-permission-375x812-light.png` | The phone switcher's Needs-input tab shows `6 +1`, and the column shows the same note. |
| `detail-permission-375x812-light.png` | The phone panel has the same header chip. |
