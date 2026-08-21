/**
 * Stage W0 rig — isolated Rapier instruments for the Weigh Station (15 §12 W0).
 *
 * This is a SPIKE, and it lives in `tests/` for a reason: `PhysicsWorld` has no joints,
 * no compound bodies and no torque API yet, and adding them is Stage W1's job. Building
 * the numerical model first means W1 adds the facade the instruments actually need
 * rather than the one they were guessed to need. `tests/**` is the one place the Rapier
 * firewall is lifted (eslint.config.js), so the spike talks to Rapier directly and
 * nothing in `src/` learns a bad habit.
 *
 * Every world here is built with the SAME integration parameters as the real
 * `PhysicsWorld`, because a calibration number measured under different solver settings
 * is a number about a different simulator.
 *
 * ## API findings, verified against the installed 0.19.3 `.d.ts` — not the website
 *
 * - `JointData.revolute / prismatic / rope / spring / fixed / spherical / generic` all
 *   exist, with `limitsEnabled` + `limits`.
 * - **`ImpulseJoint` exposes no impulse or reaction-force read.** There is no
 *   `impulse()`, no `reactionForce()`, nothing equivalent. This settles 15 §7.2's open
 *   choice: option 2 (a force-based prismatic motor whose reaction is the signal) is
 *   *not implementable* on the installed engine, so the manual spring/damper model is
 *   not merely "preferred", it is the only defensible option. The measured force is one
 *   we compute ourselves and therefore one we can defend.
 * - `setAdditionalSolverIterations` exists per body, so the assembly can be stiffened
 *   without touching global solver settings.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../../src/config.ts';

export const DT = config.loop.DT;
export const G = config.physics.gravityMps2;

/** The app's own solver settings. A spike under different ones measures another engine. */
export async function spikeWorld(): Promise<RAPIER.World> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = DT;
  world.numSolverIterations = config.stability.solverIterations;
  world.integrationParameters.maxCcdSubsteps = config.stability.maxCcdSubsteps;
  world.integrationParameters.normalizedAllowedLinearError = config.stability.allowedLinearError;
  world.integrationParameters.normalizedPredictionDistance = config.stability.predictionDistance;
  return world;
}

// ---------------------------------------------------------------------------------
// Digital scale — prismatic platter + compliant transducer (15 §7.2)
// ---------------------------------------------------------------------------------

export interface ScaleParams {
  /** Platter mass. 15 §7.3 seeds 0.6 kg; the sweep is what decides. */
  platterKg: number;
  /** Rated gross capacity above the platter. */
  ratedKg: number;
  /** Solver-resolvable travel at rated load. 15 §7.3 wants 5–8 mm. */
  travelM: number;
  /** Damping ratio around platter + 1 kg. */
  zeta: number;
  /**
   * Cap the damping impulse so it can never reverse the platter's velocity.
   *
   * Explicit damping integrated by symplectic Euler needs `c·dt/m < 2` or it amplifies
   * instead of dissipating, and a stiff cell on a light platter blows straight through
   * that. Clamping makes the damper unconditionally dissipative at the cost of being
   * slightly weak during the fastest part of a transient — which is the right trade for
   * an instrument that has to be numerically boring.
   */
  clampDamping: boolean;
  preloadN?: number;
  /** Proof force as a multiple of rated gross weight; reaching it is OVERLOAD. */
  proofFactor?: number;
  extraSolverIters?: number;
}

export interface ScaleRig {
  world: RAPIER.World;
  platter: RAPIER.RigidBody;
  /** Spring rate, N/m — derived from rated load and travel, never guessed (15 §7.3). */
  k: number;
  /** Damping coefficient, N·s/m. */
  c: number;
  proofN: number;
  /** Joint zero: the platter's uncompressed height. */
  y0: number;
  /** Top face of the platter, at rest, so loads can be placed on it. */
  topY(): number;
  /** One fixed step. Returns the cell force in newtons — the raw sensor signal. */
  step(): number;
  addLoad(massKg: number, sideM: number, offset?: { x: number; z: number }): RAPIER.RigidBody;
}

const PLATTER_HALF_XZ = 0.09;
const PLATTER_HALF_Y = 0.006;

export function buildScale(world: RAPIER.World, p: ScaleParams): ScaleRig {
  const preloadN = p.preloadN ?? 0;
  const proofFactor = p.proofFactor ?? 1.5;

  // 15 §7.3: k from rated load and chosen travel. c from the damping ratio around a
  // reference mass of platter + 1 kg.
  const k = ((p.platterKg + p.ratedKg) * G) / p.travelM;
  const c = 2 * p.zeta * Math.sqrt(k * (p.platterKg + 1));
  const proofN = proofFactor * (p.platterKg + p.ratedKg) * G;

  const y0 = 0.05;

  const housing = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  // The housing floor. A load that misses the platter must land on something, or
  // "partial support" is untestable.
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.2, 0.01, 0.2).setTranslation(0, 0.01, 0).setFriction(0.6),
    housing,
  );

  const platterDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, y0, 0);
  if (p.extraSolverIters) platterDesc.setAdditionalSolverIterations(p.extraSolverIters);
  const platter = world.createRigidBody(platterDesc);
  // Density chosen to hit the target mass, so the inertia tensor stays that of a real
  // slab rather than of a point mass bolted on afterwards.
  const volume = PLATTER_HALF_XZ * 2 * (PLATTER_HALF_Y * 2) * (PLATTER_HALF_XZ * 2);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(PLATTER_HALF_XZ, PLATTER_HALF_Y, PLATTER_HALF_XZ)
      .setDensity(p.platterKg / volume)
      .setFriction(0.7)
      .setRestitution(0.05),
    platter,
  );

  // Prismatic along +Y. The joint's own limits are the physical stops (15 §7.4): the
  // lower one stops a load falling through the scale, the upper one only matters when
  // the Hand pulls up, and it must not preload the empty reading.
  const jd = RAPIER.JointData.prismatic(
    { x: 0, y: y0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );
  jd.limitsEnabled = true;
  jd.limits = [-p.travelM * 1.6, 0.001];
  world.createImpulseJoint(jd, housing, platter, true);

  const rig: ScaleRig = {
    world,
    platter,
    k,
    c,
    proofN,
    y0,
    topY: () => platter.translation().y + PLATTER_HALF_Y,
    step(): number {
      const y = platter.translation().y;
      const vy = platter.linvel().y;
      const x = y0 - y; // compression, positive
      const xdot = -vy;

      let damping = c * xdot;
      if (p.clampDamping) {
        // Never more than the impulse that would bring the platter to rest this step.
        const maxDamp = (Math.abs(vy) * platter.mass()) / DT;
        damping = Math.max(-maxDamp, Math.min(maxDamp, damping));
      }
      const F = Math.min(Math.max(k * x + damping + preloadN, 0), proofN);

      platter.addForce({ x: 0, y: F, z: 0 }, true);
      world.step();
      // addForce is PERSISTENT until reset — the single most expensive Rapier lesson in
      // this project's history.
      platter.resetForces(true);
      return F;
    },
    addLoad(massKg, sideM, offset): RAPIER.RigidBody {
      const h = sideM / 2;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(
          offset?.x ?? 0,
          rig.topY() + h + 0.0005,
          offset?.z ?? 0,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(h, h, h)
          .setDensity(massKg / sideM ** 3)
          .setFriction(0.7)
          .setRestitution(0.05),
        body,
      );
      return body;
    },
  };
  return rig;
}

// ---------------------------------------------------------------------------------
// Equal-arm balance — revolute beam with below-pivot COM + rope-hung pans (15 §6)
// ---------------------------------------------------------------------------------

export interface BalanceParams {
  beamKg: number;
  panKg: number;
  /** Half-length of the beam: the load arm L, pivot to pan centre. */
  armM: number;
  /** How far the beam/yoke COM sits BELOW the pivot. Zero means no restoring torque. */
  keelDropM: number;
  /** Share of the beam mass carried in the keel, which is what puts the COM down there. */
  keelMassFraction: number;
  /** Viscous pivot torque coefficient, N·m·s/rad. */
  pivotDamping: number;
  limitDeg: number;
  /** Pan suspension drop — the rope length from hook ring to pan rim. */
  dropM: number;
  extraSolverIters?: number;
}

export interface BalanceRig {
  world: RAPIER.World;
  beam: RAPIER.RigidBody;
  pans: [RAPIER.RigidBody, RAPIER.RigidBody];
  /** Signed beam angle in degrees. Positive = left side down. */
  angleDeg(): number;
  step(): void;
  /** Drops a load into a pan. `side` 0 = left, 1 = right. */
  addLoad(side: 0 | 1, massKg: number, sideM: number, offsetX?: number): RAPIER.RigidBody;
  /** Starts the beam at a nonzero angle, to prove gravity — not a motor — returns it. */
  setAngleDeg(deg: number): void;
}

const BEAM_HALF_Y = 0.008;
const PAN_HALF_XZ = 0.115;
const PAN_HALF_Y = 0.004;
const PIVOT_Y = 0.55;
const ROPE_RING = 0.02;

export function buildBalance(world: RAPIER.World, p: BalanceParams): BalanceRig {
  const stand = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, PIVOT_Y, 0));

  const beamDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PIVOT_Y, 0);
  if (p.extraSolverIters) beamDesc.setAdditionalSolverIterations(p.extraSolverIters);
  const beam = world.createRigidBody(beamDesc);

  /*
   * The COM is placed by BUILDING it, not by declaring it (15 §6.2). Two colliders — the
   * bar through the pivot, and a keel hanging below it — and Rapier computes the compound
   * centre of mass from their densities. That is the same compound-body shape W1 has to
   * support anyway, so the spike exercises it rather than faking it with
   * setAdditionalMassProperties.
   */
  const barKg = p.beamKg * (1 - p.keelMassFraction);
  const keelKg = p.beamKg * p.keelMassFraction;
  const barVol = p.armM * 2 * (BEAM_HALF_Y * 2) * (BEAM_HALF_Y * 2);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(p.armM, BEAM_HALF_Y, BEAM_HALF_Y).setDensity(barKg / barVol),
    beam,
  );
  const keelHalf = 0.012;
  const keelVol = (keelHalf * 2) ** 3;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(keelHalf, keelHalf, keelHalf)
      .setDensity(keelKg / keelVol)
      .setTranslation(0, -p.keelDropM, 0),
    beam,
  );

  const limit = (p.limitDeg * Math.PI) / 180;
  const rj = RAPIER.JointData.revolute(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
  );
  const pivot = world.createImpulseJoint(rj, stand, beam, true) as RAPIER.RevoluteImpulseJoint;
  /*
   * LIMITS GO ON AFTER CREATION, and this is not a style choice.
   *
   * `JointData.limitsEnabled` / `.limits` are SILENTLY IGNORED for revolute joints in
   * Rapier 0.19.3's JS bindings: the raw constructor is `rawgenericjoint_revolute(a1, a2,
   * axis)` and takes no limit arguments, unlike the prismatic one which takes six and does
   * honour them. TypeScript accepts the fields either way, so the failure is invisible —
   * measured, a beam with a 12 degree limit set that way spun a full 359.99 degrees under
   * torque, while `setLimits()` after `createImpulseJoint` held it at exactly 12.00.
   */
  pivot.setLimits(-limit, limit);

  /*
   * Three ropes per pan (15 §6.1). The hook-ring anchors form a small triangle rather than
   * sharing one point: three ropes from one point constrain distance only and leave the
   * pan free to spin about it, so the bridle would be singular and the pan would never
   * hold an attitude.
   *
   * Every x carries `sign`, mirroring the bridle. The first version laid the SAME triangle
   * on both ends, so on the left the +x anchor pointed inboard and on the right it pointed
   * outboard — two geometrically different bridles.
   */
  const ring: [number, number][] = [
    [ROPE_RING, 0],
    [-ROPE_RING / 2, ROPE_RING * 0.866],
    [-ROPE_RING / 2, -ROPE_RING * 0.866],
  ];

  const panVol = PAN_HALF_XZ * 2 * (PAN_HALF_Y * 2) * (PAN_HALF_XZ * 2);
  const pans = ([0, 1] as const).map((i) => {
    const sign = i === 0 ? -1 : 1;
    const panDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
      sign * p.armM,
      PIVOT_Y - p.dropM,
      0,
    );
    if (p.extraSolverIters) panDesc.setAdditionalSolverIterations(p.extraSolverIters);
    const pan = world.createRigidBody(panDesc);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(PAN_HALF_XZ, PAN_HALF_Y, PAN_HALF_XZ)
        .setDensity(p.panKg / panVol)
        .setFriction(0.6)
        .setRestitution(0.05),
      pan,
    );
    // A low rim, so a cube placed off-centre stays in the pan and tilts it instead of
    // sliding out — the off-centre-load case has to come from contact, not metadata.
    const rim: [number, number][] = [
      [PAN_HALF_XZ, 0],
      [-PAN_HALF_XZ, 0],
      [0, PAN_HALF_XZ],
      [0, -PAN_HALF_XZ],
    ];
    for (const [rx, rz] of rim) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          rx === 0 ? PAN_HALF_XZ : 0.003,
          0.012,
          rz === 0 ? PAN_HALF_XZ : 0.003,
        )
          .setTranslation(rx, 0.012, rz)
          .setDensity(1),
        pan,
      );
    }

    return pan;
  }) as [RAPIER.RigidBody, RAPIER.RigidBody];

  // Beam inertia about Z, for the damping clamp. Rapier exposes principal inertia, and
  // the beam's principal frame is the identity here, so the Z component is the one.
  const BEAM_INERTIA_GUESS = beam.principalInertia().z;

  /*
   * INTERLEAVED, one rope from each side at a time.
   *
   * Rapier's solver walks constraints in creation order with a finite iteration count, so
   * whichever bridle is built last is the one whose residual is smallest. Building the
   * left pan's three ropes and then the right pan's left the left bridle 0.15 mm
   * over-extended while the right sat at zero, the left pan hanging 12.8 mm higher, and
   * the beam resting 1.0 degrees off zero under equal loads. Alternating L,R,L,R,L,R
   * gives neither side the last word.
   */
  const rimScale = PAN_HALF_XZ / ROPE_RING;
  for (const [ax, az] of ring) {
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? -1 : 1;
      const jd = RAPIER.JointData.rope(
        p.dropM,
        { x: sign * (p.armM + ax), y: 0, z: az },
        { x: sign * ax * rimScale, y: PAN_HALF_Y, z: az * rimScale },
      );
      world.createImpulseJoint(jd, beam, pans[side], true);
    }
  }

  const rig: BalanceRig = {
    world,
    beam,
    pans,
    angleDeg(): number {
      const q = beam.rotation();
      // Rotation is about Z only, so the half-angle comes straight off (z, w).
      return (2 * Math.atan2(q.z, q.w) * 180) / Math.PI;
    },
    step(): void {
      // Passive viscous pivot torque, and nothing else (15 §6.2). No motor, no angle
      // spring: if the beam finds zero it is because gravity took it there.
      const wz = beam.angvel().z;
      // Clamped for the same reason as the load cell's damper: an explicit -c*w torque
      // integrated by symplectic Euler amplifies once c*dt/I > 2, and the beam's inertia
      // is small. Capping at the impulse that would just stop the beam keeps it honestly
      // dissipative at every c.
      const maxTorque = (Math.abs(wz) * BEAM_INERTIA_GUESS) / DT;
      const tz = Math.max(-maxTorque, Math.min(maxTorque, -p.pivotDamping * wz));
      beam.addTorque({ x: 0, y: 0, z: tz }, true);
      world.step();
      beam.resetTorques(true);
    },
    addLoad(side, massKg, sideM, offsetX = 0): RAPIER.RigidBody {
      const pan = pans[side];
      const t = pan.translation();
      const h = sideM / 2;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(
          t.x + offsetX,
          t.y + PAN_HALF_Y + h + 0.0005,
          t.z,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(h, h, h)
          .setDensity(massKg / sideM ** 3)
          .setFriction(0.7)
          .setRestitution(0.05),
        body,
      );
      return body;
    },
    setAngleDeg(deg): void {
      const half = (deg * Math.PI) / 360;
      beam.setRotation({ x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }, true);
    },
  };
  return rig;
}

// ---------------------------------------------------------------------------------
// Shared measurement helpers
// ---------------------------------------------------------------------------------

export function isFiniteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Mean of the last `n` samples — the steady-state reading. */
export function tail(samples: number[], n: number): number {
  const s = samples.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

/** Peak-to-peak spread of the last `n` samples — how quiet the signal actually is. */
export function tailSpan(samples: number[], n: number): number {
  const s = samples.slice(-n);
  return Math.max(...s) - Math.min(...s);
}

/**
 * First step index after which every remaining sample sits within `tol` of `target`.
 * Returns -1 if it never settles — the honest answer, rather than the last index.
 */
export function settleStep(samples: number[], target: number, tol: number): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]! - target) > tol) return i + 1 < samples.length ? i + 1 : -1;
  }
  return 0;
}
