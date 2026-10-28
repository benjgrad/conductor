#!/usr/bin/env bash
# Deploy a git ref to gradyserver (M2-T07; ADR-0017 §Hosting topology). Run by the lead from a
# checkout; the server needs no GitHub credentials.
#
#   deploy/gradyserver/deploy.sh <git-ref> [--no-smoke]
#
# 1. resolves <git-ref> to a sha and streams `git archive` over ssh into
#    ~/deploy/conductor/releases/<sha> (skipped if that release already exists);
# 2. creates ~/deploy/conductor/.env from env.example with a random POSTGRES_PASSWORD if it does
#    not exist (mode 0600; never overwrites; a failed generation leaves no .env, and an existing
#    .env without a non-empty POSTGRES_PASSWORD is refused before anything is touched);
# 3. runs remote-deploy.sh from the uploaded release with `ssh -n` (stdin is /dev/null, so no
#    server command can read the script): builds the image, starts postgres and waits for it,
#    runs `migrate` as a separate gate (nothing has touched the running orchestrator yet, so a
#    failed migration leaves it serving, ADR-0012 §Deployment shape), recreates only the
#    orchestrator and waits for it to be healthy, and only then points current at the release and
#    writes current.env (CONDUCTOR_GIT_SHA=<sha>, used by operator commands and backup.sh);
#    keeps the last 5 releases;
# 4. verifies, in a separate ssh call, that exactly one orchestrator is running, healthy, from
#    conductor-orchestrator:<sha>, and that current / current.env name <sha>;
# 5. runs smoke.sh against $SMOKE_URL with SMOKE_EXPECT_SHA=<sha> (skip with --no-smoke, e.g.
#    before nginx is installed).
# Every step that fails prints its logs and what state the server is left in, and exits 1.
#
# Env: DEPLOY_SSH (bengrady4@gradyserver.com), DEPLOY_SSH_PORT (1024),
#      DEPLOY_DIR (deploy/conductor, relative to the remote home), SMOKE_URL
#      (https://conductor.gradyserver.com), DEPLOY_HEALTH_TIMEOUT (180 seconds, per wait).
# SC2029: the ssh wrappers pass a command string built here for the server; that is the point.
# shellcheck disable=SC2029
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
# remote: stdin forwarded (only the git archive upload). remote_n: stdin is /dev/null (ssh -n).
remote() { ssh -p "$DEPLOY_SSH_PORT" "$DEPLOY_SSH" "$@"; }
remote_n() { ssh -n -p "$DEPLOY_SSH_PORT" "$DEPLOY_SSH" "$@"; }

[[ "$DEPLOY_DIR" =~ ^[A-Za-z0-9._/-]+$ ]] || die "DEPLOY_DIR may only contain letters, digits, . _ / -"
[[ "$DEPLOY_HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "DEPLOY_HEALTH_TIMEOUT must be a whole number of seconds"
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

# The server half is a file in the uploaded release, run with remote_n (ssh -n): stdin is
# /dev/null, so no command on the server (e.g. `docker compose run`) can read the script itself.
step "building, migrating and starting $SHA on the server"
remote_n "bash \"\$HOME/$DEPLOY_DIR/releases/$SHA/deploy/gradyserver/remote-deploy.sh\" '$DEPLOY_DIR' '$SHA' '$DEPLOY_HEALTH_TIMEOUT'" ||
  die "deploy of $SHA failed on the server (see the messages above)"

# Independent of remote-deploy.sh's exit code: the RUNNING orchestrator must be the new image and
# healthy, and current / current.env must name the release. A deploy that stopped early can't
# pass as deployed.
step "verifying the running orchestrator is $SHA"
# Each field is printed even if an earlier one fails, so a mismatch shows exactly what is wrong.
verify_out="$(remote_n "cd \"\$HOME/$DEPLOY_DIR\";
  ids=\$(docker ps -q --filter label=com.docker.compose.project=conductor --filter label=com.docker.compose.service=orchestrator);
  echo \"containers=\$(echo \$ids | wc -w | tr -d ' ')\";
  [ -n \"\$ids\" ] && docker inspect -f 'image={{.Config.Image}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' \$ids;
  echo \"current=\$(readlink current)\";
  echo \"current_env=\$(sed -n 's/^CONDUCTOR_GIT_SHA=//p' current.env 2>/dev/null)\"" 2>&1 || true)"
expected="containers=1
image=conductor-orchestrator:$SHA health=healthy
current=releases/$SHA
current_env=$SHA"
if [[ "$verify_out" != "$expected" ]]; then
  echo "!!> expected:" >&2
  echo "$expected" | sed 's/^/!!>   /' >&2
  echo "!!> found:" >&2
  echo "$verify_out" | sed 's/^/!!>   /' >&2
  die "the running orchestrator is not a healthy $SHA; NOT deployed"
fi
step "running orchestrator: conductor-orchestrator:$SHA, healthy; current = releases/$SHA"

if [[ "$SMOKE" -eq 1 ]]; then
  step "smoke test against $SMOKE_URL"
  SMOKE_EXPECT_SHA="$SHA" "$HERE/smoke.sh" "$SMOKE_URL" ||
    die "smoke test failed; $SHA is deployed and current; investigate, or roll back by deploying the previous sha"
else
  step "smoke test skipped (--no-smoke)"
fi

step "deployed $SHA"
