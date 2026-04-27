import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`).run();
});

describe('GET /v1/stats/streaks', () => {
  it('returns zeros for fresh user', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/stats/streaks', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { workouts: number; meals: number; sync: number };
    expect(data).toEqual({ workouts: 0, meals: 0, sync: 0 });
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/stats/streaks');
    expect(resp.status).toBe(401);
  });
});
