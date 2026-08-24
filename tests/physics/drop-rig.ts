/**
 * Stage D0 spike rig for the Drop Tower (16 §15 D0).
 *
 * Everything that CAN go through the shipping facade does — the CCD matrix, drag, the
 * compliant pads, determinism all drive the real `PhysicsWorld`, because a spike that
 * passes on a private rig proves nothing about the app. The ONE thing the facade cannot
 * do yet — switching a body between dynamic and kinematic — is spiked against raw Rapier
 * here, exactly as `weigh-rig.ts` spiked the joints before W1 built them. This file and
 * weigh-rig.ts are the only two places outside `core/physics.ts` that touch Rapier.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../../src/config.ts';
import { PhysicsWorld } from '../../src/core/physics.ts';
import type { BodyHandle, ImpactEvent, SurfaceId, Vec3 } from '../../src/types.ts';
import { DT, G } from './harness.ts';

/* ------------------------------------------------------------------ air (16 §6.3) */

export const RHO_AIR = 1.225; // kg/m³ — 16 §6.3; becomes config.aero.rhoAirKgM3 in D1
export const CD_FACE_ON = 1.05; // 02's cube face-on drag coefficient

export function terminalVelocity(massKg: number, sideM: number): number {
  return Math.sqrt((2 * massKg * G) / (RHO_AIR * CD_FACE_ON * sideM * sideM));
}

/** Analytic speed after falling `hM` from rest under gravity + quadratic drag. */
export function speedAfterFall(hM: number, vtMps: number): number {
  return vtMps * Math.sqrt(1 - Math.exp((-2 * G * hM) / (vtMps * vtMps)));
}

/**
 * The drag force for one fixed step, impulse-clamped so it can never reverse the
 * velocity it opposes (16 §6.3). Vertical component only — the spike drops are
 * straight down; the D2 lab generalises to the full velocity vector.
 */
export function dragForceClamped(vyMps: number, sideM: number, massKg: number, dt: number): number {
  const f = -0.5 * RHO_AIR * CD_FACE_ON * sideM * sideM * Math.abs(vyMps) * vyMps;
  const maxF = (massKg * Math.abs(vyMps)) / dt;
  return Math.max(-maxF, Math.min(maxF, f));
}

/* ------------------------------------------------- shared drop instrumentation */

export interface DropOutcome {
  impact: ImpactEvent;
  /** |v| of the cube read immediately BEFORE the step that produced the impact. */
  preSpeedMps: number;
  /** Steps from release to the impact step, inclusive. */
  steps: number;
}

/**
 * Step until the body with `entityId` reports its first impact. `each` runs before
 * every step (drag, pad springs). Throws if nothing lands within `maxSeconds` —
 * in a tunnelling spike, "it never landed" IS the failure, loudly.
 */
export function stepUntilImpact(
  pw: PhysicsWorld,
  h: BodyHandle,
  entityId: number,
  maxSeconds: number,
  each?: () => void,
): DropOutcome {
  const impacts: ImpactEvent[] = [];
  const v: Vec3 = { x: 0, y: 0, z: 0 };
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    pw.readVelocityInto(h, v);
    const preSpeedMps = Math.hypot(v.x, v.y, v.z);
    each?.();
    impacts.length = 0;
    pw.step(DT, impacts);
    const hit = impacts.find((ev) => ev.a === entityId);
    if (hit) return { impact: hit, preSpeedMps, steps: i + 1 };
  }
  throw new Error(`no impact for entity ${entityId} within ${maxSeconds}s — tunnelled?`);
}

/** A 20 mm plate whose top face is at y = 0 — the Drop Tower's floor slab (16 §7.1). */
export async function plateWorld(halfM = 0.6): Promise<PhysicsWorld> {
  const pw = await PhysicsWorld.create();
  pw.addStaticBox({ x: halfM, y: 0.01, z: halfM }, { x: 0, y: -0.01, z: 0 }, 'concrete');
  return pw;
}

/* --------------------------------------------------- compliant pad (16 §7.3) */

const UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface PadParams {
  padKg: number;
  travelM: number;
  kNpm: number;
  /**
   * Constant implicit linear damping (1/s) — the trampoline's small, symmetric loss.
   * Implicit damping CANNOT restrain force applied within the same step (measured in
   * D0: a 973 1/s damper still let a freed pad jump 32 mm in one frame), so it is only
   * used where small; anything that must dominate a force is done explicitly.
   */
  dampingImplicit?: number;
  /**
   * Foam mode: while the pad carries a load (sustained contact force on it), spring +
   * critical damping against the carried mass — the scale's own damper trick (15
   * §7.2), impulse-clamped so it can never reverse the pad. While unloaded, the pad
   * does not spring back: it CREEPS, `v_target = compression / creepTauS`, applied as
   * a deadbeat velocity controller that is unconditionally stable and can stop but
   * never launch. Real foam memory is rate-limited creep, not a damped spring.
   */
  zetaLoaded?: number;
  creepTauS?: number;
  /**
   * Fabric material for the contact itself. `sand`/`trampoline` do not exist as
   * surfaces yet (that is D1); the spike borrows the nearest shipped pair — rubber
   * for a springy membrane, foam for foam — because D0 tests the MECHANISM, not the
   * pair calibration.
   */
  material: SurfaceId;
  halfM?: number;
}

/**
 * The bottoming-out gate (16 §7.3, amended by this spike).
 *
 * A landing that overwhelms the mat resolves INSIDE one 60 Hz step — full travel is
 * 1.5 steps at 9.9 m/s — and Rapier's prismatic limit is a soft constraint, i.e. a
 * stiff spring: as first built, a 4" W from 5 m "bottomed out" and rebounded 86 %,
 * because the limit stored and returned ~800 J elastically. No per-step arrest can
 * intervene in a sub-step event. So bottoming is decided BEFORE the landing, from the
 * incoming kinetic energy: past the gate the mat is already beaten, and the pad is
 * made FIXED for that landing — a rigid crushed mat — so the rebound is the fabric
 * contact's alone. Fixed, not kinematic: this spike measured a 15 in / 996 kg cube at
 * 19.8 m/s passing THROUGH a kinematic 20 mm pad that a fixed one stops every time —
 * a kinematic body is not a reliable CCD obstacle in 0.19.3. (The balance's kinematic
 * pans are safe: nothing reaches them at CCD speeds.)
 *
 * The gate is above the spring's stored capacity (½k·travel² = 108 J) because the
 * fabric contact eats its share before the spring sees the rest: a 2" W arriving with
 * 115 J measurably does NOT reach the stop (min pad y 0.109 of 0.05 travel floor).
 * 150 J keeps that landing in the live-spring regime and sends 4" W (926 J) to the
 * rigid one. Tuned, named, with this measured reason (01 pillar 2).
 */
export const TRAMPOLINE_BOTTOM_OUT_J = 150;

export function bottomsOut(cubeKg: number, impactSpeedMps: number): boolean {
  return 0.5 * cubeKg * impactSpeedMps * impactSpeedMps > TRAMPOLINE_BOTTOM_OUT_J;
}

/**
 * Foam's gate, just above its spring capacity (½k·travel² ≈ 27 J). BOTH pads need the
 * gate, not just the trampoline: D0 measured that NO velocity/force trick can make a
 * 1 kg dynamic pad withstand an 18.9 kg cube through the solver — a true hold
 * (velocity zeroed AND gravity cancelled) was still rammed through at −1.6 m/s by the
 * first contact step. The strike regime is a FIXED pad, full stop; the live spring
 * serves the quasi-static regime; D1's `setBodyKind` flips between them, decided from
 * `½mv²` (the lab knows `mgh` at release, before anything falls).
 */
export const FOAM_BOTTOM_OUT_J = 30;

export function bottomsOutFoam(cubeKg: number, impactSpeedMps: number): boolean {
  return 0.5 * cubeKg * impactSpeedMps * impactSpeedMps > FOAM_BOTTOM_OUT_J;
}

export const TRAMPOLINE_SEED: PadParams = {
  padKg: 1.5,
  travelM: 0.25,
  kNpm: 3470,
  dampingImplicit: 7.7, // ζ ≈ 0.08 on the bare pad — the mat stays ALIVE
  material: 'rubber',
};

export const FOAM_SEED: PadParams = {
  padKg: 1.0,
  travelM: 0.12,
  kNpm: 3700, // a 4" W (185 N) sags 50 mm at rest
  zetaLoaded: 1.0, // critically damped under a load: no wobble, no bounce
  creepTauS: 0.3, // within 2 mm of rest in ln(25)·τ ≈ 1 s — the ~1 s memory of 10 §4.9
  material: 'foam',
};

/**
 * A dynamic mat on a vertical prismatic joint — the scale's transducer (15 §7.2)
 * reshaped into a floor, exactly what `labs/shared/compliant-pad.ts` will extract in D1.
 */
export class PadRig {
  readonly pad: BodyHandle;
  readonly restCentreY: number;
  minPadY: number;
  readonly #frame: BodyHandle;
  readonly #p: PadParams;

  readonly rigid: boolean;

  constructor(
    readonly pw: PhysicsWorld,
    p: PadParams,
    restCentreY = 0.3,
    /**
     * Build the pad FIXED — the crushed-mat regime, chosen by `bottomsOut()` before
     * the drop. The shipping lab flips one pad with `setBodyKind` (D1, whose union
     * therefore needs 'fixed'); the spike builds it in the target kind, which
     * exercises the same solver path. See TRAMPOLINE_BOTTOM_OUT_J for why not
     * kinematic.
     */
    rigid = false,
  ) {
    this.#p = p;
    this.rigid = rigid;
    this.restCentreY = restCentreY;
    this.minPadY = restCentreY;
    const half = p.halfM ?? 0.45;
    // The frame's collider sits far off to the side: a catch box under the pad would
    // silently mask a tunnelling failure, and masking failures is not what a spike is for.
    this.#frame = pw.addCompound({
      kind: 'fixed',
      at: { x: 5, y: 0.5, z: 0 },
      parts: [
        { shape: { kind: 'box', halfExtents: { x: 0.05, y: 0.05, z: 0.05 } }, material: 'steel' },
      ],
    });
    this.pad = pw.addCompound({
      kind: rigid ? 'fixed' : 'dynamic',
      at: { x: 0, y: restCentreY, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: half, y: 0.01, z: half } },
          material: p.material,
          massKg: p.padKg,
        },
      ],
    });
    if (!rigid) {
      this.pw.addPrismaticJoint({
        bodyA: this.#frame,
        bodyB: this.pad,
        anchorA: { x: -5, y: restCentreY - 0.5, z: 0 },
        anchorB: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 1, z: 0 },
        limitsM: [-p.travelM, 0],
      });
    }
  }

  get padTopRestY(): number {
    return this.restCentreY + 0.01;
  }

  padY(): number {
    return this.pw.transformOf(this.pad).p.y;
  }

  /** True if the pad has been driven to (near) the end of its travel at any point. */
  bottomed(): boolean {
    return this.minPadY <= this.restCentreY - this.#p.travelM + 0.01;
  }

  #arrested = false;
  /**
   * A REAL hold: zero the velocity AND cancel gravity. Zeroing alone leaves the pad
   * re-accelerated by gravity every step — it drifted down at g·dt in step with the
   * falling cube, the two slammed at the soft limit, and the pair pogoed forever
   * (measured, diag6).
   */
  #hold(): void {
    this.pw.setVelocity(this.pad, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    this.pw.applyForce(this.pad, { x: 0, y: this.#p.padKg * G, z: 0 });
  }

  /** Call before every physics step, as the lab's `beforePhysics` will. */
  beforeStep(): void {
    if (this.rigid) return; // a crushed mat is a floor; nothing to drive
    const y = this.padY();
    this.minPadY = Math.min(this.minPadY, y);
    const x = Math.max(0, this.restCentreY - y); // compression
    const vy = this.pw.velocityOf(this.pad).y;
    const p = this.#p;
    const carriedN = this.pw.contactForceAlongN(this.pad, UP);

    /*
     * ARREST AT THE STOP (16 §7.3, amended by this spike). Rapier's prismatic limit
     * is a soft constraint — a stiff spring — and a sub-gate strike that still
     * reaches the end of travel would get its energy stored and RETURNED by it. The
     * balance solved the same problem with arrestment; the pad does the identical
     * thing linearly: pressed at the end of travel, it is held (velocity zeroed AND
     * gravity cancelled — zeroing alone left the pad re-accelerated every step) until
     * the load lifts, then creeps home rather than releasing the stored spring, which
     * would fire a 1.5 kg pad upward at 12 m/s. This handles only the SLOW stop-touch:
     * anything past the capacity gate never reaches a live pad at all (see
     * FOAM_BOTTOM_OUT_J — no hold survives a heavy cube's contact through the solver).
     */
    const pressedN = p.padKg * G + 1;
    if (x >= p.travelM - 0.005 && carriedN > pressedN) this.#arrested = true;
    if (this.#arrested) {
      if (carriedN > pressedN || vy < 0) {
        this.#hold();
      } else if (x > 0.02) {
        const tau = p.creepTauS ?? 0.08;
        this.pw.setLinearDamping(this.pad, 0);
        this.pw.applyForce(this.pad, { x: 0, y: p.padKg * ((x / tau - vy) / DT + G), z: 0 });
      } else {
        this.#arrested = false;
      }
      return;
    }

    if (p.zetaLoaded !== undefined && p.creepTauS !== undefined) {
      // Foam. Everything explicit; implicit damping off (see PadParams.dampingImplicit).
      this.pw.setLinearDamping(this.pad, 0);
      if (carriedN > 0.5) {
        const c = 2 * p.zetaLoaded * Math.sqrt(p.kNpm * (p.padKg + carriedN / G));
        // The clamp guards against reversing the MOVING SYSTEM — pad plus whatever
        // rides it. Clamping at the bare pad's stopping impulse gutted the damper 9×
        // under a 4" W and let the sag overshoot into the stop (the same mass-scaling
        // mistake the scale's clampDamping fixed in W2, remade here and caught by
        // this spike).
        const stoppingN = ((p.padKg + carriedN / G) * Math.abs(vy)) / DT;
        const dampN = Math.max(-stoppingN, Math.min(stoppingN, -c * vy));
        this.pw.applyForce(this.pad, { x: 0, y: p.kNpm * x + dampN, z: 0 });
      } else {
        // Unloaded: creep home. Cancels gravity, deadbeats v to x/τ; bounded by the
        // stopping impulse by construction, so it can never fling the pad.
        const vTarget = x / p.creepTauS;
        this.pw.applyForce(this.pad, { x: 0, y: p.padKg * ((vTarget - vy) / DT + G), z: 0 });
      }
      return;
    }

    // Trampoline: explicit spring, light constant implicit damping — the mat is alive.
    this.pw.applyForce(this.pad, { x: 0, y: p.kNpm * x, z: 0 });
    this.pw.setLinearDamping(this.pad, p.dampingImplicit ?? 0);
  }
}

/* ------------------------------------- raw Rapier: the body-kind switch (16 §6.2) */

export interface BodyKindProbe {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  free(): void;
}

/** A raw-Rapier world matching the facade's solver settings, with one dynamic cube. */
export async function rawCubeWorld(sideM: number, at: Vec3): Promise<BodyKindProbe> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.numSolverIterations = config.stability.solverIterations;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(sideM / 2, sideM / 2, sideM / 2), body);
  return { world, body, free: () => world.free() };
}
