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
    expect(r.source).toBe('estimate');
  });
});
