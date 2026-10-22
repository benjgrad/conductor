#!/usr/bin/env bash
# All gates, in order. Fails fast on the first red gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install";   pnpm install --frozen-lockfile
step "typecheck"; pnpm typecheck
step "lint";      pnpm lint
step "db:up";     pnpm db:up   # shared local cluster; DB tests create their own databases
step "test";      pnpm test
step "build";     pnpm build
step "test:e2e";  pnpm test:e2e

printf '\nci.sh: all gates passed\n'
