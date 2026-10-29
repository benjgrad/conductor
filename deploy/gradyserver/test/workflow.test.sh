#!/usr/bin/env bash
# Checks of the CI/CD workflow (.github/workflows/ci.yml): PRs and main run scripts/ci.sh, and only
# main (a push or a dispatch), after the gates pass, deploys with ci-deploy.sh on the self-hosted
# runner, one deploy at a time; and of the runner's job-started hook, the gate on the box. Structural
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
check "deploy runs ci-deploy.sh with the target sha" \
  has "$text" '^ +run: deploy/gradyserver/ci-deploy\.sh "\$TARGET"$'
check "dispatch inputs reach the shell only through env" \
  test -z "$(grep -E '^ +run: .*\$\{\{ *(inputs|github\.event)\.' "$WF")"
check "never pull_request_target (it would hand PR code the secrets)" lacks "$text" 'pull_request_target'
check "the default token is read-only" has "$text" '^  contents: read$'
check "no write permission anywhere" lacks "$text" ': *write'
check "no secrets: the deploy needs no credential" lacks "$text" 'secrets\.'
# The deploy runs on gradyserver as bengrady4: anything touching ~/.ssh would touch the real keys.
check "nothing touches ~/.ssh" lacks "$text" '\.ssh'
check "no ssh in the workflow" lacks "$text" '(^|[^-])ssh '

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
print("deploy_runs_on=" + ",".join(d["runs-on"]) if isinstance(d["runs-on"], list) else "deploy_runs_on=" + d["runs-on"])
print("deploy_fetch_depth=" + str(d["steps"][0].get("with", {}).get("fetch-depth")))
print("dispatch_inputs=" + ",".join(sorted((on["workflow_dispatch"] or {}).get("inputs", {}))))
print("gates_runs_on=" + str(jobs["gates"]["runs-on"]))
print("deploy_env=" + str(d.get("environment", {}).get("name")))
c = d.get("concurrency", {})
print("deploy_group=" + str(c.get("group")))
print("deploy_cancel=" + str(c.get("cancel-in-progress")))
steps = [s.get("run", "") for s in d["steps"]]
print("deploy_steps=" + str(len(steps)))
i_head = next(i for i, s in enumerate(d["steps"]) if s.get("id") == "head")
i_deploy = next(i for i, s in enumerate(d["steps"]) if "ci-deploy.sh" in s.get("run", ""))
print("target_env=" + str(d["steps"][i_deploy].get("env", {}).get("TARGET")))
print("head_before_deploy=" + str(i_head < i_deploy))
print("deploy_gated_on_head=" + str("steps.head.outputs.deploy" in d["steps"][i_deploy].get("if", "")))
print("gates_secrets=" + str("secrets." in yaml.safe_dump(jobs["gates"])))
PY
)"
  fact() { sed -n "s/^$1=//p" <<<"$facts"; }
  check "triggers: pull_request, push, workflow_dispatch" test "$(fact on)" = 'pull_request,push,workflow_dispatch'
  check "push runs only on main" test "$(fact push_branches)" = 'main'
  check "two jobs: gates and deploy" test "$(fact jobs)" = 'deploy,gates'
  check "deploy needs gates" test "$(fact deploy_needs)" = 'gates'
  check "deploy on a push" has "$(fact deploy_if)" "github\.event_name == 'push'"
  check "deploy on a dispatch (rollback, drill)" has "$(fact deploy_if)" "github\.event_name == 'workflow_dispatch'"
  check "never deploys a pull_request" lacks "$(fact deploy_if)" 'pull_request'
  check "deploy runs on the conductor runner on gradyserver" \
    test "$(fact deploy_runs_on)" = 'self-hosted,gradyserver-conductor'
  check "the gates run on GitHub's machines, never on gradyserver" test "$(fact gates_runs_on)" = 'ubuntu-latest'
  check "deploy checks out full history (the migration diff)" test "$(fact deploy_fetch_depth)" = '0'
  check "dispatch inputs: drill, sha" test "$(fact dispatch_inputs)" = 'drill,sha'
  check "TARGET is the dispatched sha, else the run's" test "$(fact target_env)" = '${{ inputs.sha || github.sha }}'
  check "deploy only from main" has "$(fact deploy_if)" "github\.ref == 'refs/heads/main'"
  check "deploy only from benjgrad/conductor" has "$(fact deploy_if)" "github\.repository == 'benjgrad/conductor'"
  check "deploy uses the gradyserver environment" test "$(fact deploy_env)" = 'gradyserver'
  check "one deploy at a time" test "$(fact deploy_group)" = 'deploy-gradyserver'
  check "a running deploy is never cancelled" test "$(fact deploy_cancel)" = 'False'
  check "the head-of-main check comes before ci-deploy.sh" test "$(fact head_before_deploy)" = 'True'
  check "ci-deploy.sh runs only when the sha is still main's head" test "$(fact deploy_gated_on_head)" = 'True'
  check "the gates job uses no secrets" test "$(fact gates_secrets)" = 'False'
else
  echo "  skip  structural checks of ci.yml (python3 with PyYAML not installed)"
fi

# The runner's job-started hook: only ci.yml's deploy job, from main, by a push or a dispatch.
HOOK="$KIT/runner-job-started.sh"
hook() { # hook <ref> <event> <job> [workflow ref]
  env -i PATH="$PATH" GITHUB_REPOSITORY=benjgrad/conductor GITHUB_REF="$1" GITHUB_EVENT_NAME="$2" \
    GITHUB_JOB="$3" GITHUB_SHA=0123456789abcdef \
    GITHUB_WORKFLOW_REF="${4:-benjgrad/conductor/.github/workflows/ci.yml@refs/heads/main}" "$HOOK"
}
check "hook: a push deploy from main runs" hook refs/heads/main push deploy
check "hook: a dispatched deploy from main runs" hook refs/heads/main workflow_dispatch deploy
refused() { ! hook "$@"; }
main_wf=benjgrad/conductor/.github/workflows/ci.yml@refs/heads/main
check "hook: a pull_request is refused" refused refs/pull/1/merge pull_request deploy
check "hook: a push to another branch is refused" refused refs/heads/x push deploy \
  benjgrad/conductor/.github/workflows/ci.yml@refs/heads/x
check "hook: a dispatch on another branch is refused" refused refs/heads/x workflow_dispatch deploy \
  benjgrad/conductor/.github/workflows/ci.yml@refs/heads/x
check "hook: the gates job is refused" refused refs/heads/main push gates
check "hook: another workflow on main is refused" refused refs/heads/main push deploy \
  benjgrad/conductor/.github/workflows/other.yml@refs/heads/main
check "hook: a schedule on main is refused" refused refs/heads/main schedule deploy "$main_wf"

finish
