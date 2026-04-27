# Grocery Worker — Plan 7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `search_groceries` agent-tool stub with a real Worker that finds products at nearby stores with prices. Implements the layered architecture from the original deep-dive doc: Google Places (stores) → Open Food Facts + USDA (products) → community/estimate (prices).

**Architecture:** Separate Worker at `services/grocery/`. One endpoint: `POST /search`. The Worker concurrently runs three layers:
1. **Stores layer** — Google Places `nearbySearch` for grocery stores in radius. Cached in KV (~7 days).
2. **Products layer** — Open Food Facts API + USDA FoodData Central API for each query item. Cached in KV (~30 days).
3. **Prices layer** — D1 `community_prices` table → `price_estimates` table → `unknown`. No external API in v1.

The agent's `search_groceries` tool calls into this via a service binding.

**Tech Stack:** Cloudflare Workers, D1 (community_prices + price_estimates tables — shared with the agent runtime), KV (cache), Google Places API, Open Food Facts API, USDA FoodData Central API.

**Spec:** Per the deep-dive doc § "Part 1 — Grocery search."

**Out of scope (deferred to future plans):**
- US-specific live price APIs (Kroger Catalog) — Calgary v1 has no Kroger.
- Flipp flyer aggregation.
- Real-time barcode scanning / receipt parsing.
- Distance computation per-store (uses haversine on lat/lng — straightforward but not v1 critical).
- Chain detection beyond a small allow-list.

---

## File Structure

```
services/grocery/
  wrangler.toml                          # NEW
  src/
    index.ts                             # NEW: POST /search entrypoint
    stores.ts                            # NEW: Google Places lookup + KV cache
    products.ts                          # NEW: Open Food Facts + USDA + KV cache
    prices.ts                            # NEW: community → estimate → unknown
    search.ts                            # NEW: orchestrate layers
    chains.ts                            # NEW: detectChain + chain regex map
    types.ts                             # NEW: shared types
    seed-estimates.json                  # NEW: Calgary v1 price estimates seed

src/db/migrations/
  0004_grocery.sql                       # NEW: community_prices, price_estimates

src/api/worker.ts                        # MODIFY: add GROCERY service binding usage
src/tools/search-groceries.ts            # MODIFY: real binding call
src/types.ts                             # MODIFY: add GROCERY binding to Env
src/do/user-agent-do.ts                  # MODIFY: pass grocery binding into RuntimeDeps
worker-configuration.d.ts                # MODIFY
wrangler.toml                            # MODIFY: add [[services]] grocery
vitest.config.ts                         # MODIFY: add mock-grocery worker for tests

tests/
  fakes/seed.ts                          # MODIFY: add new tables to inline schema
  unit/grocery/
    stores.test.ts                       # NEW
    products.test.ts                     # NEW
    prices.test.ts                       # NEW
    search.test.ts                       # NEW
    chains.test.ts                       # NEW
  unit/tools/search-groceries.test.ts    # MODIFY: now exercises binding
```

---

## Phase 1: Schema + chain detection + estimates seed

### Task 1: Migration 0004 + price-estimates seed

**Files:**
- Create: `src/db/migrations/0004_grocery.sql`
- Create: `services/grocery/src/seed-estimates.json`
- Modify: `tests/fakes/seed.ts`

Two tables: `community_prices` (user-submitted prices, keyed by upc + store_place_id) and `price_estimates` (regional fallback, keyed by category + region).

- [ ] **Step 1: Create `src/db/migrations/0004_grocery.sql`**

```sql
-- src/db/migrations/0004_grocery.sql

CREATE TABLE community_prices (
  upc              TEXT NOT NULL,
  store_place_id   TEXT NOT NULL,
  price            REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  submitted_by     TEXT NOT NULL,
  submitted_at     INTEGER NOT NULL,
  PRIMARY KEY (upc, store_place_id, submitted_at)
);

CREATE INDEX idx_community_prices_lookup
  ON community_prices(upc, store_place_id, submitted_at DESC);

CREATE TABLE price_estimates (
  category         TEXT NOT NULL,
  region           TEXT NOT NULL,
  price            REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  unit             TEXT NOT NULL,           -- '1 kg', '500 g', 'each'
  PRIMARY KEY (category, region)
);
```

- [ ] **Step 2: Create `services/grocery/src/seed-estimates.json`**

```json
[
  { "category": "rolled_oats", "region": "calgary", "price": 4.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "chicken_breast", "region": "calgary", "price": 14.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "eggs_dozen", "region": "calgary", "price": 4.49, "currency": "CAD", "unit": "12 ct" },
  { "category": "milk_2pct", "region": "calgary", "price": 4.99, "currency": "CAD", "unit": "2 L" },
  { "category": "ground_beef_lean", "region": "calgary", "price": 10.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "rice_white", "region": "calgary", "price": 3.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "rice_brown", "region": "calgary", "price": 5.49, "currency": "CAD", "unit": "1 kg" },
  { "category": "pasta_dry", "region": "calgary", "price": 2.99, "currency": "CAD", "unit": "500 g" },
  { "category": "bread_whole_wheat", "region": "calgary", "price": 3.99, "currency": "CAD", "unit": "1 loaf" },
  { "category": "bananas", "region": "calgary", "price": 1.69, "currency": "CAD", "unit": "1 kg" },
  { "category": "apples", "region": "calgary", "price": 4.49, "currency": "CAD", "unit": "1 kg" },
  { "category": "broccoli", "region": "calgary", "price": 3.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "spinach", "region": "calgary", "price": 4.49, "currency": "CAD", "unit": "454 g" },
  { "category": "olive_oil", "region": "calgary", "price": 11.99, "currency": "CAD", "unit": "1 L" },
  { "category": "peanut_butter", "region": "calgary", "price": 6.99, "currency": "CAD", "unit": "750 g" },
  { "category": "greek_yogurt", "region": "calgary", "price": 6.49, "currency": "CAD", "unit": "750 g" },
  { "category": "salmon_fillet", "region": "calgary", "price": 24.99, "currency": "CAD", "unit": "1 kg" },
  { "category": "tofu_firm", "region": "calgary", "price": 3.49, "currency": "CAD", "unit": "350 g" },
  { "category": "almonds_raw", "region": "calgary", "price": 14.99, "currency": "CAD", "unit": "500 g" },
  { "category": "protein_powder_whey", "region": "calgary", "price": 49.99, "currency": "CAD", "unit": "2 lb" }
]
```

(20 staples for Calgary v1. Easy to extend.)

- [ ] **Step 3: Apply migration locally**

```
wrangler d1 execute cohort --local --file=src/db/migrations/0004_grocery.sql
```

- [ ] **Step 4: Update `tests/fakes/seed.ts`**

Append to SCHEMA (with IF NOT EXISTS) and prepend DELETEs to resetDb. Same pattern as Plans 3, 4, 6.

- [ ] **Step 5: Run tests + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Expected: 80 PASS (no new tests yet). Typecheck clean.

- [ ] **Step 6: Commit**

```
git add src/db/migrations/0004_grocery.sql services/grocery/src/seed-estimates.json tests/fakes/seed.ts
git commit -m "Add migration 0004: community_prices, price_estimates + Calgary seed"
```

---

### Task 2: Chain detection module

**Files:**
- Create: `services/grocery/src/chains.ts`
- Create: `tests/unit/grocery/chains.test.ts`

`detectChain(name)` maps a Google Places display name to a chain identifier (or null). Used for metadata + future per-chain price logic.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/grocery/chains.test.ts
import { describe, expect, it } from 'vitest';
import { detectChain } from '../../../services/grocery/src/chains';

describe('detectChain', () => {
  it.each([
    ['Real Canadian Superstore', 'loblaw'],
    ['No Frills', 'loblaw'],
    ['Safeway', 'sobeys'],
    ['Sobeys', 'sobeys'],
    ['Save-On-Foods', 'saveon'],
    ['Save On Foods', 'saveon'],
    ['Calgary Co-op', 'calgary_coop'],
    ['Co-op Grocery', 'calgary_coop'],
    ['Costco Wholesale', 'costco'],
    ['Walmart Supercenter', 'walmart'],
    ['Some Mom and Pop', null]
  ])('detects %s as %s', (name, expected) => {
    expect(detectChain(name)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/grocery/chains.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `services/grocery/src/chains.ts`**

```ts
const CHAIN_PATTERNS: Array<{ regex: RegExp; chain: string }> = [
  { regex: /\b(?:real canadian )?superstore\b/i, chain: 'loblaw' },
  { regex: /\bno frills\b/i, chain: 'loblaw' },
  { regex: /\b(?:safeway|sobeys)\b/i, chain: 'sobeys' },
  { regex: /\bsave[- ]on[- ]foods\b/i, chain: 'saveon' },
  { regex: /\b(?:calgary )?co[- ]?op\b/i, chain: 'calgary_coop' },
  { regex: /\bcostco\b/i, chain: 'costco' },
  { regex: /\bwalmart\b/i, chain: 'walmart' },
  { regex: /\bkroger\b/i, chain: 'kroger' }
];

export function detectChain(name: string): string | null {
  for (const { regex, chain } of CHAIN_PATTERNS) {
    if (regex.test(name)) return chain;
  }
  return null;
}
```

- [ ] **Step 4: Pass + commit**

```
git add services/grocery/src/chains.ts tests/unit/grocery/chains.test.ts
git commit -m "Add grocery chain detection"
```

---

## Phase 2: Layered modules

### Task 3: Stores layer (Google Places + KV cache)

**Files:**
- Create: `services/grocery/src/stores.ts`
- Create: `services/grocery/src/types.ts`
- Create: `tests/unit/grocery/stores.test.ts`

`findNearbyStores(lat, lng, radiusM, deps)` returns up to 15 grocery stores. Caches by lat/lng bucket (rounded to 0.01 = ~1km) + radius for 7 days. Production uses Google Places `nearbySearch`. Tests use a stub fetch.

- [ ] **Step 1: Write `services/grocery/src/types.ts`**

```ts
export interface Store {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  chain: string | null;
}

export interface Product {
  name: string;
  brand?: string;
  upc?: string;
  size: string;
  category: string;
  per_100g_kcal?: number;
  per_100g_protein_g?: number;
  per_100g_carbs_g?: number;
  per_100g_fat_g?: number;
  source: 'open_food_facts' | 'usda';
  source_id: string;
}

export interface PriceInfo {
  amount: number;
  currency: string;
  source: 'community' | 'estimate' | 'unknown';
  as_of?: number;
}

export interface ProductMatch {
  product: Product;
  store: Store;
  price: PriceInfo;
}

export interface SearchInput {
  items: string[];
  lat: number;
  lng: number;
  radius_m?: number;
  region?: string;
  dietary_filters?: {
    pattern?: 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian' | 'keto';
    allergies?: string[];
    dislikes?: string[];
  };
}

export interface SearchOutput {
  results: Array<{
    query: string;
    matches: ProductMatch[];
  }>;
}
```

- [ ] **Step 2: Write failing test `tests/unit/grocery/stores.test.ts`**

```ts
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
```

- [ ] **Step 3: Run + fail**

`pnpm test tests/unit/grocery/stores.test.ts -- --run` → FAIL.

- [ ] **Step 4: Implement `services/grocery/src/stores.ts`**

```ts
import { detectChain } from './chains';
import type { Store } from './types';

export interface StoresInput {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface StoresDeps {
  kv: KVNamespace;
  fetch: typeof fetch;
  placesApiKey: string;
}

const CACHE_TTL_SEC = 7 * 24 * 60 * 60;

export async function findNearbyStores(input: StoresInput, deps: StoresDeps): Promise<Store[]> {
  const cacheKey = cacheKeyFor(input);
  const cached = await deps.kv.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as Store[]; } catch { /* fall through */ }
  }

  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  const body = {
    includedTypes: ['grocery_store', 'supermarket'],
    locationRestriction: {
      circle: { center: { latitude: input.lat, longitude: input.lng }, radius: input.radiusM }
    },
    maxResultCount: 15
  };
  const resp = await deps.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': deps.placesApiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`places api ${resp.status}`);
  }
  const data = await resp.json() as { places?: Array<{ id: string; displayName?: { text: string }; location: { latitude: number; longitude: number }; formattedAddress?: string }> };
  const stores: Store[] = (data.places ?? []).map((p) => ({
    place_id: p.id,
    name: p.displayName?.text ?? 'Unknown',
    lat: p.location.latitude,
    lng: p.location.longitude,
    address: p.formattedAddress ?? '',
    chain: detectChain(p.displayName?.text ?? '')
  }));
  await deps.kv.put(cacheKey, JSON.stringify(stores), { expirationTtl: CACHE_TTL_SEC });
  return stores;
}

function cacheKeyFor(input: StoresInput): string {
  // 0.01° ≈ 1.1 km. Stable cache key across small motion.
  return `stores:${input.lat.toFixed(2)}:${input.lng.toFixed(2)}:${input.radiusM}`;
}
```

- [ ] **Step 5: Pass + commit**

```
git add services/grocery/src/stores.ts services/grocery/src/types.ts tests/unit/grocery/stores.test.ts
git commit -m "Add grocery stores layer (Google Places + KV cache)"
```

---

### Task 4: Products layer (Open Food Facts + USDA)

**Files:**
- Create: `services/grocery/src/products.ts`
- Create: `tests/unit/grocery/products.test.ts`

`searchProducts(query, deps)` returns up to 5 products. Tries Open Food Facts first (free, no key); if zero results, falls back to USDA FoodData Central. Caches by normalized query string for 30 days.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/grocery/products.test.ts
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
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/grocery/products.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `services/grocery/src/products.ts`**

```ts
import type { Product } from './types';

export interface ProductsInput {
  query: string;
  category: string;  // e.g. 'rolled_oats' from the agent's request mapping
}

export interface ProductsDeps {
  kv: KVNamespace;
  fetch: typeof fetch;
  usdaApiKey: string;
}

const CACHE_TTL_SEC = 30 * 24 * 60 * 60;

export async function searchProducts(input: ProductsInput, deps: ProductsDeps): Promise<Product[]> {
  const key = `products:${normalize(input.query)}`;
  const cached = await deps.kv.get(key);
  if (cached) {
    try { return JSON.parse(cached) as Product[]; } catch { /* fall through */ }
  }

  let products = await searchOpenFoodFacts(input, deps);
  if (products.length === 0) {
    products = await searchUSDA(input, deps);
  }
  products = products.slice(0, 5);
  await deps.kv.put(key, JSON.stringify(products), { expirationTtl: CACHE_TTL_SEC });
  return products;
}

async function searchOpenFoodFacts(input: ProductsInput, deps: ProductsDeps): Promise<Product[]> {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(input.query)}&search_simple=1&action=process&json=1&page_size=10`;
  const resp = await deps.fetch(url);
  if (!resp.ok) return [];
  const data = await resp.json() as { products?: Array<{ code: string; product_name?: string; brands?: string; quantity?: string; nutriments?: Record<string, number> }> };
  return (data.products ?? []).filter((p) => p.product_name).map((p) => ({
    name: p.product_name ?? '',
    brand: (p.brands ?? '').split(',')[0]?.trim() || undefined,
    upc: p.code,
    size: p.quantity ?? '',
    category: input.category,
    per_100g_kcal: p.nutriments?.['energy-kcal_100g'],
    per_100g_protein_g: p.nutriments?.proteins_100g,
    per_100g_carbs_g: p.nutriments?.carbohydrates_100g,
    per_100g_fat_g: p.nutriments?.fat_100g,
    source: 'open_food_facts' as const,
    source_id: p.code
  }));
}

async function searchUSDA(input: ProductsInput, deps: ProductsDeps): Promise<Product[]> {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(input.query)}&pageSize=5&api_key=${deps.usdaApiKey}`;
  const resp = await deps.fetch(url);
  if (!resp.ok) return [];
  const data = await resp.json() as { foods?: Array<{ fdcId: number; description: string; foodNutrients?: Array<{ nutrientId: number; value: number }> }> };
  return (data.foods ?? []).map((f) => {
    const kcal = f.foodNutrients?.find((n) => n.nutrientId === 1008)?.value;
    const protein = f.foodNutrients?.find((n) => n.nutrientId === 1003)?.value;
    const carbs = f.foodNutrients?.find((n) => n.nutrientId === 1005)?.value;
    const fat = f.foodNutrients?.find((n) => n.nutrientId === 1004)?.value;
    return {
      name: f.description,
      size: '',
      category: input.category,
      per_100g_kcal: kcal,
      per_100g_protein_g: protein,
      per_100g_carbs_g: carbs,
      per_100g_fat_g: fat,
      source: 'usda' as const,
      source_id: String(f.fdcId)
    };
  });
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
```

- [ ] **Step 4: Pass + commit**

```
git add services/grocery/src/products.ts tests/unit/grocery/products.test.ts
git commit -m "Add grocery products layer (OFF + USDA fallback + KV cache)"
```

---

### Task 5: Prices layer (community → estimate → unknown)

**Files:**
- Create: `services/grocery/src/prices.ts`
- Create: `tests/unit/grocery/prices.test.ts`

`resolvePrice(product, store, region, deps)` returns `PriceInfo`. Tries community_prices (most recent within 60 days), then price_estimates (by category + region), then `{source: 'unknown'}`.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/grocery/prices.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { resolvePrice } from '../../../services/grocery/src/prices';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO price_estimates (category, region, price, currency, unit) VALUES ('rolled_oats','calgary',4.99,'CAD','1 kg')`),
    env.DB.prepare(`INSERT INTO community_prices (upc, store_place_id, price, currency, submitted_by, submitted_at) VALUES ('123','place-1',5.49,'CAD','u1',?)`).bind(Date.now() - 1_000_000)
  ]);
});

describe('resolvePrice', () => {
  it('prefers a recent community price when present', async () => {
    const r = await resolvePrice(
      { upc: '123', category: 'rolled_oats' } as any,
      { place_id: 'place-1' } as any,
      'calgary',
      { db: env.DB, clock: () => Date.now() }
    );
    expect(r.source).toBe('community');
    expect(r.amount).toBe(5.49);
  });

  it('falls back to estimate when no community price', async () => {
    const r = await resolvePrice(
      { upc: '999', category: 'rolled_oats' } as any,
      { place_id: 'place-2' } as any,
      'calgary',
      { db: env.DB, clock: () => Date.now() }
    );
    expect(r.source).toBe('estimate');
    expect(r.amount).toBe(4.99);
  });

  it('returns unknown when neither layer matches', async () => {
    const r = await resolvePrice(
      { upc: '999', category: 'unknown_category' } as any,
      { place_id: 'place-X' } as any,
      'calgary',
      { db: env.DB, clock: () => Date.now() }
    );
    expect(r.source).toBe('unknown');
  });

  it('ignores stale community prices (>60 days)', async () => {
    await env.DB.prepare(`INSERT INTO community_prices (upc, store_place_id, price, currency, submitted_by, submitted_at) VALUES ('456','place-3',8.99,'CAD','u1',?)`).bind(Date.now() - 70 * 24 * 60 * 60 * 1000).run();
    const r = await resolvePrice(
      { upc: '456', category: 'rolled_oats' } as any,
      { place_id: 'place-3' } as any,
      'calgary',
      { db: env.DB, clock: () => Date.now() }
    );
    expect(r.source).toBe('estimate');  // stale community → fall through to estimate
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/grocery/prices.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `services/grocery/src/prices.ts`**

```ts
import type { PriceInfo, Product, Store } from './types';

export interface PricesDeps {
  db: D1Database;
  clock: () => number;
}

const COMMUNITY_FRESH_MS = 60 * 24 * 60 * 60 * 1000;

export async function resolvePrice(
  product: Product,
  store: Store,
  region: string,
  deps: PricesDeps
): Promise<PriceInfo> {
  if (product.upc) {
    const cutoff = deps.clock() - COMMUNITY_FRESH_MS;
    const community = await deps.db.prepare(
      `SELECT price, currency, submitted_at FROM community_prices
       WHERE upc = ? AND store_place_id = ? AND submitted_at > ?
       ORDER BY submitted_at DESC LIMIT 1`
    ).bind(product.upc, store.place_id, cutoff).first<{ price: number; currency: string; submitted_at: number }>();
    if (community) {
      return {
        amount: community.price,
        currency: community.currency,
        source: 'community',
        as_of: community.submitted_at
      };
    }
  }

  const estimate = await deps.db.prepare(
    `SELECT price, currency FROM price_estimates WHERE category = ? AND region = ?`
  ).bind(product.category, region).first<{ price: number; currency: string }>();
  if (estimate) {
    return { amount: estimate.price, currency: estimate.currency, source: 'estimate' };
  }

  return { amount: 0, currency: 'CAD', source: 'unknown' };
}
```

- [ ] **Step 4: Pass + commit**

```
git add services/grocery/src/prices.ts tests/unit/grocery/prices.test.ts
git commit -m "Add grocery prices layer (community → estimate → unknown)"
```

---

### Task 6: Search orchestration

**Files:**
- Create: `services/grocery/src/search.ts`
- Create: `tests/unit/grocery/search.test.ts`

`searchGroceries(input, deps)` runs `findNearbyStores` once, then for each item runs `searchProducts` × `resolvePrice` per store, in parallel. Returns `SearchOutput`.

- [ ] **Step 1: Write failing test (high-level integration of the layers via injected fakes)**

```ts
// tests/unit/grocery/search.test.ts
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
      products: async (q: string) => [{
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
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/grocery/search.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `services/grocery/src/search.ts`**

```ts
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
  // Minimal mapping for the v1 seed list. Extend as needed.
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
```

- [ ] **Step 4: Pass + commit**

```
git add services/grocery/src/search.ts tests/unit/grocery/search.test.ts
git commit -m "Add grocery search orchestration"
```

---

## Phase 3: Worker entrypoint + binding

### Task 7: Grocery Worker entrypoint

**Files:**
- Create: `services/grocery/wrangler.toml`
- Create: `services/grocery/src/index.ts`

- [ ] **Step 1: Create `services/grocery/wrangler.toml`**

```toml
name = "cohort-grocery"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "cohort"
database_id = "00000000-0000-0000-0000-000000000001"

[[kv_namespaces]]
binding = "GROCERY_KV"
id = "00000000000000000000000000000000"
```

(For deployment: `wrangler kv:namespace create GROCERY_KV` and paste the real ID.)

- [ ] **Step 2: Create `services/grocery/src/index.ts`**

```ts
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
```

- [ ] **Step 3: Typecheck + commit**

`pnpm typecheck` — exit 0.

```
git add services/grocery/wrangler.toml services/grocery/src/index.ts
git commit -m "Add grocery-worker entrypoint with /search route"
```

---

### Task 8: Wire grocery binding into agent

**Files:**
- Modify: `wrangler.toml` — add `[[services]]` for cohort-grocery.
- Modify: `src/types.ts` — add `GROCERY: Fetcher` to `Env`.
- Modify: `worker-configuration.d.ts`.
- Modify: `vitest.config.ts` — add a mock-grocery worker.
- Modify: `src/tools/search-groceries.ts` — replace stub with binding call.
- Modify: `src/do/user-agent-do.ts` — pass `bindings.grocery` into RuntimeDeps in both deps constructions.
- Modify: `tests/unit/tools/search-groceries.test.ts` — exercise the binding path.

Mirror the pattern from Plan 6 Task 7 (research). The mock-grocery worker should return a deterministic SearchOutput shape.

Mock-grocery script:
```js
export default { async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/search') {
    return new Response(JSON.stringify({
      results: [{
        query: 'rolled oats',
        matches: [{
          product: { name: 'Mock Oats', size: '1 kg', category: 'rolled_oats', source: 'open_food_facts', source_id: 'm1' },
          store: { place_id: 'p1', name: 'Mock Store', lat: 0, lng: 0, address: '', chain: null },
          price: { amount: 4.99, currency: 'CAD', source: 'estimate' }
        }]
      }]
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
} };
```

`search-groceries.ts` after replacement:

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Input {
  items: string[];
  lat: number;
  lng: number;
  radius_m?: number;
  region?: string;
}

interface Output {
  results: Array<{
    query: string;
    matches: Array<{
      product: { name: string; brand?: string; size: string; category: string };
      store: { name: string; chain: string | null };
      price: { amount: number; currency: string; source: string };
    }>;
  }>;
}

export const searchGroceriesTool: ToolDef<Input, Output> = {
  name: 'search_groceries',
  description: 'Find products at nearby grocery stores with prices. Returns matched products, the stores carrying them, and price + price source (community / estimate / unknown).',
  inputSchema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string' }, minItems: 1 },
      lat: { type: 'number' },
      lng: { type: 'number' },
      radius_m: { type: 'integer', minimum: 100, maximum: 50000 },
      region: { type: 'string' }
    },
    required: ['items', 'lat', 'lng'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const grocery = (ctx.deps as any).bindings?.grocery as Fetcher | undefined;
    if (!grocery) return { results: [] };
    const resp = await grocery.fetch('https://grocery/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    if (!resp.ok) return { results: [] };
    const data = await resp.json() as Output;
    // Trim each match list down for SSE summary friendliness.
    return {
      results: data.results.map((r) => ({
        query: r.query,
        matches: r.matches.slice(0, 5)
      }))
    };
  }
};
```

Tests cover: forwards to binding + returns shaped data; returns empty when binding missing.

DO update: in both `handleChat` and `handleRunBatch`, the deps construction should be:

```ts
bindings: { research: this.env.RESEARCH, grocery: this.env.GROCERY }
```

- [ ] **Step 1-7: Apply the file changes above**
- [ ] **Step 8: Run tests + typecheck**

`pnpm test -- --run` — should be ~88 PASS (80 + 8 new: 1 chains + 2 stores + 2 products + 4 prices + 1 search + 2 tool — actually the tool test changes from 1 to 2, so net +1 there; total +12 → 92).

(Approximate. Take whatever the actual count is.)

- [ ] **Step 9: Commit**

```
git add wrangler.toml src/types.ts worker-configuration.d.ts vitest.config.ts src/tools/search-groceries.ts src/do/user-agent-do.ts tests/unit/tools/search-groceries.test.ts
git commit -m "Wire grocery-worker into agent via service binding"
```

---

## Phase 4: Final readiness

### Task 9: Final + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```

- [ ] **Step 2: Append to `docs/superpowers/runbooks/2026-04-25-vertical-slice-smoke-test.md`**

```markdown

---

## After Plan 7: grocery-worker

**Setup (one-time):**
```
wrangler kv:namespace create GROCERY_KV
# paste the returned id into services/grocery/wrangler.toml
wrangler secret put GOOGLE_PLACES_KEY --config services/grocery/wrangler.toml
wrangler secret put USDA_API_KEY --config services/grocery/wrangler.toml
wrangler deploy --config services/grocery/wrangler.toml
wrangler deploy   # api Worker, picks up the new GROCERY service binding
```

**Seed price estimates (Calgary v1):** the migration applies seed data via a follow-up seed script (or use the one-liner: `node -e 'console.log(JSON.stringify(require("./services/grocery/src/seed-estimates.json")))' | jq -r '.[]| "INSERT INTO price_estimates (category, region, price, currency, unit) VALUES (\"\(.category)\",\"\(.region)\",\(.price),\"\(.currency)\",\"\(.unit)\");"' | xargs -I{} wrangler d1 execute cohort --remote --command "{}"`).

24. **Direct grocery search:**
    ```
    curl -X POST https://cohort-grocery.<your>.workers.dev/search \
      -H "Content-Type: application/json" \
      -d '{"items":["rolled oats","chicken breast"],"lat":51.05,"lng":-114.07,"radius_m":5000,"region":"calgary"}'
    ```
    Expected: JSON with `results: [{query, matches: [...]}, ...]`. Each match includes product, store, price (with source = community | estimate | unknown).

25. **Search via the agent:**
    ```
    curl -N -X POST https://<your-api>.workers.dev/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"what are oats and chicken going for nearby? im at 51.05, -114.07"}'
    ```
    Expected SSE: `tool_call_start` for `search_groceries`, `tool_call_result` with summary, then a response that mentions a couple stores + estimated prices.

26. **Submit a community price (future):** not yet exposed; deferred to a future plan.

## Plan 7 known limitations (deferred)

- **No real-time chain prices** — Calgary chains have no public APIs. v1 uses static seed estimates + community submissions (which require a future submission UI).
- **Category mapping is hardcoded** in `inferCategory`. Extending the v1 list of 20 staples requires editing the function. A LLM-based extraction is a future plan.
- **No store-level prices** — every store gets the same regional estimate. Per-chain price hints (e.g. Costco usually cheaper for bulk) are deferred.
- **No haversine sort** — stores are returned in Google's order; not sorted by distance. Cheap to add.
- **No per-tenant data** — papers and grocery results are global.

## Final P1 → P7 capability matrix

| Capability | P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---|---|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tools | 1 | 1 | 9 | 9 | 9 | 9 | 9 |
| Preflight + post-review | partial | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cancel | ✗ | DO-wide | DO-wide | per-thread | per-thread | per-thread | per-thread |
| SSE replay | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Daily cost cap | ✗ | rolling 24h | rolling 24h | calendar-day | calendar-day | calendar-day | calendar-day |
| Batch turn | ✗ | ✗ | manual | cron | cron | cron | cron |
| Janitor | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Auth | X-User-Id | X-User-Id | X-User-Id | X-User-Id | JWT (HS256) | JWT (HS256) | JWT (HS256) |
| `search_research` | ✗ | ✗ | stub | stub | stub | **real** | real |
| `search_groceries` | ✗ | ✗ | stub | stub | stub | stub | **real (Calgary v1)** |
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 7 grocery-worker smoke checks"
```

---

## Self-review notes

- **Spec coverage:** 3-layer architecture (stores / products / prices) ✓, regional fallback ✓, KV caching ✓, service binding wired ✓.
- **Placeholder scan:** the `inferCategory` function is intentionally minimal — covers the seed list, deferred to a future plan for broader coverage.
- **Type consistency:** all new types in `services/grocery/src/types.ts`. Search composes via injected deps.
- **Scope:** 9 tasks. ~12 new tests. Test count 80 → ~92.
