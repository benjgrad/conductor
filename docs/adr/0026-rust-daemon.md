# ADR-0026 · The daemon is a Rust binary, shipped on the existing upgrade path

- **Status**: accepted (Ben, 2026-10-29, plan session: port now, freeze the TS daemon, protocol by codegen, three OSes, reuse the upgrade path)
- **Date**: 2026-10-29
- **Deciders**: Ben (+ Claude lead session, background job "why not Rust now")
- **Resolves**: none open. **Supersedes** the daemon part of [ADR-0004](0004-typescript-monorepo.md) (its "Revisit when: daemon install friction" trigger). **Amends** [ADR-0017](0017-own-sign-in-and-self-hosting.md) §Daemon distribution (Node 22 is no longer a prerequisite), [ADR-0021](0021-daemon-auto-update.md) (one tarball per target; the "Node SEA / bundled Node binary" row), and [ADR-0024](0024-native-windows-daemon.md) (Windows via Rust; Job Objects come back in scope)
- **Builds on**: [ADR-0005](0005-claude-code-driver.md) (stream-json driver), [ADR-0013](0013-machine-enrollment-inventory-routing.md) (enrollment, `register.os`/`arch`), [ADR-0023](0023-permission-prompts-through-conductor.md) (permission MCP tool)

## Context
The daemon (`packages/daemon`, ~9.9k lines of production code and ~10.4k lines of tests, ~440 cases) is the only part of conductor that runs on users' machines. As a Node program it needs Node 22 on every machine. Each OS then needs its own Node workarounds: the `.cmd` shim, cmd.exe escaping, ACL readers through PowerShell, `taskkill` instead of Job Objects, and a hook that runs `node edit-guard.mjs`. The MW-T11 installer work showed how much of the install and upgrade surface is Node plumbing.

On 2026-10-29 the lead recommended waiting until M2's daemon work landed. Ben chose to port now, and to stop building daemon features in TypeScript rather than build them twice.

## Decision
**`conductor-daemon` is rewritten in Rust as a native binary for macOS (arm64, x64), Linux (x64, arm64) and Windows x64, with every existing daemon test reimplemented. It ships through the existing distribution and upgrade path unchanged except for what is inside the tarball. The orchestrator, web and shared packages stay TypeScript, and the wire protocol does not change.**

### 1 · Freeze the TS daemon
From the freeze commit (tagged `daemon-ts-freeze` in MR-T00), `packages/daemon` gets bug fixes only. Each fix also gets a parity-ledger row and a Rust test. Daemon features not yet built are built in Rust only: ADR-0021's updater (M2-T18c), the daemon parts of M2-T27 and T28d, and MW-T09..T13. Their orchestrator, shared and web halves stay in TS and are built on the M2 plan as before. One exception is recommended (U-112): M2-T18, already in flight, finishes in TS. Its launcher, units and upgrade-in-place are version-independent, and they are the upgrade path the Rust daemon reuses.

### 2 · Protocol types come from zod
`packages/shared` stays the single source of truth for the protocol:
- A script emits JSON Schema (`z.toJSONSchema`) for every daemon-facing schema, the protocol constants as JSON, and `protocol/fixtures.ts` as JSON fixtures.
- `typify` generates `crates/conductor-protocol` from that output, and the generated code is checked in.
- CI fails if regenerating changes anything, or if any fixture doesn't round-trip on both sides.
- `PROTOCOL_VERSION` stays 2.

### 3 · Every test is reimplemented, and a ledger proves it
`crates/conductor-daemon/PARITY.md` maps every TS case (`file › describe › it`) to a Rust test, or marks it `dropped: <reason>`, which needs Ben's OK. `scripts/test-parity.js` fails CI if any TS case at the freeze commit has no row. Cutover requires 100%.

`test/fixtures/fake-claude.mjs` stays: it fakes an external binary at the process boundary, and the e2e suite uses it too. That makes Node a test-host-only dependency.

### 4 · Same upgrade path
- **The artifact** is `conductor-daemon-<version>-<target>.tgz` plus `.sha256`, with `bin/conductor-daemon` at the same path inside. On Windows that is `bin/conductor-daemon.exe` plus the existing `bin/conductor-daemon.cmd`, now one line that calls the `.exe`. ADR-0021's `file` rule (`^conductor-daemon-[0-9A-Za-z.+-]+\.tgz$`) still holds.
- **The layout doesn't change:** `<root>/daemon/<version>`, `<root>/daemon/current` (a symlink, or a junction on Windows), `<root>/bin/conductor-daemon`, `machine.json`, `config.json`, the store file and the worktree layout. Re-running `install.sh`/`install.ps1` without a token upgrades in place and keeps enrollment.
- **Choosing the target:**
  - `install.sh` is rendered with one `FILE`/`SHA256` pair per served target and picks one by `uname -s`/`-m`. `install.ps1` gets the Windows pair.
  - `update_available` (ADR-0021 §1) picks the file from `register.os`/`arch`, which daemons already send, so there is no protocol change.
- **The move from TS to Rust** is one `install.sh`/`install.ps1` re-run per machine. The frozen TS daemon never gets the updater. Rolling back to TS means pointing `current` at the TS version directory, which stays on disk. After cutover, ADR-0021's updater (built in Rust, MR-T14) moves Rust to Rust automatically, with the same launcher, trial and rollback.

### 5 · No Node at runtime
The edit-guard hook becomes `conductor-daemon hook edit-guard`, pointing at the daemon's own executable. The outcome and permission MCP server is `rmcp` (streamable HTTP), proven in the MR-T01 spike. If the spike fails, fall back to a hand-written JSON-RPC handler over `axum`; the MCP surface is three tools.

### 6 · Rust workspace and gates
- A Cargo workspace at the repo root (`crates/*`, `rust-toolchain.toml` pinned), outside the pnpm workspace.
- `scripts/ci.sh` adds `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo nextest run` inside a test slot.
- The `daemon-windows` workflow becomes a native build and test matrix on ubuntu, macos and windows runners.
- The seam rule carries over: `cfg(...)` OS branches only under `platform/`, enforced by a source-scanning test.

## Alternatives considered
| Option | Why not |
|---|---|
| Finish M2 first, port later (lead's recommendation) | Ben: port now. Each daemon feature built in TS before the port would have to be built again in Rust |
| Node single executable (SEA) | Removes the Node prerequisite but keeps every Node-on-Windows workaround and the edit guard's Node hook; Ben chose the rewrite |
| Go | Rust's `windows-sys` and `nix` cover Job Objects, DACLs and process groups directly; an official MCP SDK (`rmcp`) exists; ADR-0004 already weighed Go for the orchestrator, not the daemon |
| Hand-written serde types | Every protocol change would be edited twice; codegen plus fixtures make drift a CI failure |
| New artifact format / new installer | Ben: reuse the existing upgrade path. The tarball layout already isolates what's inside it |
| Port `fake-claude.mjs` too | It fakes an external program, not daemon code; keeping it lets the TS and Rust daemons run the same e2e scenarios |
| Unix first, Windows later | Ben: parity on all three before cutover, so there's never a second daemon to run |

## Consequences
- **Good:**
  - one static binary per target, with no Node on fleet machines;
  - Job Objects and native DACLs on Windows instead of `taskkill` and PowerShell;
  - the updater is simpler (one file, no `node_modules`);
  - the e2e suite becomes a cross-implementation parity check;
  - protocol drift fails CI.
- **Bad / accepted cost:**
  - a second language in CI and in review;
  - ~15–18k lines of Rust;
  - M2's daemon-side tasks wait on MR-T12;
  - the CI matrix gains macOS and Windows runners on every daemon change;
  - Rust has to be installed on dev machines (B-005);
  - contributors have to read both TS (orchestrator) and Rust (daemon).
- **Follow-ups:** the [MR milestone](../plan/milestones/MR-rust-daemon.md); U-112 (M2-T18 during the freeze), U-113 (`rmcp` maturity, MR-T01), U-114 (a Windows launcher that belongs to no version), U-115 (macOS Gatekeeper on curl-installed binaries), U-116 (Job Objects and claude's grandchildren); B-005 (toolchain).

## Revisit when
- The MR-T01 spike can't get real `claude -p` to call an `rmcp` streamable-HTTP tool. Then use the axum fallback in §5, or reopen this ADR if the gap is larger.
- The protocol needs a shape that `typify` can't express cleanly. Then write that type by hand, with a fixture test.
- Parity can't reach 100% for a class of tests. Then Ben decides on the drops, case by case.
