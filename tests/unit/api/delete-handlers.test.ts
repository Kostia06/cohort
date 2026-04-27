import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleDeleteMeal, handleDeleteSet } from '../../../src/api/delete-handlers';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u2','Other','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_other','u2','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s1','w1',0,'squat',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s_other','w_other',0,'bench',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m1','u1',?,'oats','user')`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m_other','u2',?,'lunch','user')`).bind(NOW),
  ]);
});

describe('handleDeleteSet', () => {
  it('deletes a set owned by the user', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 's1' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT 1 FROM workout_sets WHERE set_id='s1'`).first();
    expect(row).toBeNull();
  });

  it('returns 404 for unknown set', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when set belongs to another user', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 's_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT 1 FROM workout_sets WHERE set_id='s_other'`).first();
    expect(row).not.toBeNull();
  });
});

describe('handleDeleteMeal', () => {
  it('deletes a meal owned by the user', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'm1' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT 1 FROM meals WHERE meal_id='m1'`).first();
    expect(row).toBeNull();
  });

  it('returns 404 for unknown meal', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when meal belongs to another user', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'm_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT 1 FROM meals WHERE meal_id='m_other'`).first();
    expect(row).not.toBeNull();
  });
});
