import * as THREE from 'three';
import { config } from '../../config.ts';
import { galvanized, hazardChevron, paintedSteel, stencilPlate } from './rigtex.ts';
import type { Entity } from '../../core/entities.ts';
import type { LabContext } from '../lab.ts';
import type { BodyHandle, EntityId, Quat } from '../../types.ts';

/**
 * The winch and its RELEASE CARRIAGE (17 §3). No joint anywhere: the carried cube IS
 * kinematic (`setBodyKind`, validated in D0), seated on the carriage's closed door
 * leaves; release opens the leaves in the same frame the cube goes dynamic at zero
 * velocity. The doors carry NO colliders, ever — they are theatre synchronised to the
 * truth (17 §3.4), sprung open faster than free fall the way real drop-tester leaves
 * are.
 *
 * The hook this replaces was a category error: a cube has nothing to hook (user,
 * 2026-08-24). A basket the cube visibly rides in, with a floor that opens, is the
 * mechanism a viewer parses in one glance — it is what real drop-test rigs use.
 *
 * Every bespoke surface here is textured (17 §4's doctrine): galvanised members,
 * painted leaves, hazard chevrons on the parting edges.
 */

const T = config.drop.tower;

// Rig geometry — visual only, so it lives here rather than in config (nothing to tune).
const MAST_X = -1.45;
const MAST_Z = -1.05;
const MAST_HALF = 0.15;
const MAST_TOP = 20.9;
const BAY_M = 1.3;
const SHEAVE_Y = 20.6;

// The carriage (17 §3.1): interior 0.5 × 0.5 × 0.55 — a 15 in cube clears every post.
/** The carriage's interior half-span — the lab's footprint test uses it (17 §3.1). */
export const CARRIAGE_INTERIOR_HALF_M = 0.25;
const IX = CARRIAGE_INTERIOR_HALF_M; // interior half-span
const POST_H = 0.55;
const ROOF_T = 0.04;
const SLING_DROP = 0.3;
/** Cable end -> door top plane. The height math's one carriage constant. */
const DOOR_DROP = SLING_DROP + ROOF_T + POST_H;
/** Bi-fold floor (truck-liftgate stow): outer panel folds just past vertical… */
const FOLD_HINGE = Math.PI / 2 + 0.08;
/** …and the inner panel folds back against it, leaving a visible V so it reads as two plates. */
const FOLD_KNUCKLE = Math.PI - 0.16;
const DOOR_CLOSE_RATE = 5; // 1/s
const DOOR_SNAP_RATE = 16; // the release snap — visually faster than free fall

export type TowerPhase = 'idle' | 'loading' | 'hoisting' | 'armed' | 'dropped';

/** Texture tiles per metre: one 0.5 m tile — the galvanised seam band's period. */
const TILES_PER_M = 2;

/**
 * World-density box mapping: recompute a BoxGeometry's UVs from vertex positions by
 * dominant normal axis, so texture density is texels-per-METRE on every face of every
 * member. A single unit box stretched per instance smeared one 256 px tile over a
 * 20 m chord — technically textured, visibly bare (user-caught, 2026-08-24).
 */
function boxMapUVs(geo: THREE.BoxGeometry): THREE.BoxGeometry {
  const pos = geo.attributes.position!;
  const nrm = geo.attributes.normal!;
  const uv = geo.attributes.uv!;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else if (ny >= nx && ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv.setXY(i, u * TILES_PER_M, v * TILES_PER_M);
  }
  uv.needsUpdate = true;
  return geo;
}

export class Tower {
  #phase: TowerPhase = 'idle';
  /** Bottom-face release height the slider asked for. */
  targetHM = T.defaultHM;

  /**
   * The CARGO: every cube riding the carriage, at its own plate position. The basket
   * made batch drops natural (user, 2026-08-24: "should we be able to drop multiple
   * cubes?") — real drop testers run batches, and the release semantics per cube are
   * identical to the single case.
   */
  #cargo: { id: EntityId; dx: number; dz: number; sideM: number; q: Quat }[] = [];

  /** The CABLE END (spreader top). prev/curr for render interpolation. */
  #cableEndY = T.restCableEndYM;
  #cableEndPrevY = T.restCableEndYM;
  #hoistV = 0;
  /** Where the carriage holds after a release — it must NOT chase the cube down. */
  #holdY = T.restCableEndYM;

  /** Door leaves, 0 closed .. 1 open. Animated on the fixed step, drawn interpolated. */
  #doorsOpen = 0; // closed at idle — the floor IS the platform (2026-08-25)
  #doorsPrev = 1;

  readonly #group = new THREE.Group();
  #carriage!: THREE.Group;
  #leafL!: THREE.Group;
  #leafR!: THREE.Group;
  #foldL!: THREE.Group;
  #foldR!: THREE.Group;
  #cableMesh!: THREE.Mesh;
  readonly #disposables: { dispose(): void }[] = [];

  constructor(
    private readonly ctx: LabContext,
    /** The LANDING surface's top — the plate, or the mounted pad's mat (16 §7.1). */
    private readonly floorTopYM: () => number,
  ) {}

  get phase(): TowerPhase {
    return this.#phase;
  }
  get cargoIds(): readonly EntityId[] {
    return this.#cargo.map((c) => c.id);
  }
  get hasCargo(): boolean {
    return this.#cargo.length > 0;
  }
  /** Where the carried cube's bottom face is right now, above the landing surface. */
  get carriedHeightM(): number {
    return this.#doorPlaneY() - this.floorTopYM();
  }

  /** The closed doors' top surface — the carriage's load plane (17 §3.1). */
  #doorPlaneY(): number {
    return this.#cableEndY - DOOR_DROP;
  }

  build(): void {
    this.#createPlatform();
    const galv = galvanized();
    const steel = new THREE.MeshStandardMaterial({
      color: galv ? 0xffffff : 0x8a939c,
      roughness: galv ? 1.0 : 0.6,
      metalness: 0.35,
      ...(galv ? { map: galv.map, roughnessMap: galv.roughnessMap } : {}),
    });
    if (galv) this.#disposables.push(galv.map, galv.roughnessMap!);
    const paint = paintedSteel();
    const painted = new THREE.MeshStandardMaterial({
      color: paint ? 0xffffff : 0x68737d,
      roughness: paint ? 1.0 : 0.55,
      metalness: 0.25,
      ...(paint ? { map: paint.map, roughnessMap: paint.roughnessMap } : {}),
    });
    if (paint) this.#disposables.push(paint.map, paint.roughnessMap!);
    const dark = new THREE.MeshStandardMaterial({
      color: 0x272c31,
      roughness: 0.65,
      metalness: 0.5,
    });
    this.#disposables.push(steel, painted, dark);

    this.#buildTruss(steel);

    // The winch house on the jib, sheave at its mouth (unchanged from the crane).
    const houseGeo = new THREE.BoxGeometry(0.34, 0.26, 0.5);
    this.#disposables.push(houseGeo);
    const house = new THREE.Mesh(houseGeo, painted);
    const jibDir = Math.atan2(0 - MAST_Z, 0 - MAST_X);
    house.position.set(-0.28 * Math.cos(jibDir), SHEAVE_Y + 0.16, -0.28 * Math.sin(jibDir));
    house.rotation.y = -jibDir + Math.PI / 2;
    this.#group.add(house);
    const sheaveGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 16);
    this.#disposables.push(sheaveGeo);
    const sheave = new THREE.Mesh(sheaveGeo, steel);
    sheave.rotation.z = Math.PI / 2;
    sheave.position.set(0, SHEAVE_Y, 0.1);
    this.#group.add(sheave);

    const cableMat = new THREE.MeshStandardMaterial({
      color: 0x9aa4ae,
      roughness: 0.35,
      metalness: 0.9,
    });
    this.#disposables.push(cableMat);
    const cableGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 8);
    this.#disposables.push(cableGeo);
    this.#cableMesh = new THREE.Mesh(cableGeo, cableMat);
    this.#group.add(this.#cableMesh);

    this.#buildCarriage(steel, painted, cableMat);

    /*
     * R2 (17 §6): the details at eye level. A base plate with anchor bolts where the
     * mast meets the stage — the one part of a 20 m mast the camera ever inspects —
     * and the deadpan stencil plate on the winch house (01's tone: the joke is
     * deadpan).
     */
    const baseGeo = new THREE.BoxGeometry(MAST_HALF * 2 + 0.24, 0.035, MAST_HALF * 2 + 0.24);
    this.#disposables.push(baseGeo);
    const base = new THREE.Mesh(baseGeo, painted);
    base.position.set(MAST_X, 0.0175, MAST_Z);
    this.#group.add(base);
    const boltGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.05, 8);
    this.#disposables.push(boltGeo);
    for (const bx of [-1, 1]) {
      for (const bz of [-1, 1]) {
        const bolt = new THREE.Mesh(boltGeo, steel);
        bolt.position.set(
          MAST_X + bx * (MAST_HALF + 0.08),
          0.045,
          MAST_Z + bz * (MAST_HALF + 0.08),
        );
        this.#group.add(bolt);
      }
    }
    const plate = stencilPlate('DENSE · DROP RIG', 'WLL 1000 KG');
    if (plate) {
      this.#disposables.push(plate.map);
      const plateMat = new THREE.MeshStandardMaterial({
        map: plate.map,
        roughness: 0.6,
        metalness: 0.2,
      });
      // A thin BOX, not a plane: the legs poked through the zero-thickness plane and
      // the text clipped (user-caught, 2026-08-24). Legs sit clearly behind it.
      const plateGeo = new THREE.BoxGeometry(0.44, 0.22, 0.016);
      const legGeo = new THREE.BoxGeometry(0.02, 0.44, 0.02);
      this.#disposables.push(plateMat, plateGeo, legGeo);
      /*
       * A free-standing shop placard by the mast's base, squared to the default
       * camera. Mounted ON the mast it sat behind the lattice at a perspective that
       * clipped it half-illegible (screenshot review) — and a gag nobody can read
       * is not deadpan, it is absent. Two legs to the stage: nothing floats (17 §7).
       */
      const placard = new THREE.Group();
      // Clear of the carriage's sightline from the default camera — parked beside
      // the mast's base, not between the camera and the bay (screenshot review).
      placard.position.set(MAST_X + 0.12, 0, MAST_Z + 0.85);
      placard.rotation.y = Math.PI / 5;
      const sign = new THREE.Mesh(plateGeo, plateMat);
      sign.position.y = 0.5;
      placard.add(sign);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, steel);
        leg.position.set(sx * 0.18, 0.22, -0.022);
        placard.add(leg);
      }
      this.#group.add(placard);
    }

    this.ctx.scene.add(this.#group);
    this.#placeVisuals(this.#cableEndY, 0, 0, this.#doorsOpen);
  }

  /** The basket: spreader, slings, roof, posts, and the two door leaves (17 §3.1). */
  #buildCarriage(steel: THREE.Material, painted: THREE.Material, cableMat: THREE.Material): void {
    this.#carriage = new THREE.Group();

    const spreaderGeo = new THREE.BoxGeometry(0.16, 0.03, 0.16);
    this.#disposables.push(spreaderGeo);
    const spreader = new THREE.Mesh(spreaderGeo, painted);
    spreader.position.y = -0.015;
    this.#carriage.add(spreader);

    // Four slings, spreader corners to roof lugs — the load path, drawn (17 §5).
    const slingGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 6);
    this.#disposables.push(slingGeo);
    const up = new THREE.Vector3(0, 1, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const from = new THREE.Vector3(sx * 0.06, -0.03, sz * 0.06);
        const to = new THREE.Vector3(sx * IX, -SLING_DROP, sz * IX);
        const dir = to.clone().sub(from);
        const sling = new THREE.Mesh(slingGeo, cableMat);
        sling.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        sling.position.copy(from).add(dir.multiplyScalar(0.5));
        sling.scale.set(1, to.distanceTo(from), 1);
        this.#carriage.add(sling);
      }
    }

    // Roof frame: four rails with the lugs implied at the corners.
    const railX = boxMapUVs(new THREE.BoxGeometry(IX * 2 + 0.08, ROOF_T, 0.05));
    const railZ = boxMapUVs(new THREE.BoxGeometry(0.05, ROOF_T, IX * 2 + 0.08));
    this.#disposables.push(railX, railZ);
    for (const s of [-1, 1]) {
      const rx = new THREE.Mesh(railX, steel);
      rx.position.set(0, -SLING_DROP - ROOF_T / 2, s * IX);
      const rz = new THREE.Mesh(railZ, steel);
      rz.position.set(s * IX, -SLING_DROP - ROOF_T / 2, 0);
      this.#carriage.add(rx, rz);
    }

    // Corner posts — open sides; the cube must stay visible (17 §3.1).
    const postGeo = boxMapUVs(new THREE.BoxGeometry(0.04, POST_H, 0.04));
    this.#disposables.push(postGeo);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, steel);
        post.position.set(sx * IX, -SLING_DROP - ROOF_T - POST_H / 2, sz * IX);
        this.#carriage.add(post);
      }
    }

    /*
     * The floor: two BI-FOLD halves, stowed like a truck liftgate. Each half is a
     * pair of hinged panels; opening folds them into a slim vertical packet resting
     * against its side rail — inside the frame silhouette at every height, nothing
     * below the door plane, nothing cantilevered outboard. (Downward leaves stabbed
     * the floor; upward leaves read as wings; sliding panels stuck out like
     * shelves — all three user-caught, 2026-08-24.) Hazard chevrons mark the
     * parting edges (17 §4.4). Pure visuals; the physics of "resting on them" is
     * the kinematic carry.
     */
    const chevron = hazardChevron();
    const chevMat = new THREE.MeshStandardMaterial({
      color: chevron ? 0xffffff : 0xd9a13c,
      roughness: 0.55,
      metalness: 0.15,
      ...(chevron ? { map: chevron.map } : {}),
    });
    if (chevron) {
      chevron.map.repeat.set(3, 1);
      this.#disposables.push(chevron.map);
    }
    this.#disposables.push(chevMat);
    /*
     * The platform deck is DARKER than any cube face (graphite over the painted
     * maps): a pale 2″ cube on a near-white deck was invisible at the stage camera
     * (user: "so cube is visible there once placed", 2026-08-25).
     */
    const deckMat = (painted as THREE.MeshStandardMaterial).clone();
    deckMat.color.setHex(0x565b61);
    this.#disposables.push(deckMat);
    const halfGeo = new THREE.BoxGeometry(IX / 2, 0.012, IX * 2);
    const edgeGeo = new THREE.BoxGeometry(0.035, 0.014, IX * 2);
    this.#disposables.push(halfGeo, edgeGeo);
    const doorY = -DOOR_DROP - 0.006;
    const mkFold = (side: -1 | 1): [THREE.Group, THREE.Group] => {
      const hinge = new THREE.Group();
      hinge.position.set(side * IX, doorY, 0);
      const outer = new THREE.Mesh(halfGeo, deckMat);
      outer.position.set(-side * (IX / 4), 0, 0);
      const knuckle = new THREE.Group();
      knuckle.position.set(-side * (IX / 2), 0, 0);
      const inner = new THREE.Mesh(halfGeo, deckMat);
      inner.position.set(-side * (IX / 4), 0, 0);
      const edge = new THREE.Mesh(edgeGeo, chevMat);
      edge.position.set(-side * (IX / 2 - 0.0175), 0.002, 0);
      knuckle.add(inner, edge);
      hinge.add(outer, knuckle);
      this.#carriage.add(hinge);
      return [hinge, knuckle];
    };
    [this.#leafL, this.#foldL] = mkFold(-1);
    [this.#leafR, this.#foldR] = mkFold(1);

    this.#group.add(this.#carriage);
  }

  /** The tower crane mast + jib (unchanged from the crane rework). */
  #buildTruss(mat: THREE.Material): void {
    const members: { p: THREE.Vector3; s: THREE.Vector3; ry?: number; rz?: number }[] = [];
    const bays = Math.floor(MAST_TOP / BAY_M);

    for (const ox of [-1, 1]) {
      for (const oz of [-1, 1]) {
        members.push({
          p: new THREE.Vector3(MAST_X + ox * MAST_HALF, MAST_TOP / 2, MAST_Z + oz * MAST_HALF),
          s: new THREE.Vector3(0.06, MAST_TOP, 0.06),
        });
      }
    }
    // Gusset plates at every panel point on the chords — the bolted-joint story
    // told by geometry. (Texture seam bands told it as bamboo nodes.)
    for (let b = 1; b <= bays; b++) {
      for (const gx of [-1, 1]) {
        for (const gz of [-1, 1]) {
          members.push({
            p: new THREE.Vector3(MAST_X + gx * MAST_HALF, b * BAY_M, MAST_Z + gz * MAST_HALF),
            s: new THREE.Vector3(0.16, 0.07, 0.16),
          });
        }
      }
    }
    const diagLen = Math.hypot(MAST_HALF * 2, BAY_M);
    const diagTilt = Math.atan2(MAST_HALF * 2, BAY_M);
    for (let b = 0; b < bays; b++) {
      const y = (b + 1) * BAY_M;
      const flip = b % 2 === 0 ? 1 : -1;
      for (const oz of [-1, 1]) {
        members.push({
          p: new THREE.Vector3(MAST_X, y, MAST_Z + oz * MAST_HALF),
          s: new THREE.Vector3(MAST_HALF * 2, 0.05, 0.05),
        });
        members.push({
          p: new THREE.Vector3(MAST_X, y - BAY_M / 2, MAST_Z + oz * MAST_HALF),
          s: new THREE.Vector3(0.04, diagLen, 0.04),
          rz: flip * diagTilt,
        });
      }
      for (const ox of [-1, 1]) {
        members.push({
          p: new THREE.Vector3(MAST_X + ox * MAST_HALF, y, MAST_Z),
          s: new THREE.Vector3(0.05, 0.05, MAST_HALF * 2),
        });
      }
    }
    const jibDir = Math.atan2(0 - MAST_Z, 0 - MAST_X);
    const cosJ = Math.cos(jibDir);
    const sinJ = Math.sin(jibDir);
    const jibLen = Math.hypot(MAST_X, MAST_Z) + 0.35;
    const jibAt = (along: number, upY: number, side: number): THREE.Vector3 =>
      new THREE.Vector3(
        MAST_X + along * cosJ - side * sinJ,
        upY,
        MAST_Z + along * sinJ + side * cosJ,
      );
    for (const side of [-0.1, 0.1]) {
      members.push({
        p: jibAt(jibLen / 2, 20.5, side),
        s: new THREE.Vector3(jibLen, 0.06, 0.06),
        ry: -jibDir,
      });
    }
    members.push({
      p: jibAt(jibLen / 2, 20.86, 0),
      s: new THREE.Vector3(jibLen, 0.06, 0.06),
      ry: -jibDir,
    });
    for (let k = 1; k <= 4; k++) {
      const along = (jibLen * k) / 5;
      for (const side of [-0.1, 0.1]) {
        members.push({
          p: jibAt(along, 20.68, side * 0.6),
          s: new THREE.Vector3(0.045, 0.4, 0.045),
        });
      }
    }
    for (const side of [-0.1, 0.1]) {
      members.push({
        p: jibAt(-0.45, 20.6, side),
        s: new THREE.Vector3(0.9, 0.06, 0.06),
        ry: -jibDir,
      });
    }
    members.push({ p: jibAt(-0.75, 20.48, 0), s: new THREE.Vector3(0.3, 0.3, 0.34), ry: -jibDir });

    /*
     * Per-TYPE instancing: members grouped by their real dimensions, each group a
     * BoxGeometry of those dimensions with world-density box-mapped UVs, instances
     * carrying position and rotation only. One stretched unit box gave a 20 m chord
     * one texture tile; this gives every member the same texels-per-metre for ~8
     * draw calls, still far inside the budget.
     */
    const groups = new Map<string, { dims: THREE.Vector3; items: typeof members }>();
    for (const m of members) {
      const key = `${m.s.x.toFixed(3)}x${m.s.y.toFixed(3)}x${m.s.z.toFixed(3)}`;
      let g = groups.get(key);
      if (!g) {
        g = { dims: m.s, items: [] };
        groups.set(key, g);
      }
      g.items.push(m);
    }
    const dummy = new THREE.Object3D();
    for (const g of groups.values()) {
      const geo = boxMapUVs(new THREE.BoxGeometry(g.dims.x, g.dims.y, g.dims.z));
      this.#disposables.push(geo);
      const inst = new THREE.InstancedMesh(geo, mat, g.items.length);
      g.items.forEach((m, k) => {
        dummy.position.copy(m.p);
        dummy.rotation.set(0, m.ry ?? 0, m.rz ?? 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        inst.setMatrixAt(k, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = false;
      inst.frustumCulled = false;
      this.#group.add(inst);
    }
  }

  /** Begin loading: the open bay descends around the cargo, captures, closes, hoists. */
  /** While carrying for a TARGET drop, this cargo cube glides to plate centre. */
  #centreId: EntityId | null = null;
  /**
   * The loading platform: a BORN-FIXED collider under the closed doors, existing
   * ONLY while the carriage idles at rest (born fresh on every return — the
   * moved-fixed-body event silence, 2026-08-25). Carried cubes are kinematic and
   * need no floor; released cubes must never meet a stale one.
   */
  #platform: BodyHandle | null = null;

  /** Debug/testing: the raw cable state vs its current target. */
  get dbgCable(): { y: number; target: number; v: number } {
    return { y: this.#cableEndY, target: this.#cableTarget(), v: this.#hoistV };
  }

  get idleDoorPlaneY(): number {
    return T.restCableEndYM - DOOR_DROP;
  }

  /** Whether the loading platform is currently standing (idle, floor closed). */
  get hasPlatform(): boolean {
    return this.#platform !== null;
  }

  #createPlatform(): void {
    if (this.#platform !== null) return;
    this.#platform = this.ctx.physics.addCompound({
      kind: 'fixed',
      at: { x: 0, y: this.idleDoorPlaneY - 0.01, z: 0 },
      parts: [
        {
          shape: { kind: 'box', halfExtents: { x: IX, y: 0.01, z: IX } },
          material: 'steel',
        },
      ],
    });
  }

  #removePlatform(): void {
    if (this.#platform === null) return;
    this.ctx.physics.remove(this.#platform);
    this.#platform = null;
  }

  /** True once the target-drop subject hangs over plate centre (or no target). */
  get centredForDrop(): boolean {
    if (this.#centreId === null) return true;
    const c = this.#cargo.find((x) => x.id === this.#centreId);
    return c === undefined || Math.hypot(c.dx, c.dz) < 0.01;
  }

  load(cubes: readonly Entity[], centreId?: EntityId): boolean {
    if ((this.#phase !== 'idle' && this.#phase !== 'dropped') || cubes.length === 0) return false;
    this.#cargo = cubes.map((e) => ({
      id: e.id,
      dx: e.curr.p.x,
      dz: e.curr.p.z,
      sideM: e.spec.sideM,
      q: { ...e.curr.q },
    }));
    this.#centreId = centreId ?? null;
    /*
     * The cubes already REST on the platform at exactly the carry pose (bottom =
     * door plane), so capture is a seamless body-kind flip — no descent, no 6 mm
     * nudge, no visual pop (2026-08-25 redesign). The platform collider leaves
     * with them; kinematic cargo needs no floor.
     */
    for (const c of this.#cargo) this.ctx.entities.setKind(c.id, 'kinematic');
    this.#removePlatform();
    this.#phase = 'hoisting';
    return true;
  }

  /** Release (17 §3.4): doors snap in the frame every cube goes dynamic at v = 0. */
  drop(): EntityId[] {
    if (this.#phase !== 'armed' || this.#cargo.length === 0) return [];
    const ids: EntityId[] = [];
    // The carriage HOLDS here until the drop is judged: a rig that dives after its
    // own specimen reads as falling with it (user-caught, 2026-08-24). finishDrop()
    // sends it home once the verdict is in.
    this.#holdY = this.#cableEndY;
    for (const c of this.#cargo) {
      const e = this.ctx.entities.get(c.id);
      if (!e) continue;
      this.ctx.entities.setKind(c.id, 'dynamic');
      this.ctx.physics.setVelocity(e.body, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      this.ctx.physics.setCcd(e.body, true);
      ids.push(c.id);
    }
    this.#cargo = [];
    this.#phase = 'dropped';
    if (ids.length) this.ctx.fx.play('clack_hook', 0.5);
    return ids;
  }

  /** Put carried cargo gently back (RESET, teardown): dynamic, where it hangs. */
  unload(): void {
    for (const c of this.#cargo) {
      const e = this.ctx.entities.get(c.id);
      if (!e) continue;
      this.ctx.entities.setKind(c.id, 'dynamic');
      this.ctx.physics.setVelocity(e.body, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    }
    this.#cargo = [];
    this.#phase = 'idle';
  }

  /** The winch is done with its cube (it landed and settled): ready for the next. */
  finishDrop(): void {
    if (this.#phase === 'dropped') this.#phase = 'idle';
  }

  /** Pre-solver, every step: profile, doors, and the carried cube's seat. */
  beforePhysics(dt: number): void {
    this.#cableEndPrevY = this.#cableEndY;
    this.#doorsPrev = this.#doorsOpen;
    // Prune cargo deleted under us; an emptied bay mid-carry stands down.
    if (this.#cargo.length) {
      this.#cargo = this.#cargo.filter((c) => this.ctx.entities.get(c.id));
      if (this.#cargo.length === 0 && this.#phase !== 'dropped') this.#phase = 'idle';
    }

    /*
     * ONE transition per step, each judged against its OWN phase's target — the
     * cascade bug's fix, unchanged (16 §15 D2 amendment).
     */
    const phaseAtEntry = this.#phase;
    const target = this.#cableTarget();
    this.#stepProfile(target, dt);

    if (
      phaseAtEntry === 'idle' &&
      this.#platform === null &&
      Math.abs(this.#cableEndY - T.restCableEndYM) < 0.01
    ) {
      this.#createPlatform(); // home again: a fresh, born-in-place loading floor
    }
    if (phaseAtEntry === 'hoisting' && Math.abs(this.#cableEndY - target) < 0.001) {
      this.#phase = 'armed';
    } else if (phaseAtEntry === 'armed' && Math.abs(this.#cableEndY - target) > 0.005) {
      this.#phase = 'hoisting';
    }

    // Doors: CLOSED whenever the floor is a platform (idle, carry) and open only
    // after the release; the snap outruns free fall (17 §3.4; redesigned 2026-08-25).
    const doorsTarget = this.#phase === 'dropped' ? 1 : 0;
    const rate =
      doorsTarget > this.#doorsOpen
        ? this.#phase === 'dropped'
          ? DOOR_SNAP_RATE
          : DOOR_CLOSE_RATE
        : DOOR_CLOSE_RATE;
    const step = rate * dt;
    this.#doorsOpen =
      doorsTarget > this.#doorsOpen
        ? Math.min(doorsTarget, this.#doorsOpen + step)
        : Math.max(doorsTarget, this.#doorsOpen - step);

    if (this.#cargo.length && (this.#phase === 'hoisting' || this.#phase === 'armed')) {
      const k = 1 - Math.exp(-T.levelRate * dt);
      // Above the pedestal zone, the target-drop subject glides to plate centre —
      // the load swings inward as it rises, crane-style. Gated by height so the
      // kinematic carry never sweeps a cube through the pedestal at ground level.
      const kCentre = 1 - Math.exp(-8 * dt);
      // Must sit BELOW the minimum target-drop door plane (0.62 at h = 0.6), and
      // above the glass top (0.465) with margin — the glide happens 15 cm clear.
      const clearOfPedestal = this.#doorPlaneY() > 0.6;
      for (const c of this.#cargo) {
        const ce = this.ctx.entities.get(c.id);
        if (!ce) continue;
        if (this.#centreId === c.id && clearOfPedestal) {
          c.dx += (0 - c.dx) * kCentre;
          c.dz += (0 - c.dz) * kCentre;
        }
        c.q = nlerpToLevel(c.q, k);
        this.ctx.physics.setKinematicTarget(
          ce.body,
          { x: c.dx, y: this.#doorPlaneY() + c.sideM / 2, z: c.dz },
          c.q,
        );
      }
    }
  }

  /** Where the cable end is headed, given the phase. */
  #cableTarget(): number {
    switch (this.#phase) {
      case 'hoisting':
      case 'armed':
        return this.floorTopYM() + this.targetHM + DOOR_DROP;
      case 'dropped':
        return this.#holdY;
      default:
        return T.restCableEndYM;
    }
  }

  /** Trapezoidal profile with a braking-distance check — no overshoot, no teleport. */
  #stepProfile(targetY: number, dt: number): void {
    const dy = targetY - this.#cableEndY;
    /*
     * Exact hits are arrivals. When a trip quantizes onto the v·dt grid the cable
     * lands PRECISELY on the target at speed: dy = 0 gives dir 0 — no brake, no
     * crossing clamp — and the profile sails through into a perpetual symmetric
     * limit cycle (±6.7 mm at ±0.4 m/s, measured live as the armed↔hoisting UI
     * flicker; user-caught with an 8″ hoist, 2026-08-25).
     */
    if (Math.abs(dy) < 1e-9) {
      this.#cableEndY = targetY;
      this.#hoistV = 0;
      return;
    }
    const dir = Math.sign(dy);
    const brakingM = (this.#hoistV * this.#hoistV) / (2 * T.hoistAccelMps2);
    const shouldBrake = Math.abs(dy) <= brakingM && Math.sign(this.#hoistV) === dir;
    const a = (shouldBrake ? -dir : dir) * T.hoistAccelMps2;
    this.#hoistV = Math.max(-T.hoistSpeedMps, Math.min(T.hoistSpeedMps, this.#hoistV + a * dt));
    let next = this.#cableEndY + this.#hoistV * dt;
    // >= / <=: LANDING ON the target while moving is a crossing too (same bug).
    if ((dy > 0 && next >= targetY) || (dy < 0 && next <= targetY)) {
      next = targetY;
      this.#hoistV = 0;
    }
    this.#cableEndY = next;
  }

  /** Per rendered frame: carriage, cable and doors at the interpolated state. */
  render(alpha: number): void {
    const y = this.#cableEndPrevY + (this.#cableEndY - this.#cableEndPrevY) * alpha;
    const doors = this.#doorsPrev + (this.#doorsOpen - this.#doorsPrev) * alpha;
    // The carriage rides the plate's centreline; the cargo keeps its own offsets.
    this.#placeVisuals(y, 0, 0, doors);
  }

  #placeVisuals(cableEndY: number, x: number, z: number, doorsOpen: number): void {
    this.#carriage.position.set(x, cableEndY, z);
    // Bi-fold stow: hinge lifts the outer panel just past vertical, the knuckle
    // folds the inner one back against it — a slim packet at each rail, out of the
    // fall path and inside the silhouette (17, third amendment).
    this.#leafL.rotation.z = doorsOpen * FOLD_HINGE;
    this.#foldL.rotation.z = -doorsOpen * FOLD_KNUCKLE;
    this.#leafR.rotation.z = -doorsOpen * FOLD_HINGE;
    this.#foldR.rotation.z = doorsOpen * FOLD_KNUCKLE;
    const len = Math.max(0.01, SHEAVE_Y - cableEndY);
    this.#cableMesh.position.set(x, cableEndY + len / 2, z);
    this.#cableMesh.scale.set(1, len, 1);
  }

  teardown(): void {
    this.unload();
    this.#removePlatform();
    this.ctx.scene.remove(this.#group);
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
  }
}

/** nlerp toward identity — at per-step angles, indistinguishable from slerp. */
function nlerpToLevel(q: Quat, t: number): Quat {
  const sign = q.w < 0 ? -1 : 1;
  const x = q.x + (0 - q.x) * t;
  const y = q.y + (0 - q.y) * t;
  const z = q.z + (0 - q.z) * t;
  const w = q.w + (sign - q.w) * t;
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}
