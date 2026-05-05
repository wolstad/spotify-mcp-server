import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Spotify request runner before importing the module under test, so
// that the tools see the mocked implementation rather than the real one (which
// would require credentials and a network call).
vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    handleSpotifyRequest: vi.fn(),
  };
});

import { _internal, enrichmentTools } from './enrichment.js';
import { handleSpotifyRequest } from './utils.js';

const mockedHandle = vi.mocked(handleSpotifyRequest);

function toolByName(name: string) {
  const tool = enrichmentTools.find((t) => t.name === name);
  if (!tool) throw new Error(`enrichment tool '${name}' not registered`);
  return tool;
}
const enrichPlaylistMetadata = toolByName('enrichPlaylistMetadata');
const getArtist = toolByName('getArtist');
const getTrack = toolByName('getTrack');

function makeArtist(id: string, name: string, genres: string[] = []) {
  return {
    id,
    name,
    type: 'artist',
    genres,
    popularity: 60,
    followers: { total: 1000 },
    images: [],
    external_urls: { spotify: '' },
    href: '',
    uri: `spotify:artist:${id}`,
  };
}

function makeTrack(id: string, name: string, artistIds: string[]) {
  return {
    id,
    name,
    type: 'track',
    duration_ms: 200_000,
    explicit: false,
    popularity: 50,
    external_ids: { isrc: `ISRC-${id}` },
    artists: artistIds.map((aid) => ({
      id: aid,
      name: `Artist ${aid}`,
      type: 'artist',
      external_urls: { spotify: '' },
      href: '',
      uri: `spotify:artist:${aid}`,
    })),
    album: {
      id: 'album-1',
      name: 'Album One',
      album_type: 'album',
      label: 'Big Label',
      total_tracks: 10,
      release_date: '2024-01-01',
      release_date_precision: 'day',
      images: [],
      artists: [],
      external_urls: { spotify: '' },
      href: '',
      uri: 'spotify:album:album-1',
    },
    external_urls: { spotify: '' },
    href: '',
    uri: `spotify:track:${id}`,
  };
}

const fakeExtra = {} as any;

beforeEach(() => {
  mockedHandle.mockReset();
});

describe('toSpotifyTrack', () => {
  it('surfaces popularity, explicit, isrc, release date, label', () => {
    const enriched = _internal.toSpotifyTrack(
      makeTrack('t1', 'A', ['a1']) as any,
    );
    expect(enriched.popularity).toBe(50);
    expect(enriched.explicit).toBe(false);
    expect(enriched.isrc).toBe('ISRC-t1');
    expect(enriched.release_date).toBe('2024-01-01');
    expect(enriched.release_date_precision).toBe('day');
    expect(enriched.album.label).toBe('Big Label');
    expect(enriched.album.album_type).toBe('album');
    expect(enriched.album.total_tracks).toBe(10);
  });
});

describe('toSpotifyArtist', () => {
  it('surfaces genres, popularity, follower count', () => {
    const enriched = _internal.toSpotifyArtist(
      makeArtist('a1', 'Foo', ['indie pop', 'shoegaze']),
    );
    expect(enriched.genres).toEqual(['indie pop', 'shoegaze']);
    expect(enriched.popularity).toBe(60);
    expect(enriched.followers).toBe(1000);
  });

  it('omits absent fields rather than emitting undefined', () => {
    const enriched = _internal.toSpotifyArtist({ id: 'a1', name: 'Bare' });
    expect(enriched).toEqual({ id: 'a1', name: 'Bare' });
  });
});

describe('mapWithConcurrency', () => {
  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await _internal.mapWithConcurrency(items, 5, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('returns results in input order', async () => {
    const items = [3, 1, 4, 1, 5, 9, 2, 6];
    const out = await _internal.mapWithConcurrency(items, 3, async (n) => {
      // Smaller numbers wait longer to make sure ordering doesn't depend on
      // completion order.
      await new Promise((r) => setTimeout(r, (10 - n) * 2));
      return n * 10;
    });
    expect(out).toEqual(items.map((n) => n * 10));
  });
});

describe('enrichPlaylistMetadata', () => {
  it('joins deduped genres from multiple artists onto each track', async () => {
    const tracks = [
      makeTrack('t1', 'Song 1', ['a1', 'a2']),
      makeTrack('t2', 'Song 2', ['a2', 'a3']),
    ];
    const playlistResponse = {
      items: tracks.map((t) => ({ track: t })),
      total: 2,
    };
    const artistsById: Record<string, ReturnType<typeof makeArtist>> = {
      a1: makeArtist('a1', 'A1', ['indie', 'shoegaze']),
      a2: makeArtist('a2', 'A2', ['indie', 'dream pop']),
      a3: makeArtist('a3', 'A3', ['ambient']),
    };

    mockedHandle.mockImplementation(async (action: any) => {
      const fakeApi = {
        playlists: {
          getPlaylistItems: vi.fn().mockResolvedValue(playlistResponse),
        },
        artists: {
          get: (id: string) => Promise.resolve(artistsById[id]),
        },
      };
      return action(fakeApi);
    });

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);

    expect(json.returned).toBe(2);
    expect(json.unique_artists_fetched).toBe(3);
    // Track 1 spans a1+a2 -> indie/shoegaze/dream pop (deduped).
    expect(json.tracks[0].artist_genres).toEqual([
      'indie',
      'shoegaze',
      'dream pop',
    ]);
    // Track 2 spans a2+a3.
    expect(json.tracks[1].artist_genres).toEqual([
      'indie',
      'dream pop',
      'ambient',
    ]);
    // Aggregate is sorted alphabetically.
    expect(json.unique_genres).toEqual([
      'ambient',
      'dream pop',
      'indie',
      'shoegaze',
    ]);
  });

  it('returns an empty-tracks message rather than failing on an empty range', async () => {
    mockedHandle.mockImplementation(async (action: any) => {
      const fakeApi = {
        playlists: {
          getPlaylistItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        },
        artists: { get: vi.fn() },
      };
      return action(fakeApi);
    });

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toMatch(
      /No playable tracks/,
    );
  });

  it('handles tracks whose artists return no genres (artist_genres = [])', async () => {
    const track = makeTrack('t1', 'Song', ['a1']);
    mockedHandle.mockImplementation(async (action: any) => {
      const fakeApi = {
        playlists: {
          getPlaylistItems: vi
            .fn()
            .mockResolvedValue({ items: [{ track }], total: 1 }),
        },
        artists: {
          get: () => Promise.resolve(makeArtist('a1', 'A1', [])),
        },
      };
      return action(fakeApi);
    });

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    const json = JSON.parse(
      (result.content[0] as { text: string }).text
        .split('```json\n')[1]
        .split('\n```')[0],
    );
    expect(json.tracks[0].artist_genres).toEqual([]);
  });
});

describe('getArtist', () => {
  it('returns the artist with genres populated', async () => {
    mockedHandle.mockImplementation(async (action: any) => {
      const fakeApi = {
        artists: {
          get: () => Promise.resolve(makeArtist('a1', 'Indie Band', ['indie'])),
        },
      };
      return action(fakeApi);
    });

    const result = await getArtist.handler({ id: 'a1' } as any, fakeExtra);
    const json = JSON.parse(
      (result.content[0] as { text: string }).text
        .split('```json\n')[1]
        .split('\n```')[0],
    );
    expect(json.genres).toEqual(['indie']);
    expect(json.popularity).toBe(60);
    expect(json.followers).toBe(1000);
  });
});

describe('getTrack', () => {
  it('returns the new metadata fields surfaced by toSpotifyTrack', async () => {
    mockedHandle.mockImplementation(async (action: any) => {
      const fakeApi = {
        tracks: { get: () => Promise.resolve(makeTrack('t1', 'A', ['a1'])) },
      };
      return action(fakeApi);
    });

    const result = await getTrack.handler({ id: 't1' } as any, fakeExtra);
    const json = JSON.parse(
      (result.content[0] as { text: string }).text
        .split('```json\n')[1]
        .split('\n```')[0],
    );
    expect(json.popularity).toBe(50);
    expect(json.isrc).toBe('ISRC-t1');
    expect(json.release_date).toBe('2024-01-01');
    expect(json.album.label).toBe('Big Label');
  });
});
