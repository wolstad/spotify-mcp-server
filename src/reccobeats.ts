import type { AudioFeatures } from './types.js';

// ReccoBeats (https://reccobeats.com) is a free, no-auth public API that
// exposes a 1:1 superset of Spotify's deprecated audio-features endpoint.
// We use it because Spotify's audio-features and audio-analysis endpoints
// stopped accepting new apps in November 2024.
//
// Two-hop lookup is required: the per-track audio-features endpoint rejects
// Spotify IDs (returns 404), so we first translate Spotify IDs to ReccoBeats
// UUIDs via /v1/track?ids=, then fetch features by UUID via
// /v1/audio-features?ids=. The bulk track endpoint is the only path that
// reliably accepts Spotify IDs.
const RECCOBEATS_API_BASE = 'https://api.reccobeats.com';
const SPOTIFY_TRACK_HREF_PREFIX = 'https://open.spotify.com/track/';

// ReccoBeats does not publish a request size cap, but their recommendations
// endpoint enforces size <= 100, so we use that as a conservative ceiling.
const MAX_IDS_PER_REQUEST = 100;

// No published rate limits; keep concurrent requests low to be a polite citizen.
const REQUEST_CONCURRENCY = 2;

export class ReccoBeatsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ReccoBeatsError';
  }
}

interface ReccoBeatsTrackResource {
  id: string;
  href?: string;
}

interface ReccoBeatsAudioFeaturesResource extends AudioFeatures {
  id: string;
}

interface ReccoBeatsListResponse<T> {
  content?: T[];
}

// Sleep helper for the 429 retry path. Uses setTimeout so vitest's fake timers
// can advance through the wait when tests need to.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseSpotifyIdFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(SPOTIFY_TRACK_HREF_PREFIX)) return null;
  const tail = href.slice(SPOTIFY_TRACK_HREF_PREFIX.length);
  const id = tail.split(/[/?#]/, 1)[0];
  return id.length > 0 ? id : null;
}

async function reccobeatsFetch<T>(path: string): Promise<T> {
  const url = `${RECCOBEATS_API_BASE}${path}`;
  let response = await fetch(url, { headers: { Accept: 'application/json' } });

  // Respect a single 429 retry. ReccoBeats sets Retry-After (seconds).
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After')) || 1;
    await sleep(Math.min(retryAfter, 10) * 1000);
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ReccoBeatsError(
      `ReccoBeats ${response.status} ${response.statusText}: ${path}${body ? ` ${body}` : ''}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

async function fetchChunk(
  spotifyIds: string[],
  out: Map<string, AudioFeatures | null>,
): Promise<void> {
  const trackList = await reccobeatsFetch<
    ReccoBeatsListResponse<ReccoBeatsTrackResource>
  >(`/v1/track?ids=${encodeURIComponent(spotifyIds.join(','))}`);

  const rbToSpotify = new Map<string, string>();
  for (const t of trackList.content ?? []) {
    const spotifyId = parseSpotifyIdFromHref(t.href);
    if (spotifyId && t.id) rbToSpotify.set(t.id, spotifyId);
  }
  if (rbToSpotify.size === 0) return;

  const rbIds = [...rbToSpotify.keys()];
  const featuresList = await reccobeatsFetch<
    ReccoBeatsListResponse<ReccoBeatsAudioFeaturesResource>
  >(`/v1/audio-features?ids=${encodeURIComponent(rbIds.join(','))}`);

  for (const f of featuresList.content ?? []) {
    const spotifyId = rbToSpotify.get(f.id);
    if (!spotifyId) continue;
    out.set(spotifyId, {
      acousticness: f.acousticness,
      danceability: f.danceability,
      energy: f.energy,
      instrumentalness: f.instrumentalness,
      key: f.key,
      liveness: f.liveness,
      loudness: f.loudness,
      mode: f.mode,
      speechiness: f.speechiness,
      tempo: f.tempo,
      valence: f.valence,
    });
  }
}

/**
 * Look up ReccoBeats audio features for a batch of Spotify track IDs.
 *
 * Returns a map keyed by Spotify track ID. Tracks that ReccoBeats does not
 * have in its catalog are present in the map with a `null` value. Throws
 * `ReccoBeatsError` if any HTTP request fails after the 429 retry — callers
 * are expected to treat a thrown error as "feature lookup failed for the
 * whole batch" and fall back to whatever metadata they already have.
 */
export async function fetchAudioFeaturesBySpotifyIds(
  spotifyIds: string[],
): Promise<Map<string, AudioFeatures | null>> {
  const out = new Map<string, AudioFeatures | null>();
  for (const id of spotifyIds) out.set(id, null);
  if (spotifyIds.length === 0) return out;

  const chunks = chunk(spotifyIds, MAX_IDS_PER_REQUEST);
  await mapWithConcurrency(chunks, REQUEST_CONCURRENCY, (c) =>
    fetchChunk(c, out),
  );
  return out;
}

// Exported for tests.
export const _internal = {
  parseSpotifyIdFromHref,
  chunk,
  RECCOBEATS_API_BASE,
  MAX_IDS_PER_REQUEST,
};
