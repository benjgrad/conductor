#!/usr/bin/env bash
# Server half of deploy.sh (M2-T07). Runs on gradyserver as bengrady4, from the release being
# deployed (it arrives with the git archive):
#
#   bash ~/deploy/conductor/releases/<sha>/deploy/gradyserver/remote-deploy.sh <deploy-dir> <sha> <timeout>
#
# deploy.sh starts it with `ssh -n`, so stdin is /dev/null and no command here can swallow the
# script. Every docker / compose call also gets </dev/null (and `run` gets -T), so nothing can
# read stdin even when this is run by hand from a terminal.
#
# Steps: build → up -d postgres (healthy) → run --rm -T migrate (the migration gate; nothing has
# touched the running orchestrator yet) → up -d --no-deps orchestrator (healthy, running the new
# image) → `current` and current.env switch to the release → keep the last 5 releases.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <deploy-dir> <sha> <timeout-seconds>" >&2
  exit 2
fi
DEPLOY_DIR="$1" SHA="$2" TIMEOUT="$3"
REL="releases/$SHA"
IMAGE="conductor-orchestrator:$SHA"
cd "$HOME/$DEPLOY_DIR"

step() { echo "==> $*"; }
die() {
  echo "!!> $*" >&2
  exit 1
}

compose() {
  CONDUCTOR_GIT_SHA="$SHA" docker compose -p conductor \
    -f "$REL/deploy/gradyserver/compose.yml" --env-file .env "$@"
}

# wait_healthy <service>: returns 0 once the service's container reports healthy, 1 on timeout.
wait_healthy() {
  local svc="$1" id health="" deadline=$((SECONDS + TIMEOUT))
  step "waiting up to ${TIMEOUT}s for $svc to be healthy"
  while ((SECONDS < deadline)); do
    id="$(compose ps -q "$svc" </dev/null 2>/dev/null || true)"
    health=""
    if [[ -n "$id" ]]; then
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" </dev/null 2>/dev/null || true)"
    fi
    if [[ "$health" == healthy ]]; then
      step "$svc healthy"
      return 0
    fi
    sleep 3
  done
  echo "!!> $svc not healthy after ${TIMEOUT}s (health: ${health:-none})" >&2
  return 1
}

[[ -f "$REL/deploy/gradyserver/compose.yml" ]] || die "$REL has no deploy/gradyserver/compose.yml"

# .env: generated on the first deploy and checked step by step (TD-144). Every command is checked
# on its own line, never inside a `( … ) || die` subshell or a function called under `||`, where
# set -e is off. The file is written to .env.tmp, verified, and only then renamed; on any failure
# the temp file is removed and no .env exists.
ENV_FILE="$PWD/.env"
if [[ ! -e .env ]]; then
  step "creating .env with a random POSTGRES_PASSWORD (mode 0600)"
  trap 'rm -f .env.tmp' EXIT
  rm -f .env.tmp
  password="$(openssl rand -hex 32)" ||
    die "could not create .env: openssl rand -hex 32 failed; no .env was created"
  [[ "$password" =~ ^[0-9a-f]{64}$ ]] ||
    die "could not create .env: openssl rand -hex 32 did not print 64 hex digits; no .env was created"
  (umask 077 && sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" \
    "$REL/deploy/gradyserver/env.example" >.env.tmp) ||
    die "could not create .env: sed on $REL/deploy/gradyserver/env.example failed; no .env was created"
  unset password
  grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{64}$' .env.tmp ||
    die "could not create .env: the generated file has no POSTGRES_PASSWORD=<64 hex digits>; no .env was created"
  chmod 600 .env.tmp || die "could not create .env: chmod 600 .env.tmp failed; no .env was created"
  mv .env.tmp .env || die "could not create .env: mv .env.tmp .env failed; no .env was created"
  trap - EXIT
else
  step ".env exists; left unchanged"
fi
# An empty .env, or one without a non-empty POSTGRES_PASSWORD (e.g. left by an older, broken
# first deploy), is refused before anything is touched.
grep -qE '^POSTGRES_PASSWORD=.+' .env ||
  die "$ENV_FILE is empty or missing POSTGRES_PASSWORD; remove it to regenerate"
mkdir -p backups logs

step "building the image ($SHA)"
compose build </dev/null ||
  die "image build failed; the previous orchestrator is still running"

step "starting postgres"
compose up -d postgres </dev/null || {
  compose logs --no-color --tail 100 postgres </dev/null >&2 || true
  die "postgres failed to start; the previous orchestrator was not touched"
}
wait_healthy postgres || {
  compose logs --no-color --tail 100 postgres </dev/null >&2 || true
  die "postgres is not healthy; the previous orchestrator was not touched"
}

# The migration gate: a one-shot container, before anything touches the orchestrator. Its output
# streams to this terminal. -T and </dev/null: it must never read stdin.
step "running migrations"
compose run --rm -T migrate </dev/null || {
  echo "!!> migration failed — the previous orchestrator is still running" >&2
  exit 1
}

step "recreating the orchestrator"
compose up -d --no-deps orchestrator </dev/null || {
  compose logs --no-color --tail 100 orchestrator </dev/null >&2 || true
  die "the orchestrator for $SHA failed to start (migrations already applied); roll back by deploying the previous sha"
}
wait_healthy orchestrator || {
  compose logs --no-color --tail 100 orchestrator </dev/null >&2 || true
  die "the orchestrator for $SHA is unhealthy (migrations already applied); current still points at the previous release; roll back by deploying the previous sha"
}
running_image="$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q orchestrator </dev/null)" </dev/null)"
[[ "$running_image" == "$IMAGE" ]] ||
  die "the running orchestrator is $running_image, not $IMAGE; current left unchanged"

# Only now does the release become `current`, and current.env select its image for operator
# commands (runbook `cdc` alias, backup.sh).
ln -sfn "$REL" current
printf 'CONDUCTOR_GIT_SHA=%s\n' "$SHA" >current.env.tmp
mv current.env.tmp current.env
step "current -> $REL; current.env: CONDUCTOR_GIT_SHA=$SHA"

step "keeping the last 5 releases"
keep=5
n=0
# Newest first; `current` counts as one of the five.
while IFS= read -r r; do
  [[ "$r" == *.tmp ]] && continue
  [[ "releases/$r" == "$REL" ]] && continue
  n=$((n + 1))
  if ((n >= keep)); then
    step "removing releases/$r"
    rm -rf "releases/$r"
  fi
done < <(ls -1t releases)
step "remote deploy of $SHA complete"
