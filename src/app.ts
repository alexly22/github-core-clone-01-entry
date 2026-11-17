// The server: routes requests to git smart HTTP, REST v3, GraphQL v4, MCP, and health probe

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { handleGitSmartHTTP } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': crypto.randomUUID(), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      // Must come before REST to avoid conflicts
      if (path.match(/^\/[^/]+\/[^/]+\.git\//)) {
        const handled = await handleGitSmartHTTP(req, res);
        if (handled) return;
        // Fall through to 404 if not handled
      }

      // REST v3: /api/v3/...
      if (path.startsWith('/api/v3')) {
        const handled = await handleRest(req, res);
        if (handled) return;
      }

      // GraphQL v4: /api/graphql
      if (method === 'POST' && path === '/api/graphql') {
        const handled = await handleGraphQL(req, res);
        if (handled) return;
      }

      // MCP: /mcp
      if (method === 'POST' && path === '/mcp') {
        const handled = await handleMCP(req, res);
        if (handled) return;
      }

      // Everything else: GitHub's 404 body
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      console.error('[entry] Request handler error:', err);
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}