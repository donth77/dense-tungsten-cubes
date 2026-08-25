import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { config } from '../../src/config.ts';
import { DropLab } from '../../src/labs/drop/index.ts';
import { PhysicsWorld } from '../../src/core/physics.ts';
import type { Entity } from '../../src/core/entities.ts';
import type { LabContext } from '../../src/labs/lab.ts';
import type { CubeSpec, EntityId, ImpactEvent, MetalId } from '../../src/types.ts';
import { DT, G, IN } from './harness.ts';

/**
 * Stage D2 — the Drop Tower as SHIPPED (16 §15 D2, §16.1), the weigh-instruments
 * pattern: the same DropLab the tab mounts, the same fixed-step order the app runs
 * (beforePhysics → step → capture → afterPhysics → onImpacts), the same config.
 */

class MiniStore {
  readonly #map = new Map<EntityId, Entity>();
  #next = 1;

  constructor(readonly pw: PhysicsWorld) {}

  get all(): Iterable<Entity> {
    return this.#map.values();
  }
  get(id: EntityId): Entity | undefined {
    return this.#map.get(id);
  }
  setKind(id: EntityId, kind: Entity['kind']): void {
    const e = this.#map.get(id);
    if (!e || e.kind === kind) return;
    this.pw.setBodyKind(e.body, kind);
    e.kind = kind;
  }

  spawn(metal: MetalId, sideIn: number, at: { x: number; y: number; z: number }): Entity {
    const id = this.#next++;
    const spec: CubeSpec = { metal, sideM: sideIn * IN, purityPctW: 95 };
    const body = this.pw.addCube(spec, at, { entityId: id });
    const t = this.pw.transformOf(body);
    const e = {
      id,
      spec,
      massKg: this.pw.massOf(body),
      body,
      mesh: new THREE.Mesh(),
      blob: new THREE.Mesh(),
      prev: structuredClone(t),
      curr: structuredClone(t),
      lastVel: { x: 0, y: 0, z: 0 },
      heldBy: null,
      kind: 'dynamic',
    } as Entity;
    this.#map.set(id, e);
    return e;
  }

  capture(): void {
    for (const e of this.#map.values()) {
      this.pw.readTransformInto(e.body, e.curr.p, e.curr.q);
      this.pw.readVelocityInto(e.body, e.lastVel);
    }
  }
}

class Rig {
  readonly scene = new THREE.Scene();
  readonly store: MiniStore;
  readonly ctx: LabContext;
  readonly lab = new DropLab();

  constructor(readonly pw: PhysicsWorld) {
    this.store = new MiniStore(pw);
    this.ctx = {
      physics: pw,
      entities: this.store as unknown as LabContext['entities'],
      render: {} as LabContext['render'],
      scene: this.scene,
      bus: { emit: () => undefined } as unknown as LabContext['bus'],
      camera: { frameRadius: () => undefined },
      units: () => 'si' as const,
      ui: {
        setControls: () => undefined,
        mountPanel: () => ({ update: () => undefined, dispose: () => undefined }),
        toast: () => undefined,
        share: () => undefined,
        resetLab: () => undefined,
      },
      fx: {
        play: () => undefined,
        haptic: () => undefined,
        decals: { setTarget: () => undefined, clear: () => undefined },
      },
      replay: {
        track: () => undefined,
        untrack: () => undefined,
        markNow: () => ({ step: -1 }),
        snapshot: () => null,
        playClip: () => undefined,
        play: () => undefined,
        isPlaying: () => false,
      },
    };
  }

  /** One fixed step in the app's exact order (16 §11.1). */
  step(): void {
    this.lab.beforePhysics(DT);
    const impacts: ImpactEvent[] = [];
    this.pw.step(DT, impacts);
    this.store.capture();
    this.lab.afterPhysics();
    this.lab.onImpacts(impacts);
  }

  run(seconds: number): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step();
  }

  runUntil(done: () => boolean, maxSeconds = 30): boolean {
    const n = Math.round(maxSeconds / DT);
    for (let i = 0; i < n; i++) {
      this.step();
      if (done()) return true;
    }
    return false;
  }
}

async function rigWithStage(): Promise<Rig> {
  const pw = await PhysicsWorld.create();
  pw.addStaticBox(
    {
      x: config.stage.floorHalfSizeM,
      y: config.stage.floorThicknessM / 2,
      z: config.stage.floorHalfSizeM,
    },
    { x: 0, y: -config.stage.floorThicknessM / 2, z: 0 },
    'concrete',
  );
  const rig = new Rig(pw);
  rig.lab.build(rig.ctx);
  return rig;
}

/** Spawn on the plate, hoist to `hM`, wait for ARMED, drop, wait for the verdict. */
function fullDrop(rig: Rig, metal: MetalId, sideIn: number, hM: number): void {
  rig.store.spawn(metal, sideIn, {
    x: 0,
    y: config.drop.plate.topYM + (sideIn * IN) / 2 + 0.02,
    z: 0,
  });
  rig.run(0.5); // land and settle on the plate
  rig.lab.setHeight(hM);
  rig.lab.hoist();
  expect(
    rig.runUntil(() => rig.lab.towerPhase === 'armed', 10),
    'reaches ARMED',
  ).toBe(true);
  rig.lab.dropNow();
  expect(
    rig.runUntil(() => rig.lab.state?.phase === 'done', 12),
    'reaches a verdict',
  ).toBe(true);
}

describe('the Drop Tower, as shipped', () => {
  it('winches, arms, releases at exactly h with zero velocity, and reads an honest 2 m drop', async () => {
    const rig = await rigWithStage();
    const e = rig.store.spawn('W', 2, { x: 0, y: config.drop.plate.topYM + IN + 0.02, z: 0 });
    rig.run(0.5);
    rig.lab.hoist();
    expect(rig.lab.towerPhase === 'loading' || rig.lab.towerPhase === 'hoisting').toBe(true);
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 10)).toBe(true);
    // Carried: kinematic, level, bottom face at h above the plate.
    expect(rig.pw.bodyKindOf(e.body)).toBe('kinematic');
    const bottom = e.curr.p.y - IN;
    expect(bottom - config.drop.plate.topYM).toBeCloseTo(2, 2);

    rig.lab.dropNow();
    expect(rig.pw.bodyKindOf(e.body)).toBe('dynamic');
    expect(rig.runUntil(() => rig.lab.state?.phase === 'done', 12)).toBe(true);
    const st = rig.lab.state!;
    // 2 m in AIR: a 2" W is dense enough that drag shaves under half a percent.
    const ideal = Math.sqrt(2 * G * 2);
    expect(st.impact!.vMps).toBeGreaterThan(ideal * 0.985);
    expect(st.impact!.vMps).toBeLessThan(ideal * 1.005);
    expect(st.impact!.energyJ).toBeCloseTo(0.5 * e.massKg * st.impact!.vMps ** 2, 6);
    expect(st.impact!.partner).toBe('concrete');
    expect(st.verdict).toBe('landed');
    rig.pw.free();
  }, 120_000);

  it('delivers the wow moment: 4" W from 10 m cracks the concrete at ~1.84 kJ', async () => {
    const rig = await rigWithStage();
    fullDrop(rig, 'W', 4, 10);
    const st = rig.lab.state!;
    expect(st.impact!.energyJ).toBeGreaterThan(1800);
    expect(st.impact!.energyJ).toBeLessThan(1860);
    expect(st.impact!.tFlightS).toBeCloseTo(Math.sqrt((2 * 10) / G), 1);
    expect(st.verdict).toBe('cracked');
    rig.pw.free();
  }, 120_000);

  it('teaches Galileo: the same ¼" Al cube lands slower in AIR than in VACUUM', async () => {
    const air = await rigWithStage();
    fullDrop(air, 'Al', 0.25, 20);
    const vAir = air.lab.state!.impact!.vMps;
    air.pw.free();

    const vac = await rigWithStage();
    vac.lab.air = false;
    fullDrop(vac, 'Al', 0.25, 20);
    const vVac = vac.lab.state!.impact!.vMps;
    vac.pw.free();

    expect(vAir).toBeGreaterThan(13.9);
    expect(vAir).toBeLessThan(14.5);
    expect(vVac).toBeGreaterThan(19.6);
    expect(vVac).toBeLessThan(19.9);
  }, 120_000);

  it('gates the trampoline: 2" W is THROWN (bounced), 4" W lands on a crushed mat, BOTTOMED OUT', async () => {
    const caught = await rigWithStage();
    caught.lab.setFloor('trampoline');
    fullDrop(caught, 'W', 2, 5);
    // Re-pinned for the 8 kN/m retune (2026-08-25): the mat now genuinely throws it.
    expect(caught.lab.state!.verdict).toBe('bounced');
    expect(caught.lab.floorId).toBe('trampoline');
    caught.pw.free();

    const crushed = await rigWithStage();
    crushed.lab.setFloor('trampoline');
    fullDrop(crushed, 'W', 4, 5);
    expect(crushed.lab.state!.verdict).toBe('bottomed-out');
    // The slammed landing must still record an HONEST impact (the slam teleport ate
    // the first contact when it fired too close — user-visible as a 0.4 mph
    // "impact", 2026-08-25). ~9.9 m/s vacuum from 5 m, drag shaves a little.
    const imp = crushed.lab.state!.impact!;
    writeFileSync(
      '/private/tmp/claude-501/-Users-tomdonohue-projects-tungsten-cube-sim/6337dfa8-ecea-4672-8ddd-5daab02198d9/scratchpad/crush-impact.json',
      JSON.stringify(imp),
    );
    expect(imp.vMps).toBeGreaterThan(8);
    expect(imp.tFlightS).toBeLessThan(1.3);
    expect(imp.deliveredJ).toBeGreaterThan(200);
    crushed.pw.free();
  }, 120_000);

  it('switches every floor cleanly and tears down with nothing leaked', async () => {
    const pw = await PhysicsWorld.create();
    const before = { bodies: pw.bodyCount, joints: pw.jointCount };
    const rig = new Rig(pw);
    rig.lab.build(rig.ctx);
    for (const id of ['steel', 'oak', 'sand', 'trampoline', 'foam', 'concrete'] as const) {
      rig.lab.setFloor(id);
      rig.run(0.2);
    }
    rig.lab.teardown();
    expect(pw.bodyCount).toBe(before.bodies);
    expect(pw.jointCount).toBe(before.joints);
    expect(rig.scene.children).toHaveLength(0);
    pw.free();
  }, 120_000);

  it('is deterministic: two fresh worlds, bit-identical readout', async () => {
    const one = await rigWithStage();
    fullDrop(one, 'W', 2, 3);
    const a = one.lab.state!.impact!;
    one.pw.free();
    const two = await rigWithStage();
    fullDrop(two, 'W', 2, 3);
    const b = two.lab.state!.impact!;
    two.pw.free();
    expect(Object.is(a.vMps, b.vMps)).toBe(true);
    expect(Object.is(a.energyJ, b.energyJ)).toBe(true);
    expect(a.tFlightS).toBe(b.tFlightS);
  }, 120_000);

  it('drops a BATCH: every cube in the footprint rides and releases together', async () => {
    const rig = await rigWithStage();
    const w = rig.store.spawn('W', 2, { x: 0, y: config.drop.plate.topYM + IN + 0.02, z: 0 });
    const al = rig.store.spawn('Al', 1, {
      x: 0.15,
      y: config.drop.plate.topYM + IN / 2 + 0.02,
      z: 0.15,
    });
    rig.run(0.5);
    rig.lab.setHeight(3);
    rig.lab.hoist();
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 10)).toBe(true);
    // BOTH captured: the batch rides kinematic, each at its own plate position.
    expect(rig.pw.bodyKindOf(w.body)).toBe('kinematic');
    expect(rig.pw.bodyKindOf(al.body)).toBe('kinematic');
    expect(w.curr.p.y - IN - config.drop.plate.topYM).toBeCloseTo(3, 1);

    rig.lab.dropNow();
    expect(rig.pw.bodyKindOf(w.body)).toBe('dynamic');
    expect(rig.pw.bodyKindOf(al.body)).toBe('dynamic');
    expect(rig.runUntil(() => rig.lab.state?.phase === 'done', 15)).toBe(true);
    const st = rig.lab.state!;
    // The readout followed the HEAVIEST cube: energy is the 2" W's ½mv², not the pair's.
    expect(st.impact!.energyJ).toBeCloseTo(0.5 * w.massKg * st.impact!.vMps ** 2, 6);
    expect(st.verdict).not.toBeNull();
    // Both cubes are down on the plate, not lost.
    expect(w.curr.p.y).toBeLessThan(0.2);
    expect(al.curr.p.y).toBeLessThan(0.2);
    rig.pw.free();
  }, 120_000);

  it('applyShare restores floor, height, and drag — and shareBlock round-trips it', async () => {
    const rig = await rigWithStage();
    rig.lab.applyShare({ hM: 7.3, floor: 'oak', air: false });
    expect(rig.lab.shareBlock()).toEqual({ hM: 7.3, floor: 'oak', air: false });
    // The codec vouches for shape, not for range: height clamps to the tower's rails,
    // and a SurfaceId that is not a floor of this lab leaves the floor alone.
    rig.lab.applyShare({ hM: 99, floor: 'rubber', air: true });
    const block = rig.lab.shareBlock();
    expect(block.hM).toBe(config.drop.tower.maxHM);
    expect(block.floor).toBe('oak');
    expect(block.air).toBe(true);
    rig.lab.teardown();
  });

  it('spawns fill the carriage footprint, then yield to staging while carrying', async () => {
    const rig = await rigWithStage();
    const p1 = rig.lab.preferredSpawnPoint()!;
    expect(Math.hypot(p1.x, p1.z)).toBeLessThan(0.01);
    rig.store.spawn('W', 2, { x: p1.x, y: p1.y, z: p1.z });
    rig.run(0.5);
    // Room remains in the footprint: the NEXT spawn joins the batch on the plate.
    const p2 = rig.lab.preferredSpawnPoint()!;
    expect(Math.abs(p2.x)).toBeLessThan(0.25);
    expect(Math.abs(p2.z)).toBeLessThan(0.25);
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeGreaterThan(0.1);
    // While the winch is carrying, new cubes go to the staging row instead.
    rig.lab.hoist();
    rig.run(0.1);
    const p3 = rig.lab.preferredSpawnPoint()!;
    expect(p3.z).toBeCloseTo(config.drop.staging.zM, 6);
    rig.pw.free();
  }, 120_000);
});
