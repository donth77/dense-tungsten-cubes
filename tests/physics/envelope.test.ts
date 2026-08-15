/**
 * The supported numerical envelope (14 PHY-03, PHY-04) — resting contact, stacking,
 * tunnelling and the speed cap.
 *
 * This file exists because the full advertised domain CANNOT be made robust with Rapier
 * 0.19.3. That is a measured result, not an opinion: solver iterations 4/8/16/32, internal
 * PGS iterations 1/4/8, `lengthUnit` 1/0.1/0.01, `allowedLinearError` down to exactly 0,
 * and 1/4/12 substeps were all swept against the 0.25"-under-4" case, and the small cube's
 * sink moved from 55.93 % of its side to 54.35 % — i.e. nowhere. So the envelope is
 * published and enforced here instead of being implied by a slider range.
 */
import { describe, it, expect } from 'vitest';
import { IN, cube, run, worldWithFloor, sinkM } from './harness.ts';
import { config } from '../../src/config.ts';
import type { ImpactEvent } from '../../src/types.ts';

/*
 * THE PUBLISHED STACKING ENVELOPE. Two conditions, both measured, both necessary.
 *
 * Swept lower size x size ratio with BOTH cubes checked against their ideal heights
 * (`HELD` = the upper cube did not fall to the floor):
 *
 *   lower | ratio 1 | ratio 2 | ratio 3 | ratio 4
 *   0.25" |    -    |    -    |    -    |    -
 *   0.30" |    -    |    -    |    -    |    -
 *   0.40" |    -    |    -    |    -    |    -
 *   0.50" |    -    |    -    |    -    |    -
 *   0.60" |    -    |   held  |    -    |    -
 *   0.75" |   held  |   held  |    -    |    -
 *   1.00" |   held  |   held  |    -    |    -
 *   2.00" |   held  |   held  |   held  |    -
 *
 * Two separate limits fall out, and quoting only one of them would be misleading:
 *
 * 1. A SIZE FLOOR. Below 0.75" a cube cannot reliably support anything at all — not even
 *    an identical cube. The lower body is NOT being crushed when this happens; its own
 *    sink stays at 2-4 %. The upper cube slides off and lands on the floor. It is a
 *    small-scale contact-manifold instability, not penetration.
 * 2. A SIZE RATIO of 2, above the floor.
 *
 * This is PRE-EXISTING behaviour, not a regression from the rounded collider (14 PHY-07).
 * Compared directly at identical settings: 0.25-on-0.25 and 0.25-on-0.5 fail with sharp
 * and round colliders alike, and 0.5-on-1 fails with a SHARP collider (13.0 mm drop) and
 * HOLDS with a round one (3.7 mm). Rounding the collider made this strictly better.
 *
 * The limit is geometric, not gravitational: at equal size a 6.67x density ratio (Al
 * under W) moves the sink by less than a percentage point.
 */
const SUPPORTED_STACK_SIZE_RATIO = 2;
/** Inches. Below this a cube is not a reliable support for anything. */
const SUPPORTED_STACK_MIN_LOWER_IN = 0.75;

/**
 * Resting penetration is very nearly CONSTANT in absolute terms — it is set by the
 * contact tolerance, not by the body — so quoting one percentage gate for a 60:1 size
 * range would be meaningless at one end or the other. The absolute figure is the real
 * invariant, and the per-size percentages are what it implies.
 */
const MAX_RESTING_SINK_MM = 0.35;

describe('resting contact', () => {
  /** The M0 jitter gate, now without the small-cube damping that used to prop it up. */
  it.each([0.25, 0.5, 1, 2, 4, 15])('a %s" cube rests without drifting', async (sideIn) => {
    const pw = await worldWithFloor('concrete');
    const s = sideIn * IN;
    const h = cube(pw, 'W', sideIn, { x: 0, y: s / 2 + 1e-4, z: 0 });
    run(pw, 1.5);
    const settled = pw.transformOf(h).p;
    run(pw, 3);
    const now = pw.transformOf(h).p;
    const driftMm = Math.hypot(now.x - settled.x, now.y - settled.y, now.z - settled.z) * 1000;
    const sinkMm = sinkM(pw, h, s / 2) * 1000;
    pw.free();
    expect(driftMm).toBeLessThan(0.5); // the 08 §11 step 8 gate
    expect(sinkMm).toBeLessThan(MAX_RESTING_SINK_MM);
    expect(now.y).toBeGreaterThan(0); // centre never crosses the supporting surface
  });

  it('the smallest cube is the worst case, and it is 2.9 % of its side', async () => {
    /*
     * The honest edge. 14 §9 proposes "penetration < 1 % of the smallest body side";
     * this engine cannot deliver that at 0.25" — the tolerance sweep bottoms out around
     * 2.4 % — so the gate published here is the one that is actually met. It was 6.5 %
     * before the tolerance was tightened.
     */
    const pw = await worldWithFloor('concrete');
    const s = 0.25 * IN;
    const h = cube(pw, 'W', 0.25, { x: 0, y: s / 2 + 1e-4, z: 0 });
    run(pw, 3);
    const pct = (sinkM(pw, h, s / 2) / s) * 100;
    pw.free();
    expect(pct).toBeLessThan(3.5);
    expect(pct).toBeGreaterThan(1); // if this ever passes, the envelope doc is stale
  });

  it('a 3-high same-size stack settles, measured PER CONTACT', async () => {
    const pw = await worldWithFloor('concrete');
    const s = 2 * IN;
    const ids = [0, 1, 2].map((i) => cube(pw, 'W', 2, { x: 0, y: s / 2 + i * s + 1e-4, z: 0 }));
    run(pw, 4);
    const drops = ids.map((h, i) => s / 2 + i * s - pw.transformOf(h).p.y);
    pw.free();
    /*
     * Each cube against ITS OWN contact, not against absolute height: measuring the top
     * cube against its ideal counts the bottom cube's penetration three times.
     *
     * The gate is a share of the side rather than the single-body millimetre figure,
     * because a loaded contact legitimately sits deeper — the bottom cube here carries
     * three cubes' weight. Measured worst contact: 1.80 % of side.
     */
    for (let i = 0; i < 3; i++) {
      const perContact = drops[i]! - (i > 0 ? drops[i - 1]! : 0);
      expect((perContact / s) * 100).toBeLessThan(3);
      expect(perContact).toBeGreaterThan(-1e-4);
    }
  });
});

describe('the published stacking envelope holds, and its edge is where we say it is', () => {
  /**
   * BOTH bodies, not just the lower one. Measuring only the lower cube's sink is how the
   * first version of this test passed while the stack it was checking had actually
   * collapsed: the lower cube sat there perfectly at 4 % sink while the upper one slid
   * off it onto the floor. `upperDropMm` is the number that says whether a stack is a
   * stack.
   */
  async function stack(
    lowerIn: number,
    upperIn: number,
  ): Promise<{ lowerSinkPct: number; upperDropMm: number; held: boolean }> {
    const pw = await worldWithFloor('concrete');
    const a = lowerIn * IN;
    const b = upperIn * IN;
    const lo = cube(pw, 'W', lowerIn, { x: 0, y: a / 2, z: 0 });
    const up = cube(pw, 'W', upperIn, { x: 0, y: a + b / 2, z: 0 });
    run(pw, 10);
    const lowerSinkPct = (sinkM(pw, lo, a / 2) / a) * 100;
    const upperDrop = sinkM(pw, up, a + b / 2);
    pw.free();
    // "Held" means the upper cube did not descend by anything like the lower cube's side.
    return { lowerSinkPct, upperDropMm: upperDrop * 1000, held: upperDrop < a * 0.4 };
  }

  it.each([
    [0.75, 0.75],
    [0.75, 1.5],
    [1, 2],
    [2, 4],
    [4, 8],
    [7.5, 15],
  ])('%s" under %s" is inside the envelope', async (lower, upper) => {
    expect(lower).toBeGreaterThanOrEqual(SUPPORTED_STACK_MIN_LOWER_IN);
    expect(upper / lower).toBeLessThanOrEqual(SUPPORTED_STACK_SIZE_RATIO);
    const r = await stack(lower, upper);
    expect(r.held).toBe(true);
    expect(r.lowerSinkPct).toBeLessThan(13);
  });

  it.each([
    [0.25, 0.25, 'below the size floor — even an identical cube slides off'],
    [0.5, 1, 'below the size floor'],
    [1, 3, 'above the size ratio'],
    [0.25, 1, 'both limits at once'],
  ])('%s" under %s" is OUTSIDE it: %s', async (lower, upper) => {
    /*
     * These are receipts, not aspirations. They assert the failure so that a change which
     * FIXES one is noticed immediately rather than silently widening an envelope the
     * product is still describing conservatively.
     */
    const outside =
      lower < SUPPORTED_STACK_MIN_LOWER_IN || upper / lower > SUPPORTED_STACK_SIZE_RATIO;
    expect(outside).toBe(true);
    const r = await stack(lower, upper);
    expect(r.held).toBe(false);
  });
});

describe('continuous collision detection', () => {
  /** Fire a cube at a thin plate and report whether it ended up on the far side. */
  async function tunnels(sideIn: number, speed: number, spinRadS = 0): Promise<boolean> {
    const pw = await worldWithFloor('concrete');
    const s = sideIn * IN;
    // A 10 mm plate standing on the floor: thinner than a 0.25" cube is wide.
    pw.addStaticBox({ x: 0.005, y: 0.5, z: 0.5 }, { x: 0, y: 0.5, z: 0 }, 'steel');
    const h = cube(pw, 'W', sideIn, { x: -0.6, y: 0.5, z: 0 });
    pw.setVelocity(h, { x: speed, y: 0, z: 0 }, { x: 0, y: 0, z: spinRadS });
    const out: ImpactEvent[] = [];
    for (let i = 0; i < 120; i++) {
      pw.step(config.loop.DT, out);
      if (pw.transformOf(h).p.x > 0.005 + s) {
        pw.free();
        return true;
      }
    }
    pw.free();
    return false;
  }

  it.each([
    [0.25, 10],
    [0.25, 30],
    [0.25, 50],
    [1, 10],
    [1, 30],
    [1, 50],
    [4, 50],
  ])('a %s" cube at %s m/s does not pass through a 10 mm plate', async (sideIn, speed) => {
    // The old global-substep policy tunnelled in 5 of these 6 speed/size cases.
    expect(await tunnels(sideIn, speed)).toBe(false);
  });

  it('a fast-SPINNING cube is protected too, not just a fast-translating one', async () => {
    // The old test was post-step |v| > 5 m/s, which is blind to angular sweep.
    expect(await tunnels(1, 8, 200)).toBe(false);
  });

  it('CCD is chosen before the step, so the first fast step is already protected', async () => {
    const pw = await worldWithFloor('concrete');
    pw.addStaticBox({ x: 0.005, y: 0.5, z: 0.5 }, { x: 0, y: 0.5, z: 0 }, 'steel');
    const h = cube(pw, 'W', 1, { x: -0.6, y: 0.5, z: 0 });
    // 45 m/s covers 0.75 m in one step — past the plate. If CCD were selected from
    // POST-step speed, this single step would tunnel before CCD was ever switched on.
    pw.setVelocity(h, { x: 45, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    pw.step(config.loop.DT, []);
    const x = pw.transformOf(h).p.x;
    pw.free();
    expect(x).toBeLessThan(0.005);
  });
});

describe('the speed cap bounds travel instead of rewriting history', () => {
  it('a body already over the cap is brought back BEFORE it integrates', async () => {
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 1.5, { x: 0, y: 20, z: 0 });
    const before = pw.transformOf(h).p.x;
    pw.setVelocity(h, { x: 500, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    pw.step(config.loop.DT, []);
    const travelled = pw.transformOf(h).p.x - before;
    pw.free();
    /*
     * The property the old post-step cap could not provide. Applied after integration it
     * let the body cover the distance first and tidied the number afterwards; applied
     * before, the reported speed and the distance actually covered agree.
     */
    const maxTravel = config.stability.maxSpeedMps * config.loop.DT;
    expect(travelled).toBeLessThanOrEqual(maxTravel * 1.02);
  });

  it('a huge one-step force outruns the cap — and CCD covers it, which is the design', async () => {
    /*
     * Honest statement of what the cap is and is not. A body accelerated from rest inside
     * a single step has no pre-step speed to clamp, so it CAN travel further than
     * `maxSpeedMps * dt` in that step; the cap is a fail-safe on sustained velocity, not
     * a bound on displacement. What must hold is that the contact is still not missed,
     * and that is CCD's job — `#updateCcd` predicts `v + (F/m + g)*dt` precisely so this
     * case turns CCD on for the step that needs it.
     */
    const pw = await worldWithFloor('concrete');
    pw.addStaticBox({ x: 0.005, y: 0.5, z: 0.5 }, { x: 0.5, y: 20, z: 0 }, 'steel');
    const h = cube(pw, 'W', 1.5, { x: 0, y: 20, z: 0 });
    pw.applyForce(h, { x: 6000, y: 0, z: 0 });
    pw.step(config.loop.DT, []);
    const x = pw.transformOf(h).p.x;
    pw.free();
    // Un-protected this reached 1.046 m, straight through a plate at x = 0.5.
    expect(x).toBeLessThan(0.5);
  });

  it('and the cap still applies on the following step', async () => {
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 1.5, { x: 0, y: 20, z: 0 });
    pw.applyForce(h, { x: 6000, y: 0, z: 0 });
    pw.step(config.loop.DT, []);
    pw.step(config.loop.DT, []);
    const speed = Math.abs(pw.velocityOf(h).x);
    pw.free();
    expect(speed).toBeLessThanOrEqual(config.stability.maxSpeedMps * 1.001);
  });

  it('leaves ordinary speeds completely alone', async () => {
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 1, { x: 0, y: 5, z: 0 });
    pw.setVelocity(h, { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    pw.step(config.loop.DT, []);
    const v = pw.velocityOf(h);
    pw.free();
    expect(v.x).toBeCloseTo(3, 5);
  });
});

describe('mass properties survive every path that can change them', () => {
  it('mass is exactly rho * side^3 at creation', async () => {
    const { cubeMassKg } = await import('../../src/data/metals.ts');
    const pw = await worldWithFloor('concrete');
    for (const sideIn of [0.25, 1, 2, 4, 15]) {
      const h = cube(pw, 'W', sideIn, { x: 0, y: 5, z: 0 });
      const want = cubeMassKg('W', sideIn * IN, 95);
      expect(pw.massOf(h) / want).toBeCloseTo(1, 4);
    }
    pw.free();
  });

  it("and after a purity change, which used to reset it to Rapier's approximation", async () => {
    const { cubeMassKg, densityOf } = await import('../../src/data/metals.ts');
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 2, { x: 0, y: 5, z: 0 });
    pw.setDensity(h, densityOf('W', 90));
    const want = cubeMassKg('W', 2 * IN, 90);
    const got = pw.massOf(h);
    pw.free();
    expect(got / want).toBeCloseTo(1, 4);
  });
});
