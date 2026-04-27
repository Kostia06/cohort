import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleMeGet, handleMeUpdate } from '../../../src/api/me';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'omnivore','["peanut"]','["fish"]',150,1)`
  ).run();
});

describe('handleMeGet', () => {
  it('returns the current user profile', async () => {
    const r = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.profile).toEqual({
      user_id: 'u1',
      display_name: 'Alex',
      timezone: 'UTC',
      age_years: 32,
      dietary_pattern: 'omnivore',
      allergies: ['peanut'],
      dislikes: ['fish'],
      daily_cost_cap_cents: 150,
    });
  });

  it('returns 404 for missing user', async () => {
    const r = await handleMeGet({ db: env.DB, userId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe('handleMeUpdate', () => {
  it('updates editable fields', async () => {
    const r = await handleMeUpdate({
      db: env.DB,
      userId: 'u1',
      input: {
        display_name: 'A.',
        timezone: 'America/Edmonton',
        age_years: 33,
        dietary_pattern: 'pescatarian',
        allergies: ['peanut', 'shellfish'],
        dislikes: [],
        daily_cost_cap_cents: 200,
      },
    });
    expect(r.ok).toBe(true);
    const get = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(get.profile?.display_name).toBe('A.');
    expect(get.profile?.timezone).toBe('America/Edmonton');
    expect(get.profile?.age_years).toBe(33);
    expect(get.profile?.dietary_pattern).toBe('pescatarian');
    expect(get.profile?.allergies).toEqual(['peanut', 'shellfish']);
    expect(get.profile?.dislikes).toEqual([]);
    expect(get.profile?.daily_cost_cap_cents).toBe(200);
  });

  it('partial update only changes provided fields', async () => {
    await handleMeUpdate({ db: env.DB, userId: 'u1', input: { display_name: 'Only Name' } });
    const r = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(r.profile?.display_name).toBe('Only Name');
    expect(r.profile?.timezone).toBe('UTC');
    expect(r.profile?.age_years).toBe(32);
  });

  it('rejects empty display_name with 400', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { display_name: '   ' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects daily_cost_cap_cents below 0', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { daily_cost_cap_cents: -1 } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects daily_cost_cap_cents above 100000', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { daily_cost_cap_cents: 100001 } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects invalid dietary_pattern', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { dietary_pattern: 'junk' as any } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects invalid timezone', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { timezone: 'Not/A/Zone' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
