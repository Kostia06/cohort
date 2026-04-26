import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { computeAcwrTool } from '../../../src/tools/compute-acwr';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = new Date('2026-04-25').getTime();

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('computeAcwrTool', () => {
  it('returns null acwr with no workouts', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await computeAcwrTool.handler({}, ctx);
    expect(r.acute_load).toBe(0);
    expect(r.chronic_load).toBe(0);
    expect(r.acwr).toBeNull();
    expect(r.flag).toBeNull();
  });

  it('computes ratio in sweet spot (1.0)', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w1','u1','2026-04-22','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w2','u1','2026-04-15','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w3','u1','2026-04-08','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w4','u1','2026-04-01','strength',100,'logged')`)
    ]);
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await computeAcwrTool.handler({}, ctx);
    expect(r.acute_load).toBe(100);
    expect(r.chronic_load).toBe(100);
    expect(r.acwr).toBe(1);
    expect(r.flag).toBe('sweet_spot');
  });
});
