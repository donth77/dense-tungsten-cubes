import { describe, expect, it } from 'vitest';
import { selectionOpacityForSpeed } from '../../src/core/render.ts';

/**
 * The selection brackets fade out while their cube is moving, so they never sit on top
 * of the collision — which is the one event the whole toy exists to show.
 *
 * The ramp is the alternative to a still/moving switch: a binary rule strobes on a cube
 * that is settling onto a stack or rocking on an edge, because that jitter crosses any
 * fixed threshold over and over. These tests pin the properties that make the ramp a
 * safe replacement for that switch.
 */
describe('selectionOpacityForSpeed', () => {
  it('draws at full strength on a cube at rest', () => {
    expect(selectionOpacityForSpeed(0)).toBe(1);
    expect(selectionOpacityForSpeed(0.02)).toBe(1);
  });

  it('is gone well before a dropped cube reaches the floor', () => {
    // A 2" cube falling from the tray lands at ~2.8 m/s. Even a slow nudge clears it.
    expect(selectionOpacityForSpeed(0.35)).toBe(0);
    expect(selectionOpacityForSpeed(2.8)).toBe(0);
    expect(selectionOpacityForSpeed(50)).toBe(0);
  });

  it('never leaves the 0–1 range, including on a NaN-adjacent body', () => {
    for (const v of [-1, 0, 0.1, 0.3, 1, 1e6]) {
      const o = selectionOpacityForSpeed(v);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });

  it('is monotonic — faster never means more visible', () => {
    let prev = Infinity;
    for (let v = 0; v <= 0.5; v += 0.01) {
      const o = selectionOpacityForSpeed(v);
      expect(o).toBeLessThanOrEqual(prev + 1e-9);
      prev = o;
    }
  });

  it('degrades smoothly across the settling range rather than stepping', () => {
    // The anti-strobe property: a cube jittering around 0.1 m/s moves the opacity by a
    // few percent, not between 0 and 1.
    const a = selectionOpacityForSpeed(0.1);
    const b = selectionOpacityForSpeed(0.12);
    expect(Math.abs(a - b)).toBeLessThan(0.1);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
});
