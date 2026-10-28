# Session 2026-10-28 · windows-daemon

**Goal (Ben):** "make a windows-compatible daemon".

## Decisions (Ben)
- Native port, not WSL2 first; owner-only DACL verified on load; `taskkill /T /F` + orphan sweep; `install.ps1` + Scheduled Task in scope; GitHub Actions `windows-latest` CI (ADR-0024).
- U-110: only the native `claude.exe` on Windows.
- Mid-session: drop the implementer/QA agent fan-out ("too slow") and run targeted tests only.

## Done
- MW-T00: ADR-0024, MW milestone, ROADMAP, tracking, `daemon-windows` workflow.
- MW-T01..T04 by parallel agents (with QA: T03 failed once on cmd.exe escaping, T04 passed with debt and two security fixes), then merged into `mw-windows-daemon`.
- MW-T05..T08 and part of T09 in the lead session: spawn/kill wiring, orphan sweep, credentials/config/private repos, edit guard, worktree reuse.
- Security findings fixed on the way: `core.hooksPath=/dev/null` is drive-relative on Windows (now `NUL`); a git.exe planted in a worktree would run for bare `git` (now `execFileCli`); edit guard escapes via a junction + textual `..` and via `.. ` components (now refused); `missingManager` didn't see `.cmd` package managers.
- Windows job green (run 40777091109); full Linux daemon/shared suites green.

## Not done / next
See UNFINISHED.md (MW entry): T09 rest, T10, T11 after M2-T18; then T12, T13.

## Tracking
ADR-0024; U-071 resolved; U-106..U-111 (U-107, U-109, U-110 resolved); TD-189..TD-194; decisions logged. MW IDs were renumbered once to avoid main's TD-187/188 and U-104/105.
