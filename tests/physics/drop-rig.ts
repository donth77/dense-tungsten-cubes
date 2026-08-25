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
import type { BodyHandle, ImpactEvent, Vec3 } from '../../src/types.ts';
import { DT, G } from './harness.ts';
import { dragForceInto, speedAfterFallMps, terminalVelocityMps } from '../../src/core/aero.ts';

/* ------------------------------------------------------------------ air (16 §6.3) */

/**
 * D1 moved the drag model into `core/aero.ts` — the shipping module the lab applies.
 * The spike keeps thin 1-D wrappers so its vertical-drop tests read plainly, and so
 * they now exercise the module that ships rather than a test-local copy.
 */
export function terminalVelocity(massKg: number, sideM: number): number {
  return terminalVelocityMps(massKg, sideM);
}

export function speedAfterFall(hM: number, vtMps: number): number {
  return speedAfterFallMps(hM, vtMps);
}

const DRAG_IN: Vec3 = { x: 0, y: 0, z: 0 };
const DRAG_OUT: Vec3 = { x: 0, y: 0, z: 0 };

export function dragForceClamped(vyMps: number, sideM: number, massKg: number, dt: number): number {
  DRAG_IN.y = vyMps;
  return dragForceInto(DRAG_IN, sideM, massKg, dt, DRAG_OUT).y;
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

/**
 * D1 moved the pad into `src/labs/shared/compliant-pad.ts` — the component the lab
 * mounts. `PadRig` is now a thin adapter so the D0 tests keep their vocabulary while
 * driving the SHIPPING class (the W2 principle: a calibration that only holds for a
 * test rig is not a calibration). The params come from `config.drop`, so a tuning
 * change moves these tests with it; the gates are re-exported for the tests' regime
 * arithmetic.
 *
 * D0 spiked with rubber/foam stand-in fabrics; D1's real `trampoline` surface (pair
 * CoR 0.85) raises the fabric-bounce numbers, exactly as 16 §7.3's amendment said it
 * would — the regime assertions in drop.test.ts state the measured values.
 */
import { CompliantPad, foamParams, trampolineParams } from '../../src/labs/shared/compliant-pad.ts';
import type { CompliantPadParams } from '../../src/labs/shared/compliant-pad.ts';

export const TRAMPOLINE_SEED: CompliantPadParams = trampolineParams();
export const FOAM_SEED: CompliantPadParams = foamParams();

export function bottomsOut(cubeKg: number, impactSpeedMps: number): boolean {
  return 0.5 * cubeKg * impactSpeedMps ** 2 > config.drop.gates.trampolineBottomOutJ;
}

export function bottomsOutFoam(cubeKg: number, impactSpeedMps: number): boolean {
  return 0.5 * cubeKg * impactSpeedMps ** 2 > config.drop.gates.foamBottomOutJ;
}

export class PadRig {
  readonly inner: CompliantPad;

  constructor(pw: PhysicsWorld, p: CompliantPadParams, restCentreY = 0.3, rigid = false) {
    this.inner = new CompliantPad(
      pw,
      p,
      { x: 0, z: 0 },
      restCentreY,
      0.45,
      rigid ? 'crushed' : 'live',
    );
  }

  get pad(): BodyHandle {
    return this.inner.pad;
  }
  get restCentreY(): number {
    return this.inner.restCentreY;
  }
  get padTopRestY(): number {
    return this.inner.padTopRestY;
  }
  get minPadY(): number {
    return this.inner.minPadY;
  }
  get arrested(): boolean {
    return this.inner.arrested;
  }
  get rigid(): boolean {
    return this.inner.regime === 'crushed';
  }
  padY(): number {
    return this.inner.padY();
  }
  bottomed(): boolean {
    return this.inner.bottomed();
  }
  beforeStep(): void {
    this.inner.beforePhysics();
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
