import { describe, expect, it } from 'vitest';
import { emptyWorld, worldWithFloor, DT } from './harness.ts';
import type { ColliderPart, ImpactEvent } from '../../src/types.ts';

/**
 * Stage W1 — the physics facade extensions the Weigh Station needs (15 §8.2).
 *
 * The record used to assume one collider per body. An instrument is not one collider: a
 * balance beam is a bar plus a keel, a pan is a floor plus a rim, and every path that
 * walks contacts, materials, raycasts or teardown had to learn that. These tests cover
 * the seams that refactor could have quietly broken, and the joint behaviour W0 measured
 * but could not enforce from inside a spike.
 */

const box = (
  hx: number,
  hy: number,
  hz: number,
  massKg?: number,
  at?: { x: number; y: number; z: number },
): ColliderPart => ({
  shape: { kind: 'box', halfExtents: { x: hx, y: hy, z: hz } },
  material: 'steel',
  ...(massKg !== undefined ? { massKg } : {}),
  ...(at ? { at } : {}),
});

describe('compound bodies', () => {
  it('weighs exactly what its parts declare', async () => {
    const pw = await emptyWorld();
    const h = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.2, 0.01, 0.01, 1.0), box(0.02, 0.02, 0.02, 0.5, { x: 0, y: -0.1, z: 0 })],
    });
    // Mass is asked for per part and turned into a density, so it must come back exactly.
    expect(pw.massOf(h)).toBeCloseTo(1.5, 6);
    pw.free();
  });

  it('weighs what a ROUNDED part declares too, not what its outer box suggests', async () => {
    // Two Rapier behaviours compose here: roundCuboid grows the box it is given by the
    // border radius, and it derives mass from that inner box alone. Deriving density
    // from the outer volume made every rounded part light by ((h-r)/h)^3.
    const pw = await emptyWorld();
    const h = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [
        {
          shape: {
            kind: 'roundedBox',
            halfExtents: { x: 0.05, y: 0.05, z: 0.05 },
            borderRadiusM: 0.005,
          },
          material: 'steel',
          massKg: 2,
        },
      ],
    });
    expect(pw.massOf(h)).toBeCloseTo(2, 5);
    pw.free();
  });

  it('puts its centre of mass where the parts are, not where anyone declared', async () => {
    // 15 §6.2 turns on this: a balance restores to level because its yoke mass hangs
    // BELOW the pivot. If the COM were a declared number the beam could claim a
    // restoring moment its visible shape does not have.
    const pw = await emptyWorld();
    const h = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [
        box(0.2, 0.01, 0.01, 0.3), // bar, through the origin
        box(0.02, 0.02, 0.02, 0.7, { x: 0, y: -0.12, z: 0 }), // keel, hung below
      ],
    });
    const com = pw.centerOfMassOf(h);
    // 0.7 of the mass at -0.12 => 0.084 m below the body origin.
    expect(com.y).toBeCloseTo(1 - 0.084, 4);
    expect(com.x).toBeCloseTo(0, 6);
    pw.free();
  });

  it('is found by a raycast that hits a part other than the first', async () => {
    const pw = await emptyWorld();
    const h = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.05, 0.05, 0.05), box(0.05, 0.05, 0.05, undefined, { x: 0.5, y: 0, z: 0 })],
    });
    // One step first: Rapier builds its query structures during `step`, so a raycast
    // against a world that has never been stepped hits nothing at all.
    pw.step(DT, []);
    // Aim at the SECOND part. Before the refactor only the first collider was mapped
    // back to its body, so this returned nothing and the part was un-clickable.
    const hit = pw.raycast({ x: 0.5, y: 3, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(hit?.handle).toBe(h);
    pw.free();
  });

  it('reports an impact from a non-first part', async () => {
    const pw = await worldWithFloor('concrete');
    // A compound whose SECOND part is the one that lands.
    pw.addCompound({
      kind: 'dynamic',
      at: { x: 0.4, y: 0.35, z: 0 },
      parts: [
        box(0.02, 0.02, 0.02, 0.4, { x: -0.4, y: 0, z: 0 }),
        box(0.03, 0.03, 0.03, 0.6, { x: 0, y: 0, z: 0 }),
      ],
    });
    const impacts: ImpactEvent[] = [];
    for (let i = 0; i < 120; i++) pw.step(DT, impacts);
    expect(impacts.length).toBeGreaterThan(0);
    expect(impacts.every((e) => Number.isFinite(e.energyJ))).toBe(true);
    pw.free();
  });

  it('describes its parts back, so a debug overlay can draw what the solver sees', async () => {
    // Not what the artist supplied. 15 §1 drives instrument physics from simplified
    // procedural colliders rather than the GLB's render triangles, so an overlay drawn
    // from the mesh would hide exactly the mismatch it exists to reveal.
    const pw = await emptyWorld();
    const parts = [box(0.2, 0.01, 0.01, 1), box(0.02, 0.02, 0.02, 0.5, { x: 0, y: -0.1, z: 0 })];
    const h = pw.addCompound({ kind: 'dynamic', at: { x: 0, y: 1, z: 0 }, parts });
    const described = pw.partsOf(h);
    expect(described).toHaveLength(2);
    expect(described[1]?.at).toEqual({ x: 0, y: -0.1, z: 0 });
    expect(pw.allBodies()).toContain(h);
    // A cube is one implicit part and carries `sideM` instead.
    const cubeH = pw.addCube({ metal: 'W', sideM: 0.05, purityPctW: 95 }, { x: 1, y: 1, z: 0 });
    expect(pw.partsOf(cubeH)).toHaveLength(0);
    pw.free();
  });

  it('forgets every collider when the body is removed', async () => {
    const pw = await emptyWorld();
    const h = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.05, 0.05, 0.05), box(0.05, 0.05, 0.05, undefined, { x: 0.5, y: 0, z: 0 })],
    });
    expect(pw.hasBody(h)).toBe(true);
    pw.remove(h);
    expect(pw.hasBody(h)).toBe(false);
    pw.step(DT, []);
    // Both parts gone, not just the one the record happened to name.
    expect(pw.raycast({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull();
    expect(pw.raycast({ x: 0.5, y: 3, z: 0 }, { x: 0, y: -1, z: 0 })).toBeNull();
    pw.free();
  });
});

describe('joints', () => {
  /** A hinge holding a bar, with a limit. */
  async function hinged(limitDeg: number | null) {
    const pw = await emptyWorld();
    const stand = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.02, 0.02, 0.02)],
    });
    const bar = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.3, 0.01, 0.01, 2)],
    });
    const lim = limitDeg === null ? null : (limitDeg * Math.PI) / 180;
    const j = pw.addRevoluteJoint({
      bodyA: stand,
      bodyB: bar,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
      ...(lim === null ? {} : { limitsRad: [-lim, lim] as const }),
    });
    return {
      pw,
      bar,
      j,
      angleDeg: () => {
        const q = pw.transformOf(bar).q;
        return (2 * Math.atan2(q.z, q.w) * 180) / Math.PI;
      },
    };
  }

  it('holds a revolute limit that JointData alone would silently ignore', async () => {
    // The W0 finding, now enforced from inside the facade: `JointData.limitsEnabled` is
    // not wired for revolute in 0.19.3, so the limit has to go on after creation. Without
    // that, this bar spins a full 360.
    const { pw, bar, angleDeg } = await hinged(12);
    for (let i = 0; i < 240; i++) {
      pw.applyTorque(bar, { x: 0, y: 0, z: 6 });
      pw.step(DT, []);
    }
    expect(Math.abs(angleDeg())).toBeLessThan(12.5);
    pw.free();
  });

  it('spins freely when no limit is asked for, so the limit is doing the work', async () => {
    const { pw, bar, angleDeg } = await hinged(null);
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      pw.applyTorque(bar, { x: 0, y: 0, z: 6 });
      pw.step(DT, []);
      peak = Math.max(peak, Math.abs(angleDeg()));
    }
    expect(peak).toBeGreaterThan(45);
    pw.free();
  });

  it('constrains a prismatic slider to its axis and its stops', async () => {
    const pw = await emptyWorld();
    // The housing sits BELOW the platter. Co-located colliders would resolve their
    // overlap by shoving the platter upward, and the test would measure contact rather
    // than the joint.
    const base = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.1, 0.01, 0.1, undefined, { x: 0, y: -0.06, z: 0 })],
    });
    const platter = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.09, 0.006, 0.09, 2.5)],
    });
    pw.addPrismaticJoint({
      bodyA: base,
      bodyB: platter,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
      limitsM: [-0.016, 0.001],
    });
    for (let i = 0; i < 300; i++) pw.step(DT, []);
    const t = pw.transformOf(platter);
    // Free to fall along Y to its stop, pinned on X and Z.
    expect(t.p.y).toBeLessThan(1);
    expect(t.p.y).toBeGreaterThan(1 - 0.02);
    expect(Math.abs(t.p.x)).toBeLessThan(1e-4);
    expect(Math.abs(t.p.z)).toBeLessThan(1e-4);
    pw.free();
  });

  it('hangs a body from a rope that pulls but never pushes', async () => {
    const pw = await emptyWorld();
    const anchor = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 2, z: 0 },
      parts: [box(0.02, 0.02, 0.02)],
    });
    const load = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1.9, z: 0 },
      parts: [box(0.03, 0.03, 0.03, 1)],
    });
    pw.addRopeJoint({
      bodyA: anchor,
      bodyB: load,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      maxLengthM: 0.3,
    });
    for (let i = 0; i < 300; i++) pw.step(DT, []);
    const drop = 2 - pw.transformOf(load).p.y;
    // It falls to the rope's length and stops there — not further, and not held up short.
    expect(drop).toBeGreaterThan(0.28);
    expect(drop).toBeLessThan(0.33);
    pw.free();
  });

  it("drops a body's joints with it, so no handle outlives its constraint", async () => {
    const pw = await emptyWorld();
    const a = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.02, 0.02, 0.02)],
    });
    const b = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.1, 0.01, 0.01, 1)],
    });
    const j = pw.addRevoluteJoint({
      bodyA: a,
      bodyB: b,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
    });
    expect(pw.hasJoint(j)).toBe(true);
    expect(pw.jointCount).toBe(1);
    pw.remove(b);
    expect(pw.hasJoint(j)).toBe(false);
    expect(pw.jointCount).toBe(0);
    // And stepping afterwards must not touch a freed constraint.
    expect(() => pw.step(DT, [])).not.toThrow();
    pw.free();
  });

  it('leaves nothing behind when an instrument is torn down', async () => {
    const pw = await emptyWorld();
    const before = pw.bodyCount;
    const stand = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.02, 0.02, 0.02)],
    });
    const beam = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.3, 0.01, 0.01, 1.4)],
    });
    const pan = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0.3, y: 0.8, z: 0 },
      parts: [box(0.1, 0.004, 0.1, 0.3)],
    });
    pw.addRevoluteJoint({
      bodyA: stand,
      bodyB: beam,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
    });
    for (const dx of [0.01, -0.005, -0.005]) {
      pw.addRopeJoint({
        bodyA: beam,
        bodyB: pan,
        anchorA: { x: 0.3 + dx, y: 0, z: 0 },
        anchorB: { x: dx, y: 0, z: 0 },
        maxLengthM: 0.2,
      });
    }
    expect(pw.jointCount).toBe(4);
    for (const h of [pan, beam, stand]) pw.remove(h);
    expect(pw.jointCount).toBe(0);
    expect(pw.bodyCount).toBe(before);
    pw.free();
  });
});

describe('teardown', () => {
  it('leaves no joint claiming to be alive after the world is freed', async () => {
    const pw = await emptyWorld();
    const a = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.02, 0.02, 0.02)],
    });
    const b = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.1, 0.01, 0.01, 1)],
    });
    const j = pw.addRopeJoint({
      bodyA: a,
      bodyB: b,
      anchorA: { x: 0, y: 0, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      maxLengthM: 0.2,
    });
    pw.free();
    expect(pw.hasJoint(j)).toBe(false);
    expect(pw.hasBody(b)).toBe(false);
    expect(pw.jointCount).toBe(0);
  });
});

describe('torque', () => {
  it('applies for exactly one step, like force', async () => {
    /*
     * The single most expensive Rapier lesson in this project, now applied to torque:
     * `addTorque` accumulates until `resetTorques`. A balance whose pivot damping
     * compounded step after step would fight back harder the longer you watched it
     * (15 §8.2 names this failure).
     *
     * Measured as a rate: one torque applied on one step must produce the SAME angular
     * velocity change as the same torque applied on a later step. If it accumulated, the
     * second would be larger.
     */
    const pw = await emptyWorld();
    const bar = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.3, 0.01, 0.01, 2)],
    });
    // Gravity acts at the centre of mass, so it exerts no torque on a free body — the
    // angular channel is clean without doing anything about it.
    const kick = (): number => {
      const before = pw.angularVelocityOf(bar).z;
      pw.applyTorque(bar, { x: 0, y: 0, z: 1 });
      pw.step(DT, []);
      return pw.angularVelocityOf(bar).z - before;
    };
    const first = kick();
    for (let i = 0; i < 10; i++) pw.step(DT, []); // quiet steps, no torque
    const later = kick();
    // 6 places, not 9: the wasm bridge is f32, so ~1e-7 of drift is the floor. The
    // property under test is that `later` is not TWICE `first`, which is what an
    // accumulating torque would give.
    expect(later).toBeCloseTo(first, 6);
    pw.free();
  });

  it('does not spin a body on steps where no torque was applied', async () => {
    const pw = await emptyWorld();
    const bar = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 1, z: 0 },
      parts: [box(0.3, 0.01, 0.01, 2)],
    });
    pw.applyTorque(bar, { x: 0, y: 0, z: 5 });
    pw.step(DT, []);
    const spun = pw.angularVelocityOf(bar).z;
    for (let i = 0; i < 60; i++) pw.step(DT, []);
    // Coasting, not accelerating. Nothing damps it, so it keeps the velocity it got.
    expect(pw.angularVelocityOf(bar).z).toBeCloseTo(spun, 6);
    pw.free();
  });
});
