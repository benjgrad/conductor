# ADR-0005 · Claude Code driver: stream-json CLI, daemon-hosted MCP outcome tools

- **Status**: accepted (Ben, 2026-10-22); permission and settings parts superseded by [ADR-0006](0006-agents-inherit-claude-code-settings.md) (2026-10-23)
- **Date**: 2026-10-22
- **Deciders**: Ben (+ M1-T00 spike session)
- **Resolves**: U-001, U-002

## Context
The daemon has to run Claude Code unattended inside a session worktree. It needs to get the Claude session id, stream output to the orchestrator, receive the structured outcomes `complete_state {result}` and `ask_user {question}`, read spend, enforce the per-state tool allow-list, and kill the session. The workshop set a hard requirement ([06](../design/06-human-input.md)): while a question is pending, the Claude process **stays alive but idle**, and the answer is fed **into the live process**. `--resume` is only the fallback for when the process is gone.

The M1-T00 spike ([spikes/claude-driver](../../spikes/claude-driver/README.md)) ran each mechanism against Claude Code 2.1.308 and Agent SDK 0.3.308:

- `claude -p --input-format stream-json --output-format stream-json --verbose` is a long-lived, bidirectional NDJSON session. After each turn's `result` the process idles until the next user message on stdin, and it exits 0 when stdin closes. A message written after a 20 s idle gap continued the same session.
- The session id can be **pre-assigned** with `--session-id <uuid>`. `system/init` confirms it, but only after the first user message, and it repeats on every turn.
- `--resume <id>` keeps the id and the context, and works from any cwd **on the same machine** (it needs the local transcript).
- `result.total_cost_usd` is **cumulative per Claude session, including across `--resume`**. `usage` is per turn.
- MCP tools served by the daemon over HTTP are called reliably. A **blocking** tool call **times out after 60 s**, so `ask_user` cannot hold the call open while a human answers.
- `--permission-mode dontAsk` + `--permission-prompts none` + `--allowedTools` denies anything not pre-approved, without prompting. Bare `Write`/`Edit` rules **escape the worktree**; `Write(./**)`/`Edit(./**)` do not.
- The Agent SDK is a typed wrapper over the same CLI protocol, plus private `control_request` messages. It works, but without `strictMcpConfig` it attached the user's claude.ai connectors (119 tools) to the agent.

## Decision
**The daemon spawns the installed `claude` CLI directly, one long-lived child per session, in bidirectional stream-json mode. `complete_state` and `ask_user` are tools on an MCP server the daemon hosts itself (Streamable HTTP on 127.0.0.1). `ask_user` returns at once, and every answer is a user message: written to live stdin when the process exists, or sent as the first message after `--resume` when it does not.**

### Spawn
```
claude -p --input-format stream-json --output-format stream-json --verbose
  --session-id <uuid> | --resume <claude_session_id>
  --model <state/workflow model>  --max-turns <n>  --max-budget-usd <remaining budget>
  --setting-sources ""  --strict-mcp-config  --permission-mode dontAsk  --permission-prompts none
  --mcp-config '{"mcpServers":{"conductor":{"type":"http","url":"http://127.0.0.1:<port>/mcp/<token>"}}}'
  --tools <built-ins from the state's allow-list>
  --allowedTools <rules from the state's allow-list> mcp__conductor__complete_state mcp__conductor__ask_user
  --disallowedTools <deny rules>
cwd = session worktree; env = { CONDUCTOR_PORT_BASE, PORT, CONDUCTOR_PORT_COUNT, GIT_AUTHOR_*/GIT_COMMITTER_* , ...state env }
```
- The daemon **generates the Claude session id** (`--session-id`) and persists it before spawning, so a crash before `init` still leaves a resumable id. `system/init` must confirm it.
- **Outcome server**: one HTTP listener per daemon, bound to 127.0.0.1. Each driver session registers a random 128-bit path token, which attributes every call to exactly one session. The token is dropped on exit.
  - `complete_state({result: object})`: emits `complete_state` and returns "Recorded. Stop now". A second call, or a call while a question is pending, gets a corrective text and is not emitted.
  - `ask_user({question: string})`: emits `ask_user` and returns at once with "sent to a human; end your turn; the answer arrives as the next user message".
- **Turn end** (`result` message): emit `spend` and `turn_end`. After a `complete_state` the daemon calls `end()` (closes stdin, exits 0). If the process hasn't exited after a grace period, it calls `kill()`. After an `ask_user` the session is parked: the process stays alive, idle, with no tokens spent.
- **Answer**: `send_input` → `sendInput(answer)` writes a user message to stdin. If the process is gone, the next `start_session` carries `resumeSessionId` and `prompt = answer`.
- **Tool allow-list mapping**: a state's `tools` list maps to `--tools` (the visible built-ins) plus `--allowedTools`. File tools are always path-scoped (`Edit(./**)`, `Write(./**)`), so a bare `Edit` in a workflow is rewritten to the scoped form. Bash entries are prefix rules (`Bash(git commit:*)`). Everything else is denied by `dontAsk`. `git push` stays denied for agents: the workflow's command/connector states push.
- **Parsing**: NDJSON from stdout, validated leniently. Only `system/init`, `assistant`, `user` (tool results) and `result` matter. Unknown types (`rate_limit_event`, `system/*`, `tool_progress`, …) pass through as debug output. Record `claude_code_version` from init.

### Contract (pinned by M1-T12 in `packages/daemon/src/claude/driver.ts`)
```ts
export interface ToolPolicy {
  builtin: string[];   // --tools, e.g. ["Read","Edit","Write","Glob","Grep","Bash"]
  allow: string[];     // --allowedTools rules, e.g. ["Edit(./**)","Bash(git commit:*)"]
  deny: string[];      // --disallowedTools rules, e.g. ["Bash(git push:*)","WebFetch"]
}

export interface DriverStartOptions {
  cwd: string;                     // session worktree
  prompt: string;                  // first user message (the answer, when resuming after ask_user)
  tools: ToolPolicy;
  claudeSessionId: string;         // pre-assigned by the daemon (new) or the id to resume
  resume: boolean;                 // true → --resume claudeSessionId, else --session-id
  env: Record<string, string>;     // merged over the daemon env (ports, git identity)
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;           // remaining workflow budget, passed as a hard backstop
  appendSystemPrompt?: string;     // conductor instructions (how to use complete_state / ask_user)
}

export type DriverEvent =
  | { kind: 'claude_session_id'; id: string }                 // once, from the first system/init
  | { kind: 'output'; stream: 'assistant' | 'tool_use' | 'tool_result' | 'stderr' | 'debug'; text: string }
  | { kind: 'ask_user'; question: string }
  | { kind: 'complete_state'; result: Record<string, unknown> }
  | { kind: 'turn_end'; isError: boolean; subtype: string; permissionDenials: number }  // process now idle
  | { kind: 'spend'; totalUsd: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } }
  | { kind: 'exit'; code: number | null; signal: string | null };

export interface DriverSession {
  readonly claudeSessionId: string;
  on(listener: (ev: DriverEvent) => void): () => void;
  sendInput(text: string): void;   // live answer injection; queued by Claude if a turn is running
  end(): void;                     // graceful: close stdin → exit 0
  kill(graceMs?: number): void;    // SIGTERM, then SIGKILL after graceMs
}

export interface ClaudeDriver {
  start(opts: DriverStartOptions): DriverSession;
}
```
Mapping to [03](../design/03-protocols.md) `session_event` kinds: `claude_session_id`, `ask_user`, `complete_state`, `spend` and `exit` are forwarded as-is. `output` goes to the `output` channel. `turn_end` stays inside the daemon and drives park/end (and, for a turn with no outcome, the nudge / `no_outcome` of the [addendum](#addendum-2026-10-22-turns-without-an-outcome-u-028)).

**`spend.totalUsd` is cumulative for the Claude session, and it survives resume.** The orchestrator stores the last `totalUsd` per `claude_session_id` and adds only the positive delta to `session.spend_usd`. That makes replays and duplicates harmless.

### Fake Claude for E2E (M1-T10)
A fake satisfies the contract **at the process boundary, not the interface**. That way the daemon's real driver, parser and outcome server are all exercised. The fake is an executable selected with `CONDUCTOR_CLAUDE_BIN`, and it must:
1. accept the flags above, and read `--session-id`/`--resume` and `--mcp-config`;
2. read stream-json user messages from stdin, and for each turn emit `system/init` (with the session id), then `assistant`, then `result` (with a cumulative `total_cost_usd`);
3. make `complete_state` / `ask_user` calls as real MCP `tools/call` requests to the URL in `--mcp-config`;
4. stay alive between turns, and exit 0 when stdin closes;
5. follow a scenario file/env (per-turn actions: say, ask_user, complete_state with `$answer`, exit code, crash), with turn state keyed by session id so that a `--resume` continues the script.

The spike prototype (`driver.mjs`) takes `resumeSessionId?`/`sessionId?` in place of `claudeSessionId` + `resume`; the contract above makes resume explicit. `spikes/claude-driver/fake-claude.mjs` (65 lines) already passes the same contract run as the real CLI (`f-driver-contract.mjs`), except for item 5's resume continuity. M1-T12 also ships an in-memory `FakeClaudeDriver` for unit tests of daemon logic above the driver.

## Alternatives considered
| Option | Why not |
|---|---|
| Claude Agent SDK `query()` with streaming input + `createSdkMcpServer` | It works (spike e), and it has typed messages plus `interrupt()`/`canUseTool`. But it adds a package that releases daily and bundles its own CLI binary (262 MB on darwin-arm64) (or needs `pathToClaudeCodeExecutable`). Its in-process tools ride a private `control_request` protocol, so a fake binary would have to reimplement it, or E2E would bypass the real driver. Its isolation defaults are unsafe for us (no `strictMcpConfig` → user connectors attached), and its default system prompt isn't Claude Code's. **Keep it as the migration path** if we need interrupt or a dynamic `canUseTool`. |
| One-shot `claude -p` per turn, answers only via `--resume` | Violates the hard requirement (live process) and pays process start + cache warm-up on every answer. |
| Interactive PTY | We'd be scraping a TUI. There's no structured cost, session id or tool events. |
| `ask_user` blocks until answered (answer = tool result) | HTTP MCP tool calls time out at 60 s (spike c). It also leaves a dangling `tool_use` if the process dies, and gives two different answer paths (live vs resume). |
| Outcome via `--json-schema` structured final output or text parsing | Only covers "done", not "ask". Parsing is fragile. The agent can't call it mid-run. |
| stdio MCP server spawned by Claude, relaying to the daemon over a socket | It's an extra process per session and an extra hop. HTTP served by the daemon itself is simpler and gives the same attribution, via the path token. |

## Consequences
- Good: one answer path (a user message) for live and resumed sessions. Outcomes arrive as typed objects in-process. The fake exercises the real driver. No SDK dependency: the daemon uses whatever `claude` the machine's developer has logged in.
- Good: spend is cumulative and idempotent to account. Every denied tool call is visible in `permission_denials`.
- Bad / accepted cost: we own a small NDJSON parser for an unversioned stream format, and the CLI auto-updates under us. Mitigation: lenient parsing, version recorded, and a nightly `E2E_REAL_CLAUDE=1` run.
- Bad: `ask_user` relies on the model ending its turn when told. The guard refuses `complete_state` while a question is pending. A stray built-in tool call before the turn ends is possible.
- Bad: path-scoped file rules don't confine Bash. `Bash(cat:*)` reads anything, and `git commit` runs repo hooks. A real sandbox is U-004.
- Follow-ups (new unknowns from the T00 report): cross-machine resume needs the transcript file; isolation vs the repo's own `CLAUDE.md`/settings (`--setting-sources ""` drops them); auth model (subscription login vs `ANTHROPIC_API_KEY`/`--bare`) and shared rate limits; minimum supported CLI version.

## Revisit when
- The CLI changes the stream-json shape or the MCP tool-timeout behaviour.
- We need to interrupt a running turn (e.g. a pause button), or to approve tools dynamically. Then move to the Agent SDK, or implement `control_request` `interrupt` ourselves.
- Cross-machine resume becomes a requirement: decide transcript shipping, or accept re-prompting from the checkpointed branch.

## Addendum (2026-10-22): turns without an outcome (U-028)
- **Status**: accepted (Ben, U-028; implemented in M1-T07)

**Context.** A turn can end (`result`, the driver's `turn_end`) without the agent calling `complete_state` or `ask_user`: the model sometimes just stops and summarises. Before this addendum the daemon left the process idle and the card sat in Running until the state's timeout (TD-023), wasting wall time on a common model behaviour.

**Decision.** `turn_end` still stays in the daemon, and now also drives a bounded nudge:
1. A turn ends with neither outcome (and no question pending): the daemon writes **one** user message to the live process, `NO_OUTCOME_NUDGE` = "You must finish by calling complete_state with your result, or ask_user if you need a human" (`daemon/src/daemon.ts`).
2. If the next turn also ends without an outcome, the daemon does not nudge again. It parks the session (process alive and idle, exactly like after `ask_user`) and emits a new `session_event` kind **`no_outcome {last_output}`**: the tail of the agent's assistant text, at most `NO_OUTCOME_OUTPUT_CHARS` = 4000 characters (`shared/src/protocol/ws.ts`).
3. The gateway maps it to the EngineEvent **`agent.no_outcome {last_output}`**, which apply routes exactly like `agent.ask_user`: outcome `ask_user` → `needs_input`, an `input_request` of kind `agent_question` whose question is `NO_OUTCOME_QUESTION` = "Agent stopped without reporting an outcome; last output attached", followed by the last output.
4. The human's answer takes the normal answer path: `send_input` into the live process (or the `--resume` path if it has died). An accepted `send_input` re-arms the nudge, so every human answer buys the agent one more nudge before the next escalation.

Turn errors (`turn_end.isError`, e.g. max turns) are treated the same way; the `--max-budget-usd` / `--max-turns` backstops still bound the nudge's cost.

**Consequences.** Every outcome-less streak costs at most one extra turn before a human sees it, and the loop is bounded by the human (workflow invariant: every failure path ends at a human). The card moves to Needs input with the agent's own last words instead of waiting out the state timeout. The assistant tail lands in `input_request.question` in Postgres, as an `ask_user` question does; it is model text, not terminal output (contrast [U-039](../tracking/UNKNOWNS.md)). `session_event` gains a kind, so this is a protocol change ([03](../design/03-protocols.md), [10](../design/10-contracts.md)).
