# ADR-0024 · The daemon runs natively on Windows

- **Status**: accepted (Ben approved the MW plan, 2026-10-28)
- **Date**: 2026-10-28
- **Deciders**: Ben (+ Claude lead session, 2026-10-28)
- **Resolves**: [U-071](../tracking/UNKNOWNS.md) (daemon on Windows). Leaves [U-070](../tracking/UNKNOWNS.md) (IIS fixed-path runtime) open.
- **Amends**:
  - [ADR-0010](0010-one-workflow-columns-are-states.md): private dirs (and ADR-0013's `machine.json` credential) on Windows. An owner-only DACL replaces mode bits and the uid check.
  - [ADR-0021](0021-daemon-auto-update.md): on Windows the launcher is PowerShell, `current` is a junction, and the service is a Scheduled Task.
- **Supersedes**: the "WSL2 first, native parked" recommendation of [the Windows spike](../design/windows-spike.md) (FR-4). Its FR-2 table stays the inventory of work.

## Context
Ben's work laptop runs Windows. The spike recommended running the daemon inside WSL2 and parking a native port (N1–N13, about 15–25 engineer-days). Ben chose the native port (2026-10-28).

Re-checking the current tree found more breaks than the spike listed:
- `AbsolutePathSchema` (`shared/src/machines/inventory.ts`) accepts only `/`-rooted paths.
- `CONDUCTOR_ROOTS` is split on `:`.
- The orphan check doesn't recognise `node.exe` or `claude.exe`.
- `GIT_CONFIG_NOSYSTEM` drops Git for Windows' credential helper.
- `az.cmd` isn't found.
- `loadavg()` is always zero on Windows.
- SIGHUP doesn't exist on Windows.

## Decision
**The daemon supports native Windows (`win32`) next to macOS and Linux, with the same safety guarantees. All OS branching lives in one module, `packages/daemon/src/platform/`.** Call sites stay OS-agnostic. Milestone [MW](../plan/milestones/MW-windows-daemon.md) delivers it.

### 1 · Platform seam
| Module | POSIX (unchanged behaviour) | win32 |
|---|---|---|
| `spawn.ts` `spawnCli` | `spawn(bin, args, {detached})` | Resolve `bin` via absolute PATH entries + PATHEXT. Spawn an `.exe` directly. Run a `.cmd`/`.bat` (`az.cmd`, test fakes; never npm `claude.cmd`, U-110) through `cmd.exe /d /v:off /s /c` with double caret escaping. Always `windowsHide: true`, never `detached`, never `shell: true` |
| `kill-tree.ts` `killTree` | Signal the process group: SIGTERM, then SIGKILL after the grace period | `taskkill /T /F /PID <pid>`: forceful, with no grace step |
| `shell.ts` `workflowShell` | `/bin/sh` | Git Bash `bash.exe`, from `CONDUCTOR_SHELL`, then `CLAUDE_CODE_GIT_BASH_PATH`, then relative to `git --exec-path`, then `%ProgramFiles%` / `%ProgramW6432%` / `%LOCALAPPDATA%\Programs\Git` |
| `acl.ts` | 0600 / 0700, `lstat` and uid checks | Owner-only DACL (§3) |
| `procinfo.ts` `readProcInfo` | `ps -ww -o lstart= -o command=` | `Get-CimInstance Win32_Process`: CreationDate, ExecutablePath, CommandLine (parsed with Windows argv rules) |

`spawnCli` (MW-T03) vendors cross-spawn's approach rather than adding the package:
- it always double-escapes cmd metacharacters (including `%` and `:`, so no `%NAME%` or `%NAME:…%` span can match a variable), because every `.cmd` it runs forwards `%*`. cmd runs as `/d /v:off /s /c` with `NoDefaultCurrentDirectoryInExePath=1`, so the shim's own bare commands (`node`) never resolve from the cwd;
- it resolves a bare name only through absolute PATH entries and spawns the absolute path, so a planted `git.exe` in an agent-writable cwd never runs;
- `cmd.exe`, `taskkill.exe` and `powershell.exe` run from `%SystemRoot%\System32`.

### 2 · Tree kill: `taskkill /T /F`, with the orphan sweep as backstop (Ben)
Windows has no process groups and no signals. `taskkill /T` walks the parent-pid tree, so it misses a grandchild whose parent has already exited. The orphan sweep (BUG-1b) on the next start catches daemon-owned `claude` processes. A reparented build or dev-server process can still survive. That gap is a recorded shortcut (TD-189). The Actions runner showed the worst case: a Git Bash background job (`cmd &`) loses its Windows parent link and survives `taskkill /T`. The process runner therefore stops reading 2 s after the shell exits, so a survivor can't hold a build slot. Job Objects would close the gap, since membership is inherited whatever the parent link.

Job Objects (`KILL_ON_JOB_CLOSE`) would close it, but they need native code in the tarball. That is the payoff path if the gap bites.

### 3 · Private files: an explicit owner-only DACL, verified on load (Ben)
Writing a private file or dir runs `icacls <p> /inheritance:r /grant:r *<user SID>:F *S-1-5-18:F *S-1-5-32-544:F`. That grants the current user, SYSTEM and Administrators only, with no inherited ACEs.

Loading the credential or a private dir reads the owner and the ACEs (`Get-Acl`) and refuses if:
- the owner is not the user;
- any ACE grants another SID; or
- inheritance is on.

This is the Windows equivalent of ADR-0010's `mode & 0o077` and uid checks. The checks never silently pass on Windows: `process.getuid` being undefined is not "same owner". The current user's SID comes from `whoami /user /fo csv`.

Implementation details (MW-T04):
- **Directories** get `(OI)(CI)F` grants. Files created inside a private dir inherit only user, SYSTEM and Administrators, not the token's default DACL.
- **Ownership:** `icacls <p> /setowner *<user SID>` runs before restricting. An elevated process creates files owned by `BUILTIN\Administrators`, which would otherwise fail "owner is the user". Only `mkdirPrivate`'s pre-check (type + owner, before it takes ownership) tolerates an Administrators owner. `assertOwnerOnly` accepts the user as owner and nothing else. Whether an elevated daemon is supported at all is U-109.
- **Atomic secret writes:** `writePrivateFile` first requires the parent dir to pass the owner-only check (no inherited-permission window: Windows checks access at handle open, so a handle opened before restricting would survive). It then creates the temp file empty, restricts it, verifies it, and only then writes the data and renames.
- **Private dirs** are created one level at a time from the nearest existing ancestor. That ancestor must be owner-only, or the per-user profile (`os.homedir()`) / `%LOCALAPPDATA%`, which are per-user by default (an assumption). Each level is restricted and verified before the next is created.
- **Hidden ACEs:** `GetAccessRules` skips conditional/callback/object ACEs, so the check also reads the SDDL and the raw DACL ACE count. It refuses any ACE type other than plain `A`/`D`, a NULL DACL, an `ID` (inherited) flag, and any disagreement between the SDDL, the raw count and the parsed rules.
- **Invocation:** `icacls`, `whoami` and `powershell.exe` run by absolute `%SystemRoot%\System32` path, with argv arrays and no shell. The path reaches PowerShell through an env var and `-LiteralPath`. Identities are read as SIDs, never names. `PSModulePath` is dropped from the child env, because a pwsh 7 parent breaks Windows PowerShell 5.1's `Get-Acl`. Unreadable output means refusal.
- **Cost:** a check starts `powershell.exe` (about 0.5–1.7 s), so checks run at load time, not on hot paths.

### 4 · Workflow commands run in Git Bash
Workflow JSON commands stay POSIX `sh`, so one workflow runs on every OS. Claude Code on Windows already requires Git for Windows and uses its Bash, so the daemon adds no new dependency. `cmd.exe` would change every workflow's quoting, so it is not used.

### 5 · Git on Windows
- Every daemon git call adds `-c core.longpaths=true`. Worktree paths under `%USERPROFILE%\.conductor\wt\<uuid>` exceed MAX_PATH easily.
- `core.hooksPath` is `NUL` on win32, **not** `/dev/null`: Git for Windows reads `/dev/null` as the drive-relative `C:\dev\null`, which any local user may create, so a planted `C:\dev\null\pre-push` would run. Tests prove that a planted hook does not run (`platform/git.ts`).
- `cleanEnv` does **not** set `GIT_CONFIG_NOSYSTEM` on win32. The system gitconfig lives under Program Files, where only admins can write. It carries `credential.helper=manager`, `http.sslBackend=schannel` and corporate CAs, and `open_pr` can't push without them. On POSIX, `GIT_CONFIG_NOSYSTEM` stays.
- No `core.autocrlf` pin: the `checkClean` false positives MW-T01 saw on the runner (` M README.md`) came from dropping the system config (with `autocrlf=true`) only on the daemon side, so the checkout and the status check disagreed. With the system config kept, the daemon's git agrees with the user's.
- A bare-name PATH probe (`missingManager`) uses `isOnPath`, the same PATHEXT resolution as `spawnCli`: on Windows `npm`/`pnpm`/`yarn` are `.cmd` files with no exec bit.
- `<root>` itself is created with `mkdirPrivate` at daemon start (not just on enroll), since `<root>/private` and `machine.json` need a private parent on win32.

### 6 · Edit-guard hook
- The hook command is `"<node>" "<guard.mjs>" "<worktree>" || exit 2`, with double quotes and forward-slash paths. It means the same under `cmd.exe` and Git Bash.
- A worktree root or guard path containing `"`, `%`, `!`, `^`, `$` or a backtick is refused at session start: inside double quotes, cmd.exe still expands `%`/`!`/`^` and bash still expands `$` and backticks (`platform/hook.ts`).
- Which shell Claude Code uses for hooks on Windows is U-106. The command is built so the answer doesn't change the guard's behaviour.
- The resolver:
  - normalises `.`/`..` **textually first**, as the Win32 layer does before the file system follows any link. Otherwise `C:\wt\junction\..\..\x` would be judged by the junction's target and allowed, while Windows writes `C:\x` (found while writing MW-T08's tests). POSIX keeps kernel semantics: links first;
  - roots at the path's drive;
  - compares case-insensitively on win32;
  - refuses UNC, `\\?\`, `\\.\` and alternate data streams;
  - expands 8.3 short names with `realpathSync.native`.
- It stays fail-closed: a target it can't classify is denied.
- Tests run every hook call under each shell that may run it (sh; or cmd.exe and Git Bash, asserting they agree), with a 31-row win32 path-form table and a missing-node case.

### 7 · Service, launcher, installer
- **Install:** `install.ps1` (`irm <url>/install.ps1 | iex`) does what `install.sh` does:
  - it unpacks into `<root>\daemon\<version>`, makes `current` a **junction**, and adds `<root>\bin\conductor-daemon.cmd`;
  - it applies §3's DACL to `<root>`;
  - it passes the enrollment token in the environment (TD-117 parity).
- **Service:** `service install` registers a user-level **Scheduled Task at logon**. It needs no admin and shows no visible console.
- **Launcher:** `conductor-launch.ps1` implements ADR-0021's launcher on Windows: on exit 75 it switches the junction and relaunches, with trial and rollback.
- **Stopping:** a Scheduled Task stop terminates the process without a signal (U-108), so a stop is ungraceful (TD-190). Live sessions go to `machine.lost` on the orchestrator, and the next start's orphan sweep reaps what is left. `SIGINT` and `SIGBREAK` are handled when it runs in a console.

### 8 · Smaller changes
- `AbsolutePathSchema` accepts `^[A-Za-z]:[\\/]` and still refuses UNC, `\\?\` and relative paths.
- `CONDUCTOR_ROOTS` splits on `path.delimiter`.
- On win32, `conductor-daemon rescan` writes `<root>/state/rescan` for the running daemon to pick up, since there is no SIGHUP.
- On win32, free CPU comes from `os.cpus()` time deltas.

### 9 · Requirements and CI
- **Supported:** Windows 10 1809+ or Windows 11, Node ≥ 22, Git for Windows ≥ 2.40 (Git Bash), and the **native `claude.exe`** (U-110, Ben). npm's `claude.cmd` is refused with a hint: cmd.exe can't pass the multi-line `--append-system-prompt`, and `spawnCli` throws `ERR_CMD_UNSAFE_ARG` for CR/LF/NUL in a `.cmd` argument. Other `.cmd` CLIs (`az.cmd`) still work through `spawnCli`.
- **CI:** a GitHub Actions `windows-latest` job (`.github/workflows/daemon-windows.yml`) runs typecheck and the daemon and shared test projects on every pushed task branch. After MW-T12 it also runs the fake-claude e2e. This is the repo's first hosted CI (Ben, 2026-10-28). Linux and macOS keep `scripts/ci.sh`.

## Consequences
- Every change to `platform/`, the edit guard or the credential code needs the Windows job green as well as `ci.sh`.
- The edit guard and ADR-0010 checks now have two implementations. QA reviews both on every change.
- TD-189 (tree kill gap) and TD-190 (ungraceful stop) are accepted shortcuts.
- IIS (U-070) is not solved here. The spike's WIN-3..5 runtime slot comes later and works the same on native Windows.

## Alternatives considered
- **WSL2 first** (the spike's recommendation). It needs no code, but depends on corporate policy, keep-alive tasks and logins inside the VM, and can't run Windows-only builds well. Ben chose native.
- **Trust `%LOCALAPPDATA%` and skip the checks on Windows.** Simpler, but it silently weakens ADR-0010. Rejected.
- **Job Objects for tree kill.** Robust, but needs native code (an addon or helper exe) plus a build toolchain and signing. Deferred to TD-189's payoff.
- **`cmd.exe` for workflow commands.** It would fork every workflow's quoting by OS. Rejected.
