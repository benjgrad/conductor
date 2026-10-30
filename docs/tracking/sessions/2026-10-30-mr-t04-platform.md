# Session 2026-10-30 · mr-t04-platform

- **Lead**: Claude (Opus 5.5), conductor ticket MR-T04 (unattended)
- **Milestone / phase**: MR · build
- **Goal for this session**: port `packages/daemon/src/platform/*` and `test-support/{fake-bin,remove-tree}` to `crates/conductor-daemon/src/platform/**` and `src/test_support/`, with Job Objects on Windows.

## What happened
- Filled every `platform/` module: `spawn` (PATHEXT resolution, cmd.exe escaping, the 8191 cap, `SpawnError::{NotFound, CmdUnsafeArg}`, U-110 `native_exe_problem`), `kill_tree` (killpg TERM → KILL with cancel; Windows Job Objects with a taskkill fallback), `procinfo` (POSIX `ps` exactly as TS; Windows native), `acl` (POSIX 0600/0700 checks; Windows native owner-only descriptor, plus the TS evaluator and SDDL parser ported 1:1), `shell` (Git Bash lookup), `sysres`, `hook`, `git`, `fs`, and a new `win_path` (`path.win32` as string functions, so the win32 rules are tested on every OS).
- Windows children start suspended, go into their own kill-on-close job, and are then resumed (MR-T01 finding 6), while keeping tokio's stdio pipes. A new test kills a detached, reparented grandchild through the job. Its POSIX twin records the U-117 gap: a setsid grandchild survives killpg.
- Intended Windows differences are written up in ADR-0026 §7. The decisions are logged.
- Added the windows-sys feature `Wdk_System_Threading` (for `NtQueryInformationProcess`) to the root `Cargo.toml`.
- PARITY: 8 test files ticked, 91 rows mapped. 10 rows are `dropped:` because they parse PowerShell, whoami or CIM output, which the Rust daemon no longer produces; Ben needs to OK them in review. `node scripts/test-parity.js` passes.
- Linux: `cargo fmt --check`, `clippy -D warnings`, and every lib and seam test pass. **The Windows and macOS code was not compiled locally** (no target std on this machine; installing toolchains is not allowed): the `daemon-rust` matrix on the PR is the first compile and run.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| conductor ticket | MR-T04 | `mr-t04-platform` | PASS on Linux; Windows/macOS pending the PR's matrix |

## Tracking changes
- Unknowns raised / resolved: none (U-117 stays open; TS parity kept)
- Blockers raised / cleared: none
- Tech debt added / paid: none; TD-189 still applies to the orphan sweep's `signal_tree`
- ADRs: ADR-0026 §7 (implementation notes for the platform layer)
- Unfinished handoffs written: none

## Next session should start with
- If `daemon-rust` fails on windows-latest or macos-latest, fix the compile, clippy or test errors on this branch. All the Windows code is behind `cfg(windows)` in `src/platform/`.
- MR-T07 and MR-T09 wire the callers: `spawn_cli(…, CliOptions { detached: true, … })` + `kill_tree(KillTarget::Child(&child.tree), …)`. Keep the `CliChild`/`TreeHandle` alive for as long as the process should run, because on Windows dropping the last `TreeHandle` kills the tree.
