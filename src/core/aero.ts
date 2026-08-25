import { config } from '../config.ts';
import type { Vec3 } from '../types.ts';

/**
 * The air column (16 §6.3) — quadratic drag on a level cube, and nothing more.
 *
 * Pure functions: the Drop lab applies the force in `beforePhysics` from the previous
 * step's velocity, the tests integrate the same expressions, and D0 measured the
 * combination against the analytic law within 0.11 % over the whole envelope. The
 * Fluid Tank (M4) reuses these with `rho` for its liquid instead of air.
 *
 * Two honesty limits, stated where the numbers are made: the reference area is the
 * face-on `s²` — the winch carries cubes level, and tumbling is out of scope (16
 * §2.2) — and the impulse clamp means drag can stop a body but can never reverse it,
 * which is what keeps the lightest cube stable at any speed the clamp allows.
 */

const RHO = config.aero.rhoAirKgM3;
const CD = config.aero.cdFaceOn;

export function terminalVelocityMps(massKg: number, sideM: number): number {
  return Math.sqrt((2 * massKg * config.physics.gravityMps2) / (RHO * CD * sideM * sideM));
}

/** Analytic speed after falling `hM` from rest — the tests' reference, never a readout. */
export function speedAfterFallMps(hM: number, vtMps: number): number {
  return vtMps * Math.sqrt(1 - Math.exp((-2 * config.physics.gravityMps2 * hM) / (vtMps * vtMps)));
}

/**
 * The drag force for one fixed step, written into `out`. Opposes the velocity;
 * impulse-clamped so `|F|·dt ≤ m·|v|` — it can null a step's motion, never invert it.
 */
export function dragForceInto(v: Vec3, sideM: number, massKg: number, dt: number, out: Vec3): Vec3 {
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  let mag = 0.5 * RHO * CD * sideM * sideM * speed * speed;
  const maxMag = (massKg * speed) / dt;
  if (mag > maxMag) mag = maxMag;
  const f = -mag / speed; // per unit of velocity component
  out.x = f * v.x;
  out.y = f * v.y;
  out.z = f * v.z;
  return out;
}
