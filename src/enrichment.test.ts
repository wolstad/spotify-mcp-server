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
    spotifyFetch: vi.fn(),
  };
});

// Mock the ReccoBeats client so tests don't hit the network.
vi.mock('./reccobeats.js', () => ({
  fetchAudioFeaturesBySpotifyIds: vi.fn(),
}));

import { _internal, enrichmentTools } from './enrichment.js';
import { fetchAudioFeaturesBySpotifyIds } from './reccobeats.js';
import { handleSpotifyRequest, spotifyFetch } from './utils.js';

const mockedHandle = vi.mocked(handleSpotifyRequest);
const mockedFetch = vi.mocked(spotifyFetch);
const mockedFeatures = vi.mocked(fetchAudioFeaturesBySpotifyIds);

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

function makeFeatures(energy: number) {
  return {
    acousticness: 0.1,
    danceability: 0.5,
    energy,
    instrumentalness: 0.0,
    key: 5,
    liveness: 0.2,
    loudness: -8,
    mode: 1,
    speechiness: 0.05,
    tempo: 120,
    valence: 0.6,
  };
}

const fakeExtra = {} as any;

beforeEach(() => {
  mockedHandle.mockReset();
  mockedFetch.mockReset();
  mockedFeatures.mockReset();
});

function parseJsonFromResult(result: { content: Array<{ text: string }> }) {
  const text = result.content[0].text;
  return JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
}

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

describe('enrichPlaylistMetadata', () => {
  it('joins ReccoBeats audio features onto each track and reports coverage', async () => {
    const tracks = [
      makeTrack('t1', 'Song 1', ['a1']),
      makeTrack('t2', 'Song 2', ['a2']),
    ];
    mockedFetch.mockResolvedValue({
      items: tracks.map((t) => ({ item: t, track: true })),
      total: 2,
    });
    mockedFeatures.mockResolvedValue(
      new Map([
        ['t1', makeFeatures(0.8)],
        ['t2', makeFeatures(0.4)],
      ]),
    );

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );

    expect(result.isError).toBeFalsy();
    const json = parseJsonFromResult(
      result as { content: Array<{ text: string }> },
    );
    expect(json.returned).toBe(2);
    expect(json.audio_features_coverage).toEqual({
      hits: 2,
      misses: 0,
      errors: 0,
    });
    expect(json.tracks[0].audio_features.energy).toBe(0.8);
    expect(json.tracks[0].audio_features_source).toBe('reccobeats');
    expect(json.tracks[1].audio_features.energy).toBe(0.4);
    expect(json.tracks[1].audio_features_source).toBe('reccobeats');
    // The old field must be gone.
    expect('artist_genres' in json.tracks[0]).toBe(false);
    expect('unique_genres' in json).toBe(false);
  });

  it('marks tracks ReccoBeats does not have as missing without failing the call', async () => {
    const tracks = [
      makeTrack('t1', 'Hit', ['a1']),
      makeTrack('t2', 'Obscure', ['a2']),
    ];
    mockedFetch.mockResolvedValue({
      items: tracks.map((t) => ({ item: t, track: true })),
      total: 2,
    });
    mockedFeatures.mockResolvedValue(
      new Map([
        ['t1', makeFeatures(0.7)],
        ['t2', null],
      ]),
    );

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    const json = parseJsonFromResult(
      result as { content: Array<{ text: string }> },
    );
    expect(json.audio_features_coverage).toEqual({
      hits: 1,
      misses: 1,
      errors: 0,
    });
    expect(json.tracks[0].audio_features_source).toBe('reccobeats');
    expect(json.tracks[1].audio_features).toBeNull();
    expect(json.tracks[1].audio_features_source).toBe('missing');
  });

  it('falls back gracefully when the ReccoBeats lookup throws', async () => {
    const tracks = [makeTrack('t1', 'Song', ['a1'])];
    mockedFetch.mockResolvedValue({
      items: tracks.map((t) => ({ item: t, track: true })),
      total: 1,
    });
    mockedFeatures.mockRejectedValue(new Error('ReccoBeats 503'));

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    expect(result.isError).toBeFalsy();
    const json = parseJsonFromResult(
      result as { content: Array<{ text: string }> },
    );
    expect(json.audio_features_coverage).toEqual({
      hits: 0,
      misses: 0,
      errors: 1,
    });
    expect(json.tracks[0].audio_features).toBeNull();
    expect(json.tracks[0].audio_features_source).toBe('error');
    expect(json.audio_features_error).toMatch(/503/);
  });

  it('returns an empty-tracks message rather than failing on an empty range', async () => {
    mockedFetch.mockResolvedValue({ items: [], total: 0 });

    const result = await enrichPlaylistMetadata.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toMatch(
      /No playable tracks/,
    );
    // ReccoBeats is not consulted when there's nothing to look up.
    expect(mockedFeatures).not.toHaveBeenCalled();
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
    const json = parseJsonFromResult(
      result as { content: Array<{ text: string }> },
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
    const json = parseJsonFromResult(
      result as { content: Array<{ text: string }> },
    );
    expect(json.popularity).toBe(50);
    expect(json.isrc).toBe('ISRC-t1');
    expect(json.release_date).toBe('2024-01-01');
    expect(json.album.label).toBe('Big Label');
  });
});
