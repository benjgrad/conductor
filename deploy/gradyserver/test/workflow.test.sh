#!/usr/bin/env bash
# Checks of the CI/CD workflow (.github/workflows/ci.yml): PRs and main run scripts/ci.sh, and only
# a push to main, after the gates pass, deploys with deploy.sh, one deploy at a time. Structural
# checks need python3 with PyYAML and are skipped without it; the text checks always run.
# shellcheck disable=SC2016 # single-quoted patterns match a literal $ on purpose
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "workflow.test.sh"

WF="$REPO/.github/workflows/ci.yml"
check "ci.yml exists" test -f "$WF"
text="$(sed 's/#.*//' "$WF" 2>/dev/null)"

check "gates run scripts/ci.sh" has "$text" '^ +run: scripts/ci\.sh$'
check "deploy runs deploy.sh with the pushed sha" \
  has "$text" '^ +run: deploy/gradyserver/deploy\.sh "\$GITHUB_SHA"$'
check "never pull_request_target (it would hand PR code the secrets)" lacks "$text" 'pull_request_target'
check "the default token is read-only" has "$text" '^  contents: read$'
check "no write permission anywhere" lacks "$text" ': *write'
check "the host key is pinned, not scanned" lacks "$text" 'ssh-keyscan'
check "StrictHostKeyChecking yes" has "$text" 'StrictHostKeyChecking yes'
check "secrets reach the shell only through env" \
  test -z "$(grep -E '^ +run: .*\$\{\{ *secrets\.' "$WF")"

if python3 -c 'import yaml' 2>/dev/null; then
  # Prints one "name=value" line per fact; the checks below compare them.
  facts="$(python3 -I - "$WF" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf.get(True, wf.get("on"))  # PyYAML reads the bare key `on` as True
print("on=" + ",".join(sorted(on)))
print("push_branches=" + ",".join(on["push"]["branches"]))
jobs = wf["jobs"]
print("jobs=" + ",".join(sorted(jobs)))
d = jobs["deploy"]
print("deploy_needs=" + str(d.get("needs")))
print("deploy_if=" + d.get("if", ""))
print("deploy_env=" + str(d.get("environment", {}).get("name")))
c = d.get("concurrency", {})
print("deploy_group=" + str(c.get("group")))
print("deploy_cancel=" + str(c.get("cancel-in-progress")))
steps = [s.get("run", "") for s in d["steps"]]
print("deploy_steps=" + str(len(steps)))
i_head = next(i for i, s in enumerate(d["steps"]) if s.get("id") == "head")
i_deploy = next(i for i, s in enumerate(d["steps"]) if "deploy.sh" in s.get("run", ""))
print("head_before_deploy=" + str(i_head < i_deploy))
print("deploy_gated_on_head=" + str("steps.head.outputs.deploy" in d["steps"][i_deploy].get("if", "")))
print("cleanup_always=" + str(d["steps"][-1].get("if") == "always()" and "rm -rf ~/.ssh" in d["steps"][-1]["run"]))
print("gates_secrets=" + str("secrets." in yaml.safe_dump(jobs["gates"])))
PY
)"
  fact() { sed -n "s/^$1=//p" <<<"$facts"; }
  check "triggers: pull_request, push, workflow_dispatch" test "$(fact on)" = 'pull_request,push,workflow_dispatch'
  check "push runs only on main" test "$(fact push_branches)" = 'main'
  check "two jobs: gates and deploy" test "$(fact jobs)" = 'deploy,gates'
  check "deploy needs gates" test "$(fact deploy_needs)" = 'gates'
  check "deploy only on a push" has "$(fact deploy_if)" "github\.event_name == 'push'"
  check "deploy only from main" has "$(fact deploy_if)" "github\.ref == 'refs/heads/main'"
  check "deploy only from benjgrad/conductor" has "$(fact deploy_if)" "github\.repository == 'benjgrad/conductor'"
  check "deploy uses the gradyserver environment" test "$(fact deploy_env)" = 'gradyserver'
  check "one deploy at a time" test "$(fact deploy_group)" = 'deploy-gradyserver'
  check "a running deploy is never cancelled" test "$(fact deploy_cancel)" = 'False'
  check "the head-of-main check comes before deploy.sh" test "$(fact head_before_deploy)" = 'True'
  check "deploy.sh runs only when the sha is still main's head" test "$(fact deploy_gated_on_head)" = 'True'
  check "the ssh key is always removed last" test "$(fact cleanup_always)" = 'True'
  check "the gates job uses no secrets" test "$(fact gates_secrets)" = 'False'
else
  echo "  skip  structural checks of ci.yml (python3 with PyYAML not installed)"
fi

finish
