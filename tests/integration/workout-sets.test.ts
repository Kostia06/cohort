import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`)
  ]);
});

describe('GET /v1/workouts/:id', () => {
  it('returns workout with empty sets', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { workout: any; sets: any[] };
    expect(data.workout.workout_id).toBe('w1');
    expect(data.sets).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workouts/w1');
    expect(resp.status).toBe(401);
  });
});

describe('POST /v1/workouts/:id/sets', () => {
  it('creates a set', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1/sets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ exercise: 'squat', reps: 5, weight_kg: 100, rpe: 7 })
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { ok: boolean; set_id: string; ordinal: number };
    expect(data.ok).toBe(true);
    expect(data.ordinal).toBe(0);
  });

  it('returns 400 for missing exercise', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1/sets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(resp.status).toBe(400);
  });
});
