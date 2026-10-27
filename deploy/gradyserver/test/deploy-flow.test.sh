#!/usr/bin/env bash
# End-to-end run of deploy.sh + remote-deploy.sh with fake `ssh` and `docker` on PATH (M2-T07 QA).
# The fake ssh runs the command locally under a scratch HOME (stdin from /dev/null with -n, like
# the real one). The fake `docker compose run` reads stdin like the real one does, so a server
# half fed through stdin would be swallowed and fail these checks.
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "deploy-flow.test.sh"

for tool in git tar openssl; do
  command -v "$tool" >/dev/null || {
    echo "  skip  deploy flow ($tool not installed)"
    finish
    exit
  }
done

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home" "$T/state" "$T/repo/deploy"

cat >"$T/bin/ssh" <<'SSH'
#!/usr/bin/env bash
# Fake ssh: [-n] [-p PORT] HOST COMMAND...; runs COMMAND locally with HOME=$FAKE_HOME.
n=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) n=1; shift ;;
    -p) shift 2 ;;
    *) break ;;
  esac
done
shift # host
if [[ "$n" -eq 1 ]]; then
  HOME="$FAKE_HOME" exec bash -c "$*" </dev/null
fi
HOME="$FAKE_HOME" exec bash -c "$*"
SSH

cat >"$T/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
# Fake docker: records calls in $FAKE_STATE/calls and keeps the orchestrator's image in
# $FAKE_STATE/orch_image.
S="$FAKE_STATE"
echo "docker $*" >>"$S/calls"
if [[ "$1" == compose ]]; then
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -p | -f | --env-file) shift 2 ;;
      *) break ;;
    esac
  done
  sub="$1"
  shift
  last="${*: -1}"
  case "$sub" in
    up)
      [[ "$last" == postgres ]] && touch "$S/pg"
      if [[ "$last" == orchestrator && -z "${FAKE_UP_NOOP:-}" ]]; then
        echo "conductor-orchestrator:$CONDUCTOR_GIT_SHA" >"$S/orch_image"
      fi
      ;;
    ps)
      case "$last" in
        postgres) [[ -e "$S/pg" ]] && echo c-postgres ;;
        orchestrator) [[ -e "$S/orch_image" ]] && echo c-orchestrator ;;
      esac
      ;;
    run)
      # Like `docker compose run`: whatever is on stdin gets consumed.
      wc -c | tr -d ' ' >"$S/migrate_stdin_bytes"
      exit "${FAKE_MIGRATE_RC:-0}"
      ;;
    logs) echo "fake logs for $last" ;;
  esac
  exit 0
fi
case "$1" in
  inspect)
    fmt="$3"
    case "$fmt" in
      image=*) echo "image=$(cat "$S/orch_image") health=healthy" ;;
      '{{.Config.Image}}') cat "$S/orch_image" ;;
      *Health*) echo healthy ;;
    esac
    ;;
  ps) [[ -e "$S/orch_image" ]] && echo c-orchestrator ;;
esac
exit 0
DOCKER
chmod +x "$T/bin/ssh" "$T/bin/docker"

cp -R "$KIT" "$T/repo/deploy/gradyserver"
g() { git -C "$T/repo" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false "$@"; }
g init -q
commit() {
  echo "$1" >"$T/repo/marker"
  g add -A
  g commit -q -m "$1"
  g rev-parse HEAD
}

# deploy [ENV=VALUE...]: runs deploy.sh HEAD --no-smoke; sets OUT and CODE.
deploy() {
  OUT="$(cd "$T/repo" && env PATH="$T/bin:$PATH" FAKE_HOME="$T/home" FAKE_STATE="$T/state" \
    DEPLOY_HEALTH_TIMEOUT=5 "$@" deploy/gradyserver/deploy.sh HEAD --no-smoke 2>&1)"
  CODE=$?
}
ROOT="$T/home/deploy/conductor"
calls_line() { grep -nE -- "$1" "$T/state/calls" | tail -n 1 | cut -d: -f1; }
lt() { [[ -n "$1" && -n "$2" && "$1" -lt "$2" ]]; }

# 1. A good deploy replaces the orchestrator and switches current / current.env.
sha1="$(commit one)"
deploy
check "good deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "good deploy prints 'deployed <sha>'" has "$OUT" "^==> deployed $sha1\$"
check "good deploy verified the running orchestrator" has "$OUT" "running orchestrator: conductor-orchestrator:$sha1, healthy"
check "migrate read nothing from stdin" test "$(cat "$T/state/migrate_stdin_bytes" 2>/dev/null)" = 0
check "orchestrator runs the new image" test "$(cat "$T/state/orch_image")" = "conductor-orchestrator:$sha1"
check "current -> releases/<sha>" test "$(readlink "$ROOT/current")" = "releases/$sha1"
check "current.env names the sha" test "$(cat "$ROOT/current.env")" = "CONDUCTOR_GIT_SHA=$sha1"
check ".env created with a password, mode 0600" grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{64}$' "$ROOT/.env"
check ".env mode 0600" test "$(ls -l "$ROOT/.env" | cut -c1-10)" = '-rw-------'
c_build="$(calls_line 'compose .* build$')"
c_pg="$(calls_line 'compose .* up -d postgres$')"
c_migrate="$(calls_line 'compose .* run --rm -T migrate$')"
c_orch="$(calls_line 'compose .* up -d --no-deps orchestrator$')"
check "calls: build < postgres < migrate < orchestrator" \
  bash -c "[[ -n '$c_build' && '$c_build' -lt '$c_pg' && '$c_pg' -lt '$c_migrate' && '$c_migrate' -lt '$c_orch' ]]"
password="$(grep '^POSTGRES_PASSWORD=' "$ROOT/.env")"

# 2. A failed migration leaves the old orchestrator and current untouched.
: >"$T/state/calls"
sha2="$(commit two)"
deploy FAKE_MIGRATE_RC=1
check "failed migration exits 1 (got $CODE)" test "$CODE" -eq 1
check "failed migration says the previous orchestrator is still running" \
  has "$OUT" 'migration failed — the previous orchestrator is still running'
check "failed migration never touches the orchestrator" \
  test -z "$(grep -E 'up .*orchestrator' "$T/state/calls")"
check "failed migration: orchestrator still on the old image" \
  test "$(cat "$T/state/orch_image")" = "conductor-orchestrator:$sha1"
check "failed migration: current unchanged" test "$(readlink "$ROOT/current")" = "releases/$sha1"
check "failed migration: current.env unchanged" test "$(cat "$ROOT/current.env")" = "CONDUCTOR_GIT_SHA=$sha1"
check "failed migration: no 'deployed'" lacks "$OUT" '^==> deployed'
check ".env never overwritten" grep -qxF "$password" "$ROOT/.env"

# 3. An orchestrator that isn't replaced (stale) can't pass as deployed.
: >"$T/state/calls"
deploy FAKE_UP_NOOP=1
check "stale orchestrator exits 1 (got $CODE)" test "$CODE" -eq 1
check "stale orchestrator is named" has "$OUT" "running orchestrator is conductor-orchestrator:$sha1, not conductor-orchestrator:$sha2"
check "stale orchestrator: current unchanged" test "$(readlink "$ROOT/current")" = "releases/$sha1"
check "stale orchestrator: no 'deployed'" lacks "$OUT" '^==> deployed'

# 4. The same sha deploys after the failures once things are fixed.
deploy
check "retry of the sha succeeds (got $CODE)" test "$CODE" -eq 0
check "retry: current -> the new release" test "$(readlink "$ROOT/current")" = "releases/$sha2"

finish
