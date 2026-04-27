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
    return {
      results: data.results.map((r) => ({
        query: r.query,
        matches: r.matches.slice(0, 5)
      }))
    };
  }
};
