import { describe, expect, it } from 'vitest';
import { SelectionFade, selectionMotionSpeed } from '../../src/core/render.ts';

const DT = 1 / 60;
const IN = 0.0254;
const TWO_INCH = 2 * IN;
const ZERO = { x: 0, y: 0, z: 0 };

/** Runs `n` fixed steps at one motion state and returns the resulting opacity. */
function run(fade: SelectionFade, n: number, speed: number, held = false): number {
  let o = 0;
  for (let i = 0; i < n; i++) o = fade.update(speed, held, DT);
  return o;
}

/**
 * The selection brackets label a cube that has come to REST. Anything else — a drag, a
 * slide, a tumble, a slow spin on the spot — hides them, because a bright accent-orange
 * cage riding a cube in motion competes with the one event the whole toy exists to show.
 *
 * The hard part is not hiding, it is coming back without strobing: a cube settling onto
 * a stack or rocking on an edge crosses any fixed speed threshold over and over. These
 * tests pin the two halves of the answer — a motion measure that includes rotation, and
 * asymmetric timing (leave at once, return only after a dwell) that a jittering cube can
 * never satisfy.
 */
describe('selectionMotionSpeed', () => {
  it('is just the speed for a cube that is only translating', () => {
    expect(selectionMotionSpeed({ x: 0.3, y: -0.4, z: 0 }, ZERO, TWO_INCH)).toBeCloseTo(0.5, 6);
  });

  it('sees a cube spinning on the spot, which a linear-only test cannot', () => {
    // The regression this exists for: |v| ≈ 0 while the cube is plainly rotating.
    const spinning = selectionMotionSpeed(ZERO, { x: 0, y: 2, z: 0 }, TWO_INCH);
    expect(spinning).toBeGreaterThan(0.02);
  });

  it('scales the spin term with the cube, so one threshold works at every size', () => {
    // 1 rad/s is a lazy turn on a 15" block and a blur on a 0.25" one.
    const spin = { x: 1, y: 0, z: 0 };
    const small = selectionMotionSpeed(ZERO, spin, 0.25 * IN);
    const large = selectionMotionSpeed(ZERO, spin, 15 * IN);
    expect(large).toBeGreaterThan(small * 50);
  });

  it('is zero for a body that is truly asleep', () => {
    expect(selectionMotionSpeed(ZERO, ZERO, TWO_INCH)).toBe(0);
  });
});

describe('SelectionFade', () => {
  it('starts hidden', () => {
    expect(new SelectionFade().opacity).toBe(0);
  });

  it('answers a click on a resting cube straight away', () => {
    // The dwell exists to outlast a cube's own jitter, not to delay a tap.
    const fade = new SelectionFade();
    fade.reset();
    expect(run(fade, 2, 0)).toBeGreaterThan(0.1);
  });

  it('reaches full strength on a cube at rest', () => {
    const fade = new SelectionFade();
    fade.reset();
    expect(run(fade, 20, 0)).toBe(1);
  });

  it('is gone within a few frames of the cube moving', () => {
    const fade = new SelectionFade();
    fade.reset();
    run(fade, 20, 0);
    // ~60 ms. Fast enough to read as instant, slow enough not to pop.
    expect(run(fade, 4, 2.8)).toBe(0);
  });

  it('stays hidden for the whole of a slow drag', () => {
    // The specific complaint: a gentle 0.1 m/s drag used to leave the brackets at more
    // than half strength, tracking the cube the whole way across the stage.
    const fade = new SelectionFade();
    fade.reset();
    expect(run(fade, 120, 0.1)).toBe(0);
  });

  it('never shows a cube in hand, however still the hand is held', () => {
    // A held cube is moving by definition — under continuous control, with the info card
    // and the force meter already saying which cube it is.
    const fade = new SelectionFade();
    fade.reset();
    expect(run(fade, 300, 0, true)).toBe(0);
  });

  it('waits out the settle dwell before coming back', () => {
    const fade = new SelectionFade();
    fade.reset();
    run(fade, 10, 2.8);
    expect(run(fade, 9, 0)).toBe(0); // 150 ms of stillness — not yet
    expect(run(fade, 6, 0)).toBeGreaterThan(0); // ~250 ms — now
  });

  it('does not strobe on a cube that is still settling', () => {
    // A cube rocking onto its face trips the motion test every few frames. Each trip
    // zeroes the clock, so the 200 ms is never reached and nothing ever flashes on.
    const fade = new SelectionFade();
    fade.reset();
    run(fade, 30, 2.8); // in flight
    expect(fade.opacity).toBe(0);

    let peak = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      peak = Math.max(peak, run(fade, 1, 0.4)); // a rock onto the next edge
      peak = Math.max(peak, run(fade, 5, 0.005)); // ~80 ms of near-stillness between
    }
    expect(peak).toBe(0);

    // ...and the moment it genuinely stops, it comes back.
    expect(run(fade, 30, 0)).toBe(1);
  });

  it('stays inside 0–1 through any sequence', () => {
    const fade = new SelectionFade();
    fade.reset();
    for (const [n, speed, held] of [
      [30, 0, false],
      [3, 5, false],
      [40, 0, false],
      [10, 0, true],
      [60, 0.001, false],
    ] as const) {
      const o = run(fade, n, speed, held);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });

  it('forgets the previous cube when the selection moves', () => {
    const fade = new SelectionFade();
    fade.reset();
    run(fade, 20, 0);
    expect(fade.opacity).toBe(1);
    fade.reset();
    expect(fade.opacity).toBe(0);
  });
});
