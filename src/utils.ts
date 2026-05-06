import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import dotenv from 'dotenv';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.join(__dirname, '..');
const SYSTEM_STATE_DIR = '/etc/spotify-mcp';
const FALLBACK_DEPRECATION_MESSAGE =
  '[deprecation] Loading state from project directory; move .env and .spotify-tokens to /etc/spotify-mcp/ (will be removed in v2.0)';

let hasWarnedAboutFallback = false;

/**
 * Resolve where to look for `.env` and `.spotify-tokens`.
 *
 * Order:
 *   1. `SPOTIFY_MCP_STATE_DIR` env override — explicit, no fallback, no warning.
 *   2. `/etc/spotify-mcp/` if it exists on disk.
 *   3. The project directory (`__dirname/..`) as a backward-compat fallback.
 *
 * The override is the seam used by the installer's tests and by Mac dev
 * workflows that want to keep state in the checkout without triggering the
 * deprecation warning.
 */
export function resolveStateDir(): { dir: string; isFallback: boolean } {
  const override = process.env.SPOTIFY_MCP_STATE_DIR;
  if (override) return { dir: override, isFallback: false };
  if (fs.existsSync(SYSTEM_STATE_DIR)) {
    return { dir: SYSTEM_STATE_DIR, isFallback: false };
  }
  return { dir: PROJECT_DIR, isFallback: true };
}

function warnFallbackOnce(): void {
  if (hasWarnedAboutFallback) return;
  hasWarnedAboutFallback = true;
  console.error(FALLBACK_DEPRECATION_MESSAGE);
}

function tokenFilePath(): string {
  return path.join(resolveStateDir().dir, '.spotify-tokens');
}

/**
 * Load `.env` from the resolved state directory. Replaces the
 * `import 'dotenv/config'` side-effect import the entry points used to do.
 *
 * Must run before any module that reads `process.env` at import time —
 * call this on the very first line of `index.ts` and `auth.ts`.
 */
export function loadDotenv(): void {
  const { dir, isFallback } = resolveStateDir();
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;
  dotenv.config({ path: envPath });
  if (isFallback) warnFallbackOnce();
}

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SpotifyTokenCache {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export function loadCredentials(): SpotifyCredentials {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  if (!(clientId && clientSecret && redirectUri)) {
    throw new Error(
      'Missing Spotify credentials. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI in your .env file. See .env.example for guidance.',
    );
  }

  return { clientId, clientSecret, redirectUri };
}

export function loadTokenCache(): SpotifyTokenCache {
  const { dir, isFallback } = resolveStateDir();
  const tokenFile = path.join(dir, '.spotify-tokens');
  if (!fs.existsSync(tokenFile)) return {};
  if (isFallback) warnFallbackOnce();

  const contents = fs.readFileSync(tokenFile, 'utf8');
  const parsed = parseEnvFile(contents);
  const expiresAtRaw = parsed.SPOTIFY_EXPIRES_AT;
  return {
    accessToken: parsed.SPOTIFY_ACCESS_TOKEN,
    refreshToken: parsed.SPOTIFY_REFRESH_TOKEN,
    expiresAt: expiresAtRaw ? Number(expiresAtRaw) : undefined,
  };
}

export function saveTokenCache(tokens: SpotifyTokenCache): void {
  const tokenFile = tokenFilePath();
  const lines: string[] = [];
  if (tokens.accessToken) {
    lines.push(`SPOTIFY_ACCESS_TOKEN=${tokens.accessToken}`);
  }
  if (tokens.refreshToken) {
    lines.push(`SPOTIFY_REFRESH_TOKEN=${tokens.refreshToken}`);
  }
  if (tokens.expiresAt !== undefined) {
    lines.push(`SPOTIFY_EXPIRES_AT=${tokens.expiresAt}`);
  }
  fs.writeFileSync(tokenFile, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // Ensure mode is correct even if the file already existed.
  fs.chmodSync(tokenFile, 0o600);
}

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

let cachedSpotifyApi: SpotifyApi | null = null;

export async function createSpotifyApi(): Promise<SpotifyApi> {
  const credentials = loadCredentials();
  const tokens = loadTokenCache();

  if (tokens.accessToken && tokens.refreshToken) {
    const now = Date.now();
    const shouldRefresh = !tokens.expiresAt || tokens.expiresAt <= now;

    if (shouldRefresh) {
      console.error('Access token expired or missing expiration, refreshing…');
      try {
        const refreshed = await refreshAccessToken(
          credentials,
          tokens.refreshToken,
        );
        tokens.accessToken = refreshed.access_token;
        tokens.expiresAt = now + refreshed.expires_in * 1000;
        if (refreshed.refresh_token) {
          tokens.refreshToken = refreshed.refresh_token;
        }
        saveTokenCache(tokens);
        console.error('Access token refreshed successfully');
        cachedSpotifyApi = null;
      } catch (error) {
        console.error('Failed to refresh token:', error);
        throw new Error(
          'Failed to refresh access token. Run `npm run auth` to re-authenticate.',
        );
      }
    }

    if (cachedSpotifyApi) return cachedSpotifyApi;

    const accessToken = {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(
        ((tokens.expiresAt ?? now + 3600000) - now) / 1000,
      ),
      refresh_token: tokens.refreshToken,
    };

    cachedSpotifyApi = SpotifyApi.withAccessToken(
      credentials.clientId,
      accessToken,
    );
    return cachedSpotifyApi;
  }

  // Fallback: no user tokens — client-credentials flow (read-only, no user scopes).
  cachedSpotifyApi = SpotifyApi.withClientCredentials(
    credentials.clientId,
    credentials.clientSecret,
  );
  return cachedSpotifyApi;
}

export async function getCurrentAccessToken(): Promise<string> {
  await createSpotifyApi();
  const tokens = loadTokenCache();
  if (!tokens.accessToken) {
    throw new Error('No access token available. Run `npm run auth` first.');
  }
  return tokens.accessToken;
}

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        b % 62,
      ),
    )
    .join('');
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64');
}

async function exchangeCodeForToken(
  code: string,
  credentials: SpotifyCredentials,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = `Basic ${base64Encode(`${credentials.clientId}:${credentials.clientSecret}`)}`;

  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', credentials.redirectUri);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to exchange code for token: ${errorData}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 3600,
  };
}

async function refreshAccessToken(
  credentials: SpotifyCredentials,
  refreshToken: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = `Basic ${base64Encode(`${credentials.clientId}:${credentials.clientSecret}`)}`;

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to refresh access token: ${errorData}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 3600,
  };
}

export async function authorizeSpotify(): Promise<void> {
  const credentials = loadCredentials();

  const redirectUri = new URL(credentials.redirectUri);
  if (
    redirectUri.hostname !== 'localhost' &&
    redirectUri.hostname !== '127.0.0.1'
  ) {
    console.error(
      'Error: SPOTIFY_REDIRECT_URI must use localhost or 127.0.0.1 for automatic token exchange',
    );
    console.error('Example: http://127.0.0.1:8888/callback');
    process.exit(1);
  }

  const port = redirectUri.port || '80';
  const callbackPath = redirectUri.pathname || '/callback';

  const state = generateRandomString(16);

  const scopes = [
    'user-read-private',
    'user-read-email',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-read',
    'user-library-modify',
    'user-read-recently-played',
  ];

  const authParams = new URLSearchParams({
    client_id: credentials.clientId,
    response_type: 'code',
    redirect_uri: credentials.redirectUri,
    scope: scopes.join(' '),
    state,
    show_dialog: 'true',
  });

  const authorizationUrl = `https://accounts.spotify.com/authorize?${authParams.toString()}`;

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) return res.end('No URL provided');

      const reqUrl = new URL(req.url, `http://localhost:${port}`);

      if (reqUrl.pathname === callbackPath) {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          console.error(`Authorization error: ${error}`);
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (returnedState !== state) {
          console.error('State mismatch error');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>State verification failed. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        if (!code) {
          console.error('No authorization code received');
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>No authorization code received. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const tokens = await exchangeCodeForToken(code, credentials);
          saveTokenCache({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
          });

          res.end(
            '<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to the application.</p></body></html>',
          );
          console.error(
            `Authentication successful! Tokens saved to ${tokenFilePath()} (mode 0600).`,
          );

          server.close();
          resolve();
        } catch (err) {
          console.error('Token exchange error:', err);
          res.end(
            '<html><body><h1>Authentication Failed</h1><p>Failed to exchange authorization code for tokens. Please close this window and try again.</p></body></html>',
          );
          server.close();
          reject(err);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(Number.parseInt(port), '127.0.0.1', () => {
      console.error(
        `Listening for Spotify authentication callback on port ${port}`,
      );
      console.error('');
      console.error('Open this URL in your browser to authorize:');
      console.error('');
      console.error(authorizationUrl);
      console.error('');
      console.error(`Waiting for callback on ${credentials.redirectUri} …`);

      // Best-effort browser launch — no-op on headless systems where
      // the user already has the URL above and can paste it manually.
      open(authorizationUrl).catch(() => {});
    });

    server.on('error', (error) => {
      console.error(`Server error: ${error.message}`);
      reject(error);
    });
  });
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

// Compact metadata suffix for one-line track listings: popularity, release
// year, and an "E" flag for explicit. Returns "" when nothing is available
// so the caller can do `${formatDuration(...)}${formatTrackMeta(track)}`
// without conditional plumbing.
export function formatTrackMeta(track: {
  popularity?: number | null;
  explicit?: boolean | null;
  album?: { release_date?: string | null } | null;
  release_date?: string | null;
}): string {
  const parts: string[] = [];
  if (typeof track.popularity === 'number') {
    parts.push(`pop ${track.popularity}`);
  }
  const releaseDate = track.release_date ?? track.album?.release_date ?? null;
  if (releaseDate) {
    // release_date can be year, year-month, or year-month-day; first 4 chars
    // are always the year.
    parts.push(releaseDate.slice(0, 4));
  }
  if (track.explicit) parts.push('E');
  return parts.length ? ` [${parts.join(' · ')}]` : '';
}

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Direct HTTP path to Spotify, used for endpoints the SDK can't reach because
// `@spotify/web-api-ts-sdk@1.2.0` (latest, dormant since 2024) hasn't been
// updated for the Feb 2026 API migration. Auth + refresh are reused from
// `getCurrentAccessToken`; we don't fork the auth layer.
export async function spotifyFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const accessToken = await getCurrentAccessToken();
  const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Spotify API ${response.status} ${response.statusText}: ${path}${body ? ` ${body}` : ''}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function handleSpotifyRequest<T>(
  action: (spotifyApi: SpotifyApi) => Promise<T>,
): Promise<T> {
  try {
    const spotifyApi = await createSpotifyApi();
    return await action(spotifyApi);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes('Unexpected token') ||
      errorMessage.includes('Unexpected non-whitespace character') ||
      errorMessage.includes('Exponent part is missing a number in JSON')
    ) {
      // Spotify often returns empty 200/204 for write endpoints; the SDK then
      // fails JSON parsing. Treat these as success.
      return undefined as T;
    }
    throw error;
  }
}
