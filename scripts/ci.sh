#!/usr/bin/env bash
# All gates, in order. Fails fast on the first red gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n==> %s\n' "$*"; }

step "install";   pnpm install --frozen-lockfile
# PRs (ci.yml sets CONDUCTOR_CI_TIERED) run the expensive gates only when their diff reaches them:
# the Rust tests (clippy, nextest) and the e2e suite (scripts/ci-affected.js; after install, as it
# parses the lockfile with `yaml`). main, a dispatch and a laptop run everything. daemon-rust.yml
# also runs the cargo gates on a PR that reaches Rust.
rust=true
e2e=true
if [[ "${CONDUCTOR_CI_TIERED:-}" == 1 ]]; then
  step "affected"
  rust="$(node scripts/ci-affected.js rust)"
  e2e="$(node scripts/ci-affected.js e2e)"
  echo "rust tests: $rust, e2e: $e2e"
fi

step "typecheck"; pnpm typecheck
step "lint";      pnpm lint
# Rust (ADR-0026 §6). rustup installs cargo in ~/.cargo/bin, which a non-login shell may not have.
command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
# MR-T03 (ADR-0026 §2): regenerate the protocol JSON and the Rust types from the zod schemas; any
# diff (or new untracked file) means someone changed a schema without regenerating.
step "protocol drift"
pnpm --filter @conductor/shared emit:protocol
cargo run --locked -q -p conductor-protocol-codegen
drift=(packages/shared/protocol-json crates/conductor-protocol/src/generated.rs)
git diff --exit-code -- "${drift[@]}"
if [[ -n "$(git status --porcelain -- "${drift[@]}")" ]]; then
  git status --short -- "${drift[@]}"
  echo "protocol drift: run the two commands above and commit the result" >&2
  exit 1
fi
step "cargo fmt";    cargo fmt --all --check
if [[ "$rust" == true || "$e2e" == true ]]; then
  command -v cargo-nextest >/dev/null || cargo install --locked cargo-nextest
fi
if [[ "$rust" == true ]]; then
  step "cargo clippy"; cargo clippy --workspace --all-targets --locked -- -D warnings
  step "cargo nextest"
  node scripts/test-slot.js cargo nextest run --workspace --locked
else
  step "cargo clippy, cargo nextest: skipped (the diff doesn't reach Rust)"
fi
step "parity";       node scripts/test-parity.js   # crates/conductor-daemon/PARITY.md (ADR-0026 §3)
step "deploy kit"; bash deploy/gradyserver/test/run.sh   # shellcheck only if installed
step "db:up";     pnpm db:up   # shared local cluster; DB tests create their own databases
# PRs run the tiers their diff reaches (M2-T33); main, a dispatch and a laptop run every tier.
if [[ "${CONDUCTOR_CI_TIERED:-}" == 1 ]]; then
  step "test (tiered)"; pnpm test
else
  step "test";      pnpm test:all
fi
step "build";     pnpm build
if [[ "$e2e" == true ]]; then
  # The e2e daemon is the debug binary nextest builds (tests/cli.rs needs the bin), not a release
  # build: that one shares no artifacts with the test build (thin LTO, one codegen unit) and costs
  # ~10 min cold. The release profile is proven by daemon-rust.yml, daemon-dist.yml and the deploy.
  # The test build unifies tokio's `test-util` into the bin; it only adds APIs (paused time), so
  # the daemon behaves the same.
  if [[ "$rust" != true ]]; then
    # Not `cargo build -p conductor-daemon`: without the test targets (dev-dependency features)
    # and the rest of the workspace, features resolve differently and tokio and everything on it
    # recompile. This builds exactly what nextest would, from the cached deps.
    step "daemon (nextest build, no run)"
    node scripts/test-slot.js cargo nextest run --workspace --locked --no-run
  fi
  daemon_bin=target/debug/conductor-daemon
  [[ -x "$daemon_bin" ]] || { echo "ci.sh: $daemon_bin missing after the nextest build" >&2; exit 1; }
  step "test:e2e"   # fake Claude only: CI never spends
  env -u E2E_REAL_CLAUDE CONDUCTOR_E2E_DAEMON_BIN="$daemon_bin" pnpm test:e2e
else
  step "test:e2e: skipped (the diff doesn't reach the e2e stack)"
fi

printf '\nci.sh: all gates passed\n'
