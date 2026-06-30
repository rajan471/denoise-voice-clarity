import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../engine';

describe('resolveOptions', () => {
  it('applies defaults when nothing is provided', () => {
    expect(resolveOptions()).toEqual({
      enabled: true,
      attenuationLimitDb: 30,
      presenceGainDb: 4,
    });
  });

  it('passes through valid values', () => {
    expect(resolveOptions({ enabled: false, attenuationLimitDb: 50, presenceGainDb: 6 })).toEqual({
      enabled: false,
      attenuationLimitDb: 50,
      presenceGainDb: 6,
    });
  });

  it('clamps attenuation to [0, 100]', () => {
    expect(resolveOptions({ attenuationLimitDb: 999 }).attenuationLimitDb).toBe(100);
    expect(resolveOptions({ attenuationLimitDb: -5 }).attenuationLimitDb).toBe(0);
  });

  it('clamps presence gain to [-12, 12]', () => {
    expect(resolveOptions({ presenceGainDb: 100 }).presenceGainDb).toBe(12);
    expect(resolveOptions({ presenceGainDb: -100 }).presenceGainDb).toBe(-12);
  });

  it('falls back to the lower bound on NaN', () => {
    expect(resolveOptions({ attenuationLimitDb: Number.NaN }).attenuationLimitDb).toBe(0);
  });

  it('preserves enabled:false (not coerced by ??)', () => {
    expect(resolveOptions({ enabled: false }).enabled).toBe(false);
  });
});
