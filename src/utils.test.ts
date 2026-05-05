import { describe, expect, it } from 'vitest';
import { formatDuration, parseEnvFile } from './utils.js';

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
