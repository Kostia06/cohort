import { describe, expect, it } from 'vitest';
import { searchGroceriesTool } from '../../../src/tools/search-groceries';

describe('searchGroceriesTool', () => {
  it('forwards to the GROCERY binding and shapes the response', async () => {
    const fakeGrocery: Fetcher = {
      async fetch() {
        return new Response(JSON.stringify({
          results: [{
            query: 'oats',
            matches: [{
              product: { name: 'Mock Oats', size: '1 kg', category: 'rolled_oats' },
              store: { name: 'Mock Store', chain: null },
              price: { amount: 4.99, currency: 'CAD', source: 'estimate' }
            }]
          }]
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    } as any;
    const ctx: any = { deps: { bindings: { grocery: fakeGrocery } } };
    const r = await searchGroceriesTool.handler({ items: ['oats'], lat: 51, lng: -114 }, ctx);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.matches[0]!.product.name).toBe('Mock Oats');
    expect(r.results[0]!.matches[0]!.price.source).toBe('estimate');
  });

  it('returns empty results when no GROCERY binding is available', async () => {
    const ctx: any = { deps: {} };
    const r = await searchGroceriesTool.handler({ items: ['oats'], lat: 51, lng: -114 }, ctx);
    expect(r.results).toEqual([]);
  });
});
