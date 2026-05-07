import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReccoBeatsError,
  _internal,
  fetchAudioFeaturesBySpotifyIds,
} from './reccobeats.js';

// Each test stubs the global `fetch` so no real network call is made.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeFeatures(suffix: string) {
  // Distinct numbers per field so tests can assert correct mapping.
  return {
    acousticness: 0.1,
    danceability: 0.2,
    energy: 0.3,
    instrumentalness: 0.4,
    key: 5,
    liveness: 0.6,
    loudness: -7.7,
    mode: 1,
    speechiness: 0.08,
    tempo: 120 + Number.parseInt(suffix.replace(/\D/g, ''), 10) || 120,
    valence: 0.9,
  };
}

describe('parseSpotifyIdFromHref', () => {
  it('extracts the bare ID from an open.spotify.com track URL', () => {
    expect(
      _internal.parseSpotifyIdFromHref(
        'https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh',
      ),
    ).toBe('4iV5W9uYEdYUVa79Axb7Rh');
  });

  it('strips query strings and fragments', () => {
    expect(
      _internal.parseSpotifyIdFromHref(
        'https://open.spotify.com/track/abc123?si=xyz',
      ),
    ).toBe('abc123');
  });

  it('returns null for non-track URLs and empty input', () => {
    expect(
      _internal.parseSpotifyIdFromHref('https://open.spotify.com/album/abc'),
    ).toBeNull();
    expect(_internal.parseSpotifyIdFromHref(undefined)).toBeNull();
    expect(_internal.parseSpotifyIdFromHref('')).toBeNull();
  });
});

describe('chunk', () => {
  it('splits arrays into fixed-size chunks', () => {
    expect(_internal.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for empty input', () => {
    expect(_internal.chunk([], 10)).toEqual([]);
  });
});

describe('fetchAudioFeaturesBySpotifyIds', () => {
  it('returns an empty map for an empty input', async () => {
    const out = await fetchAudioFeaturesBySpotifyIds([]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path: maps Spotify IDs to features via the two-hop lookup', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/track?ids=')) {
        return jsonResponse({
          content: [
            {
              id: 'rb-uuid-1',
              href: 'https://open.spotify.com/track/spotify-id-1',
            },
            {
              id: 'rb-uuid-2',
              href: 'https://open.spotify.com/track/spotify-id-2',
            },
          ],
        });
      }
      if (url.includes('/v1/audio-features?ids=')) {
        return jsonResponse({
          content: [
            { id: 'rb-uuid-1', ...makeFeatures('1') },
            { id: 'rb-uuid-2', ...makeFeatures('2') },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const out = await fetchAudioFeaturesBySpotifyIds([
      'spotify-id-1',
      'spotify-id-2',
    ]);
    expect(out.get('spotify-id-1')?.energy).toBe(0.3);
    expect(out.get('spotify-id-2')?.danceability).toBe(0.2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks tracks ReccoBeats does not have as null', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/track?ids=')) {
        // Only one of the two requested IDs comes back.
        return jsonResponse({
          content: [
            {
              id: 'rb-uuid-1',
              href: 'https://open.spotify.com/track/spotify-id-1',
            },
          ],
        });
      }
      return jsonResponse({
        content: [{ id: 'rb-uuid-1', ...makeFeatures('1') }],
      });
    });

    const out = await fetchAudioFeaturesBySpotifyIds([
      'spotify-id-1',
      'spotify-id-missing',
    ]);
    expect(out.get('spotify-id-1')).not.toBeNull();
    expect(out.get('spotify-id-missing')).toBeNull();
  });

  it('returns all-null when ReccoBeats has none of the tracks', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: [] }));
    const out = await fetchAudioFeaturesBySpotifyIds(['a', 'b']);
    expect(out.get('a')).toBeNull();
    expect(out.get('b')).toBeNull();
    // Only the first hop runs; second is skipped because no RB UUIDs were resolved.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 429 and respects Retry-After', async () => {
    vi.useFakeTimers();
    let call = 0;
    fetchMock.mockImplementation(async (url: string) => {
      call++;
      // First call: 429. Second call (retry): success. Third+: feature lookup.
      if (call === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      }
      if (url.includes('/v1/track?ids=')) {
        return jsonResponse({
          content: [
            {
              id: 'rb-uuid-1',
              href: 'https://open.spotify.com/track/spotify-id-1',
            },
          ],
        });
      }
      return jsonResponse({
        content: [{ id: 'rb-uuid-1', ...makeFeatures('1') }],
      });
    });

    const promise = fetchAudioFeaturesBySpotifyIds(['spotify-id-1']);
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out.get('spotify-id-1')?.energy).toBe(0.3);
    expect(call).toBe(3); // 429, retry-success (track), features
  });

  it('throws ReccoBeatsError on non-OK responses (after the single retry)', async () => {
    fetchMock.mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Server Error' }),
    );
    await expect(
      fetchAudioFeaturesBySpotifyIds(['spotify-id-1']),
    ).rejects.toBeInstanceOf(ReccoBeatsError);
  });

  it('propagates network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    await expect(
      fetchAudioFeaturesBySpotifyIds(['spotify-id-1']),
    ).rejects.toThrow(/network down/);
  });
});
