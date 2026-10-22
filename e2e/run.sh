#!/usr/bin/env bash
# `pnpm test:e2e` (M1-T10): Postgres up (idempotent), build the orchestrator and daemon bins
# (tsc -b, incremental), then the E2E suite. Extra args go to vitest.
#   E2E_REAL_CLAUDE=1 pnpm test:e2e   the ask/answer scenario against the installed `claude` on
#                                     haiku (spends money; never in CI)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

scripts/db.sh up
pnpm exec tsc -b
exec pnpm exec vitest run --config e2e/vitest.config.ts "$@"
