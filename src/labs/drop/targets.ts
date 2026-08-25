import * as THREE from 'three';
import { PropStore } from '../../core/props.ts';
import { loadCrushAssets } from './asset.ts';
import type { CrushAssets, FragChunk } from './asset.ts';
import { glintSpec, juiceSpec } from '../../fx/particles.ts';
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

export type TargetId = 'none' | 'wine-glass' | 'watermelon';
export const TARGET_IDS: readonly TargetId[] = ['none', 'wine-glass', 'watermelon'];
export const TARGET_LABELS: Readonly<Record<TargetId, string>> = {
  none: 'None',
  'wine-glass': 'Wine glass',
  watermelon: 'Watermelon',
};

/** Per-target facts (18 §6 C2) — thresholds are 02 §7's ≈-anchors. */
interface TargetSpec {
  thresholdJ: number;
  massKg: number;
  verdict: 'shattered' | 'splat';
  pedestal: boolean;
  voice: 'tinkle_glass' | 'splat_melon';
}
export const TARGET_SPEC: Readonly<Record<Exclude<TargetId, 'none'>, TargetSpec>> = {
  'wine-glass': {
    thresholdJ: 1,
    massKg: 0.15,
    verdict: 'shattered',
    pedestal: true,
    voice: 'tinkle_glass',
  },
  watermelon: {
    thresholdJ: 40,
    // The FULL melon mesh composes to 0.32 × 0.32 × 0.42 m — a big market melon,
    // and those run 8-plus kilos (the union-bbox 5 kg guess measured the halves too).
    massKg: 8,
    verdict: 'splat',
    pedestal: false,
    voice: 'splat_melon',
  },
};

const GLASS_ID: EntityId = PROP_ID_BASE + 1;

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

export class TargetRig {
  readonly #ctx: LabContext;
  readonly #props: PropStore;
  readonly #group = new THREE.Group();
  readonly #disposables: { dispose(): void }[] = [];
  #glassMat: THREE.MeshPhysicalMaterial | null = null;
  #fleshMat: THREE.MeshStandardMaterial | null = null;
  #rindMat: THREE.MeshStandardMaterial | null = null;
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

  /** The verdict this target's break earns (18 §5.4). */
  get breakVerdict(): 'shattered' | 'splat' {
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
        arrivalJ = 0.5 * spec.massKg * ev.normalSpeedMps * ev.normalSpeedMps;
      }
      if (arrivalJ === null) continue;
      this.#wasHit = true;
      result = result ?? 'hit';
      if (arrivalJ >= spec.thresholdJ) {
        this.#pendingBreakAt = { ...ev.point };
        this.#pendingKickJ = arrivalJ - spec.thresholdJ;
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
    if (this.#pendingBreakAt === null || this.#glass === null) return;
    const at = this.#pendingBreakAt;
    this.#pendingBreakAt = null;
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
    if (this.#selected === 'watermelon') this.#burstMelon(t, v, this.#pendingKickJ, at);
    else this.#spawnShards(t, v, this.#pendingKickJ, at);
    if (this.#selected !== 'none') this.#ctx.fx.play(TARGET_SPEC[this.#selected].voice, 1);
  }

  afterPhysics(): void {
    // The entity kill-plane sweeps cubes, not props: an escaped shard is ours to cull.
    for (let i = this.#shards.length - 1; i >= 0; i--) {
      const b = this.#shards[i]!;
      if (this.#ctx.physics.transformOf(b).p.y < -1) {
        this.#removeBody(b);
        this.#shards.splice(i, 1);
      }
    }
    this.#props.capture();
  }
  render(alpha: number): void {
    this.#props.interpolate(alpha);
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

  deploy(): void {
    if (this.#selected === 'none' || this.#deployed) return;
    if (this.#selected === 'watermelon') {
      this.#deployMelon();
      return;
    }
    this.#deployed = true;
    const pw = this.#ctx.physics;
    // Pedestal — born fixed at its pose, a steel column with a top plate.
    const pedestal = pw.addCompound({
      kind: 'fixed',
      at: { x: 0, y: PEDESTAL_TOP_M / 2, z: 0 },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: PEDESTAL_TOP_M / 2, radiusM: 0.07 },
          material: 'steel',
        },
      ],
    });
    this.#bodies.push(pedestal);
    const pedGroup = new THREE.Group();
    this.#group.add(pedGroup);

    // The glass — one light dynamic body with impact identity, resting on the cap.
    this.#glass = pw.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: PEDESTAL_TOP_M + 0.001, z: 0 },
      parts: [
        {
          shape: { kind: 'cylinder', halfHeightM: 0.005, radiusM: 0.033 },
          at: { x: 0, y: 0.005, z: 0 },
          material: 'ice',
          massKg: 0.05,
        },
        {
          shape: { kind: 'cylinder', halfHeightM: 0.045, radiusM: 0.006 },
          at: { x: 0, y: 0.055, z: 0 },
          material: 'ice',
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
          material: 'ice',
          massKg: 0.03,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.004, y: 0.045, z: 0.03 } },
          at: { x: 0.032, y: 0.15, z: 0 },
          material: 'ice',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.004, y: 0.045, z: 0.03 } },
          at: { x: -0.032, y: 0.15, z: 0 },
          material: 'ice',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.03, y: 0.045, z: 0.004 } },
          at: { x: 0, y: 0.15, z: 0.032 },
          material: 'ice',
          massKg: 0.01,
        },
        {
          shape: { kind: 'box', halfExtents: { x: 0.03, y: 0.045, z: 0.004 } },
          at: { x: 0, y: 0.15, z: -0.032 },
          material: 'ice',
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
