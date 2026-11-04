#!/bin/sh
# conductor-launch (ADR-0021 §3): what the launchd agent and the systemd user unit run. It lives in
# <root>/bin, outside every daemon version, and finds <root> from its own path, so the same bytes
# serve any root. Written by `conductor-daemon service install` and by install.sh, both from
# packages/daemon/assets/conductor-launch.sh. M2-T18: a plain exec; trial and rollback come later.
root="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$root/daemon/current/bin/conductor-daemon" run "$@"
