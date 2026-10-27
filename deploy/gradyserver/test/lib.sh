#!/usr/bin/env bash
# Shared helpers for the deploy kit's tests (sourced, not run).
# shellcheck disable=SC2034 # KIT and REPO are used by the sourcing scripts.

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$KIT/../.." && pwd)"
PASSES=0
FAILURES=0

pass() {
  PASSES=$((PASSES + 1))
  echo "  ok    $*"
}
failed() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL  $*"
}

# check <message> <command...>: passes when the command succeeds.
check() {
  local msg="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$msg"; else failed "$msg"; fi
}

# has <text> <extended regex>: true if some line of text matches.
has() { grep -qE -- "$2" <<<"$1"; }
lacks() { ! grep -qE -- "$2" <<<"$1"; }

# nginx_block <file> <header regex> [last]: prints the first (or, with `last`, the last)
# `<header> { ... }` block whose opening line matches, by brace counting (comments stripped).
nginx_block() {
  NB_RE="$2" NB_LAST="${3:-}" awk '
    { sub(/#.*/, "") }
    !inside && $0 ~ ENVIRON["NB_RE"] && /\{/ { inside = 1; depth = 0; block = "" }
    inside {
      block = block $0 "\n"
      depth += gsub(/\{/, "{") - gsub(/\}/, "}")
      if (depth == 0) {
        inside = 0
        found = block
        if (ENVIRON["NB_LAST"] != "last") exit
      }
    }
    END { printf "%s", found }
  ' "$1"
}

# yaml_service <file> <name>: prints a top-level compose service block (2-space indent).
yaml_service() {
  awk -v name="$2" '
    $0 ~ "^  " name ":$" { inside = 1; print; next }
    inside && /^  [^ #]/ { exit }
    inside && /^[^ #]/ { exit }
    inside { print }
  ' "$1"
}

finish() {
  echo "  -- $PASSES passed, $FAILURES failed"
  [[ "$FAILURES" -eq 0 ]]
}
