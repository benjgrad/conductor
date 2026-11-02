# Repo checks page (ADR-0030): before / after

Shots of the web app on the static mock API (`VITE_API=mock VITE_MOCK_STATIC=1`, light theme), at the same views for `main` at 17c785a (**before**) and for this branch (**after**). Desktop is 1440×900; the phone shots are 375×812 (touch, 2×) and full-page.

| View | Before | After |
|---|---|---|
| `repo-checks`: `#/repo-checks/github.com%2Facme%2Fshop`, the mock's seeded override open | The route doesn't exist, so the board shows | The page: the note with `sh -c` and the ADR-0030 link, the overrides table, the repo picker, what runs at each gate (*Repo override*), and the override editor |
| `repo-checks-phone`: the same, on a phone | The board | The page. Its tables scroll sideways inside their own box; the page itself doesn't (11-web-ui §Breakpoint) |
| `account-menu`: the board with the account menu open | Connect Claude, Notifications | **Repo checks** added under Connect Claude |
| `transition-checks`: the workflow editor's transition panel for an Implementing transition with checks | The check list inside TransitionEditor | The same panel with the list moved into `ChecksFields`: **byte-identical** to the before shot |

When M2-T35b (`$CONDUCTOR_SCREENSHOT_DIR`, PR assets) lands, shots like these go to the PR body instead of the repo.
