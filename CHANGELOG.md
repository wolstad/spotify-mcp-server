# Changelog

All notable changes to this fork are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; entries are
grouped by release.

## [Unreleased]

### Fixed

- **HTTP transport reused a single MCP server across all client connections**,
  so the second client (or the first reconnect) failed permanently with
  `Server already initialized` until the service was restarted. `startHttpServer`
  now creates a fresh `StreamableHTTPServerTransport` and `McpServer` per
  session, routes requests by `Mcp-Session-Id`, evicts idle sessions after
  10 minutes, and closes all sessions on shutdown. Stdio transport is
  unaffected. Regression test in `src/http.test.ts` would catch this.

### Added

- `install.sh` at the repo root: one-command installer for fresh Debian/Ubuntu
  LXCs and idempotent in-place updater for existing ones. Detects mode (fresh
  vs. update), installs prereqs (Node 22 via NodeSource), creates the
  `spotify-mcp` system user, clones or pulls `/opt/spotify-mcp/`, builds, sets
  up `/etc/spotify-mcp/` with the right permissions, **migrates existing
  `.env` / `.spotify-tokens` from `/opt/spotify-mcp/` on first run**, generates
  a fresh `MCP_HTTP_TOKEN` on fresh installs, installs the systemd unit, and
  restarts only if the service was previously running. Flags: `--branch`,
  `--non-interactive`, `--help`.
- `SPOTIFY_MCP_STATE_DIR` environment variable: overrides where the server
  reads `.env` and reads/writes `.spotify-tokens`. Used by the installer's
  systemd unit and by Mac dev workflows that want to keep state in the
  checkout without triggering the deprecation warning.
- Resolution order for state files: `SPOTIFY_MCP_STATE_DIR` →
  `/etc/spotify-mcp/` (if it exists) → project directory (deprecated fallback).

### Changed

- State files (`.env` and `.spotify-tokens`) now resolve to `/etc/spotify-mcp/`
  by default on production installs, decoupling state from the git checkout so
  the installer can `git pull` / rebuild without touching tokens.
- `deploy/spotify-mcp.service`: `EnvironmentFile` and `ReadWritePaths` now
  point at `/etc/spotify-mcp/`; the unit also exports
  `SPOTIFY_MCP_STATE_DIR=/etc/spotify-mcp` explicitly.

### Deprecated

- Reading state from the project directory. The installer migrates existing
  state automatically; manual installs still work with one stderr warning per
  process start. The fallback will be removed in **v2.0**.
