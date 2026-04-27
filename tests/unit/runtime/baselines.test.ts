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
