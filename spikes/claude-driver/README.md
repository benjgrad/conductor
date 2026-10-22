# Spike M1-T00: driving Claude Code

Throwaway code, not shipped. It answers U-001 (how the daemon drives Claude Code) and U-002 (how the agent signals `complete_state` / `ask_user`). The decision is in [ADR-0005](../../docs/adr/0005-claude-code-driver.md).

Ran against Claude Code **2.1.308** (installed CLI) and `@anthropic-ai/claude-agent-sdk` **0.3.308**, on macOS with Node 20 and `--model haiku`. Total spend for every run was **under $0.06** (list price; this machine is on a subscription login).

```bash
pnpm install --ignore-workspace   # standalone, outside the workspace
pnpm run check                    # zero-cost gate: syntax + driver contract against the fake
node a-stream-json.mjs            # each script below calls the real CLI and costs about $0.001–0.02
```

Each run writes `out/<name>.log` (readable timeline) and `out/<name>.ndjson` (the raw stream). The committed `out/` files are the evidence quoted below.

## Results

| # | Script | Question | Result | Evidence |
|---|---|---|---|---|
| a | `a-stream-json.mjs` | Session id, streaming, cost over `-p --input-format stream-json --output-format stream-json --verbose` | ✅ `system/init` carries `session_id`. The daemon can **pre-assign** it with `--session-id <uuid>`, and init echoes it back. `init` is only emitted once the first user message arrives, and it **repeats at the start of every turn**. `result` carries `total_cost_usd`, `usage`, `modelUsage`, `num_turns` and `permission_denials`. The process **stays alive after `result`** until stdin closes, then exits 0. | `out/a-stream-json.log` |
| b | `b-live-inject.mjs` | Live answer injection (hard requirement), plus the resume fallback | ✅ After a 20 s idle gap, a user message written to the **same stdin** continued the **same session** ("button=green secret=marmalade"). A message written mid-turn is queued and runs as the next turn, with no interleaving. Fallback: after SIGTERM (exit 143), `--resume <id>` with the answer as the first message kept the context and the **same session id**. Resume also works from a different cwd on the same machine. | `out/b-live-inject.log`, `out/b-resume-other-cwd.ndjson` |
| b | (same) | Cost semantics | `total_cost_usd` is **cumulative per Claude session**, and it **carries across `--resume`**: the resumed process reports the previous total plus its own. `usage` is per turn. | `out/b-live-inject.log`, `out/f-driver-contract-real.log` |
| c | `c-mcp-outcome-tools.mjs` + `outcome-server.mjs` | `complete_state` / `ask_user` as MCP tools owned by the daemon | ✅ The daemon hosts a **Streamable HTTP MCP server on 127.0.0.1**, with one random path token per session, passed via `--mcp-config` (with `--strict-mcp-config`). Calls arrive in-process in the daemon as structured objects: `{"kind":"complete_state","result":{"greeting":"howdy"}}`. | `out/c-return.log`, `out/c-block.log` |
| c | (same) | Should `ask_user` block until answered, or return at once? | **Return at once.** In "return" style the tool says "end your turn"; the turn ends, the process idles, and the answer arrives as the next user message. This is the same shape as the resume fallback. "Block" style works for 15 s, but **an HTTP MCP tool call times out after 60 s** ("The operation timed out."), and the model then re-asks or gives up. That makes it unusable for human-scale waits. | `out/c-block-60s-timeout.log` |
| d | `d-tool-restriction.mjs` | Allow-list for unattended edit/bash/git in a worktree | ✅ with path-scoped rules. Flags: `--tools` (which built-ins exist), `--allowedTools` (pre-approved rules), `--disallowedTools`, `--permission-mode dontAsk` and `--permission-prompts none`. Anything not pre-approved is **denied, never prompted**, and appears in `result.permission_denials` and as `system/permission_denied`. **Bare `Write`/`Edit` rules let the agent write outside the worktree.** `Edit(./**)` / `Write(./**)` (or `--restricted`) confine it. Bash rules are literal prefixes: `git -c … commit` does **not** match `Bash(git commit:*)`, so the daemon sets the git identity through env. | `out/d-tool-restriction-{bare-gitc,scoped,restricted}.verdict.log` |
| e | `e-agent-sdk.mjs` | The same through the Agent SDK | ✅ Streaming input (an `AsyncIterable` the daemon pushes into), in-process tools through `createSdkMcpServer`, live injection after the turn ends, `resume`, and `total_cost_usd` all work. The SDK is a typed wrapper over the **same** CLI stream-json protocol, plus private `control_request` messages (`initialize`, `mcp_message`, `interrupt`). Pitfall: **without `strictMcpConfig: true`, the user's claude.ai connectors (9 servers, 119 tools: mail, chat…) were attached to the unattended agent**, at a cost of 83k cache tokens on turn 1. Also, the SDK's default system prompt is minimal, not Claude Code's. | `out/e-agent-sdk.log`, `out/e-agent-sdk-nonstrict.redacted.json` |
| f | `f-driver-contract.mjs` + `driver.mjs` + `fake-claude.mjs` | Does the proposed `ClaudeDriver` contract hold, and can a fake satisfy it? | ✅ The same driver code and the same scenario ran ask_user → park → `sendInput` → complete_state → `end()` → exit 0, then resume. It ran against the **real CLI** and against **`fake-claude.mjs`** (65 lines: stream-json on stdio, and it calls the outcome tools over the MCP URL it gets in `--mcp-config`). | `out/f-driver-contract-{real,fake}.log` |

## Choice (details in ADR-0005)
The daemon spawns the installed `claude` CLI directly in bidirectional stream-json mode, one long-lived child per session. The outcome tools come from a daemon-hosted HTTP MCP server. `ask_user` is non-blocking, and answers are always user messages: on live stdin, or as the first message after `--resume`. The SDK works too, but it adds a dependency that releases daily, it bundles its own CLI binary, and its in-process tools ride a private control protocol that a fake would have to reimplement.

## Limits found (raised as unknowns in the T00 report)
- Resume needs the transcript (`~/.claude/projects/<cwd-slug>/<id>.jsonl`) on the machine that resumes. Cross-machine resume needs that file to be shipped.
- `--setting-sources ""` also skips the target repo's `CLAUDE.md` and `.claude/settings.json`. Built-in skills and plugins still load, and auto-memory is still on (`memory_paths` in init). `--bare` would strip all of it but requires `ANTHROPIC_API_KEY` (no OAuth/subscription login).
- On a subscription login, `total_cost_usd` is a list-price estimate (`modelUsage.*.costBasis: "list"`). Rate limits are shared by every concurrent session on that login, and appear as `rate_limit_event` messages.
- Whether the model obeys "end your turn" after `ask_user` is a matter of compliance (4/4 non-blocking runs on haiku). The driver also refuses `complete_state` while a question is pending.
- Bash allow rules are prefix filters, not a sandbox: `git commit` runs repo hooks, and `Bash(cat:*)` reads any path (U-004).
- The stream-json message schema is not versioned. Claude Code auto-updates (2.1.308 today), so the daemon must parse leniently and record `claude_code_version` from init.
