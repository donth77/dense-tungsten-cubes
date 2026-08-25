import { describe, expect, it } from 'vitest';
import { energyComparison, ENERGY_LADDER } from '../../src/data/ladder.ts';

describe('the energy ladder (16 §8.3)', () => {
  it('is sorted and marked approximate', () => {
    for (let i = 1; i < ENERGY_LADDER.length; i++) {
      expect(ENERGY_LADDER[i]!.j).toBeGreaterThan(ENERGY_LADDER[i - 1]!.j);
    }
    expect(energyComparison(117)).toMatch(/^≈ /);
  });

  it('speaks the canonical moments', () => {
    expect(energyComparison(46.2)).toBe('≈ 4.6 × 1 kg dropped from 1 m');
    expect(energyComparison(117)).toBe('≈ a 90 mph fastball');
    expect(energyComparison(392)).toBe('≈ handgun-muzzle class');
    expect(energyComparison(1840)).toBe('≈ 4.7 × handgun-muzzle class');
    expect(energyComparison(1900)).toBe('≈ the 4 in tungsten cube from 10 m');
  });

  it('handles the boundaries exactly', () => {
    expect(energyComparison(0.049)).toBe('less than an egg-cracking tap');
    expect(energyComparison(0.05)).toBe('≈ an egg-cracking tap');
    expect(energyComparison(0.074)).toBe('≈ an egg-cracking tap');
    // 0.075/0.05 is 1.4999999999999998 in floats — it stays the anchor, and that is
    // fine: the boundary belongs to the rule, not to decimal intuition.
    expect(energyComparison(0.075)).toBe('≈ an egg-cracking tap');
    expect(energyComparison(0.0755)).toBe('≈ 1.5 × an egg-cracking tap');
    // Whole-number multiples above 10x, one decimal below.
    expect(energyComparison(1.0)).toBe('≈ 20 × an egg-cracking tap');
    expect(energyComparison(195_000)).toBe('≈ 1.7 × a 1,200 kg car at 50 km/h');
  });

  it('refuses to narrate nonsense', () => {
    expect(energyComparison(Number.NaN)).toBe('—');
    expect(energyComparison(-5)).toBe('—');
  });
});
