#!/usr/bin/env bash
# End-to-end run of ci-deploy.sh + remote-deploy.sh with fake `docker`, `curl` and smoke.sh (runbook
# §12): the good path, the pre-deploy dump, each way a deploy fails and is rolled back, a rollback
# that fails too, the drill, and the Discord alert each one sends.
# SC2016: single-quoted patterns and generated scripts keep a literal $ on purpose.
# shellcheck disable=SC2016
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "ci-deploy-flow.test.sh"

for tool in git tar flock python3; do
  command -v "$tool" >/dev/null || {
    echo "  skip  ci-deploy flow ($tool not installed; ci-deploy.sh only runs on gradyserver)"
    finish
    exit
  }
done

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home" "$T/state" "$T/repo/deploy"

# Fake docker: the orchestrator's image lives in $FAKE_STATE/orch_image; calls are logged.
cat >"$T/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
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
      [[ "$last" == orchestrator ]] && echo "conductor-orchestrator:$CONDUCTOR_GIT_SHA" >"$S/orch_image"
      ;;
    ps)
      case "$last" in
        postgres) [[ -e "$S/pg" ]] && echo c-postgres ;;
        orchestrator) [[ -e "$S/orch_image" ]] && echo c-orchestrator ;;
      esac
      ;;
    run) cat >/dev/null; exit "${FAKE_MIGRATE_RC:-0}" ;;
    exec) [[ -z "${FAKE_DUMP_EMPTY:-}" ]] && echo DUMP ;;
  esac
  exit 0
fi
case "$1" in
  inspect)
    case "$3" in
      image=*) echo "image=$(cat "$S/orch_image") health=healthy" ;;
      '{{.Config.Image}}') cat "$S/orch_image" ;;
      *Health*) echo healthy ;;
    esac
    ;;
  ps) [[ -e "$S/orch_image" ]] && echo c-orchestrator ;;
esac
exit 0
DOCKER

# Fake curl: only the Discord webhook calls it (smoke.sh is faked below). Keeps the payload.
cat >"$T/bin/curl" <<'CURL'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  [[ "$1" == -d ]] && printf '%s\n' "$2" >>"$FAKE_STATE/alerts"
  shift
done
printf 204
CURL
chmod +x "$T/bin/docker" "$T/bin/curl"

cp -R "$KIT" "$T/repo/deploy/gradyserver"
# Fake smoke.sh: fails for the URL nothing listens on (the drill) and for any sha in FAKE_SMOKE_FAIL.
cat >"$T/repo/deploy/gradyserver/smoke.sh" <<'SMOKE'
#!/usr/bin/env bash
echo "smoke $1 ${SMOKE_EXPECT_SHA:-}" >>"$FAKE_STATE/calls"
[[ "$1" == *:9 ]] && exit 1
[[ " ${FAKE_SMOKE_FAIL:-} " == *" ${SMOKE_EXPECT_SHA:-none} "* ]] && exit 1
exit 0
SMOKE
mkdir -p "$T/repo/packages/orchestrator/migrations"
g() { git -C "$T/repo" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false "$@"; }
g init -q
commit() { # commit <message> [file]: changes `marker`, or the given file
  echo "$1" >"$T/repo/${2:-marker}"
  g add -A
  g commit -q -m "$1"
  g rev-parse HEAD
}

ROOT="$T/home/deploy/conductor"
mkdir -p "$ROOT"
printf 'POSTGRES_PASSWORD=%s\nDISCORD_WEBHOOK_URL=https://discord.invalid/hook\n' \
  "$(printf 'a%.0s' {1..64})" >"$ROOT/.env"
chmod 600 "$ROOT/.env"

# deploy <sha> [ENV=VALUE...]: runs ci-deploy.sh; sets OUT and CODE, and resets calls / alerts.
deploy() {
  local sha="$1"
  shift
  : >"$T/state/calls"
  : >"$T/state/alerts"
  OUT="$(cd "$T/repo" && env PATH="$T/bin:$PATH" HOME="$T/home" FAKE_STATE="$T/state" \
    DEPLOY_HEALTH_TIMEOUT=2 GITHUB_RUN_ID= "$@" deploy/gradyserver/ci-deploy.sh "$sha" 2>&1)"
  CODE=$?
}
live() { test "$(cat "$T/state/orch_image")" = "conductor-orchestrator:$1" &&
  test "$(readlink "$ROOT/current")" = "releases/$1" &&
  test "$(cat "$ROOT/current.env")" = "CONDUCTOR_GIT_SHA=$1"; }
calls_line() { grep -nE -- "$1" "$T/state/calls" | head -n 1 | cut -d: -f1; }
lt() { [[ -n "$1" && -n "$2" && "$1" -lt "$2" ]]; }

out="$("$KIT/ci-deploy.sh" 2>&1)"
code=$?
check "no ref: exits 2 (got $code)" test "$code" -eq 2
check "no ref: prints usage" has "$out" '^usage: .*ci-deploy\.sh <git-ref>'

# 1. The first CI deploy (nothing live yet): no dump, no alert.
sha1="$(commit one)"
deploy "$sha1"
check "first deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "first deploy: $sha1 live, current and current.env switched" live "$sha1"
check "first deploy: says deployed" has "$OUT" "^==> deployed $sha1\$"
check "first deploy: smoke expects the sha" grep -qF "smoke https://conductor.gradyserver.com $sha1" "$T/state/calls"
check "first deploy: no alert" test ! -s "$T/state/alerts"

# 2. A deploy without migration changes takes no dump.
sha2="$(commit two)"
deploy "$sha2"
check "good deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "good deploy: $sha2 live" live "$sha2"
check "good deploy: no dump" has "$OUT" 'no migration changes since'
check "good deploy: no alert" test ! -s "$T/state/alerts"

# 3. A migration change dumps the database before anything is built.
sha3="$(commit three packages/orchestrator/migrations/1-new.sql)"
deploy "$sha3"
check "migration deploy exits 0 (got $CODE)" test "$CODE" -eq 0
check "migration deploy: a dump was written" test -n "$(ls "$ROOT"/backups/conductor-*.dump 2>/dev/null)"
check "migration deploy: dump before build" lt "$(calls_line ' exec -T postgres pg_dump')" "$(calls_line ' build$')"
check "migration deploy: $sha3 live" live "$sha3"

# 4. A failed smoke test rolls back to the previous image without migrating again, and alerts.
sha4="$(commit four)"
deploy "$sha4" FAKE_SMOKE_FAIL="$sha4"
check "smoke failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "smoke failure: $sha3 live again, current and current.env back" live "$sha3"
check "smoke failure: migrate ran once (the deploy's own gate, not the rollback)" \
  test "$(grep -c ' run --rm -T migrate' "$T/state/calls")" -eq 1
check "smoke failure: rollback recreated only the orchestrator" \
  test "$(grep -c ' up -d --no-deps orchestrator' "$T/state/calls")" -eq 2
check "smoke failure: rolled-back release smoked against its own sha" \
  grep -qF "smoke https://conductor.gradyserver.com $sha3" "$T/state/calls"
check "smoke failure: one alert, 'rolled back'" \
  test "$(wc -l <"$T/state/alerts")" -eq 1 -a -n "$(grep 'Deploy failed: rolled back' "$T/state/alerts")"
check "smoke failure: alert names both shas" has "$(cat "$T/state/alerts")" "${sha4:0:7}.*${sha3:0:7}"
check "smoke failure: the alert payload is valid JSON" python3 -I -c \
  'import json,sys; json.loads(open(sys.argv[1]).readline())' "$T/state/alerts"
check "smoke failure: no 'deployed'" lacks "$OUT" '^==> deployed'

# 5. A failed migration: the old orchestrator was never touched; still a rollback alert.
sha5="$(commit five)"
deploy "$sha5" FAKE_MIGRATE_RC=1
check "migration failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "migration failure: $sha3 still live" live "$sha3"
check "migration failure: alert 'rolled back'" grep -q 'Deploy failed: rolled back' "$T/state/alerts"

# 6. A rollback that fails too is the red alert.
deploy "$sha4" FAKE_SMOKE_FAIL="$sha4 $sha3"
check "double failure exits 1 (got $CODE)" test "$CODE" -eq 1
check "double failure: red alert" grep -q 'rollback failed: conductor may be down' "$T/state/alerts"
check "double failure: red colour" grep -q '"color": 15158332' "$T/state/alerts"

# 7. The drill: redeploying what's live fails its first smoke on purpose, rolls back, and says so.
deploy "$sha3" DEPLOY_DRILL=1
check "drill exits 1 (got $CODE)" test "$CODE" -eq 1
check "drill: smoke against the dead port first" grep -qF 'smoke http://127.0.0.1:9' "$T/state/calls"
check "drill: $sha3 still live" live "$sha3"
check "drill: alert marked as a test" grep -q '"title": "TEST: Deploy failed: rolled back"' "$T/state/alerts"
check "drill: alert says it's a drill" grep -q 'This is a drill' "$T/state/alerts"

# 8. A failure before the release (an empty dump) touches nothing and says the deploy didn't run.
sha6="$(commit six packages/orchestrator/migrations/2-new.sql)"
deploy "$sha6" FAKE_DUMP_EMPTY=1
check "failed dump exits non-zero (got $CODE)" test "$CODE" -ne 0
check "failed dump: nothing built" test -z "$(calls_line ' build$')"
check "failed dump: $sha3 still live" live "$sha3"
check "failed dump: alert 'did not run'" grep -q 'Deploy did not run' "$T/state/alerts"

# 9. Without a webhook the alert goes to the log, and nothing is sent.
sed -i.bak '/^DISCORD_WEBHOOK_URL=/d' "$ROOT/.env"
deploy "$sha4" FAKE_SMOKE_FAIL="$sha4"
check "no webhook: exits 1 (got $CODE)" test "$CODE" -eq 1
check "no webhook: nothing sent" test ! -s "$T/state/alerts"
check "no webhook: the alert is in the log" has "$OUT" 'discord not configured\] Deploy failed: rolled back'

# 10. And the sha deploys once it is fixed.
deploy "$sha6"
check "after the failures, $sha6 deploys (got $CODE)" test "$CODE" -eq 0
check "after the failures: $sha6 live" live "$sha6"

finish
