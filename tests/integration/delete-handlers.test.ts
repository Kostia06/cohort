import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s1','w1',0,'squat',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m1','u1',?,'oats','user')`).bind(NOW),
  ]);
});

describe('DELETE /v1/workout-sets/:id', () => {
  it('deletes the set', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workout-sets/s1', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workout-sets/s1', { method: 'DELETE' });
    expect(resp.status).toBe(401);
  });
});

describe('DELETE /v1/meals/:id', () => {
  it('deletes the meal', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals/m1', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
  });

  it('returns 404 for unknown meal', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals/no-such', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(resp.status).toBe(404);
  });
});
