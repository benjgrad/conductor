#!/usr/bin/env bash
# CI's deploy (runbook §12): runs ON gradyserver, in the conductor runner's checkout, as
# bengrady4. It is deploy.sh without the ssh: the same release layout and the same server half,
# plus what nobody is watching a CI deploy for: a rollback, and a Discord alert when it fails.
#
#   deploy/gradyserver/ci-deploy.sh <git-ref>
#
# 1. takes ~/deploy/conductor/.deploy.lock (CI and a by-hand ci-deploy.sh never interleave);
# 2. unpacks `git archive <sha>` into ~/deploy/conductor/releases/<sha> (skipped if it exists);
# 3. if packages/orchestrator/migrations changed since the live sha, runs backup.sh first: a
#    rollback restores code, not schema, so this dump is the only undo for a bad migration;
# 4. runs remote-deploy.sh from the release (build → postgres → migrate gate → orchestrator →
#    current), then checks the running orchestrator is a healthy <sha> and runs smoke.sh with
#    SMOKE_EXPECT_SHA=<sha>;
# 5. on any failure in 4: puts the previous orchestrator image back (no migrate, no rebuild unless
#    the image is gone), re-points current at it, smokes it, and alerts Discord. Success is silent.
#
# DEPLOY_DRILL=1 fails the first smoke on purpose, so the rollback and the alert run end to end and
# the alert says it is a drill. Do one after any change to this file.
#
# Env: DEPLOY_DIR (deploy/conductor, relative to $HOME), SMOKE_URL
#      (https://conductor.gradyserver.com), DEPLOY_HEALTH_TIMEOUT (180 seconds, per wait),
#      DEPLOY_DRILL. DISCORD_WEBHOOK_URL is read from ~/deploy/conductor/.env; unset, alerts go
#      to the job log only.
set -euo pipefail

if [[ $# -ne 1 || "$1" == -* ]]; then
  echo "usage: $0 <git-ref>" >&2
  exit 2
fi
REF="$1"
DEPLOY_DIR="${DEPLOY_DIR:-deploy/conductor}"
SMOKE_URL="${SMOKE_URL:-https://conductor.gradyserver.com}"
DEPLOY_HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT="$HOME/$DEPLOY_DIR"
MIGRATIONS=packages/orchestrator/migrations

step() { echo "==> $*"; }
die() {
  echo "!!> $*" >&2
  exit 1
}

[[ "$DEPLOY_DIR" =~ ^[A-Za-z0-9._/-]+$ ]] || die "DEPLOY_DIR may only contain letters, digits, . _ / -"
[[ "$DEPLOY_HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "DEPLOY_HEALTH_TIMEOUT must be a whole number of seconds"
[[ -d "$ROOT" ]] || die "$ROOT does not exist; the first deploy is deploy.sh by hand (runbook §3)"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")" || die "cannot resolve git ref '$REF'"

exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || die "another deploy held $ROOT/.deploy.lock for 10 minutes"

# ---------------------------------------------------------------- alerting
# Straight to the webhook with curl: when this has to speak, the orchestrator may be what's broken.
# Discord's two gotchas: Cloudflare 403s a default User-Agent, and a 429 carries Retry-After.
webhook() { sed -n 's/^DISCORD_WEBHOOK_URL=//p' "$ROOT/.env" 2>/dev/null | tail -n 1 | tr -d "\"'"; }

alert() { # alert <colour-int> <title> <description> [field-name field-value]...
  local url payload status attempt retry headers
  url="$(webhook)"
  if [[ -z "$url" ]]; then
    echo "!!> [discord not configured] $2: $3" >&2
    return 0
  fi
  payload="$(DRILL="${DEPLOY_DRILL:-}" python3 -I - "$@" <<'PY'
import json, os, sys
color, title, desc, *rest = sys.argv[1:]
drill = os.environ.get("DRILL") == "1"
fields = [{"name": n, "value": (v or "-")[:1020], "inline": False} for n, v in zip(rest[::2], rest[1::2])]
if drill:
    fields.insert(0, {"name": "This is a drill", "value": "Nothing is wrong: a deliberate failure to prove the rollback.", "inline": False})
print(json.dumps({
    "username": "Conductor (test)" if drill else "Conductor",
    "embeds": [{
        "title": ("TEST: " + title) if drill else title,
        "description": desc[:4000],
        "color": 0xF39C12 if drill else int(color),
        "footer": {"text": "conductor deploy"},
        "fields": fields[:24],
    }],
}))
PY
  )" || return 0
  headers="$(mktemp)"
  for attempt in 1 2 3; do
    status="$(curl -sS --max-time 15 -o /dev/null -D "$headers" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -H 'User-Agent: Conductor (https://conductor.gradyserver.com, 1.0)' \
      -d "$payload" "$url" 2>/dev/null || echo 000)"
    [[ "$status" == 2* ]] && break
    if [[ "$status" == 429 && "$attempt" -lt 3 ]]; then
      retry="$(grep -i '^retry-after:' "$headers" | tr -dc '0-9' || true)"
      sleep "$(((${retry:-2} > 30 ? 30 : ${retry:-2}) + 1))"
      continue
    fi
    echo "!!> [discord failed] HTTP $status" >&2 # the status, never the URL: it carries the token
    break
  done
  rm -f "$headers"
}
RED=15158332   # 0xe74c3c
AMBER=15965202 # 0xf39c12

RUN_URL="by hand"
if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-benjgrad/conductor}/actions/runs/$GITHUB_RUN_ID"
fi

# Anything that dies before the release starts has changed nothing that runs, but it is still a
# deploy that didn't happen. The rollback path sends its own alert and sets ALERTED.
ALERTED=0
PREV=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
on_exit() {
  local code=$?
  ((code == 0 || ALERTED == 1)) && return
  alert "$AMBER" "Deploy did not run" \
    "Stopped before touching production (exit $code); it is still on \`${PREV:0:7}\`. See the run log." \
    "Commit" "${SHA:0:7}" "Run" "$RUN_URL"
}
trap on_exit EXIT

# ---------------------------------------------------------------- steps
compose_for() { # compose_for <sha> <args...>: the compose project as that release defines it
  local sha="$1"
  shift
  CONDUCTOR_GIT_SHA="$sha" docker compose -p conductor \
    -f "$ROOT/releases/$sha/deploy/gradyserver/compose.yml" --env-file "$ROOT/.env" "$@"
}

# running_is <sha>: exactly one orchestrator, healthy, from conductor-orchestrator:<sha>, waiting up
# to DEPLOY_HEALTH_TIMEOUT for it. Prints what it found on failure.
running_is() {
  local want="image=conductor-orchestrator:$1 health=healthy" found="" ids
  local deadline=$((SECONDS + DEPLOY_HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    ids="$(docker ps -q --filter label=com.docker.compose.project=conductor \
      --filter label=com.docker.compose.service=orchestrator </dev/null)"
    found="containers=$(wc -w <<<"$ids" | tr -d ' ')"
    if [[ -n "$ids" ]]; then
      # shellcheck disable=SC2086 # one id per word, on purpose
      found+=" $(docker inspect -f 'image={{.Config.Image}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids </dev/null | tr '\n' ' ')"
    fi
    [[ "$found" == "containers=1 $want " ]] && return 0
    sleep 3
  done
  echo "!!> expected one orchestrator, $want; found: $found" >&2
  return 1
}

point_current_at() { # point_current_at <sha>: what remote-deploy.sh does after a good start
  ln -sfn "releases/$1" "$ROOT/current" || return 1
  printf 'CONDUCTOR_GIT_SHA=%s\n' "$1" >"$ROOT/current.env.tmp" || return 1
  mv "$ROOT/current.env.tmp" "$ROOT/current.env"
}

smoke() { # smoke <sha>
  if [[ "$DRILL_PENDING" == 1 ]]; then
    DRILL_PENDING=0
    step "drill: failing this smoke test on purpose"
    "$HERE/smoke.sh" "http://127.0.0.1:9" || return 1
  fi
  SMOKE_EXPECT_SHA="$1" "$HERE/smoke.sh" "$SMOKE_URL"
}
DRILL_PENDING=0
[[ "${DEPLOY_DRILL:-}" == 1 ]] && DRILL_PENDING=1

# EVERY STEP CARRIES ITS OWN `|| return 1`. These run as `if release …`, and bash turns set -e off
# for the whole body of a function called as a condition: without them a failed step would fall
# through and the old orchestrator's smoke would report the new sha as live.
release() { # release <sha>
  bash "$ROOT/releases/$1/deploy/gradyserver/remote-deploy.sh" "$DEPLOY_DIR" "$1" \
    "$DEPLOY_HEALTH_TIMEOUT" </dev/null || return 1
  step "verifying the running orchestrator is $1"
  running_is "$1" || return 1
  [[ "$(readlink "$ROOT/current")" == "releases/$1" ]] || return 1
  smoke "$1" || return 1
}

# Back to the previous image, without migrate (the old code runs on the new schema: migrations
# are additive, runbook §7) and without a rebuild while conductor-orchestrator:<prev> exists.
rollback() { # rollback <sha>
  [[ -n "$1" && -f "$ROOT/releases/$1/deploy/gradyserver/compose.yml" ]] || {
    echo "!!> no release to roll back to (${1:-none})" >&2
    return 1
  }
  compose_for "$1" up -d --no-deps orchestrator </dev/null || return 1
  running_is "$1" || return 1
  point_current_at "$1" || return 1
  smoke "$1" || return 1
}

# ---------------------------------------------------------------- run
PREV="$(sed -n 's/^CONDUCTOR_GIT_SHA=//p' "$ROOT/current.env" 2>/dev/null || true)"
SUBJECT="$(git -C "$REPO" log -1 --format=%s "$SHA")"
step "deploying ${SHA:0:7} ($SUBJECT); live now: ${PREV:0:7}"

if [[ -d "$ROOT/releases/$SHA" ]]; then
  step "release $SHA already unpacked"
else
  rm -rf "$ROOT/releases/$SHA.tmp"
  mkdir -p "$ROOT/releases/$SHA.tmp"
  git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$ROOT/releases/$SHA.tmp"
  mv "$ROOT/releases/$SHA.tmp" "$ROOT/releases/$SHA"
  step "unpacked releases/$SHA"
fi

# An unknown previous sha (a by-hand deploy of a ref CI never fetched) counts as changed.
if [[ -n "$PREV" ]] && git -C "$REPO" cat-file -e "$PREV^{commit}" 2>/dev/null &&
  git -C "$REPO" diff --quiet "$PREV" "$SHA" -- "$MIGRATIONS"; then
  step "no migration changes since ${PREV:0:7}; no pre-deploy dump"
elif [[ -n "$PREV" ]]; then
  step "migrations changed since ${PREV:0:7}: dumping first"
  "$HERE/backup.sh"
fi

if release "$SHA"; then
  step "deployed $SHA"
  exit 0
fi

ALERTED=1
echo "!!> ${SHA:0:7} failed; rolling back to ${PREV:0:7}" >&2
if rollback "$PREV"; then
  alert "$AMBER" "Deploy failed: rolled back" \
    "\`${SHA:0:7}\` did not come up healthy, so production is back on \`${PREV:0:7}\` and passing its smoke test. Nothing new shipped." \
    "Failed commit" "${SHA:0:7} $SUBJECT" "Running now" "${PREV:0:7}" "Run" "$RUN_URL"
else
  alert "$RED" "Deploy failed and rollback failed: conductor may be down" \
    "\`${SHA:0:7}\` failed and \`${PREV:0:7}\` did not come back either. On gradyserver: \`cdc ps\`, \`cdc logs orchestrator\` (runbook §10)." \
    "Failed commit" "${SHA:0:7} $SUBJECT" "Run" "$RUN_URL"
fi
exit 1
