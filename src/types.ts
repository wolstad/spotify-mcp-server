import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export type SpotifyHandlerExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
>;

export type tool<Args extends z.ZodRawShape> = {
  name: string;
  title?: string;
  description: string;
  schema: Args;
  annotations?: ToolAnnotations;
  handler: (
    args: z.infer<z.ZodObject<Args>>,
    extra: SpotifyHandlerExtra,
  ) => Promise<CallToolResult> | CallToolResult;
};

// Identity helper that lets each tool definition infer its schema generic
// instead of repeating the full Zod type tuple in a type annotation.
export function defineTool<Args extends z.ZodRawShape>(
  t: tool<Args>,
): tool<Args> {
  return t;
}

export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  // Populated by the dedicated getArtist enrichment endpoint.
  // The lightweight artist object on a Track or Album does not include these.
  genres?: string[];
  popularity?: number;
  followers?: number;
  images?: SpotifyImage[];
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album_type?: 'album' | 'single' | 'compilation';
  label?: string;
  total_tracks?: number;
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
  images?: SpotifyImage[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  type: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  popularity?: number;
  explicit?: boolean;
  isrc?: string;
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
}

// Returned by enrichPlaylistMetadata: a track plus the deduped union of its
// artists' genres. Genres only live on the artist object in Spotify's API,
// so this join is what makes genre-based playlist organization possible.
export interface EnrichedTrack extends SpotifyTrack {
  artist_genres: string[];
}

// Shape returned by GET /v1/playlists/{id}/items (the post-Feb-2026 path
// the SDK still calls /tracks). Only the fields we actually consume are
// declared; `track` is left as `unknown` because callers narrow it with
// the local `isTrack` guard before reading any fields.
export interface PlaylistItemsResponse {
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  items: Array<{
    track: unknown;
    added_at?: string;
  }>;
}
