<div align="center" style="display: flex; align-items: center; justify-content: center; gap: 10px;">
<img src="https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg" width="30" height="30">
<h1>Spotify MCP Server</h1>
</div>

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants like Claude and Cursor control Spotify playback and manage playlists. Built to run as a native Node service — locally for stdio MCP clients, or on a LAN host (e.g. a Proxmox LXC) over HTTP.

> **This is a fork of [marcelmarais/spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server).** See [What's different in this fork](#whats-different-in-this-fork) for the changes.

<details>
<summary>Contents</summary>

- [What's different in this fork](#whats-different-in-this-fork)
- [Quick start (local, stdio)](#quick-start-local-stdio)
- [Remote install on a Proxmox LXC (HTTP transport)](#remote-install-on-a-proxmox-lxc-http-transport)
- [Authentication & token refresh](#authentication--token-refresh)
- [Integrating with Claude Desktop, Cursor, and Cline](#integrating-with-claude-desktop-cursor-and-cline)
- [Tools](#tools)
  - [Metadata enrichment (for organizing playlists)](#metadata-enrichment-for-organizing-playlists)
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

## Quick start (local, stdio)

For running on the same machine as your MCP client (Claude Desktop, Cursor, Cline).

```bash
git clone https://github.com/wolstad/spotify-mcp-server.git
cd spotify-mcp-server
npm install
npm run build

cp .env.example .env  # then edit with your Spotify credentials
npm run auth          # one-time OAuth flow (opens browser)
node build/index.js   # runs the MCP server on stdio
```

Then point your MCP client at `node /absolute/path/to/spotify-mcp-server/build/index.js` — see [Integrating with Claude Desktop, Cursor, and Cline](#integrating-with-claude-desktop-cursor-and-cline).

## Remote install on a Proxmox LXC (HTTP transport)

When the MCP client and server are on different machines, run the server in HTTP mode and point the client at the LXC's IP.

### 1. Provision the LXC

A 1 vCPU / 512 MB / 2 GB-disk Debian or Ubuntu LXC is plenty.

Inside the container:

```bash
apt update && apt install -y nodejs npm git curl
adduser --system --group --home /opt/spotify-mcp spotify-mcp
```

### 2. Install the app

```bash
sudo -u spotify-mcp -H bash <<'EOF'
cd /opt/spotify-mcp
git clone https://github.com/wolstad/spotify-mcp-server.git .
npm ci
npm run build
EOF
```

### 3. Configure

```bash
sudo -u spotify-mcp cp /opt/spotify-mcp/.env.example /opt/spotify-mcp/.env
sudo -u spotify-mcp -e /opt/spotify-mcp/.env   # edit
```

Set at minimum:

```
SPOTIFY_CLIENT_ID=…
SPOTIFY_CLIENT_SECRET=…
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback

MCP_TRANSPORT=http
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=3000
MCP_HTTP_TOKEN=$(openssl rand -hex 32)
```

> The bearer token is the **only** thing standing between the public LAN and full control of your Spotify account. Keep it long and keep it secret.

### 4. One-time authentication

OAuth needs a browser, which an LXC doesn't have. Two options:

**Option A — auth on a workstation, copy tokens.** Run `npm run auth` on any machine with a browser, then `scp .spotify-tokens` to `/opt/spotify-mcp/.spotify-tokens`. Make sure file mode is `0600` and owner is `spotify-mcp`.

**Option B — SSH-tunnel port 8888.** From your workstation:

```bash
ssh -L 8888:127.0.0.1:8888 youruser@<lxc-ip>
# in that session:
sudo -u spotify-mcp -H bash -c 'cd /opt/spotify-mcp && npm run auth'
```

Then click the URL printed in the terminal — the redirect goes to your local browser, which forwards through the tunnel back to the LXC's auth server.

### 5. Install the systemd unit

```bash
sudo cp /opt/spotify-mcp/deploy/spotify-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spotify-mcp
sudo systemctl status spotify-mcp
```

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

> **Why two files?** `.env` is hand-edited by you and tracks credentials; `.spotify-tokens` is machine-managed and tracks short-lived tokens. Splitting them keeps your `.env` comments and ordering intact when tokens rotate.

## Integrating with Claude Desktop, Cursor, and Cline

### Local (stdio)

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

For Cursor, go to the MCP tab in `Cursor Settings` (⌘+⇧+J) and add a server with the `node /absolute/path/to/spotify-mcp-server/build/index.js` command.

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["/absolute/path/to/spotify-mcp-server/build/index.js"],
      "autoApprove": ["getNowPlaying", "searchSpotify", "getAvailableDevices"]
    }
  }
}
```

Read-only tools (annotated with `readOnlyHint: true`) are safe candidates for `autoApprove`. Tools that mutate state (`destructiveHint: true`, write tools) should generally require confirmation.

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

Replace `<lxc-ip>` with the IP of the LXC on your LAN and `<your-token>` with the value of `MCP_HTTP_TOKEN` from `.env` on the server.

If your client doesn't yet support the remote MCP `url` field, you can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://<lxc-ip>:3000/mcp",
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
| `enrichPlaylistMetadata` | Headline tool for "organize this playlist." Fetches playlist tracks, looks up every unique artist (bounded concurrency, cap 5), and returns each track joined with `artist_genres` plus popularity, explicit, ISRC, release date, label. Also returns the playlist's deduped genre vocabulary. |

The list-style tools (`searchSpotify`, `getPlaylistTracks`, `getRecentlyPlayed`, `getUsersSavedTracks`, `getQueue`, `getNowPlaying`, `getAlbumTracks`) now also append a compact metadata suffix `[pop 75 · 2024 · E]` to each track line — popularity, release year, and an `E` flag for explicit.

#### What about tempo, key, and energy?

Not supported. Spotify deprecated `audio-features`, `audio-analysis`, `recommendations`, `related-artists`, and 30-second preview URLs in [November 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api), and [further reduced the API surface in February 2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) (removed batch GETs, removed `browse/*`, removed `artists/{id}/top-tracks`, renamed playlist `/tracks` to `/items`, collapsed library calls to a generic `/me/library`). Apps with grandfathered extended-quota access can still call the deprecated endpoints; new apps and Development Mode apps cannot.

This server organizes playlists using only what's still available: **genres** (joined from artists), **popularity**, **release date**, **explicit** flag, **album type**, and **label**. That covers grouping by genre, sorting by era, separating deep cuts from hits, splitting clean vs. explicit, and indie vs. major-label — but not BPM matching.

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
src/
  index.ts        # entry point; selects transport (stdio | http) and registers tools
  http.ts         # HTTP transport with bearer-token auth
  auth.ts         # `npm run auth` — one-shot OAuth flow
  utils.ts        # credential/token helpers, refresh logic
  types.ts        # shared types and the `defineTool()` helper
  read.ts         # read-only tools
  play.ts         # playback + create tools
  albums.ts       # album tools
  playlist.ts     # playlist management tools
deploy/
  spotify-mcp.service  # systemd unit template
```
