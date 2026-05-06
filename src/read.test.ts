import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Spotify request runner before importing the module under test, so
// the tools see the mocked spotifyFetch rather than a real network call.
vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    handleSpotifyRequest: vi.fn(),
    spotifyFetch: vi.fn(),
  };
});

import { readTools } from './read.js';
import { spotifyFetch } from './utils.js';

const mockedFetch = vi.mocked(spotifyFetch);

function toolByName(name: string) {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`read tool '${name}' not registered`);
  return tool;
}
const getPlaylistTracks = toolByName('getPlaylistTracks');

const fakeExtra = {} as any;

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('getPlaylistTracks (post-Feb-2026 shape)', () => {
  it('formats tracks unpacked from item.item, not item.track', async () => {
    mockedFetch.mockResolvedValue({
      total: 1,
      items: [
        {
          added_at: '2014-12-27T23:44:28Z',
          track: true,
          item: {
            type: 'track',
            episode: false,
            id: 'abc123',
            name: 'Muscle Memory',
            artists: [{ name: 'Lights' }],
            album: { name: 'Little Machines' },
            duration_ms: 216_013,
          },
        },
      ],
    });

    const result = await getPlaylistTracks.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"Muscle Memory" by Lights');
    expect(text).toContain('ID: abc123');
    expect(text).not.toContain('[Removed track]');
    expect(text).not.toContain('[Track unavailable]');
  });

  it('labels podcast episodes instead of misrendering them', async () => {
    mockedFetch.mockResolvedValue({
      total: 1,
      items: [
        {
          added_at: '2024-01-01T00:00:00Z',
          track: false,
          item: { type: 'episode', episode: true, name: 'Some Ep' },
        },
      ],
    });

    const result = await getPlaylistTracks.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[Podcast episode — not displayed]');
  });

  it('falls back to [Track unavailable] for entries with no item payload', async () => {
    mockedFetch.mockResolvedValue({
      total: 1,
      items: [{ added_at: '...', track: true }],
    });

    const result = await getPlaylistTracks.handler(
      { playlistId: 'pl1' } as any,
      fakeExtra,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[Track unavailable]');
  });
});
