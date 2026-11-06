#!/bin/sh
# conductor-launch (ADR-0021 §3): what the launchd agent and the systemd user unit run. It lives in
# <root>/bin, outside every daemon version, and finds <root> from its own path, so the same bytes
# serve any root. Written by `conductor-daemon service install` and by install.sh, both from
# crates/conductor-daemon/assets/conductor-launch.sh. POSIX sh only (dash, macOS /bin/sh).
# conductor-launch: trial-v1
#
# Trial and rollback (MR-T14): a daemon that switched <root>/daemon/current to a new version
# wrote <root>/daemon/trial (from=, to=, attempts=). Each start counts one attempt; past
# UPDATE_MAX_TRIAL_ATTEMPTS (2) the new version failed to start twice, so current goes back to
# `from`, `to` is appended to bad-versions and trial is removed. The new version removes trial
# itself on its first `registered`. The daemon only switches when this file has the marker line
# above, so keep it.
root="$(cd "$(dirname "$0")/.." && pwd -P)"
d="$root/daemon"
t="$d/trial"
if [ -f "$t" ]; then
  from="$(sed -n 's/^from=//p' "$t" | head -n 1)"
  to="$(sed -n 's/^to=//p' "$t" | head -n 1)"
  n="$(sed -n 's/^attempts=//p' "$t" | head -n 1)"
  ok=1
  for v in "$from" "$to"; do
    case "$v" in
      '' | . | .. | *[!0-9A-Za-z.+-]*) ok=0 ;;
    esac
  done
  case "$n" in
    '' | *[!0-9]*) n=0 ;;
  esac
  n=$((n + 1))
  if [ "$ok" = 0 ]; then
    rm -f "$t"
  elif [ "$n" -gt 2 ] && [ -d "$d/$from" ]; then
    link="$d/.current.$$"
    rm -f "$link"
    if ln -s "$from" "$link" &&
      { mv -T "$link" "$d/current" 2>/dev/null || mv -h "$link" "$d/current"; }; then
      echo "$to" >>"$d/bad-versions"
      rm -f "$t"
      echo "conductor-launch: $to failed to start $((n - 1)) times; rolled back to $from" >&2
    else
      rm -f "$link"
    fi
  else
    printf 'from=%s\nto=%s\nattempts=%s\n' "$from" "$to" "$n" >"$t.tmp" && mv -f "$t.tmp" "$t"
  fi
fi
exec "$root/daemon/current/bin/conductor-daemon" run "$@"
