import * as THREE from 'three';
import { config } from '../../config.ts';
import { PropStore } from '../../core/props.ts';
import { ScaleSignal } from './signal.ts';
import { loadScaleAsset } from './asset.ts';
import { ScaleDisplay } from './display.ts';
import type { ScaleState } from './signal.ts';
import type { LabContext } from '../lab.ts';
import type { Entity } from '../../core/entities.ts';
import type { BodyHandle, ColliderPart, JointHandle, SurfaceId, Vec3 } from '../../types.ts';

/**
 * The digital kitchen scale (15 §7).
 *
 * A dynamic platter on a prismatic joint, supported by a **modelled compliant
 * transducer**: a spring/damper force we compute and apply ourselves each pre-step. That
 * applied force IS the measurement. It is not reconstructed from collision events and not
 * summed from contact impulses, because the whole point is a defined sensing axis and a
 * defined load path — a number the instrument can be held to.
 *
 * That choice is also forced. Rapier 0.19.3's `ImpulseJoint` exposes no impulse or
 * reaction-force read of any kind, so a joint-motor scale could not produce a defensible
 * signal even if we wanted one (measured in W0, against the installed .d.ts).
 *
 * The compliance is larger than a real strain gauge's — millimetres, not microns —
 * because a deflection a 60 Hz rigid-body solver can resolve has to be. That is a
 * documented trade, not an oversight (15 §7.2).
 */

const S = config.weigh.scale;
/** Show the placeholders anyway if the asset has not resolved either way by then. */
const ASSET_REVEAL_TIMEOUT_MS = 3000;

/** Must match `YAW_DEG` in tools/prepare-scale.py — the yaw baked into the asset. */
const ASSET_YAW_RAD = (45 * Math.PI) / 180;

export class ScaleInstrument {
  readonly signal = new ScaleSignal();
  readonly #props: PropStore;
  readonly #group = new THREE.Group();
  readonly #bodies: BodyHandle[] = [];
  readonly #joints: JointHandle[] = [];
  readonly #disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  #housing!: BodyHandle;
  #platter!: BodyHandle;
  /** Spring rate, N/m — derived from rated load over rated travel, never guessed. */
  #k = 0;
  #c = 0;
  #proofN = 0;
  #restY = 0;
  #lastCellForceN = 0;
  #alive = true;
  #usingAsset = false;
  #display: ScaleDisplay | null = null;
  /** Fixed-step seconds since the LCD was repainted — see config.weigh.scale.publishHz. */
  #sincePublish = 0;
  /** body -> the group PropStore drives. Children swap; the group does not. */
  readonly #shells = new Map<BodyHandle, THREE.Group>();
  readonly #placeholders = new Set<THREE.Object3D>();

  /** The player's unit setting. Injected, because labs/ must not reach into ui/. */
  units: () => 'si' | 'imperial' = () => 'si';
  #state: ScaleState;

  constructor(private readonly ctx: LabContext) {
    this.#props = new PropStore(ctx.physics);
    this.#state = this.signal.state;
  }

  get state(): Readonly<ScaleState> {
    return this.#state;
  }
  get platterTopY(): number {
    return this.#restY + S.platterHalfM.y;
  }

  build(): void {
    const { physics } = this.ctx;
    const g = physics.gravityMps2;

    // 15 §7.3: k from rated load and chosen travel; c from the damping ratio about a
    // reference mass of platter + 1 kg. Both derived, so changing the capacity or the
    // travel cannot leave a stale coefficient behind.
    this.#k = ((S.platterKg + S.ratedKg) * g) / S.travelM;
    this.#c = 2 * S.zeta * Math.sqrt(this.#k * (S.platterKg + 1));
    this.#proofN = S.proofFactor * (S.platterKg + S.ratedKg) * g;
    this.#restY = S.platterRestHeightM;

    const h = S.housingHalfM;
    this.#housing = physics.addCompound({
      kind: 'fixed',
      at: { x: 0, y: 0, z: 0 },
      // `steel` rather than a bespoke aluminium entry: the surface table is a fixed set
      // (data/surfaces.ts) and a scale housing behaves like sheet metal for contact
      // purposes. A new surface would need its own measured friction/restitution pair.
      parts: [box(h.x, h.y, h.z, { x: 0, y: h.y, z: 0 }, 'steel')],
    });

    const p = S.platterHalfM;
    this.#platter = physics.addCompound({
      kind: 'dynamic',
      at: { x: 0, y: this.#restY, z: 0 },
      parts: [box(p.x, p.y, p.z, undefined, 'steel', S.platterKg)],
    });

    /*
     * The stops (15 §7.4). The lower one keeps a load from passing through the scale; the
     * upper one only matters when the Hand pulls up and must not preload the empty
     * reading, so it sits a hair above rest rather than at it.
     *
     * Stop travel is 2.0x rated, not the 1.6x first tried: a legitimate 5 kg placement
     * peaks at 12.43 mm of compression against 8 mm of static travel, and a stop at
     * 12.8 mm would have flashed OVERLOAD on a reading the scale is supposed to make.
     */
    this.#joints.push(
      physics.addPrismaticJoint({
        bodyA: this.#housing,
        bodyB: this.#platter,
        anchorA: { x: 0, y: this.#restY, z: 0 },
        anchorB: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 1, z: 0 },
        limitsM: [-S.travelM * S.stopFactor, 0.0005],
      }),
    );

    this.#bodies.push(this.#housing, this.#platter);
    this.#buildVisuals();
    this.ctx.scene.add(this.#group);
  }

  /** Pre-solver: the load cell. `F = k x + c ẋ`, clamped to [0, proof]. */
  beforePhysics(): void {
    const { physics } = this.ctx;
    const y = physics.transformOf(this.#platter).p.y;
    const vy = physics.velocityOf(this.#platter).y;
    const x = this.#restY - y; // compression, positive
    const xdot = -vy;

    /*
     * The damping impulse is capped at what would just bring the platter to rest this
     * step. An explicit -c*v force integrated by symplectic Euler amplifies instead of
     * dissipating once c*dt/m > 2, and a cell stiff enough for millimetre travel is well
     * past that on an empty platter. Clamping makes it unconditionally dissipative — W0
     * measured 88 stable configurations with the clamp against 26 without.
     */
    // Against the mass that is actually moving with the platter: the cell's own last
    // reading is that mass (it carries the platter too), so it is not added to the
    // platter — double-counting lets the damper reverse the platter's velocity, which is
    // the instability the clamp exists to prevent. Clamping against the bare platter
    // instead was twenty times too weak under a 19 kg load and never settled.
    const carriedKg = Math.max(S.platterKg, this.#lastCellForceN / physics.gravityMps2);
    const maxDamp = (Math.abs(vy) * carriedKg) / config.loop.DT;
    const damping = Math.max(-maxDamp, Math.min(maxDamp, this.#c * xdot));
    const force = Math.min(Math.max(this.#k * x + damping, 0), this.#proofN);

    this.#lastCellForceN = force;
    physics.applyForce(this.#platter, { x: 0, y: force, z: 0 });
  }

  afterPhysics(dt: number): void {
    this.#props.capture();
    const { physics } = this.ctx;
    const y = physics.transformOf(this.#platter).p.y;
    const travel = this.#restY - y;
    const load = this.#load();

    this.#state = this.signal.update(
      {
        rawCellForceN: this.#lastCellForceN,
        platterSpeedMps: Math.abs(physics.velocityOf(this.#platter).y),
        platterTravelM: travel,
        loadMotionMps: load.motionMps,
        anyGrabbed: load.grabbed,
        onStop: travel >= S.travelM * S.stopFactor - 0.0002,
        atProof: this.#lastCellForceN >= this.#proofN * 0.999,
        partialSupport: load.partial,
      },
      dt,
    );

    /*
     * AUTO-ZERO, once. The platter weighs 5 kg — a numerical necessity, see
     * config.weigh.scale.platterKg — and an unzeroed scale shows exactly that with nothing
     * on it. 15 §7.6: zero calibrates the empty instrument, only when it is stable and the
     * measurement volume is empty; reset rebuilds the instrument, so it zeroes again. The
     * LCD reads ZEROING… until this has happened.
     */
    if (!this.#state.zeroed && this.signal.isStable && load.count === 0) {
      this.signal.zero(true);
      this.#state = this.signal.state;
    }

    // The DOM does not need 60 updates a second and neither does a texture upload
    // (15 §7.5). Transitions still appear at once, because the painter short-circuits
    // when nothing it would draw has changed.
    this.#sincePublish += dt;
    if (this.#sincePublish >= 1 / S.publishHz) {
      this.#sincePublish = 0;
      this.#display?.update(this.#state, this.units());
    }
  }

  render(alpha: number): void {
    this.#props.interpolate(alpha);
  }

  /** Zero and tare are refused unless the instrument is settled — see ScaleSignal. */
  zero(): boolean {
    return this.signal.zero(this.#load().count === 0);
  }
  tare(): boolean {
    return this.signal.tare();
  }

  /**
   * What is on the platter, and how honestly it is being supported.
   *
   * `partial` is decided by GEOMETRY, never by the force. A cube bridging the platter and
   * the fixed housing genuinely puts less than its weight on the cell, and the reading is
   * correct — but reporting that low number as a mass would be a lie about the cube, so
   * it is the geometry that raises the flag (15 §7.4).
   */
  #load(): { kg: number; count: number; motionMps: number; grabbed: boolean; partial: boolean } {
    const out = { kg: 0, count: 0, motionMps: 0, grabbed: false, partial: false };
    const p = S.platterHalfM;
    const topY = this.platterTopY;
    for (const e of this.ctx.entities.all) {
      const half = e.spec.sideM / 2;
      const dx = Math.abs(e.curr.p.x);
      const dz = Math.abs(e.curr.p.z);
      const overlaps = dx < p.x + half && dz < p.z + half;
      if (!overlaps) continue;
      // Above the platter, with slack below for contact penetration and above for stacks.
      const dy = e.curr.p.y - topY;
      if (dy < -half - 0.01 || dy > 0.5) continue;

      out.kg += e.massKg;
      out.count++;
      if (e.heldBy !== null) out.grabbed = true;
      out.motionMps = Math.max(out.motionMps, cornerSpeed(e));
      // Its CENTRE is off the platter, so something else must be carrying part of it.
      // Mere overhang is not enough — a cube hanging 40 mm over the edge with its centre
      // still on the platter is fully supported, and a 4 in cube that bounced once ended
      // exactly there and was refused a reading.
      if (dx > p.x || dz > p.z) out.partial = true;
    }
    return out;
  }

  #buildVisuals(): void {
    const shell = new THREE.MeshStandardMaterial({
      color: 0x2a2f36,
      metalness: 0.4,
      roughness: 0.55,
    });
    const plate = new THREE.MeshStandardMaterial({
      color: 0xb9bec6,
      metalness: 0.85,
      roughness: 0.25,
    });
    this.#disposables.push(shell, plate);

    const h = S.housingHalfM;
    const housingGeo = new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
    housingGeo.translate(0, h.y, 0);
    const p = S.platterHalfM;
    const platterGeo = new THREE.BoxGeometry(p.x * 2, p.y * 2, p.z * 2);
    this.#disposables.push(housingGeo, platterGeo);

    for (const [geo, mat, body] of [
      [housingGeo, shell, this.#housing],
      [platterGeo, plate, this.#platter],
    ] as const) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Bound to a GROUP so the prepared asset can replace the placeholder child later
      // without the body losing its binding.
      const group = new THREE.Group();
      group.add(mesh);
      this.#placeholders.add(mesh);
      this.#group.add(group);
      // The platter mesh follows the PHYSICAL platter exactly. Compressing the visual
      // less than the collider would leave cubes resting on an uncompressed surface while
      // the scale claims to be squashed (15 §7.2).
      this.#props.add(body, group);
      this.#shells.set(body, group);
    }
    /*
     * Invisible until the asset arrives. The placeholders exist so the instrument works
     * — physics, readings, all of it — before the GLB has loaded, and so something is on
     * screen if it never does. They are not meant to be SEEN in the normal case: on a
     * tab switch or a refresh they showed as a flash of grey collider shapes for the
     * ~100 ms the fetch took, which read as a glitch. The group is revealed by #loadAsset
     * on success, on failure, or after a timeout if the load never settles either way.
     */
    this.#group.visible = false;
    void this.#loadAsset();
    setTimeout(() => {
      if (this.#alive) this.#group.visible = true;
    }, ASSET_REVEAL_TIMEOUT_MS);
  }

  /** Swaps the placeholder boxes for the prepared GLB. Appearance only if it fails. */
  async #loadAsset(): Promise<void> {
    try {
      const asset = await loadScaleAsset();
      if (!this.#alive) return;
      for (const [body, source] of [
        [this.#housing, asset.parts.housing],
        [this.#platter, asset.parts.platter],
      ] as const) {
        const shell = this.#shells.get(body);
        if (!shell) continue;
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
        const part = source.clone(true);
        shell.add(part);
        if (body === this.#housing) this.#attachDisplay(part);
      }
      this.#usingAsset = true;
      this.#group.visible = true;
    } catch (err) {
      console.warn('[weigh] scale asset unavailable; keeping placeholder shapes', err);
      if (this.#alive) this.#group.visible = true;
    }
  }

  /** Whether the prepared asset is what is on screen. */
  get usingAsset(): boolean {
    return this.#usingAsset;
  }

  /**
   * Makes the asset's screen live.
   *
   * A PLANE FITTED OVER THE PANEL, not the panel's own material. Replacing the material
   * is the obvious approach and it puts the readout nowhere: the texture lands wherever
   * the asset's UVs send it, and this model's display UVs are not a tidy 0..1 rectangle.
   * Measuring the panel's bounding box and floating a quad just above it needs nothing
   * from the asset but its geometry, so no unwrapping choice can defeat it. The asset's
   * own dark panel stays underneath and becomes the bezel.
   */
  #attachDisplay(root: THREE.Object3D): void {
    let panel: THREE.Mesh | null = null;
    root.traverse((o) => {
      if (panel || !(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => (m as THREE.Material).name === 'Display')) panel = o;
    });
    if (!panel) {
      console.warn('[weigh] no Display material in scale.glb; readout stays off-screen');
      return;
    }

    const mesh: THREE.Mesh = panel;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    bb.getSize(size);
    bb.getCenter(centre);

    const display = new ScaleDisplay();
    /*
     * Sized from the panel's bounding box, and turned to match it.
     *
     * `prepare-scale.py` bakes a 45-degree yaw into the asset so the display faces the
     * default camera, which means the panel's LOCAL bounding box is the axis-aligned box
     * around a rotated oval — noticeably bigger than the oval, and square to the world
     * rather than to the panel. The quad therefore takes the same yaw and a matching
     * inset, or it sits askew on the bezel it is supposed to fill.
     */
    const geo = new THREE.PlaneGeometry(size.x * 0.62, size.z * 0.42);
    const mat = new THREE.MeshBasicMaterial({
      map: display.texture,
      // An LCD emits. Lit, AgX tone mapping would render it as grey plastic — the same
      // reasoning as `toneMapped: false` on the selection brackets.
      toneMapped: false,
    });
    const quad = new THREE.Mesh(geo, mat);
    // Flat, face up. `-90` about X is what points the quad at the sky; `+90` puts it
    // face-down inside the housing where nobody can see it.
    quad.rotation.set(-Math.PI / 2, 0, ASSET_YAW_RAD);
    quad.position.set(centre.x, bb.max.y + 0.0005, centre.z);
    quad.renderOrder = 1;
    mesh.parent?.add(quad);

    this.#disposables.push(geo, mat);
    this.#display = display;
  }

  teardown(): void {
    this.#alive = false;
    for (const j of this.#joints) this.ctx.physics.removeJoint(j);
    for (const b of this.#bodies) this.ctx.physics.remove(b);
    this.#joints.length = 0;
    this.#bodies.length = 0;
    this.#props.clear();
    this.ctx.scene.remove(this.#group);
    this.#group.clear();
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
    this.#shells.clear();
    this.#placeholders.clear();
    this.#display?.dispose();
    this.#display = null;
  }
}

function box(
  hx: number,
  hy: number,
  hz: number,
  at: Vec3 | undefined,
  material: SurfaceId,
  massKg?: number,
): ColliderPart {
  return {
    shape: { kind: 'box', halfExtents: { x: hx, y: hy, z: hz } },
    material,
    ...(at ? { at } : {}),
    ...(massKg !== undefined ? { massKg } : {}),
  };
}

/** |v| + |w|r — the same measure the selection brackets use for "is this still moving". */
function cornerSpeed(e: Entity): number {
  const v = e.lastVel;
  return Math.hypot(v.x, v.y, v.z);
}
