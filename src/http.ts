import crypto from 'node:crypto';
import http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpServerConfig {
  host: string;
  port: number;
  token: string;
  path: string;
}

export type McpServerFactory = () => McpServer;

// Sessions abandoned without a clean close (network blip, force-quit) are
// evicted after this much inactivity so the map doesn't grow unboundedly.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

export function loadHttpConfig(): HttpServerConfig {
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token || token.length < 16) {
    throw new Error(
      'MCP_HTTP_TOKEN must be set to a non-empty value at least 16 characters long. Generate one with: openssl rand -hex 32',
    );
  }
  return {
    host: process.env.MCP_HTTP_HOST ?? '127.0.0.1',
    port: Number(process.env.MCP_HTTP_PORT ?? '3000'),
    token,
    path: process.env.MCP_HTTP_PATH ?? '/mcp',
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return constantTimeEquals(match[1], token);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJsonRpcError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32600, message },
      id: null,
    }),
  );
}

/**
 * Start the HTTP MCP transport.
 *
 * Each MCP session gets its own `StreamableHTTPServerTransport` and `McpServer`
 * instance. Sessions are routed by the `Mcp-Session-Id` header on every
 * request after `initialize`. Without per-session state, the SDK's "Server
 * already initialized" error trips on the second client connect and the
 * service becomes useless until restart.
 */
export async function startHttpServer(
  createServer: McpServerFactory,
  config: HttpServerConfig,
): Promise<HttpServerHandle> {
  const sessions = new Map<string, Session>();

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== config.path) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
      return;
    }
    if (!isAuthorized(req, config.token)) {
      res
        .writeHead(401, {
          'Content-Type': 'text/plain',
          'WWW-Authenticate': 'Bearer',
        })
        .end('Unauthorized');
      return;
    }

    const body =
      req.method === 'POST' || req.method === 'PUT'
        ? await readBody(req)
        : undefined;

    const sessionId = req.headers['mcp-session-id'];
    const headerSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (headerSessionId) {
      const session = sessions.get(headerSessionId);
      if (!session) {
        writeJsonRpcError(
          res,
          404,
          `Unknown Mcp-Session-Id '${headerSessionId}'. Send an initialize request without a session header to start a new session.`,
        );
        return;
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session header → must be a brand-new initialize request.
    if (!isInitializeRequest(body)) {
      writeJsonRpcError(
        res,
        400,
        'Invalid Request: missing Mcp-Session-Id; first request must be initialize',
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newId) => {
        sessions.set(newId, { transport, lastActivity: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const mcpServer = createServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  let boundPort = config.port;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') boundPort = addr.port;
      console.error(
        `Spotify MCP server listening on http://${config.host}:${boundPort}${config.path}`,
      );
      resolve();
    });
  });

  const idleSweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [id, session] of sessions) {
      if (session.lastActivity < cutoff) {
        session.transport.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, IDLE_SWEEP_MS);
  idleSweep.unref();

  const shutdown = async () => {
    console.error('Shutting down…');
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  async function close(): Promise<void> {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    clearInterval(idleSweep);
    await Promise.all(
      Array.from(sessions.values()).map((s) =>
        s.transport.close().catch(() => {}),
      ),
    );
    sessions.clear();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  return { port: boundPort, close };
}
