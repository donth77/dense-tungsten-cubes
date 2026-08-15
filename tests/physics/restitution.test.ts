/**
 * Restitution calibration (14 PHY-02).
 *
 * Before the fix, `min`/`max` combine rules collapsed concrete, steel and oak to the SAME
 * measured bounce for a tungsten cube — 0.1838 / 0.1823 / 0.1816 against configured
 * values of 0.45 / 0.60 / 0.40 — because the cube's own `min` rule and its 0.2 always
 * won. The separable `Multiply` model in `data/contact.ts` cannot collapse: it is
 * strictly monotonic in both members.
 *
 * What this file does NOT assert: that any particular pair CoR is the physically correct
 * one for that material pair. Choosing those numbers needs a calibration dataset, which
 * is an open product decision recorded in `docs/14`. What it asserts is that the SOLVER
 * reproduces the model the data declares, and that the model has the properties the
 * product depends on.
 */
import { describe, it, expect } from 'vitest';
import { SURFACES } from '../../src/data/surfaces.ts';
import { METALS } from '../../src/data/metals.ts';
import { pairRestitution } from '../../src/data/contact.ts';
import type { MetalId, SurfaceId } from '../../src/types.ts';
import { IN, cube, measureRestitution, worldWithFloor } from './harness.ts';

const SURFACE_IDS = Object.keys(SURFACES) as SurfaceId[];
const METAL_IDS = Object.keys(METALS) as MetalId[];

/**
 * Absolute tolerance on e. 14 §9 proposes 0.03; the solver's own bias for a flat-face
 * landing is a few percent of e, so 0.03 holds across the whole table at drop speed.
 */
const TOL = 0.03;

/** Drop a 1" cube from `height` above the floor and read its first rebound. */
async function drop(
  metal: MetalId,
  surface: SurfaceId,
  height = 0.5,
  sideIn = 1,
): Promise<{ e: number; vIn: number }> {
  const pw = await worldWithFloor(surface);
  const h = cube(pw, metal, sideIn, { x: 0, y: height + (sideIn * IN) / 2, z: 0 });
  const r = measureRestitution(pw, h);
  pw.free();
  return r;
}

describe('rebound matches the modelled pair restitution', () => {
  it.each(SURFACE_IDS)('W95 on %s', async (surface) => {
    const { e } = await drop('W', surface);
    const target = pairRestitution(METALS.W.restitution, SURFACES[surface].restitution);
    expect(Math.abs(e - target)).toBeLessThan(TOL);
  });

  it.each<[MetalId, SurfaceId]>([
    ['Fe', 'steel'],
    ['Fe', 'concrete'],
    ['Fe', 'rubber'],
    ['Al', 'oak'],
    ['Au', 'concrete'],
    ['Ti', 'ice'],
    ['Cu', 'foam'],
  ])('%s on %s', async (metal, surface) => {
    const { e } = await drop(metal, surface);
    const target = pairRestitution(METALS[metal].restitution, SURFACES[surface].restitution);
    expect(Math.abs(e - target)).toBeLessThan(TOL);
  });
});

describe('the properties the product depends on', () => {
  it('concrete, steel and oak no longer collapse to one bounce', async () => {
    const c = (await drop('W', 'concrete')).e;
    const s = (await drop('W', 'steel')).e;
    const o = (await drop('W', 'oak')).e;
    // Pre-fix these were 0.1838 / 0.1823 / 0.1816 — a 1.2 % spread, i.e. the same thing
    // three times. The model orders them by the surface's own coefficient.
    expect(s).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(o);
    expect((s - o) / o).toBeGreaterThan(0.3);
  });

  it('is monotonic in the metal for a fixed surface', async () => {
    const ordered = [...METAL_IDS].sort((a, b) => METALS[a].restitution - METALS[b].restitution);
    const measured: number[] = [];
    for (const m of ordered) measured.push((await drop(m, 'concrete')).e);
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i]!).toBeGreaterThanOrEqual(measured[i - 1]! - TOL);
    }
    // and the ends must be clearly apart, not merely ordered
    expect(measured.at(-1)!).toBeGreaterThan(measured[0]! * 2);
  });

  it('never returns more energy than it received, on any pair', async () => {
    for (const metal of METAL_IDS) {
      for (const surface of SURFACE_IDS) {
        const target = pairRestitution(METALS[metal].restitution, SURFACES[surface].restitution);
        expect(target).toBeLessThanOrEqual(1);
        expect(target).toBeGreaterThan(0);
      }
    }
    // The bounciest pair in the whole table, measured rather than reasoned about.
    const { e } = await drop('Fe', 'rubber');
    expect(e).toBeLessThan(1);
  });

  it('is speed-INDEPENDENT above 1.5 m/s — a declared limitation, not an accident', async () => {
    // Rapier's restitution is a constant. `docs/02 §5` used to claim the code applied a
    // speed-scaled falloff; it never did, and the claim has been removed rather than
    // faked. This test pins the real behaviour so it cannot quietly come back without an
    // implementation behind it.
    const target = pairRestitution(METALS.Fe.restitution, SURFACES.steel.restitution);
    // Slightly wider than the drop-test gate: across 1.8–10.8 m/s the worst point is
    // +0.030 at 7.5 m/s, where which step the rebound lands in starts to matter. Measured
    // spread, quoted rather than rounded down.
    const SPEED_TOL = 0.035;
    for (const height of [0.15, 0.5, 1.5, 3.0, 6.0]) {
      const { e, vIn } = await drop('Fe', 'steel', height);
      expect(vIn).toBeGreaterThan(1.5);
      expect(Math.abs(e - target)).toBeLessThan(SPEED_TOL);
    }
  });

  it('reads LOW below ~1.5 m/s, and that floor is measured rather than hidden', async () => {
    /*
     * The honest edge of the calibration. 14 §9 proposes a ±0.03 gate at 0.5 and 1 m/s;
     * this engine and this timestep cannot meet it there, and pretending otherwise would
     * be exactly the kind of unearned claim the audit is about.
     *
     * Cause: the rebound speed at those approaches is the same order as the velocity
     * gravity adds inside a single step, g*dt = 0.163 m/s. Whatever the solver returns is
     * measured one step later with that already subtracted, so `e` reads low. It is a
     * fixed-timestep artifact, not a material property, and it disappears above ~1.5 m/s.
     */
    const target = pairRestitution(METALS.Fe.restitution, SURFACES.steel.restitution);
    const { e, vIn } = await drop('Fe', 'steel', 0.05);
    expect(vIn).toBeLessThan(1.5);
    expect(e).toBeLessThan(target); // low, not high — energy is never created
    expect(target - e).toBeGreaterThan(TOL); // and outside the gate, on the record
    expect(e).toBeGreaterThan(0.35); // but not collapsed to nothing either
  });

  it('does not depend on cube size', async () => {
    const small = (await drop('W', 'concrete', 0.5, 0.25)).e;
    const large = (await drop('W', 'concrete', 0.5, 4)).e;
    expect(Math.abs(small - large)).toBeLessThan(TOL);
  });
});
