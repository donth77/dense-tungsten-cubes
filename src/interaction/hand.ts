import * as THREE from 'three';
import { config } from '../config.ts';
import type { EventBus } from '../core/events.ts';
import type { EntityStore } from '../core/entities.ts';
import type { PhysicsWorld } from '../core/physics.ts';
import type { EntityId } from '../types.ts';

export type HandMode = 'one' | 'two' | 'forklift';

/**
 * TheHand — the signature mechanic (01).
 *
 * Your mouse is not a magic tractor beam; it is a human hand with a force budget. A
 * critically-damped PD spring, force-clamped, applied manually each fixed step:
 *
 *     ω₀ = 12 rad/s   ζ = 1
 *     kp = m·ω₀²      kd = 2·m·ω₀
 *     F  = kp·(target − p) − kd·v          // p, v of the GRAB POINT
 *     |F| ≤ cap  ->  applyForceAtPoint;  meter = |F| / cap
 *
 * Because kp scales with mass but the cap does not, feel falls straight out of real
 * physics: a 2" aluminium cube (0.35 kg) needs ~3 N and snaps to the cursor, a 4"
 * tungsten (19 kg) lifts but sags and lags, and a 6" tungsten (64 kg, 625 N of weight)
 * cannot be lifted at 350 N at all — it scoots. That refusal IS the product working.
 */
export class TheHand {
  #heldId: EntityId | null = null;
  /** Grab point in the body's LOCAL frame, so it tracks the cube as it rotates. */
  readonly #localGrab = new THREE.Vector3();
  /** Where the cursor wants the grab point to be, in world space. */
  readonly #target = new THREE.Vector3();
  /** Plane the cursor drags along: perpendicular to the view, through the grab point. */
  readonly #dragPlane = new THREE.Plane();
  #mode: HandMode = 'one';
  #meter = 0;
  #restoreAngularDamping = 0;
  /** What the PD law asked for, and what actually went in after the clamp. */
  #demandN = 0;
  #appliedN = 0;

  // Scratch — no allocation inside the fixed step.
  readonly #wGrab = new THREE.Vector3();
  readonly #q = new THREE.Quaternion();
  readonly #f = new THREE.Vector3();
  readonly #tmp = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly entities: EntityStore,
    private readonly bus: EventBus,
  ) {}

  get heldId(): EntityId | null {
    return this.#heldId;
  }
  get isHolding(): boolean {
    return this.#heldId !== null;
  }
  /** 0..1, where 1 means the clamp is saturated — the "you are maxed out" tell. */
  get meter(): number {
    return this.#meter;
  }
  get mode(): HandMode {
    return this.#mode;
  }
  get capN(): number {
    return this.#mode === 'one'
      ? config.hand.capOneHandN
      : this.#mode === 'two'
        ? config.hand.capTwoHandN
        : config.hand.capForkliftN;
  }
  setMode(mode: HandMode): void {
    this.#mode = mode;
  }

  /**
   * @param hitWorld the raycast hit point. The offset from the body centre is preserved,
   *   so cubes don't teleport to their centre when grabbed — which is *why* the force
   *   has to be applied at that point rather than the COM (08 §8.4).
   */
  grab(id: EntityId, hitWorld: THREE.Vector3, camera: THREE.Camera): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.release();

    const t = this.physics.transformOf(e.body);
    this.#q.set(t.q.x, t.q.y, t.q.z, t.q.w);
    // world -> local: R⁻¹ · (hit − centre)
    this.#localGrab
      .set(hitWorld.x - t.p.x, hitWorld.y - t.p.y, hitWorld.z - t.p.z)
      .applyQuaternion(this.#q.clone().invert());

    this.#heldId = id;
    e.heldBy = 'hand';
    this.#target.copy(hitWorld);
    this.#updateDragPlane(hitWorld, camera);

    // Held angular damping keeps the torque from an off-centre grab reading as "heavy
    // and badly balanced" rather than "spinning wildly" (08 §8.4).
    //
    // Read the body's ACTUAL damping first rather than assuming 0. Cubes under 1" are
    // created with angular damping 0.1 — the small-cube stability lever (05) — and
    // hardcoding the restore value to 0 silently deleted it the first time anyone
    // picked one up. The jitter gate never caught it because that test never grabs.
    this.#restoreAngularDamping = this.physics.angularDampingOf(e.body);
    this.physics.setAngularDamping(e.body, config.hand.heldAngularDamping);
    this.bus.emit('grab', { id });
    this.bus.emit('select', { id });
  }

  /**
   * Release is just "stop applying force" — the body keeps its solver velocity, so
   * throwing works with zero extra code.
   *
   * `pointercancel` routes here too (12 §4). A notification shade or an incoming call
   * cancels a pointer with no `pointerup`, and unhandled, The Hand keeps applying force
   * to a cube attached to a finger that no longer exists.
   */
  release(): void {
    const id = this.#heldId;
    if (id === null) return;
    const e = this.entities.get(id);
    this.#heldId = null;
    this.#meter = 0;
    if (!e) return;
    e.heldBy = null;
    this.physics.setAngularDamping(e.body, this.#restoreAngularDamping);
    const v = this.physics.velocityOf(e.body);
    this.bus.emit('release', {
      id,
      speedMps: Math.hypot(v.x, v.y, v.z),
    });
  }

  /** Cursor moved: re-project onto the drag plane. */
  aim(ray: THREE.Ray): void {
    if (this.#heldId === null) return;
    const hit = ray.intersectPlane(this.#dragPlane, this.#tmp);
    if (hit) this.#target.copy(hit);
  }

  /** Wheel / two-finger vertical drag pushes the drag plane along the view axis. */
  moveDepth(delta: number, camera: THREE.Camera): void {
    if (this.#heldId === null) return;
    camera.getWorldDirection(this.#tmp);
    this.#target.addScaledVector(this.#tmp, delta);
    this.#updateDragPlane(this.#target, camera);
  }

  #updateDragPlane(through: THREE.Vector3, camera: THREE.Camera): void {
    camera.getWorldDirection(this.#tmp);
    this.#dragPlane.setFromNormalAndCoplanarPoint(this.#tmp, through);
  }

  /**
   * Step 2 of the fixedStep contract — pre-step, so the solver sees these forces in the
   * same step they were computed for.
   */
  applyForces(): void {
    const id = this.#heldId;
    if (id === null) return;
    const e = this.entities.get(id);
    if (!e) {
      this.#heldId = null;
      return;
    }

    // Grab point in world space, following the cube's current rotation.
    const t = this.physics.transformOf(e.body);
    this.#q.set(t.q.x, t.q.y, t.q.z, t.q.w);
    this.#wGrab
      .copy(this.#localGrab)
      .applyQuaternion(this.#q)
      .add(this.#tmp.set(t.p.x, t.p.y, t.p.z));

    const m = this.physics.massOf(e.body);
    const kp = m * config.hand.omega0 * config.hand.omega0;
    const kd = 2 * config.hand.zeta * m * config.hand.omega0;

    const v = this.physics.velocityAtPoint(e.body, this.#wGrab);
    this.#f.set(
      kp * (this.#target.x - this.#wGrab.x) - kd * v.x,
      kp * (this.#target.y - this.#wGrab.y) - kd * v.y,
      kp * (this.#target.z - this.#wGrab.z) - kd * v.z,
    );

    const cap = this.capN;
    const mag = this.#f.length();
    // Clamp preserves direction: at the limit you still pull the right way, you just
    // can't pull hard enough. That is the whole mechanic.
    if (mag > cap) this.#f.multiplyScalar(cap / mag);
    this.#meter = cap > 0 ? Math.min(1, mag / cap) : 0;
    this.#demandN = mag;
    this.#appliedN = this.#f.length();

    this.physics.applyForceAtPoint(e.body, this.#f, this.#wGrab);

    // CCD is NOT managed here. It used to be, and release() switched it off — at exactly
    // the moment a thrown cube is fastest and needs it most. PhysicsWorld now drives it
    // from speed alone, for every body, which is the only place that has the whole
    // picture (see #clampSpeeds).
  }

  /** World-space grab point, for the force meter's screen position. */
  get grabPointWorld(): THREE.Vector3 {
    return this.#wGrab;
  }
  /** What the PD law wanted this step, before the clamp (N). */
  get demandN(): number {
    return this.#demandN;
  }
  /** What was actually applied this step, after the clamp (N). */
  get appliedN(): number {
    return this.#appliedN;
  }
}
