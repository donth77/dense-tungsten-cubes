import * as THREE from 'three';
import { PropStore } from '../../core/props.ts';
import { loadCrushAssets } from './asset.ts';
import type { LabContext } from '../lab.ts';
import { PROP_ID_BASE } from '../../types.ts';
import type { BodyHandle, EntityId, ImpactEvent, Vec3 } from '../../types.ts';

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

export type TargetId = 'none' | 'wine-glass';
export const TARGET_IDS: readonly TargetId[] = ['none', 'wine-glass'];
export const TARGET_LABELS: Readonly<Record<TargetId, string>> = {
  none: 'None',
  'wine-glass': 'Wine glass',
};

const GLASS_ID: EntityId = PROP_ID_BASE + 1;

/** 02 §7: wine glass ≈ 1 J — an arrival-energy anchor, ≈-labelled in the panel. */
export const GLASS_THRESHOLD_J = 1;
const GLASS_KG = 0.15;

/** The real plinth (assets-lib/pedestal, baked 0.173×): 22.8 cm tall. */
export const PEDESTAL_TOP_M = 0.228;
/** Foot + stem + bowl, toy-scaled. */
/** The real glass (assets-lib/wine-glass) is 19.5 cm, base-origined, real scale. */
const GLASS_H = 0.195;
/** Shard wedges stay procedural until the Blender fracture lands; sized to match. */
const GS = 1.45;
export const TARGET_TOP_M = PEDESTAL_TOP_M + GLASS_H;

export class TargetRig {
  readonly #ctx: LabContext;
  readonly #props: PropStore;
  readonly #group = new THREE.Group();
  readonly #disposables: { dispose(): void }[] = [];
  #glassMat: THREE.MeshPhysicalMaterial | null = null;
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
    if (!this.#deployed || this.#broken || this.#glass === null) return null;
    let result: 'broke' | 'hit' | null = null;
    for (const ev of events) {
      let arrivalJ: number | null = null;
      if (ev.b === GLASS_ID && typeof ev.a === 'number') {
        const m = massOf(ev.a);
        if (m !== null) arrivalJ = 0.5 * m * ev.normalSpeedMps * ev.normalSpeedMps;
      } else if (ev.a === GLASS_ID) {
        arrivalJ = 0.5 * GLASS_KG * ev.normalSpeedMps * ev.normalSpeedMps;
      }
      if (arrivalJ === null) continue;
      this.#wasHit = true;
      result = result ?? 'hit';
      if (arrivalJ >= GLASS_THRESHOLD_J) {
        this.#pendingBreakAt = { ...ev.point };
        this.#pendingKickJ = arrivalJ - GLASS_THRESHOLD_J;
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
    this.#spawnShards(t.p, v, this.#pendingKickJ, at);
    this.#ctx.fx.play('tinkle_glass', 0.85);
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
  }

  deploy(): void {
    if (this.#selected !== 'wine-glass' || this.#deployed) return;
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

  #spawnShards(at: Vec3, inherited: Vec3, excessJ: number, impactAt: Vec3): void {
    const pw = this.#ctx.physics;
    const mat = this.#shardMat ?? this.#glassMaterial();
    // Gentle and lofted: at 2.5 m/s on ice-friction colliders the wreckage slid
    // metres off-stage and the aftermath read as a vanishing act (2026-08-25).
    const kick = Math.min(1.3, 0.5 + Math.sqrt(Math.max(0, excessJ)) * 0.2);
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

  #removeBody(b: BodyHandle): void {
    const bound = this.#props;
    bound.remove(b);
    this.#ctx.physics.remove(b);
  }
}
