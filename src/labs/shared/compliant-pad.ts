import { config } from '../../config.ts';
import type { PhysicsWorld } from '../../core/physics.ts';
import type { BodyHandle, JointHandle, SurfaceId, Vec3 } from '../../types.ts';

/**
 * A compliant pad — the trampoline mat and the foam block (16 §7.3, as amended by D0).
 *
 * A dynamic mat on a vertical prismatic joint with an explicit spring; the scale's
 * transducer (15 §7.2) reshaped into a floor. Every design choice here is the residue
 * of a measured failure, D0 2026-08-23, pinned by `tests/physics/drop.test.ts`:
 *
 * - Rapier's prismatic limit is a soft constraint — a SPRING. A 4 in W "bottoming out"
 *   rebounded 86 % off it as first built. And no per-step trick holds a light dynamic
 *   pad against a heavy contact (velocity zeroed AND gravity cancelled, it was still
 *   rammed through at −1.6 m/s). So strikes past the CAPACITY GATE never meet a live
 *   pad at all: `wouldBottomOut()` is decided from ½mv² before the landing, and the
 *   crushed regime is a FIXED body — fixed, not kinematic, because a kinematic body
 *   is not a reliable CCD obstacle in 0.19.3 (a 996 kg cube went through one).
 * - Implicit damping cannot restrain force applied in the same step (a 973 s⁻¹ damper
 *   still let a freed pad jump 32 mm in one frame), so foam's ~1 s memory is a
 *   rate-controlled creep, `v = x/τ`, applied as a deadbeat that can stop but never
 *   launch — and a damper's anti-reversal clamp scales with the MOVING SYSTEM (pad
 *   plus carried mass), the same lesson the scale's clampDamping learned in W2.
 * - A sub-gate stop-touch is arrested the balance's way: held (velocity zeroed AND
 *   gravity cancelled) while pressed, then crept home — never released through the
 *   stored spring, which would fire a 1.5 kg mat upward at 12 m/s.
 */

export interface CompliantPadParams {
  padKg: number;
  travelM: number;
  kNpm: number;
  /** Constant implicit damping (1/s) — the trampoline's small, symmetric liveliness. */
  dampingImplicit?: number;
  /** Foam mode, with `creepTauS`: critical damping under load, creep when released. */
  zetaLoaded?: number;
  creepTauS?: number;
  /** The fabric the cubes actually touch; also what `ImpactEvent.b` reports. */
  surface: SurfaceId;
  /** The capacity gate: past ½mv² the landing belongs to the crushed regime. */
  bottomOutJ: number;
}

export type PadRegime = 'live' | 'crushed';

const G = config.physics.gravityMps2;
const DT = config.loop.DT;
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class CompliantPad {
  readonly pad: BodyHandle;
  readonly restCentreY: number;
  minPadY: number;
  readonly #frame: BodyHandle;
  readonly #crushedFloor: BodyHandle;
  readonly #at: Vec3;
  #joint: JointHandle | null = null;
  #regime: PadRegime;
  #arrested = false;

  constructor(
    readonly pw: PhysicsWorld,
    readonly params: CompliantPadParams,
    at: { x: number; z: number },
    restCentreY: number,
    readonly halfM: number,
    regime: PadRegime = 'live',
  ) {
    this.restCentreY = restCentreY;
    this.minPadY = restCentreY;
    this.#regime = regime;
    this.#at = { x: at.x, y: restCentreY, z: at.z };
    // The frame's collider is buried well below the pad's travel, contact-inert; it
    // exists to anchor the prismatic joint. (The D0 rig parked it off to the side for
    // the same reason: it must never catch anything, least of all a tunnelling bug.)
    this.#frame = pw.addCompound({
      kind: 'fixed',
      at: { x: at.x, y: restCentreY - 0.5, z: at.z },
      parts: [
        { shape: { kind: 'box', halfExtents: { x: 0.05, y: 0.05, z: 0.05 } }, material: 'steel' },
      ],
    });
    /*
     * The BORN-FIXED twin at the bottom of the stroke — the crushed regime's actual
     * landing surface. Measured 2026-08-25: a converted-fixed body that has been
     * setTransform'd away from its creation pose still RESOLVES contacts but stops
     * EMITTING contact-force events (the whole impact channel goes silent), while a
     * body born at its pose reports honestly. So the crushed mat body still drops
     * (it carries the visual), but this twin — created here, never moved — catches
     * the cube and reports the impact. While live, the legal stroke floor (150 J →
     * 0.194 m of 0.25 m) keeps everything 3.6 cm clear of it.
     */
    this.#crushedFloor = pw.addCompound({
      kind: 'fixed',
      at: { x: at.x, y: restCentreY - params.travelM, z: at.z },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: halfM, y: 0.01, z: halfM } },
          material: params.surface,
        },
      ],
    });
    this.pad = pw.addCompound({
      kind: regime === 'crushed' ? 'fixed' : 'dynamic',
      at: this.#at,
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: halfM, y: 0.01, z: halfM } },
          material: params.surface,
          massKg: params.padKg,
        },
      ],
    });
    if (regime === 'live') this.#addJoint();
  }

  #addJoint(): void {
    this.#joint = this.pw.addPrismaticJoint({
      bodyA: this.#frame,
      bodyB: this.pad,
      anchorA: { x: 0, y: 0.5, z: 0 },
      anchorB: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
      limitsM: [-this.params.travelM, 0],
    });
  }

  get regime(): PadRegime {
    return this.#regime;
  }

  get padTopRestY(): number {
    return this.restCentreY + 0.01;
  }

  padY(): number {
    return this.pw.transformOf(this.pad).p.y;
  }

  /** True once the pad has been near the end of its travel — or is crushed outright. */
  bottomed(): boolean {
    return (
      this.#regime === 'crushed' || this.minPadY <= this.restCentreY - this.params.travelM + 0.01
    );
  }

  /** The capacity gate (16 §7.3 amendment): decide the regime BEFORE the landing. */
  wouldBottomOut(massKg: number, impactSpeedMps: number): boolean {
    return 0.5 * massKg * impactSpeedMps * impactSpeedMps > this.params.bottomOutJ;
  }

  /**
   * Flip regimes in place — `setBodyKind` (D0-validated) plus the joint, which is
   * removed while crushed (a joint onto a fixed body is a contradiction waiting for a
   * solver opinion) and rebuilt on revival. Both directions restore the rest pose
   * deterministically: a mat is flat the moment its regime is decided.
   */
  setRegime(regime: PadRegime): void {
    if (regime === this.#regime) return;
    this.#regime = regime;
    this.#arrested = false;
    if (regime === 'crushed') {
      if (this.#joint) {
        this.pw.removeJoint(this.#joint);
        this.#joint = null;
      }
      /*
       * A crushed mat lies at the BOTTOM of its stroke, immediately (16 §7.3
       * amendment, 2026-08-25). It used to stand rigid at full height —
       * indistinguishable from a solid board (user-caught, twice) — and a later
       * "slam" teleport close to contact got the landing's CCD impact EATEN
       * (0.87 m/s recorded for a 9.5 m/s strike). Flattening at decision time is
       * seconds ahead of any contact, so the event pipeline stays honest.
       */
      this.pw.setTransform(
        this.pad,
        { x: this.#at.x, y: this.restCentreY - this.params.travelM, z: this.#at.z },
        true,
      );
      this.pw.setBodyKind(this.pad, 'fixed');
    } else {
      this.pw.setBodyKind(this.pad, 'dynamic');
      this.pw.setTransform(this.pad, this.#at, true);
      this.pw.setVelocity(this.pad, ZERO, ZERO);
      this.#addJoint();
      this.minPadY = this.restCentreY;
    }
  }

  /** Forget past bottoming — call when a new drop is armed. */
  resetBottoming(): void {
    this.minPadY = this.padY();
  }

  get arrested(): boolean {
    return this.#arrested;
  }

  /** A REAL hold: velocity zeroed AND gravity cancelled (D0: zeroing alone drifts). */
  #hold(): void {
    this.pw.setVelocity(this.pad, ZERO, ZERO);
    this.pw.applyForce(this.pad, { x: 0, y: this.params.padKg * G, z: 0 });
  }

  /** Call before every physics step, from the lab's `beforePhysics`. */
  beforePhysics(): void {
    if (this.#regime === 'crushed') return; // a crushed mat is a floor; nothing to drive
    const y = this.padY();
    this.minPadY = Math.min(this.minPadY, y);
    const x = Math.max(0, this.restCentreY - y); // compression
    const vy = this.pw.velocityOf(this.pad).y;
    const p = this.params;
    const carriedN = this.pw.contactForceAlongN(this.pad, UP);

    // Arrest at the stop — the slow stop-touch only; gated strikes never get here.
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
      // Foam: everything explicit; implicit damping off.
      this.pw.setLinearDamping(this.pad, 0);
      if (carriedN > 0.5) {
        const c = 2 * p.zetaLoaded * Math.sqrt(p.kNpm * (p.padKg + carriedN / G));
        const stoppingN = ((p.padKg + carriedN / G) * Math.abs(vy)) / DT;
        const dampN = Math.max(-stoppingN, Math.min(stoppingN, -c * vy));
        this.pw.applyForce(this.pad, { x: 0, y: p.kNpm * x + dampN, z: 0 });
      } else {
        const vTarget = x / p.creepTauS;
        this.pw.applyForce(this.pad, { x: 0, y: p.padKg * ((vTarget - vy) / DT + G), z: 0 });
      }
      return;
    }

    /*
     * Quiet hold at true rest: an underdamped per-step spring never lets the body
     * sleep, so solver noise rings the bare mat forever (user-caught: "constantly
     * vibrating", 2026-08-25). Judged by POSITION window (the W2 lesson), broken by
     * any contact impulse the same step it lands.
     */
    /*
     * Near rest and slow, the mat is OVERDAMPED instead of underdamped: at ζ≈0.08 a
     * per-step spring rings on solver noise forever ("constantly vibrating",
     * user-caught 2026-08-25). A velocity-zero hold was tried first and trapped a
     * LOADED pad — a light cube's resting contact force chatters to zero and even
     * sleeps (the W2 lesson, relearned), so no force read gates this. Damping never
     * moves an equilibrium: mis-classification cannot corrupt the sag, only the
     * settling style. A real strike arrives fast (|vy| ≥ 0.03) and keeps the mat lively.
     */
    /*
     * The window must CONTAIN the explicit-spring limit cycle: at ω·dt = 1.22 the
     * per-step spring pumps solver noise into a sustained ±1.3 mm ring whose peak
     * velocity is ~0.1 m/s — fast-and-small. A real strike arrives at metres per
     * second; 0.30 m/s cleanly separates the two (measured live, 2026-08-25).
     */
    const nearRest = Math.abs(this.restCentreY - y) < 0.004 && Math.abs(vy) < 0.3;
    this.pw.setLinearDamping(this.pad, nearRest ? 60 : (p.dampingImplicit ?? 0));
    if (x > 0) this.pw.applyForce(this.pad, { x: 0, y: p.kNpm * x, z: 0 });
  }

  teardown(): void {
    if (this.#joint) {
      this.pw.removeJoint(this.#joint);
      this.#joint = null;
    }
    this.pw.remove(this.pad);
    this.pw.remove(this.#frame);
    this.pw.remove(this.#crushedFloor);
  }
}

/** The configured pads, params + gate merged (16 §7.3; `config.drop`). */
export function trampolineParams(): CompliantPadParams {
  const p = config.drop.pads.trampoline;
  return {
    padKg: p.padKg,
    travelM: p.travelM,
    kNpm: p.kNpm,
    dampingImplicit: p.dampingImplicit,
    surface: p.surface as SurfaceId,
    bottomOutJ: config.drop.gates.trampolineBottomOutJ,
  };
}

export function foamParams(): CompliantPadParams {
  const p = config.drop.pads.foam;
  return {
    padKg: p.padKg,
    travelM: p.travelM,
    kNpm: p.kNpm,
    zetaLoaded: p.zetaLoaded,
    creepTauS: p.creepTauS,
    surface: p.surface as SurfaceId,
    bottomOutJ: config.drop.gates.foamBottomOutJ,
  };
}
