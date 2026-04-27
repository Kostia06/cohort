import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleWorkoutUpdate } from '../../../src/api/workouts-update';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u2','Bob','UTC',28,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_other','u2','2026-04-25','strength','planned')`),
  ]);
});

describe('handleWorkoutUpdate', () => {
  it('updates status when the workout belongs to the user', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w1', status: 'logged' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w1'`).first();
    expect(row).toEqual({ status: 'logged' });
  });

  it('returns 404 when the workout does not exist', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'nope', status: 'logged' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when the workout belongs to a different user', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w_other', status: 'logged' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w_other'`).first();
    expect(row).toEqual({ status: 'planned' });
  });

  it('rejects invalid status values', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w1', status: 'invalid' as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
