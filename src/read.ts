import type { MaxInt } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type {
  PlaylistItemsResponse,
  SpotifyHandlerExtra,
  SpotifyTrack,
} from './types.js';
import { defineTool } from './types.js';
import {
  extractTrackFromPlaylistItem,
  formatDuration,
  formatTrackMeta,
  getCurrentAccessToken,
  handleSpotifyRequest,
  spotifyFetch,
} from './utils.js';

function isTrack(item: any): item is SpotifyTrack {
  return (
    item &&
    item.type === 'track' &&
    Array.isArray(item.artists) &&
    item.album &&
    typeof item.album.name === 'string'
  );
}

const searchSpotify = defineTool({
  name: 'searchSpotify',
  description: 'Search for tracks, albums, artists, or playlists on Spotify',
  schema: {
    query: z.string().describe('The search query'),
    type: z
      .enum(['track', 'album', 'artist', 'playlist'])
      .describe(
        'The type of item to search for either track, album, artist, or playlist',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of results to return (10-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { query, type, limit } = args;
    const limitValue = limit ?? 10;

    try {
      const results = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.search(
          query,
          [type],
          undefined,
          limitValue as MaxInt<50>,
        );
      });

      let formattedResults = '';

      if (type === 'track' && results.tracks) {
        formattedResults = results.tracks.items
          .map((track, i) => {
            const artists = track.artists.map((a) => a.name).join(', ');
            const duration = formatDuration(track.duration_ms);
            const meta = formatTrackMeta(track);
            return `${i + 1}. "${
              track.name
            }" by ${artists} (${duration})${meta} - ID: ${track.id}`;
          })
          .join('\n');
      } else if (type === 'album' && results.albums) {
        formattedResults = results.albums.items
          .map((album, i) => {
            const artists = album.artists.map((a) => a.name).join(', ');
            const year = album.release_date?.slice(0, 4);
            const yearStr = year ? ` (${year})` : '';
            return `${i + 1}. "${album.name}" by ${artists}${yearStr} - ID: ${album.id}`;
          })
          .join('\n');
      } else if (type === 'artist' && results.artists) {
        formattedResults = results.artists.items
          .map((artist, i) => {
            const genres = artist.genres?.length
              ? ` [${artist.genres.slice(0, 3).join(', ')}]`
              : '';
            const pop =
              typeof artist.popularity === 'number'
                ? ` (pop ${artist.popularity})`
                : '';
            return `${i + 1}. ${artist.name}${pop}${genres} - ID: ${artist.id}`;
          })
          .join('\n');
      } else if (type === 'playlist' && results.playlists) {
        formattedResults = results.playlists.items
          .map((playlist, i) => {
            return `${i + 1}. "${playlist?.name ?? 'Unknown Playlist'} (${
              playlist?.description ?? 'No description'
            } tracks)" by ${playlist?.owner?.display_name} - ID: ${
              playlist?.id
            }`;
          })
          .join('\n');
      }

      return {
        content: [
          {
            type: 'text',
            text:
              formattedResults.length > 0
                ? `# Search results for "${query}" (type: ${type})\n\n${formattedResults}`
                : `No ${type} results found for "${query}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching for ${type}s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const getNowPlaying = defineTool({
  name: 'getNowPlaying',
  description:
    'Get information about the currently playing track on Spotify, including device and volume info',
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const playback = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getPlaybackState();
      });

      if (!playback?.item) {
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing is currently playing on Spotify',
            },
          ],
        };
      }

      const item = playback.item;

      if (!isTrack(item)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Currently playing item is not a track (might be a podcast episode)',
            },
          ],
        };
      }

      const artists = item.artists.map((a) => a.name).join(', ');
      const album = item.album.name;
      const duration = formatDuration(item.duration_ms);
      const progress = formatDuration(playback.progress_ms || 0);
      const isPlaying = playback.is_playing;
      const released = item.album.release_date ?? null;
      const popularity = (item as { popularity?: number }).popularity;
      const isrc = (item as { external_ids?: { isrc?: string } }).external_ids
        ?.isrc;
      const explicit = (item as { explicit?: boolean }).explicit;

      const device = playback.device;
      const deviceInfo = device
        ? `${device.name} (${device.type})`
        : 'Unknown device';
      const volume =
        device?.volume_percent !== null && device?.volume_percent !== undefined
          ? `${device.volume_percent}%`
          : 'N/A';
      const shuffle = playback.shuffle_state ? 'On' : 'Off';
      const repeat = playback.repeat_state || 'off';

      return {
        content: [
          {
            type: 'text',
            text: `# Currently ${isPlaying ? 'Playing' : 'Paused'}\n\n**Track**: "${item.name}"\n**Artist**: ${artists}\n**Album**: ${album}\n${released ? `**Released**: ${released}\n` : ''}${
              typeof popularity === 'number'
                ? `**Popularity**: ${popularity}/100\n`
                : ''
            }${
              typeof explicit === 'boolean'
                ? `**Explicit**: ${explicit ? 'Yes' : 'No'}\n`
                : ''
            }${isrc ? `**ISRC**: ${isrc}\n` : ''}**Progress**: ${progress} / ${duration}\n**ID**: ${item.id}\n\n**Device**: ${deviceInfo}\n**Volume**: ${volume}\n**Shuffle**: ${shuffle} | **Repeat**: ${repeat}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting current track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const getMyPlaylists = defineTool({
  name: 'getMyPlaylists',
  description: "Get a list of the current user's playlists on Spotify",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of playlists to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const playlists = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.playlists.playlists(
        limit as MaxInt<50>,
      );
    });

    if (playlists.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any playlists on Spotify",
          },
        ],
      };
    }

    const formattedPlaylists = playlists.items
      .map((playlist, i) => {
        // Spotify's Feb 2026 migration stopped populating `tracks.total` on
        // simplified-playlist objects for some app tiers; render `?` instead
        // of a misleading `0` when it's missing.
        const tracksTotal = playlist.tracks?.total;
        const countLabel =
          typeof tracksTotal === 'number' && tracksTotal > 0
            ? `${tracksTotal} tracks`
            : '? tracks';
        return `${i + 1}. "${playlist.name}" (${countLabel}) - ID: ${
          playlist.id
        }`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Spotify Playlists\n\n${formattedPlaylists}`,
        },
      ],
    };
  },
});

const getPlaylistTracks = defineTool({
  name: 'getPlaylistTracks',
  description: 'Get a list of tracks in a Spotify playlist',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, limit = 50, offset = 0 } = args;

    // Bypass the SDK: it still calls the legacy /playlists/{id}/tracks path
    // which returns 403 after the Feb 2026 migration. Hit /items directly.
    const playlistTracks = await spotifyFetch<PlaylistItemsResponse>(
      `/playlists/${encodeURIComponent(playlistId)}/items?limit=${limit}&offset=${offset}`,
    );

    if ((playlistTracks.items?.length ?? 0) === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "This playlist doesn't have any tracks",
          },
        ],
      };
    }

    const formattedTracks = playlistTracks.items
      .map((entry, i) => {
        const track = extractTrackFromPlaylistItem(entry);
        if (!track) {
          const raw = entry as {
            track?: unknown;
            item?: { episode?: boolean; type?: string };
          };
          const isEpisode =
            raw.track === false ||
            raw.item?.episode === true ||
            raw.item?.type === 'episode';
          if (isEpisode) {
            return `${offset + i + 1}. [Podcast episode — not displayed]`;
          }
          return `${offset + i + 1}. [Track unavailable]`;
        }
        const artists = track.artists.map((a) => a.name).join(', ');
        const duration = formatDuration(track.duration_ms);
        const meta = formatTrackMeta(track);
        return `${offset + i + 1}. "${track.name}" by ${artists} (${duration})${meta} - ID: ${track.id}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Tracks in Playlist (${offset + 1}-${offset + playlistTracks.items.length} of ${playlistTracks.total})\n\n${formattedTracks}`,
        },
      ],
    };
  },
});

const getRecentlyPlayed = defineTool({
  name: 'getRecentlyPlayed',
  description: 'Get a list of recently played tracks on Spotify',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const history = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.player.getRecentlyPlayedTracks(
        limit as MaxInt<50>,
      );
    });

    if (history.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any recently played tracks on Spotify",
          },
        ],
      };
    }

    const formattedHistory = history.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          const meta = formatTrackMeta(track);
          const playedAt = item.played_at
            ? new Date(item.played_at).toLocaleString()
            : 'Unknown time';
          return `${i + 1}. "${track.name}" by ${artists} (${duration})${meta} - ID: ${track.id} - Played at: ${playedAt}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Recently Played Tracks\n\n${formattedHistory}`,
        },
      ],
    };
  },
});

const getUsersSavedTracks = defineTool({
  name: 'getUsersSavedTracks',
  description:
    'Get a list of tracks saved in the user\'s "Liked Songs" library',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50, offset = 0 } = args;

    const savedTracks = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.tracks.savedTracks(
        limit as MaxInt<50>,
        offset,
      );
    });

    if (savedTracks.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any saved tracks in your Liked Songs",
          },
        ],
      };
    }

    const formattedTracks = savedTracks.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          const meta = formatTrackMeta(track);
          const addedDate = new Date(item.added_at).toLocaleDateString();
          return `${offset + i + 1}. "${track.name}" by ${artists} (${duration})${meta} - ID: ${track.id} - Added: ${addedDate}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Liked Songs (${offset + 1}-${offset + savedTracks.items.length} of ${savedTracks.total})\n\n${formattedTracks}`,
        },
      ],
    };
  },
});

const getQueue = defineTool({
  name: 'getQueue',
  description:
    'Get a list of the currently playing track and the next items in your Spotify queue',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of upcoming items to show (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 10 } = args;

    try {
      const queue = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getUsersQueue();
      });

      const current = (queue as any)?.currently_playing;
      const upcoming = ((queue as any)?.queue ?? []) as any[];

      const header = '# Spotify Queue\n\n';

      let currentText = 'Nothing is currently playing';
      if (current) {
        const name = current?.name ?? 'Unknown';
        const artists = Array.isArray(current?.artists)
          ? (current.artists as Array<{ name: string }>)
              .map((a) => a.name)
              .join(', ')
          : 'Unknown';
        const duration =
          typeof current?.duration_ms === 'number'
            ? formatDuration(current.duration_ms)
            : 'Unknown';
        const meta = formatTrackMeta(current);
        currentText = `Currently Playing: "${name}" by ${artists} (${duration})${meta}`;
      }

      if (upcoming.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${header}${currentText}\n\nNo upcoming items in the queue`,
            },
          ],
        };
      }

      const toShow = upcoming.slice(0, limit);
      const formatted = toShow
        .map((track, i) => {
          const name = track?.name ?? 'Unknown';
          const artists = Array.isArray(track?.artists)
            ? (track.artists as Array<{ name: string }>)
                .map((a) => a.name)
                .join(', ')
            : 'Unknown';
          const duration =
            typeof track?.duration_ms === 'number'
              ? formatDuration(track.duration_ms)
              : 'Unknown';
          const id = track?.id ?? 'Unknown';
          const meta = formatTrackMeta(track);
          return `${i + 1}. "${name}" by ${artists} (${duration})${meta} - ID: ${id}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `${header}${currentText}\n\nNext ${toShow.length} in queue:\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching queue: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const getAvailableDevices = defineTool({
  name: 'getAvailableDevices',
  description:
    "Get information about the user's available Spotify Connect devices",
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const devices = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getAvailableDevices();
      });

      if (!devices.devices || devices.devices.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No available devices found. Make sure Spotify is open on at least one device.',
            },
          ],
        };
      }

      const formattedDevices = devices.devices
        .map((device, i) => {
          const status = device.is_active ? '▶ Active' : '○ Inactive';
          const volume =
            device.volume_percent !== null
              ? `${device.volume_percent}%`
              : 'N/A';
          const restricted = device.is_restricted ? ' (Restricted)' : '';
          return `${i + 1}. ${device.name} (${device.type})${restricted}\n   Status: ${status} | Volume: ${volume} | ID: ${device.id}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Available Spotify Devices\n\n${formattedDevices}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting available devices: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const removeUsersSavedTracks = defineTool({
  name: 'removeUsersSavedTracks',
  description:
    'Remove one or more tracks from the user\'s "Liked Songs" library (max 40 per request)',
  schema: {
    trackIds: z
      .array(z.string())
      .max(40)
      .describe('Array of Spotify track IDs to remove (max 40)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { trackIds } = args;

    if (trackIds.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No track IDs provided' }],
        isError: true,
      };
    }

    try {
      const accessToken = await getCurrentAccessToken();

      const uris = trackIds.map((id) => `spotify:track:${id}`).join(',');
      const response = await fetch(
        `https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uris)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Spotify API error ${response.status}: ${errorData}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully removed ${trackIds.length} track${trackIds.length === 1 ? '' : 's'} from your Liked Songs`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error removing tracks from Liked Songs: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

export const readTools = [
  searchSpotify,
  getNowPlaying,
  getMyPlaylists,
  getPlaylistTracks,
  getRecentlyPlayed,
  getUsersSavedTracks,
  removeUsersSavedTracks,
  getQueue,
  getAvailableDevices,
];
