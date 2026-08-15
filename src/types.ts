/**
 * Shared domain types and the event contract (08 §6).
 *
 * This file imports nothing — it is the root of the dependency graph
 * (types.ts <- data/ <- core/ <- interaction/, fx/ <- labs/ <- ui/ <- app.ts),
 * and eslint enforces that.
 */

export type MetalId = 'W' | 'Au' | 'Cu' | 'Fe' | 'Ti' | 'Al';

export type SurfaceId = 'concrete' | 'steel' | 'oak' | 'rubber' | 'foam' | 'ice';

/** Monotonically increasing, never reused within a session. */
export type EntityId = number;

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
  /** Solver contacts in the manifold. >1 means `point` is one of several (14 PHY-06). */
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
  'lab-changed': { lab: 'sandbox' | 'weigh' };
}

export type EventName = keyof EventMap;
export type Handler<K extends EventName> = (payload: EventMap[K]) => void;
