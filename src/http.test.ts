import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HttpServerHandle, startHttpServer } from './http.js';

const TEST_TOKEN = 'a'.repeat(32);

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

function createTestServer(): McpServer {
  return new McpServer({ name: 'test-server', version: '0.0.0' });
}

async function postInitialize(
  port: number,
  sessionId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TEST_TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(INITIALIZE_BODY),
  });
}

describe('startHttpServer (per-session transport)', () => {
  let handle: HttpServerHandle;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle = await startHttpServer(createTestServer, {
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      path: '/mcp',
    });
  });

  afterEach(async () => {
    await handle.close();
    consoleErrorSpy.mockRestore();
  });

  it('two consecutive initialize requests both succeed with distinct session IDs', async () => {
    const resA = await postInitialize(handle.port);
    expect(resA.status).toBe(200);
    const sessionA = resA.headers.get('mcp-session-id');
    expect(sessionA).toBeTruthy();
    await resA.body?.cancel();

    const resB = await postInitialize(handle.port);
    expect(resB.status).toBe(200);
    const sessionB = resB.headers.get('mcp-session-id');
    expect(sessionB).toBeTruthy();
    await resB.body?.cancel();

    expect(sessionA).not.toBe(sessionB);
  });

  it('rejects requests with no session header that are not initialize', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('initialize');
  });

  it('rejects requests with an unknown session ID', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': 'does-not-exist',
      },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  // Regression test: previously, when the SDK's transport.onclose fired (which
  // happens when an SSE stream disconnects — e.g. a client's long-lived GET
  // /mcp channel closes after a timeout, or Claude Desktop's 60s budget fires
  // mid-response), the server eagerly deleted the session from its map. Every
  // subsequent request from that client then returned 404 "Unknown
  // Mcp-Session-Id" until the client restarted. The fix removed the eager
  // deletion; sessions now outlive individual streams.
  it('keeps the session alive when a long-lived SSE stream is aborted', async () => {
    const initRes = await postInitialize(handle.port);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    // Open the server-initiated message stream (GET /mcp) and abort it. This
    // is the connection that triggers transport.onclose in real clients.
    const aborter = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId as string,
      },
      signal: aborter.signal,
    }).catch((err) => err as Error);
    // The GET may either succeed (we then abort) or be rejected immediately
    // depending on SDK version; either way we want the connection torn down.
    if (sseRes instanceof Response) {
      aborter.abort();
      await sseRes.body?.cancel().catch(() => {});
    }
    // Give the server time to observe the closed stream and run any handlers.
    await new Promise((r) => setTimeout(r, 50));

    // The session must still be usable.
    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(followUp.status).toBe(200);
    await followUp.body?.cancel();
  });

  it('terminates a session via DELETE and 404s subsequent requests', async () => {
    const initRes = await postInitialize(handle.port);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    const del = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId as string,
      },
    });
    expect(del.status).toBe(204);

    const after = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
    await after.body?.cancel();
  });

  it('rejects DELETE without a session header', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });
});
