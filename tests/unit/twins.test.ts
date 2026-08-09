import { describe, expect, it } from 'vitest';
import { CUBE_TWINS, MASS_ANCHORS, massComparison, matchTwin } from '../../src/data/twins.ts';
import { cubeMassKg } from '../../src/data/metals.ts';

const IN = 0.0254;

describe("matchTwin — 08 §13's stated tolerance behaviour", () => {
  it('matches the 1.5" tungsten cube to the kilo cube', () => {
    const t = matchTwin('W', 1.5 * IN);
    expect(t?.label).toBe('the 1 kg cube');
  });

  it('still matches at 1.49" (inside 2 %) but not at 1.4"', () => {
    expect(matchTwin('W', 1.49 * IN)).not.toBeNull();
    expect(matchTwin('W', 1.4 * IN)).toBeNull();
  });

  it('is metal-specific — a 1.5" aluminium cube is not the kilo cube', () => {
    expect(matchTwin('Al', 1.5 * IN)).toBeNull();
  });

  it('carries the honest caveat where marketing and physics disagree (02 §3)', () => {
    // The product is sold as 1 kg; at nominal Class-3 density it computes to 0.9955.
    // The card says both, which is pillar 2 (01) doing its job.
    const t = matchTwin('W', 1.5 * IN);
    expect(t?.note).toContain('0.996');
    expect(cubeMassKg('W', 1.5 * IN)).toBeCloseTo(0.9955, 3);
  });

  it('every catalog entry is a claim about a real product, so none are placeholders', () => {
    for (const t of CUBE_TWINS) {
      expect(t.label.length).toBeGreaterThan(3);
      expect(t.sideIn).toBeGreaterThan(0);
      expect(t.metal).toBe('W');
    }
  });
});

describe('massComparison — the plain-language ladder', () => {
  it('names a near-exact anchor without a multiplier', () => {
    expect(massComparison(7.3)).toBe('about the same as a bowling ball');
    expect(massComparison(1.0)).toBe('about the same as a litre of water');
  });

  it('uses a multiple when the value sits in a gap in the ladder', () => {
    // 160 kg is between an adult person (80) and an upright piano (300).
    expect(massComparison(160)).toMatch(/^about (2×|a half of) /);
    // 21 kg is a bit under 3x a gallon of milk / over a car battery.
    expect(massComparison(36)).toMatch(/^about /);
  });

  it('never emits arithmetic nobody says — no "0.43×" and no "1/1.5"', () => {
    // Writing this caught a real one: 40 kg against a 60 kg keg produced
    // "about 1/1.5 of a full beer keg". Fractions now take whole denominators only.
    for (let kg = 0.0005; kg < 1500; kg *= 1.13) {
      const s = massComparison(kg);
      if (s === null) continue;
      expect(s, `for ${kg} kg`).not.toMatch(/0\.\d+×/);
      expect(s, `for ${kg} kg`).not.toMatch(/1\/\d*\.\d/);
      expect(s, `for ${kg} kg`).toMatch(/^about /);
      // Every phrase must be one of the three sanctioned shapes.
      expect(s, `for ${kg} kg`).toMatch(
        /^about (the same as|\d+(\.\d)?× |a (half|third|quarter|fifth|sixth|seventh|eighth|ninth|tenth) of )/,
      );
    }
  });

  it('spans the full range a cube can actually be', () => {
    // 0.25" aluminium (~0.7 g) through 15" tungsten (~996 kg).
    expect(massComparison(cubeMassKg('Al', 0.25 * IN))).not.toBeNull();
    expect(massComparison(cubeMassKg('W', 15 * IN))).not.toBeNull();
    // And the two cubes people actually talk about.
    expect(massComparison(cubeMassKg('W', 1.5 * IN))).toContain('litre of water');
    expect(massComparison(cubeMassKg('W', 4 * IN))).toContain('car battery');
  });

  it('rejects nonsense input rather than rendering it', () => {
    expect(massComparison(0)).toBeNull();
    expect(massComparison(-5)).toBeNull();
    expect(massComparison(NaN)).toBeNull();
  });

  it('keeps the anchor ladder sorted and free of duplicates', () => {
    // An unsorted or duplicated ladder silently picks the wrong comparison.
    for (let i = 1; i < MASS_ANCHORS.length; i++) {
      expect(MASS_ANCHORS[i]!.kg).toBeGreaterThan(MASS_ANCHORS[i - 1]!.kg);
    }
    expect(new Set(MASS_ANCHORS.map((a) => a.label)).size).toBe(MASS_ANCHORS.length);
  });
});
