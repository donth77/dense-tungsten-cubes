import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { PhysicsWorld } from '../../src/core/physics.ts';
import { cubeMassKg } from '../../src/data/metals.ts';
import type { BodyHandle, ImpactEvent, Vec3 } from '../../src/types.ts';
import { DT, IN } from './harness.ts';

/**
 * Stage C0 — the shatter spike (18 §6): prop impact identity, swap-on-threshold,
 * shard inheritance, determinism. Everything through the shipping facade; the
 * target/shard logic is spike-local and moves into the lab in C1.
 */

const PROP_ID_BASE = 1_000_000;
const GLASS_ID = PROP_ID_BASE + 1;
const GLASS_THRESHOLD_J = 1; // 02 §7: wine glass ≈ 1 J — an ARRIVAL-energy anchor
/** The break gauge (18 §5.2, C0 finding): the CUBE's arrival energy at the contact. */
function arrivalJ(ev: ImpactEvent, cubeMassKg: number): number {
  return 0.5 * cubeMassKg * ev.normalSpeedMps * ev.normalSpeedMps;
}
const PEDESTAL_TOP = 0.5;
const GLASS_HALF = { x: 0.035, y: 0.05, z: 0.035 };
const SCRATCH =
  '/private/tmp/claude-501/-Users-tomdonohue-projects-tungsten-cube-sim/6337dfa8-ecea-4672-8ddd-5daab02198d9/scratchpad/crush-spike.txt';

interface CrushRig {
  pw: PhysicsWorld;
  glass: BodyHandle;
  glassTop: number;
}

async function rigWithGlass(): Promise<CrushRig> {
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
  // The pedestal is BORN fixed at its pose — the 2026-08-25 engine truth.
  pw.addCompound({
    kind: 'fixed',
    at: { x: 0, y: PEDESTAL_TOP / 2, z: 0 },
    parts: [
      {
        shape: { kind: 'box', halfExtents: { x: 0.06, y: PEDESTAL_TOP / 2, z: 0.06 } },
        material: 'steel',
      },
    ],
  });
  // The intact "wine glass": one light dynamic body with prop identity. Real shape
  // arrives in C1; the spike needs mass, pose, and an id, nothing more.
  const glass = pw.addCompound({
    kind: 'dynamic',
    at: { x: 0, y: PEDESTAL_TOP + GLASS_HALF.y + 0.002, z: 0 },
    parts: [{ shape: { kind: 'box', halfExtents: GLASS_HALF }, material: 'ice', massKg: 0.15 }],
    entityId: GLASS_ID,
  });
  const rig = { pw, glass, glassTop: PEDESTAL_TOP + 2 * GLASS_HALF.y + 0.002 };
  settle(rig, 0.4);
  return rig;
}

function settle(rig: CrushRig, seconds: number): void {
  const n = Math.round(seconds / DT);
  const impacts: ImpactEvent[] = [];
  for (let i = 0; i < n; i++) {
    impacts.length = 0;
    rig.pw.step(DT, impacts);
  }
}

/** Drop a 1″ W cube from `hM` above the glass top; return every glass-pair event. */
function dropOnGlass(rig: CrushRig, hM: number): { events: ImpactEvent[]; firstStep: number } {
  const s = 1 * IN;
  const cube = rig.pw.addCube(
    { metal: 'W', sideM: s, purityPctW: 95 },
    { x: 0, y: rig.glassTop + hM + s / 2, z: 0 },
    { entityId: 1, ccd: true },
  );
  void cube;
  const events: ImpactEvent[] = [];
  let firstStep = -1;
  const impacts: ImpactEvent[] = [];
  for (let i = 0; i < Math.round(3 / DT); i++) {
    impacts.length = 0;
    rig.pw.step(DT, impacts);
    for (const ev of impacts) {
      if (ev.a === 1 && ev.b === GLASS_ID) {
        if (firstStep < 0) firstStep = i;
        events.push(ev);
      }
    }
    if (firstStep >= 0 && i > firstStep + 30) break;
  }
  return { events, firstStep };
}

/** The C1 recipe, spike-sized: despawn the prop, spawn shards with inherited motion. */
function shatter(rig: CrushRig, at: Vec3, kickJ: number): BodyHandle[] {
  const v = { x: 0, y: 0, z: 0 };
  rig.pw.readVelocityInto(rig.glass, v);
  rig.pw.remove(rig.glass);
  const shards: BodyHandle[] = [];
  const kick = Math.min(3, Math.sqrt(Math.max(0, kickJ)));
  for (let i = 0; i < 12; i++) {
    const az = (i / 12) * Math.PI * 2;
    const r = 0.02;
    const shard = rig.pw.addCompound({
      kind: 'dynamic',
      at: { x: at.x + Math.cos(az) * r, y: at.y + (i % 3) * 0.02, z: at.z + Math.sin(az) * r },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: 0.012, y: 0.008, z: 0.012 } },
          material: 'ice',
          massKg: 0.0125,
        },
      ],
    });
    rig.pw.setVelocity(
      shard,
      { x: v.x + Math.cos(az) * kick, y: v.y + 0.4 * kick, z: v.z + Math.sin(az) * kick },
      { x: 0, y: 0, z: 0 },
    );
    shards.push(shard);
  }
  return shards;
}

describe('C0 — the shatter spike (18 §6)', () => {
  it('the impact channel names the prop: cube is a, target id is b', async () => {
    const rig = await rigWithGlass();
    const { events } = dropOnGlass(rig, 0.45);
    expect(events.length).toBeGreaterThan(0);
    const hit = events[0]!;
    expect(hit.a).toBe(1);
    expect(hit.b).toBe(GLASS_ID);
    // 1″ W from 45 cm arrives with ~1.3 J of ½mv²; the DELIVERED energy is lower
    // (two light dynamic bodies share the contact) — record the ratio for 18 §5.2.
    const m = cubeMassKg('W', 1 * IN, 95);
    const arrivalJ = m * config.physics.gravityMps2 * 0.45;
    writeFileSync(
      SCRATCH,
      'arrival ' +
        arrivalJ.toFixed(2) +
        ' J, delivered ' +
        hit.energyJ.toFixed(2) +
        ' J, ratio ' +
        (hit.energyJ / arrivalJ).toFixed(2) +
        ', v ' +
        hit.normalSpeedMps.toFixed(2) +
        ' m/s\n',
    );
    expect(hit.energyJ).toBeGreaterThan(0.2);
    rig.pw.free();
  });

  it('swap-on-threshold: under survives, over shatters into capped shards', async () => {
    const m = cubeMassKg('W', 1 * IN, 95);
    const under = await rigWithGlass();
    const low = dropOnGlass(under, 0.15);
    const lowMax = Math.max(0, ...low.events.map((e) => arrivalJ(e, m)));
    expect(lowMax).toBeGreaterThan(0); // it did land on the glass
    expect(lowMax).toBeLessThan(GLASS_THRESHOLD_J);
    under.pw.free();

    // 02 §7's own anchor: 1″ tungsten from ~35 cm. 45 cm clears it with margin.
    const over = await rigWithGlass();
    const bodies0 = over.pw.bodyCount;
    const high = dropOnGlass(over, 0.45);
    const hit = high.events.find((e) => arrivalJ(e, m) >= GLASS_THRESHOLD_J);
    expect(hit, 'a 45 cm drop must cross 1 J of arrival energy').toBeTruthy();
    const shards = shatter(over, hit!.point, hit!.energyJ - GLASS_THRESHOLD_J);
    expect(shards).toHaveLength(12);
    expect(over.pw.bodyCount).toBe(bodies0 + 12 - 1 + 1); // −glass +12 shards +cube
    settle(over, 1.5);
    // Shards settle without exploding or escaping the stage.
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    for (const sh of shards) {
      over.pw.readTransformInto(sh, p, q);
      expect(p.y).toBeGreaterThan(config.stage.killPlaneY);
      expect(Math.hypot(p.x, p.z)).toBeLessThan(3);
    }
    over.pw.free();
  });

  it('the break is deterministic: two fresh worlds, bit-identical', async () => {
    async function run(): Promise<{ step: number; e: number; y: number }> {
      const rig = await rigWithGlass();
      const m = cubeMassKg('W', 1 * IN, 95);
      const { events, firstStep } = dropOnGlass(rig, 0.45);
      const hit = events.find((e) => arrivalJ(e, m) >= GLASS_THRESHOLD_J)!;
      const shards = shatter(rig, hit.point, hit.energyJ - GLASS_THRESHOLD_J);
      settle(rig, 0.5);
      const p: Vec3 = { x: 0, y: 0, z: 0 };
      const q = { x: 0, y: 0, z: 0, w: 1 };
      rig.pw.readTransformInto(shards[7]!, p, q);
      const out = { step: firstStep, e: hit.energyJ, y: p.y };
      rig.pw.free();
      return out;
    }
    const a = await run();
    const b = await run();
    expect(a.step).toBe(b.step);
    expect(Object.is(a.e, b.e)).toBe(true);
    expect(Object.is(a.y, b.y)).toBe(true);
  }, 120_000);
});
