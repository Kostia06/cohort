import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleStatsRecent } from '../../../src/api/stats-recent';
import { resetDb } from '../../fakes/seed';

const NOW = Date.parse('2026-04-25T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                    VALUES ('u1','2026-04-24',60,'normal','ready','{}','[]',?)`).bind(NOW - DAY),
    env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                    VALUES ('u1','2026-04-25',72,'normal','ready','{}','[]',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','logged')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w2','u1','2026-04-25','cardio','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w3','u1','2026-04-25','mobility','skipped')`),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m1','u1',?,'oats',380,'user')`).bind(NOW - 6 * 60 * 60 * 1000),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m2','u1',?,'lunch',600,'user')`).bind(NOW - 2 * 60 * 60 * 1000),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m_old','u1',?,'old',900,'user')`).bind(NOW - 10 * DAY),
  ]);
});

describe('handleStatsRecent', () => {
  it('aggregates last N days per-day rolling window', async () => {
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 7, timezone: 'UTC' });
    expect(r.days.length).toBe(7);
    expect(r.days[0]!.date).toBe('2026-04-19');
    expect(r.days.at(-1)!.date).toBe('2026-04-25');

    const today = r.days.find((d) => d.date === '2026-04-25')!;
    expect(today.readiness?.score).toBe(72);
    expect(today.readiness?.band).toBe('normal');
    expect(today.workouts.logged).toBe(1);
    expect(today.workouts.planned).toBe(1);
    expect(today.workouts.skipped).toBe(1);
    expect(today.meals.count).toBe(2);
    expect(today.meals.total_kcal).toBe(980);

    const yesterday = r.days.find((d) => d.date === '2026-04-24')!;
    expect(yesterday.readiness?.score).toBe(60);
    expect(yesterday.workouts.logged).toBe(0);
    expect(yesterday.meals.count).toBe(0);
  });

  it('clamps days to [1, 90]', async () => {
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 0, timezone: 'UTC' });
    expect(r.days.length).toBe(1);
    const r2 = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 200, timezone: 'UTC' });
    expect(r2.days.length).toBe(90);
  });

  it('isolates across users', async () => {
    await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                          VALUES ('u2','Other','UTC',32,'[]','[]',150,1)`).run();
    await env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                          VALUES ('u2','2026-04-25',99,'green','ready','{}','[]',?)`).bind(NOW).run();
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 7, timezone: 'UTC' });
    const today = r.days.find((d) => d.date === '2026-04-25')!;
    expect(today.readiness?.score).toBe(72);
  });
});
