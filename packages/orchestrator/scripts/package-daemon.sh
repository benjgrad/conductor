#!/usr/bin/env bash
# Package one built Rust daemon binary as the tarball the orchestrator serves for its target
# (MR-T15; ADR-0026 §4, ADR-0017 §Daemon distribution):
#
#   packages/orchestrator/scripts/package-daemon.sh [--verify] <target> <binary> <out-dir>
#
# Writes <out-dir>/conductor-daemon-<version>-<target>.tgz and its .tgz.sha256 (`<hex>  <file>`).
# <version> is the Cargo workspace version plus `+<sha>`, the daemon's own `--version` form: the
# sha is CONDUCTOR_BUILD_SHA, else `git rev-parse --short=7 HEAD`, cut to 7 characters; empty or
# `unknown` means none. The binary must have been built with the same CONDUCTOR_BUILD_SHA in its
# environment (it bakes the sha in; config.rs `daemon_version`). Inside the tarball:
#   bin/conductor-daemon            the binary (Windows: bin/conductor-daemon.exe, plus
#                                   bin/conductor-daemon.cmd, assets/conductor-daemon.cmd, CRLF)
#   assets/conductor-launch.sh      the launcher install.sh copies to <root>/bin (ADR-0021 §3)
#   VERSION
# No symlinks (Windows tar.exe can't make them). Older builds of the same target in <out-dir> are
# removed; other targets' are left alone, so one out-dir collects every target. With --verify (the
# host's own target only) the tarball is unpacked into an empty dir and `bin/conductor-daemon
# --version` must print <version> with an empty environment. No cargo, no network.
set -euo pipefail

die() {
  echo "package-daemon: $*" >&2
  exit 2
}

verify=0
if [[ "${1:-}" == "--verify" ]]; then
  verify=1
  shift
fi
[[ $# -eq 3 ]] || die "usage: package-daemon.sh [--verify] <target> <binary> <out-dir>"
target="$1" binary="$2" out="$3"

pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$pkg_dir/../.." && pwd)"

# DAEMON_TARGET_RE (packages/shared/src/machines/update.ts): a lower-case Rust triple.
[[ "$target" =~ ^[0-9a-z_]+(-[0-9a-z_]+){1,3}$ ]] || die "bad target '$target'"
[[ -f "$binary" ]] || die "no binary at $binary"

base="$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version *= *"\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)"
[[ -n "$base" ]] || die "no [workspace.package] version in $repo/Cargo.toml"
sha="${CONDUCTOR_BUILD_SHA-}"
if [[ -z "$sha" ]]; then
  sha="$(git -C "$repo" rev-parse --short=7 HEAD 2>/dev/null || true)"
fi
[[ "$sha" == unknown ]] && sha=""
sha="${sha:0:7}"
[[ -z "$sha" || "$sha" =~ ^[0-9A-Za-z]+$ ]] || die "CONDUCTOR_BUILD_SHA=$sha is not alphanumeric"
version="$base${sha:++$sha}"
# DAEMON_VERSION_RE and DAEMON_TARBALL_RE.
[[ "$version" =~ ^[0-9A-Za-z.+-]{1,64}$ ]] || die "bad version '$version'"
file="conductor-daemon-$version-$target.tgz"
[[ "$file" =~ ^conductor-daemon-[0-9A-Za-z._+-]{1,128}\.tgz$ ]] || die "bad tarball name '$file'"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/pkg"
mkdir -p "$pkg/bin" "$pkg/assets"
if [[ "$target" == *-windows-* ]]; then
  exe=conductor-daemon.exe
  cp "$binary" "$pkg/bin/$exe"
  # cmd.exe misreads bare LF line ends.
  sed -e 's/\r$//' -e 's/$/\r/' "$pkg_dir/assets/conductor-daemon.cmd" >"$pkg/bin/conductor-daemon.cmd"
else
  exe=conductor-daemon
  cp "$binary" "$pkg/bin/$exe"
fi
chmod 755 "$pkg/bin/$exe"
cp "$repo/crates/conductor-daemon/assets/conductor-launch.sh" "$pkg/assets/conductor-launch.sh"
chmod 755 "$pkg/assets/conductor-launch.sh"
printf '%s\n' "$version" >"$pkg/VERSION"

links="$(find "$pkg" -type l | head -5)"
[[ -z "$links" ]] || die "the package holds symlinks, which Windows tar.exe can't unpack: $links"

mkdir -p "$out"
tmp_out="$out/.$file.$$"
tar -C "$pkg" -czf "$tmp_out" .
size="$(wc -c <"$tmp_out" | tr -d ' ')"
# DAEMON_TARBALL_MAX_BYTES (100 MB).
((size <= 104857600)) || {
  rm -f "$tmp_out"
  die "$file is $size bytes, over the 100 MB cap"
}
if command -v shasum >/dev/null 2>&1; then
  hex="$(shasum -a 256 "$tmp_out" | cut -d' ' -f1)"
else
  hex="$(sha256sum "$tmp_out" | cut -d' ' -f1)"
fi
for old in "$out"/conductor-daemon-*-"$target".tgz; do
  [[ -e "$old" && "$old" != "$out/$file" ]] && rm -f "$old" "$old.sha256"
done
mv -f "$tmp_out" "$out/$file"
printf '%s  %s\n' "$hex" "$file" >"$out/$file.sha256"

if [[ "$verify" == 1 ]]; then
  check="$stage/check"
  mkdir -p "$check/x" "$check/cwd"
  tar -C "$check/x" -xzf "$out/$file"
  got="$(cd "$check/cwd" && env -i HOME="$check" PATH=/usr/bin:/bin "$check/x/bin/$exe" --version)" ||
    die "bin/$exe --version failed from the unpacked tarball"
  got="${got%$'\r'}"
  [[ "$got" == "$version" ]] ||
    die "bin/$exe --version printed '$got', not '$version' (was it built with CONDUCTOR_BUILD_SHA=$sha?)"
fi

echo "built $out/$file"
echo "version $version"
echo "sha256 $hex"
