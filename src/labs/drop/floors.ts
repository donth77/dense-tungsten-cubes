import * as THREE from 'three';
import { config } from '../../config.ts';
import { PropStore } from '../../core/props.ts';
import { SURFACES } from '../../data/surfaces.ts';
import { loadTrampolineAsset } from './asset.ts';
import { hazardChevron } from './rigtex.ts';
import { CompliantPad, foamParams, trampolineParams } from '../shared/compliant-pad.ts';
import type { LabContext } from '../lab.ts';
import type { BodyHandle, SurfaceId } from '../../types.ts';

/**
 * The floor plate (16 §7). One floor mounted at a time; switching tears the old one
 * down completely — bodies, joints, meshes — and the plate's SurfaceId is what
 * `ImpactEvent.b` reports, so verdicts and voices key off one value.
 *
 * Materials are built here from the surface table rather than through `ctx.render`, so
 * the physics suite can mount floors against a bare scene — the same reason the
 * balance owns its own materials.
 */

/*
 * Reduced from six to three (user decision 2026-08-25): concrete, oak, and sand
 * "don't do much" — their whole identity was decal marks and slightly different
 * thuds. Steel is the rigid default; the pads carry the drama; glass joins in M3 C3.
 */
export type FloorId = 'steel' | 'trampoline' | 'foam';
export const FLOOR_IDS: readonly FloorId[] = ['steel', 'trampoline', 'foam'];
export const FLOOR_LABELS: Readonly<Record<FloorId, string>> = {
  steel: 'Steel',
  trampoline: 'Trampoline',
  foam: 'Foam',
};

const P = config.drop.plate;

export class Floors {
  #active: FloorId = 'steel';
  #bodies: BodyHandle[] = [];
  #pad: CompliantPad | null = null;
  #meshes: THREE.Object3D[] = [];
  readonly #disposables: { dispose(): void }[] = [];
  readonly #props: PropStore;
  /** Bumped per mount, so an asset resolving after a floor switch swaps into nothing. */
  #gen = 0;

  constructor(private readonly ctx: LabContext) {
    this.#props = new PropStore(ctx.physics);
  }

  get active(): FloorId {
    return this.#active;
  }
  get pad(): CompliantPad | null {
    return this.#pad;
  }
  /** The plate's top surface, where a resting cube's bottom face sits. */
  get topYM(): number {
    return this.#pad ? this.#pad.padTopRestY : P.topYM;
  }

  build(id: FloorId = 'steel'): void {
    this.mount(id);
  }

  mount(id: FloorId): void {
    this.#unmount();
    this.#active = id;
    const spec = SURFACES[id];
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...spec.baseColorLinear),
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    this.#disposables.push(mat);

    if (id === 'trampoline' || id === 'foam') {
      const params = id === 'trampoline' ? trampolineParams() : foamParams();
      const rest =
        id === 'trampoline'
          ? config.drop.pads.trampoline.restCentreYM
          : config.drop.pads.foam.restCentreYM;
      this.#pad = new CompliantPad(this.ctx.physics, params, { x: 0, z: 0 }, rest, P.halfM);
      /*
       * The mat visual is a GROUP bound to the pad body: it holds a placeholder disc
       * until the prepared asset resolves, then the asset's own mat — the binding
       * never changes, only the children (16 §14.1). The squash and the catch are the
       * body's real displacement, not an animation.
       */
      const matGroup = new THREE.Group();
      const frameGroup = new THREE.Group();
      this.ctx.scene.add(matGroup, frameGroup);
      this.#meshes.push(matGroup, frameGroup);
      this.#props.add(this.#pad.pad, matGroup);

      const standMat = new THREE.MeshStandardMaterial({
        color: id === 'trampoline' ? 0x2a2f36 : new THREE.Color().setRGB(0.26, 0.24, 0.2),
        roughness: 0.85,
        metalness: id === 'trampoline' ? 0.6 : 0,
      });
      this.#disposables.push(standMat);
      if (id === 'trampoline') {
        const phMat = new THREE.Mesh(
          (() => {
            const g = new THREE.CylinderGeometry(P.halfM * 0.95, P.halfM * 0.95, 0.02, 24);
            this.#disposables.push(g);
            return g;
          })(),
          mat,
        );
        matGroup.add(phMat);
        const legGeo = new THREE.BoxGeometry(0.05, rest, 0.05);
        this.#disposables.push(legGeo);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const leg = new THREE.Mesh(legGeo, standMat);
            leg.position.set(sx * (P.halfM - 0.06), rest / 2, sz * (P.halfM - 0.06));
            frameGroup.add(leg);
          }
        }
        const gen = this.#gen;
        void loadTrampolineAsset()
          .then((asset) => {
            if (gen !== this.#gen) return; // the floor moved on while we fetched
            matGroup.clear();
            asset.mat.removeFromParent();
            matGroup.add(asset.mat);
            frameGroup.clear();
            asset.frame.removeFromParent();
            frameGroup.add(asset.frame);
          })
          .catch(() => {
            /* placeholders stay — never a hole where the trampoline was */
          });
      } else {
        // A foam block IS a box; the surface material is the honest visual.
        const phMat = new THREE.Mesh(
          (() => {
            const g = new THREE.BoxGeometry(P.halfM * 2, 0.02, P.halfM * 2);
            this.#disposables.push(g);
            return g;
          })(),
          mat,
        );
        matGroup.add(phMat);
        const blockGeo = new THREE.BoxGeometry(P.halfM * 2, rest, P.halfM * 2);
        this.#disposables.push(blockGeo);
        const block = new THREE.Mesh(blockGeo, standMat);
        /*
         * The block hangs from the PAD-BOUND group, top at the pad, bottom at the
         * stage — so it compresses live with every stroke and sinks into the stage
         * when the pad is crushed flat. As static scenery it stood full height while
         * the crushed pad lay at 1 cm, and the cube "clipped through the foam"
         * (user-caught, 2026-08-25).
         */
        block.position.set(0, -rest / 2, 0);
        matGroup.add(block);
      }
    } else {
      const surface: SurfaceId = id;
      this.#bodies.push(
        this.ctx.physics.addStaticBox(
          { x: P.halfM, y: P.thicknessM / 2, z: P.halfM },
          { x: 0, y: P.topYM - P.thicknessM / 2, z: 0 },
          surface,
        ),
      );
      const geo = new THREE.BoxGeometry(P.halfM * 2, P.thicknessM, P.halfM * 2);
      this.#disposables.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, P.topYM - P.thicknessM / 2, 0);
      mesh.receiveShadow = true;
      this.ctx.scene.add(mesh);
      this.#meshes.push(mesh);
      // Any rigid plate takes juice splats — mess, not damage (18 §6 C2).
      this.ctx.fx.decals.setSplatTarget(mesh);
      /*
       * The rim frame that makes the plate READ as the landing zone. Concrete on the
       * concrete stage was literally invisible in the screenshot review (2026-08-24)
       * — a light steel border is the machine-shop way to mark a target.
       */
      // 17 §4 T3: the drop zone's functional edge gets the hazard chevron — the
      // machine-shop way to mark a target, in the palette's own warn amber.
      const chevron = hazardChevron();
      const rimMat = new THREE.MeshStandardMaterial({
        color: chevron ? 0xffffff : 0x8b959f,
        roughness: 0.55,
        metalness: 0.2,
        ...(chevron ? { map: chevron.map } : {}),
      });
      if (chevron) chevron.map.repeat.set(9, 1);
      const rimLong = new THREE.BoxGeometry(P.halfM * 2 + 0.1, 0.028, 0.05);
      const rimShort = new THREE.BoxGeometry(0.05, 0.028, P.halfM * 2 + 0.1);
      this.#disposables.push(rimMat, rimLong, rimShort);
      for (const sz of [-1, 1]) {
        const r1 = new THREE.Mesh(rimLong, rimMat);
        r1.position.set(0, P.topYM + 0.006, sz * (P.halfM + 0.025));
        const r2 = new THREE.Mesh(rimShort, rimMat);
        r2.position.set(sz * (P.halfM + 0.025), P.topYM + 0.006, 0);
        this.ctx.scene.add(r1, r2);
        this.#meshes.push(r1, r2);
      }
    }
  }

  beforePhysics(): void {
    this.#pad?.beforePhysics();
  }

  afterPhysics(): void {
    this.#props.capture();
  }

  render(alpha: number): void {
    this.#props.interpolate(alpha);
  }

  #unmount(): void {
    this.ctx.fx.decals.setTarget(null, null);
    this.ctx.fx.decals.setSplatTarget(null);
    this.#gen++;
    this.#props.clear();
    this.#pad?.teardown();
    this.#pad = null;
    for (const b of this.#bodies) this.ctx.physics.remove(b);
    this.#bodies = [];
    for (const m of this.#meshes) this.ctx.scene.remove(m);
    this.#meshes = [];
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
  }

  teardown(): void {
    this.#unmount();
  }
}
