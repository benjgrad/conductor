#!/usr/bin/env bash
# Checks of the deploy kit's shell scripts (M2-T07): bash -n on all of them, shellcheck when it is
# installed, and the argument / privilege guards (nothing here touches a server or the network).
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "scripts.test.sh"

scripts=()
while IFS= read -r f; do scripts+=("$f"); done < <(find "$KIT" -name '*.sh' -type f | sort)

for f in "${scripts[@]}"; do
  check "bash -n ${f#"$KIT"/}" bash -n "$f"
done
for f in "$KIT"/*.sh; do
  check "executable ${f#"$KIT"/}" test -x "$f"
  check "set -euo pipefail in ${f#"$KIT"/}" grep -qE '^set -E?euo pipefail$' "$f"
done

if command -v shellcheck >/dev/null; then
  for f in "${scripts[@]}"; do
    check "shellcheck ${f#"$KIT"/}" shellcheck -x "$f"
  done
else
  echo "  skip  shellcheck (not installed)"
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  out="$(HOME="$scratch" "$KIT/install-nginx-site.sh" --email nobody@example.com 2>&1)"
  code=$?
  check "install-nginx-site.sh refuses to run without root (exit $code)" test "$code" -ne 0
  check "install-nginx-site.sh says it needs root" has "$out" 'must run as root'
  check "install-nginx-site.sh as non-root creates nothing" test -z "$(ls -A "$scratch")"
else
  echo "  skip  non-root guard of install-nginx-site.sh (running as root)"
fi
# Before the root check, the only top-level statements are `set`, the usage / parse_args function
# definitions and the parse-only test hook (whose body only parses, prints and exits).
INSTALL="$KIT/install-nginx-site.sh"
root_line="$(grep -n '^if \[\[ "\$(id -u)" -ne 0 \]\]; then$' "$INSTALL" | head -n 1 | cut -d: -f1)"
check "install-nginx-site.sh has a root check" test -n "$root_line"
before_root="$(head -n $((${root_line:-1} - 1)) "$INSTALL")"
expected_top='set -Eeuo pipefail
usage() {
}
parse_args() {
}
if [[ "${CONDUCTOR_PARSE_ARGS_ONLY:-}" == 1 ]]; then
fi'
check "install-nginx-site.sh: nothing but definitions and the test hook before the root check" \
  test "$(grep -E '^[^ #]' <<<"$before_root")" = "$expected_top"
hook_body="$(sed -n '/^if \[\[ "\${CONDUCTOR_PARSE_ARGS_ONLY:-}" == 1 \]\]; then$/,/^fi$/p' "$INSTALL" |
  sed '1d;$d' | sed 's/^ *//')"
check "install-nginx-site.sh: the test hook only parses, prints and exits" \
  test "$hook_body" = 'parse_args "$@"
echo "EMAIL=$EMAIL"
exit 0'
check "install-nginx-site.sh: parse_args runs after the root check" \
  test "$(grep -n '^parse_args "\$@"$' "$INSTALL" | cut -d: -f1)" -gt "${root_line:-999999}"

# parse_args, run without root through the hook. perl's alarm bounds a parser that loops.
parse() { CONDUCTOR_PARSE_ARGS_ONLY=1 perl -e 'alarm 5; exec @ARGV' "$INSTALL" "$@" 2>&1; }
out="$(parse --email)"
code=$?
check "--email with no value exits 2 (got $code)" test "$code" -eq 2
check "--email with no value prints usage" has "$out" '^usage: '
out="$(parse --email --help)"
code=$?
check "--email followed by a flag exits 2 (got $code)" test "$code" -eq 2
out="$(parse --email=)"
code=$?
check "--email= exits 2 (got $code)" test "$code" -eq 2
out="$(parse --bogus)"
code=$?
check "unknown argument exits 2 (got $code)" test "$code" -eq 2
check "unknown argument prints usage" has "$out" '^usage: '
check "--email x@y parses" test "$(parse --email x@y)" = 'EMAIL=x@y'
check "--email=x@y parses" test "$(parse --email=x@y)" = 'EMAIL=x@y'
check "no arguments parse to an empty email" test "$(parse)" = 'EMAIL='

# Server-side ordering (remote-deploy.sh): build, postgres, the migration gate, and only then the
# orchestrator; `current` and current.env switch only after the orchestrator is healthy and runs
# the new image.
DEPLOY="$KIT/deploy.sh"
REMOTE_SH="$KIT/remote-deploy.sh"
# Comment lines are blanked (line numbers kept) so prose never matches a step.
line_of() { sed 's/^[[:space:]]*#.*//' "$REMOTE_SH" | grep -nE -- "$1" | head -n 1 | cut -d: -f1; }
l_build="$(line_of '^compose build </dev/null \|\|')"
l_pg="$(line_of '^compose up -d postgres </dev/null \|\|')"
l_migrate="$(line_of '^compose run --rm -T migrate </dev/null \|\| \{$')"
l_migrate_msg="$(line_of 'migration failed — the previous orchestrator is still running')"
l_orch_up="$(line_of 'up .*orchestrator')"
l_orch_health="$(line_of '^wait_healthy orchestrator \|\|')"
l_image_check="$(line_of '^\[\[ "\$running_image" == "\$IMAGE" \]\] \|\|$')"
l_ln="$(line_of '^ln -sfn "\$REL" current$')"
l_current_env="$(line_of '^mv current\.env\.tmp current\.env$')"
for v in l_build l_pg l_migrate l_migrate_msg l_orch_up l_orch_health l_image_check l_ln l_current_env; do
  check "remote-deploy.sh has step $v" test -n "${!v}"
done
lt() { [[ -n "$1" && -n "$2" && "$1" -lt "$2" ]]; }
check "remote-deploy.sh: build before postgres" lt "$l_build" "$l_pg"
check "remote-deploy.sh: postgres before migrate" lt "$l_pg" "$l_migrate"
check "remote-deploy.sh: migrate failure handler right after migrate" lt "$l_migrate" "$l_migrate_msg"
check "remote-deploy.sh: migrate handler exits before the orchestrator is touched" \
  test "$(sed -n "${l_migrate:-1},${l_orch_up:-1}p" "$REMOTE_SH" | grep -c '^  exit 1$')" -ge 1
check "remote-deploy.sh: migrate checked before any up of the orchestrator" lt "$l_migrate_msg" "$l_orch_up"
check "remote-deploy.sh: orchestrator up is --no-deps" \
  has "$(sed -n "${l_orch_up:-1}p" "$REMOTE_SH")" 'up -d --no-deps orchestrator'
check "remote-deploy.sh: every compose up names a service" \
  test -z "$(grep -E '^[^#]*compose up' "$REMOTE_SH" | grep -vE 'compose up -d (postgres|--no-deps orchestrator) ')"
check "remote-deploy.sh: orchestrator health wait after its up" lt "$l_orch_up" "$l_orch_health"
check "remote-deploy.sh: running image checked after the health wait" lt "$l_orch_health" "$l_image_check"
check "remote-deploy.sh: current re-pointed only after the image check" lt "$l_image_check" "$l_ln"
check "remote-deploy.sh: current.env written only after the image check" lt "$l_image_check" "$l_current_env"
check "remote-deploy.sh: current.env carries CONDUCTOR_GIT_SHA" \
  grep -qF "printf 'CONDUCTOR_GIT_SHA=%s\n' \"\$SHA\" >current.env.tmp" "$REMOTE_SH"

# stdin: the server half must never be fed through stdin, and nothing in it may read stdin.
check "deploy.sh does not pipe a script into bash -s" lacks "$(sed 's/#.*//' "$DEPLOY")" 'bash -s'
check "deploy.sh has no heredoc" lacks "$(sed 's/#.*//' "$DEPLOY")" '<<'
check "deploy.sh runs remote-deploy.sh from the release with ssh -n" grep -qE \
  '^remote_n "bash \\"\\\$HOME/\$DEPLOY_DIR/releases/\$SHA/deploy/gradyserver/remote-deploy\.sh\\"' "$DEPLOY"
check "deploy.sh: remote_n is ssh -n" grep -qF 'remote_n() { ssh -n -p ' "$DEPLOY"
check "deploy.sh: the upload is the only call of remote (stdin forwarded)" \
  test "$(grep -cE '^[^#]*\| remote "|^[^#]*[^_]remote ' "$DEPLOY")" -eq 1
check "deploy.sh: the upload is the only ssh call reading stdin (git archive)" \
  grep -qE '^git archive --format=tar "\$SHA" \| remote "' "$DEPLOY"
# Every docker / compose invocation in remote-deploy.sh (not the compose() definition) reads
# /dev/null; run / exec also get -T.
calls="$(sed 's/#.*//' "$REMOTE_SH" | grep -E '(^|[^_[:alnum:]-])(compose|docker) ' |
  grep -vE 'CONDUCTOR_GIT_SHA="\$SHA" docker compose -p conductor \\$')"
check "remote-deploy.sh has docker / compose calls to audit" test -n "$calls"
check "remote-deploy.sh: every docker / compose call has </dev/null" \
  test -z "$(grep -vE '</dev/null' <<<"$calls")"
check "remote-deploy.sh: every compose run / exec has -T" \
  test -z "$(grep -E 'compose (run|exec)' <<<"$calls" | grep -vE ' -T ')"

# deploy.sh: failure handlers, and the independent check that the RUNNING orchestrator is new.
check "deploy.sh: the remote step has a failure handler" \
  grep -qF 'die "deploy of $SHA failed on the server' "$DEPLOY"
check "deploy.sh: the upload has a failure handler" grep -qF '|| die "upload of $SHA failed' "$DEPLOY"
check "deploy.sh: the smoke test has a failure handler" grep -qE '^    die "smoke test failed' "$DEPLOY"
l_remote="$(grep -nF 'remote-deploy.sh\"' "$DEPLOY" | grep -v '^[0-9]*:#' | head -n 1 | cut -d: -f1)"
l_verify="$(grep -nF 'die "the running orchestrator is not a healthy $SHA; NOT deployed"' "$DEPLOY" | cut -d: -f1)"
l_smoke="$(grep -nF '"$HERE/smoke.sh"' "$DEPLOY" | cut -d: -f1)"
l_done="$(grep -nF 'step "deployed $SHA"' "$DEPLOY" | cut -d: -f1)"
check "deploy.sh: verification after the remote step" lt "$l_remote" "$l_verify"
check "deploy.sh: verification before the smoke test" lt "$l_verify" "$l_smoke"
check "deploy.sh: 'deployed' printed last" lt "$l_smoke" "$l_done"
check "deploy.sh: verification expects the new image, healthy" \
  grep -qF 'image=conductor-orchestrator:$SHA health=healthy' "$DEPLOY"
check "deploy.sh: smoke test expects the new sha" grep -qF 'SMOKE_EXPECT_SHA="$SHA" "$HERE/smoke.sh"' "$DEPLOY"
check "smoke.sh checks /healthz version against SMOKE_EXPECT_SHA" \
  grep -qF '"$version" == *"${SMOKE_EXPECT_SHA:0:7}"*' "$KIT/smoke.sh"

# Operator commands and backup.sh select the deployed image through current.env.
check "backup.sh passes .env and current.env" \
  grep -qF -- '--env-file "$ENV_FILE" --env-file "$CURRENT_ENV"' "$KIT/backup.sh"
check "backup.sh: CURRENT_ENV is current.env" grep -qF 'CURRENT_ENV="$ROOT/current.env"' "$KIT/backup.sh"
check "runbook cdc alias passes .env and current.env" grep -qE \
  "^alias cdc='.*--env-file ~/deploy/conductor/\.env --env-file ~/deploy/conductor/current\.env'$" \
  "$REPO/docs/setup/deploy-gradyserver.md"

out="$("$KIT/deploy.sh" 2>&1)"
code=$?
check "deploy.sh without a ref exits 2" test "$code" -eq 2
check "deploy.sh without a ref prints usage" has "$out" '^usage: .*deploy\.sh <git-ref>'

out="$("$KIT/smoke.sh" 2>&1)"
code=$?
check "smoke.sh without a URL exits 2" test "$code" -eq 2
check "smoke.sh without a URL prints usage" has "$out" '^usage: .*smoke\.sh <base-url>'

out="$(CONDUCTOR_DEPLOY_ROOT="$scratch" BACKUP_KEEP_DAYS=abc "$KIT/backup.sh" 2>&1)"
code=$?
check "backup.sh rejects a non-numeric BACKUP_KEEP_DAYS" test "$code" -eq 2

finish
