#!/usr/bin/env bash
# MR-T01 FR-1 harness (local only; needs the dev Postgres and `pnpm i`). Run from the repo root
# or anywhere: it cds there itself.
#
# 1. a throwaway database on the dev server (scripts/db.sh url), migrated
# 2. the real orchestrator (packages/orchestrator/dist/bin.js) in password mode, so the machine
#    credential is really checked on the WS upgrade
# 3. an enrollment token inserted directly (no CLI mints one, and the REST route needs a signed-in
#    user), then a real POST /api/machines/enroll → {machine_id, credential}
# 4. ws-probe: register (protocol 2) → registered → 3 heartbeats → close; then a wrong credential
#    (expects HTTP 401); then the machine row
# Everything is torn down on exit (orchestrator killed, database dropped).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPIKE="$ROOT/spikes/rust-daemon"
PORT="${PROBE_PORT:-7499}"
PG="node $SPIKE/scripts/pg.mjs"
cd "$ROOT"

BASE_URL="${DATABASE_URL:-$(scripts/db.sh url)}"
DB="conductor_spike_rust_$RANDOM$RANDOM"
DB_URL="${BASE_URL%/*}/$DB"
ORCH_PID=""

cleanup() {
  [[ -n "$ORCH_PID" ]] && kill "$ORCH_PID" 2>/dev/null && wait "$ORCH_PID" 2>/dev/null || true
  $PG "$BASE_URL" "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== database $DB"
$PG "$BASE_URL" "CREATE DATABASE $DB" >/dev/null
DATABASE_URL="$DB_URL" pnpm -s db:migrate >/dev/null

echo "== build (tsc -b emits packages/orchestrator/dist)"
pnpm -s typecheck
(cd "$SPIKE" && . "$HOME/.cargo/env" 2>/dev/null; cargo build --release --bin ws-probe -q)

echo "== orchestrator (password mode) on 127.0.0.1:$PORT"
CONDUCTOR_AUTH=password CONDUCTOR_PUBLIC_URL="http://127.0.0.1:$PORT" CONDUCTOR_PORT="$PORT" \
  DATABASE_URL="$DB_URL" node packages/orchestrator/dist/bin.js >"$SPIKE/target/orchestrator.log" 2>&1 &
ORCH_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$PORT/healthz"; echo

echo "== enroll"
TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("base64url"))')"
# LOCAL_ACCOUNT_ID; token_hash = sha256(token) as gateway/enroll.ts hashSecret.
$PG "$DB_URL" "INSERT INTO enrollment_token (account_id, token_hash, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000001', sha256(convert_to(\$1, 'UTF8')), now() + interval '1 hour')" \
  "$TOKEN" >/dev/null
ENROLLED="$(curl -sf -X POST "http://127.0.0.1:$PORT/api/machines/enroll" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"hostname\":\"$(hostname)\",\"os\":\"linux\",\"arch\":\"x64\",\"daemon_version\":\"0.0.0-rust-spike\"}")"
MACHINE_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).machine_id)' "$ENROLLED")"
CREDENTIAL="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).credential)' "$ENROLLED")"
echo "enrolled machine $MACHINE_ID (credential ${#CREDENTIAL} chars, not shown)"

WS_URL="ws://127.0.0.1:$PORT/ws/daemon"
echo "== ws-probe"
"$SPIKE/target/release/ws-probe" --url "$WS_URL" --credential "$CREDENTIAL" --machine-id "$MACHINE_ID" \
  ${PROBE_INTERVAL_MS:+--interval-ms "$PROBE_INTERVAL_MS"}

echo "== ws-probe, wrong credential"
"$SPIKE/target/release/ws-probe" --url "$WS_URL" --credential "not-the-credential" \
  --machine-id "$MACHINE_ID" --expect-401

echo "== machine row"
$PG "$DB_URL" "SELECT id, status, os, arch, daemon_version, last_heartbeat_at FROM machine WHERE id = \$1" \
  "$MACHINE_ID"
echo "run-ws-probe: PASS"
