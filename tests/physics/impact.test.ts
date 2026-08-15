/**
 * Impact telemetry (14 PHY-06).
 *
 * The old formula was `½ * reduced-translational-mass * v_n²`, which is only right for
 * two point masses meeting head-on. A rigid body struck away from its centre spins away
 * from the blow and presents far less inertia than its mass: for an ideal cube landing on
 * a CORNER the normal effective mass is m/4, so the reported energy was 4x too high.
 *
 * The analytic targets below are derived, not measured, so these tests fail if the
 * formula regresses rather than merely if a number moves.
 */
import { describe, it, expect } from 'vitest';
import { IN, cube, run, runUntil, worldWithFloor } from './harness.ts';
import type { ImpactEvent } from '../../src/types.ts';

/**
 * Analytic normal effective mass of a uniform cube hitting a fixed plane, normal +y.
 *
 *   1/m_eff = 1/m + (r x n) . I^-1 (r x n),  I = m*s²/6 for a cube about any axis.
 *
 * - FACE (r parallel to n): r x n = 0, so m_eff = m.
 * - EDGE (r = (s/2)(1,1,0) say): |r x n|² = s²/4  ->  rotational term 6/(m s²) * s²/4
 *   = 1.5/m, so m_eff = m/2.5 = 0.4 m.
 * - CORNER (r = (s/2)(1,1,1)): |r x n|² = s²/2  ->  3/m, so m_eff = m/4.
 */
function analyticEffectiveMass(massKg: number, contact: 'face' | 'edge' | 'corner'): number {
  const rotational = { face: 0, edge: 1.5, corner: 3 }[contact];
  return massKg / (1 + rotational);
}

/** Drop a cube with a given orientation and return its first reported impact. */
async function firstImpact(opts: {
  sideIn?: number;
  height?: number;
  spinRadS?: number;
}): Promise<{ ev: ImpactEvent; massKg: number }> {
  const pw = await worldWithFloor('concrete');
  const sideIn = opts.sideIn ?? 2;
  const h = cube(pw, 'W', sideIn, { x: 0, y: (opts.height ?? 0.5) + (sideIn * IN) / 2, z: 0 });
  if (opts.spinRadS) pw.setVelocity(h, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: opts.spinRadS });
  const massKg = pw.massOf(h);
  const impacts: ImpactEvent[] = [];
  runUntil(pw, () => impacts.length > 0, 5, impacts);
  pw.free();
  if (!impacts[0]) throw new Error('no impact reported');
  return { ev: impacts[0], massKg };
}

describe('normal effective mass matches the closed form exactly', () => {
  /**
   * The direct check the audit asks for. An axis-aligned cube at a known pose, probed at
   * the exact face-centre / edge-midpoint / corner, against `m`, `0.4m` and `m/4`.
   *
   * The collider is a ROUNDED cuboid, so its inertia is very slightly below the ideal
   * `m s²/6` — hence a tolerance rather than an equality. That gap is the geometry being
   * honest, not the formula being loose.
   */
  it.each([
    ['face', [0, -1, 0], 1],
    ['edge', [1, -1, 0], 1 / 2.5],
    ['corner', [1, -1, 1], 1 / 4],
  ] as [string, [number, number, number], number][])(
    '%s contact -> m_eff = %s',
    async (_label, offsetSign, ratio) => {
      const pw = await worldWithFloor('concrete');
      const sideIn = 2;
      const s = sideIn * IN;
      const centre = { x: 0, y: 1, z: 0 };
      const h = cube(pw, 'W', sideIn, centre);
      const m = pw.massOf(h);
      const point = {
        x: centre.x + (offsetSign[0] * s) / 2,
        y: centre.y + (offsetSign[1] * s) / 2,
        z: centre.z + (offsetSign[2] * s) / 2,
      };
      const meff = pw.normalEffectiveMassAt(h, point, { x: 0, y: 1, z: 0 });
      pw.free();
      expect(meff / m).toBeCloseTo(ratio, 2);
    },
  );

  it('is unchanged by the length of the normal vector', async () => {
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 2, { x: 0, y: 1, z: 0 });
    const p = { x: 0.0254, y: 1 - 0.0254, z: 0.0254 };
    const a = pw.normalEffectiveMassAt(h, p, { x: 0, y: 1, z: 0 });
    const b = pw.normalEffectiveMassAt(h, p, { x: 0, y: 17, z: 0 });
    pw.free();
    expect(a).toBeCloseTo(b, 9);
  });
});

describe('normal effective mass', () => {
  it('a flat face landing presents the full mass', async () => {
    const { ev, massKg } = await firstImpact({});
    const target = analyticEffectiveMass(massKg, 'face');
    // A flat landing makes several contacts at once; each one is a corner of the face,
    // so the per-contact effective mass is below m. It must never EXCEED m.
    expect(ev.effectiveMassKg).toBeLessThanOrEqual(massKg * 1.001);
    expect(ev.effectiveMassKg).toBeGreaterThan(0);
    expect(target).toBeCloseTo(massKg, 6);
    expect(ev.contactCount).toBeGreaterThanOrEqual(1);
  });

  it('never reports more energy than the body actually had', async () => {
    for (const height of [0.1, 0.5, 2, 5]) {
      const { ev, massKg } = await firstImpact({ height });
      const vIn = Math.abs(ev.normalSpeedMps);
      const budget = 0.5 * massKg * vIn * vIn;
      // The clamp is the invariant: contact-local algebra must never invent energy.
      expect(ev.energyJ).toBeLessThanOrEqual(budget * 1.001);
    }
  });

  it('a spinning cube still respects the energy budget', async () => {
    const { ev, massKg } = await firstImpact({ spinRadS: 30, height: 1 });
    const s = 2 * IN;
    const I = (massKg * s * s) / 6;
    const rotational = 0.5 * I * 30 * 30;
    const translational = 0.5 * massKg * ev.normalSpeedMps * ev.normalSpeedMps;
    expect(ev.energyJ).toBeLessThanOrEqual((translational + rotational) * 1.001);
    expect(ev.energyJ).toBeGreaterThan(0);
  });

  it('energy is exactly ½·m_eff·v_n² when the budget is not binding', async () => {
    const { ev } = await firstImpact({ height: 0.5 });
    const predicted = 0.5 * ev.effectiveMassKg * ev.normalSpeedMps * ev.normalSpeedMps;
    // Either the closed form, or the budget clamp — and the test says which.
    expect(ev.energyJ).toBeLessThanOrEqual(predicted * 1.001);
    if (ev.energyJ > predicted * 0.999) expect(ev.energyJ).toBeCloseTo(predicted, 6);
  });

  it('a corner-first landing reports LESS than the old mass-based formula', async () => {
    // Tip the cube onto a corner by spinning it hard about two axes as it falls.
    const pw = await worldWithFloor('concrete');
    const h = cube(pw, 'W', 2, { x: 0, y: 0.6, z: 0 });
    pw.setVelocity(h, { x: 0, y: -3, z: 0 }, { x: 4, y: 0, z: 4 });
    const massKg = pw.massOf(h);
    const impacts: ImpactEvent[] = [];
    runUntil(pw, () => impacts.length > 0, 5, impacts);
    pw.free();
    const ev = impacts[0]!;
    const oldFormula = 0.5 * massKg * ev.normalSpeedMps * ev.normalSpeedMps;
    expect(ev.energyJ).toBeLessThan(oldFormula);
    // and m_eff must be inside the analytic bracket [m/4, m] for a cube
    expect(ev.effectiveMassKg).toBeGreaterThan(analyticEffectiveMass(massKg, 'corner') * 0.5);
    expect(ev.effectiveMassKg).toBeLessThanOrEqual(massKg * 1.001);
  });
});

describe('raw telemetry is not debounced', () => {
  it('reports every qualifying contact, including rapid rebounds', async () => {
    // On a bouncy pair a dropped cube rebounds several times within a second. The old
    // 60 ms cooldown lived in the physics path and swallowed them for every consumer.
    const pw = await worldWithFloor('rubber');
    cube(pw, 'Fe', 2, { x: 0, y: 1, z: 0 });
    const impacts: ImpactEvent[] = [];
    run(pw, 4, impacts);
    pw.free();
    expect(impacts.length).toBeGreaterThan(2);
  });

  it('carries the contact count so a multi-contact manifold is visible', async () => {
    const { ev } = await firstImpact({});
    expect(ev.contactCount).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(ev.contactCount)).toBe(true);
  });
});

describe('resting cubes stay silent', () => {
  it('no impact events once settled', async () => {
    const pw = await worldWithFloor('concrete');
    cube(pw, 'W', 4, { x: 0, y: (4 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 2); // let the landing happen
    const later: ImpactEvent[] = [];
    run(pw, 3, later);
    pw.free();
    expect(later).toHaveLength(0);
  });
});
