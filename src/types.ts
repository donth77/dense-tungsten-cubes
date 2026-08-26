/**
 * Shared domain types and the event contract (08 §6).
 *
 * This file imports nothing — it is the root of the dependency graph
 * (types.ts <- data/ <- core/ <- interaction/, fx/ <- labs/ <- ui/ <- app.ts),
 * and eslint enforces that.
 */

export type MetalId = 'W' | 'Au' | 'Cu' | 'Fe' | 'Ti' | 'Al';

export type SurfaceId =
  | 'concrete'
  | 'steel'
  | 'oak'
  | 'rubber'
  | 'foam'
  | 'ice'
  | 'sand'
  | 'trampoline'
  | 'pulp'
  | 'glass';

/**
 * What a rigid body IS to the solver. Most bodies are born and die in one kind; the
 * Drop Tower's winch flips a cube dynamic <-> kinematic (16 §6.2), and a compliant
 * pad's crushed regime flips it to FIXED — fixed, not kinematic, because a kinematic
 * body is not a reliable CCD obstacle in Rapier 0.19.3 (16 §6.4 amendment).
 */
export type BodyKind = 'dynamic' | 'kinematic' | 'fixed';

/** Monotonically increasing, never reused within a session. */
export type EntityId = number;

/**
 * The labs. Lives here rather than in `labs/lab.ts` (which re-exports it) because the
 * event contract below and the share codec (`core/share.ts`) both need it, and core/
 * may not import labs/ (08 §5).
 */
export type LabId = 'sandbox' | 'weigh' | 'drop';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Transform {
  p: Vec3;
  q: Quat;
}

declare const BodyHandleBrand: unique symbol;
/**
 * Opaque handle to a physics body. Only `core/physics.ts` mints or dereferences one —
 * it is the engine-swap seam (08 §5.1). It is a number underneath so it can key a Map,
 * but nothing outside physics.ts is allowed to know that.
 */
export type BodyHandle = number & { readonly [BodyHandleBrand]: never };

declare const JointHandleBrand: unique symbol;
/** The same seam, for constraints. Minted and dereferenced only by `core/physics.ts`. */
export type JointHandle = number & { readonly [JointHandleBrand]: never };

/**
 * The shapes a compound instrument part may take (15 §8.2).
 *
 * Deliberately a small closed set rather than a pass-through of Rapier's collider
 * vocabulary: the firewall is only worth having if the descriptor on this side of it is
 * engine-independent. A balance beam, a pan, a scale housing and a platter are all
 * expressible with the first three. `convexHull` joined for fracture fragments
 * (18 §6 C2 realism audit): a Voronoi cell's bounding BOX overlaps its neighbours'
 * at spawn — the solver's depenetration shove out-kicked the authored burst at every
 * energy — and lies about the rest pose (wedges balanced on edge). The hull is the
 * cell: cells partition the body, so hulls spawn touching, never penetrating.
 */
export type PartShape =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'roundedBox'; halfExtents: Vec3; borderRadiusM: number }
  | { kind: 'cylinder'; halfHeightM: number; radiusM: number }
  /** Body-local xyz triples. The engine computes the hull; degenerate sets fall back to a box. */
  | { kind: 'convexHull'; points: readonly number[] };

/** One collider inside a compound body, posed in the body's local frame. */
export interface ColliderPart {
  shape: PartShape;
  /** Local offset from the body origin. Omitted means the origin. */
  at?: Vec3;
  /** Local rotation. Omitted means identity. */
  rotation?: Quat;
  material: SurfaceId;
  /**
   * What this part weighs. Density is derived from the shape's volume, so the compound's
   * centre of mass falls out of *where the parts are* — which is what makes a balance's
   * below-pivot COM a construction rather than a declaration (15 §6.2).
   *
   * Omit on a fixed body, where mass is meaningless.
   */
  massKg?: number;
}

/**
 * Lab-prop entity ids start here (18 §5.1) — breakable targets and their kin. Cube
 * ids are small ints from the EntityStore; anything at or above this line is a prop,
 * and consumers that mean "another CUBE" must check the range, not just the type.
 */
export const PROP_ID_BASE = 1_000_000;

export interface CompoundBodySpec {
  /**
   * `kinematic` is a body the CALLER positions each step and the solver treats as
   * infinitely massive: it pushes dynamic bodies and is never pushed back. That is what
   * makes it the right thing for a balance pan — a surface that must stay level under a
   * load several times the instrument's own mass, which no joint at four solver
   * iterations can hold (every one of five joint-based pan designs was measured pulling
   * out of shape under a 4 in tungsten cube).
   */
  kind: 'fixed' | 'dynamic' | 'kinematic';
  at: Vec3;
  parts: readonly ColliderPart[];
  ccd?: boolean;
  /**
   * Impact identity for lab PROPS (18 §5.1) — a breakable target must be nameable by
   * the impact channel. Prop ids live in a reserved range (≥ 1,000,000) so they can
   * never collide with the EntityStore's cube ids, and the drain's subject ordering
   * prefers the LOWER id — the player's cube stays `a`.
   */
  entityId?: EntityId;
  /**
   * Rapier's per-body solver iterations. Measured HARMFUL on the balance's shared
   * constraint network (W0: +4 iterations sent equal-load rest from 0.07 to 82 degrees),
   * so this exists to be left alone unless a sweep says otherwise (15 §7.3).
   */
  additionalSolverIterations?: number;
  /**
   * Rapier's implicit damping — the STABLE way to bleed speed (the W2 lesson: hand-
   * applied drag forces need `c·dt/m < 2`; implicit damping never explodes). Wet
   * fracture pieces use it as squeeze-flow drag: pulp sprays fast and dies fast.
   */
  linearDamping?: number;
  angularDamping?: number;
}

export interface RevoluteJointSpec {
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  anchorA: Vec3;
  anchorB: Vec3;
  axis: Vec3;
  limitsRad?: readonly [number, number];
}

export interface PrismaticJointSpec {
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  anchorA: Vec3;
  anchorB: Vec3;
  axis: Vec3;
  limitsM?: readonly [number, number];
}

export interface SphericalJointSpec {
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  anchorA: Vec3;
  anchorB: Vec3;
}

export interface RopeJointSpec {
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  anchorA: Vec3;
  anchorB: Vec3;
  /** A rope resists stretching only; it never pushes. */
  maxLengthM: number;
}

export interface CubeSpec {
  metal: MetalId;
  /** Physics unit. The UI shows inches first (08 §2.3) — that conversion lives in data/format.ts. */
  sideM: number;
  /** 90–97, tungsten only. Default 95 (ASTM B777 Class 3). */
  purityPctW?: number;
  // shape?: 'cube' | 'sphere' | 'pyramid'   // reserved for the V2 shape pack — not read in MVP
}

export interface ImpactEvent {
  a: EntityId;
  /** A SurfaceId when the partner is a static (floor, mat, scale platform). */
  b: EntityId | SurfaceId;
  /** World-space contact point, from a manifold query — the force event carries no position. */
  point: Vec3;
  /** Closing speed along the contact normal, from pre-step cached velocities *at the contact point*. */
  normalSpeedMps: number;
  /**
   * ½·m_eff·v_n², where m_eff is the **normal effective mass at this contact** — it
   * includes both bodies' inverse mass AND their inverse inertia about the contact
   * offset, so a corner strike reports the ~m/4 a rigid cube actually presents rather
   * than its full mass (14 PHY-06). Clamped to the pre-impact kinetic-energy budget: this
   * can never exceed the energy the bodies actually had.
   */
  energyJ: number;
  /** The normal effective mass used for `energyJ`, kg. Exposed so tests can check it. */
  effectiveMassKg: number;
  /**
   * Rapier's contact-force magnitude for the whole **pair**, not for `point`. It is an
   * aggregate over every contact in the manifold and it varies with solver settings, so
   * it is data only — it never authorises an impact by itself, and it is not a stress.
   */
  forceN: number;
  /**
   * Solver contacts in the manifold. >1 means `point` is one of several (14 PHY-06).
   * 0 means the pair had already separated when the event was drained — a CCD/TOI
   * landing — and `point`/`normal` are a geometric projection, not a solver contact;
   * `forceN` reads 0 on such a step. Speed and energy are snapshot-based as always.
   */
  contactCount: number;
}

export interface EventMap {
  impact: ImpactEvent;
  spawn: { id: EntityId };
  despawn: { id: EntityId };
  grab: { id: EntityId };
  release: { id: EntityId; speedMps: number };
  /** Info-card target. */
  select: { id: EntityId | null };
  'settings-changed': { units: 'si' | 'imperial'; sound: boolean };
  'lab-changed': { lab: LabId };
}

export type EventName = keyof EventMap;
export type Handler<K extends EventName> = (payload: EventMap[K]) => void;
