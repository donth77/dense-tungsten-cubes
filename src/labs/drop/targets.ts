import * as THREE from 'three';
import { config } from '../../config.ts';
import { PropStore } from '../../core/props.ts';
import { loadCrushAssets } from './asset.ts';
import type { CrushAssets, FragChunk } from './asset.ts';
import { glintSpec, juiceSpec } from '../../fx/particles.ts';
import { pineBoard } from './rigtex.ts';
import type { LabContext } from '../lab.ts';
import { PROP_ID_BASE } from '../../types.ts';
import type { BodyHandle, EntityId, ImpactEvent, SurfaceId, Transform, Vec3 } from '../../types.ts';

/**
 * Breakable targets under the winch (18 §5, C1). The intact target is one light
 * dynamic prop with impact identity; past its ARRIVAL-energy threshold (the C0
 * finding) it swaps for pre-authored shards with inherited motion. The pedestal and
 * every body here are BORN at their poses — never moved while fixed (the 2026-08-25
 * engine truth) — which is why deploy/stow REBUILDS bodies instead of parking them.
 *
 * The stow/deploy cycle: the carriage descends over the plate to pick cubes up, and
 * its bi-fold floor sweeps the whole interior — so the target leaves during
 * loading/hoisting and a FRESH one rises once the winch is armed overhead.
 */

export type TargetId =
  'none' | 'egg' | 'wine-glass' | 'glass-pane' | 'soda-can' | 'pine-board' | 'watermelon';
export const TARGET_LABELS: Readonly<Record<TargetId, string>> = {
  none: 'None',
  egg: 'Egg',
  'wine-glass': 'Wine glass',
  'glass-pane': 'Glass pane',
  'soda-can': 'Soda can',
  watermelon: 'Watermelon',
  'pine-board': 'Pine board',
};

/** Per-target facts (18 §6 C2) — thresholds are 02 §7's ≈-anchors. */
interface TargetSpec {
  thresholdJ: number;
  massKg: number;
  verdict: 'shattered' | 'splat' | 'crushed-flat' | 'cracked-open' | 'snapped';
  pedestal: boolean;
  voice: 'tinkle_glass' | 'splat_melon' | 'crunch_can' | 'crack_egg' | 'snap_wood';
  /**
   * Quasi-static break force (02 §7). A target with one breaks WITHOUT an impact:
   * rest enough weight on it and it gives. The egg is the whole reason the trigger
   * exists — 0.05 J is a 5 mm drop, so gentle placement is the only survival, and
   * "gentle" has to be a force, not an energy.
   */
  sustainedN?: number;
  /**
   * Speed at which the target breaks ITSELF against something hard (m/s).
   *
   * Arrival ENERGY is the right gauge for a cube striking a target, and the wrong
   * one for a target that has been knocked off its stand: a 150 g glass falling
   * 23 cm carries 0.34 J against a 1 J threshold, so a goblet swept onto the plate
   * bounced and sat there intact (user-caught, 2026-08-25). Brittle failure is
   * local stress, not total energy — what matters is how fast the shell meets the
   * hard thing. Soft partners (pads, pulp) never trigger it.
   */
  selfBreakMps?: number;
}
export const TARGET_SPEC: Readonly<Record<Exclude<TargetId, 'none'>, TargetSpec>> = {
  'wine-glass': {
    thresholdJ: 1,
    massKg: 0.15,
    verdict: 'shattered',
    pedestal: true,
    voice: 'tinkle_glass',
    // A wine glass tipped onto a hard counter breaks; ~1.3 m/s is a 9 cm fall.
    selfBreakMps: 1.3,
  },
  egg: {
    // 02 §7: cracks at ~45 N quasi-static, ~0.05 J dropped (an 8-10 mm fall).
    thresholdJ: 0.05,
    massKg: 0.06,
    verdict: 'cracked-open',
    pedestal: false,
    voice: 'crack_egg',
    sustainedN: 45,
    // 02 §7: an egg cracks from an 8-10 mm drop — that is 0.4 m/s.
    selfBreakMps: 0.45,
  },
  'glass-pane': {
    // 02 §7: a 4 mm annealed pane cracks to a hard point at ~0.5-2 J. (EN 12600's
    // soft-body pendulum classes are 93/220/589 J — a different regime entirely,
    // cited in 02 for honesty, and NOT what a tungsten cube does to a sheet.)
    thresholdJ: 2,
    massKg: 1.2,
    verdict: 'shattered',
    pedestal: false,
    voice: 'tinkle_glass',
    selfBreakMps: 1.2,
  },
  'soda-can': {
    // 02 §7: 1 J dents, 5 J flattens (427–850 N buckling mapped at ~5 mm crush).
    thresholdJ: 5,
    massKg: 0.015,
    verdict: 'crushed-flat',
    pedestal: false,
    voice: 'crunch_can',
  },
  'pine-board': {
    // 02 §7: 50 J snaps a pine board, and it dents from 10 J. Janka-informed
    // (pine ~1,690 N to embed an 11.28 mm ball halfway).
    thresholdJ: 50,
    massKg: 0.9,
    verdict: 'snapped',
    pedestal: false,
    voice: 'snap_wood',
    // Dropped on its edge a board just clatters; it takes a real fall to break one.
    selfBreakMps: 6,
  },
  watermelon: {
    thresholdJ: 40,
    // The FULL melon mesh composes to 0.32 × 0.32 × 0.42 m — a big market melon,
    // and those run 8-plus kilos (the union-bbox 5 kg guess measured the halves too).
    massKg: 8,
    verdict: 'splat',
    pedestal: false,
    voice: 'splat_melon',
    // A melon bursts when IT is the one dropped, from about 40 cm.
    selfBreakMps: 2.8,
  },
};

/**
 * The TARGET row, ordered by the energy it takes to break each one — the row IS the
 * ladder, so reading left to right is reading 0.05 J to 50 J (user, 2026-08-26).
 *
 * DERIVED, not hand-listed: the hand-written order had already drifted, with the
 * 50 J board sitting ahead of the 40 J melon. Sorting off the catalog means adding
 * a target cannot put it in the wrong place.
 */
export const TARGET_IDS: readonly TargetId[] = [
  'none',
  ...(Object.keys(TARGET_SPEC) as Exclude<TargetId, 'none'>[]).sort(
    (a, b) => TARGET_SPEC[a].thresholdJ - TARGET_SPEC[b].thresholdJ,
  ),
];

const GLASS_ID: EntityId = PROP_ID_BASE + 1;
/** The structure under a target gets its own identity, so impacts can name it. */
const SUPPORT_ID_BASE: EntityId = PROP_ID_BASE + 10;

/**
 * STRUCTURE (18 §6 C3, user 2026-08-26): the things a target stands on break too,
 * at the top of the energy ladder. A hollow CMU is ~14 MPa on net area and a marble
 * plinth 50-180, so the plinth is the harder of the two — and both are far above
 * the 50 J board, which is the point: it should take a monster cube to reach them.
 *
 * Kind is what the rig fractures with and what the fragments are made of.
 */
interface SupportSpec {
  thresholdJ: number;
  massKg: number;
  frags: (a: CrushAssets) => FragChunk[];
}
const SUPPORT_SPEC = {
  block: { thresholdJ: 250, massKg: 17, frags: (a: CrushAssets) => a.blockFrags },
  plinth: { thresholdJ: 450, massKg: 20, frags: (a: CrushAssets) => a.plinthFrags },
} satisfies Record<string, SupportSpec>;
type SupportKind = keyof typeof SUPPORT_SPEC;

/**
 * How a target's pieces move when it breaks (realism audit, 2026-08-25). The audit's
 * root finding: bbox colliders inter-penetrated at spawn and the solver's
 * depenetration shove (~2+ m/s at ANY energy) drowned the authored kick — every
 * burst was the same uniform evacuation. Hull colliders spawn touching, so these
 * numbers are finally the ones in charge.
 */
interface BurstProfile {
  /** Radial speed of free pieces. Callers scale it with √excess — regimes differ in kind. */
  kickMps: number;
  /** Vertical share of the kick. Squeeze-flow sprays FLAT; glass pops higher. */
  loftFrac: number;
  spin: number;
  material: SurfaceId;
  /** Implicit drag — wet pulp flies fast and dies fast; glass skitters further. */
  linearDamping: number;
  angularDamping: number;
  /**
   * Pieces this close to the impact axis (body-local xz) stay put at a tenth of
   * the kick — the crater material the impactor drove into rather than past.
   * At heavy overkill the same central pieces are usually pulped away entirely,
   * which is how the cube reaches the plate. Null = none pinned.
   */
  pinnedR: number | null;
  /** Fragment indices converted to juice instead of spawning — pulverization. */
  pulped: ReadonlySet<number> | null;
}

/** The real plinth (assets-lib/pedestal, baked 0.173×): 22.8 cm tall. */
export const PEDESTAL_TOP_M = 0.228;
/** Foot + stem + bowl, toy-scaled. */
/** The real glass (assets-lib/wine-glass) is 19.5 cm, base-origined, real scale. */
const GLASS_H = 0.195;
/** Fallback wedge scale — the pre-fractured GLB pieces are the real recipe now. */
const GS = 1.45;
export const TARGET_TOP_M = PEDESTAL_TOP_M + GLASS_H;

/*
 * The can (18 §6 C2): a true 355 ml empty — 122 mm tall, Ø 64 mm, 15 g — with THREE
 * authored states baked into the GLB. Dent telescopes the shoulder to 103 mm; the
 * flat is 29 mm of accordion folds bulged to Ø 72. The dent band is [1, 5) J.
 */
const CAN_H = 0.122;
const CAN_R = 0.032;
const CAN_DENT_H = 0.103;
const CAN_FLAT_H = 0.0293;
const CAN_FLAT_R = 0.036;
const CAN_DENT_MIN_J = 1;

/*
 * The span rig (18 §6 C3, user direction): a target laid across TWO CINDER BLOCKS,
 * the karate-demo setup. This is not decoration — a board flat on the plate is
 * supported everywhere and cannot snap, it can only dent locally. Bending failure
 * needs an unsupported middle, and the visible gap is also what makes the break
 * legible: you can see WHY it went.
 *
 * The block is a real CMU (0.440 x 0.203 x 0.203, shipped verbatim), laid with its
 * length across the span so each end of the target gets a wide bearing.
 */
const BLOCK_L = 0.4403;
const BLOCK_H = 0.2032;
const BLOCK_D = 0.2032;
/*
 * Centre-to-centre of the two supports. The span runs along X — ACROSS the view — so
 * both halves land where they can be seen; spanning away from the camera put one half
 * permanently behind the blocks (screenshot review).
 *
 * 0.21 leaves a 22 cm unsupported middle under a 30 cm board, i.e. ~4.4 cm of bearing
 * at each end. The first cut sat at 0.17 and the blocks nearly touched under the
 * board (user: "should be spaced out further") — which also read as a smaller span
 * than the break implies. A karate board rests on an inch or two of block and no more.
 */
const SPAN_X = 0.21;
/** A 12 x 12 inch pine board, 19 mm — the board every karate demo uses. */
const BOARD_X = 0.305;
const BOARD_Z = 0.305;
const BOARD_T = 0.019;
const BOARD_CREAK_MIN_J = 10;

/** A 4 mm annealed sheet, spanning the same two blocks the board does. */
const PANE_X = 0.4;
const PANE_Z = 0.3;
const PANE_T = 0.004;

/** A large hen's egg (assets-lib/egg, baked 0.136x): 5.7 cm tall, 4.4 cm across. */
const EGG_H = 0.057;
const EGG_R = 0.022;
/** Steps the load must hold before the shell gives — a bump is not a squeeze. */
const EGG_DWELL_STEPS = 8;

export class TargetRig {
  readonly #ctx: LabContext;
  readonly #props: PropStore;
  readonly #group = new THREE.Group();
  readonly #disposables: { dispose(): void }[] = [];
  #glassMat: THREE.MeshPhysicalMaterial | null = null;
  #fleshMat: THREE.MeshStandardMaterial | null = null;
  #rindMat: THREE.MeshStandardMaterial | null = null;
  #eggMat: THREE.Material | null = null;
  #pineMat: THREE.MeshStandardMaterial | null = null;
  #paneMat: THREE.MeshPhysicalMaterial | null = null;
  #assetCache: CrushAssets | null = null;
  #shardMat: THREE.Material | null = null;
  #gen = 0;

  #selected: TargetId = 'none';
  #bodies: BodyHandle[] = [];
  #glass: BodyHandle | null = null;
  #glassVisual: THREE.Group | null = null;
  #shards: BodyHandle[] = [];
  #deployed = false;
  #broken = false;
  #wasHit = false;
  #pendingBreakAt: Vec3 | null = null;
  #pendingKickJ = 0;
  /** Who struck, and how fast — so the break can charge them for it and let them pass. */
  #pendingStriker: { id: EntityId; vHit: number; massKg: number } | null = null;
  #sustainedSteps = 0;
  /** Breakable structure under the target, with the pose each was born at. */
  #supports: {
    id: EntityId;
    body: BodyHandle;
    kind: SupportKind;
    at: Vec3;
    visual: THREE.Group;
  }[] = [];
  #pendingSupport: { id: EntityId; excessJ: number } | null = null;
  #canState: 'intact' | 'dent' | 'flat' = 'intact';
  #pendingDent = false;
  #pendingDentAt: Vec3 | null = null;
  #pendingDentJ = 0;
  #canHolder: THREE.Group | null = null;
  #canMorphMeshes: THREE.Mesh[] = [];
  #canMorphGoal: [number, number] = [0, 0];

  constructor(ctx: LabContext) {
    this.#ctx = ctx;
    this.#props = new PropStore(ctx.physics);
    ctx.scene.add(this.#group);
  }

  get selected(): TargetId {
    return this.#selected;
  }
  get deployed(): boolean {
    return this.#deployed;
  }
  get broken(): boolean {
    return this.#broken;
  }
  get wasHit(): boolean {
    return this.#wasHit;
  }
  get canState(): 'intact' | 'dent' | 'flat' {
    return this.#canState;
  }

  /** The verdict this target's break earns (18 §5.4). */
  get breakVerdict(): TargetSpec['verdict'] {
    return this.#selected === 'none' ? 'shattered' : TARGET_SPEC[this.#selected].verdict;
  }

  get thresholdJ(): number {
    return this.#selected === 'none' ? Infinity : TARGET_SPEC[this.#selected].thresholdJ;
  }

  select(id: TargetId): void {
    if (id === this.#selected) return;
    this.#selected = id;
    this.stow(); // whatever stood there belongs to the old choice
  }

  /**
   * Lifecycle, called every step. Since the raised-platform redesign (2026-08-25)
   * the target PERSISTS through every phase — the carriage never descends over the
   * plate, so nothing sweeps it. `refresh()` starts each drop cycle clean.
   */
  syncPhase(towerPhase: string): void {
    void towerPhase;
    if (this.#selected === 'none') {
      if (this.#deployed || this.#shards.length > 0) this.stow();
      return;
    }
    if (!this.#deployed) this.deploy();
  }

  /**
   * Compile the burst materials NOW, while nothing is falling.
   *
   * The first melon drop of a session froze for 727 ms (measured, 2026-08-27): the
   * fragment and juice materials had never been drawn, so the driver compiled four
   * shader programs at the moment of impact. Physics keeps stepping through a stalled
   * frame, so the cube was already buried in the melon when drawing resumed — read as
   * the cube clipping through before the burst appeared (user).
   *
   * compileAsync warms the programs off the hot path. It does not upload the fragment
   * geometry — that still lands at burst — but the programs were the expensive half.
   * Failure here is free: a cold burst is exactly today's behaviour.
   */
  warmBurstShaders(): void {
    void loadCrushAssets()
      .then(async (a) => {
        const warm = new THREE.Group();
        for (const set of [a.melonFrags, a.glassFrags, a.blockFrags, a.plinthFrags]) {
          for (const f of set) warm.add(f.visual.clone());
        }
        // Off the floor and unrendered: compileAsync needs the object parented into a
        // scene for lights and environment to resolve, not shown to anyone.
        warm.visible = false;
        this.#ctx.scene.add(warm);
        const { renderer, camera } = this.#ctx.render;
        await renderer.compileAsync(warm, camera, this.#ctx.scene);
        this.#ctx.scene.remove(warm);
        warm.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
      })
      .catch(() => {
        /* a cold first burst is the status quo, not a regression */
      });
  }

  /** A fresh intact target and a swept debris field — each HOIST begins a new take. */
  refresh(): void {
    if (this.#selected === 'none') return;
    this.stow();
    this.deploy();
  }

  /**
   * Watch the impact stream for the intact target. Returns 'broke' the step the
   * threshold is crossed (the physical swap is queued for the next beforePhysics),
   * 'hit' for a sub-threshold touch, null otherwise. A knocked-off glass striking
   * anything with its OWN energy past the threshold also breaks — as it should.
   */
  checkImpacts(
    events: readonly ImpactEvent[],
    massOf: (id: EntityId) => number | null,
  ): 'broke' | 'hit' | null {
    /*
     * Structure is scanned FIRST and unconditionally. The guard below exits as soon
     * as the target is broken, and that used to take the blocks with it: a cube that
     * snapped the board and then came down on a block was never examined, so no cube
     * could ever break structure (caught by the 15" pin). What the target is doing
     * has nothing to do with whether the blocks under it survive.
     */
    for (const ev of events) this.#checkSupport(ev, massOf);
    if (!this.#deployed || this.#broken || this.#glass === null || this.#selected === 'none')
      return null;
    const spec = TARGET_SPEC[this.#selected];
    let result: 'broke' | 'hit' | null = null;
    for (const ev of events) {
      let arrivalJ: number | null = null;
      if (ev.b === GLASS_ID && typeof ev.a === 'number') {
        const m = massOf(ev.a);
        if (m !== null) arrivalJ = 0.5 * m * ev.normalSpeedMps * ev.normalSpeedMps;
      } else if (ev.a === GLASS_ID) {
        /*
         * The target is the one moving. Energy cannot speak for this case (see
         * `selfBreakMps`), so a brittle target answers to SPEED against anything
         * that is not soft — that is what a glass swept off its plinth does.
         */
        const soft =
          typeof ev.b === 'string' &&
          (ev.b === 'foam' || ev.b === 'trampoline' || ev.b === 'sand' || ev.b === 'pulp');
        if (spec.selfBreakMps !== undefined && !soft && ev.normalSpeedMps >= spec.selfBreakMps) {
          this.#wasHit = true;
          this.#pendingBreakAt = { ...ev.point };
          this.#pendingKickJ = 0;
          this.#broken = true;
          return 'broke';
        }
        arrivalJ = 0.5 * spec.massKg * ev.normalSpeedMps * ev.normalSpeedMps;
      }
      if (arrivalJ === null) continue;
      this.#wasHit = true;
      result = result ?? 'hit';
      if (
        this.#selected === 'pine-board' &&
        arrivalJ >= BOARD_CREAK_MIN_J &&
        arrivalJ < spec.thresholdJ
      ) {
        // 18 §5.2's sub-threshold recipe: "the board creaks". It takes the hit,
        // complains, and holds — the honest middle of a bending failure.
        this.#ctx.fx.play('creak_wood', 0.5);
      }
      if (
        this.#selected === 'soda-can' &&
        this.#canState === 'intact' &&
        arrivalJ >= CAN_DENT_MIN_J &&
        arrivalJ < spec.thresholdJ
      ) {
        // The sub-threshold recipe (18 §5.2): the can dents. Queued like the
        // break — no swap ever runs inside the event drain.
        this.#pendingDent = true;
        this.#pendingDentAt = { ...ev.point };
        this.#pendingDentJ = arrivalJ - CAN_DENT_MIN_J;
      }
      if (arrivalJ >= spec.thresholdJ) {
        this.#pendingBreakAt = { ...ev.point };
        this.#pendingKickJ = arrivalJ - spec.thresholdJ;
        const strikerId = ev.b === GLASS_ID && typeof ev.a === 'number' ? ev.a : null;
        const strikerKg = strikerId === null ? null : massOf(strikerId);
        this.#pendingStriker =
          strikerId !== null && strikerKg !== null
            ? { id: strikerId, vHit: ev.normalSpeedMps, massKg: strikerKg }
            : null;
        // Broken NOW, swapped next step — the survived-judge must never see the
        // one-step gap between the hit and the swap (measured, 2026-08-25).
        this.#broken = true;
        result = 'broke';
        break;
      }
    }
    return result;
  }

  /** The queued swap (18 §5.2): one step after the hit, never inside the event drain. */
  beforePhysics(): void {
    this.#collapseSupport();
    if (this.#pendingDent) {
      this.#pendingDent = false;
      // A same-step break outranks the dent.
      if (this.#pendingBreakAt === null && this.#glass !== null && this.#canState === 'intact') {
        this.#swapCanBody('dent', this.#pendingDentAt, this.#pendingDentJ);
        this.#ctx.fx.play('crunch_can', 0.55);
      }
      this.#pendingDentAt = null;
    }
    if (this.#pendingBreakAt === null || this.#glass === null) return;
    const at = this.#pendingBreakAt;
    this.#pendingBreakAt = null;
    if (this.#selected === 'soda-can') {
      // The can MORPHS instead of shattering (18 §5.3) — its visual lives on,
      // animating to the flat state while the collider swaps under it.
      this.#swapCanBody('flat', at, this.#pendingKickJ);
      this.#ctx.fx.play('crunch_can', 1);
      return;
    }
    const v: Vec3 = { x: 0, y: 0, z: 0 };
    this.#ctx.physics.readVelocityInto(this.#glass, v);
    const t = this.#ctx.physics.transformOf(this.#glass);
    this.#removeBody(this.#glass);
    this.#glass = null;
    // The intact visual dies WITH the body — it once outlived its own shattering
    // as a ghost on the pedestal (screenshot review, 2026-08-25).
    if (this.#glassVisual) {
      this.#group.remove(this.#glassVisual);
      this.#glassVisual = null;
    }
    this.#carryStrikerThrough();
    if (this.#selected === 'watermelon') this.#burstMelon(t, v, this.#pendingKickJ, at);
    else if (this.#selected === 'egg') this.#burstEgg(t, v, this.#pendingKickJ, at);
    else if (this.#selected === 'pine-board') this.#snapBoard(t, v, this.#pendingKickJ, at);
    else if (this.#selected === 'glass-pane') this.#shatterPane(t, v, this.#pendingKickJ, at);
    else this.#spawnShards(t, v, this.#pendingKickJ, at);
    if (this.#selected !== 'none') this.#ctx.fx.play(TARGET_SPEC[this.#selected].voice, 1);
  }

  afterPhysics(): void {
    // Contact forces are only meaningful after a step has solved them.
    this.#tickSustained();
    /*
     * Wreckage is RECOVERED, never culled (user, 2026-08-25: "it should not
     * disappear ever"). Capping the burst kick bounded the wreck's own flight, but
     * the striking cube can always punt a 15 g can harder than any recipe — a 4″
     * tungsten cube arrives with enough momentum to send it past the 3 m slab, and
     * the world simply ends there. Physics is right and the stage is finite, so the
     * compromise is at the boundary: anything that leaves the slab is set back down
     * just inside it, at rest, rather than deleted. A player who looks for the can
     * always finds it.
     */
    const pw = this.#ctx.physics;
    const edge = config.stage.floorHalfSizeM - 0.25;
    for (const b of this.#shards) {
      const p = pw.transformOf(b).p;
      const out = Math.abs(p.x) > edge || Math.abs(p.z) > edge;
      if (!out && p.y > 0) continue;
      pw.setTransform(
        b,
        {
          x: Math.max(-edge, Math.min(edge, p.x)),
          y: Math.max(0.06, p.y),
          z: Math.max(-edge, Math.min(edge, p.z)),
        },
        true,
      );
    }
    this.#props.capture();
  }
  render(alpha: number): void {
    this.#props.interpolate(alpha);
    // The crush morph plays on the render clock (~90 ms to goal) — FX, not physics.
    for (const m of this.#canMorphMeshes) {
      const inf = m.morphTargetInfluences;
      if (!inf) continue;
      inf[0]! += (this.#canMorphGoal[0] - inf[0]!) * 0.3;
      inf[1]! += (this.#canMorphGoal[1] - inf[1]!) * 0.3;
    }
  }

  /** Remove every body and visual; selection is kept and syncPhase redeploys fresh. */
  stow(): void {
    for (const b of this.#bodies) this.#removeBody(b);
    this.#bodies = [];
    for (const b of this.#shards) this.#removeBody(b);
    this.#shards = [];
    this.#glass = null;
    this.#deployed = false;
    this.#broken = false;
    this.#wasHit = false;
    this.#pendingBreakAt = null;
    this.#canState = 'intact';
    this.#sustainedSteps = 0;
    this.#supports = [];
    this.#pendingSupport = null;
    this.#pendingDent = false;
    this.#pendingDentAt = null;
    this.#canHolder = null;
    this.#canMorphMeshes = [];
    this.#canMorphGoal = [0, 0];
    this.#group.clear();
  }

  teardown(): void {
    this.stow();
    this.#ctx.scene.remove(this.#group);
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
    this.#glassMat?.dispose();
    this.#fleshMat?.dispose();
    this.#rindMat?.dispose();
  }

  /**
   * Make room before anything is born at plate centre.
   *
   * Every target here is BORN at its pose, and a body born inside a resting cube is
   * an overlap the solver resolves the only way it can — by shoving. A cube left on
   * the plate got punted off the stage when a target deployed on top of it (logged
   * 2026-08-25). Sliding the cube straight out along its own bearing, at rest, is
   * both cheap and legible: the cube ends up beside the target instead of in orbit.
   */
  #clearFootprint(rM: number): void {
    const pw = this.#ctx.physics;
    for (const e of this.#ctx.entities.all) {
      // Carried cubes belong to the winch, and anything up at carriage height is
      // nowhere near a target sitting on the plate.
      if (e.kind !== 'dynamic' || e.curr.p.y > 0.6) continue;
      const d = Math.hypot(e.curr.p.x, e.curr.p.z);
      const need = rM + e.spec.sideM * 0.6;
      if (d >= need) continue;
      const ux = d > 1e-3 ? e.curr.p.x / d : 1;
      const uz = d > 1e-3 ? e.curr.p.z / d : 0;
      pw.setTransform(e.body, { x: ux * need, y: e.curr.p.y, z: uz * need }, true);
    }
  }

  deploy(): void {
    if (this.#selected === 'none' || this.#deployed) return;
    // The span rigs are the widest; the glass and its plinth the narrowest.
    this.#clearFootprint(
      this.#selected === 'pine-board' || this.#selected === 'glass-pane'
        ? SPAN_X + BLOCK_D / 2
        : this.#selected === 'watermelon'
          ? 0.22
          : 0.11,
    );
    if (this.#selected === 'watermelon') {
      this.#deployMelon();
      return;
    }
    if (this.#selected === 'soda-can') {
      this.#deployCan();
      return;
    }
    if (this.#selected === 'egg') {
      this.#deployEgg();
      return;
    }
    if (this.#selected === 'pine-board') {
      this.#deployBoard();
      return;
    }
    if (this.#selected === 'glass-pane') {
      this.#deployPane();
      return;
    }
    this.#deployed = true;
    const pw = this.#ctx.physics;
    // Pedestal — born fixed at its pose, a steel column with a top plate.
    const plinthAt = { x: 0, y: PEDESTAL_TOP_M / 2, z: 0 };
    const plinthId = SUPPORT_ID_BASE as EntityId;
    const pedestal = pw.addCompound({
      kind: 'fixed',
      at: plinthAt,
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: PEDESTAL_TOP_M / 2, radiusM: 0.07 },
          material: 'concrete',
        },
      ],
      entityId: plinthId,
    });
    this.#bodies.push(pedestal);
    const pedGroup = new THREE.Group();
    this.#group.add(pedGroup);
    // Marble, and breakable: 450 J of arrival takes it (18 §6 C3).
    this.#supports.push({
      id: plinthId,
      body: pedestal,
      kind: 'plinth',
      at: plinthAt,
      visual: pedGroup,
    });

    // The glass — one light dynamic body with impact identity, resting on the cap.
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: PEDESTAL_TOP_M + 0.001, z: 0 },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: 0.005, radiusM: 0.033 },
          at: { x: 0, y: 0.005, z: 0 },
          material: 'glass',
          massKg: 0.05,
        },
        {
          shape: { kind: 'cylinder', halfHeightM: 0.045, radiusM: 0.006 },
          at: { x: 0, y: 0.055, z: 0 },
          material: 'glass',
          massKg: 0.03,
        },
        /*
         * The bowl is a CUP, not a plug: a solid cylinder gave the goblet an
         * invisible flat lid, and a sub-threshold cube perched on it mid-air
         * (user-caught, 2026-08-25). Four thin walls and an interior floor let a
         * tiny cube drop INSIDE and sit in the glass — and a rim hit can topple it.
         */
        {
          shape: { kind: 'cylinder', halfHeightM: 0.004, radiusM: 0.03 },
          at: { x: 0, y: 0.108, z: 0 },
          material: 'glass',
          massKg: 0.03,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.004, y: 0.045, z: 0.03 } },
          at: { x: 0.032, y: 0.15, z: 0 },
          material: 'glass',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.004, y: 0.045, z: 0.03 } },
          at: { x: -0.032, y: 0.15, z: 0 },
          material: 'glass',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.03, y: 0.045, z: 0.004 } },
          at: { x: 0, y: 0.15, z: 0.032 },
          material: 'glass',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.03, y: 0.045, z: 0.004 } },
          at: { x: 0, y: 0.15, z: -0.032 },
          material: 'glass',
          massKg: 0.01,
        },
      ],
      entityId: GLASS_ID,
    });
    this.#bodies.push(this.#glass);
    const glassGroup = new THREE.Group();
    this.#group.add(glassGroup);
    this.#glassVisual = glassGroup;
    this.#props.add(this.#glass, glassGroup);
    /*
     * The REAL models (user: "why did you create your own glass when we have a 3d
     * model for that?"). Clones per mount; a stale generation discards the swap.
     */
    const gen = ++this.#gen;
    void loadCrushAssets()
      .then((a) => {
        if (gen !== this.#gen || !this.#deployed) return;
        this.#assetCache = a;
        pedGroup.add(a.pedestal);
        if (this.#glassVisual) {
          this.#glassVisual.add(a.glass);
          a.glass.traverse((o) => {
            if (o instanceof THREE.Mesh && !this.#shardMat) {
              this.#shardMat = o.material as THREE.Material;
            }
          });
        }
      })
      .catch(() => {
        /* the collider still works; a missing skin beats a broken deploy */
      });
  }

  #glassMaterial(): THREE.MeshPhysicalMaterial {
    /*
     * FROSTED, not clear: near-pure transmission rendered ghost-invisible against
     * the grey stage under the deliberately dim 0.18 environment — the intact glass
     * barely read and the shards vanished entirely (screenshot review, 2026-08-25).
     */
    this.#glassMat ??= new THREE.MeshPhysicalMaterial({
      color: 0xd3e6ef,
      metalness: 0,
      roughness: 0.16,
      transmission: 0.45,
      thickness: 0.006,
      ior: 1.5,
      transparent: true,
      opacity: 0.92,
      envMapIntensity: 2.4,
      side: THREE.DoubleSide,
    });
    return this.#glassMat;
  }

  #spawnShards(t: Transform, inherited: Vec3, excessJ: number, impactAt: Vec3): void {
    const kick = Math.min(3, 0.5 + Math.sqrt(Math.max(0, excessJ)) * 0.2);
    const frags = this.#assetCache?.glassFrags;
    if (frags && frags.length > 0) {
      this.#burstFragments(frags, TARGET_SPEC['wine-glass'].massKg, t, inherited, {
        kickMps: kick,
        loftFrac: 0.45,
        spin: 6,
        material: 'steel',
        linearDamping: 0.4,
        angularDamping: 1,
        pinnedR: null,
        pulped: null,
      });
      // Ten rigid shards can't show heavy-overkill fragmentation; a glitter cloud can.
      if (excessJ > 100) this.#ctx.fx.particles(impactAt, glintSpec(excessJ));
      return;
    }
    // No-asset fallback (load failure, headless tests): the procedural wedges.
    const at = t.p;
    const pw = this.#ctx.physics;
    const mat = this.#shardMat ?? this.#glassMaterial();
    const mkShard = (
      geo: THREE.BufferGeometry,
      local: Vec3,
      half: Vec3,
      massKg: number,
      az: number,
    ): void => {
      const body = pw.addCompound({
        kind: 'dynamic',
        at: { x: at.x + local.x, y: at.y + local.y, z: at.z + local.z },
        parts: [{ shape: { kind: 'box', halfExtents: half }, material: 'steel', massKg }],
        // A centimetre-thin body at 2.5 m/s crosses its own thickness per step —
        // 12 shards tunnelled the stage and fell to y −1300 (measured, 2026-08-25).
        ccd: true,
      });
      pw.setVelocity(
        body,
        {
          x: inherited.x + Math.cos(az) * kick,
          y: inherited.y + 0.6 * kick,
          z: inherited.z + Math.sin(az) * kick,
        },
        { x: Math.sin(az) * 6, y: 0, z: Math.cos(az) * 6 },
      );
      this.#shards.push(body);
      const mesh = new THREE.Mesh(geo, mat);
      this.#group.add(mesh);
      this.#props.add(body, mesh);
    };
    // 8 bowl wedges, 2 stem halves, 2 foot halves — 12, per the 03 §4 recipe.
    for (let i = 0; i < 8; i++) {
      const az = (i / 8) * Math.PI * 2;
      const geo = new THREE.SphereGeometry(
        0.034 * GS,
        5,
        6,
        az,
        Math.PI / 4,
        Math.PI * 0.42,
        Math.PI * 0.5,
      );
      this.#disposables.push(geo);
      mkShard(
        geo,
        {
          x: Math.cos(az + Math.PI / 8) * 0.03,
          y: 0.095 * GS,
          z: Math.sin(az + Math.PI / 8) * 0.03,
        },
        { x: 0.013 * GS, y: 0.014 * GS, z: 0.013 * GS },
        0.008,
        az + Math.PI / 8,
      );
    }
    for (let i = 0; i < 2; i++) {
      const az = i * Math.PI;
      const geo = new THREE.CylinderGeometry(
        0.004 * GS,
        0.005 * GS,
        0.02 * GS,
        8,
        1,
        false,
        az,
        Math.PI,
      );
      this.#disposables.push(geo);
      mkShard(
        geo,
        { x: 0, y: 0.02 + i * 0.014, z: 0 },
        { x: 0.005, y: 0.011, z: 0.005 },
        0.012,
        az,
      );
    }
    for (let i = 0; i < 2; i++) {
      const az = i * Math.PI + Math.PI / 2;
      const geo = new THREE.CylinderGeometry(
        0.024 * GS,
        0.028 * GS,
        0.006 * GS,
        10,
        1,
        false,
        az,
        Math.PI,
      );
      this.#disposables.push(geo);
      mkShard(
        geo,
        { x: 0, y: 0.004 * GS, z: 0 },
        { x: 0.02 * GS, y: 0.004 * GS, z: 0.02 * GS },
        0.018,
        az,
      );
    }
    void impactAt;
  }

  /**
   * The span rig: two born-fixed cinder blocks with the target laid across them.
   * Shared by every spanning target, and BORN at their poses like every other fixed
   * body here (the 2026-08-25 engine truth).
   */
  #deploySupports(): void {
    const pw = this.#ctx.physics;
    for (const [i, sx] of [-SPAN_X, SPAN_X].entries()) {
      const id = (SUPPORT_ID_BASE + i) as EntityId;
      const at = { x: sx, y: config.drop.plate.topYM + BLOCK_H / 2, z: 0 };
      const body = pw.addCompound({
        kind: 'fixed',
        at,
        parts: [
          {
            // Laid with its LENGTH across the span, so the board gets a wide bearing.
            shape: {
              kind: 'box',
              halfExtents: { x: BLOCK_D / 2, y: BLOCK_H / 2, z: BLOCK_L / 2 },
            },
            material: 'concrete',
          },
        ],
        entityId: id,
      });
      this.#bodies.push(body);
      const g = new THREE.Group();
      g.position.set(sx, config.drop.plate.topYM, 0);
      g.rotation.y = Math.PI / 2;
      this.#supports.push({ id, body, kind: 'block', at, visual: g });
      this.#group.add(g);
      const gen = this.#gen;
      void loadCrushAssets()
        .then((a) => {
          if (gen !== this.#gen || !this.#deployed) return;
          this.#assetCache = a;
          g.add(a.block.clone());
        })
        .catch(() => {
          /* the collider still holds the board up; a missing skin beats a broken deploy */
        });
    }
  }

  /** A 4 mm pane laid across the same two blocks (18 §6 C3). */
  #deployPane(): void {
    this.#deployed = true;
    this.#gen++;
    this.#deploySupports();
    const pw = this.#ctx.physics;
    const y = config.drop.plate.topYM + BLOCK_H + PANE_T / 2;
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: PANE_X / 2, y: PANE_T / 2, z: PANE_Z / 2 } },
          material: 'glass',
          massKg: TARGET_SPEC['glass-pane'].massKg,
        },
      ],
      entityId: GLASS_ID,
      ccd: true,
    });
    this.#bodies.push(this.#glass);
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(PANE_X, PANE_T, PANE_Z);
    this.#disposables.push(geo);
    const mesh = new THREE.Mesh(geo, this.#paneMaterial());
    mesh.castShadow = true;
    group.add(mesh);
    this.#group.add(group);
    this.#glassVisual = group;
    this.#props.add(this.#glass, group);
  }

  #paneMaterial(): THREE.MeshPhysicalMaterial {
    // Frosted rather than clear, for the reason the goblet is: near-pure transmission
    // renders invisible against the grey stage at env 0.18 (screenshot review, C1).
    this.#paneMat ??= new THREE.MeshPhysicalMaterial({
      color: 0xd6e8f0,
      metalness: 0,
      roughness: 0.1,
      transmission: 0.5,
      thickness: 0.004,
      ior: 1.52,
      transparent: true,
      opacity: 0.72,
      envMapIntensity: 2.2,
      side: THREE.DoubleSide,
    });
    return this.#paneMat;
  }

  /**
   * The pane is PUNCHED THROUGH (18 §6 C3). This is the first target that fails to
   * stop the cube at all: annealed glass gives at a hard point, the cube carries on
   * to the plate, and what is left behind is a spiderweb around a cube-sized hole.
   *
   * So the break is an ANNULUS, not a fan: the plug directly under the cube is gone
   * — pulverised to the glitter cloud, which is both what happens to it and what
   * keeps a shard from being born inside the descending cube (the egg's lesson).
   * Around the hole, radial cracks run out to the edges of the sheet; the wedges over
   * the gap fall through it and the ones still resting on a block stay perched until
   * they topple. Nothing is thrown: gravity does all of it.
   */
  #shatterPane(t: Transform, inherited: Vec3, excessJ: number, hitAt: Vec3): void {
    const pw = this.#ctx.physics;
    const q = new THREE.Quaternion(t.q.x, t.q.y, t.q.z, t.q.w);
    const local = new THREE.Vector3(hitAt.x - t.p.x, 0, hitAt.z - t.p.z).applyQuaternion(
      q.clone().invert(),
    );
    const HX = PANE_X / 2;
    const HZ = PANE_Z / 2;
    const px = Math.max(-HX * 0.9, Math.min(HX * 0.9, local.x));
    const pz = Math.max(-HZ * 0.9, Math.min(HZ * 0.9, local.z));
    const over = Math.max(0, excessJ);

    /** Deterministic per-seed hash — replay's no-dice law, with real irregularity. */
    const hash = (a: number, b: number): number => {
      const h = Math.sin(a * 127.1 + b * 311.7 + px * 74.7 + pz * 269.5) * 43758.5453;
      return h - Math.floor(h);
    };

    /*
     * VORONOI, seeded on the strike — not a polar grid.
     *
     * The first cut tessellated the sheet into even sectors and even rings, which is
     * a DIAGRAM of a spiderweb rather than a spiderweb: perfectly symmetric, smoothly
     * graded, and it read as "uniformly spreading out" (user, 2026-08-26 — and they
     * were right). Real annealed glass branches and merges chaotically and comes
     * apart into large irregular shards of wildly varying size; the tidy web in
     * photographs is usually a FRAMED pane that cracked and stayed put, or laminated
     * glass held by its interlayer. A 4 mm sheet on two blocks with a cube through it
     * does not stay to display a pattern.
     *
     * Seeds cluster on the impact by a power law, so pieces come out small where the
     * cube went through and large at the rim WITHOUT being graded into rings, and
     * every cell is convex by construction — which is exactly what a hull collider
     * wants.
     */
    const seedCount = Math.min(26, 9 + Math.round(Math.sqrt(over) * 0.9));
    const seeds: THREE.Vector2[] = [];
    for (let i = 0; i < seedCount; i++) {
      const ang = hash(i, 1) * Math.PI * 2;
      // r ~ u^1.9: dense at the strike, sparse at the edges, no ring structure.
      const reach = Math.max(HX, HZ) * 1.15;
      const r = Math.pow(hash(i, 2), 1.9) * reach;
      seeds.push(
        new THREE.Vector2(
          Math.max(-HX * 0.995, Math.min(HX * 0.995, px + Math.cos(ang) * r)),
          Math.max(-HZ * 0.995, Math.min(HZ * 0.995, pz + Math.sin(ang) * r)),
        ),
      );
    }

    /** Clip a convex polygon by the half-plane nearer to `a` than to `b`. */
    const clip = (poly: THREE.Vector2[], a: THREE.Vector2, b: THREE.Vector2): THREE.Vector2[] => {
      const nx = b.x - a.x;
      const nz = b.y - a.y;
      const mx = (a.x + b.x) / 2;
      const mz = (a.y + b.y) / 2;
      const side = (p: THREE.Vector2): number => (p.x - mx) * nx + (p.y - mz) * nz;
      const out: THREE.Vector2[] = [];
      for (let i = 0; i < poly.length; i++) {
        const p0 = poly[i]!;
        const p1 = poly[(i + 1) % poly.length]!;
        const s0 = side(p0);
        const s1 = side(p1);
        if (s0 <= 0) out.push(p0);
        if ((s0 <= 0 && s1 > 0) || (s0 > 0 && s1 <= 0)) {
          const tt = s0 / (s0 - s1);
          out.push(new THREE.Vector2(p0.x + (p1.x - p0.x) * tt, p0.y + (p1.y - p0.y) * tt));
        }
      }
      return out;
    };

    // Whatever punched through is gone: cells whose seed sits under the impactor are
    // pulverised rather than spawned, which is both what happens to them and what
    // keeps a shard from being born inside the descending cube.
    let holeR = 0.045;
    for (const e of this.#ctx.entities.all) {
      const dx = e.curr.p.x - hitAt.x;
      const dz = e.curr.p.z - hitAt.z;
      if (Math.hypot(dx, dz) < e.spec.sideM) holeR = Math.max(holeR, e.spec.sideM * 0.6);
    }

    const pieces: { pts: THREE.Vector2[]; area: number; cx: number; cz: number }[] = [];
    let areaSum = 0;
    for (const [i, seed] of seeds.entries()) {
      if (Math.hypot(seed.x - px, seed.y - pz) < holeR) continue;
      let poly: THREE.Vector2[] = [
        new THREE.Vector2(-HX, -HZ),
        new THREE.Vector2(HX, -HZ),
        new THREE.Vector2(HX, HZ),
        new THREE.Vector2(-HX, HZ),
      ];
      for (const [j, other] of seeds.entries()) {
        if (i === j) continue;
        poly = clip(poly, seed, other);
        if (poly.length < 3) break;
      }
      if (poly.length < 3) continue;
      let area = 0;
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < poly.length; k++) {
        const p0 = poly[k]!;
        const p1 = poly[(k + 1) % poly.length]!;
        area += p0.x * p1.y - p1.x * p0.y;
        cx += p0.x;
        cz += p0.y;
      }
      area = Math.abs(area) / 2;
      if (area < 3e-5) continue;
      pieces.push({ pts: poly, area, cx: cx / poly.length, cz: cz / poly.length });
      areaSum += area;
    }
    if (areaSum <= 0) return;

    for (const [i, piece] of pieces.entries()) {
      const shape = new THREE.Shape(
        piece.pts.map((p) => new THREE.Vector2(p.x - piece.cx, p.y - piece.cz)),
      );
      const geo = new THREE.ExtrudeGeometry(shape, { depth: PANE_T, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, PANE_T / 2, 0);
      this.#disposables.push(geo);
      const mesh = new THREE.Mesh(geo, this.#paneMaterial());
      mesh.castShadow = true;
      const wrap = new THREE.Group();
      wrap.add(mesh);

      const pos = geo.getAttribute('position');
      const hull: number[] = [];
      for (let k = 0; k < pos.count; k++) hull.push(pos.getX(k), pos.getY(k), pos.getZ(k));
      const off = new THREE.Vector3(piece.cx, 0, piece.cz).applyQuaternion(q);
      const body = pw.addCompound({
        kind: 'dynamic',
        at: { x: t.p.x + off.x, y: t.p.y + off.y, z: t.p.z + off.z },
        parts: [
          {
            shape: { kind: 'convexHull', points: hull },
            material: 'glass',
            massKg: Math.max(0.002, (TARGET_SPEC['glass-pane'].massKg * piece.area) / areaSum),
          },
        ],
        ccd: true,
        linearDamping: 0.3,
        angularDamping: 1,
      });
      /*
       * Gravity does most of it. The push is small, RAGGED (hashed per piece) and
       * biased outward rather than radially uniform — a sheet dropping out of its own
       * plane, not a firework. Uniform radial ejection was the other half of what
       * read as "weirdly perfect".
       */
      const r = Math.hypot(piece.cx - px, piece.cz - pz) || 1;
      const base = Math.min(2.2, 0.05 + 0.1 * Math.sqrt(over));
      const kick = base * (0.25 + hash(i, 7) * 1.5);
      pw.setVelocity(
        body,
        {
          x: inherited.x + ((piece.cx - px) / r) * kick,
          y: inherited.y,
          z: inherited.z + ((piece.cz - pz) / r) * kick,
        },
        {
          x: (hash(i, 8) - 0.5) * 6,
          y: (hash(i, 9) - 0.5) * 6,
          z: (hash(i, 10) - 0.5) * 6,
        },
      );
      this.#shards.push(body);
      this.#group.add(wrap);
      this.#props.add(body, wrap);
    }
    // The pulverised plug: the glass the cube actually went through.
    this.#ctx.fx.particles(
      { x: hitAt.x, y: config.drop.plate.topYM + BLOCK_H + PANE_T, z: hitAt.z },
      glintSpec(Math.max(20, excessJ)),
    );
  }

  /** The karate setup (18 §6 C3): a pine board bridging two blocks. */
  #deployBoard(): void {
    this.#deployed = true;
    this.#gen++;
    this.#deploySupports();
    const pw = this.#ctx.physics;
    const y = config.drop.plate.topYM + BLOCK_H + BOARD_T / 2;
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: BOARD_X / 2, y: BOARD_T / 2, z: BOARD_Z / 2 } },
          material: 'oak',
          massKg: TARGET_SPEC['pine-board'].massKg,
        },
      ],
      entityId: GLASS_ID,
      ccd: true,
    });
    this.#bodies.push(this.#glass);
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(BOARD_X, BOARD_T, BOARD_Z);
    this.#disposables.push(geo);
    const mesh = new THREE.Mesh(geo, this.#pineMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.#group.add(group);
    this.#glassVisual = group;
    this.#props.add(this.#glass, group);
  }

  #pineMaterial(): THREE.MeshStandardMaterial {
    this.#pineMat ??= (() => {
      const maps = pineBoard();
      const m = new THREE.MeshStandardMaterial({
        color: maps ? 0xffffff : 0xc9a877,
        roughness: 0.85,
        metalness: 0,
      });
      if (maps) {
        m.map = maps.map;
        if (maps.roughnessMap) m.roughnessMap = maps.roughnessMap;
        this.#disposables.push(maps.map);
        if (maps.roughnessMap) this.#disposables.push(maps.roughnessMap);
      }
      return m;
    })();
    return this.#pineMat;
  }

  /**
   * The board SNAPS (18 §6 C3). This is the only target in the set that fails by
   * BENDING, and the mounting is the mechanism: the cube loads an unsupported middle,
   * tension on the underside beats the fibre, and the board hinges apart at midspan.
   * So the break is two HALVES — not a fragment cloud — each rotating down into the
   * gap it was bridging, with splinters along the fracture line and the loudest voice
   * in the set. Nothing flies: the halves pivot off their blocks and drop.
   */
  #snapBoard(t: Transform, inherited: Vec3, excessJ: number, hitAt: Vec3): void {
    const pw = this.#ctx.physics;
    const q = new THREE.Quaternion(t.q.x, t.q.y, t.q.z, t.q.w);
    // A board splits ACROSS the grain, on the line through the strike — so where the
    // cube lands decides which half is the big one, exactly as it does in life.
    const local = new THREE.Vector3(hitAt.x - t.p.x, 0, hitAt.z - t.p.z).applyQuaternion(
      q.clone().invert(),
    );
    const cut = Math.max(-BOARD_X * 0.3, Math.min(BOARD_X * 0.3, local.x));
    /*
     * How many pieces (user, 2026-08-26: "would the board shatter multiple times
     * with enough force?").
     *
     * At moderate overkill: ONE break, two halves. That is right, and it stays right
     * on a second hit too — once it has snapped, each half is a free piece resting on
     * a block rather than a beam spanning a gap, so it gets crushed rather than bent
     * to failure.
     *
     * But a monster cube does not break it repeatedly, it breaks it in MORE PLACES AT
     * ONCE: a 15" cube is wider than the 30 cm board, so it never loads a point at
     * midspan — it comes down across the whole board with both supports resisting, and
     * a board loaded like that fails at several lines simultaneously and splinters.
     * So the count grows with the overkill, and the extra cuts fall either side of the
     * strike where the bending moment is highest.
     */
    const over = Math.max(0, excessJ);
    const extra = Math.min(3, Math.floor(over / 400));
    const cuts = [cut];
    for (let i = 1; i <= extra; i++) {
      const spanFrac = 0.16 + 0.1 * i;
      const side = i % 2 === 0 ? 1 : -1;
      const c = cut + side * BOARD_X * spanFrac;
      if (Math.abs(c) < BOARD_X * 0.46) cuts.push(c);
    }
    cuts.sort((a, b) => a - b);
    const halves: { xMin: number; xMax: number }[] = [];
    let prev = -BOARD_X / 2;
    for (const c of cuts) {
      halves.push({ xMin: prev, xMax: c });
      prev = c;
    }
    halves.push({ xMin: prev, xMax: BOARD_X / 2 });
    // Hinge, not launch: the pieces rotate down about the blocks they were resting on.
    const spin = Math.min(9, 2.5 + 0.5 * Math.sqrt(Math.max(0, excessJ)));
    for (const h of halves) {
      const len = h.xMax - h.xMin;
      if (len < 0.02) continue;
      const cx = (h.xMin + h.xMax) / 2;
      const off = new THREE.Vector3(cx, 0, 0).applyQuaternion(q);
      const body = pw.addCompound({
        kind: 'dynamic',
        at: { x: t.p.x + off.x, y: t.p.y + off.y, z: t.p.z + off.z },
        parts: [
          {
            shape: { kind: 'box', halfExtents: { x: len / 2, y: BOARD_T / 2, z: BOARD_Z / 2 } },
            material: 'oak',
            massKg: (TARGET_SPEC['pine-board'].massKg * len) / BOARD_X,
          },
        ],
        ccd: true,
        linearDamping: 0.4,
        angularDamping: 0.8,
      });
      const dir = Math.sign(cx) || 1;
      /*
       * The halves CLATTER OFF the blocks — they do not tuck neatly into the gap.
       * The first cut pushed them apart at 0.25 m/s and they settled down inside the
       * span, where the blocks hide the whole payoff (screenshot review — the same
       * legibility trap that killed the tile). A real break throws the halves clear:
       * the inner ends drop, the outer ends kick up, and the pieces land beside the
       * rig where you can see what you did.
       */
      /*
       * A hard enough hit THROWS the halves — they do not always settle beside the
       * rig (user, 2026-08-26: "wouldn't the board and glass pane have the potential
       * to fly off somewhere?"). The cap used to sit at 2.6 m/s purely as insurance
       * against the melon audit's vanishing-debris bug; wreckage is RECOVERED at the
       * world boundary now, so energy is free to matter again. Gentle breaks are
       * unchanged — only the top end opens up.
       */
      const out = Math.min(4.5, 0.9 + 0.16 * Math.sqrt(Math.max(0, excessJ)));
      pw.setVelocity(
        body,
        { x: inherited.x + dir * out, y: inherited.y + 0.35 * out, z: inherited.z },
        // Rotating about the board's long axis: the inner end drops as it goes.
        { x: 0, y: 0, z: -dir * spin },
      );
      this.#shards.push(body);
      const geo = new THREE.BoxGeometry(len, BOARD_T, BOARD_Z);
      this.#disposables.push(geo);
      const mesh = new THREE.Mesh(geo, this.#pineMaterial());
      mesh.castShadow = true;
      const wrap = new THREE.Group();
      wrap.add(mesh);
      this.#group.add(wrap);
      this.#props.add(body, wrap);
    }
    // Splinters along the fracture line — pale torn fibre, thrown up and out.
    this.#ctx.fx.particles(
      { x: t.p.x + cut, y: config.drop.plate.topYM + BLOCK_H + BOARD_T, z: hitAt.z },
      {
        count: Math.min(46, 16 + Math.round(excessJ * 0.12)),
        lifeS: 0.9,
        color: [0.74, 0.6, 0.4],
        vMin: 0.5,
        vMax: 2.4,
        up: 0.6,
      },
    );
  }

  /**
   * The egg (18 §6 C2): the target that teaches the lesson without a drop at all.
   * A capsule collider — an egg rolls, and a cylinder would not.
   */
  #deployEgg(): void {
    this.#deployed = true;
    const pw = this.#ctx.physics;
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 0.02 + EGG_H / 2, z: 0 },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: EGG_H / 2 - EGG_R * 0.5, radiusM: EGG_R },
          material: 'oak',
          massKg: TARGET_SPEC.egg.massKg,
        },
      ],
      entityId: GLASS_ID,
      ccd: true,
      // 60 g on steel: without damping the shell skitters at the lightest touch.
      linearDamping: 0.6,
      angularDamping: 1.5,
    });
    this.#bodies.push(this.#glass);
    const group = new THREE.Group();
    this.#group.add(group);
    this.#glassVisual = group;
    this.#props.add(this.#glass, group);
    const gen = ++this.#gen;
    void loadCrushAssets()
      .then((a) => {
        if (gen !== this.#gen || !this.#deployed || !this.#glassVisual) return;
        this.#assetCache = a;
        a.egg.position.y = -EGG_H / 2; // asset base sits at the body's bottom face
        this.#glassVisual.add(a.egg);
      })
      .catch(() => {
        /* collider still works */
      });
  }

  /**
   * A break costs the striker the target's threshold, and no more.
   *
   * A target resting on FIXED structure is a rigid sandwich for the step in which it
   * is hit: the blocks stop the cube THROUGH the board, so by the time the swap runs
   * a one-tonne cube has already been brought to rest by a 0.9 kg plank, and it then
   * settles onto the blocks at 0.22 m/s (measured, 2026-08-26). Nothing downstream
   * can be right after that — punch-through is fake, and structure never sees the
   * hit it should.
   *
   * So at the swap the striker is given back the speed it should still have:
   * v' = sqrt(v² − 2·E_break/m). Breaking a 50 J board costs a 28 kJ cube 0.2% of
   * its speed, which is the honest answer, and it is what lets the same cube go on
   * to demolish what the board was standing on.
   */
  #carryStrikerThrough(): void {
    const striker = this.#pendingStriker;
    this.#pendingStriker = null;
    if (striker === null || this.#selected === 'none') return;
    const e = this.#ctx.entities.get(striker.id);
    if (!e) return;
    const costJ = TARGET_SPEC[this.#selected].thresholdJ;
    const after = Math.sqrt(
      Math.max(0, striker.vHit * striker.vHit - (2 * costJ) / Math.max(0.001, striker.massKg)),
    );
    const v: Vec3 = { x: 0, y: 0, z: 0 };
    this.#ctx.physics.readVelocityInto(e.body, v);
    // Only the closing (downward) component is restored; sideways motion is its own.
    this.#ctx.physics.setVelocity(e.body, { x: v.x, y: Math.min(v.y, -after), z: v.z });
  }

  /** Watch one impact for a hit on structure, and queue its collapse. */
  #checkSupport(ev: ImpactEvent, massOf: (id: EntityId) => number | null): void {
    if (this.#pendingSupport !== null) return;
    for (const sup of this.#supports) {
      let arrivalJ: number | null = null;
      if (ev.b === sup.id && typeof ev.a === 'number') {
        const m = massOf(ev.a);
        if (m !== null) arrivalJ = 0.5 * m * ev.normalSpeedMps * ev.normalSpeedMps;
      } else if (ev.a === sup.id && typeof ev.b === 'number') {
        const m = massOf(ev.b);
        if (m !== null) arrivalJ = 0.5 * m * ev.normalSpeedMps * ev.normalSpeedMps;
      }
      if (arrivalJ === null) continue;
      const spec = SUPPORT_SPEC[sup.kind];
      if (arrivalJ < spec.thresholdJ) continue;
      this.#pendingSupport = { id: sup.id, excessJ: arrivalJ - spec.thresholdJ };
      return;
    }
  }

  /**
   * Structure collapses (18 §6 C3). Concrete and stone do not fly: the block bursts
   * where it stood and the pieces drop, so the kick is small and the damping high.
   * Whatever was resting on it loses its support in the same step — a board left
   * bridging one block falls, which is exactly what should happen.
   */
  #collapseSupport(): void {
    const pending = this.#pendingSupport;
    this.#pendingSupport = null;
    if (pending === null) return;
    const i = this.#supports.findIndex((s) => s.id === pending.id);
    if (i < 0) return;
    const sup = this.#supports[i]!;
    this.#supports.splice(i, 1);
    const pw = this.#ctx.physics;
    const t = pw.transformOf(sup.body);
    this.#removeBody(sup.body);
    this.#bodies = this.#bodies.filter((b) => b !== sup.body);
    this.#group.remove(sup.visual);
    const spec = SUPPORT_SPEC[sup.kind];
    const frags = this.#assetCache ? spec.frags(this.#assetCache) : [];
    if (frags.length === 0) {
      // No-asset fallback (load failure, headless): six lumps of rubble, so the
      // physical outcome is the same even when the fractured mesh is unavailable.
      const half = sup.kind === 'block' ? 0.07 : 0.05;
      for (let i = 0; i < 6; i++) {
        const az = (i / 6) * Math.PI * 2 + 0.3;
        const body = pw.addCompound({
          kind: 'dynamic',
          at: {
            x: t.p.x + Math.cos(az) * half,
            y: t.p.y - BLOCK_H * 0.25 + (i % 2) * half,
            z: t.p.z + Math.sin(az) * half,
          },
          parts: [
            {
              shape: { kind: 'box', halfExtents: { x: half, y: half, z: half } },
              material: 'concrete',
              massKg: spec.massKg / 6,
            },
          ],
          ccd: true,
          linearDamping: 1.4,
          angularDamping: 2.5,
        });
        this.#shards.push(body);
      }
    }
    if (frags.length > 0) {
      this.#burstFragments(
        frags,
        spec.massKg,
        t,
        { x: 0, y: 0, z: 0 },
        {
          kickMps: Math.min(2.2, 0.3 + 0.09 * Math.sqrt(Math.max(0, pending.excessJ))),
          loftFrac: 0.15,
          spin: 2,
          material: 'concrete',
          linearDamping: 1.4,
          angularDamping: 2.5,
          pinnedR: null,
          pulped: null,
        },
      );
    }
    this.#ctx.fx.play('crack_concrete', 1);
    this.#ctx.fx.particles(
      { x: t.p.x, y: t.p.y, z: t.p.z },
      {
        count: Math.min(60, 24 + Math.round(pending.excessJ * 0.02)),
        lifeS: 1.1,
        color: [0.62, 0.6, 0.56],
        vMin: 0.4,
        vMax: 2,
        up: 0.75,
      },
    );
  }

  /**
   * The SUSTAINED-FORCE trigger (18 §5.2, 02 §7). Everything else here breaks on
   * arrival energy, which cannot express the egg's real lesson: 0.05 J is a 5 mm
   * drop, so any cube you actually place on one breaks it — slowly, by weight, with
   * no impact anywhere in the story. Rest ~4.6 kg on the shell and it gives.
   *
   * Read on the fixed step, not from the impact stream, and held for a dwell: a
   * bounce spikes the same force for one step and is not a squeeze.
   */
  #tickSustained(): void {
    if (this.#selected === 'none' || this.#broken || this.#glass === null) return;
    const limitN = TARGET_SPEC[this.#selected].sustainedN;
    if (limitN === undefined) return;
    const n = this.#ctx.physics.maxContactForceAlongN(this.#glass, { x: 0, y: 1, z: 0 });
    this.#sustainedSteps = n >= limitN ? this.#sustainedSteps + 1 : 0;
    if (this.#sustainedSteps < EGG_DWELL_STEPS) return;
    // Break where it stands: a quasi-static crush has no impact point to borrow.
    const t = this.#ctx.physics.transformOf(this.#glass);
    this.#pendingBreakAt = { ...t.p };
    this.#pendingKickJ = 0;
    this.#broken = true;
    this.#wasHit = true;
  }

  /** A true 355 ml empty on the plate (18 §6 C2) — the cheapest recipe in the set. */
  #deployCan(): void {
    this.#deployed = true;
    this.#canState = 'intact';
    this.#canMorphGoal = [0, 0];
    const pw = this.#ctx.physics;
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 0.02 + CAN_H / 2, z: 0 },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: CAN_H / 2, radiusM: CAN_R },
          material: 'steel',
          massKg: TARGET_SPEC['soda-can'].massKg,
        },
      ],
      entityId: GLASS_ID,
      // 15 g: a heavy cube punts it across the stage — it must not tunnel mid-flight.
      ccd: true,
    });
    this.#bodies.push(this.#glass);
    const group = new THREE.Group();
    this.#group.add(group);
    this.#glassVisual = group;
    this.#props.add(this.#glass, group);
    const gen = ++this.#gen;
    void loadCrushAssets()
      .then((a) => {
        if (gen !== this.#gen || !this.#deployed || !this.#glassVisual) return;
        this.#assetCache = a;
        const holder = new THREE.Group();
        a.can.position.y = -CAN_H / 2; // asset base sits at the body's bottom face
        holder.add(a.can);
        this.#canHolder = holder;
        this.#canMorphMeshes = [];
        a.can.traverse((o) => {
          if (o instanceof THREE.Mesh && o.morphTargetInfluences) this.#canMorphMeshes.push(o);
        });
        this.#glassVisual.add(holder);
      })
      .catch(() => {
        /* collider still works */
      });
  }

  /**
   * The can's state machine (02 §7: 1 J dents, ≥ 5 J flattens): swap the COLLIDER
   * to the state's height while the morph targets animate the mesh through the
   * crush — no pop, no shards. Bodies are born axis-aligned, so a toppled can's
   * pose rides on the PART rotation and the visual holder's quaternion.
   */
  #swapCanBody(stage: 'dent' | 'flat', hitAt: Vec3 | null, excessJ: number): void {
    if (this.#glass === null) return;
    const pw = this.#ctx.physics;
    const t = pw.transformOf(this.#glass);
    const v: Vec3 = { x: 0, y: 0, z: 0 };
    pw.readVelocityInto(this.#glass, v);
    const prevH = this.#canState === 'dent' ? CAN_DENT_H : CAN_H;
    const nextH = stage === 'dent' ? CAN_DENT_H : CAN_FLAT_H;
    const nextR = stage === 'dent' ? CAN_R : CAN_FLAT_R;
    // Upright cans crush toward the plate (the base stays put); toppled keep centre.
    const upright = 1 - 2 * (t.q.x * t.q.x + t.q.z * t.q.z) > 0.9;
    const y = upright ? t.p.y - prevH / 2 + nextH / 2 : t.p.y;
    /*
     * The buckle finishes in ~5 ms — under one step — and its fold displaces the
     * wreck's centroid sideways as it crushes. At step scale the descending cube
     * would close the trap before any authored velocity clears its footprint, so
     * the swap is BORN displaced along the escape line; under a striker wider
     * than the shift, depenetration pushes the same way and finishes the job.
     */
    const dxe = hitAt ? t.p.x - hitAt.x : 0;
    const dze = hitAt ? t.p.z - hitAt.z : 0;
    const re = Math.hypot(dxe, dze);
    const seedE = (excessJ * 7.13) % (Math.PI * 2);
    const ex = re > 0.004 ? dxe / re : Math.cos(seedE);
    const ez = re > 0.004 ? dze / re : Math.sin(seedE);
    const escapeM = 0.045;
    const old = this.#glass;
    this.#removeBody(old);
    this.#bodies = this.#bodies.filter((b) => b !== old);
    if (this.#glassVisual) {
      this.#group.remove(this.#glassVisual);
      this.#glassVisual = null;
    }
    const body = pw.addCompound({
      kind: 'dynamic',
      at: { x: t.p.x + ex * escapeM, y, z: t.p.z + ez * escapeM },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: nextH / 2, radiusM: nextR },
          rotation: t.q,
          material: 'steel',
          massKg: TARGET_SPEC['soda-can'].massKg,
        },
      ],
      ...(stage === 'dent' ? { entityId: GLASS_ID } : {}),
      ccd: true,
      /*
       * Damped so the skitter dies ON the stage. The first tuning let a 4″ cube's
       * 370 J eject the wreck at the 5.5 m/s cap with only 0.8 damping — stop
       * distance ~7 m off a 3 m slab, so the can sailed past the kill plane and
       * the prop cull deleted it ("it literally disappeared", user 2026-08-25).
       * A crushed can SHOULD fly a couple of metres; it must not leave the world.
       */
      linearDamping: stage === 'dent' ? 1.6 : 2.2,
      angularDamping: 1.2,
    });
    /*
     * The KICK-OUT (user, 2026-08-25: "wouldn't it be knocked around or flipped?
     * it's literally fixed in one position"). A real crush is never symmetric:
     * the Yoshimura buckle starts on one side and the folding interface becomes
     * a ramp that squirts the can out from under the striker, spinning. A rigid
     * cylinder pinned under a flat face has no escape the solver can find, so
     * the ejection is authored — away from the hit point, faster for harder
     * hits, tumbling; dead-centre hits break symmetry deterministically from the
     * drop's own energy (no dice in the sim).
     */
    const dxk = hitAt ? t.p.x - hitAt.x : 0;
    const dzk = hitAt ? t.p.z - hitAt.z : 0;
    const rk = Math.hypot(dxk, dzk);
    const seed = (excessJ * 7.13) % (Math.PI * 2);
    const ux = rk > 0.004 ? dxk / rk : Math.cos(seed);
    const uz = rk > 0.004 ? dzk / rk : Math.sin(seed);
    const vOut =
      stage === 'dent'
        ? Math.min(2.6, 2 + 0.8 * Math.sqrt(Math.max(0, excessJ)))
        : Math.min(3.2, 2.2 + 0.35 * Math.sqrt(Math.max(0, excessJ)));
    const spin = vOut * 9;
    pw.setVelocity(
      body,
      // Low loft: a crushed can skids, it does not get punted like a football.
      { x: v.x + ux * vOut, y: v.y + 0.2 * vOut, z: v.z + uz * vOut },
      { x: -uz * spin * 0.7, y: spin * 0.4, z: ux * spin * 0.7 },
    );
    const wrap = new THREE.Group();
    if (this.#canHolder) {
      this.#canHolder.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
      const asset = this.#canHolder.children[0];
      if (asset) asset.position.y = -nextH / 2;
      wrap.add(this.#canHolder);
    }
    this.#group.add(wrap);
    this.#props.add(body, wrap);
    this.#canMorphGoal = stage === 'dent' ? [1, 0] : [0, 1];
    this.#canState = stage;
    if (stage === 'dent') {
      this.#glass = body;
      this.#bodies.push(body);
      this.#glassVisual = wrap;
    } else {
      this.#glass = null;
      this.#shards.push(body);
    }
  }

  /** The hero on the plate (18 §6 C2): an 8 kg melon, no pedestal — it IS the show. */
  #deployMelon(): void {
    this.#deployed = true;
    const pw = this.#ctx.physics;
    // The FULL melon's own bbox: 0.32 × 0.32 × 0.42 m. The first cut sized this
    // collider from the source's union bbox — the halves laid out beside the full
    // inflated it, and a 12 cm melon hid behind a 42 cm box (caught 2026-08-25).
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: 0.02 + 0.16, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: 0.16, y: 0.16, z: 0.21 } },
          material: 'oak',
          massKg: TARGET_SPEC.watermelon.massKg,
        },
      ],
      entityId: GLASS_ID,
    });
    this.#bodies.push(this.#glass);
    const group = new THREE.Group();
    this.#group.add(group);
    this.#glassVisual = group;
    this.#props.add(this.#glass, group);
    const gen = ++this.#gen;
    void loadCrushAssets()
      .then((a) => {
        if (gen !== this.#gen || !this.#deployed || !this.#glassVisual) return;
        this.#assetCache = a;
        a.melonFull.position.y = -0.16; // asset base sits at the body's bottom face
        this.#glassVisual.add(a.melonFull);
      })
      .catch(() => {
        /* collider still works */
      });
  }

  /**
   * The egg gives way (user review, 2026-08-25: "that is not how eggs crack and
   * shatter in real life"). The first cut re-used the melon's recipe — Voronoi cells
   * of a SOLID body thrown outward — and an egg is nothing like that:
   *
   *   - it is a 0.35 mm brittle SHELL around a liquid, so its pieces are thin CURVED
   *     PLATES, never wedges;
   *   - the failure starts under the load and the cracks run along the shell, so it
   *     CAVES IN where it was pressed rather than flying apart;
   *   - the inner membrane holds the pieces near each other — they slump into the
   *     mess, they do not scatter;
   *   - and the show is the CONTENTS: a spreading pool of white with the yolk sitting
   *     in the middle of it, which is what "a broken egg" actually looks like.
   *
   * So: five thin caps of the real shell material laid down where the egg stood, at
   * a slump rather than a kick, carrying only the shell's ~5 g of the 60; the other
   * 55 g leaves as the pool — a wide pale white, a golden yolk core inside it, and a
   * few satellites. Only a real impact throws anything, and only a little.
   */
  #burstEgg(t: Transform, inherited: Vec3, excessJ: number, hitAt: Vec3): void {
    const pw = this.#ctx.physics;
    const skin = this.#eggShellMaterial();
    // A drop scatters the shell a little; a resting cube scatters it not at all.
    const slump = Math.min(0.9, 0.1 + 1.6 * Math.sqrt(Math.max(0, excessJ)));
    const CAPS = 5;
    /*
     * Everything comes out from UNDER the crusher. A 3" cube is wider than the whole
     * egg, so shell born at the egg's own radius spawns INSIDE it and the solver
     * flicks the pieces up onto its top face — which is exactly what the first cut
     * did (screenshot review, 2026-08-25). Measure whatever is sitting on the egg and
     * lay the shell and the pool down just clear of it, which is also where they
     * would really squirt.
     */
    let crusherHalf = 0;
    for (const e of this.#ctx.entities.all) {
      const dx = e.curr.p.x - t.p.x;
      const dz = e.curr.p.z - t.p.z;
      const half = e.spec.sideM / 2;
      if (Math.hypot(dx, dz) < half + EGG_R && e.curr.p.y > t.p.y - EGG_H) {
        crusherHalf = Math.max(crusherHalf, half);
      }
    }
    const ring = Math.max(EGG_R * 0.8, crusherHalf + EGG_R * 0.6);
    for (let i = 0; i < CAPS; i++) {
      const az = (i / CAPS) * Math.PI * 2 + 0.4;
      const tall = i === CAPS - 1; // one piece is the blunt end, the rest are sides
      const geo = new THREE.SphereGeometry(
        EGG_R,
        6,
        4,
        az,
        (Math.PI * 2) / CAPS,
        tall ? 0 : Math.PI * 0.28,
        tall ? Math.PI * 0.32 : Math.PI * 0.5,
      );
      this.#disposables.push(geo);
      const mesh = new THREE.Mesh(geo, skin);
      mesh.castShadow = true;
      const wrap = new THREE.Group();
      wrap.add(mesh);
      const body = pw.addCompound({
        kind: 'dynamic',
        at: {
          x: t.p.x + Math.cos(az) * ring,
          // On the plate, not inside the wreck: these pieces have already fallen.
          y: config.drop.plate.topYM + 0.004,
          z: t.p.z + Math.sin(az) * ring,
        },
        parts: [
          {
            // A PLATE, not a lump: 1 mm thick, so it lies flat in the puddle.
            shape: { kind: 'box', halfExtents: { x: EGG_R * 0.55, y: 0.001, z: EGG_R * 0.55 } },
            material: 'pulp',
            // The shell is ~8% of an egg; the rest of the mass leaves as liquid.
            massKg: (TARGET_SPEC.egg.massKg * 0.08) / CAPS,
          },
        ],
        ccd: true,
        linearDamping: 3,
        angularDamping: 4,
      });
      pw.setVelocity(
        body,
        {
          x: inherited.x + Math.cos(az) * slump,
          y: inherited.y,
          z: inherited.z + Math.sin(az) * slump,
        },
        { x: Math.sin(az) * 2, y: 0, z: Math.cos(az) * 2 },
      );
      this.#shards.push(body);
      this.#group.add(wrap);
      this.#props.add(body, wrap);
    }
    /*
     * The contents. White first and widest, yolk inside it — that layering IS the
     * read: a yolk alone looks like paint, and white alone looks like water.
     */
    const WHITE = 0xd8cfae;
    const YOLK = 0xe8991a;
    const spread = 0.06 + ring * 0.5 + Math.min(0.05, excessJ * 0.4);
    const py = config.drop.plate.topYM;
    // Pooled around the crusher's edge, not beneath it — under a cube nobody sees it.
    for (let i = 0; i < 3; i++) {
      const az = i * 2.399963 + 1.1;
      const r = ring * 0.9;
      this.#ctx.fx.decals.splat(
        { x: hitAt.x + Math.cos(az) * r, y: py, z: hitAt.z + Math.sin(az) * r },
        spread * (i === 0 ? 1 : 0.6),
        WHITE,
      );
    }
    // The yolk sits in the white, off to one side, the way a broken yolk lands.
    const yaz = 1.1;
    this.#ctx.fx.decals.splat(
      { x: hitAt.x + Math.cos(yaz) * ring, y: py, z: hitAt.z + Math.sin(yaz) * ring },
      spread * 0.4,
      YOLK,
    );
  }

  /** The shell's own material, taken off the real model so the pieces match it. */
  #eggShellMaterial(): THREE.Material {
    this.#eggMat ??= (() => {
      let found: THREE.Material | null = null;
      this.#assetCache?.egg.traverse((o) => {
        if (!found && o instanceof THREE.Mesh) found = o.material as THREE.Material;
      });
      return (
        found ??
        new THREE.MeshStandardMaterial({ color: 0xe8d3b4, roughness: 0.7, side: THREE.DoubleSide })
      );
    })();
    return this.#eggMat;
  }

  /**
   * The burst, second cut (user, 2026-08-25: "we would not see 2 halves, then a
   * bunch of extra pieces that didn't exist before… irregular shapes and chunks…
   * some pieces maintaining the original watermelon skin"): the pre-fractured
   * pieces of the ACTUAL melon fly apart — they partition it, no bonus matter —
   * juice splats stamp the plate, and the wet voice fires.
   */
  #burstMelon(t: Transform, inherited: Vec3, excessJ: number, hitAt: Vec3): void {
    const frags = this.#assetCache?.melonFrags;
    if (frags && frags.length > 0) {
      /*
       * Squeeze-flow regimes (realism audit, 2026-08-25). Just-over-threshold, a
       * melon CRACKS: sections sag apart where it stood and the cube nests in the
       * crater — √20 J of excess is ~0.5 m/s here. Far over, the flesh must escape
       * SIDEWAYS as the cube-plate gap closes, so pieces spray fast and FLAT; the
       * cap plus wet damping keeps even a monster hit inside the stage.
       */
      const kick = Math.min(6, 0.12 * Math.sqrt(Math.max(0, excessJ)));
      /*
       * Pulverization: past ~200 J the pieces nearest the impact axis stop
       * existing as chunks — they are the juice. Their mass leaves as the spray
       * cloud and the splat pool, which is what actually happens to the flesh in
       * the cube's path — and it is WHY the cube ends up on the plate in a wet
       * pancake instead of perched on wreckage.
       */
      const pulped = new Set<number>();
      if (excessJ > 200) {
        const n = Math.min(4, Math.floor(excessJ / 300));
        frags
          .map((f, i) => ({ i, r: Math.hypot(f.offset.x, f.offset.z) }))
          .sort((a, b) => a.r - b.r)
          .slice(0, n)
          .forEach((c) => pulped.add(c.i));
      }
      this.#burstFragments(frags, TARGET_SPEC.watermelon.massKg, t, inherited, {
        kickMps: kick,
        loftFrac: 0.25,
        spin: 3,
        material: 'pulp',
        linearDamping: 2.5,
        angularDamping: 3,
        pinnedR: 0.08,
        pulped,
      });
      this.#ctx.fx.particles(
        { x: hitAt.x, y: Math.max(0.06, hitAt.y), z: hitAt.z },
        juiceSpec(excessJ),
      );
    } else {
      // No-asset fallback (load failure, headless boot): ten rough chunks.
      const kick = Math.min(6, 0.12 * Math.sqrt(Math.max(0, excessJ)));
      const pw = this.#ctx.physics;
      const at = t.p;
      for (let i = 0; i < 10; i++) {
        const az = (i / 10) * Math.PI * 2 + 0.4;
        const r = 0.05 + (i % 3) * 0.015;
        const body = pw.addCompound({
          kind: 'dynamic',
          at: { x: at.x + Math.cos(az) * 0.1, y: at.y + 0.04, z: at.z + Math.sin(az) * 0.1 },
          parts: [
            {
              shape: { kind: 'box', halfExtents: { x: r, y: r, z: r } },
              material: 'pulp',
              massKg: TARGET_SPEC.watermelon.massKg / 10,
            },
          ],
          ccd: true,
          linearDamping: 2.5,
          angularDamping: 3,
        });
        pw.setVelocity(
          body,
          {
            x: inherited.x + Math.cos(az) * kick,
            y: inherited.y + 0.25 * kick,
            z: inherited.z + Math.sin(az) * kick,
          },
          { x: Math.sin(az) * 3, y: 1, z: Math.cos(az) * 3 },
        );
        this.#shards.push(body);
        const geo = new THREE.IcosahedronGeometry(r * 1.15, 0);
        this.#disposables.push(geo);
        const mesh = new THREE.Mesh(geo, this.#rindOrFlesh());
        mesh.castShadow = true;
        const wrap = new THREE.Group();
        wrap.add(mesh);
        this.#group.add(wrap);
        this.#props.add(body, wrap);
      }
    }
    // The mess scales with the violence: pool under the burst, satellites farther
    // and more numerous the harder the hit (audit: 3 fixed decals at every energy).
    this.#ctx.fx.decals.splat(
      { x: hitAt.x, y: 0.02, z: hitAt.z },
      0.28 + Math.min(0.45, excessJ / 2500),
    );
    const sats = 2 + Math.min(6, Math.floor(excessJ / 180));
    for (let i = 0; i < sats; i++) {
      const az = i * 2.399963 + 0.7;
      const r = 0.2 + 0.45 * ((i + 1) / sats) * Math.min(1, excessJ / 800);
      this.#ctx.fx.decals.splat(
        { x: hitAt.x + Math.cos(az) * r, y: 0.02, z: hitAt.z + Math.sin(az) * r },
        0.09 + 0.05 * ((i * 7) % 3),
      );
    }
  }

  /**
   * Spawn the pre-fractured pieces of the intact body (tools/fracture-targets.mjs).
   * Each piece is born where it stood inside the body — offsets rotate with the
   * target, so a toppled glass breaks along its toppled pose — as its own CONVEX
   * HULL (cells partition the body: hulls spawn touching, never penetrating, and a
   * wedge RESTS like a wedge), with mass shared by volume, inherited motion, and
   * the profile's kick. Golden-angle tumble keeps the scatter deterministic
   * (replay's law: no dice in the sim).
   */
  #burstFragments(
    frags: readonly FragChunk[],
    totalKg: number,
    t: Transform,
    inherited: Vec3,
    prof: BurstProfile,
  ): void {
    const pw = this.#ctx.physics;
    const rot = new THREE.Quaternion(t.q.x, t.q.y, t.q.z, t.q.w);
    let volSum = 0;
    frags.forEach((f, i) => {
      if (!prof.pulped?.has(i)) volSum += f.half.x * f.half.y * f.half.z;
    });
    if (volSum <= 0) return;
    frags.forEach((f, i) => {
      if (prof.pulped?.has(i)) return; // that piece is the juice now
      const off = new THREE.Vector3(f.offset.x, f.offset.y, f.offset.z).applyQuaternion(rot);
      const az = i * 2.399963;
      const r = Math.hypot(off.x, off.z);
      const dirX = r > 0.01 ? off.x / r : Math.cos(az);
      const dirZ = r > 0.01 ? off.z / r : Math.sin(az);
      // Pinned = the crater material the impactor drove into: it sags, never flies.
      const pinned = prof.pinnedR !== null && Math.hypot(f.offset.x, f.offset.z) < prof.pinnedR;
      const kick = pinned ? prof.kickMps * 0.1 : prof.kickMps;
      const spin = pinned ? prof.spin * 0.3 : prof.spin;
      const body = pw.addCompound({
        kind: 'dynamic',
        at: { x: t.p.x + off.x, y: t.p.y + off.y, z: t.p.z + off.z },
        parts: [
          {
            shape: { kind: 'convexHull', points: f.points },
            material: prof.material,
            massKg: (totalKg * (f.half.x * f.half.y * f.half.z)) / volSum,
          },
        ],
        // Thin pieces at burst speed cross their own thickness per step (2026-08-25).
        ccd: true,
        linearDamping: prof.linearDamping,
        angularDamping: prof.angularDamping,
      });
      pw.setVelocity(
        body,
        {
          x: inherited.x + dirX * kick,
          y: inherited.y + prof.loftFrac * kick,
          z: inherited.z + dirZ * kick,
        },
        { x: Math.sin(az) * spin, y: Math.cos(az * 2) * spin * 0.5, z: Math.cos(az) * spin },
      );
      this.#shards.push(body);
      // The clone carries its authoring translation; the wrap follows the BODY.
      const visual = f.visual;
      visual.position.set(0, 0, 0);
      const wrap = new THREE.Group();
      wrap.add(visual);
      this.#group.add(wrap);
      this.#props.add(body, wrap);
    });
  }

  #flesh(): THREE.MeshStandardMaterial {
    this.#fleshMat ??= new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.75 });
    return this.#fleshMat;
  }

  #rindOrFlesh(): THREE.MeshStandardMaterial {
    this.#rindMat ??= new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 0.6 });
    // A minority of fallback chunks read as rind-backed; the rest are flesh.
    return this.#shards.length % 4 === 0 ? this.#rindMat : this.#flesh();
  }

  #removeBody(b: BodyHandle): void {
    const bound = this.#props;
    bound.remove(b);
    this.#ctx.physics.remove(b);
  }
}
