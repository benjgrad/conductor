# ADR-0035 · Agents run long work in the background and stay reachable

- **Status**: accepted (ticket "Messaging doesn't interrupt running tasks", Ben, 2026-11-04)
- **Date**: 2026-11-04
- **Deciders**: Ben (+ the conductor planning and implementing sessions on that ticket)
- **Extends**: [ADR-0005](0005-claude-code-driver.md) (driver events, the U-028 nudge) and [ADR-0007](0007-live-messages-to-agents.md) (live messages). It reverses neither.

## Context
Ben: *"It's unclear if it's possible for an AI agent to run things in the background while responding to new messages. I would like our agents to be able to support this."*

A live message (ADR-0007) is written to the agent's stdin, and Claude Code reads it only **between tool calls**. An agent that runs `pnpm test` in the foreground for ten minutes does not see a message for ten minutes. We never interrupt a running tool (ADR-0005 §Revisit). Three things kept agents from working around that:
- `--tools` lists only the workflow aliases' built-ins, so the tool that stops a background job was hidden.
- If an agent ended its turn to wait for a background job, the daemon took it as a turn without an outcome: it nudged, then parked the session as `no_outcome`.
- The system prompt never mentioned background work.

### Spike (claude 2.1.318, haiku; `spikes/claude-driver/g*-background*.mjs`, logs in `out/`)
- **a. Tools.**
  - The CLI has `TaskStop` (it stops a job) and no separate output tool. A background `Bash` call returns the path of an output file ("To check interim output, use Read on that file path"). The file is outside the worktree (`/tmp/claude-<uid>/…/tasks/<id>.output`), and Read is allowed on it even when Read is scoped to `Read(./**)` under `dontAsk` (g3).
  - `BashOutput`, `KillShell`, `TaskOutput` and an invented name in `--tools` / `--allowedTools` were silently dropped. The run went on, and `init.tools` listed only the real ones (g).
- **b. Turn end with a job still running.**
  - The CLI reports jobs as `system/background_tasks_changed {tasks: [...]}`, plus `task_started` / `task_updated` / `task_notification`.
  - When a job finishes after the turn has ended, the CLI **starts a turn of its own**. That turn has `init`, the agent reads the output, then `result`. Nothing is written to stdin (g).
  - A message written while the process idles with a job running runs at once as a normal turn: the agent answered and ended its turn while the job went on (g2).
  - If stdin closes while a job runs, the CLI waits for the job, runs its notification turn, and exits 0 (g2: 35 s).
- **d. Permissions.** A `run_in_background` command meets the same permission rules: `touch` was denied in `dontAsk`, while `sleep` / `echo` were allowed (g2).

## Decision
1. **Tools.** Every alias that grants `Bash` (`bash`, `git`, `review`, `qa`, `pr_skill`) also grants `BACKGROUND_TOOLS` = `TaskStop`, `BashOutput`, `KillShell` (`shared/src/workflow/tools.ts`), in both `builtin` and `allow`.
   - Only `TaskStop` exists today. The older names cost nothing (spike a) and cover older CLIs.
   - No output tool is needed: the agent Reads the job's output file.
2. **The daemon waits instead of nudging.**
   - The stream parser maps `system/background_tasks_changed` to a new in-daemon `DriverEvent::BackgroundTasks {running}`, with `running` = `tasks.length`. The line stays a `debug` output line as before.
   - The daemon keeps the last count per agent process. A turn that ends without an outcome while `running > 0` is not nudged and not parked. The daemon writes a debug line (`conductor: turn ended with N background job(s) running; waiting for them (messages reach the agent now)`) and leaves the nudge state as it is.
   - The process is idle but not parked, so `send_message` is accepted. The CLI runs the message as a turn at once. When a job finishes, the CLI's own turn carries on.
   - Once no job runs, an outcome-less turn is nudged and then parked exactly as in U-028.
   - No wire change: the event never leaves the daemon.
3. **Prompt.** `CONDUCTOR_INSTRUCTIONS` gains `## Long-running work`. It tells the agent to:
   - run anything that may take more than a minute or two with `run_in_background`, so it stays reachable;
   - end its turn to wait if it likes;
   - answer a message and end the turn again;
   - read the output file, and stop jobs it no longer needs with `TaskStop`;
   - finish or stop every job before `ask_user` or `complete_state`.

   Only the Rust daemon has this section (the TS daemon is frozen, [ADR-0026](0026-rust-daemon.md)).

## Alternatives considered
| Option | Why not |
|---|---|
| A daemon-hosted `wait_for_message` MCP tool that holds the call until a message arrives (the plan before the spike) | The CLI already wakes the agent when a job finishes and runs a message as a turn while idle. A held tool would add a polling step per wait period and a second delivery path for messages. The daemon only had to stop treating that wait as a missing outcome. |
| Poll with `sleep` in the foreground | Message latency is the sleep length; it burns a model step per poll. |
| Interrupt the running tool (`control_request` `interrupt`) when a message arrives | It throws away work the human didn't ask to stop. It could be a separate, explicit "interrupt" action later. |
| Move to the Agent SDK | Same reasons as ADR-0005; nothing here needs it. |

## Consequences
- Good: a message reaches an agent within moments whenever its long work runs in the background. Waiting for a job costs no tokens: no polling, and the CLI wakes the agent.
- Good: no schema, protocol or engine change. The engine still sees only outcomes.
- Bad / accepted cost: agents must choose `run_in_background`. A foreground command still delays a message until it returns. That is behavioural, so watch it in session findings.
- Bad / accepted cost: a job that never ends (a dev server) keeps an outcome-less agent `running` until the state's timeout. That is the bound, and its failure path ends at a human.
- Bad / known race: if an agent calls `ask_user` while a job runs (against the prompt), the job's notification starts a turn while the session is parked. The daemon ignores that turn's end (parked), and the outcome server still refuses `complete_state` while the question is pending. The human's answer is unaffected.
- Bad: on Windows a Git Bash job can escape the process-tree kill (TD-189). Background jobs make that more likely to matter.

## Revisit when
- A CLI upgrade renames the background tools or changes `background_tasks_changed` (re-run the g spikes).
- Agents still run long commands in the foreground in real sessions, or Ben wants an explicit "interrupt and send".
