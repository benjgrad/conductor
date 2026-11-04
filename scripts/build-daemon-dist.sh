#!/usr/bin/env bash
# Build the Rust daemon for this machine and package it as the orchestrator serves it (MR-T15):
#
#   scripts/build-daemon-dist.sh [out-dir]
#
# A dev and test helper: CI builds every target (.github/workflows/daemon-dist.yml). The default
# out-dir is packages/orchestrator/dist/downloads, where the orchestrator looks when
# CONDUCTOR_DOWNLOADS_DIR is unset. For a local image, `scripts/build-daemon-dist.sh daemon-dist`
# then `docker build --build-arg DAEMON_DIST_PARTIAL=1 .` (one target instead of five).
#
# CONDUCTOR_BUILD_SHA (else `git rev-parse --short=7 HEAD`) is baked into the binary and names the
# tarball. CARGO_PROFILE (default release) picks the cargo profile.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$repo/packages/orchestrator/dist/downloads}"
profile="${CARGO_PROFILE:-release}"

sha="${CONDUCTOR_BUILD_SHA-}"
if [[ -z "$sha" ]]; then
  sha="$(git -C "$repo" rev-parse --short=7 HEAD 2>/dev/null || true)"
fi
[[ "$sha" == unknown ]] && sha=""
export CONDUCTOR_BUILD_SHA="${sha:0:7}"

target="$(rustc -vV | sed -n 's/^host: //p')"
[[ -n "$target" ]] || {
  echo "build-daemon-dist: rustc -vV printed no host" >&2
  exit 1
}
cd "$repo"
cargo build --locked --profile "$profile" -p conductor-daemon
dir="target/$profile"
[[ "$profile" == dev ]] && dir=target/debug
bin="$dir/conductor-daemon"
[[ "$target" == *-windows-* ]] && bin="$bin.exe"
packages/orchestrator/scripts/package-daemon.sh --verify "$target" "$bin" "$out"
