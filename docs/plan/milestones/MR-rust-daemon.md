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
  - MW-T13 → MR-T18b
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
| MR-T00 | ADR-0026, this file, ROADMAP, `→ MR` marks in M2/MW, ADR amendment notes, tracking (U-112..116, B-005), freeze tag | — | A | — | done (PR #69, a9a04c8) |
| MR-T01 | Spike `spikes/rust-daemon`: WS register + heartbeat; `rmcp` outcome tool called by real `claude -p`; Job Object tree kill on Windows | T00, B-005 | A | — | done (PR #74, 9bf630e; GO on WS, rmcp vs fake-claude, Job Objects; real-claude run owed, U-113) |
| MR-T02 | Cargo workspace, toolchain pin, cargo CI gates + 3-OS matrix, `scripts/test-parity.js`, `PARITY.md` skeleton | T01 | B | — | in_progress (board ticket 0a3cc07e, posted 2026-10-29) |
| MR-T03 | Protocol codegen (zod → JSON Schema → typify), JSON fixtures, two-sided round-trip + drift check; ports `resolveToolPolicy`, `canonicalRepo`, `cliVersionAtLeast` with shared vectors | T02 | B | — | done (board ticket, branch of this PR; TD-196..198) |
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
| MR-T17 | Moved daemon features in Rust: T17a = M2-T27 daemon part, T17b = M2-T28d; ticket blocks written when their M2 contract tasks merge | T12 + each M2 contract task | G | — | todo |
| MR-T18a | Cutover docs, PARITY at 100% | T14, T15, T16 | H | — | todo |
| MR-T18b | Delete `packages/daemon` after Ben's dogfood day on each OS (absorbs MW-T13) and his OK | T18a | H | — | todo |

Groups run in order A → H, and tasks within a group own disjoint files. In C, T04, T05 and T06 run in parallel once their deps are done; in D, T07 and T08; in E, T09 and T10, then T11. Branches are `mr-tNN-<slug>`. Tickets are posted in the waves below. Every task must be green on the cargo matrix **and** `scripts/ci.sh` before merge.

Shared rules for every task:
- **Behaviour reference:** the TS daemon at `daemon-ts-freeze`. Any intended difference gets a design-doc edit in the same branch.
- **Parity:** the task fills the `PARITY.md` rows for the TS test files it lists under "Ports". `scripts/test-parity.js` must pass for those files. A `dropped:` row needs Ben's OK in review.
- **On-disk compatibility:** `machine.json`, `config.json`, the store file, `<root>` layout and worktree paths stay byte-compatible with the TS daemon. A TS-written fixture of each is read in a test.
- **Wire compatibility:** frames go through `conductor-protocol` types only, with no hand-built JSON.
- **Seam rule:** `cfg(windows|unix|target_os)` only under `crates/conductor-daemon/src/platform/`.
- **Shortcuts:** each one gets a TD row and a `// TD-###` comment.
- **TS freeze:** a bug fix in `packages/daemon` during MR also lands in Rust (or is listed in the task that owns that module).

## Ticket waves (conductor board)

MR is built by conductor on itself:
- **Posting:** `scripts/create-tickets.js --file docs/plan/milestones/MR-rust-daemon.md <ids>` posts each `### MR-Tnn` block below, plus the MR rules, with workflow `conductor` (the hosted board's only workflow).
- **Before wave 1:** MR-T00 must be merged (agents branch from `origin/main`, and this file is their plan), and `cargo` must be on PATH on every machine that claims MR tickets (B-005).
- **Pacing:** the board has no `depends_on` until M2b (TD-172), so a wave is posted only once every dependency in it is **merged**. The session cap is 3.

| Wave | Tickets | Posted when |
|---|---|---|
| 1 | MR-T01 | T00 merged, B-005 cleared. **Posted 2026-10-29** (ticket e4bbe7dd), merged as PR #74 |
| 2 | MR-T02 | T01 merged with a go on `rmcp` (U-113), or the axum fallback chosen. **Posted 2026-10-29** (ticket 0a3cc07e) |
| 3 | MR-T03, MR-T04 | T02 merged |
| 4 | MR-T05, MR-T06 | T03 and T04 merged (T06 only needs T03) |
| 5 | MR-T07, MR-T08 | T05 and T06 merged, and the U-113 real-claude run passed (or the axum fallback chosen) |
| 6 | MR-T09, MR-T10 | T07 and T08 merged (T10 only needs T07) |
| 7 | MR-T11 | T10 merged |
| 8 | MR-T12 | T09, T10, T11 merged |
| 9 | MR-T13 | T12 merged, U-112 answered |
| 10 | MR-T14, MR-T15 | T13 merged; T14 also needs M2-T18b merged and U-114 answered; T15 needs U-115 answered |
| 11 | MR-T16 | T13 and T15 merged |
| 12 | MR-T18a | T14, T15, T16 merged, PARITY at 100% |
| 13 | MR-T18b | Ben's dogfood day on each OS passed and Ben OKs the deletion |

MR-T17a/T17b (moved M2 daemon features) get their blocks when their M2 contract tasks merge (M2-T27 shared part; M2-T28b).

## Tickets

### MR-T01 · Spike: Rust daemon risk probes (WS, rmcp, Job Objects)
## Goal
Prove, before any port work, the three risky pieces of a Rust daemon: talking to the real orchestrator over the WS protocol, serving MCP tools that Claude Code calls, and killing a whole process tree on Windows.

## Context
ADR-0026 §5 and the MR milestone (`docs/plan/milestones/MR-rust-daemon.md`). U-113 (rmcp maturity) and U-116 (Job Objects) are answered here. The TS daemon in `packages/daemon` is the reference: `src/ws-client.ts`, `src/daemon.ts` (register, heartbeat), `src/claude/outcome-server.ts`, `src/platform/kill-tree.ts`. Protocol: `packages/shared/src/protocol/ws.ts`. This is a spike: code lives in `spikes/rust-daemon/`, outside every workspace, lint and typecheck, and it is never shipped.

## Functional requirements
- **FR-1 WS probe**: a Rust binary (`tokio` + `tokio-tungstenite` + rustls) connects to a locally started orchestrator (`pnpm db:up && pnpm db:migrate`, `packages/orchestrator` bin), authenticates with an enrolled machine credential (`DAEMON_AUTH_HEADER`), sends `register` with `protocol_version` 2, gets `registered`, sends three heartbeats, and closes cleanly. Hand-written serde structs are fine here.
- **FR-2 MCP probe**: an `rmcp` streamable-HTTP server on 127.0.0.1 with a per-session path `/mcp/<token>` and one tool `complete_state` (input shape from `COMPLETE_STATE_INPUT_SHAPE`, `packages/shared/src/protocol/outcome.ts`). `packages/daemon/test/fixtures/fake-claude.mjs` (it makes real MCP `tools/call` requests to `--mcp-config`) calls it successfully. If `E2E_REAL_CLAUDE=1` is set, real `claude -p --model haiku --mcp-config …` calls it too (it spends cents, so it is opt-in only). Also probe a tool call held open ≥ 60 s before answering, the shape the permission tool needs (ADR-0023).
- **FR-3 Job Object probe** (Windows): start `cmd /c` → `node` → a `node` grandchild that detaches, all inside a kill-on-close Job Object (`windows-sys`), and kill the job. Assert no process from the tree survives. Add a workflow `.github/workflows/spike-rust-daemon.yml` (path filter `spikes/rust-daemon/**`, `windows-latest` + `ubuntu-latest`, no deploy) that runs the probe.
- **FR-4**: `spikes/rust-daemon/README.md` records, for each probe, what was run, the result, and a go / no-go, plus release binary size per OS from the workflow.

## Non-functional requirements
- **NFR-1**: no change outside `spikes/rust-daemon/` and the one workflow file.

## Out of scope
Any production crate, codegen, or CI change to `scripts/ci.sh`.

## Verification
- FR-1: README shows the probe's log of `registered` and heartbeats against a local orchestrator.
- FR-2: README shows fake-claude's successful `tools/call` and the 60 s held call (and real claude's if Ben enabled it).
- FR-3: the spike workflow is green on `windows-latest` with the survivor check.
- FR-4: README has a go / no-go line for U-113 and U-116.

- **Depends on**: MR-T00. **Files owned**: `spikes/rust-daemon/**`, `.github/workflows/spike-rust-daemon.yml`. **Do not touch**: `packages/**`, `scripts/**`, `docs/**`.
- **Acceptance**: [ ] the three probes run; [ ] README with go / no-go; [ ] the spike workflow green.

### MR-T02 · Cargo workspace, module skeleton, CI gates, parity ledger
## Goal
Every later MR ticket can work in its own files without merge conflicts, and every Rust change is gated on Linux, macOS and Windows from day one.

## Context
ADR-0026 §3 and §6, and the MR milestone (code layout, "every test reimplemented"). The spike (`spikes/rust-daemon/README.md`) says which crates worked. The TS daemon's module tree is `packages/daemon/src/**`. The current Windows workflow is `.github/workflows/daemon-windows.yml` (diff-aware; keep its TS job running until MR-T18). Test slots: `scripts/test-slot.js` (CLAUDE.md "Test slots").

## Functional requirements
- **FR-1**: a Cargo workspace at the repo root: `Cargo.toml` (members `crates/*`, shared `[workspace.dependencies]` with every crate MR uses: tokio, tokio-tungstenite, serde, serde_json, rmcp or the axum fallback per the spike, axum, clap, reqwest (rustls), thiserror, anyhow, tracing, sha2, nix (unix), windows-sys (windows), tempfile, assert_cmd), `rust-toolchain.toml` (pinned stable), `.gitignore` gains `target/`.
- **FR-2**: `crates/conductor-daemon` (bin `conductor-daemon`, plus lib) with **every module pre-declared** as an empty file mirroring the TS tree: `platform/{spawn,kill_tree,procinfo,acl,shell,sysres,hook,git,fs}`, `claude/{driver,cli_driver,stream_parser,transcript,edit_guard,fake_driver,outcome_server}`, `actions/{open_pr,checkout,conditions}`, `inventory/{report,capabilities,repos,git,version}`, `commands/{runner,process_runner,semaphore,tail,fake_runner,enroll,config,service}`, `exec`, `ws_client`, `config`, `credential`, `store`, `ports`, `sysinfo`, `system_prompt`, `orphan`, `workspace`, `daemon`, `update`, `test_support/{fake_orchestrator,fake_bin,remove_tree}`. Also an empty `crates/conductor-protocol`. Later tickets fill files in, and none of them edit `mod` lists or `Cargo.toml` except to add a missing dependency.
- **FR-3**: the seam test, `crates/conductor-daemon/tests/seam.rs`, fails if `cfg(windows)`, `cfg(unix)` or `cfg(target_os` appears outside `src/platform/` (same rule as `packages/daemon/src/platform/seam.test.ts`).
- **FR-4**: `scripts/ci.sh` gains, after lint: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `node scripts/test-slot.js cargo nextest run --workspace` (install `cargo-nextest` via `cargo install --locked` if missing, or `taiki-e/install-action` in Actions). `.github/workflows/ci.yml` installs the pinned toolchain (`dtolnay/rust-toolchain`) with cargo caching.
- **FR-5**: a new workflow `.github/workflows/daemon-rust.yml`, the same diff-aware pattern as `daemon-windows.yml` (paths `crates/**`, `Cargo.*`, `rust-toolchain.toml`, `packages/shared/**`, the workflow file), matrix `ubuntu-latest`, `macos-latest`, `windows-latest`: fmt, clippy, nextest, `cargo build --release`.
- **FR-6**: `scripts/test-parity.js` + `scripts/test-parity.test.js`: extracts every `it(`/`test(` title (with its `describe` chain) from `packages/daemon/src/**/*.test.ts` and checks `crates/conductor-daemon/PARITY.md`. Every case must have a row `| <ts file> › <describe> › <it> | <rust test path or dropped: reason> |`. `--files <glob>` limits the check to the ported files, and the list of ported globs lives in `PARITY.md`'s header so each ticket extends it. CI runs it (in ci.sh). Generate `PARITY.md` with **every** row pre-filled and the Rust column `todo`, so tickets only edit their own lines.
- **FR-7**: CLAUDE.md §Commands gains the cargo commands (one block), and `docs/qa/QA_CHECKLIST.md` gains a Rust line (fmt, clippy, nextest, parity).

## Non-functional requirements
- **NFR-1**: the full `scripts/ci.sh` stays green on Linux. Cargo on an empty skeleton adds under a minute warm.
- **NFR-2**: no change to `packages/daemon`.

## Out of scope
Any real daemon code; protocol codegen (T03).

## Verification
- FR-1..FR-3: `cargo nextest run` green; a deliberate `cfg(windows)` in `src/daemon.rs` fails the seam test (show it in the PR, then revert).
- FR-4/FR-5: PR checks show `gates` and the three `daemon-rust` jobs green.
- FR-6: `node scripts/test-parity.js` lists ~440 cases, all `todo`; `--files` with no ported globs passes; test-parity.test.js covers missing row, extra row, and dropped rows.

- **Depends on**: MR-T01. **Files owned**: `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.gitignore`, `crates/**` (skeleton), `scripts/ci.sh`, `scripts/test-parity*.js`, `.github/workflows/ci.yml`, `.github/workflows/daemon-rust.yml`, `CLAUDE.md` §Commands, `docs/qa/QA_CHECKLIST.md`. **Do not touch**: `packages/**`.
- **Acceptance**: [ ] gates green on all three OSes; [ ] PARITY.md pre-filled; [ ] seam test proven.

### MR-T03 · Protocol codegen: zod → JSON Schema → Rust, two-sided fixture parity
## Goal
The Rust daemon speaks exactly the protocol the orchestrator speaks, and any drift between the zod schemas and the Rust types fails CI.

## Context
ADR-0026 §2. The daemon imports ~62 symbols from `@conductor/shared` (all through `packages/shared/src/index.ts`): `protocol/ws.ts` (messages, close codes, limits, `parseOrchestratorMessage`, …), `protocol/outcome.ts`, `domain.ts` (`OUTPUT_TAIL_BYTES`, `GITHUB_PR_URL_RE`, `JsonObject`), `api/machines.ts` (enroll DTOs), `api/rest.ts` (`API_PATHS`, `canonicalRepo`, `conductorPort`), `machines/capabilities.ts`, `machines/inventory.ts`, `workflow/schema.ts` (`Condition`), `workflow/tools.ts` (`resolveToolPolicy`). Fixtures: `packages/shared/src/protocol/fixtures.ts` (one per message type and per `session_event` kind). zod 4 has `z.toJSONSchema`. **Spike finding (PR #74):** schemars renders `Option<String>` as `"type": ["string", "null"]`, where zod emits `type: string` and leaves the field out of `required`. Generated types must serialise an absent optional as *absent*, not `null` (`#[serde(skip_serializing_if = "Option::is_none")]`), or the fixture round-trip fails.

## Functional requirements
- **FR-1**: `packages/shared/scripts/emit-protocol.ts` writes `packages/shared/protocol-json/`: one JSON Schema per daemon-facing schema (both directions of the WS protocol, outcome, enroll request/response, capability, inventory, condition), `constants.json` (`PROTOCOL_VERSION`, `CLOSE_*`, every byte/char limit, `DEFAULT_PERMISSION_TIMEOUT_MS`, `PERMISSION_*`, `GH_MIN_VERSION`, `NO_CONVERSATION_REASON`, `DAEMON_AUTH_HEADER`, `API_PATHS` the daemon uses), and `fixtures/*.json` from every fixture export in `protocol/fixtures.ts`. A `pnpm --filter @conductor/shared emit:protocol` script runs it.
- **FR-2**: `crates/conductor-protocol`: types generated with `typify` from the schemas (generator under `crates/conductor-protocol/build/` or an `xtask`; the generated `src/generated.rs` is checked in), constants from `constants.json`, hand-written wrappers only where typify output is unusable (each one listed in the crate README with the reason).
- **FR-3**: Rust ports with shared JSON test vectors (`packages/shared/protocol-json/vectors/*.json`) that **both** a vitest test and a Rust test run: `resolveToolPolicy`, `canonicalRepo`, `isCanonicalRemote`, `cliVersionAtLeast`, `capabilityKey(s)`, `daemonAuthHeaderValue`, `jsonByteLength`.
- **FR-4**: round trip: every fixture parses in Rust, re-serialises, and equals the original after canonical JSON (sorted keys). A vitest test parses the Rust-serialised output (written by `cargo test` into `target/protocol-roundtrip/`, or committed golden files) with the zod parsers.
- **FR-5**: drift check in `scripts/ci.sh`: re-run emit + generate, and `git diff --exit-code packages/shared/protocol-json crates/conductor-protocol/src/generated.rs`.

## Non-functional requirements
- **NFR-1**: no change to any zod schema's behaviour. If a schema can't be emitted (e.g. a `.transform`), add an emit-only twin next to it and test they accept the same fixtures.

## Out of scope
Daemon logic; orchestrator changes.

## Verification
- FR-1/FR-5: CI drift check green; a deliberate schema edit without regeneration fails it (shown in the PR, reverted).
- FR-2/FR-4: `cargo nextest run -p conductor-protocol` round-trips every fixture; `pnpm vitest run --project shared` parses the Rust output.
- FR-3: vectors pass on both sides.

- **Depends on**: MR-T02. **Files owned**: `packages/shared/scripts/emit-protocol.ts`, `packages/shared/protocol-json/**`, `packages/shared/package.json` (script line), the new shared vector tests, `crates/conductor-protocol/**`, the drift step in `scripts/ci.sh`. **Do not touch**: `packages/shared/src/**` behaviour, `crates/conductor-daemon/**`.
- **Acceptance**: [ ] every fixture round-trips; [ ] drift check; [ ] vectors on both sides.

### MR-T04 · platform/: spawn, kill tree (Job Objects), procinfo, ACLs, shell and the rest
## Goal
Every OS-specific behaviour of the daemon lives in one Rust module, with the same safety guarantees as the TS daemon on macOS, Linux and Windows, and Job Objects on Windows.

## Context
ADR-0024 (all of it: tree kill, owner-only DACL, Git Bash, `claude.exe` only per U-110) and ADR-0026. The reference is `packages/daemon/src/platform/*.ts` and their tests. The spike's Job Object result (U-116) decides how far `taskkill /T` can be retired. **Spike findings (`spikes/rust-daemon/README.md`, PR #74):** Job Objects are GO (variants a–c in `job-probe` left no survivor on `windows-latest`; `taskkill /T` left a reparented grandchild). Assignment must be atomic: `CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject` → `ResumeThread` (or `PROC_THREAD_ATTRIBUTE_JOB_LIST`); assigning after `std::process::Command::spawn` lets cmd start node outside the job. On POSIX a `setsid` grandchild escapes `killpg`, exactly as in the TS daemon today: keep TS parity here and don't add a subreaper (U-117).

## Functional requirements
- **FR-1** `spawn`: PATHEXT resolution, `.cmd` refusal of unsafe args / `ERR_CMD_UNSAFE_ARG` equivalent, the command-line length cap, ENOENT → typed error, the U-110 rule (native `claude.exe` only); no shell, ever.
- **FR-2** `kill_tree`: POSIX: own process group (`setpgid`), `killpg` TERM then KILL after the grace, `killed_exit` semantics as TS. Windows: assign each spawned child to a kill-on-close Job Object, terminate the job; keep `taskkill /T /F` as the fallback when assignment fails.
- **FR-3** `procinfo`: start time + argv of a pid (POSIX `ps -ww -o lstart= -o command=` as TS, or `sysinfo`/`/proc` if it gives identical results; Windows: native API, no PowerShell).
- **FR-4** `acl`: POSIX 0600/0700 + lstat + owner uid checks; Windows: owner-only DACL write and verify through `windows-sys` (same SIDs and rules as `acl.ts`, refuse links/junctions), no icacls/PowerShell.
- **FR-5** `shell` (Git Bash discovery, `CONDUCTOR_SHELL`), `sysres` (darwin `vm_stat`, Windows CPU deltas), `hook` (quoting with `|| exit 2`), `git` (null device, hooks-off args, `GIT_CONFIG_NOSYSTEM`), `fs` (`same_path`, case-insensitive realpath on Windows).
- **FR-6** the `test_support/fake_bin` and `remove_tree` helpers (portable fake executables, retrying removal).

## Non-functional requirements
- **NFR-1**: OS `cfg` only under `src/platform/` (seam test).
- **NFR-2**: POSIX behaviour byte-for-byte as TS (same argv to `ps`, same modes).

## Out of scope
Wiring into callers (T07, T09).

## Verification
- Every case of `platform/{acl,spawn,procinfo,kill-tree,shell,sysres,index}.test.ts` and `test-support/fake-bin.test.ts` has a Rust test, with the PARITY rows filled and the globs added to the ported list.
- A Windows test kills a tree with a detached grandchild and finds no survivor.
- `daemon-rust` green on all three OSes.

- **Depends on**: MR-T02. **Files owned**: `crates/conductor-daemon/src/platform/**`, `src/test_support/{fake_bin,remove_tree}.rs`, their PARITY rows. **Do not touch**: other modules, `packages/**`.
- **Acceptance**: [ ] parity rows done; [ ] three-OS green; [ ] seam test green.

### MR-T05 · Core: config, credential, store, ports and small modules
## Goal
The Rust daemon reads and writes every file and env var the TS daemon does, byte-compatibly, so a machine upgrades in place without re-enrolling.

## Context
ADR-0026 §4 (unchanged layout), ADR-0013 (credential), ADR-0024 (Windows credentials). Reference: `packages/daemon/src/{config,credential,store,ports,system-prompt,orphan,sysinfo}.ts`, `commands/{semaphore,tail}.ts`, `inventory/version.ts`, and `units.test.ts`, `credential.test.ts`, `orphan.test.ts`, `sysinfo.test.ts`, `index.test.ts`.

## Functional requirements
- **FR-1** `config`: every `CONDUCTOR_*` env var in `config.ts` with the same names, parsing and defaults; `<root>/config.json` with the same schema; `daemon_version()` = crate version + `CONDUCTOR_BUILD_SHA`.
- **FR-2** `credential`: `<root>/machine.json` load/write via `platform::acl`, `daemon_ws_url`, the TLS-or-loopback rule.
- **FR-3** `store`: the same single atomic JSON file (seq, buffered events, ack dedupe, per-session facts), same field names.
- **FR-4** `ports`, `system_prompt`, `orphan` (`check_ours`, `parse_lstart`), `sysinfo`, `semaphore` (FIFO, abortable), `tail` (UTF-8-safe bounded), `inventory/version`.
- **FR-5** compatibility fixtures: TS-written `machine.json`, `config.json` and store files committed under `crates/conductor-daemon/tests/fixtures/ts/` (generate them by running the TS code once, and note the command in the test). Rust reads them, and Rust-written files are read back by a vitest test in `packages/daemon` (the one allowed test-only addition there).

## Non-functional requirements
- **NFR-1**: atomic writes (temp + rename) as TS; private modes via `platform::acl`.

## Out of scope
WS, processes, git.

## Verification
- PARITY rows filled for the listed TS test files (semaphore/tail cases in `process-runner.test.ts` too).
- The FR-5 fixtures read on both sides.

- **Depends on**: MR-T03, MR-T04. **Files owned**: `src/{config,credential,store,ports,system_prompt,orphan,sysinfo}.rs`, `src/commands/{semaphore,tail}.rs`, `src/inventory/version.rs`, `tests/fixtures/ts/**`, the one vitest compat test, their PARITY rows. **Do not touch**: `packages/daemon/src/**` (except the new compat test).
- **Acceptance**: [ ] parity rows; [ ] cross-reading fixtures; [ ] three-OS green.

### MR-T06 · Test support: fake orchestrator, fake driver, fake runner
## Goal
Rust daemon tests can run against the same kinds of fakes the TS tests use, with every frame validated against the real protocol types.

## Context
Reference: `packages/daemon/src/test-support/fake-orchestrator.ts`, `src/claude/fake-driver.ts`, `src/commands/fake-runner.ts`, `src/claude/driver.ts`, `src/commands/runner.ts` (the contracts), and `fake-driver.test.ts`, `fake-runner.test.ts`.

## Functional requirements
- **FR-1** `test_support/fake_orchestrator`: a loopback WS server (`tokio-tungstenite`) that parses every daemon frame with `conductor-protocol` (failing the test on an invalid one), records auth headers, can refuse (HTTP 401/403) or close with 4001/4003/4005, and scripts orchestrator frames.
- **FR-2** the `ClaudeDriver` / `DriverSession` / `DriverEvent` trait (`claude/driver.rs`) and the `CommandRunner` trait (`commands/runner.rs`), mirroring the TS contracts.
- **FR-3** `FakeClaudeDriver` and `FakeCommandRunner`, scripted as in TS, available to tests (behind `#[cfg(test)]` or a `test-support` cargo feature).

## Out of scope
Real driver and runner.

## Verification
- PARITY rows for `fake-driver.test.ts` and `fake-runner.test.ts`.
- A self-test of the fake orchestrator rejecting an invalid frame.

- **Depends on**: MR-T03. **Files owned**: `src/test_support/fake_orchestrator.rs`, `src/claude/{driver,fake_driver}.rs`, `src/commands/{runner,fake_runner}.rs`, their PARITY rows. **Do not touch**: other modules.
- **Acceptance**: [ ] parity rows; [ ] three-OS green.

### MR-T07 · WS client and process runner
## Goal
The Rust daemon keeps a resilient authenticated socket to the orchestrator and runs workflow commands with the same isolation, timeouts and kill behaviour as the TS daemon.

## Context
Reference: `packages/daemon/src/ws-client.ts` (+ `ws-client.test.ts`, the backoff cases in `units.test.ts`), `src/commands/process-runner.ts` (+ `process-runner.test.ts`, minus the semaphore/tail cases ported in T05), `src/commands/index.ts`.

## Functional requirements
- **FR-1** `ws_client`: reconnect with the same backoff and jitter, the auth header, close codes 4001 (revoked) / 4003 (unauthorized) / 4005 (protocol) and HTTP 401/403 handled as TS.
- **FR-2** `commands/process_runner`: `sh -c` (or Git Bash via `platform::shell`) in its own group/job, timeout → kill tree, leftovers killed after the shell exits, output tails, the build semaphore; `create_command_runner` factory.

## Verification
- PARITY rows for `ws-client.test.ts`, the ws-client backoff cases in `units.test.ts`, and `process-runner.test.ts`.
- Three-OS green.

- **Depends on**: MR-T05, MR-T06. **Files owned**: `src/ws_client.rs`, `src/commands/{process_runner,mod}.rs` factory, their PARITY rows. **Do not touch**: other modules.
- **Acceptance**: [ ] parity rows; [ ] three-OS green.

### MR-T08 · claude/: stream parser, transcript, edit guard, outcome and permission MCP server
## Goal
The Rust daemon understands Claude's stream and transcripts, keeps Edit/Write inside the worktree without Node, and serves the outcome and permission tools Claude calls.

## Context
ADR-0005, ADR-0023 (permission prompts), ADR-0024 §edit guard, ADR-0026 §5 (`hook edit-guard` subcommand, `rmcp` or the axum fallback per the T01 spike). **Spike findings (`spikes/rust-daemon/`, PR #74), reuse its `mcp-probe` server as the starting point:** rmcp 3.8 with `StreamableHttpServerConfig::with_allowed_hosts` (loopback Host check → 403; drop the hand-written TS check), `with_legacy_session_mode(false)` + `with_json_response(true)` (the TS stateless JSON shape; GET → 405), an axum route `/mcp/{token}` in front of one `StreamableHttpService` per token via `tower::ServiceExt::oneshot` (unknown token → 404), `#[tool(meta = …)]` for `anthropic/alwaysLoad`. Leave `stateless_protocol_metadata_required` off (fake-claude negotiates `2025-06-18`). Caps (`minLength`/`maxLength`) are enforced in the handler, not by the schema. fake-claude's SDK client times out at 60 s, so the held permission call is tested with a raw JSON-RPC client, and the real-claude permission test sets `MCP_TOOL_TIMEOUT`. Reference: `packages/daemon/src/claude/{stream-parser,transcript,edit-guard,outcome-server}.ts` and their tests.

## Functional requirements
- **FR-1** `stream_parser`: lenient NDJSON stream-json line parser that never panics.
- **FR-2** `transcript`: find and read `projects/<slug>/<id>.jsonl` (same slug rules incl. Windows), map to output chunks with the same limits.
- **FR-3** `edit_guard`: the PreToolUse hook settings now run `<daemon exe> hook edit-guard` (the subcommand body lives in `edit_guard.rs`; `main` wiring is T13, so expose a function T13 calls). Same allow/deny decisions as `edit-guard.mjs`, fail closed.
- **FR-4** `outcome_server`: 127.0.0.1 streamable-HTTP MCP, per-session `/mcp/<token>`, tools `complete_state`, `ask_user` and the permission tool with the same names, input shapes, results, limits and timeouts (`DEFAULT_PERMISSION_TIMEOUT_MS`, `PERMISSION_*`).

## Verification
- PARITY rows for `stream-parser`, `transcript`, `edit-guard`, `outcome-server` tests (the raw JSON-RPC posts in `outcome-server.test.ts` are replayed byte-for-byte).
- `fake-claude.mjs` completes a state against the Rust server.

- **Depends on**: MR-T05, MR-T06. **Files owned**: `src/claude/{stream_parser,transcript,edit_guard,outcome_server}.rs`, their PARITY rows. **Do not touch**: `src/claude/cli_driver.rs`.
- **Acceptance**: [ ] parity rows; [ ] three-OS green.

### MR-T09 · claude/cli_driver: the long-lived claude process
## Goal
The Rust daemon drives a real `claude -p` session exactly as the TS daemon does: same flags, same input and output handling, same kill and end behaviour.

## Context
ADR-0005, ADR-0023, ADR-0024 (`claude.exe` only). Reference: `packages/daemon/src/claude/cli-driver.ts`, `cli-driver.test.ts`, `cli-driver.real.test.ts` (opt-in, `E2E_REAL_CLAUDE`). Tests drive `packages/daemon/test/fixtures/fake-claude.mjs` (`CONDUCTOR_CLAUDE_BIN`), which logs its argv.

## Functional requirements
- **FR-1**: spawn via `platform::spawn` in its own group/job; bidirectional stream-json; MCP config file pointing at the outcome server; agent env; permission mode and `--permission-prompts`; system prompt; `--resume`.
- **FR-2**: the same argv as TS for the same session inputs (compare with fake-claude's argv log in a test against recorded TS argv).
- **FR-3**: kill and end grace, stderr tail, no-outcome handling, exactly as TS.
- **FR-4**: real-Claude tests behind `E2E_REAL_CLAUDE=flags|1|permission` (`#[ignore]` unless set).

## Verification
- PARITY rows for both cli-driver test files.
- Three-OS green.

- **Depends on**: MR-T07, MR-T08. **Files owned**: `src/claude/cli_driver.rs`, its PARITY rows. **Do not touch**: other modules.
- **Acceptance**: [ ] parity rows; [ ] argv parity test; [ ] three-OS green.

### MR-T10 · Workspace, hardened exec, and actions (open_pr, checkout, conditions)
## Goal
The Rust daemon manages clones and worktrees and runs git and gh actions with the same hardening as the TS daemon.

## Context
ADR-0010 (private repos, `open_pr`), ADR-0013 (reference clones), M2-T13a (fresh base fetch). Reference: `packages/daemon/src/workspace.ts`, `src/actions/{open-pr,checkout,conditions}.ts` and their tests (`workspace`, `workspace.fresh-base`, `open-pr`, `open-pr.gh-version`, `checkout`, `conditions`). Tests use real git on temp repos and fake `gh` via `fake_bin`.

## Functional requirements
- **FR-1** `exec`: one hardened exec/git module (`clean_env`, `run`, tail, `NO_HOOKS`, `private_dir`); TS has these in `open-pr.ts` and inventory imports them from there. Rust puts them in `src/exec.rs`.
- **FR-2** `workspace`: shared clones under `repos/`, `git worktree add wt/<id>`, fresh-base fetch, the repo allow policy (incl. `CONDUCTOR_ALLOW_LOCAL_REPOS`), CLAUDE.md read, `inventory_digest`.
- **FR-3** `actions/open_pr` (push hardening, `gh pr create`/reuse, gh version gate), `actions/checkout` (fresh private checkout, package-manager detection, sweep), `actions/conditions` (`gh pr view --json …` → condition results).

## Verification
- PARITY rows for the six TS test files.
- Three-OS green (Git Bash on Windows for the sh-based fake gh, as TS).

- **Depends on**: MR-T07. **Files owned**: `src/{exec,workspace}.rs`, `src/actions/**`, their PARITY rows. **Do not touch**: other modules.
- **Acceptance**: [ ] parity rows; [ ] three-OS green.

### MR-T11 · Inventory: capabilities, repos, report, rescan
## Goal
The Rust daemon reports the same repos and capabilities as the TS daemon, so routing is unchanged.

## Context
ADR-0013. Reference: `packages/daemon/src/inventory/{capabilities,repos,git,report}.ts` and `capabilities.test.ts`, `repos.test.ts`, `report.test.ts` (fake timers), MW-T09's Windows rescan plan (`docs/plan/milestones/MW-windows-daemon.md`).

## Functional requirements
- **FR-1** `capabilities`: the same CLI probes (version, authed), MCP/skill/agent names.
- **FR-2** `repos` (walk roots, depth ≤ 4, no symlinks, refs and remote), `inventory/git` (read-only, hooks off, via `exec`).
- **FR-3** `report`: payload and hash identical to TS for the same machine state (a test compares against a TS-generated golden payload), 10-minute rescan, SIGHUP rescan on POSIX; on Windows a rescan trigger (MW-T09's design: a `rescan` subcommand writes a trigger file the daemon watches).

## Verification
- PARITY rows for the three TS files.
- The golden payload test.

- **Depends on**: MR-T10. **Files owned**: `src/inventory/{capabilities,repos,git,report}.rs`, their PARITY rows and golden files. **Do not touch**: other modules.
- **Acceptance**: [ ] parity rows; [ ] golden payload; [ ] three-OS green.

### MR-T12 · Daemon core
## Goal
The Rust daemon does everything the TS `Daemon` class does: register, replay, heartbeat, pull work, run sessions and commands, and recover after restarts.

## Context
Reference: `packages/daemon/src/daemon.ts` (1,588 lines), `daemon.test.ts` (63 cases), `daemon.kill.test.ts`, `reopen-transcript.test.ts`, and the remaining `units.test.ts` cases. 10-contracts §Daemon seq dedupe, §Agent process correlation, §Orphaned processes, §Refusals (the resume-without-transcript refusal, 7cf97f2).

## Functional requirements
- **FR-1**: register / registered, seq replay of buffered events, heartbeat with live sysinfo, inventory, `request_work` pull scheduling, command dedupe and acks.
- **FR-2**: `start_session` / `run_cmd` / `send_input` / `kill` / `evaluate_conditions` / actions, with the same refusals and event payloads.
- **FR-3**: startup orphan sweep (BUG-1b rules), transcript reopen, `no_live_process` and resume paths.

## Verification
- PARITY rows for `daemon.test.ts`, `daemon.kill.test.ts`, `reopen-transcript.test.ts`, the rest of `units.test.ts`. They run against `fake_orchestrator`, the fakes, real git and `fake-claude.mjs`, as in TS.
- Three-OS green.

- **Depends on**: MR-T09, MR-T10, MR-T11. **Files owned**: `src/daemon.rs`, its PARITY rows. **Do not touch**: other modules except to fix a bug found here (say so in the PR).
- **Acceptance**: [ ] parity rows; [ ] three-OS green.

### MR-T13 · main and subcommands: run, enroll, config, help, hook, rescan, service
## Goal
`conductor-daemon` is a complete command-line program, including starting at login on every OS, writing the same files the installers expect.

## Context
Reference: `packages/daemon/src/main.ts`, `src/commands/{enroll,config}.ts` (+ tests), M2-T18 (`service install`, `conductor-launch`, units; U-112 says whether it landed in TS first, in which case its tests are ported too), MW-T10 (Windows Scheduled Task, U-108), ADR-0021 §3 (the launcher is version-independent), `packages/orchestrator/assets/install.sh.tmpl` (calls `service install` / `service restart`, expects `~/Library/LaunchAgents/com.conductor.daemon.plist` and `~/.config/systemd/user/conductor-daemon.service`).

## Functional requirements
- **FR-1** `clap` CLI: `run` (default), `enroll --url --token [-|env]`, `config roots …` / working-copy mode / `auto-update on|off` / `show`, `help`, `--version` (prints the version, as ADR-0021 staging requires), `hook edit-guard` (calls T08's function), `rescan`.
- **FR-2** `service install|restart|uninstall`: launchd agent and systemd user unit that run `<root>/bin/conductor-launch` with `CONDUCTOR_SUPERVISED=launchd|systemd`, restart on exit 75, stop on 78 (ADR-0021 §2.4). The launcher is a POSIX sh script with the **same bytes** M2-T18 defined (or, if T18 didn't land, the ADR-0021 §3 script). Windows: a per-user Scheduled Task at logon running the Windows launcher (U-114's answer, or the MW-T10 `.ps1` until then).
- **FR-3** signals: SIGINT/SIGTERM graceful shutdown then exit after the kill grace; SIGHUP rescan (POSIX); Ctrl-Break on Windows.
- **FR-4** exit codes as TS and ADR-0021 (75 restart-for-update, 78 fatal auth).

## Verification
- PARITY rows for `enroll.test.ts`, `config.test.ts` (and the M2-T18 service tests if present).
- `assert_cmd` tests for every subcommand and exit code.
- On each OS in CI, `service install` writes the expected file in a temp HOME (no real launchctl/systemctl/schtasks calls in CI; those are behind a runner trait).

- **Depends on**: MR-T12, U-112. **Files owned**: `src/main.rs`, `src/commands/{enroll,config,service}.rs`, `assets/conductor-launch*`, their PARITY rows. **Do not touch**: other modules, `packages/orchestrator/assets/**` (T15).
- **Acceptance**: [ ] parity rows; [ ] subcommand tests; [ ] three-OS green.

### MR-T14 · Auto-update (ADR-0021) in Rust
## Goal
After cutover, every machine updates itself to each new build without anyone touching it, never cuts running work, and rolls back a bad build and tells a human.

## Context
ADR-0021 in full (it replaces M2-T18c), ADR-0026 §4 (one tarball per target). The orchestrator side (M2-T18b contracts, M2-T18d announce + `latest.json`, M2-T18e web) is TS on the M2 plan. This ticket is the daemon side only. 10-contracts §Daemon auto-update. Windows launcher: U-114.

## Functional requirements
- **FR-1** on `update_available` (or the 4005 path via `GET /downloads/latest.json`): stage to `<root>/daemon/.staging-<random>`, check size and SHA-256, refuse unsafe archive entries, unpack, run `<staging>/bin/conductor-daemon --version`, rename to `<root>/daemon/<version>`; any failure deletes staging.
- **FR-2** drain: stop `request_work`, `heartbeat.draining`, wait for idle (parked sessions don't block), bounds (6 h, 1 h back-off, 3 abandoned drains) exactly as ADR-0021 §2.
- **FR-3** switch: write `trial`, repoint `current` atomically (POSIX symlink rename; Windows: junction swap, never overwrite a running exe), exit 75. Unsupervised: stage only and log once.
- **FR-4** commit on first `registered` (delete `trial`), the 120 s connected-but-unregistered rule, `bad-versions` + `alert {kind: 'update_failed'}`, disk cleanup, `config auto-update off`.
- **FR-5** the launcher's trial/rollback logic (POSIX sh, plus Windows per U-114), with a test that the two installers' launcher bytes match.

## Verification
- Unit tests for each stage and bound (fake clock, fake orchestrator serving a tarball).
- e2e: one update and one rollback (the M2-T22 cases) against the Rust binary, Linux and Windows.

- **Depends on**: MR-T13, M2-T18b, U-114. **Files owned**: `src/update.rs`, the launcher assets, the update e2e cases. **Do not touch**: orchestrator code.
- **Acceptance**: [ ] unit tests; [ ] update + rollback e2e; [ ] three-OS green.

### MR-T15 · Distribution on the existing upgrade path
## Goal
The orchestrator serves the Rust daemon through the same install and upgrade path users already have: same URL, same layout, one re-run to upgrade, no Node needed.

## Context
ADR-0026 §4, ADR-0017, ADR-0021 §1 (`file` rule), ADR-0024 (install.ps1). Today: `packages/orchestrator/scripts/build-daemon-tarball.sh` (Node tarball), `packages/orchestrator/src/distribution.ts` (`TARBALL_RE`, `findDaemonBuild`, `renderInstallScript`, `isOutdated`), `assets/install.sh.tmpl`, `assets/install.ps1.tmpl`, `assets/conductor-daemon.cmd.tmpl`, the `Dockerfile` `daemon-tarball` stage, tests `distribution*.test.ts`, `install-script.test.ts`, `install-ps1.test.ts`. U-115 (signing).

## Functional requirements
- **FR-1** artifacts: `conductor-daemon-<version>-<target>.tgz` + `.sha256` for `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu` (or musl), `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`. Inside: `bin/conductor-daemon` (the binary; Windows `bin/conductor-daemon.exe` + `bin/conductor-daemon.cmd` calling it), plus the launcher assets. Built by the `daemon-rust` matrix on release (push to main) and attached so the image build can fetch them; the `Dockerfile` stage copies them to `/app/downloads` (replacing `build-daemon-tarball.sh`).
- **FR-2** `distribution.ts`: `TARBALL_RE` with the target suffix, `findDaemonBuild` per target, a helper that maps `register.os`/`arch` to a target (for ADR-0021's `update_available`), `isOutdated`/`servedVersion` unchanged.
- **FR-3** `install.sh.tmpl` rendered with every target's `FILE`/`SHA256` and choosing by `uname -s`/`uname -m` (clear error for an unsupported one); `install.ps1.tmpl` uses the Windows pair. Both drop the Node ≥ 22 checks and keep everything else (verify-before-write, staging, `current` swap, enrollment kept).
- **FR-4** in-place upgrade test: a root laid out by today's TS tarball (with `machine.json` and a store file) is upgraded by the rendered `install.sh` to the Rust tarball. `current` points at the new version, the old version directory is kept, and `machine.json` is untouched.

## Verification
- Updated `distribution*.test.ts`, `install-script.test.ts`, `install-ps1.test.ts` green (the last on the Windows job).
- The FR-4 test.
- `docker build` produces an image whose `/downloads` lists all five targets.

- **Depends on**: MR-T13, U-115. **Files owned**: the files named in Context, `.github/workflows/daemon-rust.yml` release job. **Do not touch**: daemon crate code.
- **Acceptance**: [ ] five targets served; [ ] install tests; [ ] in-place upgrade test.

### MR-T16 · e2e on the Rust binary
## Goal
The end-to-end suites prove the Rust daemon works against the real orchestrator on Linux and Windows, including the move from the TS daemon.

## Context
`e2e/harness/stack.ts` hard-codes `packages/daemon/dist/main.js` and spawns it with Node (`:30`, `:250`). `e2e/run.sh` builds it. `packages/orchestrator/test/e2e/ask-answer.test.ts` imports `Daemon` and the fakes from `@conductor/daemon` in-process, and `packages/orchestrator/package.json` depends on `@conductor/daemon`. MW-T12 (Windows e2e) moves here.

## Functional requirements
- **FR-1** `stack.ts`: `CONDUCTOR_E2E_DAEMON_BIN` (default: the Rust release binary at `target/release/conductor-daemon[.exe]`) spawned directly. `e2e/run.sh` builds it with cargo. Setting the TS build path still works until MR-T18b.
- **FR-2** rewrite `ask-answer.test.ts` to drive the daemon binary over the real gateway (or move it into `e2e/`), and drop the `@conductor/daemon` dependency from the orchestrator.
- **FR-3** a Windows e2e job (on `daemon-rust.yml`) running the e2e suites with fake claude.
- **FR-4** a TS → Rust upgrade e2e: enroll and run a ticket with the TS daemon, re-run the rendered `install.sh` with the Rust tarball, restart, and check the same machine id registers with no re-enroll and the next ticket runs.

## Verification
- `pnpm test:e2e` green on Linux against Rust (and once against TS via the env var, shown in the PR).
- The Windows e2e job green.
- FR-4 green.

- **Depends on**: MR-T13, MR-T15. **Files owned**: `e2e/**`, `packages/orchestrator/test/e2e/ask-answer.test.ts`, `packages/orchestrator/package.json` (that dependency), the Windows e2e job. **Do not touch**: daemon crate code (report bugs in the PR).
- **Acceptance**: [ ] e2e green on Linux and Windows; [ ] upgrade e2e.

### MR-T18a · Cutover docs and parity at 100%
## Goal
Every doc describes the Rust daemon, and the parity ledger proves every TS test has a Rust counterpart.

## Context
ADR-0026. Docs that describe the daemon: `docs/design/10-contracts.md`, `03-protocols.md`, `01-architecture.md` (and mentions in 02, 04–09), `docs/setup/add-a-machine.md` + its mirror `packages/web/src/help/add-a-machine.md` + `packages/web/src/onboarding/{content.ts,steps.tsx}`, `README.md`, `CLAUDE.md` (stack, commands, toolchain), `docs/qa/TEST_STRATEGY.md`, `e2e/README.md`.

## Functional requirements
- **FR-1**: those docs say "Rust binary" where they say Node/TS daemon, drop "Node 22" from machine prerequisites, and point at `crates/conductor-daemon`.
- **FR-2**: `scripts/test-parity.js` runs with **no** `--files` limit and passes. Every `dropped:` row is listed in the PR for Ben.
- **FR-3**: the cutover steps for Ben (re-run the installer on each machine, how to roll back to the TS version directory) go in `docs/setup/add-a-machine.md` §Upgrading.

## Verification
- Parity at 100%; `scripts/ci.sh` green; web help tests green.

- **Depends on**: MR-T14, MR-T15, MR-T16. **Files owned**: the docs listed. **Do not touch**: code.
- **Acceptance**: [ ] parity 100%; [ ] docs; [ ] gates.

### MR-T18b · Delete the TypeScript daemon
## Goal
The repo has one daemon, and nothing builds, tests or ships the TS one.

## Context
Only after Ben's dogfood day on each OS passed on the Rust daemon and Ben OKs the deletion (MR exit criteria).

## Functional requirements
- **FR-1**: delete `packages/daemon` except `test/fixtures/fake-claude.mjs` and `transcript.jsonl`, which move to `e2e/fixtures/` (update every reference).
- **FR-2**: remove its root `tsconfig.json` reference, the vitest `daemon` projects, its `scripts/test-tiers.js` tier, the ESLint scope, the TS Windows job in `daemon-windows.yml` (or the whole file if nothing else remains), the `CONDUCTOR_E2E_DAEMON_BIN` TS fallback, and `scripts/test-parity.js` (now frozen; PARITY.md stays as the record).

## Verification
- `scripts/ci.sh` green; `grep -r "packages/daemon"` only hits history docs (ADRs, session logs, the ledger).

- **Depends on**: MR-T18a, Ben's OK. **Files owned**: the files above.
- **Acceptance**: [ ] gates; [ ] grep clean.
