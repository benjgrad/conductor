#!/usr/bin/env bash
# All gates, in order. Fails fast on the first red gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install";   pnpm install --frozen-lockfile
step "typecheck"; pnpm typecheck
step "lint";      pnpm lint
step "deploy kit"; bash deploy/gradyserver/test/run.sh   # shellcheck only if installed
step "db:up";     pnpm db:up   # shared local cluster; DB tests create their own databases
step "test";      pnpm test:all   # every tier (M2-T33)
step "build";     pnpm build
step "test:e2e";  env -u E2E_REAL_CLAUDE pnpm test:e2e   # fake Claude only: CI never spends

printf '\nci.sh: all gates passed\n'
