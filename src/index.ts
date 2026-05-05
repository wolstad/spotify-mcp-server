#!/usr/bin/env node
import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';

// Human-readable titles surfaced by MCP clients (Claude Desktop, Cursor, etc.)
// Falls back to the tool name when not set.
const TITLES: Record<string, string> = {
  searchSpotify: 'Search Spotify',
  getNowPlaying: 'Get Now Playing',
  getMyPlaylists: 'List My Playlists',
  getPlaylistTracks: 'List Playlist Tracks',
  getRecentlyPlayed: 'Get Recently Played',
  getUsersSavedTracks: 'List Liked Songs',
  removeUsersSavedTracks: 'Remove Liked Songs',
  getQueue: 'Get Playback Queue',
  getAvailableDevices: 'List Spotify Devices',
  playMusic: 'Play Music',
  pausePlayback: 'Pause Playback',
  resumePlayback: 'Resume Playback',
  skipToNext: 'Skip to Next Track',
  skipToPrevious: 'Skip to Previous Track',
  createPlaylist: 'Create Playlist',
  addTracksToPlaylist: 'Add Tracks to Playlist',
  addToQueue: 'Add to Queue',
  setVolume: 'Set Volume',
  adjustVolume: 'Adjust Volume',
  getAlbums: 'Get Album Details',
  getAlbumTracks: 'List Album Tracks',
  saveOrRemoveAlbumForUser: 'Save or Remove Album',
  checkUsersSavedAlbums: 'Check Saved Albums',
  getPlaylist: 'Get Playlist Details',
  updatePlaylist: 'Update Playlist',
  removeTracksFromPlaylist: 'Remove Tracks from Playlist',
  reorderPlaylistItems: 'Reorder Playlist Items',
};

// Behavior hints for MCP clients. readOnlyHint indicates safe-by-default;
// destructiveHint indicates the tool can remove user data; idempotentHint
// indicates calling twice with the same args has the same effect as once.
const ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Read-only tools
  searchSpotify: { readOnlyHint: true, openWorldHint: true },
  getNowPlaying: { readOnlyHint: true, openWorldHint: true },
  getMyPlaylists: { readOnlyHint: true, openWorldHint: true },
  getPlaylistTracks: { readOnlyHint: true, openWorldHint: true },
  getRecentlyPlayed: { readOnlyHint: true, openWorldHint: true },
  getUsersSavedTracks: { readOnlyHint: true, openWorldHint: true },
  getQueue: { readOnlyHint: true, openWorldHint: true },
  getAvailableDevices: { readOnlyHint: true, openWorldHint: true },
  getAlbums: { readOnlyHint: true, openWorldHint: true },
  getAlbumTracks: { readOnlyHint: true, openWorldHint: true },
  checkUsersSavedAlbums: { readOnlyHint: true, openWorldHint: true },
  getPlaylist: { readOnlyHint: true, openWorldHint: true },

  // Destructive tools
  removeUsersSavedTracks: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  removeTracksFromPlaylist: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  saveOrRemoveAlbumForUser: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  // Idempotent state-setting tools
  pausePlayback: { idempotentHint: true, openWorldHint: true },
  resumePlayback: { idempotentHint: true, openWorldHint: true },
  setVolume: { idempotentHint: true, openWorldHint: true },
  updatePlaylist: { idempotentHint: true, openWorldHint: true },

  // Non-idempotent write tools (default — listed for clarity)
  playMusic: { openWorldHint: true },
  skipToNext: { openWorldHint: true },
  skipToPrevious: { openWorldHint: true },
  createPlaylist: { openWorldHint: true },
  addTracksToPlaylist: { openWorldHint: true },
  addToQueue: { openWorldHint: true },
  adjustVolume: { openWorldHint: true },
  reorderPlaylistItems: { openWorldHint: true },
};

const server = new McpServer({
  name: 'spotify-controller',
  version: '1.1.0',
});

const allTools = [...readTools, ...playTools, ...albumTools, ...playlistTools];

for (const tool of allTools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title ?? TITLES[tool.name] ?? tool.name,
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations ?? ANNOTATIONS[tool.name],
    },
    tool.handler as any,
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
