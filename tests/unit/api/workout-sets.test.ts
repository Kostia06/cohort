import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleCreateSet, handleGetWorkout } from '../../../src/api/workout-sets';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u2','Other','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_other','u2','2026-04-25','strength','planned')`)
  ]);
});

describe('handleCreateSet', () => {
  it('inserts a set with auto-incrementing ordinal', async () => {
    const r1 = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    expect(r1.ok).toBe(true);
    expect(r1.set_id).toMatch(/^set_/);
    const r2 = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW + 60_000, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    expect(r2.ok).toBe(true);
    const rows = await env.DB.prepare(`SELECT ordinal FROM workout_sets WHERE workout_id = 'w1' ORDER BY ordinal`).all<{ ordinal: number }>();
    expect(rows.results?.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it('returns 404 for unknown workout', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'nope', now: NOW, input: { exercise: 'squat' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when workout belongs to another user', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w_other', now: NOW, input: { exercise: 'squat' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('rejects empty exercise with 400', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: '' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('handleGetWorkout', () => {
  it('returns the workout with empty sets array initially', async () => {
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w1' });
    expect(r.ok).toBe(true);
    expect(r.workout!.workout_id).toBe('w1');
    expect(r.sets).toEqual([]);
  });

  it('returns sets in ordinal order', async () => {
    await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW + 1, input: { exercise: 'squat', reps: 5, weight_kg: 105 } });
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w1' });
    expect(r.sets!.length).toBe(2);
    expect(r.sets![0]!.ordinal).toBe(0);
    expect(r.sets![1]!.weight_kg).toBe(105);
  });

  it('returns 403 when accessing another user\'s workout', async () => {
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});
