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
