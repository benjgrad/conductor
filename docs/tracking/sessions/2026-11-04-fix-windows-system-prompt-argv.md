# Session 2026-11-04 · fix-windows-system-prompt-argv

- **Lead**: Claude (Opus 5.5) with Ben
- **Milestone / phase**: out of plan (FIX-2) · Build
- **Goal for this session**: unstick NCNG-2630 ("Eamon is still stuck").

## What happened
- NCNG-2630 (06475056, method-platform-ui, PC115, TS daemon 0.0.0+d90a8ea) had looped since 16:39 UTC: every few seconds `session.assigned` → `command.refused start_failed: spawn ENAMETOOLONG` → `queued`, about 1,400 times. The refused start is the `ready_for_testing` requirements reviewer (`review: true`), launched right after the checks passed.
- Cause: the daemon puts `--append-system-prompt` (conductor's instructions + the repo's CLAUDE.md, allowed up to 64 KiB) on the command line; Windows caps one at 32,767 chars. The worker's start at 16:25 worked: it read CLAUDE.md before the agent rebased the branch onto the latest master; the reviewer read it after. Inferred, not measured: this machine can't read the methodcrm repo. Every new start on that repo on Windows would fail the same way.
- Second bug: the engine requeued every `start_failed` refusal with no limit (05's "every loop bounded").
- Fixed both: `spillSystemPrompt` / `spill_system_prompt` (TS + Rust, PARITY rows) writes a prompt over 8 KiB to `system-prompt.md` in the session's private dir and passes `--append-system-prompt-file`; apply counts `start_failed` refusals (`retry_counters.start_failed`) and sends the third in a row to a human. 10-contracts §Refusals updated.
- Tests: daemon `cli-driver.test.ts` 35/35 (1 skipped), shared `src/engine/` 339/339, cargo `spill|passes_a_spilled|emits_exactly` 4/4, clippy clean, test-parity 0 todo. Full gates not run locally (CI runs them on the PR).

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| — | — | — | — |

## Tracking changes
- Decisions: FIX-2 line in DECISIONS_LOG.

## Next session should start with
After the merge deploys, check that NCNG-2630 reaches Needs input. Then upgrade PC115's daemon (re-run install.ps1, or move it to the Rust daemon) and answer "Retry".
