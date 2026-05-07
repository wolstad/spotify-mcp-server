import type { Track } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import { fetchAudioFeaturesBySpotifyIds } from './reccobeats.js';
import type {
  AudioFeatures,
  AudioFeaturesSource,
  EnrichedTrack,
  PlaylistItemsResponse,
  SpotifyArtist,
  SpotifyHandlerExtra,
  SpotifyTrack,
} from './types.js';
import { defineTool } from './types.js';
import {
  extractTrackFromPlaylistItem,
  handleSpotifyRequest,
  spotifyFetch,
} from './utils.js';

function toSpotifyArtist(a: {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  followers?: { total?: number };
  images?: Array<{ url: string; width?: number; height?: number }>;
}): SpotifyArtist {
  return {
    id: a.id,
    name: a.name,
    ...(a.genres ? { genres: a.genres } : {}),
    ...(typeof a.popularity === 'number' ? { popularity: a.popularity } : {}),
    ...(typeof a.followers?.total === 'number'
      ? { followers: a.followers.total }
      : {}),
    ...(a.images
      ? {
          images: a.images.map((img) => ({
            url: img.url,
            width: img.width,
            height: img.height,
          })),
        }
      : {}),
  };
}

function toSpotifyTrack(track: Track): SpotifyTrack {
  return {
    id: track.id,
    name: track.name,
    type: track.type,
    duration_ms: track.duration_ms,
    artists: track.artists.map((a) => ({ id: a.id, name: a.name })),
    album: {
      id: track.album.id,
      name: track.album.name,
      artists: track.album.artists.map((a) => ({ id: a.id, name: a.name })),
      ...(track.album.album_type
        ? {
            album_type: track.album.album_type as
              | 'album'
              | 'single'
              | 'compilation',
          }
        : {}),
      ...(track.album.label ? { label: track.album.label } : {}),
      ...(typeof track.album.total_tracks === 'number'
        ? { total_tracks: track.album.total_tracks }
        : {}),
      ...(track.album.release_date
        ? { release_date: track.album.release_date }
        : {}),
      ...(track.album.release_date_precision
        ? {
            release_date_precision: track.album.release_date_precision as
              | 'year'
              | 'month'
              | 'day',
          }
        : {}),
      ...(track.album.images
        ? {
            images: track.album.images.map((img) => ({
              url: img.url,
              width: img.width,
              height: img.height,
            })),
          }
        : {}),
    },
    ...(typeof track.popularity === 'number'
      ? { popularity: track.popularity }
      : {}),
    ...(typeof track.explicit === 'boolean'
      ? { explicit: track.explicit }
      : {}),
    ...(track.external_ids?.isrc ? { isrc: track.external_ids.isrc } : {}),
    ...(track.album.release_date
      ? { release_date: track.album.release_date }
      : {}),
    ...(track.album.release_date_precision
      ? {
          release_date_precision: track.album.release_date_precision as
            | 'year'
            | 'month'
            | 'day',
        }
      : {}),
  };
}

const getTrack = defineTool({
  name: 'getTrack',
  description:
    'Get full details for a single Spotify track including popularity (0-100), explicit flag, ISRC code, release date, and album. Use this when you need rich metadata for one track that the list-style tools do not surface.',
  schema: {
    id: z.string().describe('The Spotify ID of the track'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { id } = args;

    try {
      const track = await handleSpotifyRequest((api) => api.tracks.get(id));
      const enriched = toSpotifyTrack(track);
      return {
        content: [
          {
            type: 'text',
            text: `# Track Details\n\n\`\`\`json\n${JSON.stringify(enriched, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const getArtist = defineTool({
  name: 'getArtist',
  description:
    'Get full details for a Spotify artist, including their genres, popularity (0-100), and follower count. Note: Spotify has been returning empty `genres` arrays for most artists since late 2024 — treat genre data from this endpoint as best-effort.',
  schema: {
    id: z.string().describe('The Spotify ID of the artist'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { id } = args;

    try {
      const artist = await handleSpotifyRequest((api) => api.artists.get(id));
      const enriched = toSpotifyArtist(artist);
      return {
        content: [
          {
            type: 'text',
            text: `# Artist Details\n\n\`\`\`json\n${JSON.stringify(enriched, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting artist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

const enrichPlaylistMetadata = defineTool({
  name: 'enrichPlaylistMetadata',
  description:
    "Fetch a playlist and join ReccoBeats audio features (energy, valence, danceability, tempo, acousticness, instrumentalness, liveness, loudness, speechiness, key, mode) onto every track. Returns each track with id, name, artists, album, popularity, explicit, ISRC, release date, and an `audio_features` object (or `null` if ReccoBeats doesn't have the track). Each track also carries `audio_features_source`: 'reccobeats' | 'missing' | 'error'. Use this whenever the user asks to organize, group, sort, cluster, or analyze a playlist by mood, energy, tempo, vibe, or era. Audio features come from ReccoBeats (https://reccobeats.com), a free public substitute for Spotify's deprecated audio-features endpoint.",
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to enrich (1-50, default 50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based, default 0)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, limit = 50, offset = 0 } = args;

    try {
      // Bypass the SDK: it still calls the legacy /playlists/{id}/tracks path
      // which returns 403 after the Feb 2026 migration. Hit /items directly.
      const playlistItems = await spotifyFetch<PlaylistItemsResponse>(
        `/playlists/${encodeURIComponent(playlistId)}/items?limit=${limit}&offset=${offset}`,
      );

      const tracks: Track[] = [];
      for (const entry of playlistItems.items) {
        const track = extractTrackFromPlaylistItem(entry);
        if (track) tracks.push(track as unknown as Track);
      }

      if (tracks.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No playable tracks in this playlist range to enrich.',
            },
          ],
        };
      }

      const uniqueTrackIds = Array.from(new Set(tracks.map((t) => t.id)));

      let featuresByTrackId: Map<string, AudioFeatures | null>;
      let lookupFailed = false;
      let lookupError: string | undefined;
      try {
        featuresByTrackId =
          await fetchAudioFeaturesBySpotifyIds(uniqueTrackIds);
      } catch (error) {
        lookupFailed = true;
        lookupError = error instanceof Error ? error.message : String(error);
        featuresByTrackId = new Map(uniqueTrackIds.map((id) => [id, null]));
      }

      let hits = 0;
      let misses = 0;
      let errors = 0;
      const enriched: EnrichedTrack[] = tracks.map((track) => {
        const features = featuresByTrackId.get(track.id) ?? null;
        let source: AudioFeaturesSource;
        if (lookupFailed) {
          source = 'error';
          errors++;
        } else if (features) {
          source = 'reccobeats';
          hits++;
        } else {
          source = 'missing';
          misses++;
        }
        return {
          ...toSpotifyTrack(track),
          audio_features: features,
          audio_features_source: source,
        };
      });

      const summary = {
        playlist_id: playlistId,
        offset,
        returned: enriched.length,
        total: playlistItems.total,
        audio_features_coverage: { hits, misses, errors },
        ...(lookupError ? { audio_features_error: lookupError } : {}),
        tracks: enriched,
      };

      return {
        content: [
          {
            type: 'text',
            text: `# Enriched Playlist Metadata\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error enriching playlist metadata: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
});

export const enrichmentTools = [getTrack, getArtist, enrichPlaylistMetadata];

// Exported for tests.
export const _internal = {
  toSpotifyTrack,
  toSpotifyArtist,
};
