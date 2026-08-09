import { describe, expect, it } from 'vitest';
import {
  cubeSide,
  density,
  energy,
  force,
  IN_PER_M,
  LB_PER_KG,
  length,
  mass,
  massFixed,
  M_PER_IN,
  percent,
  speed,
  volume,
} from '../../src/data/format.ts';
import { cubeMassKg } from '../../src/data/metals.ts';

describe('unit round-trips', () => {
  it('kg <-> lb and m <-> in are exact inverses', () => {
    expect(1 * LB_PER_KG * 0.45359237).toBeCloseTo(1, 12);
    expect(1 * IN_PER_M * M_PER_IN).toBeCloseTo(1, 12);
  });
});

describe('mass — SI primary, imperial subtitle (08 §2.3)', () => {
  it('auto-scales down to grams and milligrams', () => {
    // A 0.25" aluminium cube is ~0.7 g. "0.00 kg" would be a useless readout.
    const tiny = cubeMassKg('Al', 0.25 * M_PER_IN);
    expect(mass(tiny).primary).toMatch(/g$/);
    expect(mass(0.0000005).primary).toMatch(/mg$/);
  });

  it('keeps kg for ordinary cubes', () => {
    expect(mass(18.88).primary).toBe('18.9 kg');
    expect(mass(18.88).secondary).toBe('41.6 lb');
  });

  it('swaps primary and secondary in imperial mode', () => {
    const si = mass(18.88, 'si');
    const imp = mass(18.88, 'imperial');
    expect(imp.primary).toBe(si.secondary);
    expect(imp.secondary).toBe(si.primary);
  });

  it('massFixed holds width so an instrument does not jitter', () => {
    // 02 §3: the scale reads two decimals, which is what lets the 1.5" cube show 1.00 kg
    // honestly (it computes to 0.9955).
    const kilo = cubeMassKg('W', 1.5 * M_PER_IN);
    expect(massFixed(kilo).primary).toBe('1.00 kg');
    expect(massFixed(0.9949).primary).toBe('0.99 kg');
    expect(massFixed(12).primary).toHaveLength('12.00 kg'.length);
  });
});

describe('cubeSide — the one deliberate imperial-first exception', () => {
  it('leads with inches because that is how the product is sold', () => {
    expect(cubeSide(2 * M_PER_IN).primary).toBe('2″');
    expect(cubeSide(1.5 * M_PER_IN).primary).toBe('1.5″');
    expect(cubeSide(0.25 * M_PER_IN).primary).toBe('0.25″');
  });

  it('carries millimetres as the subtitle', () => {
    expect(cubeSide(2 * M_PER_IN).secondary).toBe('50.8 mm');
    expect(cubeSide(4 * M_PER_IN).secondary).toBe('101.6 mm');
  });

  it('does not print trailing zeros like a part number', () => {
    expect(cubeSide(3 * M_PER_IN).primary).toBe('3″');
    expect(cubeSide(3 * M_PER_IN).primary).not.toBe('3.00″');
  });
});

describe('the other formatters', () => {
  it('density leads in g/cm³, the unit every alloy datasheet uses', () => {
    expect(density(18_000).primary).toBe('18.00 g/cm³');
    expect(density(18_000).secondary).toBe('18000 kg/m³');
    expect(density(2700).primary).toBe('2.70 g/cm³');
  });

  it('length scales mm -> cm -> m', () => {
    expect(length(0.005).primary).toMatch(/mm$/);
    expect(length(0.5).primary).toMatch(/cm$/);
    expect(length(12).primary).toMatch(/m$/);
  });

  it('force, energy, speed and volume all carry a secondary reading', () => {
    for (const r of [force(350), energy(372), speed(5.6), volume(0.001)]) {
      expect(r.primary).not.toBe('');
      expect(r.secondary).not.toBe('');
      expect(r.primary).not.toBe(r.secondary);
    }
  });

  it('percent trims noise', () => {
    expect(percent(95)).toBe('95 %');
    expect(percent(92.5)).toBe('92.5 %');
  });

  it('never renders NaN or Infinity into the UI', () => {
    // A non-finite value reaching a label is a bug upstream, but it must show as an
    // em dash rather than the string "NaN kg" in the middle of the info card.
    expect(mass(NaN).primary).toBe('—');
    expect(mass(NaN).secondary).toBe('—');
    expect(energy(Infinity).primary).toBe('—');
    expect(cubeSide(NaN).primary).toBe('—');
    expect(density(NaN).primary).toBe('—');
  });
});
