/**
 * Friction calibration (14 PHY-01, gate: measured pair mu within ±5 %).
 *
 * Before the fix, every one of these was the AVERAGE of the surface's coefficient and the
 * cube's, because `setFriction` was called and `setFrictionCombineRule` never was. Ice was
 * the headline: a configured 0.04 measured 0.245.
 */
import { describe, it, expect } from 'vitest';
import { SURFACES } from '../../src/data/surfaces.ts';
import { METALS } from '../../src/data/metals.ts';
import { pairFriction, pairFrictionMetals } from '../../src/data/contact.ts';
import type { MetalId, SurfaceId } from '../../src/types.ts';
import { IN, G, cube, measureFriction, run, worldWithFloor } from './harness.ts';

const SURFACE_IDS = Object.keys(SURFACES) as SurfaceId[];
/** Relative tolerance on mu. 5 % is the gate 14 §9 proposes. */
const TOL = 0.05;

describe('sliding friction matches the modelled pair coefficient', () => {
  it.each(SURFACE_IDS)('W95 on %s', async (surface) => {
    const pw = await worldWithFloor(surface);
    const h = cube(pw, 'W', 1, { x: -1, y: (1 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 0.5); // settle
    const mu = measureFriction(pw, h);
    const target = pairFriction(METALS.W.friction, SURFACES[surface].friction);
    pw.free();
    expect(target).toBeGreaterThan(0);
    expect(Math.abs(mu - target) / target).toBeLessThan(TOL);
  });

  // Two more metals, so the test covers the metal axis of the pair table and not just
  // the surface axis. Every metal currently shares one coefficient, so these also pin
  // the claim that they behave identically until someone gives them real values.
  it.each<[MetalId, SurfaceId]>([
    ['Al', 'ice'],
    ['Al', 'rubber'],
    ['Fe', 'concrete'],
    ['Fe', 'oak'],
    ['Au', 'steel'],
    ['Ti', 'foam'],
  ])('%s on %s', async (metal, surface) => {
    const pw = await worldWithFloor(surface);
    const h = cube(pw, metal, 1, { x: -1, y: (1 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 0.5);
    const mu = measureFriction(pw, h);
    const target = pairFriction(METALS[metal].friction, SURFACES[surface].friction);
    pw.free();
    expect(Math.abs(mu - target) / target).toBeLessThan(TOL);
  });

  it('ice is genuinely slippery — the failure that started this', async () => {
    const pw = await worldWithFloor('ice');
    const h = cube(pw, 'W', 1, { x: -1, y: (1 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 0.5);
    const mu = measureFriction(pw, h);
    pw.free();
    // The pre-fix value was 0.245. Anything near it means the combine rule regressed.
    expect(mu).toBeLessThan(0.06);
    expect(mu).toBeGreaterThan(0.02);
  });

  it('cube on cube uses the metal-on-metal coefficient, not a surface one', async () => {
    // A 15" platform under a 1" slider: 3,375x the mass, on high-friction concrete, so
    // the lower cube is a surface in all but name and the measured deceleration is the
    // pair coefficient rather than a two-body recoil.
    const pw = await worldWithFloor('concrete');
    const lower = cube(pw, 'W', 15, { x: 0, y: (15 * IN) / 2, z: 0 });
    // Start up-slide of centre and keep the window short: the flat top face is only
    // 0.179 m of half-extent, and a 2 m/s launch runs off the edge in six steps — which
    // reads as a huge extra deceleration and is really just the cube leaving the test.
    const upper = cube(pw, 'W', 1, { x: -0.12, y: 15 * IN + (1 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 1);
    pw.setVelocity(lower, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const mu = measureFriction(pw, upper, 1, 6);
    const target = pairFrictionMetals(METALS.W.friction, METALS.W.friction);
    pw.free();
    expect(target).toBeCloseTo(0.45, 6);
    expect(Math.abs(mu - target) / target).toBeLessThan(0.1);
  });
});

describe('incline angle agrees with the slide test', () => {
  /**
   * The independent check 14 §PHY-01 asks for: a block released on a slope should hold
   * below `atan(mu)` and creep above it. Rapier has no static/kinetic split, so the
   * transition sits AT `atan(mu_k)` rather than at a higher static angle — that is the
   * declared limit of the model, and this test states it rather than hiding it.
   */
  /**
   * A flat floor plus a horizontal `m*g*tan(theta)` is EXACTLY an incline of theta for a
   * flat contact: the normal load stays `m*g`, so friction stays `mu*m*g`, and the block
   * moves precisely when `tan(theta) > mu`. Emulating it this way rather than rotating a
   * collider keeps the contact geometry — and therefore the contact error — identical to
   * every other test in this file.
   */
  async function slidesOn(surface: SurfaceId, angleDeg: number): Promise<number> {
    const pw = await worldWithFloor(surface);
    const a = (angleDeg * Math.PI) / 180;
    const h = cube(pw, 'W', 2, { x: 0, y: (2 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 0.5);
    const start = pw.transformOf(h).p.x;
    const m = pw.massOf(h);
    for (let i = 0; i < 60; i++) {
      pw.applyForce(h, { x: m * G * Math.tan(a), y: 0, z: 0 });
      pw.step(1 / 60, []);
    }
    const moved = Math.abs(pw.transformOf(h).p.x - start);
    pw.free();
    return moved;
  }

  it.each<[SurfaceId, number]>([
    ['concrete', 0.55],
    ['oak', 0.4],
    ['ice', 0.04],
  ])('%s holds below atan(mu) and slides above it', async (surface, mu) => {
    const critical = (Math.atan(mu) * 180) / Math.PI;
    const held = await slidesOn(surface, critical * 0.6);
    const slid = await slidesOn(surface, Math.min(60, critical * 1.8));
    expect(held).toBeLessThan(0.002); // < 2 mm of creep in a second
    expect(slid).toBeGreaterThan(held * 5);
    expect(slid).toBeGreaterThan(0.01);
  });
});
