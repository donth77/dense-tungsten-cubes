import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics.ts';
import { DT, IN } from './harness.ts';

/**
 * The sustained-force channel reads TRUE newtons.
 *
 * Rapier 0.19.3 reports a resting contact's impulse at (1 + 1/N) times the true value,
 * N being the solver iteration count — measured at exactly 1.25x for the app's N = 4,
 * and independent of mass, timestep, tolerances and contact softness. `PhysicsWorld`
 * corrects for it; this file exists so that a Rapier upgrade or a solver-setting change
 * that alters the law fails here first, rather than as a balance that quietly reads a
 * kilo cube as 1.25 kg.
 */

async function restingCube(kind: 'fixed' | 'kinematic', massKg: number) {
  const pw = await PhysicsWorld.create();
  const plate = pw.addCompound({
    kind,
    at: { x: 0, y: 0.5, z: 0 },
    parts: [
      { shape: { kind: 'box', halfExtents: { x: 0.2, y: 0.004, z: 0.2 } }, material: 'steel' },
    ],
  });
  const side = 2 * IN;
  const cube = pw.addCompound({
    kind: 'dynamic',
    at: { x: 0, y: 0.504 + side / 2 + 0.001, z: 0 },
    parts: [
      {
        shape: { kind: 'box', halfExtents: { x: side / 2, y: side / 2, z: side / 2 } },
        material: 'steel',
        massKg,
      },
    ],
  });
  for (let i = 0; i < 240; i++) {
    if (kind === 'kinematic')
      pw.setKinematicTarget(plate, { x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    pw.step(DT, []);
  }
  const mg = pw.massOf(cube) * pw.gravityMps2;
  const r = {
    mg,
    total: pw.contactForceN(plate),
    vertical: pw.contactForceAlongN(plate, { x: 0, y: 1, z: 0 }),
    onCube: pw.contactForceN(cube),
  };
  pw.free();
  return r;
}

describe('sustained contact force', () => {
  it.each([
    ['fixed', 1],
    ['fixed', 18.9],
    ['kinematic', 2.36],
  ] as const)('reads a resting cube on a %s plate at its true weight (%s kg)', async (kind, kg) => {
    const r = await restingCube(kind, kg);
    // Inside 0.5 % — the residual is the solver's own resting jitter, not the factor.
    expect(r.total / r.mg).toBeCloseTo(1, 2);
    expect(r.vertical / r.mg).toBeCloseTo(1, 2);
    // Newton's third law, as seen from the other body.
    expect(r.onCube / r.mg).toBeCloseTo(1, 2);
  });

  it('projects onto the axis it is asked for, and nothing else', async () => {
    // A resting cube's contact is purely vertical: all of it along Y, none along X.
    const r = await restingCube('fixed', 2);
    expect(r.vertical / r.mg).toBeCloseTo(1, 2);
    const pw = await PhysicsWorld.create();
    const plate = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 0.5, z: 0 },
      parts: [
        { shape: { kind: 'box', halfExtents: { x: 0.2, y: 0.004, z: 0.2 } }, material: 'steel' },
      ],
    });
    const side = 2 * IN;
    pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 0.504 + side / 2 + 0.001, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: side / 2, y: side / 2, z: side / 2 } },
          material: 'steel',
          massKg: 2,
        },
      ],
    });
    for (let i = 0; i < 240; i++) pw.step(DT, []);
    expect(pw.contactForceAlongN(plate, { x: 1, y: 0, z: 0 })).toBeLessThan(0.05);
    pw.free();
  });
});
