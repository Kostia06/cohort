import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handlePlansToday } from '../../../src/api/plans-today';
import { resetDb } from '../../fakes/seed';

const NOW = Date.parse('2026-04-25T15:00:00Z');

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('handlePlansToday', () => {
  it('returns empty payload when nothing exists', async () => {
    const r = await handlePlansToday({
      userId: 'u1',
      date: '2026-04-25',
      now: NOW,
      db: env.DB
    });
    expect(r.readiness).toBeNull();
    expect(r.planned_workouts).toEqual([]);
    expect(r.recent_meals).toEqual([]);
    expect(r.latest_assistant_message).toBeNull();
  });

  it('aggregates readiness, planned workouts, recent meals, latest assistant message', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-25',72,'normal','ready','{"hrv":75}','["good sleep"]',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, duration_min, rpe, status, source)
                      VALUES ('w1','u1','2026-04-25','strength',60,8,'planned','agent')`),
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                      VALUES ('m1','u1',?,'oatmeal',380,'manual')`).bind(NOW - 6 * 60 * 60 * 1000),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, text, started_at, ended_at)
                      VALUES ('t1','th1',0,'system','complete','Plan generated for tomorrow.',?,?)`).bind(NOW - 60 * 60 * 1000, NOW - 60 * 60 * 1000 + 5)
    ]);

    const r = await handlePlansToday({
      userId: 'u1',
      date: '2026-04-25',
      now: NOW,
      db: env.DB
    });

    expect(r.readiness).toEqual({ score: 72, band: 'normal', status: 'ready', components: { hrv: 75 }, reasons: ['good sleep'] });
    expect(r.planned_workouts).toEqual([{ workout_id: 'w1', kind: 'strength', duration_min: 60, rpe: 8, status: 'planned', notes: null }]);
    expect(r.recent_meals.length).toBe(1);
    expect(r.recent_meals[0]!.name).toBe('oatmeal');
    expect(r.latest_assistant_message?.text).toContain('Plan generated');
  });

  it('limits recent meals to last 24h', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source)
                      VALUES ('m_recent','u1',?,'recent','manual')`).bind(NOW - 6 * 60 * 60 * 1000),
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source)
                      VALUES ('m_old','u1',?,'old','manual')`).bind(NOW - 30 * 60 * 60 * 1000)
    ]);
    const r = await handlePlansToday({ userId: 'u1', date: '2026-04-25', now: NOW, db: env.DB });
    expect(r.recent_meals.map((m) => m.name)).toEqual(['recent']);
  });
});
