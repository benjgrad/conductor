# conductor-protocol

The daemon ↔ orchestrator wire protocol for the Rust daemon, generated from the zod schemas in
`packages/shared` ([ADR-0026 §2](../../docs/adr/0026-rust-daemon.md), MR-T03). The zod schemas
are the only source of truth: never edit `src/generated.rs` by hand.

## Pipeline

```text
packages/shared/src/**  ──emit:protocol──▶  packages/shared/protocol-json/  ──codegen──▶  src/generated.rs
   (zod schemas,                              schemas/*.json   (draft-07)
    constants,                                constants.json, tool-policy.json
    protocol/fixtures.ts)                     fixtures/*.json + manifest.json
```

Regenerate after any change to a daemon-facing schema, constant or fixture:

```bash
pnpm --filter @conductor/shared emit:protocol     # tsc -b, then scripts/emit-protocol.ts
cargo run -p conductor-protocol-codegen           # crates/conductor-protocol/build → src/generated.rs
CONDUCTOR_UPDATE_GOLDEN=1 cargo nextest run -p conductor-protocol   # only if a fixture changed
```

`scripts/ci.sh` (step `protocol drift`) runs the first two and fails if anything under
`packages/shared/protocol-json` or `src/generated.rs` changes, or a new file appears.

The generator is its own package (`build/`, `conductor-protocol-codegen`), not an example of this
crate, so it still runs when the checked-in `generated.rs` no longer compiles.

## What is checked, on both sides

| Check | Rust | TypeScript |
|---|---|---|
| Every fixture of `protocol/fixtures.ts` parses, re-serialises and equals the original (sorted keys, `2.0` = `2`) | `tests/roundtrip.rs` | — |
| The Rust output (`protocol-json/roundtrip/*.json`, golden files) parses with the zod schemas and equals the fixture | the goldens must match | `src/protocol/protocol-json.test.ts` |
| Shared vectors (`protocol-json/vectors/*.json`) for `resolveToolPolicy`, `canonicalRepo`, `isCanonicalRemote`, `cliVersionAtLeast`, `capabilityKey(s)`, `daemonAuthHeaderValue`, `jsonByteLength` | `tests/vectors.rs` | `src/protocol/protocol-json.test.ts` |

The vectors are hand-maintained data: add a case when you find a difference, and both sides
must pass it.

## Modules

- `generated` (re-exported at the crate root): every type of `protocol-json/schemas`, the
  constants of `constants.json` (`PROTOCOL_VERSION`, `CLOSE_*`, `close_reason()`, the limits,
  `api_paths`, the RegExp sources) and the tool-policy table (`BASE_TOOL_POLICY`, `TOOL_ALIASES`).
- `parse_daemon_message` / `parse_orchestrator_message`: the TS parsers' counterparts.
- Hand-written ports: `tool_policy`, `repo`, `capabilities`, `auth`, `json`.
- `wire::double_option`: see below.

## Hand-written parts and normalisations (and why)

| What | Why |
|---|---|
| `wire::double_option`, patched by the generator onto every `.nullable().optional()` property (`RegisterPayload.enrollment_token`, `CmdExitEventData.head_sha`) | typify renders them as one `Option` with `skip_serializing_if`, so an explicit `null` (the TS daemon sends `enrollment_token: null` in local mode) would come back absent. A plain optional stays one `Option` that is skipped when `None`, which is absent, as zod expects (the PR #74 spike finding). The generator fails if such a property is in an unnamed object: name it in `emit-protocol.ts`. |
| `format: date-time` is dropped before typify | typify would use `chrono`, which re-serialises `…00.000Z` as `…00Z`. `IsoDateTime` is a `String` newtype checked against zod's pattern. |
| `JsonValue` (zod's recursive `z.json()`) is inlined as `{}` | it becomes `serde_json::Value`, and `JsonObject` a `serde_json::Map`. |
| `uuid` fields are `uuid::Uuid` | type safety. It re-serialises lower-case and also parses the forms `z.uuid()` refuses (no hyphens, braces, urn). Orchestrator ids are lower-case Postgres uuids. |
| Maps are `BTreeMap` | deterministic key order on the wire and in tests. |
| The schemas are emitted with `io: 'input'` | a plain `z.object` then has no `additionalProperties: false`, so serde ignores unknown fields the way zod strips them (forward compatibility). `z.strictObject` (`Condition`) keeps `deny_unknown_fields`. typify puts it on the whole untagged `MergePrResult` enum, so the Rust type also refuses an unknown field on the success variant, which zod would strip. The daemon only builds `MergePrResult`, it never parses one. |
| The WS envelopes are not named definitions | typify only makes `#[serde(tag = "type")]` enums of inline variants; with named variants it fell back to `untagged`, which reads `fetch_transcript` as `no_work`. So the messages are struct variants (`OrchestratorToDaemon::Kill { payload, .. }`) and their payloads are named (`KillPayload`). |

## Known gaps (TD rows)

- **TD-196**: zod `.refine()` checks don't survive JSON Schema, so the generated types don't enforce them:
  `isAbsolutePath` (`AbsolutePath`, `WorkingCopy.repo_path`), `isCanonicalRemote` (`InventoryRepo.remote`, `Capability.repo`),
  the branch-name rule (`InventoryRepo.default_branch`), the permission input and suggestion byte caps,
  `PermissionDecision`'s scope/rule rules, the 5-approval cap, and `DurationSchema > 0`. Literal `const`s
  that are not a tag (`ok: true`, `merged: true`, `review: true`, `require_clean: true`, `method: 'merge'`)
  become plain `bool`/`String`. The daemon has to check these itself where it relies on them (the
  `repo` ports here; `is_absolute_path` is still to be ported, for MR-T11).
- **TD-197**: `cliVersionAtLeast` compares pre-release tags with ICU `localeCompare(…, {numeric: true})`. The port
  (`capabilities::compare_prerelease`) reproduces it for the only grammar `VERSION_RE` admits
  (`[0-9A-Za-z.-]`), checked by the vectors against V8; it isn't a general collation.
- **TD-198**: typify's `minLength`/`maxLength` checks count `char`s; zod counts UTF-16 code units. They differ
  only for characters outside the BMP (emoji), where Rust accepts up to twice as many.
- Integers are `i64` even where zod says non-negative (typify ignores `minimum: 0`); `.positive()` ones are `NonZeroU64`.
