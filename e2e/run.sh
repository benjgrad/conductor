#!/usr/bin/env bash
# `pnpm test:e2e` (M1-T10): Postgres up (idempotent), build the orchestrator bin (tsc -b,
# incremental), build the Rust daemon (MR-T16: `cargo build --release`, incremental), then the E2E
# suite. Extra args go to vitest.
#   CONDUCTOR_E2E_DAEMON_BIN=<path>    run another daemon instead of target/release/conductor-daemon
#                                     (no cargo build), e.g. the TS one, packages/daemon/dist/main.js
#                                     (built by tsc -b), until MR-T18b; scripts/ci.sh passes the
#                                     debug target/debug/conductor-daemon nextest already built
#   E2E_REAL_CLAUDE=1 pnpm test:e2e   the ask/answer scenario against the installed `claude` on
#                                     haiku (spends money; never in CI)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

scripts/db.sh up
pnpm exec tsc -b
if [[ -z "${CONDUCTOR_E2E_DAEMON_BIN:-}" ]]; then
  # rustup installs cargo in ~/.cargo/bin, which a non-login shell may not have (as scripts/ci.sh).
  command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
  cargo build --release --locked -p conductor-daemon
fi
exec pnpm exec vitest run --config e2e/vitest.config.ts "$@"
