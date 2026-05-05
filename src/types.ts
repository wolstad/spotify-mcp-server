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

export interface SpotifyArtist {
  id: string;
  name: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtist[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  type: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}
