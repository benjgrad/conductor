// Claude Code driver contract, pinned verbatim from ADR-0005 §Contract (accepted 2026-10-22).
// Do NOT reshape this from spikes/claude-driver/driver.mjs (TD-002). The real implementation
// (spawn `claude -p` in stream-json mode + daemon-hosted MCP outcome server) is M1-T05/T07.
//
// Mapping to WS session_event kinds (03): `claude_session_id`, `ask_user`, `complete_state`,
// `spend` and `exit` are forwarded as-is (snake_cased; `spend` gains `claude_session_id`).
// `output` goes to the WS `output` message. `turn_end` stays inside the daemon (park / end).
// `tools` is built from the state's workflow `tools` list with `resolveToolPolicy` (shared
// workflow/tools.ts, TOOL_ALIASES).

import type {
  AgentTransitionOption,
  JsonObject,
  PermissionBehavior,
  PermissionScope,
} from '@conductor/shared';

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
  /**
   * ADR-0009: a requirements reviewer. Runs with `--permission-mode dontAsk` whatever the user's
   * mode (the one exception to ADR-0006's inherited mode): only its pre-approved read-only rules
   * run, everything else is denied without prompting.
   */
  review?: boolean;
  /**
   * ADR-0011: `start_session.transitions`, the names the outcome server accepts in
   * `complete_state` (one corrective nudge for another name). Absent or empty = any name.
   */
  transitions?: AgentTransitionOption[];
}

export type DriverEvent =
  | { kind: 'claude_session_id'; id: string } // once, from the first system/init
  | {
      kind: 'output';
      stream: 'assistant' | 'tool_use' | 'tool_result' | 'stderr' | 'debug';
      text: string;
    }
  | { kind: 'ask_user'; question: string }
  /**
   * ADR-0023 (M2-T29b): Claude called the `permission` prompt tool; the call is held until
   * `resolvePermission` / `denyPermission`, its timeout at `expiresAt`, or the process exits. The
   * daemon forwards it as a durable `permission_request`.
   */
  | {
      kind: 'permission_request';
      requestId: string;
      tool: string;
      input: JsonObject;
      suggestions?: JsonObject[];
      toolUseId?: string;
      expiresAt: string;
    }
  | {
      kind: 'complete_state';
      result: Record<string, unknown>;
      /** ADR-0011: the transition the agent named (absent = `done`), and why. */
      transition?: string;
      reason?: string;
    }
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
  /**
   * BUG-1 amendment to ADR-0005: the OS pid of the Claude process (the leader of its own process
   * group), when there is one. The daemon persists it so that, after a restart, it can kill a
   * process the previous daemon left behind (the CLI driver spawns it detached).
   */
  readonly pid?: number | undefined;
  on(listener: (ev: DriverEvent) => void): () => void;
  sendInput(text: string): void; // live answer injection; queued by Claude if a turn is running
  /**
   * ADR-0007: a human's message to the running agent. Written like sendInput (a stream-json user
   * message; Claude folds it into the current turn, and runs a `/...` text as a slash command),
   * but it is not an answer: a pending ask_user question stays pending.
   */
  sendMessage(text: string): void;
  /**
   * ADR-0023: a human's decision for a held permission prompt. `resolved` the first time,
   * `duplicate` for a request a decision already resolved, `unknown` for one not held (timed
   * out, denied, process gone). Optional: a driver without permission prompts holds none.
   */
  resolvePermission?(
    requestId: string,
    decision: {
      behavior: PermissionBehavior;
      scope: PermissionScope;
      message?: string | undefined;
      rule?: string | undefined;
    },
  ): 'resolved' | 'duplicate' | 'unknown';
  /** ADR-0023: deny a held permission prompt with `message`. False when it isn't held. */
  denyPermission?(requestId: string, message: string): boolean;
  end(): void; // graceful: close stdin → exit 0
  kill(graceMs?: number): void; // SIGTERM, then SIGKILL after graceMs
}

export interface ClaudeDriver {
  start(opts: DriverStartOptions): DriverSession;
}
