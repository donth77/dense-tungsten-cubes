import { describe, expect, it } from 'vitest';
import { shakeScale, CameraShake } from '../../src/fx/shake.ts';
import { burstSpec } from '../../src/fx/particles.ts';
import { decalSpecs } from '../../src/fx/decals.ts';
import { config } from '../../src/config.ts';

describe('camera shake law (16 §10.1)', () => {
  it('gates below 2 J and saturates at the wow moment', () => {
    expect(shakeScale(1.9)).toBe(0);
    expect(shakeScale(2)).toBeGreaterThan(0);
    expect(shakeScale(config.fx.shake.refJ)).toBeCloseTo(1, 10);
    expect(shakeScale(config.fx.shake.refJ * 10)).toBe(1); // clamped, never exceeds
  });
  it('is √-shaped: quarter energy → half scale', () => {
    expect(shakeScale(config.fx.shake.refJ / 4)).toBeCloseTo(0.5, 10);
  });
  it('stacks to saturation and decays to silence', () => {
    const sh = new CameraShake();
    sh.kick(config.fx.shake.refJ);
    sh.kick(config.fx.shake.refJ); // a shower saturates, never exceeds
    const a0 = sh.offset(1).x ** 2 + sh.offset(1).y ** 2;
    expect(a0).toBeLessThanOrEqual((config.fx.shake.ampFrac * 2) ** 2);
    for (let i = 0; i < 120; i++) sh.update(1 / 60);
    expect(sh.active).toBe(false);
    expect(sh.offset(1)).toEqual({ x: 0, y: 0 });
  });
  it('offset scales with camera distance (same on screen at any zoom)', () => {
    const sh = new CameraShake();
    sh.kick(config.fx.shake.refJ);
    const near = sh.offset(1);
    const far = sh.offset(10);
    expect(far.x).toBeCloseTo(near.x * 10, 10);
  });
});

describe('particle recipes (16 §10.2)', () => {
  it('concrete counts follow 6+42s and the 1 J gate', () => {
    expect(burstSpec('concrete', 1, 0.5)).toBeNull();
    expect(burstSpec('concrete', 0, 5)?.count).toBe(6);
    expect(burstSpec('concrete', 1, 1900)?.count).toBe(48);
  });
  it('steel sparks only above 50 J', () => {
    expect(burstSpec('steel', 0.5, 49)).toBeNull();
    expect(burstSpec('steel', 0.5, 51)?.count).toBe(5);
  });
  it('sand caps at 60; pads and the rest stay silent', () => {
    expect(burstSpec('sand', 1, 1900)?.count).toBe(60);
    expect(burstSpec('trampoline', 1, 500)).toBeNull();
    expect(burstSpec('foam', 1, 500)).toBeNull();
    expect(burstSpec('ice', 1, 500)).toBeNull();
  });
});

describe('decal size laws (16 §7.5)', () => {
  it('concrete chips at 200 J (12 mm) and cracks join at 400 J', () => {
    expect(decalSpecs('concrete', 199)).toEqual([]);
    const chip = decalSpecs('concrete', 200);
    expect(chip).toHaveLength(1);
    expect(chip[0]?.rM).toBeCloseTo(0.012, 5);
    const both = decalSpecs('concrete', 400);
    expect(both.map((d) => d.kind)).toEqual(['chip', 'crack']);
  });
  it('chip radius caps at 40 mm', () => {
    expect(decalSpecs('concrete', 2e6)[0]?.rM).toBe(0.04);
  });
  it('sand craters every impact: 10 J → 3 cm, the wow → 18 cm', () => {
    expect(decalSpecs('sand', 0.4)).toEqual([]);
    expect(decalSpecs('sand', 10)[0]?.rM).toBeCloseTo(0.0312, 3);
    expect(decalSpecs('sand', 1900)[0]?.rM).toBeCloseTo(0.1797, 3);
  });
  it('oak dents from 10 J', () => {
    expect(decalSpecs('oak', 9)).toEqual([]);
    expect(decalSpecs('oak', 10)[0]?.rM).toBeCloseTo(0.006, 5);
  });
});
