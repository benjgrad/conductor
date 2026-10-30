import { API_PATHS } from '@conductor/shared';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendError } from '../api/errors.js';
import { issuerOf } from '../oauth/routes.js';
import { OAUTH_SCOPE, verifyAccessToken } from '../oauth/tokens.js';
import { buildMcpServer, type ToolDeps } from './tools.js';

// ADR-0028: the MCP endpoint. Streamable HTTP, stateless (no Mcp-Session-Id, JSON responses):
// each POST carries a bearer token from /oauth/token and is served by a fresh McpServer bound to
// the token's account. The session cookie is never read here.

export interface McpRouteDeps extends Omit<ToolDeps, 'issuer'> {
  now: () => Date;
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  const { db, auth, now } = deps;

  app.post(API_PATHS.mcp, async (req, reply) => {
    const issuer = issuerOf(auth, req);
    const m = BEARER_RE.exec(req.headers.authorization ?? '');
    const who = m ? await verifyAccessToken(db, m[1]!, now(), auth.mode) : null;
    if (who === null) {
      // RFC 9728 §5.1: where to discover the authorization server.
      const metadata = issuer + API_PATHS.wellKnownProtectedResourceMcp;
      void reply.header(
        'www-authenticate',
        `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"` +
          (m ? ', error="invalid_token"' : ''),
      );
      return sendError(reply, 401, 'unauthorized', m ? 'invalid token' : 'bearer token required');
    }
    reply.hijack();
    const res = reply.raw;
    const server = buildMcpServer({ ...deps, issuer }, who);
    // No sessionIdGenerator → stateless mode.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's own classes disagree under exactOptionalPropertyTypes (onclose?: vs getter).
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req.raw, res, req.body);
    } catch (err) {
      app.log.error(err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });

  // Stateless: no server-initiated stream and no session to delete.
  const notAllowed = (_req: unknown, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send();
  app.get(API_PATHS.mcp, notAllowed);
  app.delete(API_PATHS.mcp, notAllowed);

  return Promise.resolve();
}
