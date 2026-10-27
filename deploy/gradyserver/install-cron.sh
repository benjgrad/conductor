#!/usr/bin/env bash
# Adds (or replaces) the nightly backup.sh line in the current user's crontab (M2-T07). Run as
# bengrady4 on gradyserver, never as root. Idempotent: the line is tagged `# conductor-backup` and
# any earlier tagged line is replaced.
#
# Env: CONDUCTOR_DEPLOY_ROOT (~/deploy/conductor), BACKUP_CRON_SCHEDULE ("17 3 * * *", UTC on
# gradyserver).
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "install-cron.sh: run as the deploy user (bengrady4), not root" >&2
  exit 1
fi

ROOT="${CONDUCTOR_DEPLOY_ROOT:-$HOME/deploy/conductor}"
SCHEDULE="${BACKUP_CRON_SCHEDULE:-17 3 * * *}"
TAG="# conductor-backup"
LINE="$SCHEDULE $ROOT/current/deploy/gradyserver/backup.sh >> $ROOT/logs/backup.log 2>&1 $TAG"

mkdir -p "$ROOT/logs"
{
  crontab -l 2>/dev/null | grep -vF "$TAG" || true
  echo "$LINE"
} | crontab -
echo "==> crontab now has: $LINE"
