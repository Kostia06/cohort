import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getRecentMealsTool } from '../../../src/tools/get-recent-meals';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m1','u1',?,'oatmeal',380)`).bind(NOW - 1 * DAY),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m2','u1',?,'salad',220)`).bind(NOW - 3 * DAY),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m3','u1',?,'old burger',900)`).bind(NOW - 14 * DAY)
  ]);
});

describe('getRecentMealsTool', () => {
  it('returns meals from the last 7 days by default', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getRecentMealsTool.handler({}, ctx);
    expect(r.meals.length).toBe(2);
    expect(r.meals[0]!.name).toBe('oatmeal');
    expect(r.meals[1]!.name).toBe('salad');
  });

  it('honors custom days parameter', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getRecentMealsTool.handler({ days: 30 }, ctx);
    expect(r.meals.length).toBe(3);
  });
});
