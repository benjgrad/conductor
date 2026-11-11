# ADR-0042 · Parallel legs inside a move step

- **Status**: proposed
- **Date**: 2026-11-11
- **Deciders**: Ben (+ conductor ticket R10 "Parallel legs inside a move step")
- **Extends**: [ADR-0011](0011-transition-rules.md) (the move step), [ADR-0010](0010-one-workflow-columns-are-states.md) (the gate-step machinery: fresh-checkout checks, the pinned commit, the fenced reviewer), [ADR-0013](0013-machine-enrollment-inventory-routing.md) (routing by repo and capability), [ADR-0030](0030-per-repo-checks-and-mcp-workflow-tools.md) (repo check overrides). Rolled out with [ADR-0037](0037-workflow-primitives-for-self-healing-process.md)'s rule-14 pattern. Supersedes nothing.

## Context

Workflow retrospective R10 (§3.5). A move step runs its phases one after another on the session's machine: held → checks → review → actions → conditions. Two costs follow:

- The checks and the requirements reviewer are independent, but the reviewer waits for every check, so a step takes their sum instead of the longer one.
- A command that only another machine can run (the Windows tests, on the Windows box) has no place in the step. It is learnt only from GitHub CI after the hand-off: commit 08e318fb broke the Windows job, and the ticket was already In review when that came back.

n8n solves this with a fan-out and a Merge node. Conductor's invariant is "one state per session": a session is in exactly one workflow state (or one gate step's label), and every engine event is judged against it. General fork/join states would break that, and are out of scope.

## Decision

**A move step may run independent legs at the same time, inside the one gate step, and passes only when all of them pass.** The session stays in the step's label (`moveStateLabel`); the legs are sub-records of the step.

### Schema

`requires.parallel` is a list of 2–4 **lanes**; each lane is a list of 1–5 **legs**. Lanes run at the same time; the legs of one lane run in order.

```jsonc
"requires": {
  "checks": [{ "name": "Tests pass", "cmd": "pnpm test" }],
  "review": { "items": ["New code paths have unit tests"] },
  "parallel": [
    [{ "type": "checks" }],
    [{ "type": "review" }],
    [{ "type": "cmd", "name": "Windows tests", "cmd": "pnpm test", "needs": ["os:windows"],
       "timeout": "20m", "setup": "pnpm i", "leg_timeout": "45m" }]
  ],
  "actions": ["open_pr"]
}
```

- `{"type": "checks"}` runs the transition's `requires.checks` (with the ADR-0030 override, as today), on the session's machine.
- `{"type": "review"}` runs the transition's `requires.review`: the fenced ADR-0009 reviewer, on the session's machine.
- `{"type": "cmd", name, cmd, timeout?, setup?, needs, leg_timeout?}` runs `cmd` in a fresh checkout of the pinned commit, on a machine that meets `needs`. `needs` holds 1–5 keys: an ADR-0013 capability key (`cli:gh:authed`, `mcp:slack`, …) or `os:windows | os:darwin | os:linux`, which `machine.os` satisfies.

Pointing `checks` and `review` at the existing fields keeps the repo override, the pin check and the reviewer machinery unchanged.

### Phase order

held → **pin** → **parallel** → the remaining `actions` → `conditions`.

- **Pin.** Before any leg starts, the step binds `head_sha` exactly as today: `PIN_CHECK` (or the first check) on a clean worktree, after the worker is killed and the fencing token is bumped. Every leg is pinned to that commit: check legs check it out fresh, the reviewer's prompt names it, and a remote `cmd` leg fetches it.
- **Remote legs need the commit pushed.** A machine other than the session's can only fetch a pushed commit, and `open_pr` (which pushes) runs after the legs. So, when a step has a `cmd` leg, the pin phase pushes `head_sha` to a conductor-owned ref, `refs/conductor/<session id>` (forced, deleted when the session ends). Conductor already pushes the session branch for `open_pr`; this is the same remote, under a ref no person works on.
- When `parallel` is set, the `checks` and `review` it names don't also run as sequential phases.

### Join

- **All must pass.** The step passes the parallel phase when every leg of every lane has passed, then runs the actions and conditions as today.
- **First failure wins.** The first leg to fail decides the phase: the verdict is `unmet`, every running leg is cancelled (`kill` with that leg's `target_command_id`, sent to the leg's own machine), and pending legs never start. The feedback ("Requirements for <title> were not met:") gives the failed leg's detail, then names the cancelled legs and the ones that never started. It is counted under `move:<from>:<name>`: `on_unmet.goto` while retries remain, `on_unmet.else` after.
- **A lost machine on a leg.** If the machine running a remote leg is lost (lease expired or revoked), that leg alone is sent out once more (attempt 2, any eligible machine). If it is lost a second time, the verdict is `infra`: `on_unmet.else` (a human), **not counted**. A machine fault isn't the agent's fault, the same as a failed action. Losing the **session's** machine is today's whole-session machine-lost park, which cancels every leg.
- **Leg timeout.** A `cmd` leg has `leg_timeout` (default 30m) to find an eligible machine and finish. While no eligible machine is online, the leg waits with a note on the checklist. When the timeout passes, the verdict is `infra`.

### Fencing

- The step bumps the session's fencing token once, when it starts, as today.
- Each leg also has its own `attempt` (1, then 2 after a re-dispatch). A leg's effects carry `leg: "<lane>.<index>"` and `attempt`; the wrapper maps the `command_id` it assigns back to that leg and attempt.
- A result, loss or timeout for a leg that isn't running, for another attempt, or after the verdict is ignored (`command_id_mismatch`). That covers a late answer from a cancelled leg and from the first attempt of a re-dispatched one.

### Machine routing (ADR-0013)

- `checks` and `review` legs run on the session's machine.
- A `cmd` leg runs on any online, unrevoked machine of the ticket's account that has the ticket's repo, passes the machine's repo rules (`repo_allow`, `repo_exclusive`), and satisfies every `needs` key. The session's machine qualifies too.
- `needs` **route the leg, not the ticket**: `requiredCapabilitiesOf` doesn't collect them. If it did, a Windows leg would pin every ticket of the workflow to the Windows machine.
- `os:<platform>` keys stay local to legs; the claim's capability keys never see them.

### Bounded

At most 4 lanes × 5 legs × 2 attempts. Every verdict ends at the target (via the actions and conditions), at the counted `on_unmet.goto`, or at a human (`on_unmet.else`). The engine's pure join (`shared/src/engine/parallel.ts`) carries a property test for it.

### Validation (rule 29) and rollout (rule 14)

Rule 29, per transition with `requires.parallel`:
- a `checks` leg needs `requires.checks`, a `review` leg needs `requires.review`, and each appears at most once across the lanes;
- a declared `requires.checks` or `requires.review` must be run by a leg;
- `cmd` leg names are unique and differ from the check names, and a `cmd` isn't blank.

Rule 13 counts `cmd` legs as requirements; rule 27 covers `$base` in a `cmd` leg. Until the engine runs legs, rule 14 refuses `requires.parallel` ("parallel legs are not available yet", feature `parallel`).

## Alternatives considered

| Option | Why not |
|---|---|
| General fork/join states (n8n's Merge) | Breaks "one state per session": two states at once means every event, timer, prompt and card needs a branch id. Out of scope. |
| A flat list of legs, all at once | Can't say "run the integration tests only after the unit tests" without a second step. Lanes cost one level of nesting. |
| Inline `checks` / `review` inside the legs | Duplicates `requires.checks` / `requires.review`, and the ADR-0030 override and the reviewer machinery would need a second home. |
| Collect `needs` into the ticket's required capabilities | Pins every ticket to the one machine that has them. |
| Any lost machine fails the leg (counted) | Sends the agent back to "fix" a machine fault and burns its retries. One re-dispatch, then a human, is cheaper. |
| Wait for `open_pr`, then run remote legs against the PR head | Puts the Windows result after the PR exists again, which is the late feedback R10 is about. |

## Consequences

- Good: a step takes as long as its slowest lane, not the sum; a Windows (or any other machine's) result arrives before the hand-off; the session stays in one state.
- Bad / accepted cost: a remote leg pushes a conductor ref; cancelled legs still cost the time they ran; `apply.ts` must route leg results by leg and attempt instead of "the one outstanding command".
- Follow-ups:
  - **P1**: run local legs (checks ∥ review) from `apply.ts`: `GateStep.parallel`, a `parallel` phase, a kill per cancelled leg, and the card checklist with lanes side by side.
  - **P2**: remote `cmd` legs: the pin ref push, an effect addressed to the leg's machine, the leg claim on `needs` and `machine.os`, the Rust daemon's checkout of a SHA from a ref, and lost-machine handling.
  - **P3**: lift rule 14 (`parallel` in `AVAILABLE_WORKFLOW_FEATURES`), and lanes in the Workflow designer.

## Revisit when

- Remote legs regularly time out waiting for a machine (machines too few, or `needs` too strict).
- Someone needs a leg to run after another lane's leg (a real dependency graph), which this design doesn't express.
