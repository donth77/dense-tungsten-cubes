/**
 * Free fall and scene independence (14 PHY-05, PHY-04).
 *
 * Two defects met here. Cubes under 1" carried linear damping 0.05 "for stability", so a
 * 0.25" cube fell at -9.568 m/s after one second where a 15" cube fell at -9.810 — a
 * 2.5 % error with a cliff at exactly one inch. And the substep count was derived from
 * the whole scene, so a 15" cube's fall changed by 12.6 mm when an unrelated 0.25" cube
 * existed somewhere else in the world.
 */
import { describe, it, expect } from 'vitest';
import { G, DT, cube, emptyWorld, run } from './harness.ts';

/**
 * Symplectic-Euler free fall is not `½gt²`. Rapier integrates gravity once per internal
 * substep, and it runs `numSolverIterations` of them per step, so after `n` substeps of
 * `h` the drop is `g*h²*n(n+1)/2`. Deriving the expectation rather than hardcoding a
 * measurement is what makes this a test of the ENGINE and not of a previous run.
 */
function idealDropM(seconds: number, substepsPerStep: number): number {
  const h = DT / substepsPerStep;
  const n = Math.round(seconds / h);
  return G * h * h * ((n * (n + 1)) / 2);
}

const SIZES_IN = [0.25, 0.5, 1, 2, 4, 15];

describe('vacuum free fall is the same for every cube', () => {
  it.each(SIZES_IN)('%s" cube reaches -g*t after one second', async (sideIn) => {
    const pw = await emptyWorld();
    const h = cube(pw, 'W', sideIn, { x: 0, y: 20, z: 0 });
    run(pw, 1);
    const v = pw.velocityOf(h);
    pw.free();
    // The velocity result is exact for symplectic Euler: v = -g*t regardless of substep.
    expect(v.y).toBeCloseTo(-G, 3);
    expect(v.x).toBe(0);
    expect(v.z).toBe(0);
  });

  it('there is no discontinuity at the old 1" damping threshold', async () => {
    const speeds: number[] = [];
    for (const sideIn of [0.9, 0.99, 1.0, 1.01, 1.1]) {
      const pw = await emptyWorld();
      const h = cube(pw, 'W', sideIn, { x: 0, y: 20, z: 0 });
      run(pw, 1);
      speeds.push(pw.velocityOf(h).y);
      pw.free();
    }
    /*
     * 1e-5 m/s, not zero: Rapier's WASM is single precision, and float32 eps at |v| = 9.8
     * is 1.2e-6, so consecutive sizes differ in the last bit or two. The discontinuity
     * this test exists to catch was 0.242 m/s (-9.568 below 1", -9.810 at and above it),
     * so the gate is four orders of magnitude tighter than the defect and still above the
     * hardware's own noise floor.
     */
    for (const s of speeds) expect(Math.abs(s - speeds[0]!)).toBeLessThan(1e-5);
  });

  it("every size falls the same DISTANCE, to the integrator's own precision", async () => {
    const drops: number[] = [];
    for (const sideIn of SIZES_IN) {
      const pw = await emptyWorld();
      const h = cube(pw, 'W', sideIn, { x: 0, y: 20, z: 0 });
      run(pw, 1);
      drops.push(20 - pw.transformOf(h).p.y);
      pw.free();
    }
    const spreadMm = (Math.max(...drops) - Math.min(...drops)) * 1000;
    // Pre-fix this spread was 93.9 mm, entirely from the small-cube damping.
    expect(spreadMm).toBeLessThan(1);
    // and the absolute drop must be the engine's own discretisation, not something else
    expect(drops[0]!).toBeCloseTo(idealDropM(1, 4), 3);
  });
});

describe('scene independence: unrelated bodies do not move a reference trajectory', () => {
  /** 14 §9's gate: adding distant bodies changes a trajectory by < 1 mm over one second. */
  const GATE_MM = 1;

  async function referenceFall(extras: number[]): Promise<{ y: number; vy: number }> {
    const pw = await emptyWorld();
    const ref = cube(pw, 'W', 15, { x: 0, y: 20, z: 0 });
    extras.forEach((sideIn, i) => {
      cube(pw, 'W', sideIn, { x: 5 + i * 2, y: 20, z: 0 });
    });
    run(pw, 1);
    const t = pw.transformOf(ref);
    const v = pw.velocityOf(ref);
    pw.free();
    return { y: t.p.y, vy: v.y };
  }

  it('a distant 0.25" cube does not change a 15" cube\'s fall', async () => {
    const alone = await referenceFall([]);
    const together = await referenceFall([0.25]);
    // Pre-fix: 15.077632 alone vs 15.090233 together — 12.6 mm, from an object it never
    // touched, because the smallest half-extent in the world set everyone's substep.
    expect(Math.abs(together.y - alone.y) * 1000).toBeLessThan(GATE_MM);
    expect(together.vy).toBeCloseTo(alone.vy, 6);
  });

  it('a crowd of unrelated cubes of every size changes nothing', async () => {
    const alone = await referenceFall([]);
    const crowd = await referenceFall([0.25, 0.25, 0.5, 1, 2, 4, 8]);
    expect(Math.abs(crowd.y - alone.y) * 1000).toBeLessThan(GATE_MM);
  });

  it('a distant FAST body does not change it either', async () => {
    const pw = await emptyWorld();
    const ref = cube(pw, 'W', 15, { x: 0, y: 20, z: 0 });
    const fast = cube(pw, 'W', 0.25, { x: 5, y: 20, z: 0 });
    pw.setVelocity(fast, { x: 40, y: 0, z: 0 }, { x: 0, y: 300, z: 0 });
    run(pw, 1);
    const y = pw.transformOf(ref).p.y;
    pw.free();

    const alone = await referenceFall([]);
    // This is the case the old global-substep policy handled worst: a fast small body
    // used to force up to 12 substeps for the entire world.
    expect(Math.abs(y - alone.y) * 1000).toBeLessThan(GATE_MM);
  });
});

describe('gravity is the one authoritative constant', () => {
  it('uses NIST standard gravity, not a rounded copy', () => {
    expect(G).toBe(9.80665);
  });
});
