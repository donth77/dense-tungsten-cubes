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
/**
 * Clearance between the top of the stand column and the underside of the beam.
 *
 * FIFTY millimetres, not two. A balance beam tilts, and a column that reaches up to
 * within a bearing's width of a 36 mm-wide bar becomes a rest the bar lands on at
 * atan(gap / radius) — 3.2 degrees for 2 mm over 36 mm. That is what every "settled"
 * angle between 3.5 and 4 degrees measured since the column was widened to match the
 * asset actually was: the beam lying on top of the stand, reading nothing. The real
 * instrument carries its beam on a knife-edge above a narrow neck; the asset draws
 * that, and the collider simply stops short and lets the joint do the holding.
 */
const BEARING_GAP = 0.05;
const KEEL_HALF = 0.012;
const ZERO = { x: 0, y: 0, z: 0 };
/** Show the placeholders anyway if the asset has not resolved either way by then. */
const ASSET_REVEAL_TIMEOUT_MS = 3000;
/** How far below a pan's underside its carried-mass stub sits. Clear of the dish. */
const STUB_DROP = 0.03;
const UP = { x: 0, y: 1, z: 0 };
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };

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
  #braking = false;
  /** Beam locked because a pan is over capacity — see beforePhysics. */
  #arrested = false;
  /** Keel-and-pans restoring moment per sin(angle), N·m. Set at build from the masses. */
  #restoringNm = 0;
  #usingAsset = false;
  /** Placeholder meshes, so a swap can free them the moment the real asset lands. */
  readonly #placeholders = new Set<THREE.Object3D>();
  /** body -> the group PropStore drives. Children swap; the group does not. */
  readonly #shells = new Map<BodyHandle, THREE.Group>();
  /** Filtered pan loads, N — what the beam is actually being asked to carry. */
  readonly #panForceN: [number, number] = [0, 0];
  /** Two one-pole sections per pan (15 §7.5's form). State is the filtered value. */
  readonly #lp1: [number, number] = [0, 0];
  readonly #lp2: [number, number] = [0, 0];

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

    // ---- stand: a column on a foot, with the beam's two end stops --------------
    this.#stand = physics.addCompound({
      kind: 'fixed',
      at: { x: 0, y, z: 0 },
      // Three cylinders that follow the mesh's silhouette — foot, bulb, stem — so a cube
      // that falls against the stand meets the shape it can see. The stem stops short of
      // the beam by BEARING_GAP: a column reaching the pivot overlaps the bar it carries,
      // and the solver resolves that by throwing the beam off its zero.
      parts: [...standParts(), ...beamStops()],
    });

    /*
     * ---- beam: the only DYNAMIC part of the instrument -------------------------
     *
     * A bar through the pivot, a counterweight hung below it, and the pans' mass carried
     * at the tips. The keel is what makes this a balance rather than a see-saw: its mass
     * is placed by BUILDING it below the pivot, so the restoring moment follows from the
     * shape (15 §6.2). It is split either side of the column because a bob on the
     * centreline would be inside the stand.
     *
     * THE PAN MASS IS CARRIED ON THE BEAM, AT THE PANS' POSITIONS, AS IF ON STIFF
     * STIRRUPS. That choice is most of the instrument's stability and it is worth being
     * precise about. A chain-hung pan contributes NO restoring moment: its weight acts at
     * the tip's horizontal position whatever the drop, and the two sides cancel exactly.
     * A pan carried rigidly below the tip does — as the beam tilts its mass swings
     * outward on the low side and inward on the high side, a pendulum effect worth
     * 2·m·g·dropM ≈ 7.1 N·m/rad here against the keel's 0.5. Measured with the mass on
     * the bar instead: every cube above 1 kg was slammed to the stop and flung off.
     *
     * So the balance behaves like one with stirrup-mounted pans — graded, readable angles
     * across the whole load range — while DRAWING chains, because that is what the asset
     * has. A chain-hung balance would be far more sensitive and would pin at its stop for
     * any single cube, which is correct for a laboratory instrument and useless for a toy
     * whose first move is "put one cube on one side".
     *
     * The stubs sit just BELOW each pan, not inside it. Inside was tried: a dynamic part
     * overlapping a kinematic collider is a penetration the solver resolves with
     * thousands of newtons, and the pans read 788 and 7,793 N under a 1 kg cube.
     */
    const barKg = B.beamKg * (1 - B.keelMassFraction);
    const keelKg = B.beamKg * B.keelMassFraction;
    const stub = 0.003;
    // Gravity's restoring coefficient, N·m per sin(theta): every part's mass times how
    // far below the pivot it is carried. The bar sits on the pivot and contributes none.
    this.#restoringNm =
      physics.gravityMps2 * (2 * B.panKg * (B.dropM + STUB_DROP) + keelKg * B.keelDropM);
    this.#beam = physics.addCompound({
      kind: 'dynamic',
      at: { x: 0, y, z: 0 },
      parts: [
        box(B.armM, BAR_HALF, BAR_HALF, undefined, barKg),
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
        box(stub, stub, stub, { x: -B.armM, y: -B.dropM - STUB_DROP, z: 0 }, B.panKg),
        box(stub, stub, stub, { x: B.armM, y: -B.dropM - STUB_DROP, z: 0 }, B.panKg),
      ],
    });
    // Viscous pivot friction, implicit — see beforePhysics for why it is not a torque.
    physics.setAngularDamping(this.#beam, B.pivotDamping);

    this.#joints.push(
      physics.addRevoluteJoint({
        bodyA: this.#stand,
        bodyB: this.#beam,
        anchorA: { x: 0, y: 0, z: 0 },
        anchorB: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 },
        // A backstop, wider than the physical stops: the contacts are what the beam is
        // meant to land on, and this only catches what they miss.
        limitsRad: [
          -(B.limitDeg + B.jointLimitMarginDeg) * DEG,
          (B.limitDeg + B.jointLimitMarginDeg) * DEG,
        ],
      }),
    );

    /*
     * ---- pans: KINEMATIC, level, and never attached to the beam by a joint --------
     *
     * The sixth suspension design, and the first that is not a joint. The five before it
     * all hung the pan off the beam with some constraint, and every one was measured being
     * pulled out of shape by a load several times the instrument's own mass:
     *
     *   three ropes           pan inverted — 113 deg from a cube set down 2 mm above it
     *   one spherical pivot   pan stable, beam slammed its stop and threw the cube
     *   merged into the beam  perfect to 2.4 kg, then the pan TILTS with the beam and a
     *                         heavy cube slides, tumbles, and never lets the beam settle
     *   revolute + servo      the motor holds in isolation; in the assembly, 45 deg
     *   fixed joint           pulled to 44 deg by 18.9 kg at 0.37 m
     *
     * A joint is a soft constraint, and at four solver iterations no stiffness fixes that.
     * A KINEMATIC body is not solved at all: it is placed, and it is infinitely massive to
     * everything resting on it. So each pan is positioned every step — hanging level
     * below its beam tip, exactly where a real pan hangs — and a cube on it sees a surface
     * that cannot tilt and cannot give.
     *
     * What a kinematic pan cannot do is push the beam. So the load is carried across
     * explicitly: the contact force the cubes actually exert on the pan, read from the
     * solver after each step, becomes a torque on the beam at the pan's lever arm. That
     * is the same shape as the digital scale's transducer — a measured force is the
     * signal — and it is the one deliberate deviation from 15 §6.2's letter, which has
     * Rapier deliver the load torque through the constraint. The part of §6.2 that
     * matters is untouched: nothing drives the beam toward an angle. Equal loads make
     * equal torques, the net is zero, and the keel alone brings it level.
     */
    const panY = y - B.dropM;
    this.#pans = [0, 1].map((i) => {
      const sign = i === 0 ? -1 : 1;
      return physics.addCompound({
        kind: 'kinematic',
        at: { x: sign * B.armM, y: panY, z: 0 },
        parts: [
          {
            // Top face at the dish's visible floor, not at the pan origin — see
            // config.weigh.balance.panFloorM for the measurement.
            shape: { kind: 'cylinder', halfHeightM: B.panThicknessM, radiusM: B.panRadiusM },
            material: 'steel',
            at: { x: 0, y: B.panFloorM - B.panThicknessM, z: 0 },
          },
          ...rim(),
        ],
      });
    }) as [BodyHandle, BodyHandle];

    this.#bodies.push(this.#stand, this.#beam, this.#pans[0], this.#pans[1]);
    this.#buildVisuals();
    this.ctx.scene.add(this.#group);
  }

  /** Where a pan's centre belongs for a given beam angle: hanging level below the tip. */
  #panTarget(side: 0 | 1, beamRad: number): Vec3 {
    const sign = side === 0 ? -1 : 1;
    return {
      x: sign * B.armM * Math.cos(beamRad),
      y: B.pivotHeightM + sign * B.armM * Math.sin(beamRad) - B.dropM,
      z: 0,
    };
  }

  /**
   * Pre-solver.
   *
   * Three things, in order: place the pans for this step, carry last step's measured
   * pan loads onto the beam as torque, then the two passive behaviours — arrestment and
   * approach braking. There is no motor and no angle spring: if the beam finds level,
   * gravity took it there (15 §6.2).
   *
   * The pivot friction is implicit (`setAngularDamping`, set at build) rather than a
   * hand-applied `-c*w` torque. The explicit form needs `c*dt/I < 2` or it amplifies, so
   * it has to be clamped, and the clamp needs an inertia Rapier only reports as principal
   * moments in an order this code cannot verify — measured, it made damping across a 10x
   * range change nothing at all.
   */
  beforePhysics(): void {
    const { physics } = this.ctx;
    const q = physics.transformOf(this.#beam).q;
    const beamRad = 2 * Math.atan2(q.z, q.w);
    const angleDeg = (beamRad * 180) / Math.PI;

    // Pans follow the beam tips, always level.
    for (const side of [0, 1] as const) {
      physics.setKinematicTarget(this.#pans[side], this.#panTarget(side, beamRad), LEVEL);
    }

    /*
     * The load, as torque. A downward force F at a pan whose tip sits at horizontal
     * distance `armM*cos(theta)` from the pivot is a torque of F times that arm; the left
     * pan turns the beam positive (left-down, the sign `angleRad` uses), the right pan
     * negative. The forces are last step's, read in afterPhysics — one step of lag at
     * 60 Hz, against a beam that takes two seconds to settle.
     */
    const arm = B.armM * Math.cos(beamRad);
    const torque = (this.#panForceN[0] - this.#panForceN[1]) * arm;
    physics.applyTorque(this.#beam, { x: 0, y: 0, z: torque });

    /*
     * ARRESTMENT, in two cases.
     *
     * Over capacity: 15 §6.1 rates these pans at 10 kg and a 4 in tungsten cube is
     * 18.9 kg. A real balance has a lever that locks the beam for exactly this, and holding
     * it still while the display says OVERLOAD is the honest behaviour.
     *
     * On the stop: a beam driven against its end stop by a load the keel cannot answer
     * chatters there forever — 8 kg on one pan is 30 N·m into a soft contact, and it
     * never goes quiet. A real beam on its stop is held by the stop's friction. So once
     * the beam is at the limit AND the net torque still points into it, it is held; the
     * moment the load eases enough for the keel to win, it is released and swings back.
     * `#restoringNm` is the same mass-times-depth the colliders were built from.
     */
    const heldOnStop =
      Math.abs(angleDeg) >= B.limitDeg - B.atStopMarginDeg &&
      Math.sign(torque) === Math.sign(beamRad) &&
      Math.abs(torque) > this.#restoringNm * Math.sin(Math.abs(beamRad));
    if (this.#arrested || heldOnStop) {
      physics.setVelocity(this.#beam, ZERO, ZERO);
      return;
    }

    /*
     * Approach braking: damping ramps up over the last few degrees before a stop, so the
     * beam eases into it instead of slamming. Only ever removes energy, cannot choose a
     * side, and does nothing until the beam is already heading for a stop. The band is
     * kept narrow so it stays clear of where a loaded beam normally rests.
     */
    const intoStop = Math.abs(angleDeg) - (B.limitDeg - B.stopApproachDeg);
    if (intoStop <= 0) {
      if (this.#braking) {
        physics.setAngularDamping(this.#beam, B.pivotDamping);
        this.#braking = false;
      }
      return;
    }
    const t = Math.min(1, intoStop / B.stopApproachDeg);
    physics.setAngularDamping(this.#beam, B.pivotDamping + B.stopBrakingDamping * t * t);
    this.#braking = true;
  }

  afterPhysics(dt: number): void {
    this.#props.capture();
    const { physics } = this.ctx;
    const q = physics.transformOf(this.#beam).q;
    // Rotation is about Z only, so the half-angle comes straight off (z, w).
    const angleRad = 2 * Math.atan2(q.z, q.w);

    // What each pan is carrying, as the solver resolved it this step — vertical share
    // only, so a cube leaning on the rim counts for what it bears down with — then
    // clamped and filtered. See config.weigh.balance.loadFilterHz for why the filter is
    // not optional.
    const proofN = B.capacityKgPerPan * physics.gravityMps2 * B.loadProofFactor;
    const a = 1 - Math.exp(-2 * Math.PI * B.loadFilterHz * dt);
    for (const side of [0, 1] as const) {
      const raw = Math.min(proofN, physics.contactForceAlongN(this.#pans[side], UP));
      this.#lp1[side] += a * (raw - this.#lp1[side]);
      this.#lp2[side] += a * (this.#lp1[side] - this.#lp2[side]);
      this.#panForceN[side] = this.#lp2[side];
    }

    const loads = this.#panLoads();
    // Latched here for the NEXT step's beforePhysics — the loads are known post-solve.
    this.#arrested = loads[0].kg > B.capacityKgPerPan || loads[1].kg > B.capacityKgPerPan;

    this.#state = this.signal.update(
      {
        angleRad,
        angularSpeedRadS: physics.angularVelocityOf(this.#beam).z,
        // Kinematic pans are placed level every step and cannot swing. Kept in the
        // sample because 15 §9.3 names them and a hung-pan design would fill them in.
        leftPanSpeedRadS: 0,
        rightPanSpeedRadS: 0,
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
      const pan = this.panCentre(side);
      for (const e of this.ctx.entities.all) {
        if (!overPan(e, pan)) continue;
        out[side].kg += e.massKg;
        out[side].count++;
        if (e.heldBy !== null) out[side].grabbed = true;
      }
    }
    return out;
  }

  /** A pan's centre in world space. */
  panCentre(side: 0 | 1): Vec3 {
    return this.ctx.physics.transformOf(this.#pans[side]).p;
  }

  /** The measured load on each pan, N — what the beam is actually being asked to carry. */
  get panForceN(): readonly [number, number] {
    return this.#panForceN;
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

    // Every body is bound to a GROUP, never straight to a mesh. The group is what the
    // PropStore drives; its children are swappable, which is how the prepared asset
    // replaces the placeholder shapes without any body losing its binding.
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

    // Placeholders that MATCH THE COLLIDERS. The prepared GLB replaces these meshes and
    // nothing else — the physics is procedural either way, so the asset swap cannot
    // change how the instrument behaves. The counterweight is deliberately not drawn: the
    // asset's beam has nothing for it to belong to, and it read as debris. Its mass is in
    // the colliders, and `__dense.colliders(true)` shows exactly where.
    add(standShape(), this.#stand);
    add(beamShape(), this.#beam);
    add(panShape(), this.#pans[0]);
    add(panShape(), this.#pans[1]);
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
   * Redraws the six chain runs from the hook rings at the beam tips to the pan rims.
   *
   * Read from the INTERPOLATED prop transforms, not from physics: drawn from the
   * fixed-step pose the chains would detach from the pans on every frame between steps.
   * And `updateWorldMatrix` first, because three.js refreshes `matrixWorld` DURING render
   * — reading it beforehand gets last frame's pose, which is exactly how the chains once
   * hung permanently one frame behind the beam.
   */
  #updateChains(): void {
    if (!this.#chains) return;
    const beamObj = this.#props.objectOf(this.#beam);
    const panObjs = [this.#props.objectOf(this.#pans[0]), this.#props.objectOf(this.#pans[1])];
    if (!beamObj || !panObjs[0] || !panObjs[1]) return;
    beamObj.updateWorldMatrix(true, false);
    panObjs[0].updateWorldMatrix(true, false);
    panObjs[1].updateWorldMatrix(true, false);

    const pos = this.#chains.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ring = hookRing(B.hookRingM);
    const rimScale = B.panRimRadiusM / B.hookRingM;
    const v = new THREE.Vector3();
    let i = 0;
    for (const [ax, az] of ring) {
      for (const side of [0, 1] as const) {
        const sign = side === 0 ? -1 : 1;
        v.set(sign * (B.armM - B.hookRingM) + ax * sign, B.hookHeightM, az).applyMatrix4(
          beamObj.matrixWorld,
        );
        pos.setXYZ(i++, v.x, v.y, v.z);
        v.set(ax * rimScale * sign, B.panRimTopM, az * rimScale).applyMatrix4(
          panObjs[side]!.matrixWorld,
        );
        pos.setXYZ(i++, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
  }

  /**
   * Swaps the placeholder boxes for the prepared GLB once it arrives. The instrument is
   * fully working before this resolves, so a slow or failed load costs appearance and
   * nothing else. `#alive` guards a load that resolves after teardown.
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
      this.#group.visible = true;
    } catch (err) {
      console.warn('[weigh] balance asset unavailable; keeping placeholder shapes', err);
      if (this.#alive) this.#group.visible = true;
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

/**
 * Two blocks on the stand that the beam comes to rest against at `limitDeg`.
 *
 * Sized and placed from the beam's own geometry: at the limit angle, the underside of the
 * bar at `stopRadiusM` sits at exactly this height, so the beam meets the block instead of
 * fighting its joint limit. See the note on `config.weigh.balance.stopRadiusM` for the
 * measurements that made these necessary.
 */
function beamStops(): ColliderPart[] {
  const t = B.limitDeg * DEG;
  const r = B.stopRadiusM;
  // A thin post, not a block. A 20 mm-wide block centred on the contact point caught the
  // bar on its outer corner 1.5 degrees early; 3 mm keeps the error under 0.3.
  const halfX = 0.003;
  const halfY = 0.01;
  // Underside of the bar at radius r, once the beam has rotated to the limit.
  const contactY = -(r * Math.sin(t) + BAR_HALF * Math.cos(t));
  const contactX = r * Math.cos(t) + BAR_HALF * Math.sin(t);
  return [-1, 1].map((sign) => ({
    shape: { kind: 'box', halfExtents: { x: halfX, y: halfY, z: 0.01 } },
    material: 'foam' as const,
    // `foam` for its restitution of 0.1: a stop that bounces is a stop that rings, and
    // this one is struck by loads several times the instrument's own mass.
    at: { x: sign * contactX, y: contactY - halfY, z: 0 },
  }));
}

/**
 * Eight short walls around the dish's edge — a polygon standing in for the dish's curved
 * lip. They run from the dish floor up to the visible rim crest and no higher, at the
 * radius the mesh's rim actually sits: an invisible wall taller than the metal stops a
 * cube in mid-air, and one further out lets it hang past the edge.
 */
function rim(): ColliderPart[] {
  const segments = 8;
  const t = 0.003;
  const radius = B.panRimRadiusM;
  const chord = radius * Math.tan(Math.PI / segments);
  const halfH = (B.panRimTopM - B.panFloorM) / 2;
  const centreY = (B.panRimTopM + B.panFloorM) / 2;
  const out: ColliderPart[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const half = a / 2;
    out.push({
      shape: { kind: 'box', halfExtents: { x: t, y: halfH, z: chord } },
      material: 'steel',
      at: { x: Math.cos(a) * radius, y: centreY, z: Math.sin(a) * radius },
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
/** The stand's three cylinders, in the stand's frame (origin at the pivot). */
function standParts(): ColliderPart[] {
  const y = B.pivotHeightM;
  const bulbCentre = -B.bulbCentreBelowPivotM;
  const bulbTop = bulbCentre + B.bulbHalfHeightM;
  const stemTop = -BAR_HALF - BEARING_GAP;
  const stemHalf = (stemTop - bulbTop) / 2;
  const cyl = (halfHeightM: number, radiusM: number, cy: number): ColliderPart => ({
    shape: { kind: 'cylinder', halfHeightM, radiusM },
    material: 'steel',
    at: { x: 0, y: cy, z: 0 },
  });
  return [
    cyl(B.baseThicknessM / 2, B.baseRadiusM, -y + B.baseThicknessM / 2),
    cyl(B.bulbHalfHeightM, B.bulbRadiusM, bulbCentre),
    cyl(stemHalf, B.stemRadiusM, bulbTop + stemHalf),
  ];
}

/** Placeholder stand: the same three cylinders the colliders use. */
function standShape(): THREE.BufferGeometry {
  const geos = standParts().map((p) => {
    const sh = p.shape as { kind: 'cylinder'; halfHeightM: number; radiusM: number };
    const g = new THREE.CylinderGeometry(sh.radiusM, sh.radiusM, sh.halfHeightM * 2, 12);
    g.translate(0, p.at?.y ?? 0, 0);
    return g;
  });
  return mergeBoxes(geos);
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
  const g = new THREE.BoxGeometry(B.panRadiusM * 2, B.panThicknessM * 2, B.panRadiusM * 2);
  g.translate(0, B.panFloorM - B.panThicknessM, 0);
  return g;
}
