import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { searchGroceries } from '../../../services/grocery/src/search';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO price_estimates (category, region, price, currency, unit) VALUES ('rolled_oats','calgary',4.99,'CAD','1 kg')`).run();
});

describe('searchGroceries', () => {
  it('returns results combining stores, products, prices', async () => {
    const deps = {
      stores: async () => [{ place_id: 'p1', name: 'Superstore', lat: 0, lng: 0, address: '', chain: 'loblaw' }],
      products: async (_q: string) => [{
        name: 'Quaker Oats', size: '1 kg', category: 'rolled_oats',
        upc: 'q1', source: 'open_food_facts' as const, source_id: 'q1'
      }],
      db: env.DB,
      clock: () => Date.now()
    };
    const r = await searchGroceries(
      { items: ['rolled oats'], lat: 51, lng: -114, radius_m: 5000, region: 'calgary' },
      deps
    );
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.query).toBe('rolled oats');
    expect(r.results[0]!.matches.length).toBe(1);
    const m = r.results[0]!.matches[0]!;
    expect(m.product.name).toBe('Quaker Oats');
    expect(m.store.name).toBe('Superstore');
    expect(m.price.source).toBe('estimate');
    expect(m.price.amount).toBe(4.99);
  });
});
