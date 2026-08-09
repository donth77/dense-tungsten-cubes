import { describe, expect, it } from 'vitest';
import {
  astmClassLabel,
  cubeMassKg,
  densityOf,
  METALS,
  whaDensity,
  WHA_PURITY_DEFAULT,
} from '../../src/data/metals.ts';

const IN = 0.0254; // metres per inch
const LB_PER_KG = 2.2046226218;

describe('whaDensity — ASTM B777 anchors (02 §4)', () => {
  it('hits every anchor exactly', () => {
    expect(whaDensity(90)).toBe(17_000);
    expect(whaDensity(92.5)).toBe(17_500);
    expect(whaDensity(93)).toBe(17_700);
    expect(whaDensity(95)).toBe(18_000);
    expect(whaDensity(97)).toBe(18_500);
  });

  it('interpolates linearly between anchors', () => {
    // Midway between 95 (18.0) and 97 (18.5) is 96 → 18.25
    expect(whaDensity(96)).toBeCloseTo(18_250, 6);
    // Midway between 90 (17.0) and 92.5 (17.5) is 91.25 → 17.25
    expect(whaDensity(91.25)).toBeCloseTo(17_250, 6);
  });

  it('clamps to the real product range', () => {
    expect(whaDensity(85)).toBe(17_000);
    expect(whaDensity(100)).toBe(18_500);
  });

  it('is monotonically increasing across the slider', () => {
    let prev = -Infinity;
    for (let p = 90; p <= 97; p += 0.1) {
      const d = whaDensity(p);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('cube mass — the anchors the whole product is quoted on (08 §13)', () => {
  it('the "kilo cube" is 0.9955 kg, not 1.000 (02 §3)', () => {
    // Assert the computed value, not the marketing one. A ±0.005 window around
    // 1.000 kg passes by only 0.5 g and would break on any density retune.
    expect(cubeMassKg('W', 1.5 * IN)).toBeCloseTo(0.9955, 3);
  });

  it('a 4" W95 cube is 41.62 lb (Midwest catalog, exact)', () => {
    expect(cubeMassKg('W', 4 * IN) * LB_PER_KG).toBeCloseTo(41.62, 2);
  });

  it('a 2.83" aluminum cube is the 1 kg same-mass line-up member', () => {
    expect(cubeMassKg('Al', 2.83 * IN)).toBeCloseTo(1.0, 2);
  });

  it('the 14.545" meme cube is one short ton', () => {
    expect(cubeMassKg('W', 14.545 * IN) * LB_PER_KG).toBeCloseTo(2000, -1);
  });

  it('spans a 1.4-million-to-one mass ratio across the size slider (08 §14)', () => {
    // The extreme-mass-ratio risk, asserted so it can't drift silently.
    const lightest = cubeMassKg('Al', 0.25 * IN);
    const heaviest = cubeMassKg('W', 15 * IN);
    expect(lightest).toBeCloseTo(0.0007, 4); // ~0.7 g
    expect(heaviest).toBeCloseTo(996, 0); // ~996 kg
    expect(heaviest / lightest).toBeGreaterThan(1_000_000);
  });

  it('purity moves the reading: 90% W is ~5.6% lighter than 95%', () => {
    const at95 = cubeMassKg('W', 1.5 * IN, 95);
    const at90 = cubeMassKg('W', 1.5 * IN, 90);
    expect(at90 / at95).toBeCloseTo(17_000 / 18_000, 6);
    expect(at90).toBeCloseTo(0.9403, 3);
  });
});

describe('densityOf', () => {
  it('defaults tungsten to Class 3 (95%) — what desk cubes actually are', () => {
    expect(densityOf('W')).toBe(whaDensity(WHA_PURITY_DEFAULT));
    expect(densityOf('W')).toBe(18_000);
  });

  it('ignores purity for non-tungsten metals', () => {
    expect(densityOf('Al', 90)).toBe(2700);
    expect(densityOf('Cu', 97)).toBe(8960);
  });
});

/**
 * Gold is in the app for one reason, and it is a numeric one. If these drift, the
 * gold-vs-tungsten comparison stops being surprising and gold becomes decoration.
 */
describe('gold, and why it is here', () => {
  it('is within half a percent of PURE tungsten — the counterfeiting fact', () => {
    const au = densityOf('Au');
    const pureW = 19_250;
    expect(au).toBe(19_320);
    expect(Math.abs(au - pureW) / pureW).toBeLessThan(0.005);
  });

  it('is denser than every heavy-alloy grade the purity slider can reach', () => {
    // The honest half of the story: the ALLOY in this app tops out at 97 % W / 18,500,
    // so a same-size gold cube always wins the scale. Only pure tungsten ties.
    expect(densityOf('Au')).toBeGreaterThan(whaDensity(97));
    expect(cubeMassKg('Au', 2 * IN)).toBeGreaterThan(cubeMassKg('W', 2 * IN, 97));
  });

  it('is the deadest metal in the set — soft, ductile, barely rebounds', () => {
    const others = (['W', 'Cu', 'Fe', 'Ti', 'Al'] as const).map((m) => METALS[m].restitution);
    for (const r of others) expect(METALS.Au.restitution).toBeLessThan(r);
  });
});

describe('astmClassLabel — the honesty rule applies to grades too (08 §16.7)', () => {
  it('labels exact anchors cleanly', () => {
    expect(astmClassLabel(90)).toBe('Class 1');
    expect(astmClassLabel(92.5)).toBe('Class 2');
    expect(astmClassLabel(95)).toBe('Class 3');
    expect(astmClassLabel(97)).toBe('Class 4');
  });

  it('brackets a free slider position rather than rounding to a class', () => {
    expect(astmClassLabel(94)).toBe('between Class 2 and 3');
    expect(astmClassLabel(96)).toBe('between Class 3 and 4');
    // 93% is a supplier grade, not an ASTM class (02 §3).
    expect(astmClassLabel(93)).toBe('between Class 2 and 3');
  });
});
