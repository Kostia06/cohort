import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleMealCreate } from '../../../src/api/meals-create';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`
  ).run();
});

describe('handleMealCreate', () => {
  it('inserts a meal and returns ok with meal_id', async () => {
    const r = await handleMealCreate({
      db: env.DB,
      userId: 'u1',
      now: 1000,
      input: { name: 'Oatmeal', kcal: 300 },
    });
    expect(r.ok).toBe(true);
    expect(r.meal_id).toMatch(/^meal_u1_/);
    const row = await env.DB.prepare(`SELECT * FROM meals WHERE meal_id=?`).bind(r.meal_id).first<Record<string, unknown>>();
    expect(row?.name).toBe('Oatmeal');
    expect(row?.kcal).toBe(300);
    expect(row?.eaten_at).toBe(1000);
    expect(row?.source).toBe('user');
  });

  it('uses custom eaten_at when provided', async () => {
    const customTime = 9999999;
    const r = await handleMealCreate({
      db: env.DB,
      userId: 'u1',
      now: 1000,
      input: { name: 'Salad', eaten_at: customTime },
    });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT eaten_at FROM meals WHERE meal_id=?`).bind(r.meal_id).first<{ eaten_at: number }>();
    expect(row?.eaten_at).toBe(customTime);
  });

  it('returns 400 when name is missing', async () => {
    const r = await handleMealCreate({
      db: env.DB,
      userId: 'u1',
      now: 1000,
      input: { name: '' },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
