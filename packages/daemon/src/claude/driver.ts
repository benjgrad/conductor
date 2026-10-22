// Claude Code driver contract, pinned verbatim from ADR-0005 §Contract (accepted 2026-10-22).
// Do NOT reshape this from spikes/claude-driver/driver.mjs (TD-002). The real implementation
// (spawn `claude -p` in stream-json mode + daemon-hosted MCP outcome server) is M1-T05/T07.
//
// Mapping to WS session_event kinds (03): `claude_session_id`, `ask_user`, `complete_state`,
// `spend` and `exit` are forwarded as-is (snake_cased; `spend` gains `claude_session_id`).
// `output` goes to the WS `output` message. `turn_end` stays inside the daemon (park / end).
// `tools` is built from the state's workflow `tools` list with `resolveToolPolicy` (shared
// workflow/tools.ts, TOOL_ALIASES).

export interface ToolPolicy {
  builtin: string[]; // --tools, e.g. ["Read","Edit","Write","Glob","Grep","Bash"]
  allow: string[]; // --allowedTools rules, e.g. ["Edit(./**)","Bash(git commit:*)"]
  deny: string[]; // --disallowedTools rules, e.g. ["Bash(git push:*)","WebFetch"]
}

export interface DriverStartOptions {
  cwd: string; // session worktree
  prompt: string; // first user message (the answer, when resuming after ask_user)
  tools: ToolPolicy;
  claudeSessionId: string; // pre-assigned by the daemon (new) or the id to resume
  resume: boolean; // true → --resume claudeSessionId, else --session-id
  env: Record<string, string>; // merged over the daemon env (ports, git identity)
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number; // remaining workflow budget, passed as a hard backstop
  appendSystemPrompt?: string; // conductor instructions (how to use complete_state / ask_user)
}

export type DriverEvent =
  | { kind: 'claude_session_id'; id: string } // once, from the first system/init
  | {
      kind: 'output';
      stream: 'assistant' | 'tool_use' | 'tool_result' | 'stderr' | 'debug';
      text: string;
    }
  | { kind: 'ask_user'; question: string }
  | { kind: 'complete_state'; result: Record<string, unknown> }
  | { kind: 'turn_end'; isError: boolean; subtype: string; permissionDenials: number } // process now idle
  | {
      kind: 'spend';
      totalUsd: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      };
    }
  | { kind: 'exit'; code: number | null; signal: string | null };

export interface DriverSession {
  readonly claudeSessionId: string;
  on(listener: (ev: DriverEvent) => void): () => void;
  sendInput(text: string): void; // live answer injection; queued by Claude if a turn is running
  end(): void; // graceful: close stdin → exit 0
  kill(graceMs?: number): void; // SIGTERM, then SIGKILL after graceMs
}

export interface ClaudeDriver {
  start(opts: DriverStartOptions): DriverSession;
}
