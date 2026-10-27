#!/usr/bin/env bash
# Deploy a git ref to gradyserver (M2-T07; ADR-0017 §Hosting topology). Run by the lead from a
# checkout; the server needs no GitHub credentials.
#
#   deploy/gradyserver/deploy.sh <git-ref> [--no-smoke]
#
# 1. resolves <git-ref> to a sha and streams `git archive` over ssh into
#    ~/deploy/conductor/releases/<sha> (skipped if that release already exists);
# 2. points ~/deploy/conductor/current at it;
# 3. creates ~/deploy/conductor/.env from env.example with a random POSTGRES_PASSWORD if it does
#    not exist (mode 0600; never overwrites);
# 4. docker compose -p conductor ... up -d --build (the migrate service runs first);
# 5. waits for the orchestrator to be healthy, keeps the last 5 releases;
# 6. runs smoke.sh against $SMOKE_URL (skip with --no-smoke, e.g. before nginx is installed).
#
# Env: DEPLOY_SSH (bengrady4@gradyserver.com), DEPLOY_SSH_PORT (1024),
#      DEPLOY_DIR (deploy/conductor, relative to the remote home), SMOKE_URL
#      (https://conductor.gradyserver.com), DEPLOY_HEALTH_TIMEOUT (180 seconds).
set -euo pipefail

usage() {
  echo "usage: $0 <git-ref> [--no-smoke]" >&2
  exit 2
}

REF=""
SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --no-smoke) SMOKE=0 ;;
    -h | --help) usage ;;
    -*)
      echo "deploy.sh: unknown option: $arg" >&2
      usage
      ;;
    *)
      [[ -z "$REF" ]] || usage
      REF="$arg"
      ;;
  esac
done
[[ -n "$REF" ]] || usage

DEPLOY_SSH="${DEPLOY_SSH:-bengrady4@gradyserver.com}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-1024}"
DEPLOY_DIR="${DEPLOY_DIR:-deploy/conductor}"
SMOKE_URL="${SMOKE_URL:-https://conductor.gradyserver.com}"
DEPLOY_HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { echo "==> $*"; }
remote() { ssh -p "$DEPLOY_SSH_PORT" "$DEPLOY_SSH" "$@"; }

SHA="$(git rev-parse --verify "$REF^{commit}")"
step "deploying $REF = $SHA to $DEPLOY_SSH:~/$DEPLOY_DIR"

# Extract into <sha>.tmp and rename, so a half-copied release is never reused.
step "uploading git archive of $SHA"
git archive --format=tar "$SHA" | remote "set -eu
  d=\"\$HOME/$DEPLOY_DIR/releases/$SHA\"
  if [ -d \"\$d\" ]; then
    cat >/dev/null
    echo \"==> release \$d already exists\"
  else
    rm -rf \"\$d.tmp\"
    mkdir -p \"\$d.tmp\"
    tar -x -C \"\$d.tmp\"
    mv \"\$d.tmp\" \"\$d\"
    echo \"==> unpacked \$d\"
  fi"

step "activating the release and starting the stack"
remote bash -s -- "$DEPLOY_DIR" "$SHA" "$DEPLOY_HEALTH_TIMEOUT" <<'REMOTE'
set -euo pipefail
DEPLOY_DIR="$1" SHA="$2" TIMEOUT="$3"
cd "$HOME/$DEPLOY_DIR"
step() { echo "==> $*"; }

ln -sfn "releases/$SHA" current
step "current -> releases/$SHA"

if [[ ! -e .env ]]; then
  step "creating .env with a random POSTGRES_PASSWORD (mode 0600)"
  (
    umask 077
    password="$(openssl rand -hex 32)"
    sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" \
      current/deploy/gradyserver/env.example >.env.tmp
    mv .env.tmp .env
  )
  chmod 600 .env
else
  step ".env exists; left unchanged"
fi
mkdir -p backups logs

compose() {
  CONDUCTOR_GIT_SHA="$SHA" docker compose -p conductor \
    -f current/deploy/gradyserver/compose.yml --env-file .env "$@"
}

step "docker compose up -d --build"
compose up -d --build --remove-orphans

# Polling, not `up --wait`: the one-shot migrate container exiting trips --wait on some compose
# versions.
step "waiting up to ${TIMEOUT}s for the orchestrator to be healthy"
deadline=$((SECONDS + TIMEOUT))
while :; do
  migrate_id="$(compose ps -a -q migrate)"
  if [[ -n "$migrate_id" ]]; then
    state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$migrate_id")"
    if [[ "$state" == exited* && "$state" != "exited 0" ]]; then
      echo "!!> migrate failed ($state); the previous orchestrator (if any) is still running" >&2
      compose logs --no-color migrate >&2
      exit 1
    fi
  fi
  orch_id="$(compose ps -q orchestrator)"
  health=""
  [[ -n "$orch_id" ]] && health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$orch_id")"
  if [[ "$health" == healthy ]]; then
    step "orchestrator healthy"
    break
  fi
  if ((SECONDS >= deadline)); then
    echo "!!> orchestrator not healthy after ${TIMEOUT}s (health: ${health:-none})" >&2
    compose logs --no-color --tail 100 orchestrator >&2
    exit 1
  fi
  sleep 3
done

step "keeping the last 5 releases"
keep=5
n=0
current_target="$(readlink current)"
# Newest first; `current` counts as one of the five.
while IFS= read -r r; do
  [[ "$r" == *.tmp ]] && continue
  [[ "releases/$r" == "$current_target" ]] && continue
  n=$((n + 1))
  if ((n >= keep)); then
    step "removing releases/$r"
    rm -rf "releases/$r"
  fi
done < <(ls -1t releases)
REMOTE

if [[ "$SMOKE" -eq 1 ]]; then
  step "smoke test against $SMOKE_URL"
  "$HERE/smoke.sh" "$SMOKE_URL"
else
  step "smoke test skipped (--no-smoke)"
fi

step "deployed $SHA"
