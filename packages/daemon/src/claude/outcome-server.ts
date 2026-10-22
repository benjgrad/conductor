// Daemon-hosted MCP outcome server (ADR-0005 §Decision › Outcome server).
//
// One Streamable-HTTP listener per daemon, bound to 127.0.0.1. Each driver session registers a
// random 128-bit path token (`/mcp/<32 hex>`), which attributes every tool call to exactly one
// session; the token is dropped when the session's process exits. The server is stateless: a
// fresh McpServer + transport per POST (the spike's proven shape; no GET SSE stream).
//
// Tools: `complete_state({result})` and `ask_user({question})`. Both return immediately with the
// ADR's texts. Guards live here, per registration, so a refused call never reaches the driver:
//   - complete_state while a question is pending → corrective text, not emitted
//   - complete_state a second time → corrective text, not emitted
//   - ask_user after complete_state, or while a question is already pending → corrective text,
//     not emitted (one open question per session; not in the ADR, see the T05b report)
// The driver clears the pending question when it delivers the answer (`answered()`).
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

export const OUTCOME_SERVER_NAME = 'conductor';
export const COMPLETE_STATE_TOOL = `mcp__${OUTCOME_SERVER_NAME}__complete_state`;
export const ASK_USER_TOOL = `mcp__${OUTCOME_SERVER_NAME}__ask_user`;
/** The `--allowedTools` entries the driver always adds to the state's allow-list. */
export const OUTCOME_TOOL_NAMES: readonly string[] = [COMPLETE_STATE_TOOL, ASK_USER_TOOL];

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

const TOKEN_PATH = /^\/mcp\/([a-f0-9]{32})$/;
// Keep the tools out of the CLI's tool-search deferral, so the model always sees them (spike c).
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

export interface OutcomeHandlers {
  onCompleteState(result: Record<string, unknown>): void;
  onAskUser(question: string): void;
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
  /** Drop the token: later calls on it get 404. Idempotent. */
  unregister(): void;
}

export interface OutcomeServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  register(handlers: OutcomeHandlers): OutcomeRegistration;
  /** Number of live tokens (for tests / diagnostics). */
  readonly size: number;
  close(): Promise<void>;
}

interface Entry {
  handlers: OutcomeHandlers;
  questionPending: boolean;
  completed: boolean;
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function buildServer(entry: Entry): McpServer {
  const s = new McpServer({ name: OUTCOME_SERVER_NAME, version: '0.0.0' });
  s.registerTool(
    'complete_state',
    {
      description:
        "Call exactly once when the current workflow state's work is finished. `result` holds the keys the state asked for. After calling it, stop: do not call any other tool and end your turn.",
      inputSchema: {
        result: z.record(z.string(), z.unknown()).describe('Structured outcome of this state'),
      },
      _meta: ALWAYS_LOAD,
    },
    ({ result }) => {
      if (entry.questionPending) return text(COMPLETE_STATE_PENDING_QUESTION);
      if (entry.completed) return text(COMPLETE_STATE_DUPLICATE);
      entry.completed = true;
      entry.handlers.onCompleteState(result);
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
  return s;
}

export interface OutcomeServerOptions {
  /** Default 0 (an ephemeral port). */
  port?: number;
}

export async function startOutcomeServer(opts: OutcomeServerOptions = {}): Promise<OutcomeServer> {
  const entries = new Map<string, Entry>();
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
    register(handlers) {
      const token = randomBytes(16).toString('hex');
      const entry: Entry = { handlers, questionPending: false, completed: false };
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
        unregister() {
          entries.delete(token);
        },
      };
    },
    close() {
      entries.clear();
      return new Promise<void>((resolve, reject) => {
        srv.close((err) => (err ? reject(err) : resolve()));
        srv.closeAllConnections();
      });
    },
  };
}
