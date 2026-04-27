# HealthKit Sync + Readiness Scoring — Plan 8

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `get_readiness` actually return data. Implements the readiness scoring algorithm from the deep-dive doc (Part 3) and adds a `POST /v1/healthkit/sync` endpoint that the Flutter side will eventually call. Server stores raw daily samples, computes 14-day rolling baselines, and writes a daily readiness row.

**Architecture:** No new Worker — adds to the existing api Worker. New routes + new pure modules:
- `src/runtime/readiness.ts` — pure `computeReadiness(inputs)` function with the algorithm verbatim from the deep-dive.
- `src/runtime/baselines.ts` — pure `computeBaselines(samples)` returning `{median, mad}` per metric.
- `src/api/worker.ts` — adds `POST /v1/healthkit/sync` (auth-protected, JWT).

**Tech Stack:** Same as Plans 1-7. No new deps.

**Spec:** Per the deep-dive doc § "Part 3 — Readiness score."

**Out of scope (deferred):**
- Flutter HealthKit reader implementation. This plan exposes the server endpoint; the iOS app integration is its own project.
- ACWR (Acute:Chronic Workload Ratio) tool — already implemented in Plan 3 as `compute_acwr`. The deep-dive's "ACWR is separate" stance holds.
- Streak / trend computation across days.
- Multi-device deduplication (assume one source of truth per day).

---

## File Structure

```
src/db/migrations/
  0005_healthkit.sql                     # NEW: health_samples_daily

src/runtime/
  readiness.ts                           # NEW: computeReadiness (pure)
  baselines.ts                           # NEW: computeBaselines (median + MAD)

src/api/
  worker.ts                              # MODIFY: POST /v1/healthkit/sync route
  healthkit-sync.ts                      # NEW: sync handler logic separated for testability

tests/
  fakes/seed.ts                          # MODIFY: add health_samples_daily
  unit/runtime/
    readiness.test.ts                    # NEW
    baselines.test.ts                    # NEW
  unit/api/
    healthkit-sync.test.ts               # NEW
  integration/
    healthkit.test.ts                    # NEW: end-to-end sync via SELF.fetch
```

---

## Phase 1: Schema

### Task 1: Migration 0005 — health_samples_daily

**Files:**
- Create: `src/db/migrations/0005_healthkit.sql`
- Modify: `tests/fakes/seed.ts`

One table holds the raw daily samples. Existing `readiness_daily` (from Plan 3) holds the computed score.

- [ ] **Step 1: Create `src/db/migrations/0005_healthkit.sql`**

```sql
-- src/db/migrations/0005_healthkit.sql

CREATE TABLE health_samples_daily (
  user_id              TEXT NOT NULL,
  date                 TEXT NOT NULL,            -- YYYY-MM-DD local
  hrv_sdnn_ms          REAL,                     -- overnight HRV
  rhr_bpm              REAL,                     -- overnight RHR
  sleep_minutes        INTEGER,                  -- total time asleep last night
  time_in_bed_minutes  INTEGER,                  -- total time in bed
  active_kcal          INTEGER,                  -- active energy burned
  steps                INTEGER,
  source               TEXT NOT NULL DEFAULT 'healthkit',
  ingested_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_health_samples_user_date ON health_samples_daily(user_id, date DESC);
```

- [ ] **Step 2: Apply locally**

```
wrangler d1 execute cohort --local --file=src/db/migrations/0005_healthkit.sql
```

- [ ] **Step 3: Update `tests/fakes/seed.ts`**

Append to SCHEMA (with IF NOT EXISTS) and prepend the DELETE in `resetDb`:

```sql
CREATE TABLE IF NOT EXISTS health_samples_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hrv_sdnn_ms REAL,
  rhr_bpm REAL,
  sleep_minutes INTEGER,
  time_in_bed_minutes INTEGER,
  active_kcal INTEGER,
  steps INTEGER,
  source TEXT NOT NULL DEFAULT 'healthkit',
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_health_samples_user_date ON health_samples_daily(user_id, date DESC);
```

- [ ] **Step 4: Run tests + typecheck**

Expected: 101 PASS (no new tests yet).

- [ ] **Step 5: Commit**

```
git add src/db/migrations/0005_healthkit.sql tests/fakes/seed.ts
git commit -m "Add migration 0005: health_samples_daily"
```

---

## Phase 2: Pure modules

### Task 2: Baseline computation

**Files:**
- Create: `src/runtime/baselines.ts`
- Create: `tests/unit/runtime/baselines.test.ts`

`median(values)` and `mad(values, median)` are pure. `computeBaselines(samples, metric)` returns `{median, mad}` for a given metric across the samples list.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/runtime/baselines.test.ts
import { describe, expect, it } from 'vitest';
import { computeBaseline, mad, median } from '../../../src/runtime/baselines';

describe('median', () => {
  it('returns null for empty input', () => {
    expect(median([])).toBeNull();
  });
  it('odd count → middle value', () => {
    expect(median([10, 20, 30])).toBe(20);
  });
  it('even count → average of middle two', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
  it('handles unsorted input', () => {
    expect(median([30, 10, 20])).toBe(20);
  });
});

describe('mad (median absolute deviation)', () => {
  it('returns null for empty input', () => {
    expect(mad([], 0)).toBeNull();
  });
  it('returns 0 for all-same values', () => {
    expect(mad([5, 5, 5], 5)).toBe(0);
  });
  it('returns the median of |x - center|', () => {
    expect(mad([1, 2, 3, 4, 5], 3)).toBe(1);
  });
});

describe('computeBaseline', () => {
  it('returns null when fewer than 7 samples are present', () => {
    const samples = [{ hrv_sdnn_ms: 50 }, { hrv_sdnn_ms: 55 }];
    expect(computeBaseline(samples, 'hrv_sdnn_ms')).toBeNull();
  });

  it('returns {median, mad} for >= 7 valid samples', () => {
    const samples = Array.from({ length: 14 }, (_, i) => ({ hrv_sdnn_ms: 40 + i }));
    const r = computeBaseline(samples, 'hrv_sdnn_ms');
    expect(r).not.toBeNull();
    expect(r!.median).toBe(46.5);
    expect(r!.mad).toBe(3.5);
  });

  it('skips null/undefined values when counting', () => {
    const samples = [
      { hrv_sdnn_ms: 50 },
      { hrv_sdnn_ms: null },
      { hrv_sdnn_ms: 60 }
    ];
    expect(computeBaseline(samples as any, 'hrv_sdnn_ms')).toBeNull();
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/runtime/baselines.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/runtime/baselines.ts`**

```ts
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mad(values: number[], center: number): number | null {
  if (values.length === 0) return null;
  return median(values.map((v) => Math.abs(v - center)));
}

const MIN_SAMPLES_FOR_BASELINE = 7;

export interface Baseline {
  median: number;
  mad: number;
}

export function computeBaseline<T extends Record<string, number | null | undefined>>(
  samples: T[],
  metric: keyof T
): Baseline | null {
  const values = samples
    .map((s) => s[metric])
    .filter((v): v is number => typeof v === 'number');
  if (values.length < MIN_SAMPLES_FOR_BASELINE) return null;
  const med = median(values);
  if (med === null) return null;
  const m = mad(values, med);
  if (m === null) return null;
  // Floor MAD at 1 to avoid divide-by-zero downstream.
  return { median: med, mad: Math.max(m, 1) };
}
```

- [ ] **Step 4: Run + commit**

`pnpm test tests/unit/runtime/baselines.test.ts -- --run` → PASS (10 tests).

```
git add src/runtime/baselines.ts tests/unit/runtime/baselines.test.ts
git commit -m "Add baseline (median + MAD) computation for readiness"
```

---

### Task 3: Readiness scoring

**Files:**
- Create: `src/runtime/readiness.ts`
- Create: `tests/unit/runtime/readiness.test.ts`

`computeReadiness(inputs)` per the deep-dive doc Part 3 § "TypeScript implementation." Pure function.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/runtime/readiness.test.ts
import { describe, expect, it } from 'vitest';
import { computeReadiness } from '../../../src/runtime/readiness';

describe('computeReadiness', () => {
  it('returns calibrating when no sleep data', () => {
    const r = computeReadiness({
      todayHrvSdnnMs: null,
      todayRhrBpm: null,
      lastNightSleepMinutes: null,
      lastNightTimeInBedMinutes: null,
      baselineHrv: null,
      baselineRhr: null,
      ageYears: 32
    });
    expect(r.status).toBe('calibrating');
    expect(r.score).toBeNull();
  });

  it('scores around 60 when all signals match baseline (z=0)', () => {
    const r = computeReadiness({
      todayHrvSdnnMs: 50,
      todayRhrBpm: 60,
      lastNightSleepMinutes: 480,
      lastNightTimeInBedMinutes: 510,
      baselineHrv: { median: 50, mad: 5 },
      baselineRhr: { median: 60, mad: 4 },
      ageYears: 32
    });
    expect(r.status).toBe('ready');
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.score).toBeLessThanOrEqual(85);
    expect(r.band).toMatch(/^(normal|green)$/);
  });

  it('drops to rest band when HRV is well below baseline', () => {
    const r = computeReadiness({
      todayHrvSdnnMs: 30,            // baseline 50, mad 5 → z = -4
      todayRhrBpm: 65,
      lastNightSleepMinutes: 360,    // 6h, well under 8h target
      lastNightTimeInBedMinutes: 480,
      baselineHrv: { median: 50, mad: 5 },
      baselineRhr: { median: 60, mad: 4 },
      ageYears: 32
    });
    expect(r.status).toBe('ready');
    expect(r.score).toBeLessThan(40);
    expect(r.band).toBe('rest');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('uses age 540 min target for under-18', () => {
    const r = computeReadiness({
      todayHrvSdnnMs: 50,
      todayRhrBpm: 60,
      lastNightSleepMinutes: 540,    // exactly the teen target
      lastNightTimeInBedMinutes: 570,
      baselineHrv: { median: 50, mad: 5 },
      baselineRhr: { median: 60, mad: 4 },
      ageYears: 16
    });
    // sleep_duration_component should be 100 since actual >= target
    expect(r.components.sleep_duration).toBe(100);
  });

  it('reweights when components are missing', () => {
    const r = computeReadiness({
      todayHrvSdnnMs: null,         // hrv missing
      todayRhrBpm: null,            // rhr missing
      lastNightSleepMinutes: 480,
      lastNightTimeInBedMinutes: 510,
      baselineHrv: null,
      baselineRhr: null,
      ageYears: 32
    });
    expect(r.status).toBe('ready');
    expect(r.components.hrv).toBeNull();
    expect(r.components.rhr).toBeNull();
    expect(r.score).not.toBeNull();
  });

  it('returns calibrating when total weight available is < 0.5', () => {
    // Only sleep_efficiency would contribute (weight 0.20), but no time-in-bed → only sleep_duration (0.25). Total 0.25 < 0.5.
    const r = computeReadiness({
      todayHrvSdnnMs: null,
      todayRhrBpm: null,
      lastNightSleepMinutes: 480,
      lastNightTimeInBedMinutes: null,
      baselineHrv: null,
      baselineRhr: null,
      ageYears: 32
    });
    expect(r.status).toBe('calibrating');
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/runtime/readiness.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/runtime/readiness.ts`**

```ts
import type { Baseline } from './baselines';

export interface ReadinessInputs {
  todayHrvSdnnMs: number | null;
  todayRhrBpm: number | null;
  lastNightSleepMinutes: number | null;
  lastNightTimeInBedMinutes: number | null;
  baselineHrv: Baseline | null;
  baselineRhr: Baseline | null;
  ageYears: number;
}

export interface ReadinessOutput {
  status: 'calibrating' | 'ready';
  score: number | null;
  components: {
    hrv: number | null;
    rhr: number | null;
    sleep_duration: number | null;
    sleep_efficiency: number | null;
  };
  band: 'rest' | 'easy' | 'normal' | 'green' | null;
  reasons: string[];
}

const WEIGHTS = { hrv: 0.40, sleep_duration: 0.25, sleep_efficiency: 0.20, rhr: 0.15 };

export function computeReadiness(inputs: ReadinessInputs): ReadinessOutput {
  const reasons: string[] = [];
  const components = {
    hrv: null as number | null,
    rhr: null as number | null,
    sleep_duration: null as number | null,
    sleep_efficiency: null as number | null
  };

  if (inputs.lastNightSleepMinutes == null) {
    reasons.push('No sleep data for last night');
    return { status: 'calibrating', score: null, components, band: null, reasons };
  }

  // HRV
  if (inputs.todayHrvSdnnMs != null && inputs.baselineHrv) {
    const z = (inputs.todayHrvSdnnMs - inputs.baselineHrv.median) / Math.max(inputs.baselineHrv.mad, 1);
    components.hrv = clip(60 + 30 * z, 0, 100);
    if (z < -1) reasons.push(`HRV ${Math.abs(z).toFixed(1)} SD below baseline`);
    else if (z > 1) reasons.push('HRV elevated vs baseline');
  }

  // RHR (inverted — higher is worse)
  if (inputs.todayRhrBpm != null && inputs.baselineRhr) {
    const z = (inputs.todayRhrBpm - inputs.baselineRhr.median) / Math.max(inputs.baselineRhr.mad, 1);
    components.rhr = clip(60 - 30 * z, 0, 100);
    if (z > 1) reasons.push(`Resting HR ${z.toFixed(1)} SD above baseline`);
  }

  // Sleep duration (age-targeted)
  const target = inputs.ageYears < 18 ? 540 : 480;
  const actual = inputs.lastNightSleepMinutes;
  let dur: number;
  if (actual >= target) dur = 100;
  else if (actual >= 0.85 * target) dur = 70 + 30 * (actual - 0.85 * target) / (0.15 * target);
  else if (actual >= 0.70 * target) dur = 40 + 30 * (actual - 0.70 * target) / (0.15 * target);
  else dur = Math.max(0, 40 * (actual / (0.70 * target)));
  components.sleep_duration = dur;
  if (actual < 0.85 * target) reasons.push(`Slept ${Math.round(actual)} min, target ${target}`);

  // Sleep efficiency
  if (inputs.lastNightTimeInBedMinutes && inputs.lastNightTimeInBedMinutes > 0) {
    const eff = actual / inputs.lastNightTimeInBedMinutes;
    components.sleep_efficiency = clip(
      eff >= 0.90 ? 100
      : eff >= 0.85 ? 60 + 40 * (eff - 0.85) / 0.05
      : eff >= 0.70 ? 30 + 30 * (eff - 0.70) / 0.15
      : eff * 30 / 0.70,
      0, 100
    );
    if (eff < 0.85) reasons.push(`Sleep efficiency ${(eff * 100).toFixed(0)}%`);
  }

  // Aggregate (reweight if components are missing)
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as Array<[keyof typeof WEIGHTS, number]>) {
    const v = components[k];
    if (v != null) { weightedSum += v * w; totalWeight += w; }
  }

  if (totalWeight < 0.5) {
    reasons.push('Not enough data for reliable score');
    return { status: 'calibrating', score: null, components, band: null, reasons };
  }

  const score = Math.round(weightedSum / totalWeight);
  let band: ReadinessOutput['band'];
  if (score < 40) band = 'rest';
  else if (score < 55) band = 'easy';
  else if (score < 75) band = 'normal';
  else band = 'green';

  return { status: 'ready', score, components, band, reasons };
}

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
```

- [ ] **Step 4: Pass + commit**

`pnpm test tests/unit/runtime/readiness.test.ts -- --run` → PASS (6 tests).

```
git add src/runtime/readiness.ts tests/unit/runtime/readiness.test.ts
git commit -m "Add readiness scoring (HRV, RHR, sleep duration, efficiency)"
```

---

## Phase 3: Sync handler

### Task 4: HealthKit sync handler + endpoint

**Files:**
- Create: `src/api/healthkit-sync.ts` — pure handler logic (extracted for testability).
- Modify: `src/api/worker.ts` — wire `POST /v1/healthkit/sync` route.
- Create: `tests/unit/api/healthkit-sync.test.ts`
- Create: `tests/integration/healthkit.test.ts`

The sync handler:
1. Validates the JWT (handled by Worker's `authenticateRequest`).
2. Reads body: `{date, hrv_sdnn_ms?, rhr_bpm?, sleep_minutes?, time_in_bed_minutes?, active_kcal?, steps?}`.
3. UPSERTs `health_samples_daily` for `(userId, date)`.
4. Reads last 14 days of samples for baselines.
5. Reads `users.age_years`.
6. Computes readiness.
7. UPSERTs `readiness_daily`.
8. Returns the readiness output.

- [ ] **Step 1: Write `src/api/healthkit-sync.ts`**

```ts
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
```

- [ ] **Step 2: Write `tests/unit/api/healthkit-sync.test.ts`**

```ts
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
```

- [ ] **Step 3: Run + fail**

`pnpm test tests/unit/api/healthkit-sync.test.ts -- --run` → FAIL.

- [ ] **Step 4: Pass (the file already exists from Step 1)**

`pnpm test tests/unit/api/healthkit-sync.test.ts -- --run` → PASS (3 tests).

- [ ] **Step 5: Wire `/v1/healthkit/sync` into `src/api/worker.ts`**

Read the current file. Find `authenticateRequest`. Add the new route alongside `/v1/chat/`, `/v1/cancel/`, `/v1/run-batch/`:

```ts
import { handleHealthKitSync } from './healthkit-sync';

// ... inside the default fetch handler, before the 404 fallback:
if (req.method === 'POST' && url.pathname === '/v1/healthkit/sync') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const sample = await req.json<{ date: string; hrv_sdnn_ms?: number; rhr_bpm?: number; sleep_minutes?: number; time_in_bed_minutes?: number; active_kcal?: number; steps?: number }>();
  if (!sample?.date) return new Response('missing date', { status: 400 });
  const deps = { db: env.DB, clock: () => Date.now() };
  const result = await handleHealthKitSync(userId, sample, deps);
  return Response.json(result);
}
```

- [ ] **Step 6: Add `tests/integration/healthkit.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`
  ).run();
});

describe('POST /v1/healthkit/sync', () => {
  it('persists a sample and returns calibrating on first sync', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/healthkit/sync', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-04-25', hrv_sdnn_ms: 50, rhr_bpm: 60, sleep_minutes: 480, time_in_bed_minutes: 510 })
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { readiness: { status: string } };
    expect(data.readiness.status).toBe('calibrating');
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/healthkit/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-04-25', sleep_minutes: 480 })
    });
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 7: Run all tests**

```
pnpm test -- --run
pnpm typecheck
```
Expected: ~117 PASS (101 + 10 baselines + 6 readiness + 3 sync handler + 2 sync integration). Typecheck clean.

(Take whatever the actual count is.)

- [ ] **Step 8: Commit**

```
git add src/api/healthkit-sync.ts src/api/worker.ts tests/unit/api/healthkit-sync.test.ts tests/integration/healthkit.test.ts
git commit -m "Add /v1/healthkit/sync endpoint that computes readiness"
```

---

## Phase 4: Final readiness

### Task 5: Final + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```

- [ ] **Step 2: Append to `docs/superpowers/runbooks/2026-04-25-vertical-slice-smoke-test.md`**

```markdown

---

## After Plan 8: HealthKit sync + readiness scoring

27. **Sync a daily sample (calibrating phase):**
    ```
    curl -X POST https://<your-api>.workers.dev/v1/healthkit/sync \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"date":"2026-04-25","hrv_sdnn_ms":50,"rhr_bpm":60,"sleep_minutes":480,"time_in_bed_minutes":510}'
    ```
    Expected: 200 with `{readiness: {status: 'calibrating', score: null, ...}}` for the first 14 days.

28. **Sync 14+ days then check readiness:**
    Backfill 14 days of samples (script or repeated curls), then sync today.
    Expected: 200 with `{readiness: {status: 'ready', score: <0..100>, band: 'rest'|'easy'|'normal'|'green', components: {...}, reasons: [...]}}`.

29. **Verify `get_readiness` tool now returns data:**
    ```
    curl -N -X POST https://<your-api>.workers.dev/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"what is my readiness today?"}'
    ```
    The orchestrator calls `get_readiness`; it now returns the latest `readiness_daily` row and the model can talk about the band + reasons.

30. **Integration with batch turn:**
    The 5am cron-fired batch turn calls `get_readiness` as part of generating tomorrow's plan. With real readiness data, the agent can dial volume up/down based on band.

## Plan 8 known limitations (deferred)

- **No Flutter HealthKit reader** — server endpoint is ready; iOS-side code is its own project.
- **No multi-device dedup** — assume one source of truth per (user_id, date). Multiple uploads on the same date overwrite.
- **No backfill endpoint** — bulk historical sync is a single-row API that the client must loop over. A `/sync/batch` taking an array could come later.
- **Age-based target only** — sleep target is 540 min for under-18, 480 otherwise. No personalization or sleep-need detection.

## Final P1 → P8 capability matrix

| Capability | P1-P5 | P6 | P7 | P8 |
|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ |
| 9 tools | ✓ | ✓ | ✓ | ✓ |
| Full hardening (retry, cancel, replay, cap, batch, janitor, JWT) | ✓ | ✓ | ✓ | ✓ |
| `search_research` | stub→**real** | real | real | real |
| `search_groceries` | stub | stub | **real** | real |
| `get_readiness` | always null | always null | always null | **real (after 14d calibration)** |
| HealthKit sync endpoint | ✗ | ✗ | ✗ | ✓ |
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 8 HealthKit sync + readiness smoke checks"
```

---

## Self-review notes

- **Spec coverage:** algorithm verbatim from deep-dive Part 3 ✓; 14-day rolling baseline ✓; calibration phase ✓; age-based sleep target ✓; component reweighting ✓; band derivation ✓.
- **Placeholder scan:** none.
- **Type consistency:** `Baseline`, `ReadinessInputs`, `ReadinessOutput`, `HealthKitSample`, `HealthKitSyncResult` all defined.
- **Scope:** 5 tasks. ~21 new tests. Test count 101 → ~122.
