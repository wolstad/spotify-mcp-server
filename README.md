<div align="center" style="display: flex; align-items: center; justify-content: center; gap: 10px;">
<img src="https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg" width="30" height="30">
<h1>Spotify MCP Server</h1>
</div>

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets any MCP client control Spotify playback and manage playlists. Built to run as a native Node service — locally for stdio MCP clients, or on a LAN host (e.g. a Proxmox LXC) over HTTP.

> **This is a fork of [marcelmarais/spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server).** See [What's different in this fork](#whats-different-in-this-fork) for the changes.

<details>
<summary>Contents</summary>

- [What's different in this fork](#whats-different-in-this-fork)
- [Quick start (local, stdio)](#quick-start-local-stdio)
- [Remote install on a Proxmox LXC (HTTP transport)](#remote-install-on-a-proxmox-lxc-http-transport)
- [Authentication & token refresh](#authentication--token-refresh)
- [Integrating with MCP clients](#integrating-with-mcp-clients)
- [Tools](#tools)
  - [Metadata enrichment (for organizing playlists)](#metadata-enrichment-for-organizing-playlists)
- [Known limitations](#known-limitations)
- [Development](#development)
</details>

## What's different in this fork

This fork is based on upstream commit [`969576b`](https://github.com/marcelmarais/spotify-mcp-server/commit/969576b) (the latest as of writing). The differences are infrastructure plus three metadata-enrichment tools added on top.

- **HTTP transport with bearer-token auth.** Set `MCP_TRANSPORT=http` to start a long-running HTTP MCP service (`StreamableHTTPServerTransport`), protected by `MCP_HTTP_TOKEN` (constant-time compared on every request). Stdio remains the default. Upstream is stdio-only.
- **Systemd unit template** in `deploy/spotify-mcp.service` — designed for installing the HTTP service on a small LXC or VM with sensible hardening (`NoNewPrivileges`, `ProtectSystem=strict`, restricted address families).
- **Env-only configuration.** Credentials live in `.env`; OAuth tokens live in a machine-managed `.spotify-tokens` file (mode `0600`). Upstream uses a single `spotify-config.json` for both.
- **Modern MCP API.** Every tool is registered via `server.registerTool()` with `title`, `inputSchema`, and behavior `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so MCP clients can route, batch, and confirm tools intelligently. Upstream still uses the deprecated `server.tool(name, description, schema, handler)` variadic API with no annotations.
- **Standardized error returns.** All 27 tools return `{ content: [...], isError: true }` on failure. Upstream sets `isError` in only two places.
- **Stdio-safe logging.** Runtime status messages (token-refresh notices, etc.) go to `stderr` instead of `stdout`, so they don't corrupt the JSON-RPC frames on the stdio transport. Upstream's `console.log` calls inside the runtime path can break stdio clients.
- **Modernized dependencies**: `@modelcontextprotocol/sdk` 1.29 (vs upstream 1.10.1), `zod` 4 (vs 3), `dotenv` added, `vitest` smoke tests added, `npm audit` clean.
- **Metadata enrichment tools** (`getTrack`, `getArtist`, `enrichPlaylistMetadata`) plus expanded fields (popularity, ISRC, release date, explicit, album label/type) on every list-style tool. See [Metadata enrichment (for organizing playlists)](#metadata-enrichment-for-organizing-playlists) for the rationale and constraints.

## Prerequisites

- A Spotify Premium account
- A registered [Spotify Developer application](https://developer.spotify.com/dashboard/) with `http://127.0.0.1:8888/callback` registered as a Redirect URI
- Node.js 22+

> **Redirect URI must match exactly.** Spotify allowlists the literal string. Use `127.0.0.1`, not `localhost` (deprecated for new apps). No trailing slash. `http`, not `https`. Any mismatch fails the OAuth callback.

## Quick start (local, stdio)

For running on the same machine as your MCP client.

```bash
git clone https://github.com/wolstad/spotify-mcp-server.git
cd spotify-mcp-server
npm install
npm run build

cp .env.example .env  # then edit with your Spotify credentials
npm run auth          # one-time OAuth flow (opens browser)
node build/index.js   # runs the MCP server on stdio
```

Then point your MCP client at `node /absolute/path/to/spotify-mcp-server/build/index.js` — see [Integrating with MCP clients](#integrating-with-mcp-clients).

## Remote install on a Proxmox LXC (HTTP transport)

When the MCP client and server are on different machines, run the server in HTTP mode and point the client at the LXC's IP.

### 1. Provision the LXC

A 1 vCPU / 512 MB / 2 GB-disk Debian 13 or Ubuntu 24.04 LXC is plenty. You'll need root SSH access.

### 2. Run the installer

Inside the container, as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wolstad/spotify-mcp-server/main/install.sh)
```

The installer is idempotent — re-running it pulls the latest code, rebuilds, and leaves your `.env` / `.spotify-tokens` untouched. On first run after upgrade it migrates state from `/opt/spotify-mcp/` to `/etc/spotify-mcp/` automatically. It:

- installs Node 22 (via NodeSource), `git`, `openssl`
- creates the `spotify-mcp` system user
- clones the repo to `/opt/spotify-mcp/` (code) and creates `/etc/spotify-mcp/` (state, mode 750)
- builds the TypeScript
- generates `MCP_HTTP_TOKEN` on fresh installs and prints it once
- installs the systemd unit, `enable`s it, and **leaves it stopped** on fresh installs (OAuth still needs to run)

> **Security note.** `curl | bash` runs whatever is at that URL with root privileges. Pin to a release tag if you want a stable reference, e.g. `…/v1.1.0/install.sh` instead of `…/main/install.sh`.

Flags: `--branch <name>`, `--non-interactive`, `--help`.

### 3. Configure credentials

Edit `/etc/spotify-mcp/.env` and fill in your Spotify Developer credentials:

```bash
nano /etc/spotify-mcp/.env
```

Set at minimum:

```
SPOTIFY_CLIENT_ID=…
SPOTIFY_CLIENT_SECRET=…
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback

MCP_TRANSPORT=http
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=3000
# MCP_HTTP_TOKEN was generated and written by the installer.

# Optional: per-request HTTP timeout for Spotify and ReccoBeats calls.
# Defaults to 30000 (30s). Caps how long a stalled upstream can wedge a
# tool handler before the request is aborted.
# SPOTIFY_REQUEST_TIMEOUT_MS=30000
```

> The bearer token is the **only** thing standing between the public LAN and full control of your Spotify account. Keep it long and keep it secret.

### 4. One-time authentication

OAuth needs a browser, which an LXC doesn't have. Two options:

**Option A — auth on a workstation, copy tokens.** Run `npm run auth` on any machine with a browser, then `scp .spotify-tokens` to `/etc/spotify-mcp/.spotify-tokens`. Set file mode `0600` and owner `spotify-mcp`.

**Option B — SSH-tunnel port 8888.** From your workstation:

```bash
ssh -L 8888:127.0.0.1:8888 root@<lxc-ip>
# in that session:
sudo -u spotify-mcp -H bash -c 'cd /opt/spotify-mcp && npm run auth'
```

Tokens land at `/etc/spotify-mcp/.spotify-tokens` (since `/etc/spotify-mcp/` exists, the code resolves state there automatically; no env override needed).

> Fresh Proxmox LXCs typically only have `root` with SSH key auth, hence `root@` above. Creating a sudo-capable non-root user is a stronger long-term posture — substitute `<your-user>@<lxc-ip>` once you've done so.

Then click the URL printed in the terminal — the redirect goes to your local browser, which forwards through the tunnel back to the LXC's auth server.

### 5. Start the service

```bash
sudo systemctl start spotify-mcp
sudo systemctl status spotify-mcp
```

(The installer already enabled it for boot.)

### 6. Verify

From your workstation:

```bash
curl -i -X POST http://<lxc-ip>:3000/mcp \
  -H "Authorization: Bearer <your-token>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

You should see `200 OK` and an SSE-framed JSON response containing `serverInfo` for `spotify-controller`. A `401` means the bearer token didn't match.

### Updating

Re-run the installer. It detects the existing checkout, fetches and rebuilds, preserves `.env` / `.spotify-tokens`, and only restarts the service if it was already running.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wolstad/spotify-mcp-server/main/install.sh)
```

### Defense in depth (optional)

The MCP server only ever talks to three outbound hosts:

- `accounts.spotify.com` (auth + token refresh)
- `api.spotify.com` (everything else)
- `api.reccobeats.com` (audio features for `enrichPlaylistMetadata`)

If you run network segmentation (UniFi, OPNsense, pfSense, etc.), restricting the LXC's outbound egress to those three hosts limits blast radius if the bearer token or refresh token leaks.

## Authentication & token refresh

Spotify uses OAuth 2.0. The flow:

1. `npm run auth` opens `https://accounts.spotify.com/authorize…` in your browser.
2. After you approve, Spotify redirects to `http://127.0.0.1:8888/callback` (the redirect URI you configured). The auth script catches the redirect, exchanges the authorization code for tokens, and writes them to `.spotify-tokens` with file mode `0600`:

   ```
   SPOTIFY_ACCESS_TOKEN=…
   SPOTIFY_REFRESH_TOKEN=…
   SPOTIFY_EXPIRES_AT=1700000000000
   ```

3. The MCP server transparently refreshes the access token when it's about to expire, updating `.spotify-tokens` in place.

If a refresh ever fails (refresh token revoked, password changed, etc.), the server reports the error and you should rerun `npm run auth`.

> **Where state lives.** On production LXC installs, both files live at `/etc/spotify-mcp/.env` and `/etc/spotify-mcp/.spotify-tokens`. For local development, they fall back to the project directory with a one-time stderr deprecation warning. Set `SPOTIFY_MCP_STATE_DIR` to override the location explicitly.

> **Why two files?** `.env` is hand-edited by you and tracks credentials; `.spotify-tokens` is machine-managed and tracks short-lived tokens. Splitting them keeps your `.env` comments and ordering intact when tokens rotate.

## Integrating with MCP clients

Any MCP-spec-compliant client can talk to this server. The exact field names in your client's config may vary — consult its docs — but every client accepts either a `command + args` pair (for stdio) or a `url + headers` pair (for remote HTTP). The shapes below are the common form.

### Local (stdio)

Point your client at `node /absolute/path/to/spotify-mcp-server/build/index.js`:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["/absolute/path/to/spotify-mcp-server/build/index.js"]
    }
  }
}
```

Tools are annotated with behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Clients that support automatic-approval lists can safely whitelist read-only tools; tools that mutate state should require confirmation.

### Remote (HTTP, e.g. Proxmox LXC)

```json
{
  "mcpServers": {
    "spotify": {
      "url": "http://<lxc-ip>:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Replace `<lxc-ip>` with the IP of the LXC on your LAN and `<your-token>` with the value of `MCP_HTTP_TOKEN` from `/etc/spotify-mcp/.env` on the server.

If your client doesn't yet support the remote MCP `url` field, you can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). `mcp-remote` rejects plain `http://` URLs by default, so `--allow-http` is required — and **it must precede `--header`**, or it gets parsed as part of the header value. Drop it once you put TLS in front of the LXC via a reverse proxy.

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://<lxc-ip>:3000/mcp",
        "--allow-http",
        "--header",
        "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

## Tools

### Read operations

| Tool | Description |
| --- | --- |
| `searchSpotify` | Search for tracks, albums, artists, or playlists. Args: `query`, `type`, optional `limit` (1-50). |
| `getNowPlaying` | Currently playing track, device, volume, shuffle/repeat state. |
| `getMyPlaylists` | Current user's playlists. Optional `limit` (1-50). |
| `getPlaylistTracks` | Tracks in a playlist with pagination. Args: `playlistId`, optional `limit`, `offset`. |
| `getRecentlyPlayed` | Recently played tracks. Optional `limit` (1-50). |
| `getUsersSavedTracks` | Liked Songs library. Optional `limit`, `offset`. |
| `removeUsersSavedTracks` | Remove tracks from Liked Songs. Args: `trackIds` (max 40). |
| `getQueue` | Current track + upcoming queue items. Optional `limit` (1-50). |
| `getAvailableDevices` | List Spotify Connect devices with active state, volume, and IDs. |

### Play / create operations

| Tool | Description |
| --- | --- |
| `playMusic` | Start playing a track/album/artist/playlist. Args: `uri` OR (`type` + `id`), optional `deviceId`. |
| `pausePlayback` | Pause playback. Optional `deviceId`. |
| `resumePlayback` | Resume playback. Optional `deviceId`. |
| `skipToNext` | Skip to next track. Optional `deviceId`. |
| `skipToPrevious` | Skip to previous track. Optional `deviceId`. |
| `addToQueue` | Add an item to the playback queue. Args: `uri` OR (`type` + `id`). |
| `setVolume` | Set volume to a specific percentage 0-100. Requires Premium. |
| `adjustVolume` | Adjust volume by a relative ± amount. Requires Premium. |
| `createPlaylist` | Create a new playlist. Args: `name`, optional `description`, `public`. Returns playlist ID and URL. |
| `addTracksToPlaylist` | Add tracks to a playlist. Args: `playlistId`, `trackIds`, optional `position`. |

### Album operations

| Tool | Description |
| --- | --- |
| `getAlbums` | Album details for one or many IDs (max 20). |
| `getAlbumTracks` | Tracks in an album with pagination. |
| `saveOrRemoveAlbumForUser` | Save or remove albums in the user's library. Args: `albumIds`, `action` (`save`/`remove`). |
| `checkUsersSavedAlbums` | Check whether albums are saved. |

### Playlist operations

| Tool | Description |
| --- | --- |
| `getPlaylist` | Playlist details (owner, tracks count, visibility, description, URL). |
| `updatePlaylist` | Update name/description/public/collaborative. |
| `removeTracksFromPlaylist` | Remove tracks from a playlist (max 100 per request). Optional `snapshotId`. |
| `reorderPlaylistItems` | Move a range of tracks to a new position. Args: `rangeStart`, `insertBefore`, optional `rangeLength`, `snapshotId`. |

### Metadata enrichment (for organizing playlists)

| Tool | Description |
| --- | --- |
| `getTrack` | Full details for one track as JSON: popularity, explicit, ISRC, release date, album label/type. |
| `getArtist` | Full details for one artist as JSON: **genres**, popularity, follower count. The only way to get genre data, since Spotify doesn't put genres on track or album responses. |
| `enrichPlaylistMetadata` | Headline tool for "organize this playlist." Fetches playlist tracks and joins ReccoBeats audio features (energy, valence, danceability, tempo, acousticness, instrumentalness, liveness, loudness, speechiness, key, mode) onto every track, plus popularity, explicit, ISRC, release date, label. Each track carries an `audio_features_source` flag (`reccobeats` / `missing` / `error`) and the response includes a coverage rollup. |

The list-style tools (`searchSpotify`, `getPlaylistTracks`, `getRecentlyPlayed`, `getUsersSavedTracks`, `getQueue`, `getNowPlaying`, `getAlbumTracks`) now also append a compact metadata suffix `[pop 75 · 2024 · E]` to each track line — popularity, release year, and an `E` flag for explicit.

#### Where do tempo, key, and energy come from?

[ReccoBeats](https://reccobeats.com), a free public API that exposes a 1:1 superset of Spotify's deprecated `audio-features` payload. Spotify deprecated `audio-features`, `audio-analysis`, `recommendations`, `related-artists`, and 30-second preview URLs for new apps in [November 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api), and [further reduced the API surface in February 2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide). `enrichPlaylistMetadata` calls ReccoBeats with no auth — there is no API key to configure. Tracks ReccoBeats does not have come back with `audio_features: null` and `audio_features_source: "missing"`; an outright lookup failure marks every track as `"error"` but the rest of the metadata still returns. The artist-level `genres` field on `getArtist` has been returning empty arrays from Spotify since late 2024 — treat it as best-effort.

## Known limitations

- **Feb 2026 Spotify API migration.** Spotify renamed `/playlists/{id}/tracks` → `/playlists/{id}/items` and stopped populating `tracks.total` on simplified-playlist objects for some app tiers. The upstream SDK (`@spotify/web-api-ts-sdk@1.2.0`, dormant since 2024) hasn't been updated, so this fork bypasses it for `getPlaylistTracks` and `enrichPlaylistMetadata` via a thin `spotifyFetch` helper in `src/utils.ts`. `getMyPlaylists` and `getPlaylist` render `?` for the track count when Spotify omits it rather than reporting a misleading `0`.
- **Podcast episodes inside playlists.** Track-listing tools (`getPlaylistTracks`, `enrichPlaylistMetadata`) skip episodes; `getPlaylistTracks` shows them as `[Podcast episode — not displayed]`. There is no read-side episode tool — use the Spotify mobile/desktop apps to browse episodes.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run test          # vitest smoke tests
npm run build         # compile TypeScript to ./build
npm run check         # typecheck + lint + test
```

Tests live in `src/*.test.ts`. The compile step (`tsc`) excludes `*.test.ts` from the published `build/` output.

### Project layout

```
install.sh        # LXC installer / updater (idempotent)
src/
  index.ts        # entry point; selects transport (stdio | http) and registers tools
  bootstrap.ts    # side-effect dotenv loader for the entry points
  http.ts         # HTTP transport with bearer-token auth and per-session McpServer
  auth.ts         # `npm run auth` — one-shot OAuth flow
  utils.ts        # credential/token helpers, state-dir resolution, refresh logic
  types.ts        # shared types and the `defineTool()` helper
  read.ts         # read-only tools
  play.ts         # playback + create tools
  albums.ts       # album tools
  playlist.ts     # playlist management tools
deploy/
  spotify-mcp.service  # systemd unit template (EnvironmentFile=/etc/spotify-mcp/.env)
```
