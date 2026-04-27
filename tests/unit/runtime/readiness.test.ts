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
    // With HRV (0.40) + sleep_duration (0.25) + sleep_efficiency (0.20) = 0.85 weight
    const r = computeReadiness({
      todayHrvSdnnMs: 50,
      todayRhrBpm: null,            // rhr missing — only 0.15 dropped
      lastNightSleepMinutes: 480,
      lastNightTimeInBedMinutes: 510,
      baselineHrv: { median: 50, mad: 5 },
      baselineRhr: null,
      ageYears: 32
    });
    expect(r.status).toBe('ready');
    expect(r.components.rhr).toBeNull();
    expect(r.score).not.toBeNull();
  });

  it('returns calibrating when total weight available is < 0.5', () => {
    // Only sleep_duration (0.25) contributes — no time-in-bed so no sleep_efficiency. Total 0.25 < 0.5.
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
