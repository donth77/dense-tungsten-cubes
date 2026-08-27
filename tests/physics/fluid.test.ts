import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import type { PhysicsWorld } from '../../src/core/physics.ts';
import {
  fluidForces,
  makeFluidForces,
  stepVelocityQuantum,
  terminalSinkMps,
} from '../../src/core/fluid.ts';
import { FLUIDS, floatFraction } from '../../src/data/fluids.ts';
import { cubeMassKg, densityOf, whaDensity } from '../../src/data/metals.ts';
import type { BodyHandle, FluidId, ImpactEvent, MetalId } from '../../src/types.ts';
import { DT, IN, emptyWorld } from './harness.ts';

/**
 * Stage F0 — the buoyancy spike (19 §6).
 *
 * The tank's numbers were published in 02 §6 long before this code existed, so the bar
 * here is not "does it look like it floats" — it is that the SHIPPING model, stepped by
 * the real solver, reproduces figures nobody tuned it to hit. Everything runs through
 * the facade; the fluid itself is pure functions applied in the same place the lab will
 * apply them.
 */

/** The surface plane. Cubes start below it, so there is no entry transient to wait out. */
const SURFACE_Y = 0;
const forces = makeFluidForces();

interface Sank {
  vMps: number;
  steps: number;
}

/**
 * Step a lone cube through a fluid, applying buoyancy at the centre of buoyancy and
 * resistance at the centre of mass — exactly the order the lab will use.
 */
function swim(
  pw: PhysicsWorld,
  h: BodyHandle,
  sideM: number,
  massKg: number,
  fluid: FluidId,
  seconds: number,
): void {
  const n = Math.round(seconds / DT);
  const scratch: ImpactEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = pw.transformOf(h);
    const v = pw.velocityOf(h);
    const w = pw.angularVelocityOf(h);
    fluidForces(fluid, sideM, massKg, t.p, t.q, v, w, SURFACE_Y, DT, forces);
    if (forces.frac > 0) {
      pw.applyForceAtPoint(h, { x: 0, y: forces.buoyN, z: 0 }, forces.centre);
      pw.applyForce(h, forces.resistN);
      pw.applyForce(h, forces.inertiaN);
      pw.applyTorque(h, forces.torqueNm);
    }
    pw.setLinearDamping(h, forces.dampingPerS);
    scratch.length = 0;
    pw.step(DT, scratch);
  }
}

async function sinkSpeed(
  metal: MetalId,
  sideIn: number,
  fluid: FluidId,
  purity = 95,
): Promise<Sank> {
  const pw = await emptyWorld();
  const sideM = sideIn * IN;
  const massKg = cubeMassKg(metal, sideM, purity);
  // Deep enough to be fully submerged for the whole run, in an empty world with no floor.
  const h = pw.addCube({ metal, sideM, purityPctW: purity }, { x: 0, y: -40, z: 0 });
  swim(pw, h, sideM, massKg, fluid, 6);
  return { vMps: Math.abs(pw.velocityOf(h).y), steps: Math.round(6 / DT) };
}

async function restFraction(metal: MetalId, sideIn: number, fluid: FluidId): Promise<number> {
  const pw = await emptyWorld();
  const sideM = sideIn * IN;
  const massKg = cubeMassKg(metal, sideM);
  // Born straddling the surface so it settles from a plausible pose, not a contrived one.
  const h = pw.addCube({ metal, sideM, purityPctW: 95 }, { x: 0, y: sideM / 2, z: 0 });
  swim(pw, h, sideM, massKg, fluid, 12);
  const t = pw.transformOf(h);
  const v = pw.velocityOf(h);
  const w = pw.angularVelocityOf(h);
  fluidForces(fluid, sideM, massKg, t.p, t.q, v, w, SURFACE_Y, DT, forces);
  return forces.frac;
}

/** Peak |vy| over the last second of a 25 s settle, with damping scaled by `dampScale`. */
async function peakResidual(
  metal: MetalId,
  sideIn: number,
  fluid: FluidId,
  dampScale: number,
): Promise<number> {
  const pw = await emptyWorld();
  const sideM = sideIn * IN;
  const massKg = cubeMassKg(metal, sideM);
  const h = pw.addCube({ metal, sideM, purityPctW: 95 }, { x: 0, y: sideM / 2, z: 0 });
  const scratch: ImpactEvent[] = [];
  const n = Math.round(25 / DT);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = pw.transformOf(h);
    const v = pw.velocityOf(h);
    const w = pw.angularVelocityOf(h);
    fluidForces(fluid, sideM, massKg, t.p, t.q, v, w, SURFACE_Y, DT, forces);
    if (forces.frac > 0) {
      pw.applyForceAtPoint(h, { x: 0, y: forces.buoyN, z: 0 }, forces.centre);
      pw.applyForce(h, forces.resistN);
      pw.applyForce(h, forces.inertiaN);
      pw.applyTorque(h, forces.torqueNm);
    }
    pw.setLinearDamping(h, forces.dampingPerS * dampScale);
    scratch.length = 0;
    pw.step(DT, scratch);
    if (i > n - 60) peak = Math.max(peak, Math.abs(pw.velocityOf(h).y));
  }
  return peak;
}

describe('F0.1 water terminal velocities reproduce 02 §6', () => {
  /* 02 §6 published these for 2" cubes before any of this code was written. */
  const PUBLISHED: readonly (readonly [MetalId, number])[] = [
    ['Al', 1.3],
    ['Ti', 1.8],
    ['Fe', 2.6],
    ['Cu', 2.8],
    ['W', 4.0],
  ];

  for (const [metal, published] of PUBLISHED) {
    it(`${metal} sinks at ~${published} m/s`, async () => {
      const { vMps } = await sinkSpeed(metal, 2, 'water');
      expect(vMps).toBeGreaterThan(published * 0.95);
      expect(vMps).toBeLessThan(published * 1.05);
    });
  }
});

describe('F0.2 mercury float fractions are rho_c / rho_f, not a table', () => {
  /* 02 §6: aluminium, titanium, iron and copper all float, at these depths. */
  const PUBLISHED: readonly (readonly [MetalId, number])[] = [
    ['Al', 0.2],
    ['Ti', 0.33],
    ['Fe', 0.58],
    ['Cu', 0.66],
  ];

  for (const [metal, published] of PUBLISHED) {
    it(`${metal} rides at ~${Math.round(published * 100)} % submerged`, async () => {
      // The law, stated independently of the sim.
      expect(floatFraction(densityOf(metal), 'mercury')).toBeCloseTo(published, 2);
      // And the sim, which was never told the answer.
      const frac = await restFraction(metal, 2, 'mercury');
      expect(frac).toBeGreaterThan(published - 0.06);
      expect(frac).toBeLessThan(published + 0.06);
    });
  }

  it('tungsten does not float in mercury', () => {
    expect(floatFraction(whaDensity(95), 'mercury')).toBeNull();
  });
});

describe('F0.3 the gold/tungsten separation — 19 §2.2', () => {
  /*
   * 02 §6 says "tungsten alone sinks" in mercury. It is wrong: gold is 19,320 kg/m3,
   * above the W-Ni-Fe alloy's 17,000-18,500, so gold sinks too and FASTER. This is the
   * one place in the toy where the gold-plated-tungsten fraud becomes visible, so it is
   * pinned here rather than left as a comment in a design doc.
   */
  it('gold sinks in mercury, and outruns W95', async () => {
    const au = await sinkSpeed('Au', 2, 'mercury');
    const w95 = await sinkSpeed('W', 2, 'mercury', 95);
    expect(au.vMps).toBeGreaterThan(w95.vMps);
    expect(au.vMps).toBeCloseTo(0.637, 1);
    expect(w95.vMps).toBeCloseTo(0.56, 1);
  });

  it('mercury widens the 7 % density gap into a 30 % driving-force gap', () => {
    const rho = FLUIDS.mercury.densityKgM3;
    const au = densityOf('Au');
    const w95 = whaDensity(95);
    const raw = au / w95 - 1;
    const net = (au - rho) / (w95 - rho) - 1;
    expect(raw).toBeCloseTo(0.073, 2);
    expect(net).toBeCloseTo(0.296, 2);
    expect(net / raw).toBeGreaterThan(3.5);
  });

  it('the finish is readable across a 40 cm tank', () => {
    const au = terminalSinkMps(densityOf('Au'), 2 * IN, 'mercury')!;
    const w95 = terminalSinkMps(whaDensity(95), 2 * IN, 'mercury')!;
    const depth = 0.4;
    const lead = depth - w95 * (depth / au);
    // 19 §3 sets the tank's minimum depth off this number; below ~40 cm it is a tie.
    expect(lead).toBeGreaterThan(0.04);
  });

  it('the purity slider shows up in the tank', async () => {
    const w90 = await sinkSpeed('W', 2, 'mercury', 90);
    const w97 = await sinkSpeed('W', 2, 'mercury', 97);
    expect(w97.vMps).toBeGreaterThan(w90.vMps);
    expect(w90.vMps).toBeCloseTo(0.493, 1);
    expect(w97.vMps).toBeCloseTo(0.59, 1);
  });
});

describe('F0.4 stability — the stiffest spring in the toy', () => {
  /*
   * Buoyancy is a spring in depth (k = rho_f * g * A), and 14/W2's rule is that a
   * hand-applied spring needs sqrt(k/m)*dt < 2. The worst case in the size row is the
   * smallest cube in the densest fluid: 0.25" aluminium in mercury, at omega*dt = 1.47.
   * Inside the limit, but close enough that it is the first thing that will jitter.
   */
  it('the analytic worst case is inside the limit, and known', () => {
    const sideM = 0.25 * IN;
    const k = FLUIDS.mercury.densityKgM3 * config.physics.gravityMps2 * sideM * sideM;
    const m = cubeMassKg('Al', sideM);
    const omegaDt = Math.sqrt(k / m) * DT;
    expect(omegaDt).toBeGreaterThan(1.4);
    expect(omegaDt).toBeLessThan(2);
  });

  it('the small-cube residual is a discretisation floor, not a damping shortfall', async () => {
    /*
     * 19 §2.4 predicted this case would be the first to misbehave, and it was — but for
     * the wrong reason, and the wrong fix. Buoyancy near the surface is a saturating
     * ramp, not a spring: a cube oscillating further than its own height is fully wet
     * one step and fully dry the next, which is a bang-bang system with a limit cycle
     * that damping cannot reach.
     *
     * This pins the DIAGNOSIS, because that is what stops the next person reaching for a
     * bigger damping constant: the residual sits at a small multiple of one step's
     * velocity quantum, and does not respond to damping.
     */
    const quantum = stepVelocityQuantum(densityOf('Al'), 'mercury', DT);
    expect(quantum).toBeCloseTo(0.15, 2);

    const residual = await peakResidual('Al', 0.25, 'mercury', 1);
    expect(residual).toBeGreaterThan(quantum);
    expect(residual).toBeLessThan(4 * quantum);

    // Triple the damping; the floor barely moves. A damping problem would collapse.
    const damped = await peakResidual('Al', 0.25, 'mercury', 3);
    expect(Math.abs(damped - residual)).toBeLessThan(0.5 * residual);
  });

  it('the 2 in cubes the lab actually stages do settle, to three decimals', async () => {
    // The same code, one size up: no residual worth a readout. The floor is small-cube only.
    for (const metal of ['Al', 'Ti', 'Cu'] as MetalId[]) {
      expect(await peakResidual(metal, 2, 'mercury', 1)).toBeLessThan(0.01);
    }
  });

  it('a floating cube comes to rest', async () => {
    const pw = await emptyWorld();
    const sideM = 2 * IN;
    const massKg = cubeMassKg('Al', sideM);
    const h = pw.addCube({ metal: 'Al', sideM, purityPctW: 95 }, { x: 0, y: sideM / 2, z: 0 });
    swim(pw, h, sideM, massKg, 'mercury', 12);
    expect(Math.abs(pw.velocityOf(h).y)).toBeLessThan(0.05);
  });
});

describe('F0.5 honey — does the viscous term tune at 60 Hz? (19 §7.2)', () => {
  it('honey is the only fluid where the viscous term leads', () => {
    const sideM = 2 * IN;
    const v = 0.5;
    const quad = (id: FluidId) => 0.5 * FLUIDS[id].densityKgM3 * 1.05 * sideM * sideM * v * v;
    const visc = (id: FluidId) => 3 * Math.PI * FLUIDS[id].viscosityPaS * sideM * v;
    expect(visc('water') / quad('water')).toBeLessThan(0.01);
    expect(visc('mercury') / quad('mercury')).toBeLessThan(0.01);
    expect(visc('honey') / quad('honey')).toBeGreaterThan(0.5);
  });

  it('a tungsten cube still sinks through honey, slowly', async () => {
    const { vMps } = await sinkSpeed('W', 2, 'honey');
    expect(vMps).toBeGreaterThan(0.5);
    expect(vMps).toBeLessThan(4);
  });

  it('nothing in the roster floats in honey — or in water', () => {
    /*
     * Worth pinning because it is the shape of the whole lab: the lightest metal here is
     * aluminium at 2,700 kg/m3, above honey's 1,420 and water's 998. Mercury is the ONLY
     * fluid that floats anything, which is exactly why it is the punchline and not just
     * the third option.
     */
    for (const metal of ['Al', 'Ti', 'Fe', 'Cu', 'Au'] as MetalId[]) {
      expect(floatFraction(densityOf(metal), 'honey')).toBeNull();
      expect(floatFraction(densityOf(metal), 'water')).toBeNull();
    }
    expect(floatFraction(densityOf('Al'), 'mercury')).not.toBeNull();
  });
});
