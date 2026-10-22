#!/usr/bin/env bash
# Local Postgres 16 for development and tests.
#
#   scripts/db.sh up       start Postgres on localhost:54329 (idempotent)
#   scripts/db.sh down     stop it (data is kept)
#   scripts/db.sh migrate  apply migrations (node-pg-migrate) to $DATABASE_URL
#   scripts/db.sh status   report whether the local server is reachable
#
# Uses docker-compose when `docker info` succeeds. Otherwise it runs a Homebrew
# postgresql@16 cluster in the gitignored .pgdata/ directory (no Docker on Ben's Mac).
# Override the binaries location with PG_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=54329
DB_USER=conductor
DB_NAME=conductor
PGDATA_DIR="$ROOT/.pgdata"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"

load_env() {
  if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
  fi
  export DATABASE_URL="${DATABASE_URL:-postgres://$DB_USER:$DB_USER@localhost:$PORT/$DB_NAME}"
}

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.yml" "$@"
  else
    docker-compose -f "$ROOT/docker-compose.yml" "$@"
  fi
}

require_pg_bin() {
  if [[ ! -x "$PG_BIN/pg_ctl" ]]; then
    echo "db.sh: no Docker runtime and no postgresql@16 binaries at $PG_BIN" >&2
    echo "db.sh: install with 'brew install postgresql@16' or set PG_BIN" >&2
    exit 1
  fi
}

local_running() {
  [[ -f "$PGDATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1
}

up_local() {
  require_pg_bin
  if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
    echo "db.sh: initdb into $PGDATA_DIR"
    "$PG_BIN/initdb" -D "$PGDATA_DIR" -U "$DB_USER" --auth=trust --encoding=UTF8 --no-locale >/dev/null
  fi
  if local_running; then
    echo "db.sh: Postgres already running on localhost:$PORT"
  else
    # TCP only: unix sockets are disabled because worktree paths can exceed the
    # ~103-byte socket path limit on macOS.
    "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories=''" start >/dev/null
    echo "db.sh: Postgres started on localhost:$PORT (log: .pgdata/server.log)"
  fi
  if ! "$PG_BIN/psql" -h localhost -p "$PORT" -U "$DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
    "$PG_BIN/createdb" -h localhost -p "$PORT" -U "$DB_USER" "$DB_NAME"
    echo "db.sh: created database $DB_NAME"
  fi
}

down_local() {
  require_pg_bin
  if local_running; then
    "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null
    echo "db.sh: Postgres stopped"
  else
    echo "db.sh: Postgres not running"
  fi
}

cmd="${1:-}"
case "$cmd" in
  up)
    if have_docker; then
      compose up -d --wait
    else
      up_local
    fi
    ;;
  down)
    if have_docker; then
      compose down
    else
      down_local
    fi
    ;;
  status)
    if have_docker; then
      compose ps
    elif local_running; then
      echo "db.sh: running (local cluster, localhost:$PORT)"
    else
      echo "db.sh: not running"
      exit 1
    fi
    ;;
  migrate)
    load_env
    shift
    direction="${1:-up}"
    [[ $# -gt 0 ]] && shift
    cd "$ROOT/packages/orchestrator"
    exec pnpm exec node-pg-migrate "$direction" --migrations-dir migrations "$@"
    ;;
  *)
    echo "usage: scripts/db.sh {up|down|status|migrate [up|down|create <name>] [args...]}" >&2
    exit 2
    ;;
esac
