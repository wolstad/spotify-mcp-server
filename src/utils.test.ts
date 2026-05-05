import { describe, expect, it } from 'vitest';
import { formatDuration, formatTrackMeta, parseEnvFile } from './utils.js';

describe('formatDuration', () => {
  it('formats sub-minute durations with leading zero', () => {
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(30_000)).toBe('0:30');
  });

  it('formats multi-minute durations', () => {
    expect(formatDuration(90_000)).toBe('1:30');
    expect(formatDuration(605_000)).toBe('10:05');
  });
});

describe('parseEnvFile', () => {
  it('parses simple key=value lines', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux\n')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('ignores comments and blank lines', () => {
    const input = '# comment\n\nFOO=bar\n  # leading whitespace comment\n';
    expect(parseEnvFile(input)).toEqual({ FOO: 'bar' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile('A="hello"\nB=\'world\'\n')).toEqual({
      A: 'hello',
      B: 'world',
    });
  });

  it('preserves equals signs inside the value', () => {
    expect(parseEnvFile('TOKEN=abc=def=ghi\n')).toEqual({
      TOKEN: 'abc=def=ghi',
    });
  });

  it('round-trips a token cache', () => {
    const tokens = {
      SPOTIFY_ACCESS_TOKEN: 'access-123',
      SPOTIFY_REFRESH_TOKEN: 'refresh-abc',
      SPOTIFY_EXPIRES_AT: '1700000000000',
    };
    const serialized = `${Object.entries(tokens)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`;
    expect(parseEnvFile(serialized)).toEqual(tokens);
  });
});

describe('formatTrackMeta', () => {
  it('returns empty string when no metadata is present', () => {
    expect(formatTrackMeta({})).toBe('');
  });

  it('includes popularity, year, and explicit flag', () => {
    expect(
      formatTrackMeta({
        popularity: 75,
        explicit: true,
        album: { release_date: '2024-03-15' },
      }),
    ).toBe(' [pop 75 · 2024 · E]');
  });

  it('omits the explicit flag when false', () => {
    expect(
      formatTrackMeta({
        popularity: 50,
        explicit: false,
        album: { release_date: '2010' },
      }),
    ).toBe(' [pop 50 · 2010]');
  });

  it('reads release_date from the track when album is missing', () => {
    expect(formatTrackMeta({ release_date: '1999-01-01' })).toBe(' [1999]');
  });

  it('includes popularity of 0 (not falsy-skipped)', () => {
    expect(formatTrackMeta({ popularity: 0 })).toBe(' [pop 0]');
  });
});
