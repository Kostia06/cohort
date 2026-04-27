import { describe, expect, it } from 'vitest';
import { findNearbyStores } from '../../../services/grocery/src/stores';

const FAKE_PLACES_RESPONSE = {
  places: [
    {
      id: 'place-1',
      displayName: { text: 'Real Canadian Superstore' },
      location: { latitude: 51.05, longitude: -114.07 },
      formattedAddress: '123 Main St, Calgary'
    },
    {
      id: 'place-2',
      displayName: { text: 'Save-On-Foods' },
      location: { latitude: 51.06, longitude: -114.08 },
      formattedAddress: '456 Side Ave, Calgary'
    }
  ]
};

const fakeFetch = (async () => new Response(JSON.stringify(FAKE_PLACES_RESPONSE), {
  status: 200, headers: { 'Content-Type': 'application/json' }
})) as typeof fetch;

const fakeKv: KVNamespace = {
  get: async () => null,
  put: async () => {},
} as any;

describe('findNearbyStores', () => {
  it('queries Google Places and parses stores', async () => {
    const stores = await findNearbyStores(
      { lat: 51.05, lng: -114.07, radiusM: 5000 },
      { kv: fakeKv, fetch: fakeFetch, placesApiKey: 'k' }
    );
    expect(stores.length).toBe(2);
    expect(stores[0]!.name).toBe('Real Canadian Superstore');
    expect(stores[0]!.chain).toBe('loblaw');
    expect(stores[1]!.chain).toBe('saveon');
  });

  it('returns the cached value when present', async () => {
    const cachedStores = [{ place_id: 'cached', name: 'Cached', lat: 0, lng: 0, address: '', chain: null }];
    const kv: KVNamespace = {
      get: async () => JSON.stringify(cachedStores),
      put: async () => {}
    } as any;
    const fail = (async () => { throw new Error('should not be called'); }) as typeof fetch;
    const stores = await findNearbyStores(
      { lat: 51.05, lng: -114.07, radiusM: 5000 },
      { kv, fetch: fail, placesApiKey: 'k' }
    );
    expect(stores).toEqual(cachedStores);
  });
});
