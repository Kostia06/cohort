import type { Product } from './types';

export interface ProductsInput {
  query: string;
  category: string;
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
  const data = await resp.json() as {
    products?: Array<{
      code: string;
      product_name?: string;
      brands?: string;
      quantity?: string;
      nutriments?: Record<string, number>;
    }>;
  };
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
  const data = await resp.json() as {
    foods?: Array<{
      fdcId: number;
      description: string;
      foodNutrients?: Array<{ nutrientId: number; value: number }>;
    }>;
  };
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
