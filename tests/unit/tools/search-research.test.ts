import { describe, expect, it } from 'vitest';
import { searchResearchTool } from '../../../src/tools/search-research';

describe('searchResearchTool (stub)', () => {
  it('returns not_yet_available', async () => {
    const r = await searchResearchTool.handler({ query: 'creatine timing' }, {} as any);
    expect(r.error).toBe('not_yet_available');
    expect(searchResearchTool.surface).toBe('visible');
  });
});
