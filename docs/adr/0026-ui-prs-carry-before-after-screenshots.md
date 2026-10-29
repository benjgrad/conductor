# ADR-0026 · UI pull requests carry before/after screenshots

- **Status**: accepted (Ben, 2026-10-29; built in M2-T35a–c)
- **Date**: 2026-10-29
- **Deciders**: Ben (+ Claude session, background job "tickets are being transitioned directly to done")

## Context
Ben, 2026-10-29: *"I also want the implementer to attach screenshots from puppeteer or something else of the before and after to the PR if there's a UI change. This should be written into the workflow rules."* And on how: *"the agent is instructed to have the images, and the daemon checks and re-prompts the agent if necessary."*

Constraints:
- Agents can't push (ADR-0006). Only the daemon's hardened `open_pr` pushes (ADR-0010), and only the commit the checks ran on.
- GitHub has no API to upload a PR attachment. Images in a PR body must be served from somewhere the reader can open, and the repos are private.
- Files the agent leaves untracked in its worktree make the entry checks refuse the commit (`checkClean`), and committing screenshots would put them in the repo's history (and, for work tickets, break the work-commit review item).

## Decision
1. **The check is a condition, `pr_screenshots {ui_paths, min_pairs?}`** (M2-T35a). It is not a new gate phase. The conditions phase already sends a failure back to the agent with evidence, in its own conversation, counted, with retries and the card checklist (ADR-0011; how red PR CI works since ADR-0025). The daemon reads the PR's changed files and the body's marker with `gh pr view`. If no file matches `ui_paths`, the condition is met. Otherwise the body must show at least `min_pairs` pairs, or the condition fails with "save before-<view>.png / after-<view>.png in `$CONDUCTOR_SCREENSHOT_DIR`, then finish again".
2. **Screenshots live outside the worktree** (M2-T35b): `<daemon root>/artifacts/<session>/screenshots/`. The daemon creates it and passes it to the worker as `CONDUCTOR_SCREENSHOT_DIR`. Nothing lands in the user's repo or its history.
3. **`open_pr` attaches them** (M2-T35b):
   - It reads the directory as untrusted input: no symlinks, regular files only, the PNG signature, ≤ 5 MB each, ≤ 20 files, names `^(before|after)-[a-z0-9][a-z0-9-]{0,39}\.png$`, complete pairs only.
   - It writes the validated bytes into a fresh daemon-private bare repo and builds one commit with plumbing only (hooks off, the same protocol allow-list as the branch push). The commit's parent is the current tip of **`conductor-pr-assets`**, a branch that is never merged. It pushes without force and retries once if another upload won the race.
   - The PR body gets a `## Screenshots` Before / After table, linked by **commit** (`/blob/<commit>/<session>/<file>?raw=true`, so a later upload never breaks an older table), followed by the marker `<!-- conductor:screenshots pairs=N -->`.
   - A reused PR is updated with `gh pr edit --body`. A failed upload or edit is the action's error, so a human sees it.
4. **`conductor` v5 uses it** (M2-T35c) on every shipping transition, with `ui_paths` defaulting to `**/*.{tsx,jsx,vue,svelte,css,scss,html}`. The capture instruction in the condition's failure and in `implement_template`: a headless browser (Chrome / Playwright / Puppeteer), the default branch for "before" (e.g. a worktree of the merge-base), this branch for "after", each served on a port from the session's range.

## Alternatives considered
| Option | Why not |
|---|---|
| A new gate phase between checks and review | A new step kind, protocol command and card phase for what the conditions phase already does; it would check the directory, not what the PR shows |
| Commit the screenshots on the PR branch | They merge into the default branch's history; work tickets' review item forbids conductor-only files |
| The agent links local paths and Ben uploads | Not attached; a manual step on every UI PR |
| A gist or a release asset | Binary gists aren't supported; releases are public-facing and need extra permissions |

## Consequences
- Good: a UI PR reaches Ben only with screenshots in its body, checked by the daemon on the actual PR. The agent is told exactly what's missing and where to save it.
- Good: nothing is added to the user's repo history; one never-merged branch holds every image.
- Bad / accepted: `conductor-pr-assets` grows with every upload (a commit per upload, images only). Prune it by hand if it matters.
- Bad / accepted: image links work for whoever can read the repo; a private repo's images don't show to outsiders. Recorded as U-112.
- Bad / accepted: a daemon older than M2-T35a refuses the condition's args, so the step polls to its timeout and then reaches a human (TD-195). Update the daemons before shipping v5.
- Bad / accepted: "is this a UI change" is a path glob, not a judgement. A UI change in a `.ts` file outside the globs isn't caught; widen `ui_paths` per repo.

## Revisit when
- GitHub offers an attachment API, or the assets branch gets too big to fetch at depth 1.
- Repos need different UI globs (make `ui_paths` per repo, ADR-0013's repo settings).
