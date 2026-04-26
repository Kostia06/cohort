import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { proposeWorkoutTool } from '../../../src/tools/propose-workout';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('proposeWorkoutTool', () => {
  it('inserts a planned workout', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength', rpe: 8 }, ctx);
    expect(r.workout_id).toBe('workout_t1_0');
    const row = await env.DB.prepare(`SELECT kind, status, rpe FROM workouts WHERE workout_id = ?`).bind(r.workout_id).first();
    expect(row).toEqual({ kind: 'strength', status: 'planned', rpe: 8 });
  });

  it('is idempotent on replay', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength' }, ctx);
    await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength' }, ctx);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workouts`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
