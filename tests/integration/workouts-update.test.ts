import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
  ]);
});

describe('PATCH /v1/workouts/:id', () => {
  it('marks a planned workout as logged', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' }),
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w1'`).first();
    expect(row).toEqual({ status: 'logged' });
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' }),
    });
    expect(resp.status).toBe(401);
  });

  it('returns 404 for unknown workout', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/no-such', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' }),
    });
    expect(resp.status).toBe(404);
  });
});
