# Repo checks

Before an agent opens or updates a pull request, conductor runs the workflow's checks: usually install, build and test. A repo can have its own checks instead, for when the workflow's commands don't fit it (a pnpm repo, a repo whose code is in a subfolder, a different test command). They replace the workflow's checks and setup for that repo only.

## Setup
Setup runs once, before the checks.
- **Auto-detect**: conductor picks `npm ci` or `npm install` from the repo's lockfile.
- **None**: no setup.
- Or type your own command, e.g. `pnpm install --frozen-lockfile`.

## Checks
Each check has a name and a command; it passes when the command exits with 0. A repo can have up to 20 checks, run in order.

Commands run in a shell at the root of a fresh checkout of the commit being shipped. On Windows machines that shell is Git Bash, so write bash and use forward slashes, e.g. `cd m-one && npm ci && npm run build`.

## Run a check only for some files
A check can list the files it covers under **Only when these change**: path globs relative to the repo root, separated by commas, e.g. `crates/**, Cargo.*, rust-toolchain.toml`. `**` matches any folders, `*` and `?` match within one folder name, and `{a,b}` matches either. The check then runs only when the branch changes a matching file since it left the default branch. Otherwise it is skipped, shown as **Skipped: no matching changes**, and counts as passed. When conductor can't tell what changed, the check runs. Leave the field empty to always run the check.

## Last runs
A repo's page shows each check's last 5 runs from the past 30 days, oldest to newest. A green ✓ passed, a red ✗ failed and a grey – was skipped (no matching changes); hover a mark for how it ended, how long it took and its ticket, and click it to open the ticket. The list of repos shows a health hint for each one.

Runs are matched to a check by its command, so renaming a check keeps its history, but changing its command starts it again from empty.
## Where you see them
The workflow editor lists the repos with their own checks under each transition's checks. While conductor runs a ticket's checks, the panel shows a **Repo checks** badge when they are the repo's own; both link to the repo's page.

## Going back to the workflow's checks
Clear a repo's checks and its tickets run the workflow's checks again. Tickets pick up a change the next time they run their checks.

You can also set a repo's checks from Claude, with the `set_repo_checks` tool (see [Connect Claude](/help/connect-claude)).

## Proposed changes
When the workflow advisor proposes new checks for a repo, the proposal shows on that repo's page under its checks: what would change, in the same words as the editor, and why. Nothing changes until you apply it.
