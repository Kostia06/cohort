import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`
  ).run();
});

describe('GET /v1/plans/today', () => {
  it('returns empty aggregate when no data', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/plans/today?date=2026-04-25', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { readiness: null; planned_workouts: unknown[]; recent_meals: unknown[] };
    expect(data.readiness).toBeNull();
    expect(data.planned_workouts).toEqual([]);
    expect(data.recent_meals).toEqual([]);
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/plans/today', { method: 'GET' });
    expect(resp.status).toBe(401);
  });
});
