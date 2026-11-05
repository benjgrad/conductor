# UXR-22 / 23 / 24 / 57: type ramp, colour semantics, CSS on tokens

Taken with `node scripts/ui-screenshots.js --out uxr-22/<before|after>` on the mock API: before on
the branch's base, after on this branch. The full run was 90 shots at every size and scheme. A
representative set is kept here, plus the after run's `metrics.json`.

Comparing the full runs' metrics, no shot gained horizontal overflow or page height. Four shots
report one more sub-44 px tap target: `board-360x740`, both `new-ticket-360x740` shots and
`machine-drawer-1440x900`. These are not new controls. On the phone board, a card preview whose
text now fits on one line drops from 36 to 17 px tall. In the machine drawer, the top-bar links
lose a pixel (25→24 px).

| Shot | What changed |
|---|---|
| `board-1440x900-light` / `-dark` | Card edges are visible (`--card-edge`, about 2:1 on the panel; before, 1.3:1). Needs input is violet (`--attention`), not red, so red now means only failed or lost (Retries exhausted, Step failed, lost). Question badges are `--info`. |
| `board-375x812-light` | The same on a phone. The card title is 14 px/600 (`--text-md`); it was 15 px. |
| `workflow-column-1440x900-light` | The Person lane and its legend chip are violet. Sizes are on the ramp: headings `--text-lg`, body 13 px. |
| `detail-1440x900-light`, `detail-failed-1440x900-light` | A question request is blue (`--info`), a failure is red (`--danger`). Chat body text is 13 px. |
| `machines-1440x900-light`, `setup-375x812-light` | Paddings rounded onto `--space-*`, titles on the ramp. |

Contrast of the semantic tokens (checked by `packages/web/src/tokens.test.ts`; AA is 4.5):

| Token | On its `-bg` light / dark | On `--panel` light / dark |
|---|---|---|
| `--attention` | 5.8 / 7.5 | 6.7 / 8.1 |
| `--danger` | 6.3 / 6.9 | 7.4 / 7.5 |
| `--warn` | 5.4 / 8.4 | 5.9 / 9.7 |
| `--info` | 4.7 / 5.4 | 5.3 / 6.2 |
| `--ok` | 4.7 / 7.3 | 5.3 / 8.4 |

The dark `--warn-bg` went from `#3a2f12` to `#34290e`, so that `--muted` on it reaches AA (4.48 → 4.86).
