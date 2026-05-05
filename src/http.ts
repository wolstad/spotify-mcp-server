import crypto from 'node:crypto';
import http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpServerConfig {
  host: string;
  port: number;
  token: string;
  path: string;
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

export async function startHttpServer(
  server: McpServer,
  config: HttpServerConfig,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

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
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      console.error(
        `Spotify MCP server listening on http://${config.host}:${config.port}${config.path}`,
      );
      resolve();
    });
  });

  const shutdown = async () => {
    console.error('Shutting down…');
    await transport.close();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
