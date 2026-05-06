import http from 'node:http';
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
  parseEnvFile,
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
