#!/usr/bin/env bash
# Deploy a git ref to gradyserver (M2-T07; ADR-0017 §Hosting topology). Run by the lead from a
# checkout; the server needs no GitHub credentials.
#
#   deploy/gradyserver/deploy.sh <git-ref> [--no-smoke]
#
# 1. resolves <git-ref> to a sha and streams `git archive` over ssh into
#    ~/deploy/conductor/releases/<sha> (skipped if that release already exists);
# 2. creates ~/deploy/conductor/.env from env.example with a random POSTGRES_PASSWORD if it does
#    not exist (mode 0600; never overwrites);
# 3. using the new release's compose file: builds the image, starts postgres and waits for it to
#    be healthy, then runs `migrate` as a separate gate. Nothing has touched the running
#    orchestrator yet, so a failed migration leaves it serving (ADR-0012 §Deployment shape);
# 4. recreates only the orchestrator (`up -d --no-deps`) and waits for it to be healthy;
# 5. only then points ~/deploy/conductor/current at the release and writes
#    ~/deploy/conductor/current.env (CONDUCTOR_GIT_SHA=<sha>, used by operator commands and
#    backup.sh), and keeps the last 5 releases;
# 6. runs smoke.sh against $SMOKE_URL (skip with --no-smoke, e.g. before nginx is installed).
# Every step that fails prints its logs and what state the server is left in, and exits 1.
#
# Env: DEPLOY_SSH (bengrady4@gradyserver.com), DEPLOY_SSH_PORT (1024),
#      DEPLOY_DIR (deploy/conductor, relative to the remote home), SMOKE_URL
#      (https://conductor.gradyserver.com), DEPLOY_HEALTH_TIMEOUT (180 seconds, per wait).
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
die() {
  echo "!!> $*" >&2
  exit 1
}
remote() { ssh -p "$DEPLOY_SSH_PORT" "$DEPLOY_SSH" "$@"; }

SHA="$(git rev-parse --verify "$REF^{commit}")" || die "cannot resolve git ref '$REF'"
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
  fi" || die "upload of $SHA failed; nothing on the server was changed"

step "building, migrating and starting $SHA on the server"
remote bash -s -- "$DEPLOY_DIR" "$SHA" "$DEPLOY_HEALTH_TIMEOUT" <<'REMOTE' ||
set -euo pipefail
DEPLOY_DIR="$1" SHA="$2" TIMEOUT="$3"
REL="releases/$SHA"
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
    id="$(compose ps -q "$svc" 2>/dev/null || true)"
    health=""
    if [[ -n "$id" ]]; then
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)"
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

if [[ ! -e .env ]]; then
  step "creating .env with a random POSTGRES_PASSWORD (mode 0600)"
  (
    umask 077
    password="$(openssl rand -hex 32)"
    sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" \
      "$REL/deploy/gradyserver/env.example" >.env.tmp
    mv .env.tmp .env
  ) || die "could not create .env"
  chmod 600 .env
else
  step ".env exists; left unchanged"
fi
mkdir -p backups logs

step "docker compose build ($SHA)"
compose build ||
  die "image build failed; the previous orchestrator is still running"

step "starting postgres"
compose up -d postgres || {
  compose logs --no-color --tail 100 postgres >&2 || true
  die "postgres failed to start; the previous orchestrator was not touched"
}
wait_healthy postgres || {
  compose logs --no-color --tail 100 postgres >&2 || true
  die "postgres is not healthy; the previous orchestrator was not touched"
}

# The migration gate: a one-shot container, before anything touches the orchestrator. Its output
# streams to this terminal.
step "running migrations"
compose run --rm migrate || {
  echo "!!> migration failed — the previous orchestrator is still running" >&2
  exit 1
}

step "recreating the orchestrator"
compose up -d --no-deps orchestrator || {
  compose logs --no-color --tail 100 orchestrator >&2 || true
  die "the orchestrator for $SHA failed to start (migrations already applied); roll back by deploying the previous sha"
}
wait_healthy orchestrator || {
  compose logs --no-color --tail 100 orchestrator >&2 || true
  die "the orchestrator for $SHA is unhealthy (migrations already applied); current still points at the previous release; roll back by deploying the previous sha"
}

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
REMOTE
  die "deploy of $SHA failed on the server (see the messages above)"

if [[ "$SMOKE" -eq 1 ]]; then
  step "smoke test against $SMOKE_URL"
  "$HERE/smoke.sh" "$SMOKE_URL" ||
    die "smoke test failed; $SHA is deployed and current; investigate, or roll back by deploying the previous sha"
else
  step "smoke test skipped (--no-smoke)"
fi

step "deployed $SHA"
