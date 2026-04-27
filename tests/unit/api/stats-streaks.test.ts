import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleStatsStreaks } from '../../../src/api/stats-streaks';
import { resetDb } from '../../fakes/seed';

const NOW = Date.parse('2026-04-25T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`).run();
});

describe('handleStatsStreaks', () => {
  it('returns zeros when no data exists', async () => {
    const r = await handleStatsStreaks({ db: env.DB, userId: 'u1', now: NOW, timezone: 'UTC' });
    expect(r.workouts).toBe(0);
    expect(r.meals).toBe(0);
    expect(r.sync).toBe(0);
  });

  it('counts consecutive workout days', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_today','u1','2026-04-25','strength','logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_yest','u1','2026-04-24','strength','logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_dby','u1','2026-04-23','strength','logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_old','u1','2026-04-21','strength','logged')`),
    ]);
    const r = await handleStatsStreaks({ db: env.DB, userId: 'u1', now: NOW, timezone: 'UTC' });
    expect(r.workouts).toBe(3);
  });

  it('counts consecutive meal days (any meals on that date)', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m_today','u1',?,'oats','user')`).bind(NOW - 2 * 60 * 60 * 1000),
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m_yest','u1',?,'lunch','user')`).bind(NOW - DAY),
    ]);
    const r = await handleStatsStreaks({ db: env.DB, userId: 'u1', now: NOW, timezone: 'UTC' });
    expect(r.meals).toBe(2);
  });

  it('counts consecutive sync days where readiness status is ready', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-25',72,'normal','ready','{}','[]',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-24',null,null,'calibrating','{}','[]',?)`).bind(NOW - DAY),
    ]);
    const r = await handleStatsStreaks({ db: env.DB, userId: 'u1', now: NOW, timezone: 'UTC' });
    expect(r.sync).toBe(1);
  });

  it('returns 0 when streak does not include today', async () => {
    await env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_yest','u1','2026-04-24','strength','logged')`).run();
    const r = await handleStatsStreaks({ db: env.DB, userId: 'u1', now: NOW, timezone: 'UTC' });
    expect(r.workouts).toBe(0);
  });
});
