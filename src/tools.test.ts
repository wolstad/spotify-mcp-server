import { describe, expect, it } from 'vitest';
import { albumTools } from './albums.js';
import { enrichmentTools } from './enrichment.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';

const allTools = [
  ...readTools,
  ...playTools,
  ...albumTools,
  ...playlistTools,
  ...enrichmentTools,
];

describe('tool registration', () => {
  it('every tool has the required fields', () => {
    for (const tool of allTools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.handler).toBe('function');
      expect(tool.schema).toBeTypeOf('object');
    }
  });

  it('tool names are unique across all tool groups', () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every parameter in every tool schema has a Zod-style describe', () => {
    for (const tool of allTools) {
      for (const [paramName, paramSchema] of Object.entries(tool.schema)) {
        // A described Zod schema exposes the description on its def or directly.
        const description =
          (paramSchema as { description?: string }).description ??
          (paramSchema as { def?: { description?: string } }).def?.description;
        expect(
          description,
          `tool ${tool.name} param ${paramName} is missing .describe()`,
        ).toBeTruthy();
      }
    }
  });
});
