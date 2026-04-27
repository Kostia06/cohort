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

describe('POST /v1/meals', () => {
  it('creates a meal and returns meal_id', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Eggs', kcal: 200, protein_g: 14 }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { meal_id?: string };
    expect(body.meal_id).toMatch(/^meal_u1_/);
  });

  it('returns 400 when name is missing', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kcal: 200 }),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Eggs' }),
    });
    expect(resp.status).toBe(401);
  });
});
