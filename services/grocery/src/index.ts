import { findNearbyStores } from './stores';
import { searchProducts } from './products';
import { searchGroceries } from './search';
import type { SearchInput } from './types';

interface Env {
  DB: D1Database;
  GROCERY_KV: KVNamespace;
  GOOGLE_PLACES_KEY: string;
  USDA_API_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/search') {
      const body = await req.json<SearchInput>();
      if (!body?.items?.length) return new Response('missing items', { status: 400 });

      const deps = {
        stores: async (i: { lat: number; lng: number; radiusM: number }) =>
          findNearbyStores(i, { kv: env.GROCERY_KV, fetch, placesApiKey: env.GOOGLE_PLACES_KEY }),
        products: async (query: string, category: string) =>
          searchProducts({ query, category }, { kv: env.GROCERY_KV, fetch, usdaApiKey: env.USDA_API_KEY }),
        db: env.DB,
        clock: () => Date.now()
      };

      const result = await searchGroceries(body, deps);
      return Response.json(result);
    }

    return new Response('not found', { status: 404 });
  }
};
