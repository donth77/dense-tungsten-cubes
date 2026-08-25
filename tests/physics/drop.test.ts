import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../../src/config.ts';
import { cubeMassKg } from '../../src/data/metals.ts';
import type { BodyHandle, MetalId, Vec3 } from '../../src/types.ts';
import type { PhysicsWorld } from '../../src/core/physics.ts';
import { DT, emptyWorld, G, IN, run, worldWithFloor } from './harness.ts';
import {
  bottomsOut,
  bottomsOutFoam,
  dragForceClamped,
  FOAM_SEED,
  PadRig,
  plateWorld,
  rawCubeWorld,
  speedAfterFall,
  stepUntilImpact,
  terminalVelocity,
  TRAMPOLINE_SEED,
} from './drop-rig.ts';

/**
 * Stage D0 — the Drop Tower's numerical and API spikes (16 §15 D0), run BEFORE any lab
 * code exists. Every seed number in 16 §6.3 and §7.3 is either confirmed here or the
 * document gets corrected; that is D0's exit criterion.
 */

const DROP_H = 20;
const SIZES_IN = [0.25, 0.5, 1, 2, 4, 8, 15] as const;

/** Centre height that puts the bottom face `hM` above a surface whose top is `topY`. */
function spawnY(topY: number, hM: number, sideM: number): number {
  return topY + hM + sideM / 2;
}

function wCube(pw: PhysicsWorld, sideIn: number, y: number, entityId: number): BodyHandle {
  return pw.addCube(
    { metal: 'W', sideM: sideIn * IN, purityPctW: 95 },
    { x: 0, y, z: 0 },
    { entityId },
  );
}

/** Run with the pad's spring/damper applied before every step, as the lab will. */
function runPad(pw: PhysicsWorld, rig: PadRig, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    rig.beforeStep();
    each?.();
    pw.step(DT, []);
  }
}

describe('D0.1 — continuous collision from the full tower height', () => {
  it('no supported size tunnels a 20 mm plate from 20 m, and the impact speed is honest', async () => {
    for (const sizeIn of SIZES_IN) {
      const s = sizeIn * IN;
      const pw = await plateWorld();
      const h = wCube(pw, sizeIn, spawnY(0, DROP_H, s), 1);
      // Deliberately NOT opts.ccd — this measures the automatic predictive rule alone.
      const out = stepUntilImpact(pw, h, 1, 4);
      const ideal = Math.sqrt(2 * G * DROP_H);
      expect(out.preSpeedMps, `${sizeIn}" pre-impact speed`).toBeGreaterThan(ideal * 0.99);
      expect(out.preSpeedMps, `${sizeIn}" pre-impact speed`).toBeLessThan(ideal * 1.01);
      expect(out.impact.normalSpeedMps, `${sizeIn}" event speed`).toBeCloseTo(out.preSpeedMps, 1);
      // The landing is CCD-resolved and separated again within the step; the event
      // reaches us through the synthetic-contact path (contactCount 0). Pinned so a
      // Rapier upgrade that starts keeping the manifold flips this loudly, not silently.
      if (sizeIn === 2) expect(out.impact.contactCount, 'TOI landing is synthesised').toBe(0);
      run(pw, 2);
      const y = pw.transformOf(h).p.y;
      expect(Number.isFinite(y), `${sizeIn}" finite`).toBe(true);
      expect(y, `${sizeIn}" rests ON the plate, not through it`).toBeGreaterThan(s / 2 - 0.005);
      pw.free();
    }
  }, 120_000);

  it('no supported size tunnels a compliant pad from 20 m', async () => {
    // Body-vs-body CCD — 16 §17's top-ranked risk, so it runs in the first spike.
    // The pad stands over the real stage, as in the lab: a big cube can legitimately
    // BOUNCE off the mat and walk off its edge onto the floor (the 15" cube does).
    // Tunnelling means the FIRST thing the cube meets is not the pad, or it ends
    // below the stage. A void below would conflate the two.
    for (const sizeIn of SIZES_IN) {
      const s = sizeIn * IN;
      const pw = await worldWithFloor();
      const m = cubeMassKg('W', s, 95);
      const rig = new PadRig(pw, TRAMPOLINE_SEED, 0.3, bottomsOut(m, Math.sqrt(2 * G * DROP_H)));
      const h = wCube(pw, sizeIn, spawnY(rig.padTopRestY, DROP_H, s), 1);
      const out = stepUntilImpact(pw, h, 1, 4, () => rig.beforeStep());
      // The pad's part carries its fabric material into the event — the partner
      // reports as 'trampoline', which is exactly what the audio voice keys on.
      // 'concrete' here would mean the cube met the stage THROUGH the mat.
      expect(out.impact.b, `${sizeIn}" first meets the fabric, not the stage`).toBe('trampoline');
      runPad(pw, rig, 2);
      const y = pw.transformOf(h).p.y;
      const v = pw.velocityOf(h);
      expect(Number.isFinite(y), `${sizeIn}" finite`).toBe(true);
      expect(y, `${sizeIn}" never ends below the stage`).toBeGreaterThan(-0.05);
      expect(Math.hypot(v.x, v.y, v.z), `${sizeIn}" no blow-up`).toBeLessThan(
        config.stability.maxSpeedMps + 1,
      );
      pw.free();
    }
  }, 120_000);
});

describe('D0.2 — the jointless hoist: body-kind switching (raw Rapier)', () => {
  it('carries a cube kinematically and releases it dynamic with nothing lost', async () => {
    const probe = await rawCubeWorld(2 * IN, { x: 0, y: 0.5, z: 0 });
    const { world, body } = probe;
    const m0 = body.mass();

    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    // Hoist at 6 m/s for one second of steps.
    const steps = 60;
    let target = 0.5;
    for (let i = 0; i < steps; i++) {
      target = 0.5 + 6 * DT * (i + 1);
      body.setNextKinematicTranslation({ x: 0, y: target, z: 0 });
      world.step();
    }
    expect(body.translation().y).toBeCloseTo(target, 9);
    // With no new target, a kinematic body ignores gravity entirely.
    world.step();
    expect(body.translation().y).toBeCloseTo(target, 9);

    // Release: back to dynamic, velocity explicitly zeroed — the carry must leave
    // NO residual velocity (Rapier gives kinematic bodies a computed 6 m/s).
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    expect(body.mass(), 'mass survives the round-trip').toBeCloseTo(m0, 12);
    expect(body.linvel().y).toBe(0);
    expect(body.translation().y).toBeCloseTo(target, 9);

    // First dynamic step: exactly one step of gravity, nothing else.
    world.step();
    expect(body.linvel().y).toBeCloseTo(-G * DT, 6);
    probe.free();
  });
});

describe('D0.3 — the air column', () => {
  it('reproduces the quadratic-drag speed law over 20 m within 1 %', async () => {
    const cases: readonly [MetalId, number][] = [
      ['Al', 0.25],
      ['Al', 0.5],
      ['Al', 2],
      ['W', 0.5],
      ['W', 2],
      ['W', 4],
    ];
    const rows: string[] = [];
    for (const [metal, sizeIn] of cases) {
      const s = sizeIn * IN;
      const m = cubeMassKg(metal, s, 95);
      const vt = terminalVelocity(m, s);
      const pw = await emptyWorld();
      const y0 = 30;
      const h = pw.addCube({ metal, sideM: s, purityPctW: 95 }, { x: 0, y: y0, z: 0 });
      const v: Vec3 = { x: 0, y: 0, z: 0 };
      let measured = 0;
      let analytic = 0;
      for (let i = 0; i < Math.round(6 / DT); i++) {
        pw.readVelocityInto(h, v);
        const fallen = y0 - pw.transformOf(h).p.y;
        if (fallen >= DROP_H) {
          // Compare at the exact distance this sample has fallen — no crossing error.
          measured = Math.abs(v.y);
          analytic = speedAfterFall(fallen, vt);
          break;
        }
        pw.applyForce(h, { x: 0, y: dragForceClamped(v.y, s, m, DT), z: 0 });
        pw.step(DT, []);
      }
      expect(measured, `${sizeIn}" ${metal} fell 20 m`).toBeGreaterThan(0);
      const err = Math.abs(measured / analytic - 1);
      rows.push(
        `${sizeIn}" ${metal}: vt ${vt.toFixed(1)} | 20 m measured ${measured.toFixed(2)} ` +
          `| analytic ${analytic.toFixed(2)} | err ${(err * 100).toFixed(2)} %`,
      );
      expect(err, `${sizeIn}" ${metal} drag law`).toBeLessThan(0.01);
      pw.free();
    }
    console.log(`\n[D0.3 drag]\n${rows.join('\n')}`);
  }, 120_000);

  it('the impulse clamp opposes the velocity and can never reverse it', () => {
    const cases = [
      { v: -50, side: 15 * IN, m: 0.0001 }, // absurd: huge area, feather mass — must clamp hard
      { v: -19.8, side: 0.25 * IN, m: 0.0007 }, // the real worst case in the envelope
      { v: -5, side: 2 * IN, m: 2.36 },
      { v: 3, side: 4 * IN, m: 18.9 }, // rising cube: drag must point DOWN
    ];
    for (const c of cases) {
      const f = dragForceClamped(c.v, c.side, c.m, DT);
      expect(f * c.v, 'opposes motion').toBeLessThanOrEqual(0);
      expect(Math.abs(f), 'impulse never exceeds the stopping impulse').toBeLessThanOrEqual(
        (c.m * Math.abs(c.v)) / DT + 1e-12,
      );
    }
  });
});

describe('D0.4 — compliant pads', () => {
  it('trampoline: flicked, caught-and-thrown, or bottomed out dead — by energy', async () => {
    /*
     * D0 MEASUREMENT, correcting 16 §7.3 and 03 §3's folk-gag. Rebound is NOT
     * monotone in mass — it is a U-shaped curve with a dead spot, and the honest
     * demonstration is three REGIMES (rubber stand-in fabric; the real trampoline
     * surface lands in D1 and raises the flick numbers):
     *
     *   1" Al  (2 J):    the fabric alone flicks it back      — measured 13.6 %
     *   2" Al  (17 J):   too heavy to flick, too light to     — measured  2.4 %
     *                    drive the spring: the dead spot
     *   2" W   (115 J):  in the pocket — CAUGHT and thrown    — measured 31.1 %
     *   4" W   (926 J):  over capacity — rigid crushed mat,   — fabric CoR only
     *                    BOTTOMED OUT
     */
    const cases: readonly [MetalId, number][] = [
      ['Al', 1],
      ['Al', 2],
      ['W', 2],
      ['W', 4],
    ];
    const rebound: number[] = [];
    const rigidCase: boolean[] = [];
    for (const [metal, sizeIn] of cases) {
      const s = sizeIn * IN;
      const m = cubeMassKg(metal, s, 95);
      const pw = await emptyWorld();
      const rigid = bottomsOut(m, Math.sqrt(2 * G * 5));
      const rig = new PadRig(pw, TRAMPOLINE_SEED, 0.3, rigid);
      const h = pw.addCube(
        { metal, sideM: s, purityPctW: 95 },
        { x: 0, y: spawnY(rig.padTopRestY, 5, s), z: 0 },
        { entityId: 1 },
      );
      stepUntilImpact(pw, h, 1, 4, () => rig.beforeStep());
      let apex = -Infinity;
      runPad(pw, rig, 4, () => {
        apex = Math.max(apex, pw.transformOf(h).p.y);
      });
      rebound.push(Math.max(0, (apex - s / 2 - rig.padTopRestY) / 5));
      rigidCase.push(rigid);
      pw.free();
    }
    // Only the over-capacity cube is in the rigid regime.
    expect(rigidCase, 'gate assignments').toEqual([false, false, false, true]);
    expect(rebound[0], '1" Al: the fabric flicks it').toBeGreaterThan(0.08);
    expect(rebound[2], '2" W: caught and thrown').toBeGreaterThan(0.2);
    // The energy budget bounds the catch: 116 J in, ≤108 J storable, ζ 0.08 and two
    // fabric contacts of losses. Measured 31 % on the D0 rubber stand-in and 69 % on
    // the real fabric (pair CoR 0.283 vs W) — the mat times the throw better. <0.8 is
    // the physics bound with losses, not taste.
    expect(rebound[2], '2" W returns less than it got').toBeLessThan(0.8);
    expect(rebound[3], '4" W: bottomed out DEAD — the stop returns nothing').toBeLessThan(0.1);
    expect(rebound[2], 'the pocket outthrows the flick').toBeGreaterThan(rebound[0]!);
    expect(rebound[3], 'over capacity rebounds less than everything else').toBeLessThan(
      Math.min(rebound[0]!, rebound[2]!),
    );
  }, 120_000);

  it('foam: absorbs, sags believably under load, and recovers on its ~1 s memory', async () => {
    // (i) A 4" W PLACED on foam (a 1 cm settle, ~2 J — the live, quasi-static
    // regime): sags ~50 mm, no jitter, no growth. Fast arrivals never meet a live
    // foam pad — the capacity gate sends them to the rigid regime, (iii) below.
    const pw = await emptyWorld();
    const rig = new PadRig(pw, FOAM_SEED);
    const s = 4 * IN;
    const h = pw.addCube(
      { metal: 'W', sideM: s, purityPctW: 95 },
      { x: 0, y: spawnY(rig.padTopRestY, 0.01, s), z: 0 },
      { entityId: 1 },
    );
    runPad(pw, rig, 6);
    const sag = rig.restCentreY - rig.padY();
    expect(sag, 'static sag ≈ mg/k').toBeGreaterThan(0.03);
    expect(sag).toBeLessThan(0.07);
    let lo = Infinity;
    let hi = -Infinity;
    runPad(pw, rig, 1, () => {
      const y = rig.padY();
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    });
    expect(hi - lo, 'no resting jitter').toBeLessThan(0.002);

    // (ii) Recovery after the load lifts: back within 2 mm of rest on the memory
    // timescale — 3τ = 3·c/k ≈ 0.8 s — never a one-frame jump.
    pw.remove(h);
    let tRecover = -1;
    let maxStepRise = 0;
    let prevY = rig.padY();
    for (let i = 0; i < Math.round(3 / DT); i++) {
      rig.beforeStep();
      pw.step(DT, []);
      const y = rig.padY();
      maxStepRise = Math.max(maxStepRise, y - prevY);
      prevY = y;
      if (tRecover < 0 && y >= rig.restCentreY - 0.002) tRecover = (i + 1) * DT;
    }
    console.log(
      `\n[D0.4 foam] sag ${(sag * 1000).toFixed(0)} mm, recovery ${tRecover.toFixed(2)} s, ` +
        `max one-step rise ${(maxStepRise * 1000).toFixed(1)} mm`,
    );
    expect(tRecover, 'recovers').toBeGreaterThan(0.3);
    expect(tRecover, 'but on the memory timescale, not instantly').toBeLessThan(1.5);
    // From a full-travel arrest the creep starts at travel/τ = 0.4 m/s → ~6.7 mm/step:
    // that is the memory's own designed speed. What this forbids is the 32 mm one-frame
    // launch the implicit damper allowed.
    expect(maxStepRise, 'no one-frame launch').toBeLessThan(0.01);
    pw.free();

    // (iii) A real drop is absorbed DEAD: 2" W from 2 m is 46 J, past FOAM's 30 J
    // gate, so it lands on the rigid crushed-foam regime and the fabric pair (CoR
    // 0.033 vs W) is all the bounce there is.
    const pw2 = await emptyWorld();
    const s2 = 2 * IN;
    expect(bottomsOutFoam(cubeMassKg('W', s2, 95), Math.sqrt(2 * G * 2))).toBe(true);
    const rig2 = new PadRig(pw2, FOAM_SEED, 0.3, true);
    const h2 = pw2.addCube(
      { metal: 'W', sideM: s2, purityPctW: 95 },
      { x: 0, y: spawnY(rig2.padTopRestY, 2, s2), z: 0 },
      { entityId: 1 },
    );
    stepUntilImpact(pw2, h2, 1, 4, () => rig2.beforeStep());
    let apex = -Infinity;
    runPad(pw2, rig2, 3, () => {
      apex = Math.max(apex, pw2.transformOf(h2).p.y);
    });
    const frac = Math.max(0, (apex - s2 / 2 - rig2.padTopRestY) / 2);
    expect(frac, 'foam absorbs the drop').toBeLessThan(0.05);
    pw2.free();
  }, 120_000);
});

describe('D1 — the pad flips regimes in place', () => {
  it('live -> crushed -> live on one pad, with nothing leaked or forgotten', async () => {
    const pw = await emptyWorld();
    const bodies0 = pw.bodyCount;
    const joints0 = pw.jointCount;
    const rig = new PadRig(pw, TRAMPOLINE_SEED);
    const pad = rig.inner;
    expect(pw.jointCount).toBe(joints0 + 1);

    // Live: a gently placed cube compresses the spring.
    const s1 = 1 * IN;
    const h1 = pw.addCube(
      { metal: 'W', sideM: s1, purityPctW: 95 },
      { x: 0, y: spawnY(pad.padTopRestY, 0.005, s1), z: 0 },
      { entityId: 1 },
    );
    runPad(pw, rig, 2);
    const sag = pad.restCentreY - pad.padY();
    expect(sag, 'the live spring sags under a placed cube').toBeGreaterThan(0.0005);
    pw.remove(h1);
    runPad(pw, rig, 2);

    // Crush it: fixed body, joint gone, flat at rest.
    pad.setRegime('crushed');
    expect(pw.bodyKindOf(pad.pad)).toBe('fixed');
    expect(pw.jointCount, 'the joint is removed while crushed').toBe(joints0);
    expect(pad.padY()).toBeCloseTo(pad.restCentreY, 6);
    const s2 = 1 * IN;
    const h2 = pw.addCube(
      { metal: 'W', sideM: s2, purityPctW: 95 },
      { x: 0, y: spawnY(pad.padTopRestY, 3, s2), z: 0 },
      { entityId: 2 },
    );
    stepUntilImpact(pw, h2, 2, 4, () => rig.beforeStep());
    let apex = -Infinity;
    runPad(pw, rig, 2, () => {
      apex = Math.max(apex, pw.transformOf(h2).p.y);
    });
    expect(pad.padY(), 'a crushed mat does not move').toBeCloseTo(pad.restCentreY, 6);
    expect(
      Math.max(0, (apex - s2 / 2 - pad.padTopRestY) / 3),
      'the rebound is the fabric alone',
    ).toBeLessThan(0.15);
    pw.remove(h2);

    // Revive: dynamic again, joint back, spring works again.
    pad.setRegime('live');
    expect(pw.bodyKindOf(pad.pad)).toBe('dynamic');
    expect(pw.jointCount).toBe(joints0 + 1);
    const h3 = pw.addCube(
      { metal: 'W', sideM: s1, purityPctW: 95 },
      { x: 0, y: spawnY(pad.padTopRestY, 0.005, s1), z: 0 },
      { entityId: 3 },
    );
    runPad(pw, rig, 2);
    expect(pad.restCentreY - pad.padY(), 'the revived spring sags again').toBeGreaterThan(0.0005);
    pw.remove(h3);

    pad.teardown();
    expect(pw.bodyCount).toBe(bodies0);
    expect(pw.jointCount).toBe(joints0);
    pw.free();
  }, 120_000);
});

describe('D0.5 — replay recording cost', () => {
  it('recording 60 bodies costs well under the 0.05 ms/step budget', async () => {
    const pw = await worldWithFloor();
    const handles: BodyHandle[] = [];
    for (let i = 0; i < 60; i++) {
      const x = ((i % 8) - 3.5) * 0.24;
      const z = (Math.floor(i / 8) - 3.5) * 0.24;
      handles.push(pw.addCube({ metal: 'W', sideM: 1 * IN, purityPctW: 95 }, { x, y: 0.05, z }));
    }
    run(pw, 1.5); // settle

    const FRAMES = 90;
    const ring = new Float32Array(FRAMES * 60 * 7);
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    let recordMs = 0;
    const STEPS = 600;
    for (let i = 0; i < STEPS; i++) {
      pw.step(DT, []);
      const t0 = performance.now();
      const base = (i % FRAMES) * 60 * 7;
      for (let b = 0; b < 60; b++) {
        pw.readTransformInto(handles[b]!, p, q);
        const o = base + b * 7;
        ring[o] = p.x;
        ring[o + 1] = p.y;
        ring[o + 2] = p.z;
        ring[o + 3] = q.x;
        ring[o + 4] = q.y;
        ring[o + 5] = q.z;
        ring[o + 6] = q.w;
      }
      recordMs += performance.now() - t0;
    }
    const avg = recordMs / STEPS;
    console.log(`\n[D0.5 replay] recording 60 bodies: ${(avg * 1000).toFixed(1)} µs/step`);
    expect(avg).toBeLessThan(0.05);
    pw.free();
  }, 120_000);
});

describe('D0.6 — determinism', () => {
  async function oneDrop(): Promise<{ steps: number; v: number; e: number }> {
    const pw = await plateWorld();
    const s = 2 * IN;
    const m = cubeMassKg('W', s, 95);
    const h = wCube(pw, 2, spawnY(0, 5, s), 1);
    const v: Vec3 = { x: 0, y: 0, z: 0 };
    const out = stepUntilImpact(pw, h, 1, 4, () => {
      pw.readVelocityInto(h, v);
      pw.applyForce(h, { x: 0, y: dragForceClamped(v.y, s, m, DT), z: 0 });
    });
    pw.free();
    return { steps: out.steps, v: out.preSpeedMps, e: out.impact.energyJ };
  }

  it('two fresh worlds produce bit-identical impact numbers', async () => {
    const a = await oneDrop();
    const b = await oneDrop();
    expect(Object.is(a.v, b.v), 'speed bit-identical').toBe(true);
    expect(Object.is(a.e, b.e), 'energy bit-identical').toBe(true);
    expect(a.steps).toBe(b.steps);
  }, 120_000);
});
