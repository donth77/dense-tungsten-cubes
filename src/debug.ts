import * as THREE from 'three';
import type { App } from './app.ts';
import { config } from './config.ts';
import { cubeMassKg } from './data/metals.ts';
import type { ImpactEvent, MetalId, PartShape } from './types.ts';

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
  /** The mounted lab, or null. `__dense.lab()?.scale?.state` reads the scale. */
  lab(): unknown;
  colliders(on: boolean): void;
  /** The M0 go/no-go (08 §11 step 8). */
  jitterTest(seconds?: number): Promise<JitterResult[]>;
  /** The extreme-size-ratio probe (08 §14). Expected to FAIL — see docs/14 PHY-03. */
  massRatioTest(seconds?: number, bigIn?: number): Promise<JitterResult[]>;
  /** The stack at the published limit: an upper cube 2x the lower one's side. */
  envelopeTest(seconds?: number, lowerIn?: number): Promise<JitterResult[]>;
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
    // The active lab, for reading an instrument that has no HUD yet.
    lab: () => app.labs.active,
    colliders: (on) => overlay.setEnabled(on),
    jitterTest: (seconds = 10) => jitterTest(app, seconds),
    massRatioTest: (seconds = 10, bigIn = 4) => massRatioTest(app, seconds, bigIn),
    envelopeTest: (seconds = 10, lowerIn = 1) => envelopeTest(app, seconds, lowerIn),
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
    stats.dom.style.cssText = 'position:fixed;bottom:0;left:0;z-index:10;opacity:.85';
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
  /** One wireframe per live entity, rebuilt only when the entity set changes. */
  readonly #boxes = new Map<number, THREE.LineSegments>();
  /**
   * The same for a lab's compound instrument bodies, which are NOT entities — they are
   * not spawnable, selectable or culled, so nothing in the entity events describes them.
   *
   * Worth drawing for the reason the overlay exists at all: 15 §1 drives instrument
   * physics from simplified procedural colliders and never from the asset's render
   * triangles, so the solver's balance beam and the artist's balance beam are different
   * shapes on purpose. This is the only way to see the one the simulation believes in.
   */
  readonly #propGroups = new Map<number, THREE.Group>();
  #enabled = false;
  #offSpawn: (() => void) | null = null;
  #offDespawn: (() => void) | null = null;
  #offLab: (() => void) | null = null;

  constructor(private readonly app: App) {
    this.#group.renderOrder = 999;
    this.app.render.scene.add(this.#group);
  }

  setEnabled(on: boolean): void {
    if (on === this.#enabled) return;
    this.#enabled = on;
    this.#group.visible = on;
    if (on) {
      this.#sync();
      this.#syncProps();
      // Rebuild on membership change only. The previous version re-created an
      // EdgesGeometry per cube on EVERY frame via a self-scheduling rAF, which allocated
      // more per second than the simulation it was there to inspect.
      this.#offSpawn = this.app.bus.on('spawn', () => this.#sync());
      this.#offDespawn = this.app.bus.on('despawn', () => this.#sync());
      // Instruments appear and vanish with a lab, not with a spawn.
      this.#offLab = this.app.bus.on('lab-changed', () => this.#syncProps());
    } else {
      this.#offSpawn?.();
      this.#offDespawn?.();
      this.#offLab?.();
      this.#offSpawn = this.#offDespawn = this.#offLab = null;
      this.#clear();
    }
  }

  #clear(): void {
    for (const box of this.#boxes.values()) {
      this.#group.remove(box);
      box.geometry.dispose();
    }
    this.#boxes.clear();
    this.#clearProps();
  }

  #clearProps(): void {
    for (const g of this.#propGroups.values()) {
      this.#group.remove(g);
      g.traverse((o) => {
        if (o instanceof THREE.LineSegments) o.geometry.dispose();
      });
    }
    this.#propGroups.clear();
  }

  /**
   * Rebuilds the compound-body wireframes wholesale. Cheap, and it runs on a lab switch
   * rather than per frame: a lab's instrument set is fixed between builds.
   */
  #syncProps(): void {
    if (!this.#enabled) return;
    this.#clearProps();
    for (const handle of this.app.physics.allBodies()) {
      const parts = this.app.physics.partsOf(handle);
      if (parts.length === 0) continue; // a cube: drawn from entity data above

      const group = new THREE.Group();
      for (const part of parts) {
        const src = boxGeometryFor(part.shape);
        if (!src) continue;
        const seg = new THREE.LineSegments(new THREE.EdgesGeometry(src), this.#mat);
        src.dispose();
        if (part.at) seg.position.set(part.at.x, part.at.y, part.at.z);
        if (part.rotation) {
          seg.quaternion.set(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w);
        }
        group.add(seg);
      }
      /*
       * Track the body each frame without rebuilding anything, exactly as the cube
       * wireframes do — and read through the facade, never a Rapier handle.
       *
       * The hook goes on every CHILD, not on the group: `onBeforeRender` only fires for
       * objects the renderer actually draws, and a Group is not one. Hung on the group
       * it never ran, and every compound was drawn with its body at the origin — the
       * balance's stand appeared a full pivot-height below the stand, which read as the
       * physics being misaligned when it was only the overlay.
       */
      const follow = (): void => {
        if (!this.app.physics.hasBody(handle)) return;
        const t = this.app.physics.transformOf(handle);
        group.position.set(t.p.x, t.p.y, t.p.z);
        group.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
      };
      for (const child of group.children) child.onBeforeRender = follow;
      follow();
      this.#propGroups.set(handle, group);
      this.#group.add(group);
    }
  }

  #sync(): void {
    const live = new Set<number>();
    for (const e of this.app.entities.all) {
      live.add(e.id);
      if (this.#boxes.has(e.id)) continue;
      const s = e.spec.sideM;
      // The outer box of the collider. Since 14 PHY-07 the collider is a ROUND cuboid
      // whose outer half-extent is exactly `s/2`, so this outline is the collider's true
      // bounding box and the mesh should sit inside it, touching at the face centres.
      // It used to be a genuine mismatch — sharp collider, chamfered mesh.
      const src = new THREE.BoxGeometry(s, s, s);
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(src), this.#mat);
      src.dispose();
      // Track the mesh each frame without rebuilding anything.
      box.onBeforeRender = () => {
        box.position.copy(e.mesh.position);
        box.quaternion.copy(e.mesh.quaternion);
      };
      this.#boxes.set(e.id, box);
      this.#group.add(box);
    }
    for (const [id, box] of [...this.#boxes]) {
      if (live.has(id)) continue;
      this.#group.remove(box);
      box.geometry.dispose();
      this.#boxes.delete(id);
    }
  }
}

/** A drawable stand-in for a collider shape. Cylinders are drawn as their bounding box. */
function boxGeometryFor(shape: PartShape): THREE.BoxGeometry | null {
  switch (shape.kind) {
    case 'box':
    case 'roundedBox': {
      const h = shape.halfExtents;
      return new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
    }
    case 'cylinder':
      return new THREE.BoxGeometry(shape.radiusM * 2, shape.halfHeightM * 2, shape.radiusM * 2);
  }
}

// ---- the M0 go/no-go ----------------------------------------------------------------

/**
 * Spawn small cubes at rest and a 3-stack, let them settle, then measure how far they
 * drift over `seconds`. Pass is < 0.5 mm and no visible wobble (08 §11 step 8).
 *
 * The escalation ladder this used to name (solver iterations -> damping -> lengthUnit ->
 * WORLD_SCALE) is gone. Every rung was measured at 14 and none of them moved the number
 * that mattered; `WORLD_SCALE` was never read by any code at all. What DID work was
 * tightening the contact tolerances — see config.stability.allowedLinearError.
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
 * The extreme-size-ratio probe (08 §14). Stacking across the size slider is exactly what
 * players will try, and impulse solvers lose the small body first.
 *
 * **This test is expected to FAIL, and that is the point.** Measured at 14: the lower
 * cube's centre ends up *below* the supporting surface, and no solver setting recovers
 * it — 4/8/16/32 iterations, 1/4/8 internal PGS iterations, `lengthUnit` 1/0.1/0.01,
 * `allowedLinearError` down to exactly 0, and 1/4/12 substeps all land between 54 % and
 * 56 % sink. The limit is the SIZE ratio, not the mass ratio: at equal size a 6.67x
 * density ratio barely registers.
 *
 * The supported envelope has TWO limits: the lower cube must be at least 0.75", and the
 * upper cube no more than 2x its side. Run `window.__dense.envelopeTest()` for the
 * passing side of that line.
 *
 * @param bigIn side of the upper cube, inches. Defaults to 4" — the case 14 measured.
 */
async function massRatioTest(app: App, seconds: number, bigIn = 4): Promise<JitterResult[]> {
  app.hand.release();
  app.entities.clear();

  const smallSide = 0.25 * IN;
  const bigSide = bigIn * IN;
  console.warn(
    `[dense] size ratio ${(bigIn / 0.25).toFixed(0)}:1 (mass ratio ${Math.round(
      cubeMassKg('W', bigSide) / cubeMassKg('Al', smallSide),
    ).toLocaleString()}:1) — 0.25" Al = ${(cubeMassKg('Al', smallSide) * 1000).toFixed(2)} g ` +
      `under ${bigIn}" W95 = ${cubeMassKg('W', bigSide).toFixed(2)} kg. ` +
      `EXPECTED TO FAIL above a 2:1 size ratio — see docs/14 PHY-03.`,
  );

  const plan = [
    {
      label: '0.25" Al (crushed)',
      metal: 'Al' as MetalId,
      sizeIn: 0.25,
      at: new THREE.Vector3(0, smallSide / 2, 0),
    },
    {
      label: `${bigIn}" W95 (on top)`,
      metal: 'W' as MetalId,
      sizeIn: bigIn,
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
 * The stack at the PUBLISHED limit — an upper cube exactly 2x the lower one's side.
 *
 * This is the companion to `massRatioTest`: same shape, inside the envelope instead of
 * outside it, so the two together show where the line is rather than only that a line
 * exists. Expected to pass for `lowerIn >= 0.75`; below that a cube cannot reliably
 * support anything at all, including an identical cube, and the UPPER cube is the one to
 * watch — it slides off onto the floor while the lower one sits there looking fine.
 */
async function envelopeTest(app: App, seconds: number, lowerIn: number): Promise<JitterResult[]> {
  app.hand.release();
  app.entities.clear();

  const upperIn = lowerIn * 2;
  const lower = lowerIn * IN;
  const upper = upperIn * IN;
  console.warn(
    `[dense] envelope: ${lowerIn}" under ${upperIn}" (size ratio 2:1, the published limit)`,
  );

  const plan = [
    {
      label: `${lowerIn}" W95 (lower)`,
      metal: 'W' as MetalId,
      sizeIn: lowerIn,
      at: new THREE.Vector3(0, lower / 2, 0),
    },
    {
      label: `${upperIn}" W95 (upper)`,
      metal: 'W' as MetalId,
      sizeIn: upperIn,
      at: new THREE.Vector3(0, lower + upper / 2, 0),
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
          `(>5% of side). Contact tolerance is the lever that measurably moves this ` +
          `(config.stability.allowedLinearError); solver iterations do not.`,
  );
  return results;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const round = (v: number, dp: number): number => Number(v.toFixed(dp));
