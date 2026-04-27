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
