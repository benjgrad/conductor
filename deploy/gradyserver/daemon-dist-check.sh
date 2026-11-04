#!/usr/bin/env bash
# Check a directory of Rust daemon tarballs before a deploy puts it in the image's build context
# (MR-T15; ci-deploy.sh and deploy.sh run it):
#
#   deploy/gradyserver/daemon-dist-check.sh <dir>
#
# Exactly one conductor-daemon-<version>-<target>.tgz per served target, each with a .sha256 that
# matches it, all of one version. Prints the version on success; says what is wrong and exits 1
# otherwise. The Dockerfile's daemon-dist stage checks the same again inside the build.
set -euo pipefail

TARGETS="aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-pc-windows-msvc"

[[ $# -eq 1 ]] || {
  echo "usage: $0 <dir>" >&2
  exit 2
}
dir="$1"
fail() {
  echo "daemon-dist: $*" >&2
  exit 1
}
[[ -d "$dir" ]] || fail "$dir is not a directory"
if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

version=""
for t in $TARGETS; do
  shopt -s nullglob
  files=("$dir"/conductor-daemon-*-"$t".tgz)
  shopt -u nullglob
  [[ ${#files[@]} -eq 1 ]] || fail "expected one build for $t in $dir, found ${#files[@]}"
  f="${files[0]}"
  name="${f##*/}"
  [[ -f "$f.sha256" ]] || fail "$name has no .sha256"
  want="$(cut -d' ' -f1 <"$f.sha256")"
  [[ "$(hash "$f")" == "$want" ]] || fail "$name does not match its .sha256"
  v="${name#conductor-daemon-}"
  v="${v%-"$t".tgz}"
  [[ -z "$version" || "$v" == "$version" ]] || fail "more than one version: $version and $v"
  version="$v"
done
echo "$version"
