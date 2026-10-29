# Unfinished work (session handoff)

Anything started but not merged when a session ends. The next session reads this **first**, before anything else, and picks up from **Next step** without re-deriving context.

Remove the entry once the work is merged or deliberately abandoned. If abandoned, note why in the session log.

<!-- Template — copy per item:

## M1-T05 · Daemon core
- **Branch / worktree**: `m1-t05-daemon-core` @ `.claude/worktrees/m1-t05-daemon-core`
- **Last commit**: abc1234 "WIP: heartbeat sends live mem"
- **Done so far**: WS client + reconnect; register; heartbeat
- **Not done**: worktree creation, spawn, kill
- **Exact next step**: implement `createWorktree()` in packages/daemon/src/worktree.ts; test stub already in worktree.test.ts (skipped)
- **Gotchas**: `git worktree add` fails if branch exists — see note in code
- **Gates**: typecheck ✅ lint ✅ tests ❌ (worktree.test.ts skipped)
-->

## MR-T00 · Rust daemon plan (ADR-0026): written, not merged
- **Branch / worktree**: `mr-t00-rust-daemon-plan` (PR #69; origin/main merged in on 2026-10-29) @ `.claude/worktrees/mr-t00-rust-daemon-plan`
- **Done so far**: ADR-0026; `docs/plan/milestones/MR-rust-daemon.md` (19 tasks, groups A–H); ROADMAP row; `→ MR` marks on M2-T18c/T27/T28d and MW-T09..T13; amendment notes on ADR-0004/0017/0021/0024; U-112..U-116, B-005; decisions-log line. Docs only, no code.
- **Also done (Ben: "implement it all using the conductor board")**: every MR task is a ticket block (`### MR-Tnn` with Goal / Context / FR / NFR / Verification) in `MR-rust-daemon.md` §Tickets, with a 13-wave table. `scripts/create-tickets.js` adds MR rules (frozen TS reference, PARITY rows, seam rule, stop if no `cargo`, cargo gates) and refuses MR-T00. The dry run builds all 18 tickets. T18 split into T18a (docs, parity 100%) and T18b (delete the TS daemon after Ben's dogfood).
- **Posted**: wave 1, MR-T01 → ticket e4bbe7dd-6ad4-496d-8dcc-ad7605b1ad49 (2026-10-29, workflow `conductor` v4, starts in planning), with `CONDUCTOR_EMAIL=bengrady4@gmail.com CONDUCTOR_PASSWORD_FILE=~/.conductor-pw` (the login from session 96231ac4, M3/UX waves).
- **Not done**: the `daemon-ts-freeze` tag (on the merge commit, after Ben merges); waves 2–13.
- **Exact next step**: Ben merges PR #69, installs rustup on every machine that claims tickets (B-005) and answers U-112. The lead tags the merge commit `daemon-ts-freeze`, QAs MR-T01's PR when it opens, and after it merges posts wave 2 (`CONDUCTOR_EMAIL=bengrady4@gmail.com CONDUCTOR_PASSWORD_FILE=~/.conductor-pw node scripts/create-tickets.js --file docs/plan/milestones/MR-rust-daemon.md MR-T02`, `--dry-run` first).
- **Gotchas**: ADR-0025 was already taken on origin/main (CI-gated review), so the Rust ADR is 0026. Local `main` has an unpushed TD-189 (install.sh `--service`), which collides with origin/main's TD-189 (orphan sweep); renumber it when local main is reconciled.
- **Gates**: docs only; markdown links checked by hand.

## M1-T05a · Real-mode manual check (code merged; one acceptance item outstanding)
- **Branch / worktree**: none; daemon core merged via `integrate/B` (d5841e7), wiring via M1-T07 (66ab745). Work from the main checkout or a fresh worktree off main
- **Last commit**: 344a0c9 (main after group E, M1-T10 merged)
- **Done so far**: the paid real-CLI round trip passed (M1-T07: `E2E_REAL_CLAUDE=1`, claude 2.1.308, 2/2 passed, B-004 cleared); daemon `main.ts` now statically imports `createCliDriver` with the outcome server (TD-021 paid), and the orchestrator has a real process entry (`conductor-orchestrator` bin)
- **Not done**: the T05a real-mode manual check (orchestrator + daemon + real driver against a real repo), documented in the task's QA notes
- **Exact next step**: `pnpm db:up && pnpm db:migrate`, start `conductor-orchestrator` (packages/orchestrator/dist/bin.js) and the daemon against it with the real driver, create a ticket from the board, watch it reach `implement` and record the result in the session log. Simplest route now that M1-T10 is merged: with Ben's spend approval run `E2E_REAL_CLAUDE=1 pnpm test:e2e` (real orchestrator + daemon bins, real `claude`, haiku, local fixture repo) and record the result; or do the manual board run above
- **Gotchas**: `main()` does not migrate; run `pnpm db:migrate` first. pnpm scripts run Node 22 via `.npmrc`, the shell may have Node 20. Since M1-T14 a local-path repo needs `CONDUCTOR_ALLOW_LOCAL_REPOS=1` on the daemon, and if the web dev server is not on port 5173/4173 set `CONDUCTOR_ALLOWED_ORIGINS` (TD-069)
- **Gates**: on main 344a0c9: typecheck ✅ lint ✅ tests ✅ (503 passed / 2 skipped) build ✅ test:e2e ✅ (6 passed / 1 skipped, ~16 s)

## Housekeeping · merged M1b branches and worktrees (no unfinished work)
- **Branch / worktree**: `m1b-t01-contracts` … `m1b-t10-e2e` and 12 `worktree-agent-*` branches, with their `.claude/worktrees/*` checkouts. `git branch --no-merged main` is empty on 5c49010: every M1b task is merged, and there are no M1b WIP handoffs
- **Exact next step**: the lead removes the merged worktrees and branches (`git worktree remove`, `git branch -d`); then delete this entry

## UX-9..UX-16 · board polish, agent team, notifications: ticket waves (2026-10-28)
- **Branch / worktree**: none yet; bodies in `docs/plan/UX-board-and-notifications.md`, posted with `scripts/create-tickets.js --file docs/plan/UX-board-and-notifications.md <ids>`
- **Done so far**: the 9 ticket bodies and their dry run; nothing posted
- **Not done**: wave 1: UX-10, UX-11, UX-13a (migration), UX-14, UX-15 (migration) · wave 2: UX-9 (after UX-10), UX-13b (after UX-13a), UX-16 (after UX-14 + UX-15) · wave 3: UX-12 (after UX-9 + UX-11)
- **Exact next step**: Ben posts wave 1 now (they don't share files, apart from a top-bar line in App.tsx); after each merge, post the next tickets whose deps are merged
- **Gotchas**: UX-9, UX-10 and UX-12 all edit `Board.tsx`, so never run them together. After UX-15 merges, VAPID keys for prod are a lead + Ben step (`conductor-admin vapid-keys`, then the deploy env)

## M3 · ticket waves on the hosted board (2026-10-28)
- **Branch / worktree**: none yet; tickets are created by `scripts/create-tickets.js` on https://conductor.gradyserver.com
- **Done so far**: the script and its dry run (16 tickets, T01–T16); nothing posted, because M2r is not done (only M2r-T01 merged)
- **Not done**: every wave. A: T01 · B: T02, T03, T04, T05, T06, T07, T11 · C: T08 (after T02), T09 (T02+T04), T10 (T02+T03+T04) · D: T12 · E: T13 · F: T14, T15 · G: T16
- **Exact next step**: when M2r is merged, Ben runs `! CONDUCTOR_EMAIL=<email> node scripts/create-tickets.js T01` (it prompts for the password). After each merge, post the tickets whose deps are now all merged (`--dry-run` first). Wave B order: T02 T03 T04 T05 T06 T07 T11
- **Gotchas**: no `depends_on` and no edit (TD-172), so never post a wave early. Re-running skips titles already on the board. Session cap 3 queues the rest of wave B

## Open PRs and next tickets (2026-10-29, reconciled against origin/main 0b3b8bb)
- **Branch / worktree**: open PRs #56 (M2r-T03 QA state), #65 (M2-T35b screenshots), #67 (UX-15 Web Push server; migration), #69 (MR-T00 Rust daemon plan); this reconcile is branch `docs/reconcile-2026-10-29`
- **Done so far**: PRs #1–#68 except those four are merged; every one maps to a row in M2, M2r, MW or the UX board (`docs/plan/...`), or to the out-of-plan table in M2
- **Not done**: the four PRs above; M2-T16a (inventory ingest + routing, new); UX-9 → UX-12 (mobile); UX-14, UX-16 (push, web); dependencies-lite (not planned yet); IIS runtime slot (spike only, U-070)
- **Exact next step**: Ben merges `docs/reconcile-2026-10-29`; then post M2-T16a as a ticket (it is the first thing that makes several machines safe), UX-9 and UX-14 alongside it (disjoint files). QA #67 (migration: Ben approves) and #56 as they stand
- **Gotchas**: until T16a lands, **every online machine takes every ready ticket**, whatever repo or tools it has (the claim checks only `required_tags` and an explicit `repo_allow_machines`, which the board never sets): run only the daemons that can do the queued work. Done on the board ≠ merged (U-083). Keep `machine.max_sessions` at 3 or less while checks run (TD-148). The Lead's local `main` has an unpushed commit 178f5a8 whose TD-189 collides with origin's; its content is TD-195 here, so drop 178f5a8 when syncing
## Hazel and Nova · dogfood sessions waiting on Ben (2026-10-28)
- **Branch / worktree**: Hazel: ticket d0f8e9aa (M2-T18b planning), branch fast-forwarded to eb45d46. Nova: session 005f1e8c (M2-T18), branch untouched
- **Done so far**: Hazel now sees ADR-0021. Nova's gates run by hand: typecheck OK, prettier OK, lint FAIL at `packages/daemon/src/credential.ts:80` (preserve-caught-error); web `SetupGuide.test.tsx` fails on main too (flaky)
- **Not done**: Ben's answers to both `ask_user` prompts; the lint fix on Nova's branch
- **Exact next step**: Ben answers Hazel's and Nova's `ask_user` on the board; tell Nova to fix `credential.ts:80` and use pnpm (not npm) for its checks
- **Gotchas**: Nova had 18 denied tool calls (no `defaultMode`, prompts `none`) until T29b lands; expect more denials in the meantime
