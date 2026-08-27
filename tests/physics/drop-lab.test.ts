import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { config } from '../../src/config.ts';
import { DropLab } from '../../src/labs/drop/index.ts';
import { __setCrushAssetsForTests } from '../../src/labs/drop/asset.ts';
import type { CrushAssets, FragChunk } from '../../src/labs/drop/asset.ts';
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
        particles: () => undefined,
        decals: {
          setTarget: () => undefined,
          setSplatTarget: () => undefined,
          splat: () => undefined,
          clear: () => undefined,
        },
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
    y: rig.lab.platformY + (sideIn * IN) / 2 + 0.02,
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
    const e = rig.store.spawn('W', 2, { x: 0, y: rig.lab.platformY + IN + 0.02, z: 0 });
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
    expect(st.impact!.partner).toBe('steel');
    expect(st.verdict).toBe('rang'); // steel default since the 2026-08-25 floor reduction
    rig.pw.free();
  }, 120_000);

  it('delivers the wow moment: 4" W from 10 m rings the steel at ~1.84 kJ', async () => {
    const rig = await rigWithStage();
    fullDrop(rig, 'W', 4, 10);
    const st = rig.lab.state!;
    expect(st.impact!.energyJ).toBeGreaterThan(1800);
    expect(st.impact!.energyJ).toBeLessThan(1860);
    expect(st.impact!.tFlightS).toBeCloseTo(Math.sqrt((2 * 10) / G), 1);
    expect(st.verdict).toBe('rang');
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
    for (const id of ['trampoline', 'foam', 'steel'] as const) {
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
    const w = rig.store.spawn('W', 2, { x: 0, y: rig.lab.platformY + IN + 0.02, z: 0 });
    const al = rig.store.spawn('Al', 1, {
      x: 0.15,
      y: rig.lab.platformY + IN / 2 + 0.02,
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
    rig.lab.applyShare({ hM: 7.3, floor: 'foam', air: false });
    expect(rig.lab.shareBlock()).toEqual({ hM: 7.3, floor: 'foam', air: false });
    // The codec vouches for shape, not for range: height clamps to the tower's rails,
    // and a SurfaceId that is not a floor of this lab leaves the floor alone.
    rig.lab.applyShare({ hM: 99, floor: 'oak', air: true }); // a SurfaceId that is no longer a floor
    const block = rig.lab.shareBlock();
    expect(block.hM).toBe(config.drop.tower.maxHM);
    expect(block.floor).toBe('foam');
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

describe('C1 — the wine glass on the tower (18 §6)', () => {
  it('deploys, persists through the carry, and SHATTERS under 2″ W from 2 m', async () => {
    const rig = await rigWithStage();
    const base = rig.pw.bodyCount;
    rig.lab.setTarget('wine-glass');
    rig.run(0.2);
    expect(rig.lab.targetId).toBe('wine-glass');
    expect(rig.pw.bodyCount).toBe(base + 2); // pedestal + intact glass

    rig.store.spawn('W', 2, { x: 0.15, y: rig.lab.platformY + IN + 0.02, z: 0.15 });
    rig.run(0.5);
    rig.lab.setHeight(2);
    rig.lab.hoist();
    rig.run(0.1);
    // The raised-platform redesign (2026-08-25): the target PERSISTS — hoisting no
    // longer sweeps the plate, and refresh() begins each cycle with a fresh glass.
    // −1: the platform collider leaves with the winch (kinematic cargo needs no floor).
    expect(rig.pw.bodyCount, 'pedestal + fresh glass + cube, platform away').toBe(base + 2);
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 10)).toBe(true);

    rig.lab.dropNow();
    expect(rig.runUntil(() => rig.lab.state?.phase === 'done', 12)).toBe(true);
    expect(rig.lab.state!.verdict).toBe('shattered');
    // Glass gone; pedestal + cube + the surviving shards remain. CCD keeps most
    // aboard, and the prop cull sweeps any edge-case escapee — tolerate one or two.
    // Platform still away (the carriage is riding home as the verdict lands).
    expect(rig.pw.bodyCount).toBeGreaterThanOrEqual(base + 1 + 10);
    expect(rig.pw.bodyCount).toBeLessThanOrEqual(base + 1 + 12);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('a light cube from the minimum target height SURVIVES; pads refuse targets', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('wine-glass');
    rig.run(0.2);
    rig.store.spawn('Al', 1, { x: 0.15, y: rig.lab.platformY + IN / 2 + 0.02, z: 0.15 });
    rig.run(0.5);
    rig.lab.setHeight(0.1); // clamps to 0.6 while a target stands
    rig.lab.hoist();
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 10)).toBe(true);
    rig.lab.dropNow();
    expect(rig.runUntil(() => rig.lab.state?.phase === 'done', 12)).toBe(true);
    rig.run(0.1); // SURVIVED is decided at the done transition; it lands next tick
    expect(rig.lab.state!.verdict).toBe('survived');
    // …and the little cube sits INSIDE the goblet, not on an invisible lid over it
    // (the solid bowl collider bug, 2026-08-25).
    const survivor = [...rig.store.all].find((e) => e.spec.metal === 'Al')!;
    expect(survivor.curr.p.y).toBeLessThan(0.42); // below the rim (0.423)
    expect(survivor.curr.p.y).toBeGreaterThan(0.3); // caught in the cup, not fallen through

    rig.lab.setFloor('trampoline');
    rig.run(0.1);
    expect(rig.lab.targetId, 'pads clear the target').toBe('none');
    rig.lab.setTarget('wine-glass');
    expect(rig.lab.targetId, 'and refuse a new one').toBe('none');
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('C2 — the watermelon (18 §6)', () => {
  it('survives a light tap, then BURSTS past 40 J into halves, chunks, and a SPLAT', async () => {
    const under = await rigWithStage();
    under.lab.setTarget('watermelon');
    under.run(0.2);
    fullDrop(under, 'W', 2, 0.6); // ~6 J at the rind — a bruise, not a burst
    under.run(0.1);
    expect(under.lab.state!.verdict).toBe('survived');
    under.lab.teardown();
    under.pw.free();

    const over = await rigWithStage();
    over.lab.setTarget('watermelon');
    over.run(0.2);
    const b0 = over.pw.bodyCount; // includes platform + melon
    fullDrop(over, 'W', 2, 2.5); // ~51 J of arrival — the hero moment (top is at 0.34)
    over.run(0.1);
    expect(over.lab.state!.verdict).toBe('splat');
    // Melon gone; cube + ten fallback chunks remain — headless has no GLBs, so the
    // fracture-fragment path is the browser's; platform away with the winch;
    // tolerate a culled escapee or two.
    expect(over.pw.bodyCount).toBeGreaterThanOrEqual(b0 - 1 - 1 + 1 + 8);
    expect(over.pw.bodyCount).toBeLessThanOrEqual(b0 - 1 - 1 + 1 + 10);
    over.lab.teardown();
    over.pw.free();
  }, 120_000);

  it('deploys flat on the plate — no pedestal for the hero', async () => {
    const rig = await rigWithStage();
    const base = rig.pw.bodyCount;
    rig.lab.setTarget('watermelon');
    rig.run(0.2);
    expect(rig.pw.bodyCount).toBe(base + 1);
    rig.lab.setTarget('none');
    rig.run(0.1);
    expect(rig.pw.bodyCount).toBe(base);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

/**
 * C2.4 — the egg (18 §6, 02 §7): the only target that breaks WITHOUT an impact.
 * 0.05 J is an 8 mm drop, so the honest lesson is the 45 N sustained-force trigger —
 * gentle placement is the only survival, and "gentle" is a force, not an energy.
 */
describe('C1.6 — a knocked-off target breaks itself (user, 2026-08-25)', () => {
  /** The deployed target body: the only many-part dynamic prop on the stage. */
  function targetBody(rig: Rig) {
    const b = [...rig.pw.allBodies()].find(
      (h) => rig.pw.partsOf(h).length > 1 && rig.pw.bodyKindOf(h) === 'dynamic',
    );
    expect(b, 'the glass is deployed').toBeDefined();
    return b!;
  }

  it('a glass swept off its plinth SHATTERS on the plate instead of bouncing intact', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('wine-glass');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    /*
     * Sweep it off, the way a cube clipping the rim does. Nothing here breaks it by
     * ARRIVAL energy — a 0.15 kg glass falling 23 cm carries 0.34 J against a 1 J
     * threshold — so before `selfBreakMps` the goblet bounced on the plate and sat
     * there whole (user-caught). Brittle failure is local stress: what breaks it is
     * meeting steel at 1.9 m/s.
     */
    rig.pw.setVelocity(targetBody(rig), { x: 2.5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(
      rig.runUntil(() => rig.lab.targetState.broken, 4),
      'the fall breaks it',
    ).toBe(true);
    // `broken` flips at the impact; the swap itself is queued for the next
    // beforePhysics (18 §5.2), so the shards exist a step later.
    rig.run(0.3);
    const shards = burstPieces(rig, before);
    expect(shards.length, 'and it leaves shards').toBeGreaterThan(0);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('a nudge that only slides it does NOT break it — speed is the gauge', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('wine-glass');
    rig.run(0.3);
    // Gentle: it rocks and resettles on the plinth well under 1.3 m/s.
    rig.pw.setVelocity(targetBody(rig), { x: 0.12, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    rig.run(1.5);
    expect(rig.lab.targetState.broken).toBe(false);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('C2.4 — the egg (18 §6)', () => {
  it('a cube RESTED on it cracks it open — no impact anywhere in the story', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('egg');
    rig.run(0.3);
    expect(rig.lab.targetState.deployed).toBe(true);
    // Placed, not dropped: 1 mm above the shell at zero velocity. A 2" tungsten cube
    // is 2.36 kg = 23 N... under the 45 N limit, so this one must SURVIVE.
    const eggTop = 0.02 + 0.057;
    rig.store.spawn('W', 2, { x: 0, y: eggTop + IN + 0.001, z: 0 });
    rig.run(2.5);
    expect(rig.lab.targetState.broken, '23 N is a load the shell carries').toBe(false);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('past 45 N the shell gives way under a resting load, with no drop at all', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('egg');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    // 3" W is 7.96 kg = 78 N, comfortably past the 45 N quasi-static limit.
    const eggTop = 0.02 + 0.057;
    rig.store.spawn('W', 3, { x: 0, y: eggTop + 1.5 * IN + 0.001, z: 0 });
    rig.run(2.5);
    expect(rig.lab.targetState.broken, 'the shell gives under 78 N').toBe(true);
    // …and it opens into shell pieces rather than vanishing.
    const shell = burstPieces(rig, before);
    expect(shell.length).toBeGreaterThan(0);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('and a DROP cracks it too — the verdict is CRACKED OPEN either way', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('egg');
    rig.run(0.3);
    fullDrop(rig, 'W', 1, 0.6);
    rig.run(0.3);
    expect(rig.lab.state!.verdict).toBe('cracked-open');
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

/**
 * C2.2 — burst REGIMES (realism audit 2026-08-25). The audit measured every burst
 * as the same uniform evacuation: bbox colliders inter-penetrated at spawn and the
 * solver's depenetration shove (~2+ m/s at ANY energy) drowned the authored kick.
 * These pins hold the two regimes apart on the SHIPPING fragment path — synthetic
 * fragments injected where GLTFLoader cannot run.
 */
/**
 * C2.3 — the soda can (18 §6): a 3-state MORPH, not a shatter. 02 §7's anchors:
 * 1 J dents, 5 J flattens. The physics runs fully headless (the morph swap needs
 * no GLB — only the visual does), so these pins exercise the shipping path.
 */
/** New dynamic prop bodies since `before` — burst pieces, morphed cans — with their field position. */
function burstPieces(rig: Rig, before: ReadonlySet<number>): { r: number; y: number }[] {
  const cubes = new Set([...rig.store.all].map((e) => e.body));
  return [...rig.pw.allBodies()]
    .filter((b) => !before.has(b) && !cubes.has(b) && rig.pw.bodyKindOf(b) === 'dynamic')
    .map((b) => {
      const t = rig.pw.transformOf(b);
      return { r: Math.hypot(t.p.x, t.p.z), y: t.p.y };
    });
}

describe('C2.3 — the soda can (18 §6)', () => {
  it('the dent band: a light cube DENTS it, KNOCKS it away, and the can SURVIVES', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('soda-can');
    rig.run(0.2);
    const before = new Set(rig.pw.allBodies());
    fullDrop(rig, 'W', 1, 0.6); // ~1.4 J at the shoulder — the dent band
    rig.run(1.5);
    expect(rig.lab.state!.verdict).toBe('survived');
    expect(rig.lab.targetState.canState).toBe('dent');
    expect(rig.lab.targetState.broken).toBe(false);
    // The kick-out (realism review, 2026-08-25): a 15 g can never stays planted
    // under a strike — it gets knocked out from under the cube…
    const canBodies = burstPieces(rig, before);
    expect(canBodies.length).toBe(1);
    expect(canBodies[0]!.r, 'knocked away from centre').toBeGreaterThan(0.1);
    expect(canBodies[0]!.r, 'but stays on stage').toBeLessThan(2.5);
    // …so the cube lands on the PLATE, not perched on the can.
    const cube = [...rig.store.all][0]!;
    expect(cube.curr.p.y).toBeLessThan(0.06);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('the wreck is RECOVERED, never culled — an 8" cube cannot delete the can', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('soda-can');
    rig.run(0.2);
    const before = new Set(rig.pw.allBodies());
    // The heaviest thing the size row can spawn, from height: whatever it does to a
    // 15 g can, the can still has to exist afterwards (user: "should not disappear ever").
    fullDrop(rig, 'W', 8, 6);
    rig.run(3);
    const wreck = burstPieces(rig, before);
    expect(wreck.length, 'the can still exists').toBe(1);
    expect(wreck[0]!.r, 'and it is on the stage, not in the void').toBeLessThan(
      config.stage.floorHalfSizeM,
    );
    expect(wreck[0]!.y, 'above the floor, not under it').toBeGreaterThan(-0.1);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('a heavy drop CRUSHES FLAT: verdict stamped, wreckage body swapped not multiplied', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('soda-can');
    rig.run(0.2);
    const deployed = rig.pw.bodyCount;
    fullDrop(rig, 'W', 2, 2); // ~44 J — far past the 5 J flatten
    rig.run(0.2);
    expect(rig.lab.state!.verdict).toBe('crushed-flat');
    expect(rig.lab.targetState.canState).toBe('flat');
    // The wreck SKITTERS out from under the cube (the buckle-ramp kick-out) and
    // the damped slide dies on stage.
    rig.run(1.5);
    const wreck = burstPieces(rig, new Set<number>()).filter((p) => p.y < 0.1);
    expect(wreck.some((p) => p.r > 0.15 && p.r < 2.8)).toBe(true);
    // The intact body left, the flat wreck arrived, the cube landed: net +1 —
    // counted back at idle, once the carriage has returned its loading platform.
    expect(rig.runUntil(() => rig.lab.towerPhase === 'idle', 12)).toBe(true);
    rig.run(0.6);
    expect(rig.pw.bodyCount).toBe(deployed + 1);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

/**
 * C3.2 — the pine board (18 §6 C3). The only target that fails by BENDING, and the
 * mounting IS the mechanism: it bridges two cinder blocks, so the cube loads an
 * unsupported middle and the board hinges apart at midspan.
 */
describe('C3.2 — the pine board (18 §6)', () => {
  it('deploys as a board on TWO supports — the span is the mechanism', async () => {
    const rig = await rigWithStage();
    const base = rig.pw.bodyCount;
    rig.lab.setTarget('pine-board');
    rig.run(0.3);
    // Two blocks + the board.
    expect(rig.pw.bodyCount).toBe(base + 3);
    rig.lab.setTarget('none');
    rig.run(0.1);
    expect(rig.pw.bodyCount).toBe(base);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('creaks and holds below 50 J, then SNAPS into two halves', async () => {
    const under = await rigWithStage();
    under.lab.setTarget('pine-board');
    under.run(0.3);
    fullDrop(under, 'W', 2, 0.8); // ~18 J: the creak band
    under.run(0.3);
    expect(under.lab.state!.verdict).toBe('survived');
    expect(under.lab.targetState.broken).toBe(false);
    under.lab.teardown();
    under.pw.free();

    const over = await rigWithStage();
    over.lab.setTarget('pine-board');
    over.run(0.3);
    const before = new Set(over.pw.allBodies());
    fullDrop(over, 'W', 2, 2.5); // ~55 J
    over.run(1.5);
    expect(over.lab.state!.verdict).toBe('snapped');
    // TWO halves, not a fragment cloud — that is what bending failure looks like at
    // this energy. A monster cube splinters it into more (see the pin below).
    const pieces = burstPieces(over, before);
    expect(pieces.length).toBe(2);
    // They hinge down into the gap rather than flying: still over their own blocks.
    expect(Math.max(...pieces.map((p) => p.r))).toBeLessThan(0.45);
    over.lab.teardown();
    over.pw.free();
  }, 120_000);
});

/**
 * C3.3 — the glass pane (18 §6 C3). The first target that fails to STOP the cube:
 * annealed glass gives at a hard point, the cube punches through and carries on to
 * the plate, and what is left is a spiderweb around a cube-sized hole.
 */
describe('C3.3 — the glass pane (18 §6)', () => {
  it('the cube PUNCHES THROUGH and reaches the plate below', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('glass-pane');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    fullDrop(rig, 'W', 2, 1); // ~22 J against a 2 J pane: no contest
    rig.run(2);
    expect(rig.lab.state!.verdict).toBe('shattered');
    // The pane sat on 20 cm blocks; the cube ends up BELOW that, on the plate.
    const cube = [...rig.store.all][0]!;
    expect(cube.curr.p.y, 'it did not stop on the glass').toBeLessThan(0.2032);
    // A spiderweb, not two halves.
    const shards = burstPieces(rig, before);
    expect(shards.length).toBeGreaterThanOrEqual(6);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('the sheet drops out of its own plane rather than exploding', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('glass-pane');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    fullDrop(rig, 'W', 2, 1);
    rig.run(2.5);
    const shards = burstPieces(rig, before);
    // Gravity does the work: everything stays within the sheet's own footprint plus
    // the blocks it fell off, nothing is flung across the stage.
    expect(Math.max(...shards.map((s) => s.r))).toBeLessThan(0.6);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

/**
 * C3.4 — breakable STRUCTURE (18 §6 C3, user 2026-08-26). The blocks and the plinth
 * break too, at the top of the ladder: a hollow CMU takes 250 J of arrival, marble
 * 450, both far above the 50 J board — so it takes a monster cube to reach them.
 */
describe('C3.4 — the structure breaks too (18 §6)', () => {
  it('a 2" cube leaves the blocks standing — they are the ceiling, not the target', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('pine-board');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    fullDrop(rig, 'W', 2, 2.5); // ~55 J: snaps the board, nowhere near the blocks
    rig.run(1);
    expect(rig.lab.state!.verdict).toBe('snapped');
    // Exactly the two board halves: no block rubble, so both blocks stood.
    expect(burstPieces(rig, before).length).toBe(2);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('a cube wider than the span lands ON the blocks and takes them out', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('pine-board');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    /*
     * A 2" cube lands mid-span, snaps the board and falls THROUGH the 22 cm gap
     * without ever touching a block — which is why the blocks survive it, and is
     * honest: a board failing mid-span barely loads its supports. Reaching the
     * blocks takes a cube wide enough to come down on them, and a 15" tungsten cube
     * (0.38 m across, ~1 tonne) bridges the gap and lands on both at once.
     */
    rig.store.spawn('W', 15, { x: 0, y: rig.lab.platformY + 0.2, z: 0 });
    rig.run(0.5);
    rig.lab.setHeight(3);
    rig.lab.hoist();
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 12)).toBe(true);
    rig.lab.dropNow();
    rig.runUntil(() => rig.lab.state?.phase === 'done', 12);
    rig.run(2);
    // Board halves AND block rubble — far more than the two the board alone leaves.
    expect(burstPieces(rig, before).length).toBeGreaterThan(4);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('the two logged glitches, closed (2026-08-26)', () => {
  it('a DROP press with cargo aboard is never eaten, whatever the phase', async () => {
    const rig = await rigWithStage();
    rig.store.spawn('W', 2, { x: 0, y: rig.lab.platformY + IN + 0.02, z: 0 });
    rig.run(0.5);
    rig.lab.setHeight(3);
    rig.lab.hoist();
    // Press it IMMEDIATELY — mid-climb, nowhere near armed. The old code enumerated
    // the phases that may swallow a press and a third window still ate one; now the
    // press latches and comes out the moment the winch is ready.
    rig.lab.dropNow();
    expect(rig.lab.towerPhase).not.toBe('armed');
    expect(
      rig.runUntil(() => rig.lab.state?.phase === 'done', 20),
      'the drop happens',
    ).toBe(true);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);

  it('deploying a target slides a resting cube clear instead of punting it off-stage', async () => {
    const rig = await rigWithStage();
    // A cube sitting exactly where the melon is about to be born.
    const e = rig.store.spawn('W', 2, { x: 0, y: config.drop.plate.topYM + IN, z: 0 });
    rig.run(0.4);
    rig.lab.setTarget('watermelon');
    rig.run(1.5);
    const d = Math.hypot(e.curr.p.x, e.curr.p.z);
    expect(d, 'it was moved out of the way').toBeGreaterThan(0.15);
    expect(d, 'not flung across the stage').toBeLessThan(0.7);
    expect(e.curr.p.y, 'and it is still on the plate').toBeGreaterThan(0);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('C3.2b — the board splinters at overkill, it does not re-break', () => {
  it('a 2" cube gives two halves; a monster cube breaks it in more places at once', async () => {
    const rig = await rigWithStage();
    rig.lab.setTarget('pine-board');
    rig.run(0.3);
    const before = new Set(rig.pw.allBodies());
    /*
     * A 15" cube is WIDER than the 30 cm board, so it never loads a point at midspan:
     * it comes down across the whole board with both supports resisting, which fails
     * at several lines at once. Repeated breaking is the wrong model — once snapped,
     * a half is a free piece on a block, not a beam over a gap.
     */
    rig.store.spawn('W', 15, { x: 0, y: rig.lab.platformY + 0.2, z: 0 });
    rig.run(0.5);
    rig.lab.setHeight(3);
    rig.lab.hoist();
    expect(rig.runUntil(() => rig.lab.towerPhase === 'armed', 12)).toBe(true);
    rig.lab.dropNow();
    rig.runUntil(() => rig.lab.state?.phase === 'done', 12);
    rig.run(1);
    // Board pieces alone exceed the two a moderate hit leaves (block rubble adds more).
    expect(burstPieces(rig, before).length).toBeGreaterThan(3);
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('the pad gate is platform-aware (user, 2026-08-26)', () => {
  for (const floor of ['trampoline', 'foam'] as const) {
    it(`spawning a heavy cube on the platform does not bottom the ${floor}`, async () => {
      const rig = await rigWithStage();
      rig.lab.setFloor(floor);
      rig.run(0.2);
      /*
       * The gate charges a cube its remaining fall, and the loading platform sits
       * 0.85 m above the mat — so an 8" tungsten cube resting there was credited
       * with ~337 J and bottomed the pad the instant it spawned, with nothing
       * dropped. A cube on the platform is the carriage's business, not the mat's.
       */
      rig.store.spawn('W', 8, { x: 0, y: rig.lab.platformY + 4 * IN + 0.02, z: 0 });
      rig.run(2);
      expect(rig.lab.pad!.regime, 'the mat is untouched').toBe('live');
      rig.lab.teardown();
      rig.pw.free();
    }, 120_000);
  }

  it('but a real drop onto it still bottoms it out', async () => {
    const rig = await rigWithStage();
    rig.lab.setFloor('foam');
    rig.run(0.2);
    fullDrop(rig, 'W', 4, 6); // far past foam's 30 J
    expect(rig.lab.state!.verdict).toBe('bottomed-out');
    rig.lab.teardown();
    rig.pw.free();
  }, 120_000);
});

describe('C2.2 — burst regimes (18 §6, audit)', () => {
  /** A 3×2×2 grid of hull chunks standing in for the melon's 12 Voronoi pieces. */
  function syntheticMelonAssets(): CrushAssets {
    const frags: FragChunk[] = [];
    for (const x of [-0.1, 0, 0.1]) {
      for (const y of [0.08, 0.24]) {
        for (const z of [-0.075, 0.075]) {
          const half = { x: 0.05, y: 0.075, z: 0.07 };
          const points: number[] = [];
          for (const sx of [-1, 1])
            for (const sy of [-1, 1])
              for (const sz of [-1, 1]) points.push(sx * half.x, sy * half.y, sz * half.z);
          frags.push({ offset: { x, y, z }, half, points, visual: new THREE.Group() });
        }
      }
    }
    return {
      glass: new THREE.Group(),
      pedestal: new THREE.Group(),
      melonFull: new THREE.Group(),
      can: new THREE.Group(),
      egg: new THREE.Group(),
      block: new THREE.Group(),
      blockFrags: [],
      plinthFrags: [],
      melonFrags: frags,
      glassFrags: [],
    };
  }

  it('just-over CRACKS OPEN in place: pieces sag around the crater, cube nests on the wreck', async () => {
    __setCrushAssetsForTests(syntheticMelonAssets());
    try {
      const rig = await rigWithStage();
      rig.lab.setTarget('watermelon');
      rig.run(0.3); // deploy…
      await Promise.resolve(); // …and flush the loader's microtask so the cache lands
      const before = new Set(rig.pw.allBodies());
      fullDrop(rig, 'W', 2, 2.6); // ~53 J arrival, ~13 J excess — kick ≈ 0.4 m/s
      rig.run(1.5);
      expect(rig.lab.state!.verdict).toBe('splat');
      const pieces = burstPieces(rig, before);
      expect(pieces.length, 'nothing pulped, nothing culled').toBe(12);
      const near = pieces.filter((p) => p.r < 0.55).length;
      expect(near, 'a crack-open stays at the crater').toBeGreaterThanOrEqual(9);
      expect(Math.max(...pieces.map((p) => p.r))).toBeLessThan(1.2);
      rig.lab.teardown();
      rig.pw.free();
    } finally {
      __setCrushAssetsForTests(null);
    }
  }, 120_000);

  it('a massive hit SPRAYS flat and wide, pulps the core, and the cube punches to the plate', async () => {
    __setCrushAssetsForTests(syntheticMelonAssets());
    try {
      const rig = await rigWithStage();
      rig.lab.setTarget('watermelon');
      rig.run(0.3);
      await Promise.resolve(); // flush the loader's microtask so the cache lands
      const before = new Set(rig.pw.allBodies());
      fullDrop(rig, 'W', 6, 2.5); // ~1.3 kJ arrival — kick ≈ 4.3 m/s, 4 pieces pulped
      rig.run(2.0);
      expect(rig.lab.state!.verdict).toBe('splat');
      const pieces = burstPieces(rig, before);
      expect(pieces.length, '12 minus 4 pulped to juice, none culled').toBe(8);
      const radii = pieces.map((p) => p.r);
      expect(Math.max(...radii), 'sprayed wide').toBeGreaterThan(0.8);
      expect(Math.max(...radii), 'wet drag keeps it inside the world').toBeLessThan(2.9);
      // The pulped core is why the cube reaches the plate instead of perching.
      const cube = [...rig.store.all][0]!;
      expect(cube.curr.p.y, 'cube on the plate in the pancake').toBeLessThan(0.14);
      rig.lab.teardown();
      rig.pw.free();
    } finally {
      __setCrushAssetsForTests(null);
    }
  }, 120_000);
});
