# Known-flaky tests (quarantine)

Tests that fail intermittently, or already fail on `main`, through no fault of the branch that hits them. A test listed here is **quarantined**:

- **Out of the gate.** A listed TypeScript file is excluded from its package's vitest project, so `pnpm test` / `pnpm test:all` don't run it. A listed Rust test carries `#[ignore = "flaky: see FLAKY.md"]`, so `cargo nextest run` / `cargo test` skip it.
- **Still run nightly.** `.github/workflows/quarantine.yml` (a schedule, plus workflow_dispatch) runs every quarantined test without retries and writes a report, one line per row, to the run's summary.
- **Run locally**: `pnpm vitest --project quarantine` (or `pnpm test:quarantine`; retries twice, `CONDUCTOR_QUARANTINE_RETRY=0` for none) and `cargo test -p conductor-daemon -- --ignored`.

This file is read by `vitest.config.ts`, `scripts/test-flaky.js` and the nightly workflow: the table below **is** the quarantine list. `scripts/test-flaky.test.js` (in the gate) checks that every row's file exists and that the Rust `#[ignore]` markers match the rows.

## For agents

- A failing check whose test is listed here is not your failure: rerun only the failed job, once (`gh run rerun <run-id> --failed`). Don't ask Ben about it.
- A job cancelled before a runner was ever assigned (conductor reports it as `infrastructure, not a test failure`) is not a test failure either: rerun it.
- This file is the one `docs/tracking/` file a ticket branch edits: add a row when you quarantine a test, delete it in the PR that fixes the test.

## The rule

**A row past its fix-by date gets fixed or deleted.** Either fix the test and delete its row in the same PR, or delete the test (and its row). A fix-by date is never extended without a new owner ticket. The nightly report flags overdue rows; the gate never fails on them.

## Adding a row

- **TypeScript**: list the test file. If only one case of a large file flakes, move that case into a sibling file first (e.g. `markdown-io.large.test.ts`) and list that, so the rest stays in the gate.
- **Rust**: put `#[ignore = "flaky: see FLAKY.md"]` on each test fn in the file, and list the file. The `Test` column is the nextest name filter the nightly uses (a module path such as `daemon::tests::kill_real`).
- `Rounds caused` counts the rework rounds the flake cost tickets; `Fix by` is `YYYY-MM-DD`.

<!-- flaky:start -->

| Test                                                                       | File                                                                  | First seen | Rounds caused                                    | Owner ticket | Fix by     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- | ------------------------------------------------ | ------------ | ---------- |
| `SetupGuide.test.tsx:39` (`findBy*` timeout under load, TD-186; whole file) | `packages/web/src/onboarding/SetupGuide.test.tsx`                     | 2026-10-28 | ≥1 (tickets 2e5b8626, d0f8e9aa; ~15 across all)  | WF-T10       | 2026-11-18 |
| `apply.property` coverage assertion (TD-163)                               | `packages/shared/src/engine/apply.property.test.ts`                   | 2026-10-27 | ≥1 (tickets 0ca2aa8b, af5d64b6; ~15 across all)  | WF-T06       | 2026-11-18 |
| `daemon::tests::kill_real` (MR-T12)                                        | `crates/conductor-daemon/src/daemon/tests/kill_real.rs`               | 2026-11-01 | ≥1 (~15 across all)                              | WF-T07       | 2026-11-18 |
| `markdown-io.test.ts:208` (2,000-requirement round-trip timing)            | `packages/web/src/components/ticket-editor/markdown-io.large.test.ts` | 2026-10-28 | ≥1 (TD-186; ~15 across all)                      | WF-T11       | 2026-11-18 |
| `distribution-tarball.test.ts` (package-daemon.sh)                         | `packages/orchestrator/test/distribution-tarball.test.ts`             | 2026-11-04 | ≥2 (ticket 9d21b3db asked Ben twice)             | none yet     | 2026-11-18 |

<!-- flaky:end -->
