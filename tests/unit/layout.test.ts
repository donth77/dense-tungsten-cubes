import { describe, expect, it } from 'vitest';
import { cameraOffsetFor, computeLayout } from '../../src/ui/layout.ts';

/**
 * The breakpoint logic is pure precisely so it can be tested without a browser —
 * these are the same viewports the Playwright projects use (12 §6).
 */

describe('computeLayout — the four classes (12 §3)', () => {
  it('resolves the three test viewports to their intended classes', () => {
    expect(computeLayout(390, 844)).toBe('phone-portrait');
    expect(computeLayout(844, 390)).toBe('phone-landscape');
    expect(computeLayout(820, 1180)).toBe('tablet');
    expect(computeLayout(1280, 800)).toBe('desktop');
  });

  it('keys landscape on HEIGHT, not width — the bug 12 §3 exists to prevent', () => {
    // A landscape phone is 844 px wide, well past the 700 px "phone" width. Test width
    // first and it resolves to `tablet`, gets a bottom sheet, and the sheet covers most
    // of a 390 px-tall viewport.
    expect(computeLayout(844, 390)).toBe('phone-landscape');
    expect(computeLayout(1180, 420)).toBe('phone-landscape');
    // ...including a merely short desktop window, which is the same problem.
    expect(computeLayout(1600, 500)).toBe('phone-landscape');
  });

  it('places the boundaries exactly where the doc says', () => {
    expect(computeLayout(700, 900)).toBe('phone-portrait'); // <= 700 is phone
    expect(computeLayout(701, 900)).toBe('tablet');
    expect(computeLayout(1023, 900)).toBe('tablet');
    expect(computeLayout(1024, 900)).toBe('desktop');
    expect(computeLayout(1280, 520)).toBe('phone-landscape'); // <= 520 tall
    expect(computeLayout(1280, 521)).toBe('desktop');
  });

  it('never returns anything outside the four known classes', () => {
    for (const w of [200, 390, 700, 701, 820, 1024, 2560]) {
      for (const h of [300, 390, 520, 521, 800, 1180, 1440]) {
        expect(['phone-portrait', 'phone-landscape', 'tablet', 'desktop']).toContain(
          computeLayout(w, h),
        );
      }
    }
  });
});

describe('cameraOffsetFor — the camera has to know about the UI (12 §3)', () => {
  it('lifts content clear of a bottom sheet in portrait', () => {
    const o = cameraOffsetFor('phone-portrait', 390, 844);
    expect(o.y).toBeGreaterThan(0);
    expect(o.y).toBeCloseTo(844 / 6, 0);
    expect(o.x).toBe(0);
  });

  it('shifts sideways for the landscape rail instead', () => {
    const o = cameraOffsetFor('phone-landscape', 844, 390);
    expect(o.x).toBeGreaterThan(0);
    expect(o.y).toBe(0);
  });

  it('leaves desktop and tablet centred — panels float, they do not claim a band', () => {
    expect(cameraOffsetFor('desktop', 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(cameraOffsetFor('tablet', 820, 1180)).toEqual({ x: 0, y: 0 });
  });

  it('scales the portrait offset with viewport height, not a fixed pixel count', () => {
    const small = cameraOffsetFor('phone-portrait', 360, 640);
    const large = cameraOffsetFor('phone-portrait', 430, 932);
    expect(large.y).toBeGreaterThan(small.y);
  });
});
