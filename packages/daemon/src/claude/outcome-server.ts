// Daemon-hosted MCP outcome server (ADR-0005 §Decision › Outcome server).
//
// One Streamable-HTTP listener per daemon, bound to 127.0.0.1. Each driver session registers a
// random 128-bit path token (`/mcp/<32 hex>`), which attributes every tool call to exactly one
// session; the token is dropped when the session's process exits. The server is stateless: a
// fresh McpServer + transport per POST (the spike's proven shape; no GET SSE stream).
//
// Tools: `complete_state({transition?, reason?, result})` and `ask_user({question})`. Both return
// immediately with the ADR's texts. Guards live here, per registration, so a refused call never
// reaches the driver:
//   - complete_state while a question is pending → corrective text, not emitted
//   - complete_state a second time → corrective text, not emitted
//   - ADR-0011: complete_state naming a transition outside the registration's list (absent =
//     `done`) → corrective text listing the allowed names, not emitted, ONCE; a second unknown
//     name is emitted as is and the engine routes it to a human. No list = any name passes.
//   - ask_user after complete_state, or while a question is already pending → corrective text,
//     not emitted (one open question per session; not in the ADR, see the T05b report)
// The driver clears the pending question when it delivers the answer (`answered()`).
//
// ADR-0023 (M2-T29b): a third tool, `permission`, is Claude's `--permission-prompt-tool`
// (`mcp__conductor__permission`). Claude calls it only when its permission mode would still ask
// (deny rules are evaluated first and never reach it; ADR-0027's `git push` ask rule always does). The call is HELD:
// the registration hands the request to the driver (`onPermissionRequest`, which the daemon sends
// as a durable `permission_request`) and the tool returns only when the request is resolved:
//   - `resolvePermission` (a human's `permission_decision`), at most once per request;
//   - `denyPermission` (the daemon: an old server's `protocol_error` naming the request);
//   - the timeout (`permissionTimeoutMs`, default 30 min, = `expires_at`);
//   - `unregister()` (the process exited) or `close()` (daemon shutdown): every held call is denied.
// Input over PERMISSION_INPUT_MAX_BYTES is denied at once and never sent (U-101); suggestions over
// their bounds are dropped (10-contracts §Permission prompts).
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  COMPLETE_STATE_INPUT_SHAPE,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PERMISSION_INPUT_MAX_BYTES,
  PERMISSION_MESSAGE_MAX,
  PERMISSION_SUGGESTIONS_MAX,
  PERMISSION_SUGGESTIONS_MAX_BYTES,
  PERMISSION_TOOL_MAX,
  jsonByteLength,
  type AgentTransitionOption,
  type JsonObject,
  type PermissionBehavior,
  type PermissionScope,
} from '@conductor/shared';

export const OUTCOME_SERVER_NAME = 'conductor';
export const COMPLETE_STATE_TOOL = `mcp__${OUTCOME_SERVER_NAME}__complete_state`;
export const ASK_USER_TOOL = `mcp__${OUTCOME_SERVER_NAME}__ask_user`;
/**
 * ADR-0023: the `--permission-prompt-tool`. Not in OUTCOME_TOOL_NAMES: Claude's permission system
 * calls it, the model never needs to.
 */
export const PERMISSION_TOOL = `mcp__${OUTCOME_SERVER_NAME}__permission`;
/** The `--allowedTools` entries the driver always adds to the state's allow-list. */
export const OUTCOME_TOOL_NAMES: readonly string[] = [COMPLETE_STATE_TOOL, ASK_USER_TOOL];

// ADR-0023 / 10-contracts §Permission prompts: the deny reasons Claude sees.
/** No human answered before `expires_at`. */
export function permissionTimeoutText(timeoutMs: number): string {
  const min = Math.max(1, Math.round(timeoutMs / 60_000));
  return `Permission denied: no human answered within ${min} min. If you still need this, call ask_user to ask a human, then end your turn.`;
}
/** U-101: the input is over PERMISSION_INPUT_MAX_BYTES; nothing was sent to the board. */
export function permissionTooLargeText(bytes: number): string {
  return `Permission denied: input too large to review (${bytes} bytes)`;
}
export const PERMISSION_TOOL_NAME_TOO_LONG = `Permission denied: the tool name is longer than ${PERMISSION_TOOL_MAX} characters`;
/** A deny without a note. The decision frame names no user, so "a human" (10-contracts). */
export const PERMISSION_DENIED_ON_BOARD = 'Permission denied by a human on the board.';
/** An old conductor server answered the request with `protocol_error`. */
export const PERMISSION_UNSUPPORTED_SERVER =
  "Permission denied: this conductor server can't show permission prompts.";
/** The daemon can't forward prompts at all (no handler wired, or forwarding threw). */
export const PERMISSION_NO_HANDLER =
  "Permission denied: this conductor daemon can't show permission prompts.";
/** The agent's process went away while the call was held (unregister). */
export const PERMISSION_SESSION_ENDED = 'Permission denied: the agent session ended.';
/** The daemon is shutting down (close). */
export const PERMISSION_SHUTDOWN = 'Permission denied: the conductor daemon is shutting down.';

// Return texts (ADR-0005: "Recorded. Stop now" / "sent to a human; end your turn; the answer
// arrives as the next user message"), worded as the spike ran them against the real CLI.
export const COMPLETE_STATE_RETURN =
  'Recorded. Stop now: do not call any other tool and end your turn.';
export const ASK_USER_RETURN =
  'Your question was sent to a human. End your turn now without calling more tools. The answer will arrive as the next user message.';
export const COMPLETE_STATE_PENDING_QUESTION =
  'Not recorded: a question to the human is still pending. End your turn now and wait for the answer, which arrives as the next user message.';
export const COMPLETE_STATE_DUPLICATE =
  'Not recorded: complete_state was already recorded for this state. End your turn now.';
export const ASK_USER_PENDING_QUESTION =
  'Not sent: a question to the human is already pending. End your turn now and wait for the answer.';
export const ASK_USER_AFTER_COMPLETE =
  'Not sent: complete_state was already recorded for this state. End your turn now.';

/** The transition `complete_state` takes when it names none (old prompts, ADR-0011). */
export const DEFAULT_TRANSITION = 'done';

/** ADR-0011 "one corrective nudge": the tool result for a name outside the allowed list. */
export function unknownTransitionText(
  name: string | undefined,
  transitions: readonly AgentTransitionOption[],
): string {
  const named =
    name === undefined
      ? `complete_state named no transition (that means "${DEFAULT_TRANSITION}"), which is not allowed here`
      : `"${name}" is not a transition you can take here`;
  const list = transitions
    .map((t) => `- ${t.name}${t.when !== null ? `: ${t.when}` : ''}`)
    .join('\n');
  return `Not recorded: ${named}. Call complete_state again with \`transition\` set to exactly one of:\n${list}`;
}

/**
 * ADR-0011: whether `complete_state` naming `name` is refused with the corrective text. Only the
 * first unknown name is refused (`nudged` false); no list (old workflows, reviewers) accepts any.
 */
export function refuseTransition(
  transitions: readonly AgentTransitionOption[] | undefined,
  name: string | undefined,
  nudged: boolean,
): boolean {
  if (transitions === undefined || transitions.length === 0 || nudged) return false;
  const effective = name ?? DEFAULT_TRANSITION;
  return !transitions.some((t) => t.name === effective);
}

/** The complete_state tool description, listing the allowed transitions when there are any. */
export function completeStateDescription(
  transitions: readonly AgentTransitionOption[] | undefined,
): string {
  const base =
    "Call exactly once when the current workflow state's work is finished. `result` holds the keys the state asked for. After calling it, stop: do not call any other tool and end your turn.";
  if (transitions === undefined || transitions.length === 0) return base;
  const list = transitions
    .map(
      (t) =>
        `- ${t.name}${t.when !== null ? `: ${t.when}` : ''}${t.question ? ' (a question: `reason` is the question for the human)' : ''}`,
    )
    .join('\n');
  return `${base}\nSet \`transition\` to the move you take and \`reason\` to why. Allowed transitions:\n${list}`;
}

const TOKEN_PATH = /^\/mcp\/([a-f0-9]{32})$/;
// Keep the tools out of the CLI's tool-search deferral, so the model always sees them (spike c).
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

/** ADR-0011: what the agent named in complete_state (absent fields were not given). */
export interface CompleteStateMeta {
  transition?: string;
  reason?: string;
}

/** A held permission prompt, handed to the driver (the daemon sends it as `permission_request`). */
export interface PermissionPrompt {
  /** Fresh uuid: the idempotency key of the request and its decision. */
  requestId: string;
  tool: string;
  /** At most PERMISSION_INPUT_MAX_BYTES of JSON (larger ones are denied before this). */
  input: JsonObject;
  /** Claude's `permission_suggestions`; absent when none or over their bounds. */
  suggestions?: JsonObject[];
  toolUseId?: string;
  /** ISO time the call is denied if nobody answers. */
  expiresAt: string;
}

/** A human's decision (`permission_decision`, minus the command fields). */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  scope: PermissionScope;
  message?: string | undefined;
  rule?: string | undefined;
}

/** What `resolvePermission` did: resolved now, already resolved by a decision, or not held. */
export type PermissionResolution = 'resolved' | 'duplicate' | 'unknown';

/** The permission-prompt-tool reply Claude reads (the tool's text content, as JSON). */
export type PermissionReply =
  | {
      behavior: 'allow';
      updatedInput: JsonObject;
      updatedPermissions?: {
        type: 'addRules';
        rules: { toolName: string; ruleContent?: string }[];
        behavior: 'allow';
        destination: 'session';
      }[];
    }
  | { behavior: 'deny'; message: string };

/** `Bash(pnpm exec tsc -b)` → `{toolName: 'Bash', ruleContent: 'pnpm exec tsc -b'}`; `Read` → `{toolName: 'Read'}`. */
export function parsePermissionRule(rule: string): { toolName: string; ruleContent?: string } {
  const m = /^([^()]+)\(([\s\S]*)\)$/.exec(rule);
  if (m === null) return { toolName: rule };
  return { toolName: m[1]!, ruleContent: m[2]! };
}

/** The reply for a human's decision on `input` (10-contracts §Permission prompts, "What Claude gets"). */
export function permissionReply(input: JsonObject, d: PermissionDecision): PermissionReply {
  if (d.behavior === 'deny') {
    const note = d.message?.trim().slice(0, PERMISSION_MESSAGE_MAX);
    return {
      behavior: 'deny',
      message:
        note !== undefined && note !== ''
          ? `Permission denied by a human on the board: ${note}`
          : PERMISSION_DENIED_ON_BOARD,
    };
  }
  return {
    behavior: 'allow',
    updatedInput: input,
    ...(d.scope === 'always' && d.rule !== undefined
      ? {
          updatedPermissions: [
            {
              type: 'addRules' as const,
              rules: [parsePermissionRule(d.rule)],
              behavior: 'allow' as const,
              destination: 'session' as const,
            },
          ],
        }
      : {}),
  };
}

/** Claude's suggestions within PERMISSION_SUGGESTIONS_MAX / _MAX_BYTES, else undefined (dropped). */
export function boundedSuggestions(v: unknown): JsonObject[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (v.length > PERMISSION_SUGGESTIONS_MAX) return undefined;
  if (!v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) return undefined;
  if (jsonByteLength(v) > PERMISSION_SUGGESTIONS_MAX_BYTES) return undefined;
  return v as JsonObject[];
}

export interface OutcomeHandlers {
  onCompleteState(result: Record<string, unknown>, meta: CompleteStateMeta): void;
  onAskUser(question: string): void;
  /**
   * ADR-0023: a permission prompt is now held. Absent → every prompt is denied at once
   * (PERMISSION_NO_HANDLER).
   */
  onPermissionRequest?(prompt: PermissionPrompt): void;
}

export interface OutcomeRegistration {
  /** 32 lowercase hex chars (128 bits). */
  readonly token: string;
  /** `http://127.0.0.1:<port>/mcp/<token>` */
  readonly url: string;
  /** The `--mcp-config` JSON for this session. */
  readonly mcpConfig: string;
  readonly questionPending: boolean;
  readonly completed: boolean;
  /** The pending question was answered (the answer is being delivered as a user message). */
  answered(): void;
  /** Number of held permission prompts. */
  readonly pendingPermissions: number;
  /**
   * A human's decision for a held prompt. Resolves it at most once: `duplicate` when a decision
   * already resolved it, `unknown` when it isn't held (timed out, denied, never existed).
   */
  resolvePermission(requestId: string, decision: PermissionDecision): PermissionResolution;
  /** Deny a held prompt with `message` (e.g. an old server's protocol_error). False if not held. */
  denyPermission(requestId: string, message: string): boolean;
  /** Drop the token: later calls on it get 404, held prompts are denied. Idempotent. */
  unregister(): void;
}

export interface OutcomeServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  register(handlers: OutcomeHandlers, opts?: OutcomeRegisterOptions): OutcomeRegistration;
  /** Number of live tokens (for tests / diagnostics). */
  readonly size: number;
  close(): Promise<void>;
}

export interface OutcomeRegisterOptions {
  /** ADR-0011 `start_session.transitions`; absent or empty = any name passes. */
  transitions?: readonly AgentTransitionOption[] | undefined;
}

interface HeldPrompt {
  input: JsonObject;
  timer: NodeJS.Timeout;
  settle: (reply: PermissionReply) => void;
}

/** How many decided request ids a registration remembers (for the `duplicate` ack). */
const DECIDED_MAX = 1_000;
/** close(): how long the deny replies of held calls get to flush before the sockets close. */
const CLOSE_FLUSH_MS = 200;

interface Entry {
  handlers: OutcomeHandlers;
  questionPending: boolean;
  completed: boolean;
  transitions: readonly AgentTransitionOption[] | undefined;
  /** The one corrective nudge for an unknown transition was given. */
  nudged: boolean;
  /** ADR-0023: permission prompts held open, by request id. */
  held: Map<string, HeldPrompt>;
  /** Request ids a human decision resolved (insertion-ordered, capped at DECIDED_MAX). */
  decided: Set<string>;
  /** Unregistered: a new prompt is denied at once. */
  closed: boolean;
  timeoutMs: number;
}

function settleHeld(entry: Entry, requestId: string, reply: PermissionReply): boolean {
  const h = entry.held.get(requestId);
  if (h === undefined) return false;
  entry.held.delete(requestId);
  clearTimeout(h.timer);
  h.settle(reply);
  return true;
}

function denyAll(entry: Entry, message: string): void {
  for (const id of [...entry.held.keys()]) settleHeld(entry, id, { behavior: 'deny', message });
}

const PERMISSION_INPUT_SHAPE = {
  tool_name: z.string().min(1).describe('The tool Claude wants to run'),
  input: z.record(z.string(), z.unknown()).describe('The input it wants to run it with'),
  tool_use_id: z.string().optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
};

interface PermissionArgs {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string | undefined;
  permission_suggestions?: unknown[] | undefined;
}

/** The `permission` tool: hold the call until a decision, a deny, the timeout or shutdown. */
function holdPermission(entry: Entry, args: PermissionArgs): Promise<PermissionReply> {
  const deny = (message: string): Promise<PermissionReply> =>
    Promise.resolve({ behavior: 'deny', message });
  if (entry.handlers.onPermissionRequest === undefined) return deny(PERMISSION_NO_HANDLER);
  if (entry.closed) return deny(PERMISSION_SESSION_ENDED);
  if (args.tool_name.length > PERMISSION_TOOL_MAX) return deny(PERMISSION_TOOL_NAME_TOO_LONG);
  const input = args.input as JsonObject;
  const bytes = jsonByteLength(input);
  // U-101: over the bound the daemon denies the call itself and sends nothing.
  if (bytes > PERMISSION_INPUT_MAX_BYTES) return deny(permissionTooLargeText(bytes));
  const requestId = randomUUID();
  const expiresAt = new Date(Date.now() + entry.timeoutMs).toISOString();
  const suggestions = boundedSuggestions(args.permission_suggestions);
  const toolUseId =
    args.tool_use_id !== undefined && args.tool_use_id.length > 0 && args.tool_use_id.length <= 200
      ? args.tool_use_id
      : undefined;
  return new Promise<PermissionReply>((resolve) => {
    const timer = setTimeout(
      () =>
        settleHeld(entry, requestId, {
          behavior: 'deny',
          message: permissionTimeoutText(entry.timeoutMs),
        }),
      entry.timeoutMs,
    );
    timer.unref();
    entry.held.set(requestId, { input, timer, settle: resolve });
    try {
      if (entry.handlers.onPermissionRequest === undefined) throw new Error('no handler');
      entry.handlers.onPermissionRequest({
        requestId,
        tool: args.tool_name,
        input,
        ...(suggestions !== undefined ? { suggestions } : {}),
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        expiresAt,
      });
    } catch {
      // The request could not be forwarded: never strand the agent.
      settleHeld(entry, requestId, { behavior: 'deny', message: PERMISSION_NO_HANDLER });
    }
  });
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function buildServer(entry: Entry): McpServer {
  const s = new McpServer({ name: OUTCOME_SERVER_NAME, version: '0.0.0' });
  s.registerTool(
    'complete_state',
    {
      description: completeStateDescription(entry.transitions),
      inputSchema: COMPLETE_STATE_INPUT_SHAPE,
      _meta: ALWAYS_LOAD,
    },
    ({ result, transition, reason }) => {
      if (entry.questionPending) return text(COMPLETE_STATE_PENDING_QUESTION);
      if (entry.completed) return text(COMPLETE_STATE_DUPLICATE);
      if (refuseTransition(entry.transitions, transition, entry.nudged)) {
        entry.nudged = true;
        return text(unknownTransitionText(transition, entry.transitions ?? []));
      }
      entry.completed = true;
      entry.handlers.onCompleteState(result, {
        ...(transition !== undefined ? { transition } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return text(COMPLETE_STATE_RETURN);
    },
  );
  s.registerTool(
    'ask_user',
    {
      description:
        'Ask the human operator one clear question when you cannot proceed without a decision. The call returns at once; then end your turn. The answer arrives as the next user message.',
      inputSchema: { question: z.string().min(1).describe('One clear question for the human') },
      _meta: ALWAYS_LOAD,
    },
    ({ question }) => {
      if (entry.completed) return text(ASK_USER_AFTER_COMPLETE);
      if (entry.questionPending) return text(ASK_USER_PENDING_QUESTION);
      entry.questionPending = true;
      entry.handlers.onAskUser(question);
      return text(ASK_USER_RETURN);
    },
  );
  // ADR-0023: Claude's --permission-prompt-tool. Not always-loaded: the model never calls it.
  s.registerTool(
    'permission',
    {
      description:
        "Conductor's permission prompt tool: Claude Code calls it when a tool call needs a human's approval. Do not call it yourself.",
      inputSchema: PERMISSION_INPUT_SHAPE,
    },
    async (args) => text(JSON.stringify(await holdPermission(entry, args))),
  );
  return s;
}

export interface OutcomeServerOptions {
  /** Default 0 (an ephemeral port). */
  port?: number;
  /** ADR-0023: deny a held permission prompt after this long. Default DEFAULT_PERMISSION_TIMEOUT_MS. */
  permissionTimeoutMs?: number;
}

export async function startOutcomeServer(opts: OutcomeServerOptions = {}): Promise<OutcomeServer> {
  const entries = new Map<string, Entry>();
  const timeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const srv = http.createServer((req, res) => {
    const m = TOKEN_PATH.exec(req.url ?? '');
    const entry = m?.[1] === undefined ? undefined : entries.get(m[1]);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    // DNS-rebinding guard: only loopback Host headers (the token already makes the path unguessable).
    if (!allowedHosts().has(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end(); // stateless: no GET SSE stream, no DELETE
      return;
    }
    // No sessionIdGenerator → stateless mode.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildServer(entry);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      // The SDK's own classes disagree under exactOptionalPropertyTypes (onclose?: vs getter).
      .connect(transport as unknown as Transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(opts.port ?? 0, '127.0.0.1', () => {
      srv.off('error', reject);
      resolve();
    });
  });
  port = (srv.address() as AddressInfo).port;

  return {
    host: '127.0.0.1',
    port,
    get size() {
      return entries.size;
    },
    register(handlers, opts = {}) {
      const token = randomBytes(16).toString('hex');
      const entry: Entry = {
        handlers,
        questionPending: false,
        completed: false,
        transitions: opts.transitions,
        nudged: false,
        held: new Map(),
        decided: new Set(),
        closed: false,
        timeoutMs,
      };
      entries.set(token, entry);
      const url = `http://127.0.0.1:${port}/mcp/${token}`;
      const mcpConfig = JSON.stringify({
        mcpServers: { [OUTCOME_SERVER_NAME]: { type: 'http', url } },
      });
      return {
        token,
        url,
        mcpConfig,
        get questionPending() {
          return entry.questionPending;
        },
        get completed() {
          return entry.completed;
        },
        answered() {
          entry.questionPending = false;
        },
        get pendingPermissions() {
          return entry.held.size;
        },
        resolvePermission(requestId, decision) {
          const h = entry.held.get(requestId);
          if (h === undefined) return entry.decided.has(requestId) ? 'duplicate' : 'unknown';
          entry.decided.add(requestId);
          if (entry.decided.size > DECIDED_MAX) {
            const oldest = entry.decided.values().next().value;
            if (oldest !== undefined) entry.decided.delete(oldest);
          }
          settleHeld(entry, requestId, permissionReply(h.input, decision));
          return 'resolved';
        },
        denyPermission(requestId, message) {
          return settleHeld(entry, requestId, { behavior: 'deny', message });
        },
        unregister() {
          entries.delete(token);
          entry.closed = true;
          denyAll(entry, PERMISSION_SESSION_ENDED);
        },
      };
    },
    async close() {
      let denied = 0;
      for (const e of entries.values()) {
        e.closed = true;
        denied += e.held.size;
        denyAll(e, PERMISSION_SHUTDOWN);
      }
      entries.clear();
      // Let the held calls' deny replies reach Claude before the sockets are cut.
      if (denied > 0) await new Promise((r) => setTimeout(r, CLOSE_FLUSH_MS));
      return new Promise<void>((resolve, reject) => {
        srv.close((err) => (err ? reject(err) : resolve()));
        srv.closeAllConnections();
      });
    },
  };
}
