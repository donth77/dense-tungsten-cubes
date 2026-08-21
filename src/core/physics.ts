import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config.ts';
import { densityOf } from '../data/metals.ts';
import { METALS } from '../data/metals.ts';
import { SURFACES } from '../data/surfaces.ts';
import { E_REF_PAIR, MU_REF_PAIR, factor } from '../data/contact.ts';
import type {
  BodyHandle,
  ColliderPart,
  CompoundBodySpec,
  CubeSpec,
  EntityId,
  ImpactEvent,
  JointHandle,
  PartShape,
  PrismaticJointSpec,
  Quat,
  RevoluteJointSpec,
  RopeJointSpec,
  SurfaceId,
  Transform,
  Vec3,
} from '../types.ts';

/**
 * PhysicsWorld — THE ONLY MODULE THAT IMPORTS RAPIER (08 §5.1, lint-enforced).
 *
 * It exposes opaque `BodyHandle`s and plain vectors. That firewall is the engine-swap
 * seam, and it is why unit tests never need wasm.
 *
 * Everything is SI at true scale (08 §2.7), and the timestep is FIXED — the world is
 * never stepped at a rate that depends on what happens to be in it. See `step()`.
 */

const GRAVITY_MPS2 = config.physics.gravityMps2;

/**
 * Rapier's `Multiply` rule is what makes the separable pair model of `data/contact.ts`
 * come out right, and every collider must use it or the pair is silently something else.
 * Both coefficients go through `factor()`; see that file for the algebra.
 */
const PAIR_RULE = RAPIER.CoefficientCombineRule.Multiply;

/** A cube corner sits sqrt(3) half-extents from the centre — the angular sweep lever arm. */
const CORNER_OVER_HALF = Math.sqrt(3);

/** Shared with the renderer so the drawn and simulated cube are the same solid. */
const RENDER_CHAMFER_FRACTION = config.geometry.chamferFraction;

/**
 * Mass properties for a chamfered cube of outer side `s` and density `rho`.
 *
 * These are set EXPLICITLY rather than left to `setDensity`, because Rapier 0.19.3
 * derives a `roundCuboid`'s mass properties from the INNER box alone — the border radius
 * contributes no mass and no inertia. Measured against the installed build: for any
 * radius, `mass == rho * (2h)^3` exactly and `I == m*(2h)^2/6` exactly. At our 3 %
 * chamfer that is a **16.75 % light** cube and an inertia **11.6 % low**, which would
 * have quietly undone the one property this project most depends on — that the mass on
 * the info card is the mass in the simulation.
 *
 * So:
 * - **mass = rho * s^3**, the advertised figure `data/metals.ts` computes. The true
 *   chamfered solid is 0.23 % smaller than that; a real machined cube is sold at its
 *   nominal mass, and 0.23 % is well inside WHA's own supplier-to-supplier density
 *   spread, so this is the honest number rather than a flattering one.
 * - **I = m*s^2/6**, the ideal cube. Numerically integrating the actual rounded solid
 *   gives 0.166177*m*s^2 against the ideal 0.166667 — **0.29 % low**, versus Rapier's
 *   11.64 %. Isotropic, so the principal frame is the identity.
 */
function cubeMassProperties(s: number, rho: number): { mass: number; inertia: number } {
  const mass = rho * s ** 3;
  return { mass, inertia: (mass * s * s) / 6 };
}

/** Rapier wants a local principal frame; a cube's inertia is isotropic, so: identity. */
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };

/** Per-body bookkeeping the public surface never exposes. */
interface Rec {
  handle: BodyHandle;
  body: RAPIER.RigidBody;
  /**
   * EVERY collider on this body, not just the first.
   *
   * It was a single collider until compound instrument bodies arrived (15 §8.2): a
   * balance beam is a bar plus a keel, a pan is a floor plus a rim. Anything that walks
   * contacts, materials or teardown has to see all of them, and `#byCollider` maps each
   * one back here.
   */
  colliders: RAPIER.Collider[];
  massKg: number;
  /** Set for statics: what the impact bus reports as the partner. */
  surface?: SurfaceId;
  /** Set for dynamics: the EntityStore id, so impacts can name who hit what. */
  entityId?: EntityId;
  /**
   * Pre-step velocity snapshot. Impact energy MUST be computed from these: by the time
   * the contact-force event is drained, the solver has already resolved the real
   * velocities to ~0 and a post-step reading reports a silent landing (08 §8.1).
   */
  prevLin: Vec3;
  prevAng: Vec3;
  prevCom: Vec3;
  /** Mirrors Rapier's CCD flag so we only toggle it on an actual change. */
  ccd: boolean;
  /** Half-side, metres. Sets this body's own CCD sweep threshold — see `#updateCcd`. */
  halfExtent: number;
  /** Outer side, metres. Dynamics only — the purity slider needs it to re-derive mass. */
  sideM?: number;
  /**
   * How a compound was described, kept so the debug overlay can draw what the SOLVER
   * sees rather than what the artist supplied. On an instrument those differ by design:
   * 15 §1 drives the physics from simplified procedural colliders, never from the GLB's
   * render triangles, and an overlay that draws the mesh would hide exactly the
   * mismatch it exists to reveal.
   */
  parts?: readonly ColliderPart[];
}

interface JointRec {
  joint: RAPIER.ImpulseJoint;
  bodyA: BodyHandle;
  bodyB: BodyHandle;
}

/** The smallest half-extent of a shape — a body's own CCD sweep threshold. */
function minHalfExtent(shape: PartShape): number {
  switch (shape.kind) {
    case 'box':
    case 'roundedBox':
      return Math.min(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    case 'cylinder':
      return Math.min(shape.halfHeightM, shape.radiusM);
  }
}

/** Volume of a part's shape, for turning a requested mass into a collider density. */
function partVolume(shape: PartShape): number {
  switch (shape.kind) {
    case 'box':
      return 8 * shape.halfExtents.x * shape.halfExtents.y * shape.halfExtents.z;
    case 'roundedBox': {
      /*
       * The INNER box, shrunk by the border radius on every axis.
       *
       * Two facts compose here and it is easy to get half of it right. Rapier's
       * `roundCuboid` GROWS the box it is given by `borderRadius`, so `#createPart` asks
       * for `half - r` to land on the advertised outer size. And Rapier derives a
       * roundCuboid's mass from that inner box ALONE, giving the rounded border no mass
       * at all (14 PHY-07). So the volume the density is divided into has to be the inner
       * one: using the outer half-extents here made every rounded part come out light by
       * ((h - r)/h)^3 — 15 % on a part with a 5 % radius, silently.
       */
      const h = shape.halfExtents;
      const r = shape.borderRadiusM;
      return 8 * Math.max(0, h.x - r) * Math.max(0, h.y - r) * Math.max(0, h.z - r);
    }
    case 'cylinder':
      return Math.PI * shape.radiusM * shape.radiusM * 2 * shape.halfHeightM;
  }
}

export class PhysicsWorld {
  #world!: RAPIER.World;
  /** Cached so `#updateCcd` can predict a step's velocity without a wasm call per body. */
  readonly #gravity: Vec3 = { x: 0, y: -GRAVITY_MPS2, z: 0 };
  #events!: RAPIER.EventQueue;
  #recs = new Map<BodyHandle, Rec>();
  #byCollider = new Map<number, BodyHandle>();
  #nextHandle = 1;
  /** Bodies that had a user force OR torque applied this step, so we know what to zero. */
  #forced = new Set<BodyHandle>();
  #joints = new Map<JointHandle, JointRec>();
  #nextJoint = 1;

  private constructor() {}

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    // Pre-grow the wasm heap: phones show the first-seconds GC hitch far more than
    // desktops do, and it lands exactly during the first drop (12 §2).
    RAPIER.reserveMemory(8 * 1024 * 1024);

    const pw = new PhysicsWorld();
    pw.#world = new RAPIER.World({ x: 0, y: -GRAVITY_MPS2, z: 0 });
    pw.#world.timestep = config.loop.DT;
    pw.#world.numSolverIterations = config.stability.solverIterations;
    // Rapier defaults this to 1, which is not enough for a 60:1 size range — see the
    // measurements quoted on config.stability.maxCcdSubsteps. Set explicitly, never
    // inherited: a default that silently changes between versions is not a decision.
    pw.#world.integrationParameters.maxCcdSubsteps = config.stability.maxCcdSubsteps;
    // Tell Rapier the world is measured in something other than metres, rather than
    // rescaling our own geometry. Measured to buy ~1.5 points on the size-ratio case, so
    // it stays at 1 and the world stays in real metres.
    if (config.stability.lengthUnit !== 1) pw.#world.lengthUnit = config.stability.lengthUnit;
    // Contact tolerances sized for our smallest cube, not for human-scale props — see
    // the rationale in config.stability.allowedLinearError.
    pw.#world.integrationParameters.normalizedAllowedLinearError =
      config.stability.allowedLinearError;
    pw.#world.integrationParameters.normalizedPredictionDistance =
      config.stability.predictionDistance;
    pw.#events = new RAPIER.EventQueue(true);
    return pw;
  }

  // ---- construction ----------------------------------------------------------

  addCube(spec: CubeSpec, at: Vec3, opts?: { ccd?: boolean; entityId?: EntityId }): BodyHandle {
    const s = spec.sideM;
    const metal = METALS[spec.metal];
    const density = densityOf(spec.metal, spec.purityPctW);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(at.x, at.y, at.z)
      .setCcdEnabled(opts?.ccd ?? false)
      // Off by measurement, not by omission — see config.stability.softCcdFraction.
      .setSoftCcdPrediction((s / 2) * config.stability.softCcdFraction);

    /*
     * NO SIZE-THRESHOLD DAMPING (14 PHY-05).
     *
     * Cubes under 1" used to get linear damping 0.05 and angular 0.1 "for stability".
     * Rapier's own docs call damping a way to fake air friction, and that is exactly what
     * it did here: a 0.25" cube in vacuum fell at -9.568 m/s after one second where a 15"
     * cube fell at -9.810, a 2.5 % error and a hard discontinuity at exactly one inch.
     * Free fall is the one result this app must not get wrong, so the lever is gone. The
     * jitter gate is met without it — see `tests/physics/resting.test.ts`.
     */
    const body = this.#world.createRigidBody(bodyDesc);

    /*
     * Rounded collider, matching the renderer's chamfer (14 PHY-07). Rapier's
     * `roundCuboid` GROWS the box by `borderRadius`, so the half-extent is reduced by the
     * radius to keep the advertised outer side exactly `s`. Mass properties are set
     * explicitly — see `cubeMassProperties` for why `setDensity` cannot be trusted here.
     */
    const r = s * RENDER_CHAMFER_FRACTION;
    const half = s / 2 - r;
    const mp = cubeMassProperties(s, density);
    const colDesc = RAPIER.ColliderDesc.roundCuboid(half, half, half, r)
      .setMassProperties(
        mp.mass,
        ORIGIN,
        { x: mp.inertia, y: mp.inertia, z: mp.inertia },
        IDENTITY_ROTATION,
      )
      .setFriction(factor(metal.friction, MU_REF_PAIR))
      .setFrictionCombineRule(PAIR_RULE)
      .setRestitution(factor(metal.restitution, E_REF_PAIR))
      .setRestitutionCombineRule(PAIR_RULE)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      // 0 = report every contact force. The gate that decides what is an *impact* is
      // ours (§8.1), not Rapier's — a threshold here would silently drop soft landings.
      .setContactForceEventThreshold(0);

    const collider = this.#world.createCollider(colDesc, body);
    return this.#register(body, [collider], {
      halfExtent: s / 2,
      sideM: s,
      ccd: opts?.ccd ?? false,
      ...(opts?.entityId !== undefined ? { entityId: opts.entityId } : {}),
    });
  }

  /**
   * The stage floor and a lab's mats (08 §6). Returns a handle so a caller can name the
   * box again — to read contact force on it, to swap its surface, or to remove it at
   * teardown.
   */
  addStaticBox(halfExtents: Vec3, at: Vec3, surface: SurfaceId): BodyHandle {
    const spec = SURFACES[surface];
    const body = this.#world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z),
    );
    const collider = this.#world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(factor(spec.friction, MU_REF_PAIR))
        .setFrictionCombineRule(PAIR_RULE)
        .setRestitution(factor(spec.restitution, E_REF_PAIR))
        .setRestitutionCombineRule(PAIR_RULE)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body,
    );
    return this.#register(body, [collider], {
      surface,
      halfExtent: Math.min(halfExtents.x, halfExtents.y, halfExtents.z),
    });
  }

  /**
   * A body built from several posed colliders (15 §8.2) — an instrument, not a cube.
   *
   * Mass comes from per-part `massKg` turned into a density, never from
   * `setAdditionalMassProperties`. That is deliberate: it means the compound's centre of
   * mass is computed by Rapier from *where the parts are*, so a balance beam whose keel
   * hangs below its pivot has a below-pivot COM as a consequence of its construction
   * rather than as a number someone typed. 15 §6.2 turns on exactly that distinction —
   * a declared COM would let the beam claim a restoring moment its visible shape does
   * not have.
   */
  addCompound(spec: CompoundBodySpec): BodyHandle {
    const desc =
      spec.kind === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(spec.at.x, spec.at.y, spec.at.z);
    if (spec.kind === 'dynamic') desc.setCcdEnabled(spec.ccd ?? false);
    if (spec.additionalSolverIterations) {
      desc.setAdditionalSolverIterations(spec.additionalSolverIterations);
    }
    const body = this.#world.createRigidBody(desc);

    const colliders = spec.parts.map((part) => this.#createPart(body, part));
    let smallestHalf = Infinity;
    for (const part of spec.parts) smallestHalf = Math.min(smallestHalf, minHalfExtent(part.shape));

    return this.#register(body, colliders, {
      halfExtent: Number.isFinite(smallestHalf) ? smallestHalf : 0.05,
      ccd: spec.ccd ?? false,
      parts: spec.parts,
      // Every part names a surface, and the impact bus reports one partner material, so
      // the first part's is what it speaks for. Instruments are single-material in
      // practice (a steel balance, an aluminium scale); if that stops being true this is
      // the line that has to grow a per-collider lookup.
      ...(spec.parts[0] ? { surface: spec.parts[0].material } : {}),
    });
  }

  #createPart(body: RAPIER.RigidBody, part: ColliderPart): RAPIER.Collider {
    const shape = part.shape;
    let cd: RAPIER.ColliderDesc;
    switch (shape.kind) {
      case 'box':
        cd = RAPIER.ColliderDesc.cuboid(
          shape.halfExtents.x,
          shape.halfExtents.y,
          shape.halfExtents.z,
        );
        break;
      case 'roundedBox':
        cd = RAPIER.ColliderDesc.roundCuboid(
          shape.halfExtents.x - shape.borderRadiusM,
          shape.halfExtents.y - shape.borderRadiusM,
          shape.halfExtents.z - shape.borderRadiusM,
          shape.borderRadiusM,
        );
        break;
      case 'cylinder':
        cd = RAPIER.ColliderDesc.cylinder(shape.halfHeightM, shape.radiusM);
        break;
    }

    const surf = SURFACES[part.material];
    cd.setFriction(factor(surf.friction, MU_REF_PAIR))
      .setFrictionCombineRule(PAIR_RULE)
      .setRestitution(factor(surf.restitution, E_REF_PAIR))
      .setRestitutionCombineRule(PAIR_RULE)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(0);

    if (part.at) cd.setTranslation(part.at.x, part.at.y, part.at.z);
    if (part.rotation) cd.setRotation(part.rotation);
    if (part.massKg !== undefined) {
      const v = partVolume(shape);
      cd.setDensity(v > 0 ? part.massKg / v : 0);
    }
    return this.#world.createCollider(cd, body);
  }

  // ---- joints -----------------------------------------------------------------

  /**
   * A hinge. `limitsRad` is applied AFTER creation, and that is not a style choice:
   * `JointData.limitsEnabled`/`.limits` are **silently ignored** for revolute joints in
   * Rapier 0.19.3 (the raw binding takes no limit arguments, unlike the prismatic one),
   * and TypeScript accepts the fields either way. Measured in the W0 spike: a beam with a
   * 12 degree limit set through JointData spun 359.99 degrees under torque, where
   * `setLimits()` afterwards held it at exactly 12.00.
   */
  addRevoluteJoint(spec: RevoluteJointSpec): JointHandle {
    const a = this.#must(spec.bodyA);
    const b = this.#must(spec.bodyB);
    const jd = RAPIER.JointData.revolute(spec.anchorA, spec.anchorB, spec.axis);
    const joint = this.#world.createImpulseJoint(jd, a.body, b.body, true);
    if (spec.limitsRad) {
      (joint as RAPIER.RevoluteImpulseJoint).setLimits(spec.limitsRad[0], spec.limitsRad[1]);
    }
    return this.#registerJoint(joint, spec.bodyA, spec.bodyB);
  }

  /**
   * A slider. Unlike revolute, prismatic DOES honour limits set on the JointData — but
   * they go through `setLimits` here too, so one code path covers both and nobody has to
   * remember which joint type is which.
   *
   * Limits are SOFT. Measured: 400 N on a 0.2 kg slider pushed a 10 mm stop to 44.9 mm.
   * They bound travel; they are not a wall, and nothing may rely on one for containment.
   */
  addPrismaticJoint(spec: PrismaticJointSpec): JointHandle {
    const a = this.#must(spec.bodyA);
    const b = this.#must(spec.bodyB);
    const jd = RAPIER.JointData.prismatic(spec.anchorA, spec.anchorB, spec.axis);
    const joint = this.#world.createImpulseJoint(jd, a.body, b.body, true);
    if (spec.limitsM) {
      (joint as RAPIER.PrismaticImpulseJoint).setLimits(spec.limitsM[0], spec.limitsM[1]);
    }
    return this.#registerJoint(joint, spec.bodyA, spec.bodyB);
  }

  /**
   * A maximum-distance tether — it pulls, never pushes. Three per pan make a bridle.
   *
   * CREATION ORDER MATTERS. Rapier walks constraints in the order they were made with a
   * finite iteration count, so whichever bridle is built last has the smallest residual.
   * Building one pan's ropes and then the other's left the first 0.15 mm over-extended
   * and the beam resting 1.0 degrees off zero under equal loads; interleaving the two
   * sides took that to 0.07. A caller building a symmetric assembly must interleave.
   */
  addRopeJoint(spec: RopeJointSpec): JointHandle {
    const a = this.#must(spec.bodyA);
    const b = this.#must(spec.bodyB);
    const jd = RAPIER.JointData.rope(spec.maxLengthM, spec.anchorA, spec.anchorB);
    const joint = this.#world.createImpulseJoint(jd, a.body, b.body, true);
    return this.#registerJoint(joint, spec.bodyA, spec.bodyB);
  }

  removeJoint(h: JointHandle): void {
    const rec = this.#joints.get(h);
    if (!rec) return;
    this.#joints.delete(h);
    this.#world.removeImpulseJoint(rec.joint, true);
  }

  /**
   * The collider parts a compound was built from, for debug drawing. Empty for a cube,
   * which is one implicit part and has `sideM` instead.
   */
  partsOf(h: BodyHandle): readonly ColliderPart[] {
    return this.#recs.get(h)?.parts ?? [];
  }

  /** Every live body. The debug overlay needs this to draw what is not an entity. */
  allBodies(): BodyHandle[] {
    return [...this.#recs.keys()];
  }

  /** Whether a handle still names a live joint — the safe check teardown needs. */
  hasJoint(h: JointHandle): boolean {
    return this.#joints.has(h);
  }

  get jointCount(): number {
    return this.#joints.size;
  }

  #registerJoint(joint: RAPIER.ImpulseJoint, bodyA: BodyHandle, bodyB: BodyHandle): JointHandle {
    const handle = this.#nextJoint++ as JointHandle;
    this.#joints.set(handle, { joint, bodyA, bodyB });
    return handle;
  }

  #register(
    body: RAPIER.RigidBody,
    colliders: RAPIER.Collider[],
    extra: {
      surface?: SurfaceId;
      entityId?: EntityId;
      halfExtent?: number;
      ccd?: boolean;
      sideM?: number;
      parts?: readonly ColliderPart[];
    },
  ): BodyHandle {
    const handle = this.#nextHandle++ as BodyHandle;
    const rec: Rec = {
      handle,
      body,
      colliders,
      massKg: body.mass(),
      prevLin: { x: 0, y: 0, z: 0 },
      prevAng: { x: 0, y: 0, z: 0 },
      prevCom: { ...at(body) },
      // Mirror what the body was actually CREATED with. Hardcoding `false` here meant a
      // body made with `ccd: true` was recorded as CCD-off, so the first `#updateCcd`
      // pass that agreed with the record skipped the toggle and left Rapier's real flag
      // untouched — the bookkeeping and the engine disagreed from birth (14 PHY-04).
      ccd: extra.ccd ?? false,
      halfExtent: extra.halfExtent ?? 0.05,
      ...(extra.sideM !== undefined ? { sideM: extra.sideM } : {}),
      ...(extra.parts !== undefined ? { parts: extra.parts } : {}),
      ...(extra.surface !== undefined ? { surface: extra.surface } : {}),
      ...(extra.entityId !== undefined ? { entityId: extra.entityId } : {}),
    };
    this.#recs.set(handle, rec);
    for (const c of colliders) this.#byCollider.set(c.handle, handle);
    return handle;
  }

  remove(h: BodyHandle): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    // Joints before the body (15 §8.2). Rapier drops a body's joints for us, but our own
    // JointHandle map would keep pointing at freed constraints — and a stale handle that
    // still answers `hasJoint` is exactly the bug teardown tests are supposed to catch.
    for (const [jh, jrec] of [...this.#joints]) {
      if (jrec.bodyA === h || jrec.bodyB === h) this.removeJoint(jh);
    }
    for (const c of rec.colliders) this.#byCollider.delete(c.handle);
    this.#recs.delete(h);
    this.#forced.delete(h);
    this.#world.removeRigidBody(rec.body); // removes its colliders too
  }

  /** Whether a handle still names a live body — the safe check teardown needs. */
  hasBody(h: BodyHandle): boolean {
    return this.#recs.has(h);
  }

  // ---- forces & mutation ------------------------------------------------------

  /**
   * At the centre of mass. Applies for exactly one step — see `#clearAppliedForces`.
   */
  applyForce(h: BodyHandle, forceN: Vec3): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.addForce(forceN, true);
    this.#forced.add(h);
  }

  /**
   * The Hand grabs off-centre, so it needs the torque this produces (08 §8.4). Applying
   * at the COM instead is a silent no-op for rotation: a cube grabbed by its corner
   * would swing exactly like one grabbed dead centre, and half the "this thing is heavy
   * and badly balanced" reading would vanish.
   */
  applyForceAtPoint(h: BodyHandle, forceN: Vec3, pointWorld: Vec3): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.addForceAtPoint(forceN, pointWorld, true);
    this.#forced.add(h);
  }

  /**
   * Purity edits mutate the collider in place (08 §9.2). Density is NOT set-at-creation-
   * only, and rebuilding the body would drop its velocity, its contacts and its grab.
   */
  setDensity(h: BodyHandle, kgPerM3: number): void {
    const rec = this.#recs.get(h);
    if (!rec || rec.sideM === undefined) return;
    /*
     * Goes through the SAME law as creation (`cubeMassProperties`), not through
     * `collider.setDensity`. Rapier's docs are explicit that setDensity "overrides any
     * previous mass-properties set by setMassProperties", so the obvious one-liner here
     * would have silently reverted this body to Rapier's inner-box approximation — a
     * cube that weighed the right amount until you touched the purity slider, and 16.75 %
     * too little afterwards. Exactly the failure mode this method's own comment warns of.
     */
    const mp = cubeMassProperties(rec.sideM, kgPerM3);
    rec.colliders[0]!.setMassProperties(
      mp.mass,
      ORIGIN,
      { x: mp.inertia, y: mp.inertia, z: mp.inertia },
      IDENTITY_ROTATION,
    );
    /*
     * The recompute is NOT optional. Rapier propagates a collider's mass properties to
     * its body "at the next physics step, or manually via
     * recomputeMassPropertiesFromColliders" — so reading `body.mass()` straight after
     * setDensity returns the OLD mass, and whatever we cache from it stays wrong.
     *
     * That produced the worst possible failure mode for this product: dragging the
     * purity slider updated the info card (which derives mass from the spec) while the
     * simulation kept the old mass. The number on screen and the thing on screen would
     * have disagreed, which is pillar 2 (01) inverted.
     */
    rec.body.recomputeMassPropertiesFromColliders();
    rec.massKg = rec.body.mass();
  }

  /**
   * A pure torque, for exactly one step.
   *
   * Registered in the SAME `#forced` set as `applyForce`, because Rapier's torques are
   * as persistent as its forces: `addTorque` accumulates until `resetTorques`. A balance
   * whose pivot damping quietly compounded step after step would read as an instrument
   * that fights back harder the longer you watch it (15 §8.2 calls this out by name).
   */
  applyTorque(h: BodyHandle, torqueNm: Vec3): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.addTorque(torqueNm, true);
    this.#forced.add(h);
  }

  /** World-space centre of mass — for a compound, this is where its construction put it. */
  centerOfMassOf(h: BodyHandle): Vec3 {
    const c = this.#must(h).body.worldCom();
    return { x: c.x, y: c.y, z: c.z };
  }

  /**
   * Principal moments of inertia, body frame. An instrument needs this to size its own
   * damping: an explicit `-c*w` torque integrated by symplectic Euler amplifies once
   * `c*dt/I > 2`, so the only safe damper is one that knows the inertia it is fighting.
   */
  principalInertiaOf(h: BodyHandle): Vec3 {
    const i = this.#must(h).body.principalInertia();
    return { x: i.x, y: i.y, z: i.z };
  }

  /** Rapier has put this body to sleep: it is at rest and costing nothing. */
  isSleeping(h: BodyHandle): boolean {
    return this.#recs.get(h)?.body.isSleeping() ?? false;
  }

  /**
   * Linear damping — Rapier's own model of air friction.
   *
   * For INSTRUMENT bodies only. 14 PHY-05 deleted the equivalent on small cubes because
   * it corrupted the one result this app must not get wrong: a damped 0.25" cube fell at
   * -9.568 m/s where an undamped one fell at -9.810. A hanging pan is not measuring free
   * fall, and a pan that swings forever is not an instrument (15 §6.1).
   */
  setLinearDamping(h: BodyHandle, d: number): void {
    this.#recs.get(h)?.body.setLinearDamping(d);
  }

  setAngularDamping(h: BodyHandle, d: number): void {
    this.#recs.get(h)?.body.setAngularDamping(d);
  }

  /**
   * Manual override. Normally CCD is driven per step by `#updateCcd` from swept motion —
   * callers should not need this, and TheHand deliberately no longer touches it.
   */
  setCcd(h: BodyHandle, enabled: boolean): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.enableCcd(enabled);
    rec.ccd = enabled;
  }

  /** Current angular damping, so a temporary override can be restored to its real value. */
  angularDampingOf(h: BodyHandle): number {
    return this.#recs.get(h)?.body.angularDamping() ?? 0;
  }

  /** Writes the body's transform into caller-owned objects — allocation-free hot path. */
  readTransformInto(h: BodyHandle, outP: Vec3, outQ: Quat): void {
    const rec = this.#must(h);
    const p = rec.body.translation();
    const q = rec.body.rotation();
    outP.x = p.x;
    outP.y = p.y;
    outP.z = p.z;
    outQ.x = q.x;
    outQ.y = q.y;
    outQ.z = q.z;
    outQ.w = q.w;
  }

  /** Writes linear velocity into a caller-owned vector — allocation-free hot path. */
  readVelocityInto(h: BodyHandle, out: Vec3): void {
    const v = this.#must(h).body.linvel();
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
  }

  /** The same for angular velocity — a cube can rock or spin in place at |v| ≈ 0. */
  readAngularVelocityInto(h: BodyHandle, out: Vec3): void {
    const w = this.#must(h).body.angvel();
    out.x = w.x;
    out.y = w.y;
    out.z = w.z;
  }

  setTransform(h: BodyHandle, p: Vec3, zeroVelocity = false): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.setTranslation(p, true);
    if (zeroVelocity) {
      rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Direct velocity write. Not used by gameplay — the Hand works through forces so that
   * mass is felt — but the calibration suite has to launch a body at an exact speed to
   * infer a coefficient from its deceleration, and an impulse would have to be divided
   * by a mass the test is trying to measure.
   */
  setVelocity(h: BodyHandle, linear: Vec3, angular?: Vec3): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    rec.body.setLinvel(linear, true);
    if (angular) rec.body.setAngvel(angular, true);
  }

  // ---- reads ------------------------------------------------------------------

  /**
   * Handle lookup for reads that have no sensible answer if the body is gone. A stale
   * handle is always a bug upstream (something kept an id past a despawn), so name it
   * here rather than letting an undefined propagate into the solver as a NaN.
   */
  #must(h: BodyHandle): Rec {
    const rec = this.#recs.get(h);
    if (!rec) throw new Error(`[physics] stale BodyHandle ${h} — body was removed`);
    return rec;
  }

  transformOf(h: BodyHandle): Transform {
    const rec = this.#must(h);
    const p = rec.body.translation();
    const q = rec.body.rotation();
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  velocityOf(h: BodyHandle): Vec3 {
    const v = this.#must(h).body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  angularVelocityOf(h: BodyHandle): Vec3 {
    const w = this.#must(h).body.angvel();
    return { x: w.x, y: w.y, z: w.z };
  }

  /** v + ω×r at a world point. Current (not cached) values — The Hand runs pre-step. */
  velocityAtPoint(h: BodyHandle, pointWorld: Vec3): Vec3 {
    const v = this.#must(h).body.velocityAtPoint(pointWorld);
    return { x: v.x, y: v.y, z: v.z };
  }

  massOf(h: BodyHandle): number {
    return this.#recs.get(h)?.massKg ?? 0;
  }

  /**
   * Normal effective mass this body presents at a world-space contact, kg.
   *
   *     1/m_eff = 1/m + (r x n) . I^-1 (r x n)
   *
   * This is the inertia a contact actually feels, and it is NOT the body's mass unless
   * the contact is dead in line with the centre of mass. Struck on a corner an ideal cube
   * presents m/4, because it can rotate away from the blow.
   *
   * Public because it is the honest basis for any "how hard was that?" question — impact
   * telemetry uses it (see `#drainImpacts`), and Drop/Crush will need it before they can
   * claim a number. `n` is normalised here so callers cannot silently scale the answer.
   */
  normalEffectiveMassAt(h: BodyHandle, pointWorld: Vec3, normal: Vec3): number {
    const rec = this.#recs.get(h);
    if (!rec) return 0;
    const len = Math.hypot(normal.x, normal.y, normal.z);
    if (len === 0) return 0;
    const n = { x: normal.x / len, y: normal.y / len, z: normal.z / len };
    // Use the CURRENT centre of mass: this read is for callers asking about now, whereas
    // `#drainImpacts` deliberately asks about the pre-step pose.
    const com = at(rec.body);
    const inv = effectiveInvMassAbout(rec.body, com, pointWorld, n);
    return inv > 0 ? 1 / inv : 0;
  }

  isDynamic(h: BodyHandle): boolean {
    return this.#recs.get(h)?.body.isDynamic() ?? false;
  }

  raycast(
    originWorld: Vec3,
    dir: Vec3,
    maxDistance = 100,
  ): { handle: BodyHandle; point: Vec3; distance: number } | null {
    const ray = new RAPIER.Ray(originWorld, dir);
    const hit = this.#world.castRay(ray, maxDistance, true);
    if (!hit) return null;
    const handle = this.#byCollider.get(hit.collider.handle);
    if (handle === undefined) return null;
    const t = hit.timeOfImpact;
    return {
      handle,
      point: {
        x: originWorld.x + dir.x * t,
        y: originWorld.y + dir.y * t,
        z: originWorld.z + dir.z * t,
      },
      distance: t,
    };
  }

  /**
   * Total contact impulse on a body over the last step, as a force in **newtons**.
   *
   * The **sustained-force channel**: polled, continuous, and silent by nature. It is not,
   * and must not be, the impact channel (08 §8.1) — that one is evented and reports
   * energy.
   *
   * Implemented by summing solver contact impulses ÷ dt rather than by accumulating
   * contact-force *events*. 08 §14 flagged the event path as a risk (events fire only
   * above a threshold and can drop resting contacts); the impulse walk is the same number
   * with no event plumbing. Keep it that way — the event path looks equivalent and is not.
   *
   * **This is NOT the Weigh Station's readout**, and returning newtons rather than kg is
   * the point. It shipped as `contactForceOnKg`, dividing by g inside the physics layer,
   * which handed callers a mass they had not earned: 15 §7.2's honesty rule is force while
   * anything is moving and mass only after a stability test. The scale measures the
   * support force its own compliant transducer applies to a dynamic platter on a prismatic
   * joint — a modelled load cell, not a contact sum against a rigid static box.
   *
   * As a raw magnitude this projects onto no sensing axis, identifies no load path and
   * models no transducer bandwidth (14 PHY-12). That is correct for a facade primitive and
   * wrong for an instrument; anything that wants a reading owns that work itself. The
   * caller this exists for is 10 §1's quasi-static break trigger — the path that notices a
   * 64 kg cube being *lowered* onto an egg, where impact energy is near zero.
   */
  contactForceN(h: BodyHandle): number {
    const rec = this.#recs.get(h);
    if (!rec) return 0;
    let impulse = 0;
    // Every collider on the body: a compound platter or pan carries load on more than
    // one part, and summing only the first would under-read whatever the rim caught.
    for (const c of rec.colliders) {
      this.#world.contactPairsWith(c, (other) => {
        this.#world.contactPair(c, other, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i++) impulse += manifold.contactImpulse(i);
        });
      });
    }
    return impulse / this.#world.timestep;
  }

  // ---- the step ---------------------------------------------------------------

  /**
   * One fixed step. The timestep is CONSTANT — it is never derived from what is in the
   * world (14 PHY-04).
   *
   * The previous version chose a substep count from the world's fastest body and the
   * world's smallest body, which are in general two different objects. Three things
   * followed, all measured:
   *
   * 1. **Unrelated bodies changed each other's trajectories.** A 15" cube fell 15.0776 m
   *    in one second alone and 15.0902 m with a 0.25" cube somewhere else in the scene —
   *    12.6 mm of difference from an object it never touched, because the small body
   *    shrank the substep and the finer gravity integration moved the big one.
   * 2. **It did not actually bound swept motion.** The `< 1.5 m/s` early-out contradicted
   *    the travel criterion it was supposed to enforce, and the 12-substep ceiling could
   *    not satisfy that criterion above ~1.37 m/s for the smallest cube anyway.
   * 3. **It tunnelled regardless.** Against a 10 mm plate it went straight through in 5
   *    of 6 speed/size cases; pre-step CCD held all 6.
   *
   * So: fixed step, and swept motion is handled per body by CCD chosen BEFORE the step
   * that needs it, from linear *and* angular sweep against that body's own size.
   */
  step(dt: number, outImpacts: ImpactEvent[]): void {
    this.#world.timestep = dt;
    // Order matters: clamp, then choose CCD from the speeds we are actually going to
    // integrate, then step. Deciding CCD from POST-step speed (as this used to) leaves
    // the first step over the threshold — the one that does the tunnelling — unprotected.
    this.#clampSpeeds();
    this.#updateCcd(dt);
    this.#snapshotVelocities();
    this.#world.step(this.#events);
    this.#clearAppliedForces();
    this.#drainImpacts(outImpacts);
    this.#nanWatchdog();
  }

  /** Snapshot BEFORE the solver touches anything (see Rec.prevLin). Mutates in place. */
  #snapshotVelocities(): void {
    for (const rec of this.#recs.values()) {
      if (!rec.body.isDynamic()) continue;
      const v = rec.body.linvel();
      const w = rec.body.angvel();
      const c = rec.body.worldCom();
      // Field-by-field rather than fresh object literals: this runs for every body on
      // every step, and object churn here is what turns 60 fps into 50 after a minute.
      rec.prevLin.x = v.x;
      rec.prevLin.y = v.y;
      rec.prevLin.z = v.z;
      rec.prevAng.x = w.x;
      rec.prevAng.y = w.y;
      rec.prevAng.z = w.z;
      rec.prevCom.x = c.x;
      rec.prevCom.y = c.y;
      rec.prevCom.z = c.z;
    }
  }

  /**
   * Absolute speed ceiling, applied BEFORE integration so it actually bounds travel.
   *
   * This is a fail-safe, not physics: it exists so a numerical blow-up cannot launch a
   * body across the world in one step. Applied after the step (as it used to be) it was
   * strictly worse than useless — a 1.5" cube given 6,000 N for one step moved 1.046 m
   * during that step and *then* reported a tidy 50.0 m/s, so the cap neither prevented
   * the swept-collision failure nor left the momentum honest (14 §4.6).
   */
  #clampSpeeds(): void {
    const maxV = config.stability.maxSpeedMps;
    for (const rec of this.#recs.values()) {
      if (!rec.body.isDynamic()) continue;
      const v = rec.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > maxV) {
        const k = maxV / speed;
        rec.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
      }
    }
  }

  /**
   * Choose CCD per body from the sweep it is ABOUT to make, relative to its own size.
   *
   * Both terms matter. A cube can be nearly stationary at its centre and still whip a
   * corner through a plane: the corner sits sqrt(3) half-extents out, so its speed is
   * `|v| + |w| * sqrt(3) * halfExtent`. The old test was post-step `|v| > 5 m/s`, which
   * is blind to spin and always one step late.
   *
   * CCD lives here rather than in TheHand because the Hand was disabling it on release —
   * precisely when a thrown cube is fastest and needs it most (found by audit).
   */
  #updateCcd(dt: number): void {
    for (const rec of this.#recs.values()) {
      if (!rec.body.isDynamic()) continue;
      const v = rec.body.linvel();
      const w = rec.body.angvel();

      /*
       * PREDICT the velocity this step will produce, do not read the one it starts with.
       *
       * Reading the current velocity is still one step late whenever a force is what
       * makes the body fast. Measured: a 1.5" cube at rest given 6,000 N for one step
       * moves 1.046 m during that step — it begins at zero, so a current-velocity test
       * sees a stationary body and leaves CCD off for exactly the step that needed it.
       * Adding `F/m` and gravity turns the test into a genuine forward prediction.
       */
      const invM = rec.body.invMass();
      const f = rec.body.userForce();
      const vx = v.x + (f.x * invM + this.#gravity.x) * dt;
      const vy = v.y + (f.y * invM + this.#gravity.y) * dt;
      const vz = v.z + (f.z * invM + this.#gravity.z) * dt;

      // Same for spin. The inverse inertia is anisotropic in general, so take its largest
      // diagonal term — this is a threshold test, and over-estimating only turns CCD on
      // slightly early.
      const I = rec.body.effectiveWorldInvInertia();
      const invI = Math.max(I.m11, I.m22, I.m33);
      const t = rec.body.userTorque();
      const wMag = Math.hypot(w.x, w.y, w.z) + Math.hypot(t.x, t.y, t.z) * invI * dt;

      const cornerR = rec.halfExtent * CORNER_OVER_HALF;
      const sweep = (Math.hypot(vx, vy, vz) + wMag * cornerR) * dt;
      const wantCcd = sweep > rec.halfExtent * config.stability.ccdSweepFraction;
      if (wantCcd !== rec.ccd) {
        rec.body.enableCcd(wantCcd);
        rec.ccd = wantCcd;
      }
    }
  }

  /**
   * Rapier's `addForce`/`addForceAtPoint` are PERSISTENT: they add to an accumulator
   * that keeps being applied every step until `resetForces` is called. They are not
   * per-step forces, despite reading like them.
   *
   * Without this, The Hand's clamp silently stops meaning anything. Applying "350 N"
   * each step accumulates — 350, 700, 1050 … — so by the second step it exceeds a 6"
   * tungsten cube's 625 N weight and the cube that is supposed to be unliftable sails
   * into the air. The force cap IS the signature mechanic (01), so this failure mode
   * looks like the toy working while quietly deleting the whole point of it.
   *
   * Found at M0 by measuring: the grab point tracked its target to within 1 mm while
   * the meter reported a saturated 350 N clamp against a 625 N load.
   *
   * `wakeUp: false` — resetting a force must never be a reason to wake a sleeping body.
   */
  #clearAppliedForces(): void {
    if (this.#forced.size === 0) return;
    for (const h of this.#forced) {
      const rec = this.#recs.get(h);
      if (!rec) continue;
      rec.body.resetForces(false);
      rec.body.resetTorques(false);
    }
    this.#forced.clear();
  }

  #drainImpacts(out: ImpactEvent[]): void {
    this.#events.drainContactForceEvents((ev) => {
      const hA = this.#byCollider.get(ev.collider1());
      const hB = this.#byCollider.get(ev.collider2());
      if (hA === undefined || hB === undefined) return;
      const a = this.#recs.get(hA)!;
      const b = this.#recs.get(hB)!;
      // At least one side must be dynamic, or there is nothing to have moved.
      if (!a.body.isDynamic() && !b.body.isDynamic()) return;

      const forceN = ev.totalForceMagnitude();

      // The contact point comes from a manifold query — TempContactForceEvent carries
      // only the collider pair, force magnitudes and a direction, never a position
      // (verified against 0.19.3's .d.ts; audit 2026-08-09).
      // The colliders from the EVENT, not the bodies' first ones. On a compound body
      // those differ, and querying the wrong pair returns a manifold that never existed.
      const c1 = this.#world.getCollider(ev.collider1());
      const c2 = this.#world.getCollider(ev.collider2());
      const contact = c1 && c2 ? this.#deepestContact(c1, c2) : null;
      if (!contact) return;

      // Orient the normal from A toward B ourselves rather than trusting the manifold's
      // convention plus the `flipped` flag. Self-correcting, and it makes the sign of
      // the closing speed below unambiguous.
      let n = contact.normal;
      const dx = b.prevCom.x - a.prevCom.x;
      const dy = b.prevCom.y - a.prevCom.y;
      const dz = b.prevCom.z - a.prevCom.z;
      if (n.x * dx + n.y * dy + n.z * dz < 0) n = { x: -n.x, y: -n.y, z: -n.z };

      // Velocity AT THE CONTACT POINT, not at the centre of mass: a tumbling cube
      // landing on a corner carries most of its impact energy in the rotation, and a
      // COM-only reading under-reports it badly (08 §8.1).
      const va = pointVelocity(a, contact.point);
      const vb = pointVelocity(b, contact.point);
      const rel = { x: va.x - vb.x, y: va.y - vb.y, z: va.z - vb.z };
      const normalSpeedMps = rel.x * n.x + rel.y * n.y + rel.z * n.z;

      /*
       * NORMAL EFFECTIVE MASS at this contact — not the reduced mass of two point
       * masses (14 PHY-06).
       *
       *   1/m_eff = 1/mA + 1/mB + (rA x n)*IA^-1*(rA x n) + (rB x n)*IB^-1*(rB x n)
       *
       * The rotational terms are the whole point. A rigid cube struck on a CORNER can
       * spin away from the blow, so it presents far less inertia to the contact than its
       * mass: for an ideal cube, r = (s/2)(1,1,1) and I = m*s^2/6 give |r x n|^2 = s^2/2
       * and a rotational term of 3/m, so m_eff = m/4. The old formula used the full m and
       * therefore over-reported an ideal corner impact's energy by exactly 4x.
       */
      const invMassNormal =
        effectiveInvMass(a, contact.point, n) + effectiveInvMass(b, contact.point, n);
      const effectiveMassKg = invMassNormal > 0 ? 1 / invMassNormal : 0;
      let energyJ = 0.5 * effectiveMassKg * normalSpeedMps * normalSpeedMps;

      /*
       * An impact can never dissipate more than the bodies actually had. m_eff is a
       * contact-local quantity and the normal speed is read at one point of a manifold,
       * so nothing in the algebra above forbids the product from exceeding the real
       * pre-impact kinetic energy — clamp it to the budget rather than report an
       * impossible number (14 §9, "Impact energy").
       */
      const budgetJ = kineticEnergy(a) + kineticEnergy(b);
      if (energyJ > budgetJ) energyJ = budgetJ;

      // TWO SEPARATE CHANNELS, AND-ed, never OR-ed. An earlier draft emitted on
      // `forceN > 3 || energyJ > 0.005`, which fires forever under any resting cube
      // heavier than ~300 g — "rests are silent" would have been false immediately.
      // forceN rides along as data; it never authorises an impact by itself.
      if (energyJ <= config.impact.minEnergyJ) return;
      if (normalSpeedMps <= config.impact.minNormalSpeedMps) return;

      // NO DEBOUNCE HERE. A per-pair cooldown used to live at this line; it is
      // presentation, it belongs to the ear, and while it sat in the physics signal path
      // it silently swallowed real rapid rebounds for every other consumer. It now lives
      // in `fx/audio.ts` (14 PHY-06).

      // Report the dynamic body as `a`; a static partner reports as its SurfaceId.
      const aIsDyn = a.body.isDynamic();
      const primary = aIsDyn ? a : b;
      const partner = aIsDyn ? b : a;
      out.push({
        a: primary.entityId ?? -1,
        b: partner.surface ?? partner.entityId ?? -1,
        point: contact.point,
        normalSpeedMps,
        energyJ,
        effectiveMassKg,
        forceN,
        contactCount: contact.count,
      });
    });
  }

  /**
   * Deepest solver contact for a pair, in world space, with the manifold normal and how
   * many contacts it was chosen from.
   *
   * `count` is reported rather than hidden: Rapier's force event is an aggregate over the
   * whole pair, and pinning it to one point is a simplification. A flat landing has four
   * contacts sharing the load; a corner landing has one. Consumers that care can tell.
   */
  #deepestContact(
    c1: RAPIER.Collider,
    c2: RAPIER.Collider,
  ): { point: Vec3; normal: Vec3; count: number } | null {
    let best: { point: Vec3; normal: Vec3; count: number } | null = null;
    let bestDist = Infinity;
    let total = 0;
    this.#world.contactPair(c1, c2, (manifold) => {
      const n = manifold.normal();
      const count = manifold.numSolverContacts();
      total += count;
      for (let i = 0; i < count; i++) {
        const d = manifold.solverContactDist(i);
        if (d < bestDist) {
          const p = manifold.solverContactPoint(i);
          bestDist = d;
          best = {
            point: { x: p.x, y: p.y, z: p.z },
            normal: { x: n.x, y: n.y, z: n.z },
            count: 0,
          };
        }
      }
    });
    if (best) (best as { count: number }).count = total;
    return best;
  }

  /**
   * Any non-finite translation -> teleport to the tray, zero velocities, leave a
   * breadcrumb (05). A NaN that propagates through the solver takes the whole scene
   * with it, and it is invisible until everything vanishes at once.
   */
  #nanWatchdog(): void {
    for (const rec of this.#recs.values()) {
      if (!rec.body.isDynamic()) continue;
      const p = rec.body.translation();
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) continue;
      console.warn('[physics] non-finite body, recovering to the tray', rec.handle);
      this.setTransform(rec.handle, config.stage.trayCentre, true);
    }
  }

  /** Debug/testing only. */
  get bodyCount(): number {
    return this.#recs.size;
  }

  /**
   * The gravity this world runs at. Exposed so nothing downstream — a readout, a smoke
   * test, a future scale — has to keep its own copy of g and watch it drift (14 PHY-14).
   */
  get gravityMps2(): number {
    return GRAVITY_MPS2;
  }

  free(): void {
    this.#events.free();
    this.#world.free();
    this.#recs.clear();
    this.#byCollider.clear();
    // The world owns the joints and has just been freed, so these are dangling wrappers.
    // Left behind, `hasJoint` would keep answering true for a constraint in a dead world.
    this.#joints.clear();
    this.#forced.clear();
  }
}

/**
 * A body's contribution to the inverse normal effective mass at a contact:
 *
 *     1/m + (r x n) . I^-1 (r x n)
 *
 * A static body contributes 0 — it is infinitely heavy and cannot rotate, which is
 * exactly what "the floor doesn't move" means in this algebra.
 *
 * `r` is measured from the PRE-STEP centre of mass for the same reason the velocities
 * are: by the time this runs the solver has already moved everything.
 */
function effectiveInvMass(rec: Rec, point: Vec3, n: Vec3): number {
  if (!rec.body.isDynamic()) return 0;
  return effectiveInvMassAbout(rec.body, rec.prevCom, point, n);
}

/** The same, about an explicit centre of mass. Shared with `normalEffectiveMassAt`. */
function effectiveInvMassAbout(body: RAPIER.RigidBody, com: Vec3, point: Vec3, n: Vec3): number {
  if (!body.isDynamic()) return 0;
  const rx = point.x - com.x;
  const ry = point.y - com.y;
  const rz = point.z - com.z;
  // c = r x n
  const cx = ry * n.z - rz * n.y;
  const cy = rz * n.x - rx * n.z;
  const cz = rx * n.y - ry * n.x;
  // I^-1 is symmetric positive definite; Rapier hands it over as its upper triangle.
  const I = body.effectiveWorldInvInertia();
  const ix = I.m11 * cx + I.m12 * cy + I.m13 * cz;
  const iy = I.m12 * cx + I.m22 * cy + I.m23 * cz;
  const iz = I.m13 * cx + I.m23 * cy + I.m33 * cz;
  return body.invMass() + (cx * ix + cy * iy + cz * iz);
}

/** Total kinetic energy of a body from the PRE-STEP snapshot: ½mv² + ½ωᵀIω. */
function kineticEnergy(rec: Rec): number {
  if (!rec.body.isDynamic()) return 0;
  const v = rec.prevLin;
  const w = rec.prevAng;
  const translational = 0.5 * rec.massKg * (v.x * v.x + v.y * v.y + v.z * v.z);
  // Rapier exposes the INVERSE inertia, so invert the principal axes to get ½ωᵀIω.
  // The local frame is the cube's, and for our cubes I is isotropic, so working in the
  // world frame with the effective inverse tensor is exact here and conservative
  // elsewhere — this value is only ever used as an upper bound.
  const I = rec.body.effectiveWorldInvInertia();
  const invIx = I.m11;
  const invIy = I.m22;
  const invIz = I.m33;
  const rotational =
    0.5 *
    ((invIx > 0 ? (w.x * w.x) / invIx : 0) +
      (invIy > 0 ? (w.y * w.y) / invIy : 0) +
      (invIz > 0 ? (w.z * w.z) / invIz : 0));
  return translational + rotational;
}

/** v + ω×r from the PRE-STEP snapshot (see Rec.prevLin). */
function pointVelocity(rec: Rec, point: Vec3): Vec3 {
  if (!rec.body.isDynamic()) return { x: 0, y: 0, z: 0 };
  const rx = point.x - rec.prevCom.x;
  const ry = point.y - rec.prevCom.y;
  const rz = point.z - rec.prevCom.z;
  const w = rec.prevAng;
  return {
    x: rec.prevLin.x + (w.y * rz - w.z * ry),
    y: rec.prevLin.y + (w.z * rx - w.x * rz),
    z: rec.prevLin.z + (w.x * ry - w.y * rx),
  };
}

function at(body: RAPIER.RigidBody): Vec3 {
  const c = body.worldCom();
  return { x: c.x, y: c.y, z: c.z };
}
