<div align="center" style="display: flex; align-items: center; justify-content: center; gap: 10px;">
<img src="https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg" width="30" height="30">
<h1>Spotify MCP Server</h1>
</div>

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants like Claude and Cursor control Spotify playback and manage playlists.

> **This is a fork of [marcelmarais/spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server).** See [What's different in this fork](#whats-different-in-this-fork) for the changes.

<details>
<summary>Contents</summary>

- [What's different in this fork](#whats-different-in-this-fork)
- [Quick start (Docker — recommended)](#quick-start-docker--recommended)
- [Quick start (local Node)](#quick-start-local-node)
- [Authentication & token refresh](#authentication--token-refresh)
- [Integrating with Claude Desktop, Cursor, and Cline](#integrating-with-claude-desktop-cursor-and-cline)
- [Tools](#tools)
- [Development](#development)
</details>

## What's different in this fork

- **Docker-first**: ships with a `Dockerfile` and `docker-compose.yml`; running in a container is the recommended path.
- **Env-only configuration**: credentials live in `.env`; OAuth tokens live in a machine-managed `.spotify-tokens` file (mode `0600`). No JSON config.
- **Modern MCP API**: tools are registered via `server.registerTool()` with `title`, `inputSchema`, and behavior `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so MCP clients can route, batch, and confirm tools intelligently.
- **Automatic token refresh**: access tokens refresh transparently when expired (1‑hour TTL).
- **Extra tools** beyond upstream:
  - **Album operations**: `getAlbums`, `getAlbumTracks`, `saveOrRemoveAlbumForUser`, `checkUsersSavedAlbums`.
  - **Playlist management**: `getPlaylist`, `updatePlaylist`, `removeTracksFromPlaylist`, `reorderPlaylistItems`.
  - **Device & volume control**: `getAvailableDevices`, `setVolume`, `adjustVolume`.
  - **Queue & library**: `getQueue`, `getRecentlyPlayed`, `getUsersSavedTracks`, `removeUsersSavedTracks`, `addToQueue`.
- **Modernized dependencies**: `@modelcontextprotocol/sdk` 1.29, `zod` 4, `dotenv`, `vitest` smoke tests, deps refreshed and audited.

## Prerequisites

- A Spotify Premium account
- A registered [Spotify Developer application](https://developer.spotify.com/dashboard/) with `http://127.0.0.1:8888/callback` as a registered Redirect URI
- One of:
  - **Docker** (recommended) — Docker 24+ with `docker compose`
  - **Node.js 22+** for the local-Node path

## Quick start (Docker — recommended)

```bash
git clone https://github.com/wolstad/spotify-mcp-server.git
cd spotify-mcp-server

# 1. Configure credentials
cp .env.example .env
# Edit .env with your Spotify Client ID, Secret, and Redirect URI.

# 2. Authenticate ONCE on the host. This opens your browser, completes OAuth,
#    and writes refresh tokens to ./.spotify-tokens (mode 0600, gitignored).
#    Requires a local Node install just for this step.
npm install
npm run auth

# 3. Build the image and run
docker compose build
docker compose run --rm spotify-mcp
```

The container reads `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` from `.env`, and mounts `./.spotify-tokens` so the refresh-token cache survives restarts. Token refresh happens automatically inside the container.

If you ever need to re-authenticate, rerun `npm run auth` on the host — the new tokens will be picked up by the next container run.

## Quick start (local Node)

```bash
git clone https://github.com/wolstad/spotify-mcp-server.git
cd spotify-mcp-server
npm install
npm run build

cp .env.example .env  # then edit with your credentials
npm run auth          # one-time OAuth flow
node build/index.js   # runs the MCP server on stdio
```

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

### Docker integration (recommended)

Add to your client's MCP config (paths must be absolute):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--env-file",
        "/absolute/path/to/spotify-mcp-server/.env",
        "-v",
        "/absolute/path/to/spotify-mcp-server/.spotify-tokens:/app/.spotify-tokens",
        "spotify-mcp:local"
      ]
    }
  }
}
```

Build the image once with `docker compose build` (or `docker build -t spotify-mcp:local .`) before starting your client.

### Local Node integration

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
  index.ts        # MCP server entry; registers every tool with annotations
  auth.ts         # `npm run auth` — one-shot OAuth flow
  utils.ts        # credential/token helpers, refresh logic
  types.ts        # shared types and the `defineTool()` helper
  read.ts         # read-only tools
  play.ts         # playback + create tools
  albums.ts       # album tools
  playlist.ts     # playlist management tools
```
