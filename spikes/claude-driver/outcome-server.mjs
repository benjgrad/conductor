// The daemon-owned MCP server that exposes complete_state / ask_user.
// One HTTP listener on 127.0.0.1 per daemon; each driver session gets its own
// unguessable path token, so a call is attributed to exactly one session and
// no other local process can forge it without the token.
// Stateless Streamable HTTP: a fresh McpServer + transport per request.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const SERVER_NAME = 'conductor';
export const TOOL_NAMES = [`mcp__${SERVER_NAME}__complete_state`, `mcp__${SERVER_NAME}__ask_user`];

const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true }; // keep the tools out of tool-search deferral

/**
 * handlers: {
 *   completeState(result) -> Promise<string>  text returned to the model
 *   askUser(question)     -> Promise<string>  text returned to the model
 * }
 */
function buildServer(handlers) {
  const s = new McpServer({ name: SERVER_NAME, version: '0.0.0' });
  s.registerTool('complete_state', {
    description: 'Call exactly once when the current workflow state\'s work is finished. `result` holds the keys the state asked for. After calling it, stop: do not call any other tool.',
    inputSchema: { result: z.record(z.string(), z.unknown()).describe('Structured outcome of this state') },
    _meta: ALWAYS_LOAD,
  }, async ({ result }) => ({ content: [{ type: 'text', text: await handlers.completeState(result) }] }));
  s.registerTool('ask_user', {
    description: 'Ask the human operator a question when you cannot proceed without a decision. Ask one clear question.',
    inputSchema: { question: z.string().min(1) },
    _meta: ALWAYS_LOAD,
  }, async ({ question }) => ({ content: [{ type: 'text', text: await handlers.askUser(question) }] }));
  return s;
}

export async function startOutcomeServer() {
  const sessions = new Map(); // token -> handlers
  const srv = http.createServer(async (req, res) => {
    const m = /^\/mcp\/([a-f0-9]{32})$/.exec(req.url ?? '');
    const handlers = m && sessions.get(m[1]);
    if (!handlers) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; } // stateless: no GET SSE stream
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildServer(handlers);
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    port,
    /** Register a session; returns the --mcp-config JSON string for it. */
    register(handlers) {
      const token = randomBytes(16).toString('hex');
      sessions.set(token, handlers);
      const mcpConfig = JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}` } } });
      return { token, mcpConfig, unregister: () => sessions.delete(token) };
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}
