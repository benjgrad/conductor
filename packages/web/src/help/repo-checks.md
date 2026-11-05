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

## Going back to the workflow's checks
Clear a repo's checks and its tickets run the workflow's checks again. Tickets pick up a change the next time they run their checks.

You can also set a repo's checks from Claude, with the `set_repo_checks` tool (see [Connect Claude](/help/connect-claude)).

## Proposed changes
When the workflow advisor proposes new checks for a repo, the proposal shows on that repo's page under its checks: what would change, in the same words as the editor, and why. Nothing changes until you apply it.
