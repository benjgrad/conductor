# UXR-75: repo check overrides where checks are edited and where they run

Taken with `node scripts/ui-screenshots.js --out uxr-75 --only detail-checks,wf-rules-full` on the mock API. `detail-checks` is a new screen: the "Conductor checks demo" card, whose mock repo (`github.com/acme/shop`) has the seeded override.

| Shot | What to see |
|---|---|
| `detail-checks-1440x900-light` | The "Conductor is running checks" banner ends its head with a **Repo checks** badge (`checking.checks_source = 'repo'`), a link to `#/repo-checks/github.com%2Facme%2Fshop`. Before: [`detail-checks-1440x900-light.png`](https://github.com/benjgrad/conductor/blob/9bedb1628c20bc655d9a83940a68f2f81db12945/docs/qa/ux-review/full-2026-11/detail-checks-1440x900-light.png). |
| `detail-checks-375x812-light` | The same on a phone. |
| `wf-rules-full-1440x900-light` | Implementing → Waiting external: under the Checks section, "1 repo uses its own checks instead: acme/shop ›", linking to the repo's page (from `listRepoChecks`). Hidden when there are no overrides, and on a transition without checks (an override replaces only a list of checks). |
| `wf-rules-full-375x812-light` | The same on a phone. |

The mock's demo card still lists the workflow-style check names (Typecheck, Lint, …) rather than the override's Build and Tests: the UX-5 tests key on them.
