#!/usr/bin/env bash
# Build the self-contained daemon tarball the orchestrator serves (M2-T14; ADR-0017 §Daemon
# distribution):
#
#   packages/orchestrator/scripts/build-daemon-tarball.sh [--no-verify] [out-dir]
#
# Writes <out-dir>/conductor-daemon-<version>.tgz and .tgz.sha256 (default out-dir:
# packages/orchestrator/dist/downloads) and removes any older build there, so exactly one is
# served. <version> is the daemon package version plus `+<sha>`, the same form as the daemon's
# `daemonVersion()`: the sha is CONDUCTOR_BUILD_SHA, else `git rev-parse --short=7 HEAD`, cut to
# 7 characters; empty or `unknown` means none. The tarball is flat (./bin, ./dist,
# ./node_modules, ./package.json); its entries are bin/conductor-daemon (sh) and
# bin/conductor-daemon.cmd (Windows, MW-T11), which run `node dist/main.js` with
# CONDUCTOR_BUILD_SHA set. node_modules is hoisted and holds no symlinks: Windows tar.exe can't
# create them without Developer Mode, so one tarball serves every OS. Needs node, pnpm and the installed
# workspace; no Docker. Unless --no-verify, the result is unpacked into an empty directory and
# `bin/conductor-daemon --help` must run with only Node on PATH.
set -euo pipefail

verify=1
if [[ "${1:-}" == "--no-verify" ]]; then
  verify=0
  shift
fi
pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$pkg_dir/../.." && pwd)"
out="${1:-$pkg_dir/dist/downloads}"

cd "$repo"
# Incremental; builds @conductor/shared through the project references.
pnpm exec tsc -b packages/daemon

base="$(node -p "require('./packages/daemon/package.json').version")"
sha="${CONDUCTOR_BUILD_SHA-}"
if [[ -z "$sha" ]]; then
  sha="$(git -C "$repo" rev-parse --short=7 HEAD 2>/dev/null || true)"
fi
[[ "$sha" == unknown ]] && sha=""
sha="${sha:0:7}"
if [[ -n "$sha" && ! "$sha" =~ ^[0-9A-Za-z]+$ ]]; then
  echo "build-daemon-tarball: CONDUCTOR_BUILD_SHA=$sha is not alphanumeric" >&2
  exit 2
fi
version="$base${sha:++$sha}"
file="conductor-daemon-$version.tgz"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/pkg"

# pnpm 10 without inject-workspace-packages needs --legacy to deploy a workspace package (same as
# the orchestrator in the Dockerfile): production deps only, @conductor/shared copied, not linked.
# The hoisted linker gives an npm-style flat node_modules of real directories (no symlinks).
pnpm --filter @conductor/daemon --prod --config.node-linker=hoisted deploy --legacy "$pkg" >/dev/null

# node_modules/.bin holds the only symlinks; .pnpm holds only pnpm's lock file.
rm -rf "$pkg/src" "$pkg/test" "$pkg/node_modules/.bin" "$pkg/node_modules/.modules.yaml" \
  "$pkg/node_modules/.pnpm"
find "$pkg" \( -name '*.test.*' -o -name '*.tsbuildinfo' -o -name 'tsconfig*.json' \) \
  -not -path '*/node_modules/*' -exec rm -rf {} +
for f in dist/main.js package.json node_modules/@conductor/shared/dist/index.js; do
  if [[ ! -f "$pkg/$f" ]]; then
    echo "build-daemon-tarball: $f is missing from the deployed daemon" >&2
    exit 1
  fi
done

mkdir -p "$pkg/bin"
{
  cat <<'EOF'
#!/bin/sh
# conductor-daemon entry (built by packages/orchestrator/scripts/build-daemon-tarball.sh).
set -e
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
EOF
  if [[ -n "$sha" ]]; then
    printf ': "${CONDUCTOR_BUILD_SHA:=%s}"\nexport CONDUCTOR_BUILD_SHA\n' "$sha"
  fi
  echo 'exec node "$here/dist/main.js" "$@"'
} >"$pkg/bin/conductor-daemon"
chmod 755 "$pkg/bin/conductor-daemon"
# The Windows entry: the same, as a batch file with CRLF line ends (cmd.exe misreads bare LF).
sed -e "s/@@BUILD_SHA@@/$sha/" -e 's/$/\r/' "$pkg_dir/assets/conductor-daemon.cmd.tmpl" \
  >"$pkg/bin/conductor-daemon.cmd"

# No symlinks at all: Windows can't unpack them (and none may point back into the workspace).
links="$(find "$pkg" -type l | head -5)"
if [[ -n "$links" ]]; then
  echo "build-daemon-tarball: the package holds symlinks, which Windows tar.exe can't unpack:" >&2
  echo "$links" >&2
  exit 1
fi

mkdir -p "$out"
rm -f "$out"/conductor-daemon-*.tgz "$out"/conductor-daemon-*.tgz.sha256
tar -C "$pkg" -czf "$out/$file" .
if command -v shasum >/dev/null 2>&1; then
  hex="$(shasum -a 256 "$out/$file" | cut -d' ' -f1)"
else
  hex="$(sha256sum "$out/$file" | cut -d' ' -f1)"
fi
printf '%s  %s\n' "$hex" "$file" >"$out/$file.sha256"

if [[ "$verify" == 1 ]]; then
  check="$stage/check"
  mkdir -p "$check/x" "$check/pathbin" "$check/cwd"
  tar -C "$check/x" -xzf "$out/$file"
  ln -s "$(command -v node)" "$check/pathbin/node"
  help="$(cd "$check/cwd" && env -i HOME="$check" PATH="$check/pathbin:/usr/bin:/bin" \
    "$check/x/bin/conductor-daemon" --help)"
  if [[ "$help" != *"usage: conductor-daemon"* ]]; then
    echo "build-daemon-tarball: bin/conductor-daemon --help failed from the unpacked tarball" >&2
    exit 1
  fi
fi

echo "built $out/$file"
echo "version $version"
echo "sha256 $hex"
