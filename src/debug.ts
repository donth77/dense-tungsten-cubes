import * as THREE from 'three';
import type { App } from './app.ts';
import { config } from './config.ts';
import { cubeMassKg } from './data/metals.ts';
import type { ImpactEvent, MetalId } from './types.ts';

/**
 * Debug facade and tooling. Reached only via `?debug` or a dev build, and dynamically
 * imported so lil-gui and stats-gl are separate chunks nobody downloads (08 §16.5).
 *
 * NOTE on the collider overlay: 08 §11 step 11 proposed three's `RapierHelper` addon.
 * It can't be used — it takes the Rapier `World` as an argument, so wiring it up outside
 * `core/physics.ts` would breach the Rapier firewall (08 §5.1), and it ships no type
 * declarations in @types/three. Cuboid wireframes built from our own entity data are
 * ~15 lines, respect the seam, and show exactly the same thing.
 */

const IN = 0.0254;

export interface JitterResult {
  label: string;
  maxDriftMm: number;
  finalYMm: number;
  /** How far the cube settled *below* its ideal resting height — contact penetration. */
  sinkMm: number;
  /** The same, as a share of the cube's own side. This is the number that matters. */
  sinkPctOfSide: number;
  pass: boolean;
}

interface DenseDebug {
  app: App;
  bodyCount(): number;
  lastImpact(): ImpactEvent | null;
  fps(): number;
  frameMs(): number;
  spawn(metal?: MetalId, sizeIn?: number, purity?: number): void;
  setSpec(metal: MetalId, sizeIn: number, purity?: number): void;
  reset(): void;
  colliders(on: boolean): void;
  /** The M0 go/no-go (08 §11 step 8). */
  jitterTest(seconds?: number): Promise<JitterResult[]>;
  /** The extreme-mass-ratio probe (08 §14): 0.7 g under 996 kg. */
  massRatioTest(seconds?: number): Promise<JitterResult[]>;
  config: typeof config;
}

declare global {
  interface Window {
    __dense?: DenseDebug;
  }
}

export async function attachDebug(app: App): Promise<void> {
  const overlay = new ColliderOverlay(app);

  window.__dense = {
    app,
    bodyCount: () => app.entities.size,
    lastImpact: () => app.lastImpact,
    fps: () => app.loop.fps,
    frameMs: () => app.loop.frameMs,
    spawn: (metal = 'W', sizeIn = 2, purity = 95) => {
      app.spec = { metal, sideM: sizeIn * IN, purityPctW: purity };
      app.spawn();
    },
    setSpec: (metal, sizeIn, purity = 95) => {
      app.spec = { metal, sideM: sizeIn * IN, purityPctW: purity };
    },
    reset: () => app.reset(),
    colliders: (on) => overlay.setEnabled(on),
    jitterTest: (seconds = 10) => jitterTest(app, seconds),
    massRatioTest: (seconds = 10) => massRatioTest(app, seconds),
    config,
  };

  await mountStats(app);
  console.warn('[dense] debug facade ready — try window.__dense.jitterTest()');
}

// ---- stats -----------------------------------------------------------------------

async function mountStats(app: App): Promise<void> {
  try {
    const mod = await import('stats-gl');
    const Stats = mod.default;
    const stats = new Stats({ trackGPU: true, horizontal: false });
    await stats.init(app.render.renderer);
    stats.dom.style.cssText = 'position:fixed;top:0;left:0;z-index:10;opacity:.85';
    document.body.appendChild(stats.dom);
    const tick = (): void => {
      stats.update();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    console.warn('[dense] stats-gl unavailable', err);
  }
}

// ---- collider overlay --------------------------------------------------------------

class ColliderOverlay {
  readonly #group = new THREE.Group();
  readonly #mat = new THREE.LineBasicMaterial({ color: 0xff6b1f, depthTest: false });
  #enabled = false;

  constructor(private readonly app: App) {
    this.#group.renderOrder = 999;
    this.app.render.scene.add(this.#group);
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
    this.#group.visible = on;
    if (on) this.#rebuild();
    else this.#clear();
  }

  #clear(): void {
    for (const c of [...this.#group.children]) {
      this.#group.remove(c);
      if (c instanceof THREE.LineSegments) c.geometry.dispose();
    }
  }

  #rebuild(): void {
    this.#clear();
    for (const e of this.app.entities.all) {
      const s = e.spec.sideM;
      // The *collider* is a sharp cuboid; the mesh has a 3 % chamfer. Seeing the two
      // disagree at the corners is the point of the overlay.
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s)),
        this.#mat,
      );
      const bind = (): void => {
        box.position.copy(e.mesh.position);
        box.quaternion.copy(e.mesh.quaternion);
      };
      bind();
      box.onBeforeRender = bind;
      this.#group.add(box);
    }
    if (this.#enabled) requestAnimationFrame(() => this.#rebuild());
  }
}

// ---- the M0 go/no-go ----------------------------------------------------------------

/**
 * Spawn small cubes at rest and a 3-stack, let them settle, then measure how far they
 * drift over `seconds`. Pass is < 0.5 mm and no visible wobble (08 §11 step 8).
 *
 * Failure escalation, in order: numSolverIterations 4 -> 8, then the small-cube damping,
 * then `world.lengthUnit`, then `WORLD_SCALE = 4`. Record whichever was needed.
 */
async function jitterTest(app: App, seconds: number): Promise<JitterResult[]> {
  app.hand.release();
  app.entities.clear();

  const half = (inches: number): number => (inches * IN) / 2;
  // restsOn: index of the body this one sits on, or omitted for the floor.
  const plan: {
    label: string;
    metal: MetalId;
    sizeIn: number;
    at: THREE.Vector3;
    restsOn?: number;
  }[] = [
    { label: '0.5" W at rest', metal: 'W', sizeIn: 0.5, at: new THREE.Vector3(-0.3, half(0.5), 0) },
    { label: '1" W at rest', metal: 'W', sizeIn: 1, at: new THREE.Vector3(-0.1, half(1), 0) },
    { label: '2" W stack (bottom)', metal: 'W', sizeIn: 2, at: new THREE.Vector3(0.2, half(2), 0) },
    {
      label: '2" W stack (middle)',
      metal: 'W',
      sizeIn: 2,
      at: new THREE.Vector3(0.2, half(2) * 3, 0),
      restsOn: 2,
    },
    {
      label: '2" W stack (top)',
      metal: 'W',
      sizeIn: 2,
      at: new THREE.Vector3(0.2, half(2) * 5, 0),
      restsOn: 3,
    },
  ];

  const ids = plan.map((p) => {
    app.spec = { metal: p.metal, sideM: p.sizeIn * IN, purityPctW: 95 };
    return app.entities.spawn({ ...app.spec }, { x: p.at.x, y: p.at.y, z: p.at.z }).id;
  });

  return measureDrift(app, plan, ids, seconds);
}

/**
 * The extreme-mass-ratio probe (08 §14): the size slider spans 0.25" Al (~0.7 g) to
 * 15" W95 (~996 kg), a 1.4-million-to-one range, and stacking across it is exactly what
 * players will try. Impulse solvers lose the light body first.
 *
 * Honest outcome to accept: a 0.7 g aluminium cube under a 19 kg tungsten one gets
 * squashed flat in reality too. "It sinks in" can be theatre rather than a bug.
 */
async function massRatioTest(app: App, seconds: number): Promise<JitterResult[]> {
  app.hand.release();
  app.entities.clear();

  const smallSide = 0.25 * IN;
  const bigSide = 4 * IN;
  console.warn(
    `[dense] mass ratio: 0.25" Al = ${(cubeMassKg('Al', smallSide) * 1000).toFixed(2)} g under ` +
      `4" W95 = ${cubeMassKg('W', bigSide).toFixed(2)} kg — ratio ${Math.round(
        cubeMassKg('W', bigSide) / cubeMassKg('Al', smallSide),
      ).toLocaleString()}:1`,
  );

  const plan = [
    {
      label: '0.25" Al (crushed)',
      metal: 'Al' as MetalId,
      sizeIn: 0.25,
      at: new THREE.Vector3(0, smallSide / 2, 0),
    },
    {
      label: '4" W95 (on top)',
      metal: 'W' as MetalId,
      sizeIn: 4,
      at: new THREE.Vector3(0, smallSide + bigSide / 2, 0),
      restsOn: 0,
    },
  ];
  const ids = plan.map((p) => {
    app.spec = { metal: p.metal, sideM: p.sizeIn * IN, purityPctW: 95 };
    return app.entities.spawn({ ...app.spec }, { x: p.at.x, y: p.at.y, z: p.at.z }).id;
  });

  return measureDrift(app, plan, ids, seconds);
}

/**
 * Settle for 1 s, then track the largest excursion from the settled pose.
 * `plan[i].at.y` is the *ideal* resting height, so the gap to the settled height is
 * the solver's contact penetration.
 */
async function measureDrift(
  app: App,
  plan: { label: string; sizeIn: number; at: THREE.Vector3; restsOn?: number }[],
  ids: number[],
  seconds: number,
): Promise<JitterResult[]> {
  await sleep(1000);

  const origin = ids.map((id) => {
    const e = app.entities.get(id)!;
    return { x: e.curr.p.x, y: e.curr.p.y, z: e.curr.p.z };
  });
  const maxDrift = ids.map(() => 0);

  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    await nextFrame();
    for (let i = 0; i < ids.length; i++) {
      const e = app.entities.get(ids[i]!);
      const o = origin[i]!;
      if (!e) continue;
      const d = Math.hypot(e.curr.p.x - o.x, e.curr.p.y - o.y, e.curr.p.z - o.z);
      if (d > maxDrift[i]!) maxDrift[i] = d;
    }
  }

  // Absolute drop below ideal, per body — the raw input to per-contact penetration.
  const dropMm = ids.map((id, i) => {
    const e = app.entities.get(id);
    return (plan[i]?.at.y ?? 0) * 1000 - (e?.curr.p.y ?? 0) * 1000;
  });

  const results: JitterResult[] = ids.map((id, i) => {
    const e = app.entities.get(id);
    const mm = maxDrift[i]! * 1000;
    const p = plan[i];
    // Penetration is measured, not eyeballed: a resting cube's centre should sit at
    // exactly half its side above whatever it rests on. Anything else is the solver's
    // allowed contact error, and on a 0.25" cube that error is a visible burial.
    // Penetration at THIS body's own contact, not the accumulated drop of everything
    // beneath it. Measuring a stack's top cube against its absolute ideal height counts
    // the bottom cube's penetration three times and reports a false failure.
    const below = p?.restsOn ?? -1;
    const sinkMm = dropMm[i]! - (below >= 0 ? (dropMm[below] ?? 0) : 0);
    // Judged RELATIVE to the cube's own size, not as an absolute. The size slider spans
    // 0.25"–15", so a fixed millimetre budget is meaningless at one end or the other:
    // 0.5 mm is invisible on a 15" cube and half a burial on a 0.25" one.
    const sideMm = (p?.sizeIn ?? 2) * IN * 1000;
    const sinkPct = sideMm > 0 ? (sinkMm / sideMm) * 100 : 0;
    return {
      label: p?.label ?? `#${id}`,
      maxDriftMm: round(mm, 4),
      finalYMm: round((e?.curr.p.y ?? 0) * 1000, 3),
      sinkMm: round(sinkMm, 3),
      sinkPctOfSide: round(sinkPct, 1),
      pass: mm < 0.5 && sinkPct < 5,
    };
  });
  console.table(results);
  const drifted = results.filter((r) => r.maxDriftMm >= 0.5);
  const sunk = results.filter((r) => r.sinkPctOfSide >= 5);
  console.warn(
    drifted.length === 0 && sunk.length === 0
      ? `[dense] JITTER GATE PASS — max drift ${round(
          Math.max(...results.map((r) => r.maxDriftMm)),
          4,
        )} mm, max sink ${round(
          Math.max(...results.map((r) => r.sinkPctOfSide)),
          1,
        )}% of side over ${seconds}s`
      : `[dense] JITTER GATE FAIL — ${drifted.length} drifting (>0.5 mm), ${sunk.length} sunk ` +
          `(>5% of side). Escalate: solver iters 8 -> contact tolerances -> damping -> ` +
          `lengthUnit -> WORLD_SCALE 4`,
  );
  return results;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const round = (v: number, dp: number): number => Number(v.toFixed(dp));
