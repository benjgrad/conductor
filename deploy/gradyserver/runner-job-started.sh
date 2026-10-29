#!/usr/bin/env bash
# Job-started hook of the conductor runner on gradyserver (runbook §12). The runner runs it before
# every job, from its own directory, and fails the job when it exits non-zero.
#
# Why: the repo is private on the free plan, so GitHub can neither protect main nor limit an
# environment to it. Any branch can edit ci.yml to send a job to this runner, and bengrady4 is in
# the docker group (effectively root). This hook is the gate GitHub can't give us: only the
# `deploy` job of ci.yml, run from main by a push or a manual dispatch, gets to run here.
#
# Installed as a COPY outside every checkout (~/actions-runner-conductor/job-started.sh), never
# referenced from the repo, so a branch can't rewrite the gate it is checked by. After changing
# this file, copy it again (runbook §12).
set -euo pipefail

want_workflow="benjgrad/conductor/.github/workflows/ci.yml@refs/heads/main"
refuse() {
  echo "job-started: refusing $*" >&2
  echo "job-started: this runner only runs ci.yml's deploy job from main (push or workflow_dispatch)" >&2
  exit 1
}

[[ "${GITHUB_REPOSITORY:-}" == benjgrad/conductor ]] || refuse "repository '${GITHUB_REPOSITORY:-}'"
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || refuse "ref '${GITHUB_REF:-}'"
[[ "${GITHUB_WORKFLOW_REF:-}" == "$want_workflow" ]] || refuse "workflow '${GITHUB_WORKFLOW_REF:-}'"
case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch) ;;
  *) refuse "event '${GITHUB_EVENT_NAME:-}'" ;;
esac
[[ "${GITHUB_JOB:-}" == deploy ]] || refuse "job '${GITHUB_JOB:-}'"
echo "job-started: ok (${GITHUB_EVENT_NAME} of ${GITHUB_SHA:0:7} on main)"
