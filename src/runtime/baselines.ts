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

export function computeBaseline(
  samples: Array<Record<string, number | null | undefined>>,
  metric: string
): Baseline | null {
  const raw = samples.map((s) => s[metric]);
  const values: number[] = [];
  for (const v of raw) {
    if (typeof v === 'number') values.push(v);
  }
  if (values.length < MIN_SAMPLES_FOR_BASELINE) return null;
  const med = median(values);
  if (med === null) return null;
  const m = mad(values, med);
  if (m === null) return null;
  // Floor MAD at 1 to avoid divide-by-zero downstream.
  return { median: med, mad: Math.max(m, 1) };
}
