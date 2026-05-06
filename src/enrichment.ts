import type { Track } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type {
  EnrichedTrack,
  PlaylistItemsResponse,
  SpotifyArtist,
  SpotifyHandlerExtra,
  SpotifyTrack,
} from './types.js';
import { defineTool } from './types.js';
import { handleSpotifyRequest, spotifyFetch } from './utils.js';

// Spotify removed batch GET /artists in February 2026, so we have to fan out
// per-artist requests. Cap concurrency to avoid hitting the rate limit when a
// single playlist references dozens of unique artists.
const ARTIST_FETCH_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

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
    'Get full details for a Spotify artist, including their genres, popularity (0-100), and follower count. Genres only live on the artist object — track and album responses do not include them — so this is the canonical way to get genre information for organizing music.',
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
    'Fetch a playlist and join genre tags onto every track by looking up each unique artist. Returns each track with id, name, artists, album, popularity, explicit flag, ISRC, release date, and an artist_genres array (deduped union of every artist genre). Use this whenever the user asks to organize, group, sort, cluster, or analyze a playlist by genre, era, popularity, or explicitness. Does NOT return tempo/key/energy/danceability — those endpoints were deprecated by Spotify in November 2024.',
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
      for (const item of playlistItems.items) {
        if (item.track && (item.track as { type?: string }).type === 'track') {
          tracks.push(item.track as Track);
        }
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

      const uniqueArtistIds = Array.from(
        new Set(tracks.flatMap((t) => t.artists.map((a) => a.id))),
      );

      const artists = await mapWithConcurrency(
        uniqueArtistIds,
        ARTIST_FETCH_CONCURRENCY,
        (artistId) => handleSpotifyRequest((api) => api.artists.get(artistId)),
      );

      const genresByArtistId = new Map<string, string[]>();
      for (const a of artists) {
        genresByArtistId.set(a.id, a.genres ?? []);
      }

      const enriched: EnrichedTrack[] = tracks.map((track) => {
        const seen = new Set<string>();
        const artist_genres: string[] = [];
        for (const a of track.artists) {
          for (const g of genresByArtistId.get(a.id) ?? []) {
            if (!seen.has(g)) {
              seen.add(g);
              artist_genres.push(g);
            }
          }
        }
        return { ...toSpotifyTrack(track), artist_genres };
      });

      const summary = {
        playlist_id: playlistId,
        offset,
        returned: enriched.length,
        total: playlistItems.total,
        unique_artists_fetched: artists.length,
        unique_genres: Array.from(
          new Set(enriched.flatMap((t) => t.artist_genres)),
        ).sort(),
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
  mapWithConcurrency,
  ARTIST_FETCH_CONCURRENCY,
};
