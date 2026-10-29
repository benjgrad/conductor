# MR · Rust daemon (ADR-0026)

> **Approved by Ben 2026-10-29** (plan approval). His decisions:
> - port now;
> - freeze the TS daemon and build unbuilt daemon features in Rust only;
> - protocol types by codegen from zod, with fixture parity;
> - parity on macOS, Linux and Windows before cutover;
> - every test reimplemented;
> - reuse the existing daemon upgrade path.

**Goal** ([ADR-0026](../../adr/0026-rust-daemon.md)): `conductor-daemon` is a native Rust binary on macOS (arm64, x64), Linux (x64, arm64) and Windows x64. Every one of the TS daemon's ~440 test cases has a Rust counterpart. It ships in the same `<root>/daemon/<version>` tarball layout through the same `install.sh`/`install.ps1` in-place upgrade, and from then on through ADR-0021's auto-update. Fleet machines no longer need Node.

**Placement**:
- MR replaces the daemon side of M2 and MW from the freeze commit (tag `daemon-ts-freeze`). M2's orchestrator, shared and web tasks carry on in TS.
- Daemon-side M2/MW rows are marked `→ MR` in their files:
  - M2-T18c → MR-T14
  - M2-T27 daemon part → MR-T17a
  - M2-T28d → MR-T17b
  - MW-T09, T10, T11b → MR-T13
  - MW-T12 → MR-T16
  - MW-T13 → MR-T18
- M2-T18 (in flight) is the recommended exception: it finishes in TS (U-112).

**Exit criteria**:
- Every task below is `done` and QA'd.
- `PARITY.md` is at 100%: every TS daemon case at the freeze commit maps to a Rust test or to a Ben-approved `dropped:` row.
- `scripts/ci.sh` (with the cargo gates) is green, and the ubuntu/macos/windows cargo matrix is green on `main`.
- `pnpm test:e2e` is green against the Rust binary on Linux and Windows.
- Every machine (gradyserver, Ben's Mac, the Windows laptop) moves from TS to Rust by an `install.sh`/`install.ps1` re-run that keeps `machine.json` and the store, then runs one clean dogfood day.
- One Rust → Rust auto-update and one rollback pass in e2e.
- `packages/daemon` is deleted (Ben's OK).

**Not in MR**:
- any wire-protocol change (`PROTOCOL_VERSION` stays 2);
- orchestrator, web or shared rewrites;
- porting `fake-claude.mjs`;
- code signing or notarization (U-115 decides whether it's needed);
- Windows ARM64;
- Homebrew or other package managers (ADR-0017).

**Blocking unknowns**:
- U-112 (M2-T18 during the freeze): before MR-T13;
- U-113 (`rmcp` maturity): answered by MR-T01;
- U-114 (Windows launcher): before MR-T14;
- U-115 (Gatekeeper): before MR-T15;
- U-116 (Job Objects and grandchildren): answered by MR-T01 and T04.
- B-005 (Rust toolchain on dev machines) blocks MR-T01.

**Design refs for every task**:
- [ADR-0026](../../adr/0026-rust-daemon.md);
- the TS daemon at `daemon-ts-freeze` (the behaviour reference);
- [10-contracts](../../design/10-contracts.md) and [03-protocols](../../design/03-protocols.md) §Daemon ↔ orchestrator;
- ADR-0005, 0010, 0013, 0021, 0023, 0024.

## Tasks

| ID | Task | Depends on | Group | Migration | Status |
|---|---|---|---|---|---|
| MR-T00 | ADR-0026, this file, ROADMAP, `→ MR` marks in M2/MW, ADR amendment notes, tracking (U-112..116, B-005), freeze tag | — | A | — | in_review (branch `mr-t00-rust-daemon-plan`) |
| MR-T01 | Spike `spikes/rust-daemon`: WS register + heartbeat; `rmcp` outcome tool called by real `claude -p`; Job Object tree kill on Windows | T00, B-005 | A | — | todo |
| MR-T02 | Cargo workspace, toolchain pin, cargo CI gates + 3-OS matrix, `scripts/test-parity.js`, `PARITY.md` skeleton | T01 | B | — | todo |
| MR-T03 | Protocol codegen (zod → JSON Schema → typify), JSON fixtures, two-sided round-trip + drift check; ports `resolveToolPolicy`, `canonicalRepo`, `cliVersionAtLeast` with shared vectors | T02 | B | — | todo |
| MR-T04 | `platform/`: spawn, kill-tree (+ Job Objects), procinfo, acl, shell, sysres, hook, git, fs; seam test | T02 | C | — | todo |
| MR-T05 | Core: store, config, credential, ports, system-prompt, semaphore, tail, version, orphan, sysinfo | T03, T04 | C | — | todo |
| MR-T06 | Test support: fake orchestrator, fake-bin, remove-tree, fake driver, fake runner | T03 | C | — | todo |
| MR-T07 | `ws_client` + process runner | T05, T06 | D | — | todo |
| MR-T08 | `claude/`: stream-parser, transcript, edit-guard (`hook edit-guard`), outcome + permission MCP server | T05, T06 | D | — | todo |
| MR-T09 | `claude/cli_driver` | T07, T08 | E | — | todo |
| MR-T10 | workspace + hardened exec/git module + actions (open-pr, checkout, conditions) | T07 | E | — | todo |
| MR-T11 | inventory (capabilities, repos, git, report, rescan) | T10 | E | — | todo |
| MR-T12 | Daemon core | T09, T10, T11 | F | — | todo |
| MR-T13 | `main` + subcommands: run, enroll, config, help, `service install/restart/uninstall` (launchd, systemd user, Windows Scheduled Task); absorbs MW-T09/T10/T11b | T12, U-112 | F | — | todo |
| MR-T14 | ADR-0021 updater in Rust (stage, verify, drain, switch, exit 75, trial commit, `bad-versions`, `config auto-update`, 4005 → latest.json); absorbs M2-T18c | T13, M2-T18b, U-114 | G | — | todo |
| MR-T15 | Distribution on the existing path: per-target tarballs from CI, image stage, `distribution.ts` target selection, install scripts without Node checks | T13, U-115 | G | — | todo |
| MR-T16 | e2e on the binary (`CONDUCTOR_E2E_DAEMON_BIN`), `ask-answer.test.ts` driven through the binary, TS→Rust upgrade e2e, Windows e2e job; absorbs MW-T12 | T13, T15 | G | — | todo |
| MR-T17 | Moved daemon features in Rust: T17a = M2-T27 daemon part, T17b = M2-T28d; more sub-tasks as M2 adds daemon work | T12 + each M2 contract task | G | — | todo |
| MR-T18 | Cutover: PARITY 100%, docs, one dogfood day per OS, delete `packages/daemon` (Ben OK); absorbs MW-T13 | T14, T15, T16 | H | — | todo |

Groups run in order A → H, and tasks within a group own disjoint files. In C, T04, T05 and T06 run in parallel once their deps are done; in D, T07 and T08; in E, T09 and T10, then T11. Branches are `mr-tNN-<slug>`. Every task must be green on the cargo matrix **and** `scripts/ci.sh` before merge.

Shared rules for every task:
- **Behaviour reference:** the TS daemon at `daemon-ts-freeze`. Any intended difference gets a design-doc edit in the same branch.
- **Parity:** the task fills the `PARITY.md` rows for the TS test files it lists under "Ports". `scripts/test-parity.js` must pass for those files. A `dropped:` row needs Ben's OK in review.
- **On-disk compatibility:** `machine.json`, `config.json`, the store file, `<root>` layout and worktree paths stay byte-compatible with the TS daemon. A TS-written fixture of each is read in a test.
- **Wire compatibility:** frames go through `conductor-protocol` types only, with no hand-built JSON.
- **Seam rule:** `cfg(windows|unix|target_os)` only under `crates/conductor-daemon/src/platform/`.
- **Shortcuts:** each one gets a TD row and a `// TD-###` comment.
- **TS freeze:** a bug fix in `packages/daemon` during MR also lands in Rust (or is listed in the task that owns that module).

## Task details

### MR-T00 · ADR, milestone, freeze
- **Scope**: ADR-0026; this file; the ROADMAP row; `→ MR` marks on the moved M2/MW rows; amendment notes on ADR-0004/0017/0021/0024; U-112..U-116 and B-005; a decisions-log line; the `daemon-ts-freeze` tag (created by Ben or the lead after Ben merges, on the merge commit).
- **Acceptance**:
  - [ ] Ben merges.
  - [ ] Tag pushed (Ben).

### MR-T01 · Spike
- **Scope**: `spikes/rust-daemon` (outside every workspace). Three probes:
  1. Register + heartbeat against a local orchestrator (`pnpm db:up`, real gateway, an enrolled machine).
  2. An `rmcp` streamable-HTTP server whose `complete_state` tool is called by real `claude -p --mcp-config …` on haiku (spends cents; Ben OKs it).
  3. On Windows CI: a Job Object that kills a `cmd → node → node` tree, including a grandchild that detached.
- **Acceptance**:
  - [ ] A README with go/no-go for `rmcp` (U-113) and for Job Objects (U-116).
  - [ ] Measured binary size per target.

### MR-T02 · Cargo workspace and gates
- **Files owned**: `Cargo.toml`, `rust-toolchain.toml`, `crates/conductor-daemon/` (skeleton), `scripts/ci.sh` (cargo steps), `.github/workflows/daemon-windows.yml` (becomes `daemon-rust.yml`: ubuntu/macos/windows matrix, path-filtered like today), `scripts/test-parity.js` + test, `crates/conductor-daemon/PARITY.md`, `.gitignore` (`target/`).
- **Acceptance**:
  - [ ] `cargo fmt --check`, `clippy -D warnings` and `nextest` (inside `node scripts/test-slot.js`) run in ci.sh and on all three OSes.
  - [ ] The parity script lists all ~440 TS cases and fails on a missing row (scoped by a `--files` list that grows per task).
  - [ ] The TS daemon's Windows vitest job keeps running until T18.

### MR-T03 · Protocol codegen
- **Files owned**: `packages/shared/scripts/emit-protocol.ts`, `packages/shared/protocol-json/` (generated schemas, constants, fixtures), `crates/conductor-protocol/`.
- **Scope**:
  - Every schema in the daemon's `@conductor/shared` imports: `protocol/ws.ts`, `outcome.ts`, the `api/machines.ts` enroll DTOs, `machines/*`, `Condition`, and the inventory schemas.
  - Constants: `PROTOCOL_VERSION`, close codes, byte and char limits, `GH_MIN_VERSION`.
  - Ports of `resolveToolPolicy`, `canonicalRepo`, `isCanonicalRemote`, `cliVersionAtLeast` and `capabilityKey`, each driven by JSON test vectors that the TS side also runs.
- **Acceptance**:
  - [ ] Every fixture in `protocol/fixtures.ts` round-trips through Rust byte-equal after canonical JSON.
  - [ ] The TS side parses the Rust-serialised output.
  - [ ] CI fails on regeneration drift.

### MR-T04 · platform
- **Ports**: `platform/*.test.ts` (acl, spawn, procinfo, kill-tree, shell, sysres, index, seam), `test-support/fake-bin.test.ts`.
- **Scope**:
  - Windows: Job Objects for kill-tree (keep the `taskkill` fallback); DACL write and verify through `windows-sys` instead of icacls/PowerShell, with the same owner-only rules as ADR-0024.
  - POSIX: `setpgid` + `killpg`, with the same TERM → KILL grace.
- **Acceptance**:
  - [ ] Ledger rows done.
  - [ ] Seam test green.
  - [ ] A Windows test kills a tree that includes a detached grandchild.

### MR-T05 · Core
- **Ports**: `units`, `credential`, `orphan`, `sysinfo`, `index` tests; the semaphore and tail cases in `process-runner.test.ts`; `inventory/version.test.ts`.
- **Acceptance**:
  - [ ] Reads TS-written `machine.json`, `config.json` and store fixtures, and writes files the TS daemon can read.
  - [ ] Every `CONDUCTOR_*` env var from `config.ts` is honoured, with the same defaults.

### MR-T06 · Test support
- **Ports**: `fake-driver`, `fake-runner` tests.
- **Scope**: the fake orchestrator (`tokio-tungstenite` server that validates every frame with `conductor-protocol`), fake-bin, remove-tree, `FakeClaudeDriver`, `FakeCommandRunner` (in `#[cfg(test)]` or a `test-support` feature).

### MR-T07 · ws_client, process runner
- **Ports**: `ws-client.test.ts`, the rest of `process-runner.test.ts`.
- **Acceptance**:
  - [ ] Backoff and jitter match.
  - [ ] Close codes 4001/4003/4005 and HTTP 401/403 behave as in TS.
  - [ ] A timeout kills the whole group.

### MR-T08 · claude/ (parsers, guard, MCP server)
- **Ports**: stream-parser, transcript, edit-guard, outcome-server tests.
- **Scope**:
  - The edit guard is the daemon's own `hook edit-guard` subcommand, so no Node is needed.
  - The outcome server keeps the per-session `/mcp/<token>` path and tool names and shapes. The permission tool follows ADR-0023.

### MR-T09 · cli_driver
- **Ports**: `cli-driver.test.ts`, `cli-driver.real.test.ts` (opt-in via `E2E_REAL_CLAUDE`).
- **Acceptance**:
  - [ ] Same argv as TS for the same session (asserted through fake-claude's argv log).
  - [ ] Kill and end grace behave as in TS.

### MR-T10 · workspace and actions
- **Ports**: `workspace`, `workspace.fresh-base`, `open-pr`, `open-pr.gh-version`, `checkout`, `conditions` tests.
- **Scope**: pull `cleanEnv`/`run`/`tail` into one hardened exec module, which removes the inventory → open-pr coupling.

### MR-T11 · inventory
- **Ports**: `capabilities`, `repos`, `report` tests.
- **Scope**: SIGHUP rescan on POSIX. On Windows, the `rescan` subcommand (MW-T09's design).

### MR-T12 · Daemon core
- **Ports**: `daemon.test.ts` (63), `daemon.kill.test.ts`, `reopen-transcript.test.ts`.
- **Acceptance**:
  - [ ] Replay, dedupe, orphan sweep and resume-without-transcript refusal (7cf97f2) behave as in TS.

### MR-T13 · main and subcommands
- **Ports**: `enroll`, `config` tests, plus the M2-T18 service tests if T18 lands in TS first (U-112).
- **Scope**:
  - `service install|restart|uninstall` writes the same launchd plist, systemd user unit and `conductor-launch` bytes as M2-T18. On Windows: a per-user Scheduled Task (MW-T10's design, U-108).
  - SIGINT/SIGTERM shutdown. SIGBREAK on Windows.

### MR-T14 · Updater
- **Scope**: everything in ADR-0021 §2–§4, with each tarball's target picked by the orchestrator. Windows replaces the binary by staging into a new version directory and swapping the junction, never by overwriting a running `.exe`. The Windows launcher depends on U-114.
- **Acceptance**:
  - [ ] e2e update and rollback (the M2-T22 cases) pass against the Rust binary.

### MR-T15 · Distribution
- **Files owned**: `packages/orchestrator/src/distribution.ts`, `assets/install.sh.tmpl`, `assets/install.ps1.tmpl`, `assets/conductor-daemon.cmd.tmpl`, `scripts/build-daemon-tarball.sh` (replaced), `Dockerfile` (daemon stage), their tests.
- **Acceptance**:
  - [ ] `findDaemonBuild` serves one build per target.
  - [ ] `install.sh` picks by `uname`.
  - [ ] Neither script checks for Node.
  - [ ] A TS-layout root upgrades in place to Rust and keeps `machine.json`.

### MR-T16 · e2e on the binary
- **Files owned**: `e2e/harness/stack.ts`, `e2e/run.sh`, `packages/orchestrator/test/e2e/ask-answer.test.ts`, the `packages/orchestrator/package.json` dependency on `@conductor/daemon` (removed), the Windows e2e job.
- **Acceptance**:
  - [ ] Both e2e suites are green against Rust on Linux and Windows.
  - [ ] A TS → Rust `install.sh` re-run keeps the machine id with no re-enroll.

### MR-T17 · Moved daemon features
- **Scope**: one sub-task per moved M2 daemon feature, each planned when its M2 contract task merges.

### MR-T18 · Cutover
- **Scope**:
  - Docs: `10-contracts`, `03-protocols`, `01-architecture`, `docs/setup/add-a-machine.md` + `packages/web/src/help/add-a-machine.md` + onboarding content, README, CLAUDE.md (stack, commands, toolchain), `docs/qa/TEST_STRATEGY.md`, `e2e/README.md`.
  - Move each machine with an install re-run, then one dogfood day per OS.
  - Then, with Ben's OK, delete `packages/daemon`, its tsconfig reference, the vitest projects, the test-tiers entry, the ESLint scope and the TS Windows job.
