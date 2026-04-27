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

describe('POST /v1/healthkit/sync', () => {
  it('persists a sample and returns calibrating on first sync', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/healthkit/sync', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-04-25', hrv_sdnn_ms: 50, rhr_bpm: 60, sleep_minutes: 480, time_in_bed_minutes: 510 })
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { readiness: { status: string } };
    expect(data.readiness.status).toBe('calibrating');
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/healthkit/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-04-25', sleep_minutes: 480 })
    });
    expect(resp.status).toBe(401);
  });
});
