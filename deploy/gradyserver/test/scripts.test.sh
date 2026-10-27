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

# deploy.sh ordering: build, postgres, the migration gate, and only then the orchestrator; `current`
# and current.env switch only after the orchestrator is healthy.
DEPLOY="$KIT/deploy.sh"
line_of() { grep -nE -- "$1" "$DEPLOY" | head -n 1 | cut -d: -f1; }
l_build="$(line_of '^compose build \|\|')"
l_pg="$(line_of '^compose up -d postgres \|\|')"
l_migrate="$(line_of '^compose run --rm migrate \|\| \{$')"
l_migrate_msg="$(line_of 'migration failed — the previous orchestrator is still running')"
l_orch_up="$(line_of 'up .*orchestrator')"
l_orch_health="$(line_of '^wait_healthy orchestrator \|\|')"
l_ln="$(line_of '^ln -sfn "\$REL" current$')"
l_current_env="$(line_of '^mv current\.env\.tmp current\.env$')"
for v in l_build l_pg l_migrate l_migrate_msg l_orch_up l_orch_health l_ln l_current_env; do
  check "deploy.sh has step $v" test -n "${!v}"
done
lt() { [[ -n "$1" && -n "$2" && "$1" -lt "$2" ]]; }
check "deploy.sh: build before postgres" lt "$l_build" "$l_pg"
check "deploy.sh: postgres before migrate" lt "$l_pg" "$l_migrate"
check "deploy.sh: migrate failure handler right after migrate" lt "$l_migrate" "$l_migrate_msg"
check "deploy.sh: migrate handler exits before the orchestrator is touched" \
  test "$(sed -n "${l_migrate:-1},${l_orch_up:-1}p" "$DEPLOY" | grep -c '^  exit 1$')" -ge 1
check "deploy.sh: migrate checked before any up of the orchestrator" lt "$l_migrate_msg" "$l_orch_up"
check "deploy.sh: orchestrator up is --no-deps" has "$(sed -n "${l_orch_up:-1}p" "$DEPLOY")" \
  'up -d --no-deps orchestrator'
check "deploy.sh: every compose up names a service" \
  test -z "$(grep -E '^[^#]*compose up' "$DEPLOY" | grep -vE 'compose up -d (postgres|--no-deps orchestrator)')"
check "deploy.sh: orchestrator health wait after its up" lt "$l_orch_up" "$l_orch_health"
check "deploy.sh: current re-pointed only after the health wait" lt "$l_orch_health" "$l_ln"
check "deploy.sh: current.env written only after the health wait" lt "$l_orch_health" "$l_current_env"
check "deploy.sh: current.env carries CONDUCTOR_GIT_SHA" \
  grep -qF "printf 'CONDUCTOR_GIT_SHA=%s\n' \"\$SHA\" >current.env.tmp" "$DEPLOY"
check "deploy.sh: the remote step has a failure handler" grep -qE '<<.REMOTE. \|\|$' "$DEPLOY"
check "deploy.sh: the upload has a failure handler" grep -qF '|| die "upload of $SHA failed' "$DEPLOY"
check "deploy.sh: the smoke test has a failure handler" grep -qE '^    die "smoke test failed' "$DEPLOY"

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
