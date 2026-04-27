import { describe, expect, it } from 'vitest';
import { searchProducts } from '../../../services/grocery/src/products';

const OFF_RESPONSE = {
  products: [
    {
      code: '1234567890123',
      product_name: 'Quaker Rolled Oats',
      brands: 'Quaker',
      quantity: '1 kg',
      nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13.5, carbohydrates_100g: 67.7, fat_100g: 6.5 }
    }
  ]
};

const fakeKv: KVNamespace = {
  get: async () => null,
  put: async () => {}
} as any;

describe('searchProducts', () => {
  it('queries Open Food Facts and parses products', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify(OFF_RESPONSE), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch;

    const products = await searchProducts(
      { query: 'rolled oats', category: 'rolled_oats' },
      { kv: fakeKv, fetch: fakeFetch, usdaApiKey: 'u' }
    );
    expect(products.length).toBe(1);
    expect(products[0]!.name).toBe('Quaker Rolled Oats');
    expect(products[0]!.brand).toBe('Quaker');
    expect(products[0]!.upc).toBe('1234567890123');
    expect(products[0]!.per_100g_kcal).toBe(379);
    expect(products[0]!.source).toBe('open_food_facts');
  });

  it('returns cached results when present', async () => {
    const cached = [{ name: 'Cached', size: '', category: 'oats', source: 'usda', source_id: 'x' }];
    const kv: KVNamespace = {
      get: async () => JSON.stringify(cached),
      put: async () => {}
    } as any;
    const fail = (async () => { throw new Error('should not be called'); }) as typeof fetch;
    const r = await searchProducts({ query: 'oats', category: 'rolled_oats' }, { kv, fetch: fail, usdaApiKey: 'u' });
    expect(r).toEqual(cached);
  });
});
