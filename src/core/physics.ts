import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config.ts';
import { densityOf } from '../data/metals.ts';
import { METALS } from '../data/metals.ts';
import { SURFACES } from '../data/surfaces.ts';
import type {
  BodyHandle,
  CombineRule,
  CubeSpec,
  EntityId,
  ImpactEvent,
  Quat,
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
 * Everything is SI at true scale (08 §2.7). If the M0 jitter gate fails, the escalation
 * order is: solver iterations -> damping -> `world.lengthUnit` -> `WORLD_SCALE = 4`.
 */

const GRAVITY_MPS2 = 9.81;

/**
 * `data/` declares its combine rule as a plain string so it never imports Rapier
 * (08 §5.1). This is the only place the mapping exists.
 */
function combineRule(rule: CombineRule): RAPIER.CoefficientCombineRule {
  switch (rule) {
    case 'min':
      return RAPIER.CoefficientCombineRule.Min;
    case 'max':
      return RAPIER.CoefficientCombineRule.Max;
    default:
      return RAPIER.CoefficientCombineRule.Average;
  }
}

/** Per-body bookkeeping the public surface never exposes. */
interface Rec {
  handle: BodyHandle;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
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
  /** Half-side, metres. Drives size-aware substepping — see `#substepsFor`. */
  halfExtent: number;
}

export class PhysicsWorld {
  #world!: RAPIER.World;
  #events!: RAPIER.EventQueue;
  #recs = new Map<BodyHandle, Rec>();
  #byCollider = new Map<number, BodyHandle>();
  #nextHandle = 1;
  /** `${handleA}:${handleB}` -> simulated-time ms of the last emitted impact. */
  #pairCooldown = new Map<string, number>();
  #simTimeMs = 0;
  /** Bodies that had a user force applied this step, so we know what to zero after it. */
  #forced = new Set<BodyHandle>();

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
    // The sanctioned first escalation for small-cube trouble: tell Rapier the world is
    // measured in something other than metres, rather than rescaling our own geometry.
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
      .setCcdEnabled(opts?.ccd ?? false);

    // The small-cube stability lever (05). Tiny colliders are what an impulse solver
    // loses first, and the size slider goes down to 0.25".
    if (s < config.stability.smallCubeSideM) {
      bodyDesc
        .setLinearDamping(config.stability.smallCubeLinearDamping)
        .setAngularDamping(config.stability.smallCubeAngularDamping);
    }
    const body = this.#world.createRigidBody(bodyDesc);

    // Density in kg/m³, never a hand-set mass: Rapier then derives mass AND the inertia
    // tensor correctly. Setting mass directly would leave inertia wrong and a heavy cube
    // would tumble like a light one.
    const colDesc = RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2)
      .setDensity(density)
      .setFriction(metal.friction)
      .setRestitution(metal.restitution)
      .setRestitutionCombineRule(combineRule(metal.restitutionRule))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      // 0 = report every contact force. The gate that decides what is an *impact* is
      // ours (§8.1), not Rapier's — a threshold here would silently drop soft landings.
      .setContactForceEventThreshold(0);

    const collider = this.#world.createCollider(colDesc, body);
    return this.#register(body, collider, {
      halfExtent: s / 2,
      ...(opts?.entityId !== undefined ? { entityId: opts.entityId } : {}),
    });
  }

  /**
   * Returns a handle — the scale platform is a static box and `contactForceOnKg()`
   * needs to be able to name it (08 §6, audit 2026-08-09).
   */
  addStaticBox(halfExtents: Vec3, at: Vec3, surface: SurfaceId): BodyHandle {
    const spec = SURFACES[surface];
    const body = this.#world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z),
    );
    const collider = this.#world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(spec.friction)
        .setRestitution(spec.restitution)
        .setRestitutionCombineRule(combineRule(spec.restitutionRule))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body,
    );
    return this.#register(body, collider, { surface });
  }

  #register(
    body: RAPIER.RigidBody,
    collider: RAPIER.Collider,
    extra: { surface?: SurfaceId; entityId?: EntityId; halfExtent?: number },
  ): BodyHandle {
    const handle = this.#nextHandle++ as BodyHandle;
    const rec: Rec = {
      handle,
      body,
      collider,
      massKg: body.mass(),
      prevLin: { x: 0, y: 0, z: 0 },
      prevAng: { x: 0, y: 0, z: 0 },
      prevCom: { ...at(body) },
      ccd: false,
      halfExtent: extra.halfExtent ?? 0.05,
      ...(extra.surface !== undefined ? { surface: extra.surface } : {}),
      ...(extra.entityId !== undefined ? { entityId: extra.entityId } : {}),
    };
    this.#recs.set(handle, rec);
    this.#byCollider.set(collider.handle, handle);
    return handle;
  }

  remove(h: BodyHandle): void {
    const rec = this.#recs.get(h);
    if (!rec) return;
    this.#byCollider.delete(rec.collider.handle);
    this.#recs.delete(h);
    this.#world.removeRigidBody(rec.body); // removes its colliders too
    for (const key of this.#pairCooldown.keys()) {
      if (key.startsWith(`${h}:`) || key.endsWith(`:${h}`)) this.#pairCooldown.delete(key);
    }
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
    if (!rec) return;
    rec.collider.setDensity(kgPerM3);
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

  setAngularDamping(h: BodyHandle, d: number): void {
    this.#recs.get(h)?.body.setAngularDamping(d);
  }

  /**
   * Manual override. Normally CCD is driven by speed inside the step (`#clampSpeeds`) —
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
   * The digital scale's readout (08 §9.2). This is the **sustained-force channel** —
   * polled, continuous, and silent by nature; it is not, and must not be, the impact
   * channel (§8.1).
   *
   * Implemented by summing solver contact impulses ÷ dt rather than by accumulating
   * contact-force *events*. 08 §14 flagged the event path as a risk (events fire only
   * above a threshold and can drop resting contacts); the impulse walk is the same
   * number with no event plumbing, so it is what ships. Revisit at step 22 with a
   * 10-step average in front of you.
   */
  contactForceOnKg(h: BodyHandle): number {
    const rec = this.#recs.get(h);
    if (!rec) return 0;
    let impulse = 0;
    this.#world.contactPairsWith(rec.collider, (other) => {
      this.#world.contactPair(rec.collider, other, (manifold) => {
        for (let i = 0; i < manifold.numContacts(); i++) impulse += manifold.contactImpulse(i);
      });
    });
    return impulse / this.#world.timestep / GRAVITY_MPS2;
  }

  // ---- the step ---------------------------------------------------------------

  step(dt: number, outImpacts: ImpactEvent[]): void {
    /*
     * Substepping (08 §7, 05): a body moving fast enough covers more than its own size
     * in one 60 Hz step and the narrow phase never sees the contact.
     *
     * Measured at M0: a 1" cube at 18.8 m/s travels 0.313 m per step — 12x its own edge
     * — and drove 58 mm into a 200 mm concrete slab before the solver pushed it back
     * out. Against a thinner prop or another cube it goes straight through. The Hand can
     * throw well past the threshold, so this is reachable in the Sandbox today, not just
     * in the Drop Tower.
     */
    const substeps = this.#substepsFor(dt);
    const sub = dt / substeps;
    this.#world.timestep = sub;

    for (let i = 0; i < substeps; i++) {
      this.#snapshotVelocities();
      this.#world.step(this.#events);
      this.#simTimeMs += sub * 1000;
      // Forces are cleared only after the LAST substep: a force applied for one fixed
      // step should act across the whole of it, not just its first quarter.
      if (i === substeps - 1) this.#clearAppliedForces();
      this.#clampSpeeds();
      this.#drainImpacts(outImpacts);
    }

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
   * How many substeps this step needs, from TRAVEL PER STEP vs the SMALLEST body —
   * not from a fixed speed threshold.
   *
   * 08 §10's "substep above 8 m/s" is the wrong shape, and measurably so: a 1" cube
   * dropped 2 m lands at 6.4 m/s, sits *under* the threshold, gets one step, and moves
   * 107 mm — four times its own width — straight through the floor surface. Meanwhile a
   * 15" cube at the same speed is entirely safe. What matters is how far something moves
   * relative to how big it is, and our sizes span 60:1.
   *
   * Measured: penetration went 98 mm -> a few mm at that speed once this was size-aware.
   */
  #substepsFor(dt: number): number {
    let maxSpeedSq = 0;
    let minHalf = Infinity;
    for (const rec of this.#recs.values()) {
      if (!rec.body.isDynamic()) continue;
      const v = rec.body.linvel();
      const sq = v.x * v.x + v.y * v.y + v.z * v.z;
      if (sq > maxSpeedSq) maxSpeedSq = sq;
      if (rec.halfExtent < minHalf) minHalf = rec.halfExtent;
    }
    if (minHalf === Infinity) return 1;
    const speed = Math.sqrt(maxSpeedSq);
    // Cheap early-out for the overwhelmingly common case of a slow or sleeping scene.
    if (speed < config.loop.substepSpeedMps) return 1;
    const travel = speed * dt;
    const allowed = minHalf * config.loop.substepTravelFraction;
    return Math.min(config.loop.maxSubsteps, Math.max(1, Math.ceil(travel / allowed)));
  }

  /**
   * Hard speed ceiling (05) plus CCD lifecycle.
   *
   * CCD lives here rather than in TheHand because the Hand was disabling it on release
   * — precisely when a thrown cube is fastest and needs it most (found by audit). Speed
   * is the only thing that should decide, and only physics knows every body's speed.
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
      const wantCcd = speed > config.hand.ccdSpeedMps;
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
      const contact = this.#deepestContact(a.collider, b.collider);
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

      // Reduced mass; a static partner is infinitely heavy, so μ = m_dynamic.
      const ma = a.body.isDynamic() ? a.massKg : Infinity;
      const mb = b.body.isDynamic() ? b.massKg : Infinity;
      const mu = ma === Infinity ? mb : mb === Infinity ? ma : (ma * mb) / (ma + mb);
      const energyJ = 0.5 * mu * normalSpeedMps * normalSpeedMps;

      // TWO SEPARATE CHANNELS, AND-ed, never OR-ed. An earlier draft emitted on
      // `forceN > 3 || energyJ > 0.005`, which fires forever under any resting cube
      // heavier than ~300 g — "rests are silent" would have been false immediately.
      // forceN rides along as data; it never authorises an impact by itself.
      if (energyJ <= config.impact.minEnergyJ) return;
      if (normalSpeedMps <= config.impact.minNormalSpeedMps) return;

      const key = hA < hB ? `${hA}:${hB}` : `${hB}:${hA}`;
      const last = this.#pairCooldown.get(key);
      if (last !== undefined && this.#simTimeMs - last < config.impact.pairCooldownMs) return;
      this.#pairCooldown.set(key, this.#simTimeMs);

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
        forceN,
      });
    });
  }

  /** Deepest solver contact for a pair, in world space, with the manifold normal. */
  #deepestContact(c1: RAPIER.Collider, c2: RAPIER.Collider): { point: Vec3; normal: Vec3 } | null {
    let best: { point: Vec3; normal: Vec3 } | null = null;
    let bestDist = Infinity;
    this.#world.contactPair(c1, c2, (manifold) => {
      const n = manifold.normal();
      const count = manifold.numSolverContacts();
      for (let i = 0; i < count; i++) {
        const d = manifold.solverContactDist(i);
        if (d < bestDist) {
          const p = manifold.solverContactPoint(i);
          bestDist = d;
          best = { point: { x: p.x, y: p.y, z: p.z }, normal: { x: n.x, y: n.y, z: n.z } };
        }
      }
    });
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

  free(): void {
    this.#events.free();
    this.#world.free();
    this.#recs.clear();
    this.#byCollider.clear();
  }
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
