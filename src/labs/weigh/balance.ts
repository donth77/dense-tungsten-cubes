import * as THREE from 'three';
import { config } from '../../config.ts';
import { PropStore } from '../../core/props.ts';
import { BalanceSignal } from './balance-signal.ts';
import type { BalanceState } from './balance-signal.ts';
import { loadBalanceAsset } from './asset.ts';
import type { LabContext } from '../lab.ts';
import type { Entity } from '../../core/entities.ts';
import type { BodyHandle, ColliderPart, JointHandle, Vec3 } from '../../types.ts';

/**
 * The equal-arm balance (15 §6).
 *
 * A dynamic beam on a passive revolute joint with two rope-hung pans. **Nothing drives it
 * toward level.** Gravity supplies the restoring moment — the beam/yoke's centre of mass
 * sits below the pivot because its keel is built there — and the pivot torque only ever
 * removes energy. A motor quietly pulling the beam to zero would look completely correct
 * and would falsify the one thing the instrument is for, so there is no motor path here
 * to accidentally enable (15 §6.2).
 *
 * Every parameter comes from `config.weigh.balance`, which the W0 spike measured rather
 * than estimated.
 */

const B = config.weigh.balance;
const DEG = Math.PI / 180;

/** Bar cross-section. Thin enough to read as a beam, thick enough to be a stable collider. */
const BAR_HALF = 0.008;
/** Clearance between the top of the stand column and the underside of the beam. */
const BEARING_GAP = 0.002;
const KEEL_HALF = 0.012;

export class BalanceInstrument {
  readonly signal = new BalanceSignal();
  readonly #props: PropStore;
  readonly #group = new THREE.Group();
  readonly #bodies: BodyHandle[] = [];
  readonly #joints: JointHandle[] = [];
  readonly #disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  #stand!: BodyHandle;
  #beam!: BodyHandle;
  #pans!: [BodyHandle, BodyHandle];
  #state: BalanceState;
  #alive = true;
  #usingAsset = false;
  /** Placeholder meshes, so a swap can free them the moment the real asset lands. */
  readonly #placeholders = new Set<THREE.Object3D>();
  /** body -> the group PropStore drives. Children swap; the group does not. */
  readonly #shells = new Map<BodyHandle, THREE.Group>();

  constructor(private readonly ctx: LabContext) {
    this.#props = new PropStore(ctx.physics);
    this.#state = this.signal.state;
  }

  get state(): Readonly<BalanceState> {
    return this.#state;
  }
  get pivotHeightM(): number {
    return B.pivotHeightM;
  }

  build(): void {
    const { physics } = this.ctx;
    const y = B.pivotHeightM;

    /*
     * The stand is a YOKE — two plates straddling the beam in Z — not a column.
     *
     * A single column on the centreline occupies exactly the volume the keel swings
     * through, and the first version did: the keel spawned inside the stand, the solver
     * pushed them apart, and an EMPTY balance slammed to its stop at 12.4 degrees. The
     * plates sit outside the keel's half-width so the beam's counterweight has somewhere
     * to hang.
     */
    this.#stand = physics.addCompound({
      kind: 'fixed',
      at: { x: 0, y, z: 0 },
      parts: [
        // A column and a base plate, matching the asset's turned pillar. The collider is
        // simplified (15 §1 drives physics from procedural shapes) but it is the same
        // SOLID: a narrow post rising to the pivot, on a wide foot.
        {
          // STOPS SHORT OF THE BEAM. A column running the full pivot height overlaps the
          // beam bar it is supposed to carry, and the solver resolves that penetration by
          // throwing the beam off its zero — an empty balance rested 0.45 degrees out and
          // equal loads 5.8. The bearing gap is 2 mm and invisible next to the asset's
          // own turned bearing.
          shape: { kind: 'cylinder', halfHeightM: columnHalf(), radiusM: B.columnRadiusM },
          material: 'steel',
          at: { x: 0, y: -y + columnHalf(), z: 0 },
        },
        {
          shape: {
            kind: 'cylinder',
            halfHeightM: B.baseThicknessM / 2,
            radiusM: B.baseRadiusM,
          },
          material: 'steel',
          at: { x: 0, y: -y + B.baseThicknessM / 2, z: 0 },
        },
      ],
    });

    // ---- beam: a bar through the pivot, and a keel hung below it ---------------
    // The keel is what makes this a balance rather than a see-saw. Its mass is placed by
    // BUILDING it below the pivot, so the restoring moment is a consequence of the shape
    // the player can see (15 §6.2).
    const barKg = B.beamKg * (1 - B.keelMassFraction);
    const keelKg = B.beamKg * B.keelMassFraction;
    this.#beam = physics.addCompound({
      kind: 'dynamic',
      at: { x: 0, y, z: 0 },
      parts: [
        box(B.armM, BAR_HALF, BAR_HALF, undefined, barKg),
        // The counterweight, SPLIT IN TWO and hung either side of the column.
        //
        // A single bob on the centreline is where a real balance puts it, and here it
        // would be inside the stand: the two bodies overlap, the solver pushes them apart
        // and an EMPTY balance slams to its stop. Two halves straddling the column give
        // the identical centre of mass — which is the only thing the restoring moment
        // depends on — and can actually be drawn.
        box(
          KEEL_HALF,
          KEEL_HALF,
          KEEL_HALF,
          { x: 0, y: -B.keelDropM, z: B.keelOffsetZM },
          keelKg / 2,
        ),
        box(
          KEEL_HALF,
          KEEL_HALF,
          KEEL_HALF,
          { x: 0, y: -B.keelDropM, z: -B.keelOffsetZM },
          keelKg / 2,
        ),
      ],
    });
    // Viscous pivot friction, implicit. See beforePhysics for why it is not a torque.
    physics.setAngularDamping(this.#beam, B.pivotDamping);

    this.#joints.push(
      physics.addRevoluteJoint({
        bodyA: this.#stand,
        bodyB: this.#beam,
        anchorA: { x: 0, y: 0, z: 0 },
        anchorB: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 },
        limitsRad: [-B.limitDeg * DEG, B.limitDeg * DEG],
      }),
    );

    // ---- pans -------------------------------------------------------------------
    const panY = y - B.dropM;
    const mk = (sign: -1 | 1): BodyHandle =>
      physics.addCompound({
        kind: 'dynamic',
        at: { x: sign * B.armM, y: panY, z: 0 },
        parts: [
          // A cylinder, because the asset's pans are round dishes. A square plate under a
          // round dish leaves cubes near the corners resting on nothing you can see.
          {
            shape: { kind: 'cylinder', halfHeightM: B.panThicknessM, radiusM: B.panRadiusM },
            material: 'steel',
            massKg: B.panKg,
          },
          // A low SEGMENTED rim (15 §6.1), so an off-centre cube tilts the pan instead of
          // sliding out — the off-centre case has to come from contact, never metadata.
          ...rim(B.panRadiusM, B.panRimHeightM),
        ],
      });
    this.#pans = [mk(-1), mk(1)];
    for (const pan of this.#pans) {
      // Bridle friction and air drag, so a disturbed pan comes to rest instead of
      // swinging for the rest of the session. Instrument bodies only.
      physics.setLinearDamping(pan, B.panLinearDamping);
      physics.setAngularDamping(pan, B.panAngularDamping);
    }

    /*
     * Six ropes, INTERLEAVED left/right/left/right/left/right.
     *
     * Not cosmetic. Rapier walks constraints in creation order with a finite iteration
     * count, so building one pan's bridle and then the other leaves the first
     * over-extended and the beam resting a full degree off zero under EQUAL loads. W0
     * measured 1.0 degrees before interleaving and 0.07 after.
     */
    const ring = hookRing(B.hookRingM);
    const rimScale = B.panRadiusM / B.hookRingM;
    /*
     * ROPE LENGTH IS THE SLANT, NOT THE DROP.
     *
     * The bridle splays: each rope runs from a 2 cm hook ring on the beam out to an 11 cm
     * pan rim, over a 27 cm drop. Using the drop as the length makes every one of the six
     * ropes about 11 mm too short, so the pan hangs permanently strained — and a balance
     * whose suspension is fighting itself thrashes. Measured with the drop as the length:
     * one 1 kg cube sent the beam oscillating between -2 and +9 degrees until it threw the
     * cube on the floor, and pivot damping across a 10x range changed nothing, because
     * damping was never the problem.
     */
    const splay = B.hookRingM * Math.abs(1 - rimScale);
    const ropeLength = Math.hypot(splay, B.dropM - B.panThicknessM);
    for (const [ax, az] of ring) {
      for (const side of [0, 1] as const) {
        const sign = side === 0 ? -1 : 1;
        this.#joints.push(
          physics.addRopeJoint({
            bodyA: this.#beam,
            bodyB: this.#pans[side],
            anchorA: { x: sign * (B.armM + ax), y: 0, z: az },
            anchorB: { x: sign * ax * rimScale, y: B.panThicknessM, z: az * rimScale },
            maxLengthM: ropeLength,
          }),
        );
      }
    }

    this.#bodies.push(this.#stand, this.#beam, this.#pans[0], this.#pans[1]);
    this.#buildVisuals();
    this.ctx.scene.add(this.#group);
  }

  /**
   * Pre-solver.
   *
   * The pivot friction is NOT applied here as a torque, and that is a correction. 15 §6.1
   * writes it as `tau = -c*w`, and a hand-applied version of that needs `c*dt/I < 2` or it
   * amplifies — so it has to be clamped, and the clamp needs the beam's moment of inertia
   * about Z. Rapier reports PRINCIPAL moments, in an order this code cannot verify maps to
   * world axes, so the clamp was sized by a number that might not be the right one. It
   * showed: pivot damping swept across a 10x range changed the outcome not at all.
   *
   * `setAngularDamping` is the same viscous law integrated implicitly by the solver, which
   * is unconditionally stable and needs no inertia at all. Set once at build.
   *
   * Nothing else belongs here. There is no motor and no angle spring: if the beam finds
   * level, gravity took it there (15 §6.2).
   */
  beforePhysics(): void {
    // Intentionally empty: the pivot friction is implicit (set at build) and there is no
    // motor. Kept so the instrument still satisfies the pre-step half of the contract and
    // has an obvious home if it ever needs one.
    return;
  }

  afterPhysics(dt: number): void {
    this.#props.capture();
    const { physics } = this.ctx;
    const q = physics.transformOf(this.#beam).q;
    // Rotation is about Z only, so the half-angle comes straight off (z, w).
    const angleRad = 2 * Math.atan2(q.z, q.w);

    const loads = this.#panLoads();
    this.#state = this.signal.update(
      {
        angleRad,
        angularSpeedRadS: physics.angularVelocityOf(this.#beam).z,
        leftPanSpeedRadS: speed(physics.angularVelocityOf(this.#pans[0])),
        rightPanSpeedRadS: speed(physics.angularVelocityOf(this.#pans[1])),
        leftLoadKg: loads[0].kg,
        rightLoadKg: loads[1].kg,
        anyGrabbed: loads[0].grabbed || loads[1].grabbed,
      },
      dt,
    );
  }

  render(alpha: number): void {
    this.#props.interpolate(alpha);
    this.#updateChains();
  }

  /** What is sitting in each pan. A HINT for the panel — never the source of the sign. */
  #panLoads(): [PanLoad, PanLoad] {
    const out: [PanLoad, PanLoad] = [
      { kg: 0, count: 0, grabbed: false },
      { kg: 0, count: 0, grabbed: false },
    ];
    for (const side of [0, 1] as const) {
      const pan = this.ctx.physics.transformOf(this.#pans[side]).p;
      for (const e of this.ctx.entities.all) {
        if (!overPan(e, pan)) continue;
        out[side].kg += e.massKg;
        out[side].count++;
        if (e.heldBy !== null) out[side].grabbed = true;
      }
    }
    return out;
  }

  // ---- visuals -----------------------------------------------------------------

  #chains: THREE.LineSegments | null = null;

  #buildVisuals(): void {
    const steel = new THREE.MeshStandardMaterial({
      color: 0x8b9199,
      metalness: 0.9,
      roughness: 0.35,
    });
    this.#disposables.push(steel);

    /*
     * Every body is bound to a GROUP, never straight to a mesh. The group is what the
     * PropStore drives; its children are swappable. That is what lets the prepared asset
     * replace the placeholder shape later without the beam losing its counterweight
     * meshes, which are ours and belong on screen either way.
     */
    const add = (geo: THREE.BufferGeometry, body: BodyHandle): THREE.Group => {
      this.#disposables.push(geo);
      const mesh = new THREE.Mesh(geo, steel);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.#placeholders.add(mesh);
      const group = new THREE.Group();
      group.add(mesh);
      this.#group.add(group);
      this.#props.add(body, group);
      this.#shells.set(body, group);
      return group;
    };

    // Placeholder geometry that MATCHES THE COLLIDERS exactly. The prepared GLB replaces
    // these meshes and nothing else — 15 §1 drives the physics from procedural colliders
    // either way, so the asset swap cannot change how the instrument behaves.
    add(standShape(), this.#stand);
    const beamGroup = add(beamShape(), this.#beam);
    add(panShape(), this.#pans[0]);
    add(panShape(), this.#pans[1]);

    // The counterweight, drawn where it actually is. Without these the restoring moment
    // comes from mass nobody can see, and 15 §8.2 asks for mass behaviour that agrees
    // with visible construction.
    for (const z of [B.keelOffsetZM, -B.keelOffsetZM]) {
      const geo = new THREE.BoxGeometry(KEEL_HALF * 2, KEEL_HALF * 2, KEEL_HALF * 2);
      this.#disposables.push(geo);
      const bob = new THREE.Mesh(geo, steel);
      bob.castShadow = true;
      bob.position.set(0, -B.keelDropM, z);
      beamGroup.add(bob);
    }

    void this.#loadAsset();

    const chainMat = new THREE.LineBasicMaterial({ color: 0x6a7078 });
    this.#disposables.push(chainMat);
    const chainGeo = new THREE.BufferGeometry();
    chainGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Array(6 * 2 * 3).fill(0), 3),
    );
    this.#disposables.push(chainGeo);
    this.#chains = new THREE.LineSegments(chainGeo, chainMat);
    this.#chains.frustumCulled = false;
    this.#group.add(this.#chains);
  }

  /**
   * Redraws the six chain runs between their live anchor points.
   *
   * Read from the INTERPOLATED prop transforms, not from physics: drawn from the
   * fixed-step pose the chains would detach from the pans they are attached to on every
   * frame that falls between two steps.
   */
  #updateChains(): void {
    if (!this.#chains) return;
    const beamObj = this.#props.objectOf(this.#beam);
    const panObjs = [this.#props.objectOf(this.#pans[0]), this.#props.objectOf(this.#pans[1])];
    if (!beamObj || !panObjs[0] || !panObjs[1]) return;

    const pos = this.#chains.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ring = hookRing(B.hookRingM);
    const rimScale = B.panRadiusM / B.hookRingM;
    const v = new THREE.Vector3();
    let i = 0;
    for (const [ax, az] of ring) {
      for (const side of [0, 1] as const) {
        const sign = side === 0 ? -1 : 1;
        v.set(sign * (B.armM + ax), 0, az).applyMatrix4(beamObj.matrixWorld);
        pos.setXYZ(i++, v.x, v.y, v.z);
        v.set(sign * ax * rimScale, B.panThicknessM, az * rimScale).applyMatrix4(
          panObjs[side]!.matrixWorld,
        );
        pos.setXYZ(i++, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
  }

  /**
   * Swaps the placeholder boxes for the prepared GLB once it arrives.
   *
   * The instrument is fully working before this resolves — physics, readings and all —
   * so a slow or failed asset load costs appearance and nothing else. `#alive` is the
   * guard that matters: a load resolving after teardown must not attach meshes to a
   * scene the lab has already left.
   */
  async #loadAsset(): Promise<void> {
    try {
      const asset = await loadBalanceAsset();
      if (!this.#alive) return;
      const bind: [BodyHandle, THREE.Object3D][] = [
        [this.#stand, asset.parts.stand],
        [this.#beam, asset.parts.beam],
        [this.#pans[0], asset.parts.leftPan],
        [this.#pans[1], asset.parts.rightPan],
      ];
      for (const [body, source] of bind) {
        const shell = this.#shells.get(body);
        if (!shell) continue;
        // Drop only the placeholder child; anything else on the group — the beam's two
        // counterweight bobs — stays exactly where it is.
        for (const child of [...shell.children]) {
          if (!this.#placeholders.has(child)) continue;
          shell.remove(child);
          this.#placeholders.delete(child);
          if (child instanceof THREE.Mesh) {
            const geo = child.geometry as THREE.BufferGeometry;
            const at = this.#disposables.indexOf(geo);
            if (at >= 0) this.#disposables.splice(at, 1);
            geo.dispose();
          }
        }
        // Cloned, because the cache is shared with every future mount of this lab.
        shell.add(source.clone(true));
      }
      this.#usingAsset = true;
    } catch (err) {
      // Deliberately not fatal, and deliberately loud in dev.
      console.warn('[weigh] balance asset unavailable; keeping placeholder shapes', err);
    }
  }

  /** Whether the prepared asset is what is on screen. Read by the smoke tests. */
  get usingAsset(): boolean {
    return this.#usingAsset;
  }

  teardown(): void {
    this.#alive = false;
    for (const j of this.#joints) this.ctx.physics.removeJoint(j);
    for (const b of this.#bodies) this.ctx.physics.remove(b);
    this.#joints.length = 0;
    this.#bodies.length = 0;
    this.#props.clear();
    this.#shells.clear();
    this.#placeholders.clear();
    this.ctx.scene.remove(this.#group);
    this.#group.clear();
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
    this.#chains = null;
  }
}

interface PanLoad {
  kg: number;
  count: number;
  grabbed: boolean;
}

// ---- geometry helpers ------------------------------------------------------------

function box(hx: number, hy: number, hz: number, at?: Vec3, massKg?: number): ColliderPart {
  return {
    shape: { kind: 'box', halfExtents: { x: hx, y: hy, z: hz } },
    material: 'steel',
    ...(at ? { at } : {}),
    ...(massKg !== undefined ? { massKg } : {}),
  };
}

/** Eight short walls around the dish's edge — a polygon standing in for a round lip. */
function rim(radius: number, height: number): ColliderPart[] {
  const segments = 8;
  const t = 0.003;
  const chord = radius * Math.tan(Math.PI / segments);
  const out: ColliderPart[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const half = a / 2;
    out.push({
      shape: { kind: 'box', halfExtents: { x: t, y: height, z: chord } },
      material: 'steel',
      at: { x: Math.cos(a) * radius, y: height, z: Math.sin(a) * radius },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    });
  }
  return out;
}

/**
 * Three anchor points forming a small triangle, NOT one shared point: three ropes from a
 * single point constrain distance only, leaving the pan free to spin about it. The bridle
 * would be singular and the pan would never hold an attitude (15 §6.1).
 */
function hookRing(r: number): [number, number][] {
  return [
    [r, 0],
    [-r / 2, r * 0.866],
    [-r / 2, -r * 0.866],
  ];
}

function speed(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Is this cube sitting in the pan whose centre is at `pan`? Footprint plus a tall band. */
function overPan(e: Entity, pan: Vec3): boolean {
  const dx = e.curr.p.x - pan.x;
  const dz = e.curr.p.z - pan.z;
  const reach = B.panRadiusM + e.spec.sideM / 2;
  if (dx * dx + dz * dz > reach * reach) return false;
  const dy = e.curr.p.y - pan.y;
  // Generous upward band so a stack still counts; a little slack below for penetration.
  return dy > -0.02 && dy < 0.5;
}

/** Half-height of the column, stopping just under the beam it carries. */
function columnHalf(): number {
  return (B.pivotHeightM - BAR_HALF - BEARING_GAP) / 2;
}

/** Placeholder stand: the same column and foot the colliders use. */
function standShape(): THREE.BufferGeometry {
  const y = B.pivotHeightM;
  const col = new THREE.CylinderGeometry(B.columnRadiusM, B.columnRadiusM, columnHalf() * 2, 12);
  col.translate(0, -y + columnHalf(), 0);
  const base = new THREE.CylinderGeometry(B.baseRadiusM, B.baseRadiusM, B.baseThicknessM, 16);
  base.translate(0, -y + B.baseThicknessM / 2, 0);
  return mergeBoxes([col, base]);
}

/** Concatenates a few box geometries into one buffer — no BufferGeometryUtils import. */
function mergeBoxes(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const norm: number[] = [];
  for (const g of geos) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const idx = g.getIndex();
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i++) {
      const v = idx ? idx.getX(i) : i;
      pos.push(p.getX(v), p.getY(v), p.getZ(v));
      norm.push(n.getX(v), n.getY(v), n.getZ(v));
    }
    g.dispose();
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  return out;
}

function beamShape(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(B.armM * 2, BAR_HALF * 2, BAR_HALF * 2);
}

function panShape(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(B.panRadiusM * 2, B.panThicknessM * 2, B.panRadiusM * 2);
}
