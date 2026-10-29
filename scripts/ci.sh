#!/usr/bin/env bash
# All gates, in order. Fails fast on the first red gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install";   pnpm install --frozen-lockfile
step "typecheck"; pnpm typecheck
step "lint";      pnpm lint
# Rust (ADR-0026 §6). rustup installs cargo in ~/.cargo/bin, which a non-login shell may not have.
command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
step "cargo fmt";    cargo fmt --all --check
step "cargo clippy"; cargo clippy --workspace --all-targets --locked -- -D warnings
step "cargo nextest"
command -v cargo-nextest >/dev/null || cargo install --locked cargo-nextest
node scripts/test-slot.js cargo nextest run --workspace --locked
step "parity";       node scripts/test-parity.js   # crates/conductor-daemon/PARITY.md (ADR-0026 §3)
step "deploy kit"; bash deploy/gradyserver/test/run.sh   # shellcheck only if installed
step "db:up";     pnpm db:up   # shared local cluster; DB tests create their own databases
# PRs run the tiers their diff reaches (M2-T33; ci.yml sets CONDUCTOR_CI_TIERED); main, a dispatch
# and a laptop run every tier.
if [[ "${CONDUCTOR_CI_TIERED:-}" == 1 ]]; then
  step "test (tiered)"; pnpm test
else
  step "test";      pnpm test:all
fi
step "build";     pnpm build
step "test:e2e";  env -u E2E_REAL_CLAUDE pnpm test:e2e   # fake Claude only: CI never spends

printf '\nci.sh: all gates passed\n'
