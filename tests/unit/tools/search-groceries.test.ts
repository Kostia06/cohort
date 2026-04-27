import { describe, expect, it } from 'vitest';
import { searchGroceriesTool } from '../../../src/tools/search-groceries';

describe('searchGroceriesTool (stub)', () => {
  it('returns not_yet_available', async () => {
    const r = await searchGroceriesTool.handler({ items: ['oats'] }, {} as any);
    expect(r.error).toBe('not_yet_available');
    expect(searchGroceriesTool.surface).toBe('visible');
  });
});
