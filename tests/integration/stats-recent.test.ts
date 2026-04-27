import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`).run();
});

describe('GET /v1/stats/recent', () => {
  it('returns 7 days by default with empty defaults', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/stats/recent', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { days: any[] };
    expect(data.days.length).toBe(7);
    expect(data.days[0]!.workouts).toEqual({ logged: 0, planned: 0, skipped: 0 });
    expect(data.days[0]!.meals).toEqual({ count: 0, total_kcal: 0 });
  });

  it('supports ?days=14', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/stats/recent?days=14', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { days: any[] };
    expect(data.days.length).toBe(14);
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/stats/recent');
    expect(resp.status).toBe(401);
  });
});
