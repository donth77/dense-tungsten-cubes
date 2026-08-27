import { config } from '../config.ts';
import { FLUIDS } from '../data/fluids.ts';
import type { FluidId, Quat, Vec3 } from '../types.ts';

/**
 * The tank's force model (19 §2) — buoyancy, orientation-aware quadratic drag, and the
 * linear viscous term that only wakes up in honey.
 *
 * Pure functions, exactly like `aero.ts` next door, which anticipated this file: the
 * lab applies these in `beforePhysics` from the previous step's pose, and the tests
 * integrate the same expressions. `aero.ts` stays as it is — its face-on `s²`
 * simplification is CORRECT for the winch, which carries cubes level. In the tank a
 * cube rolls and tumbles, so this file has to earn the orientation terms it skips.
 *
 * Three deliberate limits, stated where the numbers are made (19 §2.5): the surface is
 * a fixed plane and cannot be pushed, the cube does not raise the level it displaces,
 * and added mass is not modelled.
 */

const G = config.physics.gravityMps2;

/** 02's two published cube anchors. Everything between them is interpolated. */
const CD_FACE_ON = config.aero.cdFaceOn; // 1.05, shared with the air column
const CD_EDGE_ON = 0.8;

/**
 * Added-mass coefficient for a cube.
 *
 * A body accelerating through a fluid has to shove fluid out of its way, so it responds
 * as though it were heavier by `C_a * rho_f * V_submerged`. The textbook value for a
 * sphere is 0.50; a cube is blunter, and 0.67 is the usual working figure.
 *
 * 19 §2.5 declared this out of scope. F0 measured, and it is not: for aluminium in
 * mercury the entrained fluid is **3.4x the cube's own mass**, which makes it the
 * dominant term in exactly the case the lab is built around — the mercury line-up.
 * Without it a 0.25" cube bobs forever, because mercury's viscosity is too low to damp
 * it and the cube spends half its time in air where nothing damps it at all.
 *
 * It costs nothing in fidelity to the published numbers: added mass cannot move an
 * equilibrium or a terminal velocity (both are zero-net-force states, and this scales
 * net force), so 02 §6's figures are untouched. It only slows the approach — which is
 * the whole problem.
 */
const ADDED_MASS_COEFF = 0.67;

/**
 * Angular drag coefficient, `tau = K * rho_f * s^5 * omega^2`, derived rather than tuned.
 *
 * Take a cube spinning about an axis through its centre parallel to one edge. The four
 * faces parallel to that axis do the work; a strip of one face at distance `z` from the
 * axis meets the fluid at `omega*z`, so its torque contribution is
 *
 *   INT INT  1/2 * rho * Cd * (omega*z)^2 * |z|  dy dz   over  [-s/2, s/2]^2
 *     =  1/2 * rho * Cd * omega^2 * s * 2 * (s/2)^4 / 4   =  rho * Cd * omega^2 * s^5 / 64
 *
 * and four such faces give `Cd/16`. The faces perpendicular to the axis contribute only
 * shear and are dropped, which is why this is a floor on the real value, not a fit.
 *
 * 02 §6 lists angular damping as the fourth term of the model. F0 left it out and paid
 * for it: with no resistive torque a floating cube spun up from rest to 9 rad/s and the
 * whole tank sat in a permanent limit cycle that looked exactly like a stiff-spring
 * instability (2026-08-26).
 */
const ANG_DRAG_COEFF = CD_FACE_ON / 16;

/**
 * Peak implicit linear damping, in s^-1, for a body straddling the surface.
 *
 * WHY THIS EXISTS. F0 measured the bob of a floating cube and found it plateaus at a
 * fixed amplitude instead of decaying: with the buoyant force evaluated at the START of
 * a step, a cube that crosses the surface DURING that step is pushed with the wrong
 * force for part of it, and that error feeds the oscillation a little energy every
 * cycle. Real terms cannot remove it — added mass and angular drag each cut the
 * amplitude and neither kills it — because the source is the 60 Hz discretisation, not
 * the model. It is also under-dissipated on the physics: vortex shedding and surface
 * waves both carry energy away from a real bobbing cube and neither is simulated.
 *
 * WHY THE SHAPE. Damping is `D * nearSurface * (1 - frac)` — gated on PROXIMITY to the
 * surface rather than on submersion, because every effect it stands in for is a surface
 * effect. That shape is not cosmetic; it is what keeps this honest:
 *
 *   - A SINKING cube is fully submerged, `frac = 1`, so `(1 - frac)` is EXACTLY ZERO and
 *     02 §6's terminal velocities are untouched. This matters: flat damping at this
 *     strength would have cost a sinking W95 cube 87 % of its driving force in water and
 *     quietly falsified every published number in the lab.
 *   - A FLOATING cube rides at `frac = rho_c / rho_f` with its shoulders out, so it is
 *     damped and settles.
 *   - A cube that POPS CLEAR of the surface is still damped, and it has to be. Aluminium
 *     floats at 20 % in mercury, so the smallest nudge lifts it out — and a `frac`-gated
 *     rule gives an airborne cube exactly zero dissipation, making the hop a lossless
 *     ballistic arc that re-enters at the speed it left. Measured: Ti and Cu decayed to
 *     0.000 m/s while Al sat on 0.368 m/s forever (F0, 2026-08-26).
 *   - A cube thrown CLEAR of the tank leaves the band and is untouched, so nothing
 *     mysteriously slows down in mid-air.
 *
 * WHY 6. Swept, not guessed. At 6 every 2" cube settles onto its published depth to
 * three decimals (Al 0.200, Ti 0.333, Fe 0.581, Cu 0.660 against 0.20 / 0.33 / 0.58 /
 * 0.66) with a residual under 0.004 m/s. Below 6 the heavier floaters plateau; above it
 * nothing improves, because what is left is not a damping problem — see
 * `stepVelocityQuantum` for the floor that no value of D can reach.
 *
 * Rapier applies linear damping implicitly, so unlike a hand-applied spring it cannot
 * destabilise at any strength — 14/W2's lesson, and the reason this is the lever the
 * plan named before any of it was written.
 */
const SURFACE_DAMPING_PER_S = 6;

/** Half-width of the damped band around the surface, in cube side-lengths. */
const SURFACE_BAND_SIDES = 2;

/**
 * Samples per axis for the submerged-volume lattice — 4³ = 64 points per cube.
 *
 * A box clipped by a plane is analytically solvable, but only fiddly-solvable at
 * arbitrary orientation, and the sampled version buys something the closed form does
 * not: the centre of the submerged samples IS the centre of buoyancy, so applying the
 * force there produces the righting torque for free. That is why a cube dropped in
 * askew rolls level and bobs instead of hanging at whatever angle it entered.
 */
const N = 4;
const SAMPLE_COUNT = N * N * N;

/** Local-frame sample offsets as fractions of the half-extent: ±0.25, ±0.75. */
const OFFSETS: readonly number[] = Array.from({ length: N }, (_, i) => (2 * i + 1) / N - 1);

export interface SubmergedReading {
  /** 0..1 — the fraction of the cube's volume below the surface. */
  frac: number;
  /** World centre of the submerged volume. Only meaningful when `frac > 0`. */
  centre: Vec3;
}

/** Rotate `v` by unit quaternion `q`, in place into `out`. */
function rotateInto(q: Quat, vx: number, vy: number, vz: number, out: Vec3): Vec3 {
  // t = 2 * (q_vec x v); v' = v + q_w * t + q_vec x t
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * How much of the cube is under `surfaceYM`, and where that volume is centred.
 *
 * Cheap enough to run for every cube every step: 64 point tests, no allocation.
 */
export function sampleSubmerged(
  sideM: number,
  p: Vec3,
  q: Quat,
  surfaceYM: number,
  out: SubmergedReading,
): SubmergedReading {
  const half = sideM / 2;
  /*
   * Each sample is WEIGHTED by how far its own cell is under the surface, not counted
   * by a binary in/out test. This is the difference between a working tank and a
   * permanent limit cycle, and it cost an afternoon to find (F0, 2026-08-26):
   *
   * For a LEVEL cube every sample in a horizontal layer crosses the surface on the same
   * step, so a binary count can only ever report 0.25 / 0.50 / 0.75 / 1.00. Iron floats
   * at 0.58 in mercury. It cannot be expressed, so the cube oscillated between the two
   * neighbouring levels forever and never settled — which reads exactly like a spring
   * instability and is nothing of the kind.
   *
   * The ramp below is not merely a smoothing hack: for a level cube it is EXACT at every
   * depth, because a cell's contribution really is linear in how deep it is. Rotate the
   * cube and it degrades gracefully to a good approximation.
   */
  const cell = sideM / N;
  // Vertical extent of one cell at this orientation — the width of the ramp.
  const vert = cell * projectedSpread(q, 0, 1, 0);
  const invVert = vert > 0 ? 1 / vert : 0;
  let w = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const ox of OFFSETS) {
    for (const oy of OFFSETS) {
      for (const oz of OFFSETS) {
        rotateInto(q, ox * half, oy * half, oz * half, scratch);
        const wy = p.y + scratch.y;
        const t = 0.5 + (surfaceYM - wy) * invVert;
        const wi = t <= 0 ? 0 : t >= 1 ? 1 : t;
        if (wi > 0) {
          w += wi;
          cx += (p.x + scratch.x) * wi;
          cy += wy * wi;
          cz += (p.z + scratch.z) * wi;
        }
      }
    }
  }
  out.frac = w / SAMPLE_COUNT;
  if (w > 0) {
    out.centre.x = cx / w;
    out.centre.y = cy / w;
    out.centre.z = cz / w;
  } else {
    out.centre.x = p.x;
    out.centre.y = p.y;
    out.centre.z = p.z;
  }
  return out;
}

/**
 * The cube's silhouette along a world direction, and the drag coefficient that goes
 * with it.
 *
 * For a cube of side `s` the area projected along a unit direction `d` expressed in the
 * BODY frame is `s²·(|dx| + |dy| + |dz|)` — that bracket ("spread") runs from 1 face-on
 * through √2 edge-on to √3 corner-on. 02 publishes Cd at the first two, so Cd is
 * interpolated across that span and held beyond it rather than invented.
 *
 * Note that `Cd·A` still RISES as the cube turns (1.05 s² face-on vs 1.13 s² edge-on):
 * the falling coefficient does not outrun the growing silhouette, which is the correct
 * physical behaviour and worth knowing before anyone "fixes" it.
 */
export function projectedSpread(q: Quat, dx: number, dy: number, dz: number): number {
  // Rotating the direction by the CONJUGATE takes it from world into the body frame.
  rotateInto({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, dx, dy, dz, scratch);
  return Math.abs(scratch.x) + Math.abs(scratch.y) + Math.abs(scratch.z);
}

export function dragCoefficient(spread: number): number {
  const t = Math.min(1, Math.max(0, (spread - 1) / (Math.SQRT2 - 1)));
  return CD_FACE_ON + (CD_EDGE_ON - CD_FACE_ON) * t;
}

export interface FluidForces {
  /** Buoyancy, to be applied AT `centre` — not at the centre of mass. */
  buoyN: number;
  centre: Vec3;
  /** Drag + viscous, already summed and opposing the velocity. At the centre of mass. */
  resistN: Vec3;
  /** The added-mass correction (§ below). At the centre of mass. */
  inertiaN: Vec3;
  /** Resistive torque — 02 §6's fourth term. Opposes the spin, never reverses it. */
  torqueNm: Vec3;
  frac: number;
  /** Fluid dragged along with the cube, in kg — a readout, and what F0 measures. */
  addedMassKg: number;
  /**
   * Implicit linear damping for this step, in s^-1 — hand to `setLinearDamping`.
   * Zero for a fully submerged body, so sink speeds are never touched.
   */
  dampingPerS: number;
}

const reading: SubmergedReading = { frac: 0, centre: { x: 0, y: 0, z: 0 } };

/**
 * Everything the tank does to one cube in one step.
 *
 * The resistive force carries `aero.ts`'s impulse clamp — `|F|·dt ≤ m·|v|`, so drag can
 * null a step's motion but never invert it. Buoyancy deliberately carries no clamp; see
 * the note at the force itself for why, and for what happened when it did.
 *
 * That leaves the stiffest spring in the toy (19 §2.4: a 0.25" cube in mercury, omega·dt
 * = 1.47) held by drag alone, which F0 measures rather than assumes. No hand-applied
 * spring constant appears anywhere in this file — those have bitten this project twice.
 */
export function fluidForces(
  fluid: FluidId,
  sideM: number,
  massKg: number,
  p: Vec3,
  q: Quat,
  v: Vec3,
  w: Vec3,
  surfaceYM: number,
  dt: number,
  out: FluidForces,
): FluidForces {
  const spec = FLUIDS[fluid];
  const rho = spec.densityKgM3;
  sampleSubmerged(sideM, p, q, surfaceYM, reading);
  const frac = reading.frac;
  out.frac = frac;

  /*
   * Set BEFORE the dry early-out: a cube that has just left the surface is the case that
   * most needs this, and returning early without it is what let aluminium hop forever.
   */
  const band = SURFACE_BAND_SIDES * sideM;
  const near = Math.max(0, 1 - Math.abs(p.y - surfaceYM) / band);
  out.dampingPerS = SURFACE_DAMPING_PER_S * near * (1 - frac);

  out.centre.x = reading.centre.x;
  out.centre.y = reading.centre.y;
  out.centre.z = reading.centre.z;

  if (frac <= 0) {
    out.buoyN = 0;
    out.resistN.x = 0;
    out.resistN.y = 0;
    out.resistN.z = 0;
    out.inertiaN.x = 0;
    out.inertiaN.y = 0;
    out.inertiaN.z = 0;
    out.torqueNm.x = 0;
    out.torqueNm.y = 0;
    out.torqueNm.z = 0;
    out.addedMassKg = 0;
    return out;
  }

  const volume = sideM * sideM * sideM;
  const addedMass = ADDED_MASS_COEFF * rho * volume * frac;
  out.addedMassKg = addedMass;
  /*
   * `k` scales every force the body feels, fluid AND gravity, because added mass slows
   * the response to all of them. Rapier applies gravity itself and cannot be told a
   * per-body mass, so the shortfall is handed back as an explicit correction:
   *
   *   want:  (m + m_a)*a = Fg + Fb + Fd        i.e.  a = k*(Fg + Fb + Fd)
   *   have:  m*a = Fg + F_applied
   *   so:    F_applied = k*(Fb + Fd) + (k - 1)*Fg
   *
   * At any equilibrium Fb + Fd + Fg = 0, so F_applied = -Fg and the body sits still —
   * the resting depth and the terminal velocity are exactly where they were.
   */
  const k = massKg / (massKg + addedMass);
  out.inertiaN.x = 0;
  out.inertiaN.y = (1 - k) * massKg * G; // (k - 1) * (-m*g), i.e. upward: gravity, softened
  out.inertiaN.z = 0;
  /*
   * Buoyancy is NOT impulse-clamped, and the first cut of this file was wrong to try.
   * `aero.ts`'s clamp exists so drag can null a step's motion but never invert it —
   * correct for a purely resistive force. Buoyancy is not resistive: reversing a sinking
   * cube is the entire point of floating. Clamping it to the weight it would have to
   * beat pinned every floater at whatever depth it was born, and all four mercury
   * fractions read back exactly their spawn pose (F0, 2026-08-26).
   *
   * Nothing is needed in its place. Buoyancy is bounded by `rho_f * V * g`, so the worst
   * net upward acceleration in the toy is mercury on aluminium at ~4 g, and the drag
   * term in a fluid that dense kills the overshoot inside a few steps.
   */
  out.buoyN = k * rho * volume * frac * G;

  /*
   * Resistive torque, clamped like the linear term: it can null a step's spin but never
   * invert it, so no amount of angular velocity can make it explode.
   */
  const spin = Math.hypot(w.x, w.y, w.z);
  if (spin > 0) {
    const s5 = sideM * sideM * sideM * sideM * sideM;
    const quadT = ANG_DRAG_COEFF * rho * s5 * spin * spin;
    const viscT = Math.PI * spec.viscosityPaS * sideM * sideM * sideM * spin;
    let tmag = (quadT + viscT) * frac;
    // I = m*s^2/6 for a cube about a face axis; the clamp only needs the scale.
    const maxT = ((massKg * sideM * sideM) / 6 / dt) * spin;
    if (tmag > maxT) tmag = maxT;
    const tf = -tmag / spin;
    out.torqueNm.x = tf * w.x;
    out.torqueNm.y = tf * w.y;
    out.torqueNm.z = tf * w.z;
  } else {
    out.torqueNm.x = 0;
    out.torqueNm.y = 0;
    out.torqueNm.z = 0;
  }

  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed === 0) {
    out.resistN.x = 0;
    out.resistN.y = 0;
    out.resistN.z = 0;
    return out;
  }
  const spread = projectedSpread(q, v.x / speed, v.y / speed, v.z / speed);
  const area = sideM * sideM * spread;
  const quad = 0.5 * rho * dragCoefficient(spread) * area * speed * speed;
  const visc = 3 * Math.PI * spec.viscosityPaS * sideM * speed;
  let mag = (quad + visc) * frac * k;
  const maxMag = (massKg * speed) / dt;
  if (mag > maxMag) mag = maxMag;
  const f = -mag / speed;
  out.resistN.x = f * v.x;
  out.resistN.y = f * v.y;
  out.resistN.z = f * v.z;
  return out;
}

export function makeFluidForces(): FluidForces {
  return {
    buoyN: 0,
    centre: { x: 0, y: 0, z: 0 },
    resistN: { x: 0, y: 0, z: 0 },
    inertiaN: { x: 0, y: 0, z: 0 },
    torqueNm: { x: 0, y: 0, z: 0 },
    frac: 0,
    addedMassKg: 0,
    dampingPerS: 0,
  };
}

/**
 * Terminal sink speed for a fully-submerged, face-on cube — the analytic reference the
 * tests measure against, never a readout.
 *
 * `null` when the cube floats, which is the honest answer: there is no terminal
 * velocity, there is a resting depth (`floatFraction`).
 */
/**
 * The velocity a single step of un-opposed net buoyancy imparts — the floor on how still
 * a small floater can be held at 60 Hz.
 *
 * THE FINDING F0 EXISTS TO PRODUCE (2026-08-26). 19 §2.4 predicted trouble for the
 * smallest cube in mercury on stiffness grounds (`omega*dt = 1.47` against a limit of 2)
 * and named damping as the fix. Both halves were wrong, and measuring beat reasoning:
 *
 * Buoyancy near the surface is not a spring, it is a SATURATING RAMP. Once a cube's
 * oscillation exceeds its own height it swings between fully wet and fully dry inside a
 * step or two, so it behaves as a bang-bang system, and a bang-bang system has a limit
 * cycle that damping cannot remove — the residual is regenerated at every crossing.
 *
 * The scale is set by this quantum, and the evidence is that the residual tracks it and
 * ignores everything else. For a 0.25" aluminium cube in mercury this returns 0.150 m/s
 * and the measured residual is 0.31-0.37 m/s — the cycle spends a step or so at full
 * force in each direction, so a small multiple of the quantum is what a bang-bang limit
 * cycle should give. What matters is that damping does not touch it: widening the band
 * 160x, so damping never lapses at all, moved the residual by 0.06 m/s, and raising D
 * from 6 to 18 moved it by 0.05. A damping problem does not behave like that.
 *
 * The consequence is a REQUIREMENT ON THE LAB (19 §6, F2), not on this file: a floater
 * whose residual is within a few of these quanta must be parked at the depth
 * `floatFraction` gives and allowed to sleep, rather than left to jitter around it.
 * Parking there is not a cheat — `floatFraction` is an exact division, so it snaps to
 * the known answer instead of to a discretisation artefact. Note that the lab must stop
 * applying forces to do it: `applyForce` wakes a body every step, so a cube under
 * continuous fluid forces can never sleep on its own.
 *
 * It is a small-cube problem only. The quantum scales with `g*dt` and the density ratio,
 * not with size, but the cube it has to stay small against does — for a 2" cube the same
 * 0.39 m/s would be absurd, and the measured residual there is 0.001.
 */
export function stepVelocityQuantum(bodyDensityKgM3: number, fluid: FluidId, dt: number): number {
  const rho = FLUIDS[fluid].densityKgM3;
  const frac = Math.min(1, rho / bodyDensityKgM3);
  const addedMass = ADDED_MASS_COEFF * rho * frac;
  const k = bodyDensityKgM3 / (bodyDensityKgM3 + addedMass);
  return Math.abs(k * (rho / bodyDensityKgM3 - 1) * G * dt);
}

/**
 * A CPU-side surface-wave model — the physics half of the ripple.
 *
 * The GPU heightfield (`fx/ripple.ts`) is what you SEE, and it cannot be what the
 * physics reads: sampling it per body per step means a GPU->CPU readback every frame,
 * which stalls the pipeline and is exactly the class of cost that shows up as stutter on
 * a real GPU and not at all in a headless benchmark.
 *
 * So the same splash events drive a handful of expanding rings here, evaluated
 * analytically. It is an approximation of the same wave equation rather than a copy of
 * its state, but it is driven by the same disturbances at the same places and times, so
 * it agrees with the visible surface in character and timing — a wave you can see
 * arriving is a wave that lifts the duck as it passes.
 *
 * Cost is a few dozen flops per sample with at most `MAX_RINGS` alive; sampling every
 * body every step is free.
 */
const MAX_RINGS = 8;

interface Ring {
  x: number;
  z: number;
  /** Seconds since the disturbance. */
  age: number;
  amp: number;
}

export class SurfaceWaves {
  readonly #rings: Ring[] = [];
  /** Shallow-water wave speed, sqrt(g*depth) — ~2.1 m/s in a 46 cm tank. */
  #speed = 2.1;
  /** How fast a ring dies, in seconds. */
  #life = 1.6;

  configure(depthM: number, lifeS: number): void {
    this.#speed = Math.sqrt(config.physics.gravityMps2 * Math.max(0.01, depthM));
    this.#life = lifeS;
  }

  /** A disturbance at a world (x, z). `amp` is the trough depth in metres. */
  add(x: number, z: number, amp: number): void {
    if (this.#rings.length >= MAX_RINGS) this.#rings.shift();
    this.#rings.push({ x, z, age: 0, amp });
  }

  step(dt: number): void {
    for (let i = this.#rings.length - 1; i >= 0; i--) {
      const r = this.#rings[i]!;
      r.age += dt;
      if (r.age > this.#life) this.#rings.splice(i, 1);
    }
  }

  clear(): void {
    this.#rings.length = 0;
  }

  /**
   * Surface displacement at a world (x, z), in metres. Positive is up.
   *
   * Each ring is a wavelet riding an expanding front: a leading trough followed by a
   * crest, enveloped so it is local to the front, spreading (1/(1+r)) and decaying with
   * age. That is enough for a body to be lifted as the wave passes and set down after.
   */
  heightAt(x: number, z: number): number {
    let h = 0;
    for (const ring of this.#rings) {
      const dx = x - ring.x;
      const dz = z - ring.z;
      const r = Math.hypot(dx, dz);
      const front = this.#speed * ring.age;
      const d = r - front;
      const w = 0.055;
      if (Math.abs(d) > w * 3) continue;
      const env = Math.exp(-(d * d) / (2 * w * w));
      const decay = Math.exp(-ring.age / this.#life) / (1 + r / 0.12);
      h += -ring.amp * Math.cos((d / w) * 1.6) * env * decay;
    }
    return h;
  }
}

export function terminalSinkMps(
  bodyDensityKgM3: number,
  sideM: number,
  fluid: FluidId,
): number | null {
  const rho = FLUIDS[fluid].densityKgM3;
  if (bodyDensityKgM3 <= rho) return null;
  return Math.sqrt((2 * (bodyDensityKgM3 - rho) * sideM * G) / (rho * CD_FACE_ON));
}
