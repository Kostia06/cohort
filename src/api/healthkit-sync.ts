import { computeBaseline } from '../runtime/baselines';
import { computeReadiness } from '../runtime/readiness';

export interface HealthKitSample {
  date: string;                    // YYYY-MM-DD local
  hrv_sdnn_ms?: number;
  rhr_bpm?: number;
  sleep_minutes?: number;
  time_in_bed_minutes?: number;
  active_kcal?: number;
  steps?: number;
}

export interface HealthKitSyncDeps {
  db: D1Database;
  clock: () => number;
}

export interface HealthKitSyncResult {
  readiness: {
    status: 'calibrating' | 'ready';
    score: number | null;
    band: string | null;
    components: Record<string, number | null>;
    reasons: string[];
  };
}

export async function handleHealthKitSync(
  userId: string,
  sample: HealthKitSample,
  deps: HealthKitSyncDeps
): Promise<HealthKitSyncResult> {
  const now = deps.clock();

  await deps.db.prepare(
    `INSERT INTO health_samples_daily
       (user_id, date, hrv_sdnn_ms, rhr_bpm, sleep_minutes, time_in_bed_minutes, active_kcal, steps, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'healthkit', ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       hrv_sdnn_ms = excluded.hrv_sdnn_ms,
       rhr_bpm = excluded.rhr_bpm,
       sleep_minutes = excluded.sleep_minutes,
       time_in_bed_minutes = excluded.time_in_bed_minutes,
       active_kcal = excluded.active_kcal,
       steps = excluded.steps,
       ingested_at = excluded.ingested_at`
  ).bind(
    userId,
    sample.date,
    sample.hrv_sdnn_ms ?? null,
    sample.rhr_bpm ?? null,
    sample.sleep_minutes ?? null,
    sample.time_in_bed_minutes ?? null,
    sample.active_kcal ?? null,
    sample.steps ?? null,
    now
  ).run();

  // Baselines from the last 14 days *excluding* today.
  const history = await deps.db.prepare(
    `SELECT hrv_sdnn_ms, rhr_bpm
     FROM health_samples_daily
     WHERE user_id = ? AND date < ?
     ORDER BY date DESC
     LIMIT 14`
  ).bind(userId, sample.date).all<{ hrv_sdnn_ms: number | null; rhr_bpm: number | null }>();

  const baselineHrv = computeBaseline(history.results ?? [], 'hrv_sdnn_ms');
  const baselineRhr = computeBaseline(history.results ?? [], 'rhr_bpm');

  const userRow = await deps.db.prepare(`SELECT age_years FROM users WHERE user_id = ?`)
    .bind(userId).first<{ age_years: number | null }>();
  const ageYears = userRow?.age_years ?? 30;

  const readiness = computeReadiness({
    todayHrvSdnnMs: sample.hrv_sdnn_ms ?? null,
    todayRhrBpm: sample.rhr_bpm ?? null,
    lastNightSleepMinutes: sample.sleep_minutes ?? null,
    lastNightTimeInBedMinutes: sample.time_in_bed_minutes ?? null,
    baselineHrv,
    baselineRhr,
    ageYears
  });

  await deps.db.prepare(
    `INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       score = excluded.score,
       band = excluded.band,
       status = excluded.status,
       components_json = excluded.components_json,
       reasons_json = excluded.reasons_json,
       computed_at = excluded.computed_at`
  ).bind(
    userId,
    sample.date,
    readiness.score,
    readiness.band,
    readiness.status,
    JSON.stringify(readiness.components),
    JSON.stringify(readiness.reasons),
    now
  ).run();

  return {
    readiness: {
      status: readiness.status,
      score: readiness.score,
      band: readiness.band,
      components: readiness.components,
      reasons: readiness.reasons
    }
  };
}
