import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'omnivore','[]','[]',150,1)`
  ).run();
});

describe('GET /v1/me', () => {
  it('returns the profile', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { display_name: string };
    expect(data.display_name).toBe('Alex');
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/me');
    expect(resp.status).toBe(401);
  });
});

describe('PATCH /v1/me', () => {
  it('updates the profile', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'A.', age_years: 33 }),
    });
    expect(resp.status).toBe(200);
    const get = await SELF.fetch('https://api/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await get.json() as { display_name: string; age_years: number };
    expect(data.display_name).toBe('A.');
    expect(data.age_years).toBe(33);
  });

  it('returns 400 for invalid input', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_cost_cap_cents: -5 }),
    });
    expect(resp.status).toBe(400);
  });
});
