# Session 2026-10-29 · rust-daemon-plan

- **Lead**: Claude (claude-opus-5-5) with Ben · background job
- **Milestone / phase**: MR · Plan
- **Goal for this session**: answer "why not Rust now rather than later", then (Ben's call) plan the port

## What happened
- Answered the question: the lead recommended waiting until M2's daemon work landed. The reasons were moving daemon surface, the just-finished Windows TS work, an unsettled protocol, and Ben's review queue. The cheaper alternative offered was a Node single-executable spike.
- Ben overrode this: port now, and reimplement every test. Two Explore agents inventoried the daemon (51 prod files / 9.9k lines, 39 test files / 10.4k lines / ~440 cases) and everything outside it that the port touches (shared protocol imports, e2e harness, distribution, CI, docs).
- Ben's decisions (AskUserQuestion):
  - freeze the TS daemon and build unbuilt daemon features in Rust only;
  - protocol by codegen (zod → JSON Schema → typify) with two-sided fixture parity;
  - parity on macOS, Linux and Windows before cutover;
  - mid-plan: "use our existing daemon upgrade path if possible".
- Checked the upgrade path. `install.sh`/`install.ps1` already do in-place upgrades into `<root>/daemon/<version>` + `current` and keep `machine.json`. `register` already sends `os`/`arch`. So the Rust daemon ships in the same tarball layout with no protocol change. ADR-0021's updater gets built in Rust, and the TS → Rust move is one installer re-run per machine.
- Wrote ADR-0026 and the MR milestone (19 tasks) on `mr-t00-rust-daemon-plan`.
- Found that the `service` subcommand `install.sh.tmpl` calls doesn't exist yet in the daemon (in flight as M2-T18). U-112 asks whether T18 finishes in TS. The recommendation is yes, because its launcher and units are the reused upgrade path.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| Explore | Daemon module + test inventory | — | PASS |
| Explore | Daemon coupling outside the package (shared, e2e, distribution, CI, docs, conventions) | — | PASS |

## Tracking changes
- Unknowns raised: U-112 (M2-T18 in the freeze), U-113 (rmcp), U-114 (Windows launcher), U-115 (signing/Gatekeeper), U-116 (Job Objects)
- Blockers raised: B-005 (Rust toolchain)
- Tech debt: none
- ADRs: ADR-0026 (new); amendment notes on ADR-0004, 0017, 0021, 0024
- Unfinished handoffs written: MR-T00

## Next session should start with
- Ben merges `mr-t00-rust-daemon-plan`, answers U-112 and installs rustup (B-005). The lead tags `daemon-ts-freeze` on the merge commit and starts the MR-T01 spike.
