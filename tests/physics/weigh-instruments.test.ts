import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { config } from '../../src/config.ts';
import { PhysicsWorld } from '../../src/core/physics.ts';
import { BalanceInstrument } from '../../src/labs/weigh/balance.ts';
import { ScaleInstrument } from '../../src/labs/weigh/scale.ts';
import type { LabContext } from '../../src/labs/lab.ts';
import type { Entity } from '../../src/core/entities.ts';
import type { BodyHandle, CubeSpec, MetalId } from '../../src/types.ts';
import { cubeMassKg } from '../../src/data/metals.ts';
import { DT, IN } from './harness.ts';

/**
 * Stage W2 — the instruments themselves, against real Rapier (15 §13.1).
 *
 * These drive the SHIPPING classes, not a spike: the same `BalanceInstrument` and
 * `ScaleInstrument` the lab mounts, through the same facade, at the same fixed step, with
 * the same `config.weigh` numbers. A calibration that only holds for a test rig is not a
 * calibration.
 *
 * `LabContext` is stubbed down to what an instrument actually touches — physics, a scene,
 * and an iterable of entities. `EntityStore` needs a `RenderWorld`, which needs WebGL, and
 * none of that has any bearing on whether a load cell reads correctly.
 */

/** A minimal entity, enough for the instruments' load queries. */
function fakeEntity(pw: PhysicsWorld, body: BodyHandle, spec: CubeSpec, massKg: number): Entity {
  return {
    id: body as unknown as number,
    spec,
    massKg,
    body,
    mesh: new THREE.Mesh(),
    blob: new THREE.Mesh(),
    prev: pw.transformOf(body),
    curr: pw.transformOf(body),
    lastVel: { x: 0, y: 0, z: 0 },
    heldBy: null,
  } as Entity;
}

class Rig {
  readonly entities: Entity[] = [];
  readonly scene = new THREE.Scene();
  readonly ctx: LabContext;

  constructor(readonly pw: PhysicsWorld) {
    this.ctx = {
      physics: pw,
      entities: { all: this.entities } as unknown as LabContext['entities'],
      render: {} as LabContext['render'],
      scene: this.scene,
      bus: { emit: () => undefined } as unknown as LabContext['bus'],
      camera: { frameRadius: () => undefined },
      units: () => 'si' as const,
      ui: { setControls: () => undefined, toast: () => undefined },
    };
  }

  /** Places a real cube and registers it as an entity, as the app would. */
  addCube(metal: MetalId, sideIn: number, at: { x: number; y: number; z: number }): Entity {
    const spec: CubeSpec = { metal, sideM: sideIn * IN, purityPctW: 95 };
    const body = this.pw.addCube(spec, at);
    const e = fakeEntity(this.pw, body, spec, this.pw.massOf(body));
    this.entities.push(e);
    return e;
  }

  /** One fixed step through the whole instrument contract, plus entity bookkeeping. */
  step(inst: { beforePhysics(): void; afterPhysics(dt: number): void }): void {
    inst.beforePhysics();
    this.pw.step(DT, []);
    for (const e of this.entities) {
      this.pw.readTransformInto(e.body, e.curr.p, e.curr.q);
      this.pw.readVelocityInto(e.body, e.lastVel);
    }
    inst.afterPhysics(DT);
  }

  run(inst: { beforePhysics(): void; afterPhysics(dt: number): void }, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) this.step(inst);
  }
}

async function scaleRig(): Promise<{ rig: Rig; scale: ScaleInstrument }> {
  const pw = await PhysicsWorld.create();
  pw.addStaticBox(
    { x: 3, y: config.stage.floorThicknessM / 2, z: 3 },
    { x: 0, y: -config.stage.floorThicknessM / 2, z: 0 },
    'concrete',
  );
  const rig = new Rig(pw);
  const scale = new ScaleInstrument(rig.ctx);
  scale.build();
  // Settle the empty platter, then zero it — the instrument's own dead load is not a
  // measurement (15 §7.6).
  rig.run(scale, 3);
  scale.zero();
  return { rig, scale };
}

describe('the digital scale', () => {
  it('zeroes itself once the empty platter settles, without being asked', async () => {
    // The platter weighs 5 kg. A scale that showed that with nothing on it would be
    // wrong in the most visible way possible, and it did, until this.
    const pw = await PhysicsWorld.create();
    pw.addStaticBox(
      { x: 3, y: config.stage.floorThicknessM / 2, z: 3 },
      { x: 0, y: -config.stage.floorThicknessM / 2, z: 0 },
      'concrete',
    );
    const rig = new Rig(pw);
    const scale = new ScaleInstrument(rig.ctx);
    scale.build();
    expect(scale.state.zeroed).toBe(false);
    rig.run(scale, 3); // nobody calls zero()
    expect(scale.state.zeroed).toBe(true);
    expect(scale.state.status).toBe('under-min');
    expect(Math.abs(scale.state.grossForceN)).toBeLessThan(0.1);
    pw.free();
  });

  it('zeroes an empty platter to nothing', async () => {
    const { rig, scale } = await scaleRig();
    rig.run(scale, 2);
    expect(scale.state.status).toBe('under-min');
    expect(scale.state.grossForceN).toBeCloseTo(0, 1);
    rig.pw.free();
  });

  it('weighs the 1.5" W95 kilo cube at 1.00 kg', async () => {
    // 15 §2.1's headline: the cube the whole app is named after, on a scale that had to
    // earn the number through a spring, a joint and a solver.
    const { rig, scale } = await scaleRig();
    rig.addCube('W', 1.5, { x: 0, y: scale.platterTopY + 0.03, z: 0 });
    rig.run(scale, 5);
    expect(scale.state.status).toBe('stable');
    expect(scale.state.stableMassKg).toBeCloseTo(cubeMassKg('W', 1.5 * IN, 95), 2);
    rig.pw.free();
  });

  it('matches density-derived truth across the metals', async () => {
    for (const metal of ['W', 'Au', 'Cu', 'Ti'] as const) {
      const { rig, scale } = await scaleRig();
      rig.addCube(metal, 1.5, { x: 0, y: scale.platterTopY + 0.03, z: 0 });
      rig.run(scale, 5);
      const truth = cubeMassKg(metal, 1.5 * IN, 95);
      expect(scale.state.status, metal).toBe('stable');
      // Within one displayed division of the truth (15 §13.2).
      expect(Math.abs((scale.state.stableMassKg ?? 0) - truth), metal).toBeLessThanOrEqual(
        config.weigh.scale.divisionKg,
      );
      rig.pw.free();
    }
  });

  it('weighs a 4 in tungsten cube — the reason the rating is 20 kg', async () => {
    const { rig, scale } = await scaleRig();
    rig.addCube('W', 4, { x: 0, y: scale.platterTopY + 0.04, z: 0 });
    rig.run(scale, 6);
    expect(scale.state.status).toBe('stable');
    expect(scale.state.stableMassKg).toBeCloseTo(cubeMassKg('W', 4 * IN, 95), 1);
    rig.pw.free();
  });

  it('adds up a stack rather than weighing only the bottom cube', async () => {
    const { rig, scale } = await scaleRig();
    const a = rig.addCube('Al', 1.5, { x: 0, y: scale.platterTopY + 0.02, z: 0 });
    const b = rig.addCube('Al', 1.5, { x: 0, y: scale.platterTopY + 0.08, z: 0 });
    rig.run(scale, 6);
    expect(scale.state.status).toBe('stable');
    expect(scale.state.stableMassKg).toBeCloseTo(a.massKg + b.massKg, 1);
    rig.pw.free();
  });

  it('shows dynamic newtons during a drop, never a transient mass claim', async () => {
    // 15 §13.1 case 10. A cube in mid-air produces enormous transient force; a scale that
    // divided it by g mid-bounce would flash a mass three times the truth.
    const { rig, scale } = await scaleRig();
    rig.addCube('W', 1.5, { x: 0, y: scale.platterTopY + 0.25, z: 0 });
    let sawMassWhileMoving = false;
    for (let i = 0; i < 90; i++) {
      rig.step(scale);
      if (scale.state.stableMassKg !== null && Math.abs(scale.state.rawCellForceN) > 60) {
        sawMassWhileMoving = true;
      }
    }
    expect(sawMassWhileMoving).toBe(false);
    rig.run(scale, 5);
    expect(scale.state.stableMassKg).toBeCloseTo(cubeMassKg('W', 1.5 * IN, 95), 1);
    rig.pw.free();
  });

  it('goes OVERLOAD past capacity and names no mass', async () => {
    // 5 in tungsten is 36.9 kg against a 20 kg rating. (3 in, at 8 kg, used to be the
    // overload case when the scale was rated 5 kg; it is a legitimate weighing now.)
    const { rig, scale } = await scaleRig();
    rig.addCube('W', 5, { x: 0, y: scale.platterTopY + 0.05, z: 0 });
    rig.run(scale, 5);
    expect(scale.state.status).toBe('overload');
    expect(scale.state.stableMassKg).toBeNull();
    rig.pw.free();
  });

  it('drops its reading in real time when the Hand lifts the load', async () => {
    // 15 §13.1 case 8: the support force must fall as the cube is taken, not after.
    const { rig, scale } = await scaleRig();
    const e = rig.addCube('W', 1.5, { x: 0, y: scale.platterTopY + 0.03, z: 0 });
    rig.run(scale, 5);
    const loaded = scale.state.filteredCellForceN;

    // A steady upward pull of most of its weight.
    const lift = e.massKg * rig.pw.gravityMps2 * 0.8;
    for (let i = 0; i < 90; i++) {
      rig.pw.applyForce(e.body, { x: 0, y: lift, z: 0 });
      rig.step(scale);
    }
    expect(scale.state.filteredCellForceN).toBeLessThan(loaded - lift * 0.5);
    rig.pw.free();
  });

  it('reads the same from the centre and from near a corner', async () => {
    // 15 §13.2's corner-load gate. The platter is on ONE prismatic joint, so an
    // off-centre load tilts nothing — but it does change the contact patch, and the cell
    // must not care.
    const readings: number[] = [];
    for (const dx of [0, 0.035]) {
      const { rig, scale } = await scaleRig();
      rig.addCube('W', 1, { x: dx, y: scale.platterTopY + 0.03, z: 0 });
      rig.run(scale, 5);
      expect(scale.state.status).toBe('stable');
      readings.push(scale.state.stableMassKg ?? NaN);
      rig.pw.free();
    }
    expect(Math.abs(readings[0]! - readings[1]!)).toBeLessThanOrEqual(
      config.weigh.scale.divisionKg,
    );
  });
});

// ---------------------------------------------------------------------------------

async function balanceRig(): Promise<{ rig: Rig; bal: BalanceInstrument }> {
  const pw = await PhysicsWorld.create();
  pw.addStaticBox(
    { x: 3, y: config.stage.floorThicknessM / 2, z: 3 },
    { x: 0, y: -config.stage.floorThicknessM / 2, z: 0 },
    'concrete',
  );
  const rig = new Rig(pw);
  const bal = new BalanceInstrument(rig.ctx);
  bal.build();
  rig.run(bal, 4);
  return { rig, bal };
}

/**
 * Places cubes in one or both pans, THEN settles.
 *
 * Both sides go in before a single step runs. Loading one pan, settling, and then loading
 * the other means the second cube is dropped at a pan that has already risen to the stop
 * — it misses, and the test measures a cube bouncing off the floor.
 */
function place(rig: Rig, side: -1 | 1, metal: MetalId, sizeIn: number, n = 1): void {
  const B = config.weigh.balance;
  const sideM = sizeIn * IN;
  // Spaced by the CUBE'S OWN SIZE — a fixed 30 mm spread overlaps 2 in cubes, which spawn
  // interpenetrating and blow apart. Laid out FLAT in a grid across the dish rather than
  // stacked: the pan is 0.32 m across precisely so seven 2 in cubes fit side by side, and
  // a three-high stack topples off a tilting pan instead of being weighed.
  const pitch = sideM * 1.12;
  const cols = 3;
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const rows = Math.ceil(n / cols);
    // MIRRORED through `side`, or one pan's cubes sit outboard and the other's inboard —
    // a real torque difference that swamps the 5 % the demonstration is about.
    const spread = (col - (inRow - 1) / 2) * pitch;
    rig.addCube(metal, sizeIn, {
      x: side * (B.armM + spread),
      // Just above the dish; a long drop bounces a heavy cube over the rim.
      y: B.pivotHeightM - B.dropM + sideM / 2 + 0.012,
      z: (row - (rows - 1) / 2) * pitch,
    });
  }
}

describe('the equal-arm balance', () => {
  it('rests level when empty, with no motor anywhere in it', async () => {
    const { rig, bal } = await balanceRig();
    rig.run(bal, 5);
    expect(Math.abs(bal.state.angleDeg)).toBeLessThan(0.25);
    expect(bal.state.status).toBe('balanced');
    rig.pw.free();
  });

  it('returns to level after a disturbance, on gravity alone', async () => {
    // 15 §6.2's central claim. Nothing in BalanceInstrument can pull the beam anywhere —
    // the only torque it applies is `-c*w`, which removes energy and cannot choose a side.
    const { rig, bal } = await balanceRig();
    rig.pw.setVelocity(rig.pw.allBodies()[1]!, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.0 });
    rig.run(bal, 8);
    expect(Math.abs(bal.state.angleDeg)).toBeLessThan(0.25);
    expect(bal.state.status).toBe('balanced');
    rig.pw.free();
  });

  it('stays level under equal loads', async () => {
    const { rig, bal } = await balanceRig();
    place(rig, -1, 'Al', 1.5);
    place(rig, 1, 'Al', 1.5);
    rig.run(bal, 8);
    expect(Math.abs(bal.state.angleDeg)).toBeLessThan(0.5);
    rig.pw.free();
  });

  it('tips toward the heavier side, and says which', async () => {
    const { rig, bal } = await balanceRig();
    place(rig, -1, 'W', 1);
    place(rig, 1, 'Al', 1);
    rig.run(bal, 8);
    // Positive is left-down, and tungsten is on the left.
    expect(bal.state.angleDeg).toBeGreaterThan(1);
    expect(['left-heavy', 'at-stop']).toContain(bal.state.status);
    rig.pw.free();
  });

  it('shows the signature demonstration: 7 aluminium outweigh 1 tungsten', async () => {
    /*
     * 15 §1's whole reason for the lab. One 2 in W95 cube is 2.36 kg; seven 2 in aluminium
     * cubes are 2.48 kg — about 5 % heavier — so the ALUMINIUM side goes down, which is
     * the result that makes people recount the cubes.
     *
     * Measured at -2.06 deg here, and between -1.8 and -2.2 across pan masses 0.8-2.0 kg
     * and counterweight depths 18-54 mm, so it is a broad optimum rather than a number
     * balanced on a knife edge.
     */
    const { rig, bal } = await balanceRig();
    place(rig, -1, 'W', 2, 1);
    place(rig, 1, 'Al', 2, 7);
    rig.run(bal, 15);

    expect(Number.isFinite(bal.state.angleDeg)).toBe(true);
    // Negative is right-down, and the aluminium is on the right.
    expect(bal.state.angleDeg).toBeLessThan(-0.5);
    expect(Math.abs(bal.state.angleDeg)).toBeLessThan(config.weigh.balance.limitDeg);
    // Every cube still on the instrument, not on the floor.
    expect([...rig.entities].filter((e) => e.curr.p.y < 0.2)).toHaveLength(0);
    rig.pw.free();
  });

  it('never travels past its stop, however badly it is loaded', async () => {
    /*
     * KNOWN LIMIT, asserted for what it is. A large single-sided load — 2 x 2 in tungsten
     * against one aluminium — slams the beam down hard enough that the pan throws its
     * cubes out, across every pan mass and counterweight depth swept. Real up to a point,
     * since nobody expects 4.7 kg dumped on one side of a balance to sit politely, but the
     * load should not escape the dish, and that is a rim-geometry item for W3.
     *
     * What this pins is the part that must hold regardless: the joint limit, and no NaN.
     */
    const { rig, bal } = await balanceRig();
    place(rig, -1, 'W', 2, 2);
    place(rig, 1, 'Al', 2, 1);
    rig.run(bal, 12);
    expect(Number.isFinite(bal.state.angleDeg)).toBe(true);
    expect(Math.abs(bal.state.angleDeg)).toBeLessThan(config.weigh.balance.limitDeg + 0.5);
    rig.pw.free();
  });

  it('leaves nothing behind when torn down', async () => {
    const pw = await PhysicsWorld.create();
    const rig = new Rig(pw);
    const before = { bodies: pw.bodyCount, joints: pw.jointCount };
    const bal = new BalanceInstrument(rig.ctx);
    bal.build();
    // One revolute at the pivot, and nothing else: the pans are part of the beam.
    expect(pw.jointCount).toBe(1);
    bal.teardown();
    expect(pw.bodyCount).toBe(before.bodies);
    expect(pw.jointCount).toBe(before.joints);
    expect(rig.scene.children).toHaveLength(0);
    pw.free();
  });
});
