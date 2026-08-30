import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { config } from '../../src/config.ts';
import { WeighLab } from '../../src/labs/weigh/index.ts';
import { PhysicsWorld } from '../../src/core/physics.ts';
import type { Entity } from '../../src/core/entities.ts';
import type { LabContext, LabControlGroup } from '../../src/labs/lab.ts';
import type { CubeSpec, EntityId, MetalId } from '../../src/types.ts';
import { DT, IN } from './harness.ts';

/**
 * Where the Weigh Station puts a cube (user, 2026-08-30).
 *
 * Spawns land ON the instrument now — the armed pan, or the platter — rather than on the
 * bench in front of it, and that is a placement problem with real consequences: a cube
 * dropped into a pan that is already occupied is two colliders born overlapping, which
 * the solver answers with a shove that came from nowhere. So this drives the SHIPPED
 * `WeighLab` against real Rapier, through the same control seam the panel uses, and
 * checks the footprints rather than trusting the arithmetic.
 *
 * The scale case is the one that cannot be reasoned about from the geometry at all: its
 * auto-zero fires once, on a settled EMPTY platter, so a cube that gets there first does
 * not delay the zero, it cancels it.
 */

const B = config.weigh.balance;

class MiniStore {
  readonly #map = new Map<EntityId, Entity>();
  #next = 1;

  constructor(readonly pw: PhysicsWorld) {}

  get all(): Iterable<Entity> {
    return this.#map.values();
  }
  get size(): number {
    return this.#map.size;
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

  clear(): void {
    for (const e of this.#map.values()) this.pw.remove(e.body);
    this.#map.clear();
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
  readonly lab = new WeighLab();
  /** The panel model as the lab last published it — the seam the chips are built from. */
  groups: readonly LabControlGroup[] = [];
  toasts: string[] = [];

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
      layoutClass: () => 'desktop' as const,
      ui: {
        setControls: (groups) => {
          this.groups = groups;
        },
        mountPanel: () => ({ update: () => undefined, dispose: () => undefined }),
        toast: (m) => this.toasts.push(m),
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

  /** Press a chip by its label, exactly as the rendered row would. */
  press(label: string): void {
    for (const g of this.groups) {
      const c = g.controls.find((x) => x.label === label);
      if (c) {
        c.onSelect();
        return;
      }
    }
    throw new Error(`no control labelled ${label} — have ${this.labels().join(', ')}`);
  }

  labels(): string[] {
    return this.groups.flatMap((g) =>
      g.controls.map((c) => `${g.label}/${c.label}${c.selected ? '*' : ''}`),
    );
  }

  /** What the dock's own SPAWN button does: ask the lab, then place the cube. */
  spawnFromDock(sideIn: number, metal: MetalId = 'W'): Entity {
    const at = this.lab.preferredSpawnPoint(sideIn * IN)!;
    return this.store.spawn(metal, sideIn, at);
  }

  step(): void {
    this.lab.beforePhysics();
    this.pw.step(DT, []);
    this.store.capture();
    this.lab.afterPhysics(DT);
  }

  run(seconds: number): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step();
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

/** Horizontal separation as the placement test sees it: an AABB gap, not a centre gap. */
function overlaps(a: Entity, b: Entity): boolean {
  const need = a.spec.sideM / 2 + b.spec.sideM / 2;
  return (
    Math.abs(a.curr.p.x - b.curr.p.x) < need - 1e-9 &&
    Math.abs(a.curr.p.z - b.curr.p.z) < need - 1e-9
  );
}

describe('the Weigh Station puts cubes on the instrument', () => {
  it('arms the LEFT pan by default, and says so on the chip', async () => {
    const rig = await rigWithStage();
    expect(rig.labels()).toEqual([
      'Instrument/Balance*',
      'Instrument/Digital Scale',
      'Spawn onto/Left pan*',
      'Spawn onto/Right pan',
    ]);

    const p = rig.lab.preferredSpawnPoint(2 * IN)!;
    const dish = rig.lab.balance!.dishFloor(0);
    expect(p.x).toBeCloseTo(dish.x, 3);
    expect(p.z).toBeCloseTo(dish.z, 3);
    // Set down on the dish floor, not dropped at it from the beam's height.
    expect(p.y - dish.y).toBeCloseTo(IN + 0.004, 3);
    expect(p.x).toBeLessThan(0);
  });

  it('a cube spawned into a pan stays in it, and the beam takes the load', async () => {
    const rig = await rigWithStage();
    const e = rig.spawnFromDock(2);
    rig.run(2);

    const dish = rig.lab.balance!.dishFloor(0);
    expect(Math.hypot(e.curr.p.x - dish.x, e.curr.p.z - dish.z)).toBeLessThan(B.panRimRadiusM);
    // Left pan alone: the beam goes left-down and pins against its stop.
    expect(rig.lab.balance!.state.angleDeg).toBeGreaterThan(1);
    expect(rig.lab.reading!.status).toBe('at-stop');
  });

  it('the right-pan chip AIMS and nothing more — SPAWN is what spawns', async () => {
    const rig = await rigWithStage();
    rig.press('Right pan');
    expect(rig.labels()).toContain('Spawn onto/Right pan*');
    expect(rig.labels()).toContain('Spawn onto/Left pan');
    // Aiming a pan must not put anything on the stage (user, 2026-08-30).
    expect(rig.store.size).toBe(0);

    // The dock's SPAWN now goes there instead.
    expect(rig.lab.preferredSpawnPoint(2 * IN)!.x).toBeGreaterThan(0);
    const cube = rig.spawnFromDock(2);
    rig.run(2);
    const dish = rig.lab.balance!.dishFloor(1);
    expect(Math.hypot(cube.curr.p.x - dish.x, cube.curr.p.z - dish.z)).toBeLessThan(
      B.panRimRadiusM,
    );
  });

  it('fills a pan SIDE BY SIDE — never a cube inside the one already there', async () => {
    const rig = await rigWithStage();
    const placed: Entity[] = [];
    for (let i = 0; i < 5; i++) {
      placed.push(rig.spawnFromDock(2));
      rig.run(0.4);
    }
    const dish = rig.lab.balance!.dishFloor(0);
    for (const e of placed) {
      expect(Math.hypot(e.curr.p.x - dish.x, e.curr.p.z - dish.z)).toBeLessThan(
        B.panRimRadiusM + IN,
      );
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i]!, placed[j]!), `cube ${i} vs ${j}`).toBe(false);
      }
    }
  });

  it('sends the overflow to the bench rather than stacking a tower on a tilting pan', async () => {
    const rig = await rigWithStage();
    // An 8" cube leaves no ring a 2" one can reach: 0.102 m of half-width plus its own
    // 0.025 needs 0.133 m of clearance, and the dish only offers 0.127 m of reach.
    rig.spawnFromDock(8, 'Al');
    rig.run(0.5);
    const next = rig.lab.preferredSpawnPoint(2 * IN)!;
    expect(next.z).toBeCloseTo(config.weigh.stagingZ, 3);
    expect(next.y).toBeLessThan(B.pivotHeightM);
  });

  it('a cube wider than the dish still gets a slot — the centre of it', async () => {
    const rig = await rigWithStage();
    const p = rig.lab.preferredSpawnPoint(15 * IN)!;
    const dish = rig.lab.balance!.dishFloor(0);
    expect(p.x).toBeCloseTo(dish.x, 3);
    expect(p.z).toBeCloseTo(dish.z, 3);
  });

  describe('the digital scale', () => {
    it('takes the very first cube on the platter — no waiting for a zero', async () => {
      const rig = await rigWithStage();
      rig.press('Digital Scale');
      // Not one step run yet: it arrives zeroed, so the platter is open for business.
      expect(rig.lab.scale!.state.zeroed).toBe(true);

      const p = rig.lab.preferredSpawnPoint(2 * IN)!;
      expect(p.x).toBeCloseTo(0, 3);
      expect(p.z).toBeCloseTo(0, 3);
      expect(p.y - rig.lab.scale!.platterTopY).toBeCloseTo(IN + 0.004, 3);
    });

    /*
     * The regression this replaces: the platter used to refuse cubes until a MEASURED
     * zero had happened, which needs a settled empty platter and takes 1.3 s — so the
     * first cube, spawned at any human speed, landed on the bench instead (user,
     * 2026-08-30). Spawning at step zero is the case that used to fail.
     */
    it('reads the cube it was handed, to the gram, spawned before it ever settled', async () => {
      const rig = await rigWithStage();
      rig.press('Digital Scale');
      const e = rig.spawnFromDock(2);
      expect(Math.hypot(e.curr.p.x, e.curr.p.z)).toBeLessThan(0.1);
      rig.run(5);

      const st = rig.lab.scale!.state;
      expect(st.status).toBe('stable');
      expect(st.stableMassKg!).toBeCloseTo(e.massKg, 2);
      // And the seed is still standing in, because the platter never was empty.
      expect(rig.lab.scale!.signal.measuredZero).toBe(false);
    });

    it('reads the same after the measured zero replaces the seed', async () => {
      const rig = await rigWithStage();
      rig.press('Digital Scale');
      rig.run(3);
      expect(rig.lab.scale!.signal.measuredZero).toBe(true);
      const e = rig.spawnFromDock(2);
      rig.run(4);

      const st = rig.lab.scale!.state;
      expect(st.status).toBe('stable');
      expect(st.stableMassKg!).toBeCloseTo(e.massKg, 2);
    });

    it('parks what will not fit BESIDE it, not across the room', async () => {
      const rig = await rigWithStage();
      const S = config.weigh.scale;
      rig.press('Digital Scale');
      rig.run(3);
      // Fill the platter: the centre, then every ring slot a 2" cube can reach.
      for (let i = 0; i < 6; i++) {
        rig.spawnFromDock(2);
        rig.run(0.4);
      }
      const onPlatter = [...rig.store.all].filter((e) => Math.hypot(e.curr.p.x, e.curr.p.z) < 0.12);
      expect(onPlatter.length).toBeGreaterThanOrEqual(3);

      const bench = rig.lab.preferredSpawnPoint(2 * IN)!;
      // Clear of the housing, but nowhere near the balance's 0.48 m staging row — that
      // is outside the shot for an instrument framed at 1.3 m (user, 2026-08-30).
      expect(bench.z).toBeGreaterThan(S.housingHalfM.z);
      expect(bench.z).toBeLessThan(config.weigh.stagingZ * 0.6);
      expect(Math.hypot(bench.x, bench.z)).toBeLessThan(0.35);
    });

    it('sets a cube too big for the platter down ON the floor, not through it', async () => {
      const rig = await rigWithStage();
      rig.press('Digital Scale');
      rig.run(3);
      rig.spawnFromDock(2); // takes the platter centre, so the big one has to go beside
      rig.run(0.4);

      const half = (15 * IN) / 2;
      const p = rig.lab.preferredSpawnPoint(15 * IN)!;
      expect(p.y - half).toBeGreaterThan(0);
      expect(p.z).toBeGreaterThan(config.weigh.scale.housingHalfM.z + half);
    });

    it('offers no pan chips — there is only one place to put a cube', async () => {
      const rig = await rigWithStage();
      rig.press('Digital Scale');
      expect(rig.labels()).toEqual(['Instrument/Balance', 'Instrument/Digital Scale*']);
    });
  });
});
