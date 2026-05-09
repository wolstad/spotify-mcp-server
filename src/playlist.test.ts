import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    handleSpotifyRequest: vi.fn(),
    spotifyFetch: vi.fn(),
  };
});

import { playlistTools } from './playlist.js';
import { spotifyFetch } from './utils.js';

const mockedFetch = vi.mocked(spotifyFetch);

function toolByName(name: string) {
  const tool = playlistTools.find((t) => t.name === name);
  if (!tool) throw new Error(`playlist tool '${name}' not registered`);
  return tool;
}

const fakeExtra = {} as any;

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('removeTracksFromPlaylist (post-Feb-2026 endpoint)', () => {
  it('hits DELETE /playlists/{id}/items with tracks array', async () => {
    mockedFetch.mockResolvedValue(undefined);

    await toolByName('removeTracksFromPlaylist').handler(
      { playlistId: 'pl1', trackIds: ['abc', 'def'] } as any,
      fakeExtra,
    );

    const [path, init] = mockedFetch.mock.calls[0];
    expect(path).toBe('/playlists/pl1/items');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(init?.body as string)).toEqual({
      tracks: [{ uri: 'spotify:track:abc' }, { uri: 'spotify:track:def' }],
    });
  });

  it('includes snapshot_id when provided', async () => {
    mockedFetch.mockResolvedValue(undefined);
    await toolByName('removeTracksFromPlaylist').handler(
      { playlistId: 'pl1', trackIds: ['abc'], snapshotId: 'snap42' } as any,
      fakeExtra,
    );
    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      tracks: [{ uri: 'spotify:track:abc' }],
      snapshot_id: 'snap42',
    });
  });
});

describe('reorderPlaylistItems (post-Feb-2026 endpoint)', () => {
  it('hits PUT /playlists/{id}/items with range params', async () => {
    mockedFetch.mockResolvedValue(undefined);

    await toolByName('reorderPlaylistItems').handler(
      { playlistId: 'pl1', rangeStart: 2, insertBefore: 0 } as any,
      fakeExtra,
    );

    const [path, init] = mockedFetch.mock.calls[0];
    expect(path).toBe('/playlists/pl1/items');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      range_start: 2,
      insert_before: 0,
    });
  });

  it('passes range_length and snapshot_id when provided', async () => {
    mockedFetch.mockResolvedValue(undefined);
    await toolByName('reorderPlaylistItems').handler(
      {
        playlistId: 'pl1',
        rangeStart: 0,
        insertBefore: 5,
        rangeLength: 3,
        snapshotId: 'snap42',
      } as any,
      fakeExtra,
    );
    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      range_start: 0,
      insert_before: 5,
      range_length: 3,
      snapshot_id: 'snap42',
    });
  });
});
