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

import { playTools } from './play.js';
import { spotifyFetch } from './utils.js';

const mockedFetch = vi.mocked(spotifyFetch);

function toolByName(name: string) {
  const tool = playTools.find((t) => t.name === name);
  if (!tool) throw new Error(`play tool '${name}' not registered`);
  return tool;
}

const fakeExtra = {} as any;

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('createPlaylist (post-Feb-2026 endpoint)', () => {
  it('hits POST /me/playlists with name and public flag', async () => {
    mockedFetch.mockResolvedValue({
      id: 'new123',
      external_urls: { spotify: 'https://open.spotify.com/playlist/new123' },
    });

    const result = await toolByName('createPlaylist').handler(
      { name: 'My Mix', public: false } as any,
      fakeExtra,
    );

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockedFetch.mock.calls[0];
    expect(path).toBe('/me/playlists');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'My Mix',
      public: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Successfully created playlist "My Mix"');
    expect(text).toContain('new123');
  });

  it('includes description when provided', async () => {
    mockedFetch.mockResolvedValue({
      id: 'p1',
      external_urls: { spotify: 'x' },
    });
    await toolByName('createPlaylist').handler(
      { name: 'X', description: 'desc', public: true } as any,
      fakeExtra,
    );
    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'X',
      public: true,
      description: 'desc',
    });
  });
});

describe('addTracksToPlaylist (post-Feb-2026 endpoint)', () => {
  it('hits POST /playlists/{id}/items with uris array', async () => {
    mockedFetch.mockResolvedValue(undefined);

    await toolByName('addTracksToPlaylist').handler(
      { playlistId: 'pl1', trackIds: ['abc', 'def'] } as any,
      fakeExtra,
    );

    const [path, init] = mockedFetch.mock.calls[0];
    expect(path).toBe('/playlists/pl1/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      uris: ['spotify:track:abc', 'spotify:track:def'],
    });
  });

  it('includes position when provided', async () => {
    mockedFetch.mockResolvedValue(undefined);
    await toolByName('addTracksToPlaylist').handler(
      { playlistId: 'pl1', trackIds: ['abc'], position: 5 } as any,
      fakeExtra,
    );
    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      uris: ['spotify:track:abc'],
      position: 5,
    });
  });

  it('returns an error when no track IDs are provided', async () => {
    const result = await toolByName('addTracksToPlaylist').handler(
      { playlistId: 'pl1', trackIds: [] } as any,
      fakeExtra,
    );
    expect(result.isError).toBe(true);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
