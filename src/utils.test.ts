import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Intercept the `open` package so tests don't actually try to launch a
// browser. The mocked default export returns a never-resolving promise to
// simulate the headless-server case where xdg-open hangs silently.
vi.mock('open', () => ({
  default: vi.fn(
    () =>
      new Promise(() => {
        /* never resolves */
      }),
  ),
}));

import {
  authorizeSpotify,
  formatDuration,
  formatTrackMeta,
  loadTokenCache,
  parseEnvFile,
  resolveStateDir,
  saveTokenCache,
} from './utils.js';

describe('formatDuration', () => {
  it('formats sub-minute durations with leading zero', () => {
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(30_000)).toBe('0:30');
  });

  it('formats multi-minute durations', () => {
    expect(formatDuration(90_000)).toBe('1:30');
    expect(formatDuration(605_000)).toBe('10:05');
  });
});

describe('parseEnvFile', () => {
  it('parses simple key=value lines', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux\n')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('ignores comments and blank lines', () => {
    const input = '# comment\n\nFOO=bar\n  # leading whitespace comment\n';
    expect(parseEnvFile(input)).toEqual({ FOO: 'bar' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile('A="hello"\nB=\'world\'\n')).toEqual({
      A: 'hello',
      B: 'world',
    });
  });

  it('preserves equals signs inside the value', () => {
    expect(parseEnvFile('TOKEN=abc=def=ghi\n')).toEqual({
      TOKEN: 'abc=def=ghi',
    });
  });

  it('round-trips a token cache', () => {
    const tokens = {
      SPOTIFY_ACCESS_TOKEN: 'access-123',
      SPOTIFY_REFRESH_TOKEN: 'refresh-abc',
      SPOTIFY_EXPIRES_AT: '1700000000000',
    };
    const serialized = `${Object.entries(tokens)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`;
    expect(parseEnvFile(serialized)).toEqual(tokens);
  });
});

describe('formatTrackMeta', () => {
  it('returns empty string when no metadata is present', () => {
    expect(formatTrackMeta({})).toBe('');
  });

  it('includes popularity, year, and explicit flag', () => {
    expect(
      formatTrackMeta({
        popularity: 75,
        explicit: true,
        album: { release_date: '2024-03-15' },
      }),
    ).toBe(' [pop 75 · 2024 · E]');
  });

  it('omits the explicit flag when false', () => {
    expect(
      formatTrackMeta({
        popularity: 50,
        explicit: false,
        album: { release_date: '2010' },
      }),
    ).toBe(' [pop 50 · 2010]');
  });

  it('reads release_date from the track when album is missing', () => {
    expect(formatTrackMeta({ release_date: '1999-01-01' })).toBe(' [1999]');
  });

  it('includes popularity of 0 (not falsy-skipped)', () => {
    expect(formatTrackMeta({ popularity: 0 })).toBe(' [pop 0]');
  });
});

describe('resolveStateDir', () => {
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalOverride = process.env.SPOTIFY_MCP_STATE_DIR;
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      Reflect.deleteProperty(process.env, 'SPOTIFY_MCP_STATE_DIR');
    } else {
      process.env.SPOTIFY_MCP_STATE_DIR = originalOverride;
    }
    vi.restoreAllMocks();
  });

  it('uses SPOTIFY_MCP_STATE_DIR override and reports no fallback', () => {
    process.env.SPOTIFY_MCP_STATE_DIR = '/tmp/spotify-mcp-test-override';
    expect(resolveStateDir()).toEqual({
      dir: '/tmp/spotify-mcp-test-override',
      isFallback: false,
    });
  });

  it('uses /etc/spotify-mcp/ when it exists and no override is set', () => {
    Reflect.deleteProperty(process.env, 'SPOTIFY_MCP_STATE_DIR');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => String(p) === '/etc/spotify-mcp',
    );
    expect(resolveStateDir()).toEqual({
      dir: '/etc/spotify-mcp',
      isFallback: false,
    });
  });

  it('falls back to the project directory when no override and /etc is absent', () => {
    Reflect.deleteProperty(process.env, 'SPOTIFY_MCP_STATE_DIR');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = resolveStateDir();
    expect(result.isFallback).toBe(true);
    // Project dir resolves to the repo root (one level above src/), so it
    // must be an absolute path that does not point at /etc/spotify-mcp.
    expect(path.isAbsolute(result.dir)).toBe(true);
    expect(result.dir).not.toBe('/etc/spotify-mcp');
  });

  it('lets the override beat /etc/spotify-mcp/ even when /etc exists', () => {
    process.env.SPOTIFY_MCP_STATE_DIR = '/tmp/explicit-wins';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(resolveStateDir()).toEqual({
      dir: '/tmp/explicit-wins',
      isFallback: false,
    });
  });
});

describe('saveTokenCache + loadTokenCache', () => {
  let tmpDir: string;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-mcp-test-'));
    originalOverride = process.env.SPOTIFY_MCP_STATE_DIR;
    process.env.SPOTIFY_MCP_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalOverride === undefined) {
      Reflect.deleteProperty(process.env, 'SPOTIFY_MCP_STATE_DIR');
    } else {
      process.env.SPOTIFY_MCP_STATE_DIR = originalOverride;
    }
  });

  it('writes tokens to the resolved state directory', () => {
    saveTokenCache({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_700_000_000_000,
    });
    const tokenPath = path.join(tmpDir, '.spotify-tokens');
    expect(fs.existsSync(tokenPath)).toBe(true);
  });

  it('writes the token file with mode 0600', () => {
    saveTokenCache({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const stat = fs.statSync(path.join(tmpDir, '.spotify-tokens'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('round-trips through saveTokenCache and loadTokenCache', () => {
    saveTokenCache({
      accessToken: 'access-xyz',
      refreshToken: 'refresh-xyz',
      expiresAt: 1_700_000_000_000,
    });
    expect(loadTokenCache()).toEqual({
      accessToken: 'access-xyz',
      refreshToken: 'refresh-xyz',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('returns an empty cache when no token file exists', () => {
    expect(loadTokenCache()).toEqual({});
  });
});

describe('authorizeSpotify', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let createServerSpy: ReturnType<typeof vi.spyOn>;
  let createdServers: http.Server[];
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
      SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
      SPOTIFY_REDIRECT_URI: process.env.SPOTIFY_REDIRECT_URI,
    };
    process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
    process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
    // Port 0 lets the OS pick a free port so parallel test runs don't collide.
    process.env.SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:0/callback';

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createdServers = [];
    const realCreate = http.createServer.bind(http);
    createServerSpy = vi.spyOn(http, 'createServer').mockImplementation(((
      handler: http.RequestListener,
    ) => {
      const server = realCreate(handler);
      createdServers.push(server);
      return server;
    }) as typeof http.createServer);
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    createServerSpy.mockRestore();
    await Promise.all(
      createdServers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('prints the authorization URL to stderr before any browser launch', async () => {
    void authorizeSpotify().catch(() => {
      /* promise never resolves in this test path */
    });

    // Wait for server.listen's callback to fire and the URL to be logged.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messages = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    const urlMessage = messages.find((m) =>
      m.startsWith('https://accounts.spotify.com/authorize?'),
    );

    expect(urlMessage).toBeDefined();
    expect(urlMessage).toContain('client_id=test-client-id');
    expect(urlMessage).toContain('state=');
    expect(urlMessage).toContain('redirect_uri=');
  });
});
