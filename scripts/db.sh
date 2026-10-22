#!/usr/bin/env bash
# Local Postgres 16 for development and tests.
#
#   scripts/db.sh up       start Postgres on localhost:54329 (idempotent, safe to run concurrently)
#   scripts/db.sh down     stop it (data is kept; this stops it for EVERY worktree)
#   scripts/db.sh migrate  apply migrations (node-pg-migrate) to $DATABASE_URL
#   scripts/db.sh status   report whether the server is reachable (exit 1 if not)
#   scripts/db.sh url      print the resolved DATABASE_URL
#
# Uses docker-compose when `docker info` succeeds. Otherwise it runs ONE shared Homebrew
# postgresql@16 cluster (U-020) whose data dir lives outside any worktree:
#   ${CONDUCTOR_PGDATA:-${XDG_DATA_HOME:-~/.local/share}/conductor/pgdata}
# Every worktree talks to that same cluster; tests isolate themselves by creating their
# own database (packages/orchestrator/test/db.ts), never by starting another cluster.
# Override the binaries location with PG_BIN.
#
# DATABASE_URL resolution (U-021), shared with vitest.config.ts:
#   process env  >  .env  >  .env.example
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=54329
DB_USER=conductor
DB_NAME=conductor
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/conductor"
PGDATA_DIR="${CONDUCTOR_PGDATA:-$DATA_HOME/pgdata}"
LOCK_DIR="$(dirname "$PGDATA_DIR")/db.lock"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"

load_env() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    local file
    for file in "$ROOT/.env" "$ROOT/.env.example"; do
      if [[ -f "$file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$file"
        set +a
        break
      fi
    done
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

# Accepting connections on the shared port, whoever started it.
server_ready() {
  "$PG_BIN/pg_isready" -q -h localhost -p "$PORT" >/dev/null 2>&1
}

# Cross-worktree mutex. macOS has no flock(1), so use an atomic mkdir; a lock whose
# owner pid is gone is stale and gets broken.
release_lock() { rm -rf "$LOCK_DIR"; }
acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  local waited=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    local owner
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
      echo "db.sh: breaking stale lock held by pid $owner" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
    if ((waited >= 600)); then
      echo "db.sh: timed out after 60s waiting for $LOCK_DIR" >&2
      exit 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  echo $$ >"$LOCK_DIR/pid"
  trap release_lock EXIT
}

app_db_exists() {
  "$PG_BIN/psql" -h localhost -p "$PORT" -U "$DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null | grep -q 1
}

# Called under the lock, so concurrent callers can't race on createdb.
ensure_app_db() {
  if ! app_db_exists; then
    "$PG_BIN/createdb" -h localhost -p "$PORT" -U "$DB_USER" "$DB_NAME"
    echo "db.sh: created database $DB_NAME"
  fi
}

up_local() {
  require_pg_bin
  # Fast path: already up (from this or any other worktree). No lock needed.
  if server_ready && app_db_exists; then
    echo "db.sh: Postgres already running on localhost:$PORT"
    return
  fi
  acquire_lock
  # Re-check under the lock: another worktree may have started it while we waited.
  if server_ready; then
    echo "db.sh: Postgres already running on localhost:$PORT"
  else
    if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
      echo "db.sh: initdb into $PGDATA_DIR"
      mkdir -p "$(dirname "$PGDATA_DIR")"
      "$PG_BIN/initdb" -D "$PGDATA_DIR" -U "$DB_USER" --auth=trust --encoding=UTF8 --no-locale >/dev/null
    fi
    # TCP only: unix sockets stay disabled so a long CONDUCTOR_PGDATA can't hit the
    # ~103-byte macOS socket path limit. max_connections covers several worktrees'
    # test pools at once.
    if "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories='' -c max_connections=200" \
      start >/dev/null; then
      echo "db.sh: Postgres started on localhost:$PORT (data: $PGDATA_DIR, log: server.log there)"
    elif server_ready; then
      # Lost a (rare) race with another starter; the cluster is up, which is all we need.
      echo "db.sh: Postgres already running on localhost:$PORT"
    else
      echo "db.sh: pg_ctl start failed; see $PGDATA_DIR/server.log" >&2
      exit 1
    fi
  fi
  ensure_app_db
}

down_local() {
  require_pg_bin
  acquire_lock
  if [[ -f "$PGDATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null
    echo "db.sh: Postgres stopped (shared by all worktrees)"
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
    elif server_ready; then
      echo "db.sh: running (localhost:$PORT, data: $PGDATA_DIR)"
    else
      echo "db.sh: not running"
      exit 1
    fi
    ;;
  url)
    load_env
    echo "$DATABASE_URL"
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
    echo "usage: scripts/db.sh {up|down|status|url|migrate [up|down|create <name>] [args...]}" >&2
    exit 2
    ;;
esac
