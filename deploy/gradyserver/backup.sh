#!/usr/bin/env bash
# Nightly Postgres dump (M2-T07; ADR-0017 §Hosting topology, U-074: on-host only, 14 days).
# Runs from bengrady4's crontab (install-cron.sh). Writes
# ~/deploy/conductor/backups/conductor-<UTC timestamp>.dump (pg_dump -Fc, mode 0600), deletes
# dumps older than BACKUP_KEEP_DAYS (default 14; read from .env when set there), and exits
# non-zero if the dump is empty.
#
# Env: CONDUCTOR_DEPLOY_ROOT (~/deploy/conductor), BACKUP_KEEP_DAYS.
set -euo pipefail
umask 077

ROOT="${CONDUCTOR_DEPLOY_ROOT:-$HOME/deploy/conductor}"
ENV_FILE="$ROOT/.env"
# Written by deploy.sh after a successful deploy (CONDUCTOR_GIT_SHA): selects the deployed image,
# so compose never resolves conductor-orchestrator:latest.
CURRENT_ENV="$ROOT/current.env"
COMPOSE_FILE="$ROOT/current/deploy/gradyserver/compose.yml"
BACKUPS="$ROOT/backups"

if [[ -z "${BACKUP_KEEP_DAYS:-}" && -r "$ENV_FILE" ]]; then
  BACKUP_KEEP_DAYS="$(sed -n 's/^BACKUP_KEEP_DAYS=\([0-9][0-9]*\)$/\1/p' "$ENV_FILE" | tail -n 1)"
fi
KEEP="${BACKUP_KEEP_DAYS:-14}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || {
  echo "backup.sh: BACKUP_KEEP_DAYS must be a whole number, got '$KEEP'" >&2
  exit 2
}

mkdir -p "$BACKUPS"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUPS/conductor-$ts.dump"
partial="$BACKUPS/.conductor-$ts.dump.partial"
trap 'rm -f "$partial"' EXIT

echo "$(date -u +%FT%TZ) backup.sh: dumping to $out"
docker compose -p conductor -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --env-file "$CURRENT_ENV" \
  exec -T postgres pg_dump -U conductor -Fc conductor >"$partial"

if [[ ! -s "$partial" ]]; then
  echo "backup.sh: pg_dump produced an empty file; no backup written" >&2
  exit 1
fi
mv "$partial" "$out"
echo "$(date -u +%FT%TZ) backup.sh: wrote $out ($(wc -c <"$out" | tr -d ' ') bytes)"

find "$BACKUPS" -maxdepth 1 -name 'conductor-*.dump' -type f -mtime +"$KEEP" -print -delete |
  sed 's/^/backup.sh: deleted /'
