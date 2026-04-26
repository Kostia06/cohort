import { describe, expect, it } from 'vitest';
import { preflightSafety } from '../../../src/runtime/safety';

describe('preflightSafety', () => {
  it('allows benign messages', () => {
    expect(preflightSafety('what should I eat for breakfast?').allow).toBe(true);
  });

  it('blocks medication dosing questions', () => {
    const r = preflightSafety('Should I take 200mg of caffeine?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('medication_dosage');
    expect(r.cannedResponse).toContain('pharmacist');
  });

  it('blocks self-diagnosis questions', () => {
    const r = preflightSafety('Do I have iron deficiency?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('self_diagnosis');
  });

  it('blocks low-calorie target questions below the floor', () => {
    const r = preflightSafety('Should I cut to 1100 kcal?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('low_calorie_floor');
  });

  it('allows above-floor calorie targets', () => {
    expect(preflightSafety('Should I target 1800 kcal?').allow).toBe(true);
  });
});
