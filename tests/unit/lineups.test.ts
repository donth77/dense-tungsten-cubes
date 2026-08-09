import { describe, expect, it } from 'vitest';
import { LINEUP_METALS, SAME_MASS_IN } from '../../src/labs/sandbox/index.ts';
import { cubeMassKg, METALS, WHA_PURITY_DEFAULT } from '../../src/data/metals.ts';

const IN = 0.0254;
/** What the line-up buttons actually spawn tungsten at. */
const W_PURITY = WHA_PURITY_DEFAULT;

/**
 * The two line-ups make a factual claim in their own toast — "every cube here weighs
 * about 1 kg", "2.5 kg down to 0.35 kg" — which puts them under 01's honesty rule.
 * Hand-picked side lengths are exactly the kind of constant that silently stops being
 * true when a metal is added or a density is corrected.
 */
describe('the "same mass" line-up', () => {
  it('really does weigh 1 kg, every cube', () => {
    for (const [metal, inches] of SAME_MASS_IN) {
      const kg = cubeMassKg(metal, inches * IN, W_PURITY);
      expect(kg, `${metal} at ${inches}"`).toBeGreaterThan(0.99);
      expect(kg, `${metal} at ${inches}"`).toBeLessThan(1.01);
    }
  });

  it('runs smallest to largest, so size reads as density', () => {
    const sides = SAME_MASS_IN.map(([, inches]) => inches);
    for (let i = 1; i < sides.length; i++) {
      expect(sides[i]!, `entry ${i} breaks the ascending order`).toBeGreaterThan(sides[i - 1]!);
    }
  });

  it('puts gold first — a kilo of gold is smaller than a kilo of tungsten alloy', () => {
    // The point of the row. If the heavy-alloy density ever rises past gold's, this
    // ordering becomes a lie and the test says so.
    expect(SAME_MASS_IN[0]![0]).toBe('Au');
  });

  it('covers every metal, so no swatch is missing from the comparison', () => {
    expect([...SAME_MASS_IN.map(([m]) => m)].sort()).toEqual(Object.keys(METALS).sort());
  });
});

describe('the "same size" line-up', () => {
  it('covers every metal', () => {
    expect([...LINEUP_METALS].sort()).toEqual(Object.keys(METALS).sort());
  });

  it('spans the mass range its toast advertises', () => {
    const masses = LINEUP_METALS.map((m) => cubeMassKg(m, 2 * IN, W_PURITY));
    // Toast says "2.5 kg down to 0.35 kg".
    expect(Math.max(...masses)).toBeCloseTo(2.5, 1);
    expect(Math.min(...masses)).toBeCloseTo(0.35, 2);
  });
});
