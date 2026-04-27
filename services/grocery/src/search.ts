import { resolvePrice } from './prices';
import type { ProductMatch, SearchInput, SearchOutput, Store, Product } from './types';

export interface SearchDeps {
  stores: (input: { lat: number; lng: number; radiusM: number }) => Promise<Store[]>;
  products: (query: string, category: string) => Promise<Product[]>;
  db: D1Database;
  clock: () => number;
}

export async function searchGroceries(input: SearchInput, deps: SearchDeps): Promise<SearchOutput> {
  const radiusM = input.radius_m ?? 5000;
  const region = input.region ?? 'calgary';

  const stores = await deps.stores({ lat: input.lat, lng: input.lng, radiusM });
  const limitedStores = stores.slice(0, 5);

  const results = await Promise.all(input.items.map(async (item) => {
    const category = inferCategory(item);
    const products = await deps.products(item, category);
    const limitedProducts = products.slice(0, 5);
    const matches: ProductMatch[] = [];
    for (const product of limitedProducts) {
      for (const store of limitedStores) {
        const price = await resolvePrice(product, store, region, { db: deps.db, clock: deps.clock });
        matches.push({ product, store, price });
      }
    }
    return { query: item, matches };
  }));

  return { results };
}

function inferCategory(query: string): string {
  const q = query.toLowerCase();
  if (/\boat/.test(q)) return 'rolled_oats';
  if (/\bchicken breast\b/.test(q)) return 'chicken_breast';
  if (/\beggs?\b/.test(q)) return 'eggs_dozen';
  if (/\bmilk\b/.test(q)) return 'milk_2pct';
  if (/\bground beef\b/.test(q)) return 'ground_beef_lean';
  if (/\bbrown rice\b/.test(q)) return 'rice_brown';
  if (/\b(white )?rice\b/.test(q)) return 'rice_white';
  if (/\bpasta\b/.test(q)) return 'pasta_dry';
  if (/\bbread\b/.test(q)) return 'bread_whole_wheat';
  if (/\bbananas?\b/.test(q)) return 'bananas';
  if (/\bapples?\b/.test(q)) return 'apples';
  if (/\bbroccoli\b/.test(q)) return 'broccoli';
  if (/\bspinach\b/.test(q)) return 'spinach';
  if (/\bolive oil\b/.test(q)) return 'olive_oil';
  if (/\bpeanut butter\b/.test(q)) return 'peanut_butter';
  if (/\b(greek )?yogurt\b/.test(q)) return 'greek_yogurt';
  if (/\bsalmon\b/.test(q)) return 'salmon_fillet';
  if (/\btofu\b/.test(q)) return 'tofu_firm';
  if (/\balmonds?\b/.test(q)) return 'almonds_raw';
  if (/\bprotein powder\b/.test(q)) return 'protein_powder_whey';
  return 'unknown';
}
