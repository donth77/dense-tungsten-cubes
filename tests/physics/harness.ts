/**
 * Shared rig for the actual-Rapier calibration suite (14 §7).
 *
 * Everything here drives the REAL `PhysicsWorld` — the same class the app runs — against
 * the real WASM solver. Nothing is mocked. A calibration number that only holds for a
 * stub is not a calibration number.
 */
import { PhysicsWorld } from '../../src/core/physics.ts';
import { config } from '../../src/config.ts';
import type { BodyHandle, CubeSpec, ImpactEvent, MetalId, SurfaceId } from '../../src/types.ts';

export const IN = 0.0254;
export const DT = config.loop.DT;
export const G = config.physics.gravityMps2;

/** A world with a 6 m floor of the given surface, top face at y = 0. */
export async function worldWithFloor(surface: SurfaceId = 'concrete'): Promise<PhysicsWorld> {
  const pw = await PhysicsWorld.create();
  pw.addStaticBox(
    {
      x: config.stage.floorHalfSizeM,
      y: config.stage.floorThicknessM / 2,
      z: config.stage.floorHalfSizeM,
    },
    { x: 0, y: -config.stage.floorThicknessM / 2, z: 0 },
    surface,
  );
  return pw;
}

/** An empty world — for free fall, where a floor would only get in the way. */
export async function emptyWorld(): Promise<PhysicsWorld> {
  return PhysicsWorld.create();
}

export function cube(
  pw: PhysicsWorld,
  metal: MetalId,
  sideIn: number,
  at: { x: number; y: number; z: number },
  purityPctW = 95,
): BodyHandle {
  const spec: CubeSpec = { metal, sideM: sideIn * IN, purityPctW };
  return pw.addCube(spec, at);
}

/** Step `seconds` of simulated time, collecting every impact reported along the way. */
export function run(pw: PhysicsWorld, seconds: number, impacts?: ImpactEvent[]): void {
  const n = Math.round(seconds / DT);
  const scratch: ImpactEvent[] = [];
  for (let i = 0; i < n; i++) {
    scratch.length = 0;
    pw.step(DT, scratch);
    if (impacts) impacts.push(...scratch);
  }
}

/** Step until `done` returns true, or `maxSeconds` elapses. Returns seconds elapsed. */
export function runUntil(
  pw: PhysicsWorld,
  done: () => boolean,
  maxSeconds = 20,
  impacts?: ImpactEvent[],
): number {
  const n = Math.round(maxSeconds / DT);
  const scratch: ImpactEvent[] = [];
  for (let i = 0; i < n; i++) {
    scratch.length = 0;
    pw.step(DT, scratch);
    if (impacts) impacts.push(...scratch);
    if (done()) return (i + 1) * DT;
  }
  return maxSeconds;
}

/**
 * Kinetic coefficient of friction, inferred from deceleration over a SHORT FIXED window
 * straight after launch.
 *
 * The window matters. Fitting over "most of the slide" looks more thorough and is much
 * worse: at mu = 0.9 the block stops in 0.23 s, so a percentile window is mostly the
 * stationary tail and reads low; at mu = 0.04 the block is still moving after 5 s and the
 * same window straddles a tipping cube.
 *
 * 4 m/s over 6 steps is the window that works at BOTH ends. It keeps the fractional
 * velocity change modest even at mu = 0.9 (0.88 of 4 m/s, so the estimate is not
 * dominated by the last step's contact state), while a mu = 0.04 slide still loses
 * 39 mm/s — five orders of magnitude above float32 noise at this speed.
 */
export function measureFriction(pw: PhysicsWorld, h: BodyHandle, v0 = 4, steps = 6): number {
  pw.setVelocity(h, { x: v0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const before = pw.velocityOf(h);
  const speed0 = Math.hypot(before.x, before.z);
  run(pw, steps * DT);
  const after = pw.velocityOf(h);
  const speed1 = Math.hypot(after.x, after.z);
  return (speed0 - speed1) / (steps * DT) / G;
}

/**
 * Coefficient of restitution: rebound speed / approach speed at the first bounce, read
 * from the sign change of vertical velocity.
 */
export function measureRestitution(
  pw: PhysicsWorld,
  h: BodyHandle,
  minApproach = 0.5,
): { e: number; vIn: number; vOut: number } {
  let prev = 0;
  const scratch: ImpactEvent[] = [];
  for (let i = 0; i < 1200; i++) {
    scratch.length = 0;
    pw.step(DT, scratch);
    const vy = pw.velocityOf(h).y;
    if (prev < -minApproach && vy > 0) return { e: vy / -prev, vIn: -prev, vOut: vy };
    prev = vy;
  }
  return { e: 0, vIn: 0, vOut: 0 };
}

/** How far below its ideal resting height a body settled, in metres. */
export function sinkM(pw: PhysicsWorld, h: BodyHandle, idealY: number): number {
  return idealY - pw.transformOf(h).p.y;
}
