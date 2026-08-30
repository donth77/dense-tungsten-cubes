import * as THREE from 'three';
import { SURFACES } from '../../data/surfaces.ts';
import { M_PER_IN } from '../../data/format.ts';
import type { Lab, LabContext } from '../lab.ts';
import type { BodyHandle, MetalId, SurfaceId } from '../../types.ts';

/**
 * Sandbox (08 §9.1) — the material-intuition lab.
 *
 * Five mats in a row means the same cube dropped across them produces five different
 * sounds and five different bounces. That only became true once restitution stopped
 * being one shared value for all metals (see data/metals.ts).
 */

/** The mats, left to right. Concrete is the floor itself, so it isn't a mat. */
const MATS: readonly SurfaceId[] = ['steel', 'oak', 'rubber', 'foam', 'ice'];

const MAT_SIZE_M = 0.17;
const MAT_THICK_M = 0.02;
const MAT_SPACING_M = 0.2;
const MAT_Z_M = -0.26;

/**
 * The 1 kg set (02 §4). Sides chosen so every cube weighs the same to 3 digits, and
 * ordered smallest to largest so the size gradient IS the density gradient.
 *
 * Gold leads, which is the whole reason it is worth having in this line-up: at 19,320
 * it is denser than any heavy-alloy grade the purity slider reaches, so a kilo of gold
 * is physically smaller than a kilo of tungsten cube. The one place the toy can show
 * that is right here, at the head of the row.
 */
export const SAME_MASS_IN: readonly (readonly [MetalId, number])[] = [
  ['Au', 1.47],
  ['W', 1.5],
  ['Cu', 1.9],
  ['Fe', 1.98],
  ['Ti', 2.38],
  ['Al', 2.83],
];

/** Same order as the spawner's swatch row, so the two never disagree. */
export const LINEUP_METALS: readonly MetalId[] = ['W', 'Au', 'Cu', 'Fe', 'Ti', 'Al'];
const LINEUP_SPACING_M = 0.085;
/** Everything the lab lays out fits inside this radius of the stage centre. */
const STAGE_RADIUS_M = 0.55;

export class SandboxLab implements Lab {
  readonly id = 'sandbox' as const;
  readonly title = 'Sandbox';
  readonly spawnOnEntry = true;

  #ctx: LabContext | null = null;
  readonly #bodies: BodyHandle[] = [];
  readonly #objects: THREE.Object3D[] = [];
  readonly #disposables: { dispose(): void }[] = [];

  build(ctx: LabContext): void {
    this.#ctx = ctx;
    this.#buildMats(ctx);
    this.#buildPanel(ctx);
    // Frame the mats and the staging strip, not a single cube.
    // The cube is the subject; the mats are scenery and may run off a phone's edges.
    ctx.camera.frameRadius(STAGE_RADIUS_M, { fit: 'subject' });
  }

  #buildMats(ctx: LabContext): void {
    const startX = -((MATS.length - 1) * MAT_SPACING_M) / 2;
    MATS.forEach((surface, i) => {
      const x = startX + i * MAT_SPACING_M;
      const y = MAT_THICK_M / 2;

      this.#bodies.push(
        ctx.physics.addStaticBox(
          { x: MAT_SIZE_M / 2, y: MAT_THICK_M / 2, z: MAT_SIZE_M / 2 },
          { x, y, z: MAT_Z_M },
          surface,
        ),
      );

      const geo = new THREE.BoxGeometry(MAT_SIZE_M, MAT_THICK_M, MAT_SIZE_M);
      const mat = ctx.render.surfaceMaterial(surface);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, MAT_Z_M);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      ctx.scene.add(mesh);
      this.#objects.push(mesh);
      this.#disposables.push(geo, mat);

      this.#objects.push(this.#label(SURFACES[surface].label, x, MAT_Z_M));
      ctx.scene.add(this.#objects[this.#objects.length - 1]!);
    });
  }

  /**
   * Mat names are drawn into the 3D scene as sprites rather than as DOM.
   *
   * This is the one sanctioned exception to 13 §6's "canvas text is forbidden": these
   * labels belong to a *world object* and have to track it through orbit and zoom.
   * A DOM label would need per-frame projection and would fight the panel layer.
   */
  #label(text: string, x: number, z: number): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, c.width, c.height);
    g.font = '600 34px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = '#9aa7b2';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text.toUpperCase(), c.width / 2, c.height / 2);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, 0.035, z + MAT_SIZE_M / 2 + 0.05);
    sprite.scale.set(0.11, 0.028, 1);
    this.#disposables.push(tex, mat);
    return sprite;
  }

  #buildPanel(ctx: LabContext): void {
    ctx.ui.setControls([
      {
        label: 'Line-ups',
        controls: [
          { label: 'Same size', onSelect: () => this.#sameSize(ctx) },
          { label: 'Same mass', onSelect: () => this.#sameMass(ctx) },
        ],
      },
    ]);
  }

  /** Five 2" cubes, one per metal — the "same size, wildly different mass" shot. */
  #sameSize(ctx: LabContext): void {
    this.#clearStaging(ctx);
    const startX = -((LINEUP_METALS.length - 1) * LINEUP_SPACING_M) / 2;
    LINEUP_METALS.forEach((metal, i) => {
      const sideM = 2 * M_PER_IN;
      ctx.entities.spawn(
        { metal, sideM, ...(metal === 'W' ? { purityPctW: 95 } : {}) },
        { x: startX + i * LINEUP_SPACING_M, y: sideM / 2 + 0.002, z: 0.2 },
      );
    });
    ctx.ui.toast('Same size — six 2″ cubes, 2.5 kg down to 0.35 kg');
  }

  /** The 1 kg set — "same mass, wildly different size", the other killer screenshot. */
  #sameMass(ctx: LabContext): void {
    this.#clearStaging(ctx);
    const widths = SAME_MASS_IN.map(([, inches]) => inches * M_PER_IN);
    const total = widths.reduce((a, b) => a + b, 0) + 0.03 * (widths.length - 1);
    let x = -total / 2;
    SAME_MASS_IN.forEach(([metal, inches], i) => {
      const sideM = inches * M_PER_IN;
      x += sideM / 2;
      ctx.entities.spawn(
        { metal, sideM, ...(metal === 'W' ? { purityPctW: 95 } : {}) },
        { x, y: sideM / 2 + 0.002, z: 0.2 },
      );
      x += sideM / 2 + 0.03;
      void i;
    });
    ctx.ui.toast('Same mass — every cube here weighs about 1 kg');
  }

  /** Both line-ups clear the staging strip first (08 §9.1) so they never pile up. */
  #clearStaging(ctx: LabContext): void {
    for (const e of [...ctx.entities.all]) {
      if (e.heldBy === null && e.curr.p.z > 0.12) ctx.entities.despawn(e.id);
    }
  }

  teardown(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const h of this.#bodies) ctx.physics.remove(h);
    for (const o of this.#objects) ctx.scene.remove(o);
    for (const d of this.#disposables) d.dispose();
    this.#bodies.length = 0;
    this.#objects.length = 0;
    this.#disposables.length = 0;
    this.#ctx = null;
  }
}
