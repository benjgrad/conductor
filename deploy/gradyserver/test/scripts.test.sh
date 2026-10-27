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
check "install-nginx-site.sh: root check is the first command after set" \
  test "$(grep -vE '^(#|$)' "$KIT/install-nginx-site.sh" | sed -n 2p)" = 'if [[ "$(id -u)" -ne 0 ]]; then'

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
