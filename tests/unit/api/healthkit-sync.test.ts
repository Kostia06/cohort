import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleHealthKitSync } from '../../../src/api/healthkit-sync';
import { resetDb } from '../../fakes/seed';

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`
  ).run();
});

describe('handleHealthKitSync', () => {
  it('returns calibrating on the first day with no history', async () => {
    const r = await handleHealthKitSync(
      'u1',
      { date: '2026-04-25', hrv_sdnn_ms: 50, rhr_bpm: 60, sleep_minutes: 480, time_in_bed_minutes: 510 },
      { db: env.DB, clock: () => NOW }
    );
    expect(r.readiness.status).toBe('calibrating');
    expect(r.readiness.score).toBeNull();

    const sampleRow = await env.DB.prepare(`SELECT hrv_sdnn_ms, rhr_bpm FROM health_samples_daily WHERE user_id='u1' AND date='2026-04-25'`).first();
    expect(sampleRow).toEqual({ hrv_sdnn_ms: 50, rhr_bpm: 60 });
    const readinessRow = await env.DB.prepare(`SELECT status FROM readiness_daily WHERE user_id='u1' AND date='2026-04-25'`).first();
    expect(readinessRow).toEqual({ status: 'calibrating' });
  });

  it('produces a real score after sufficient history', async () => {
    // Seed 14 days of stable baseline.
    const stmts = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(2026, 3, 11 + i);   // Apr 11..24
      const ds = d.toISOString().slice(0, 10);
      stmts.push(env.DB.prepare(
        `INSERT INTO health_samples_daily (user_id, date, hrv_sdnn_ms, rhr_bpm, sleep_minutes, time_in_bed_minutes, source, ingested_at)
         VALUES ('u1', ?, ?, ?, ?, ?, 'healthkit', ?)`
      ).bind(ds, 50 + (i % 3 - 1), 60 + (i % 3 - 1), 480, 510, NOW));
    }
    await env.DB.batch(stmts);

    const r = await handleHealthKitSync(
      'u1',
      { date: '2026-04-25', hrv_sdnn_ms: 50, rhr_bpm: 60, sleep_minutes: 480, time_in_bed_minutes: 510 },
      { db: env.DB, clock: () => NOW }
    );
    expect(r.readiness.status).toBe('ready');
    expect(r.readiness.score).not.toBeNull();
    expect(r.readiness.band).toMatch(/^(rest|easy|normal|green)$/);
  });

  it('upserts on repeated sync of the same date', async () => {
    await handleHealthKitSync('u1', { date: '2026-04-25', hrv_sdnn_ms: 50, sleep_minutes: 400, time_in_bed_minutes: 480 }, { db: env.DB, clock: () => NOW });
    await handleHealthKitSync('u1', { date: '2026-04-25', hrv_sdnn_ms: 60, sleep_minutes: 500, time_in_bed_minutes: 540 }, { db: env.DB, clock: () => NOW + 1000 });

    const sampleRow = await env.DB.prepare(`SELECT hrv_sdnn_ms, sleep_minutes FROM health_samples_daily WHERE user_id='u1' AND date='2026-04-25'`).first();
    expect(sampleRow).toEqual({ hrv_sdnn_ms: 60, sleep_minutes: 500 });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM health_samples_daily WHERE user_id='u1'`).first<{n:number}>();
    expect(count?.n).toBe(1);
  });
});
