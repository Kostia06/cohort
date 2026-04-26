import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { logMealTool } from '../../../src/tools/log-meal';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('logMealTool', () => {
  it('inserts a meal row and returns the meal_id', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    expect(r.meal_id).toMatch(/^meal_t1_0$/);
    expect(r.eaten_at).toBe(NOW);
    const row = await env.DB.prepare(`SELECT name, kcal FROM meals WHERE meal_id = ?`).bind(r.meal_id).first();
    expect(row).toEqual({ name: 'oatmeal', kcal: 380 });
  });

  it('is idempotent on (turn_id, call_index) replay', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r1 = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    const r2 = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    expect(r2.meal_id).toBe(r1.meal_id);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meals`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
