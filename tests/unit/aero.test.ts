import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { dragForceInto, speedAfterFallMps, terminalVelocityMps } from '../../src/core/aero.ts';
import type { Vec3 } from '../../src/types.ts';

const DT = config.loop.DT;
const G = config.physics.gravityMps2;

/** 16 §6.3's model, at the unit level; the integration against Rapier is D0's. */
describe('the air column', () => {
  it('reproduces the doc table of terminal velocities', () => {
    // 16 §6.3 seeds, confirmed by D0. Mass and side from the data model at the time.
    expect(terminalVelocityMps(0.00069, 0.25 * 0.0254)).toBeCloseTo(16.2, 1);
    expect(terminalVelocityMps(0.354, 2 * 0.0254)).toBeCloseTo(45.7, 1);
    expect(terminalVelocityMps(18.9, 4 * 0.0254)).toBeCloseTo(167, 0);
  });

  it('at terminal velocity, drag exactly cancels weight', () => {
    const m = 0.354;
    const s = 2 * 0.0254;
    const vt = terminalVelocityMps(m, s);
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    dragForceInto({ x: 0, y: -vt, z: 0 }, s, m, DT, out);
    expect(out.y).toBeCloseTo(m * G, 6);
  });

  it('opposes the velocity in every axis and never reverses it', () => {
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    const cases: { v: Vec3; s: number; m: number }[] = [
      { v: { x: 3, y: -19.8, z: -1 }, s: 0.0254, m: 0.044 },
      { v: { x: 0, y: -50, z: 0 }, s: 0.381, m: 0.0001 }, // absurd: must clamp hard
      { v: { x: -0.01, y: 0.02, z: 0.005 }, s: 0.1, m: 20 },
    ];
    for (const c of cases) {
      dragForceInto(c.v, c.s, c.m, DT, out);
      const speed = Math.hypot(c.v.x, c.v.y, c.v.z);
      expect(out.x * c.v.x).toBeLessThanOrEqual(0);
      expect(out.y * c.v.y).toBeLessThanOrEqual(0);
      expect(out.z * c.v.z).toBeLessThanOrEqual(0);
      const mag = Math.hypot(out.x, out.y, out.z);
      expect(mag).toBeLessThanOrEqual((c.m * speed) / DT + 1e-9);
    }
  });

  it('is zero at rest, with no NaN from the normalisation', () => {
    const out: Vec3 = { x: 1, y: 1, z: 1 };
    dragForceInto({ x: 0, y: 0, z: 0 }, 0.05, 1, DT, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('the analytic fall law approaches terminal velocity from below', () => {
    const vt = 22.9;
    expect(speedAfterFallMps(0.5, vt)).toBeLessThan(Math.sqrt(2 * G * 0.5));
    expect(speedAfterFallMps(500, vt)).toBeCloseTo(vt, 3);
    expect(speedAfterFallMps(500, vt)).toBeLessThan(vt);
  });
});
