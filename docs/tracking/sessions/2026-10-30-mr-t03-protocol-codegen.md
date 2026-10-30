# Session 2026-10-30 · mr-t03-protocol-codegen

- **Lead**: Claude (Opus 5.5), conductor board ticket MR-T03, unattended
- **Milestone / phase**: MR · Build
- **Goal for this session**: the Rust daemon's protocol types come from the zod schemas, both sides check the same fixtures and vectors, and drift fails CI.

## What happened
- `packages/shared/scripts/emit-protocol.ts` (`pnpm --filter @conductor/shared emit:protocol`) writes `packages/shared/protocol-json/`: 23 draft-07 schemas, `constants.json`, `tool-policy.json`, and 92 fixture files plus `fixtures/manifest.json` from every export of `protocol/fixtures.ts`. An unmapped export fails the emit, and every fixture is zod-parsed first. It runs on the built package (Node type stripping can't run shared's sources), with its own `scripts/tsconfig.json` referenced from the root `tsconfig.json`.
- `crates/conductor-protocol/build` (`conductor-protocol-codegen`, a workspace member) runs typify 0.8 and writes `src/generated.rs` with the constants and the tool-policy table. It is a package of its own, not an example of the crate, because an example can't build without the file it generates.
- Findings that shaped it:
  - With named envelope definitions, typify emitted `untagged` unions (`fetch_transcript` parsed as `no_work`); inline variants give `#[serde(tag = "type")]`.
  - `.nullable().optional()` (`enrollment_token`, `cmd_exit.head_sha`) needs a double `Option`, which the generator patches in.
  - `io: 'input'` keeps unknown-key tolerance.
  - date-time stays `String`.
- Hand ports with shared vectors (`protocol-json/vectors/*.json`, 974 cases, expected values taken from the TS functions): `resolve_tool_policy`, `canonical_repo`, `is_canonical_remote`, `cli_version_at_least` (an ICU `localeCompare` numeric port for the pre-release grammar), `capability_key(s)`, `daemon_auth_header_value`, `json_byte_length` (ryu-js numbers). Rust runs them in `tests/vectors.rs`, vitest in `packages/shared/src/protocol/protocol-json.test.ts`.
- Round trip: `tests/roundtrip.rs` parses and re-serialises every fixture, compares it canonically, and compares the committed goldens `protocol-json/roundtrip/` (87). vitest parses each golden with zod and checks it `toEqual`s the fixture.
- `scripts/ci.sh` step `protocol drift`: re-emit + regenerate, `git diff --exit-code`, and fail on untracked files. Shown failing on a deliberate unregenerated `HeartbeatPayloadSchema` edit, then reverted.

## Agents dispatched
| Agent | Task | Branch | Result (PASS / FAIL / partial) |
|---|---|---|---|
| — | — | — | — |

## Tracking changes
- Unknowns raised / resolved: none
- Blockers raised / cleared: none
- Tech debt added / paid: TD-196 (refines and literals not enforced in Rust), TD-197 (localeCompare port), TD-198 (char vs UTF-16 length caps)
- ADRs: none (ADR-0026 §2 as written)
- Unfinished handoffs written: none

## Next session should start with
- MR-T05/T06 use `conductor_protocol::*`. Not ported yet: `isAbsolutePath` and `matchingPaths` (MR-T10/T11). MR-T08 can serve `protocol-json/schemas/CompleteStateInput.json` as the MCP `inputSchema`.
