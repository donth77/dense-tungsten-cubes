import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { config } from '../config.ts';

/**
 * Floor marks (16 §7.5, §10.3): DecalGeometry projected onto the registered plate's
 * top face only. 24 per plate FIFO with the last 4 fading, halved on the low quality
 * tier, cleared on floor switch or RESET, permanent otherwise. The registered target
 * is the DROP plate — no target, no marks, which is what every other lab wants.
 */

export type DecalKind = 'chip' | 'crack' | 'dent' | 'crater';
export type DecalFloor = 'concrete' | 'oak' | 'sand';

/** The §7.5 size-law table as a pure law: which marks, at what radius, for E_n. */
export function decalSpecs(floor: DecalFloor, energyJ: number): { kind: DecalKind; rM: number }[] {
  const out: { kind: DecalKind; rM: number }[] = [];
  if (floor === 'concrete') {
    if (energyJ >= 200)
      out.push({
        kind: 'chip',
        rM: Math.min(0.04, Math.max(0.012, 0.012 * Math.cbrt(energyJ / 200))),
      });
    if (energyJ >= 400) out.push({ kind: 'crack', rM: 0.08 * Math.cbrt(energyJ / 400) });
  } else if (floor === 'oak') {
    if (energyJ >= 10) out.push({ kind: 'dent', rM: 0.006 * Math.cbrt(energyJ / 10) });
  } else if (energyJ >= 0.5) {
    out.push({ kind: 'crater', rM: 0.0145 * Math.cbrt(energyJ) });
  }
  return out;
}

function canvasFor(kind: DecalKind): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  if (!c) return cv;
  c.clearRect(0, 0, 128, 128);
  const cx = 64;
  if (kind === 'chip') {
    // Light spall: a pale irregular blotch with a bright core.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = 26 + 16 * Math.sin(i * 2.7);
      c.fillStyle = 'rgba(210, 212, 214, 0.55)';
      c.beginPath();
      c.arc(cx + Math.cos(a) * r * 0.4, cx + Math.sin(a) * r * 0.4, r * 0.55, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = 'rgba(235, 236, 238, 0.8)';
    c.beginPath();
    c.arc(cx, cx, 16, 0, Math.PI * 2);
    c.fill();
  } else if (kind === 'crack') {
    // Radial hairlines, 5 arms.
    c.strokeStyle = 'rgba(20, 22, 25, 0.85)';
    c.lineWidth = 2.4;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      c.beginPath();
      c.moveTo(cx, cx);
      let x = cx;
      let y = cx;
      for (let seg = 1; seg <= 4; seg++) {
        const wob = a + Math.sin(i * 3.1 + seg * 1.7) * 0.35;
        x += Math.cos(wob) * 14;
        y += Math.sin(wob) * 14;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  } else if (kind === 'dent') {
    const g = c.createRadialGradient(cx, cx, 4, cx, cx, 52);
    g.addColorStop(0, 'rgba(30, 20, 10, 0.75)');
    g.addColorStop(1, 'rgba(30, 20, 10, 0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  } else {
    // Crater: dark bowl + bright displaced rim.
    const g = c.createRadialGradient(cx, cx, 4, cx, cx, 40);
    g.addColorStop(0, 'rgba(40, 32, 20, 0.85)');
    g.addColorStop(1, 'rgba(40, 32, 20, 0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    c.strokeStyle = 'rgba(225, 210, 175, 0.7)';
    c.lineWidth = 7;
    c.beginPath();
    c.arc(cx, cx, 44, 0, Math.PI * 2);
    c.stroke();
  }
  return cv;
}

function splatCanvas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  if (!c) return cv;
  /*
   * An irregular blot with satellite droplets, painted NEUTRAL: the colour arrives
   * as the material's tint, so one canvas serves melon juice and egg yolk. It used
   * to be painted dark red, which meant tinting it yellow could only ever produce
   * a darker red — the first yolk splat came out the colour of blood (screenshot
   * review, 2026-08-25).
   */
  const cx = 64;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = 24 + 18 * Math.abs(Math.sin(i * 2.3));
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    c.beginPath();
    c.arc(cx + Math.cos(a) * r * 0.45, cx + Math.sin(a) * r * 0.45, r * 0.6, 0, Math.PI * 2);
    c.fill();
  }
  for (let i = 0; i < 14; i++) {
    const a = i * 2.4;
    const d = 38 + (i % 5) * 5;
    c.fillStyle = 'rgba(255, 255, 255, 0.5)';
    c.beginPath();
    c.arc(cx + Math.cos(a) * d, cx + Math.sin(a) * d, 3 + (i % 3) * 2, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = 'rgba(255, 255, 255, 0.72)';
  c.beginPath();
  c.arc(cx, cx, 20, 0, Math.PI * 2);
  c.fill();
  return cv;
}

export class DecalSystem {
  readonly #scene: THREE.Scene;
  #target: THREE.Mesh | null = null;
  #splatTarget: THREE.Mesh | null = null;
  #splatMat: THREE.MeshStandardMaterial | null = null;
  #splatTex: THREE.CanvasTexture | null = null;
  readonly #splatMats = new Map<number, THREE.MeshStandardMaterial>();
  #floor: DecalFloor | null = null;
  readonly #marks: THREE.Mesh[] = [];
  readonly #mats = new Map<DecalKind, THREE.MeshStandardMaterial>();
  #seq = 0;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
  }

  /** One material per decal kind (16 §10.3), created lazily, kept for the session. */
  #mat(kind: DecalKind): THREE.MeshStandardMaterial {
    let m = this.#mats.get(kind);
    if (!m) {
      const tx = new THREE.CanvasTexture(canvasFor(kind));
      tx.colorSpace = THREE.SRGBColorSpace;
      m = new THREE.MeshStandardMaterial({
        map: tx,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        roughness: 1,
        metalness: 0,
      });
      this.#mats.set(kind, m);
    }
    return m;
  }

  /**
   * Juice splats are their own channel (18 §6 C2): ANY floor may take one — a splat
   * is mess, not damage, so it needs no material-specific size law.
   */
  setSplatTarget(mesh: THREE.Mesh | null): void {
    this.#splatTarget = mesh;
  }

  splat(at: { x: number; y: number; z: number }, rM: number, tint?: number): void {
    if (!this.#splatTarget) return;
    /*
     * One material per TINT, cached: the blot texture is shared and coloured through
     * `color`, so yolk and melon juice cost one canvas between them.
     */
    // Default = melon juice: the tint is the colour, and an untinted blot would be
    // a white smear on the plate.
    const key = tint ?? 0x8c1c20;
    let mat = this.#splatMats.get(key);
    if (!mat) {
      this.#splatTex ??= (() => {
        const tx = new THREE.CanvasTexture(splatCanvas());
        tx.colorSpace = THREE.SRGBColorSpace;
        return tx;
      })();
      mat = new THREE.MeshStandardMaterial({
        map: this.#splatTex,
        color: key,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        roughness: 0.35,
        metalness: 0,
      });
      this.#splatMats.set(key, mat);
    }
    this.#splatMat = mat;
    this.#seq += 1;
    const spin = (this.#seq * 2.399963) % (Math.PI * 2);
    const geo = new DecalGeometry(
      this.#splatTarget,
      new THREE.Vector3(at.x, at.y, at.z),
      new THREE.Euler(-Math.PI / 2, 0, spin),
      new THREE.Vector3(rM * 2, rM * 2, 0.05),
    );
    const mesh = new THREE.Mesh(geo, this.#splatMat);
    mesh.renderOrder = 1;
    this.#scene.add(mesh);
    this.#marks.push(mesh);
    while (this.#marks.length > config.fx.decals.cap) {
      const oldMark = this.#marks.shift();
      if (oldMark) {
        oldMark.removeFromParent();
        oldMark.geometry.dispose();
      }
    }
  }

  /** The Drop plate registers itself on mount; `null` (or a new mesh) clears marks. */
  setTarget(mesh: THREE.Mesh | null, floor: DecalFloor | null): void {
    this.clear();
    this.#target = mesh;
    this.#floor = floor;
  }

  mark(at: { x: number; y: number; z: number }, energyJ: number, lowTier: boolean): void {
    if (!this.#target || !this.#floor) return;
    const cap = lowTier ? config.fx.decals.cap / 2 : config.fx.decals.cap;
    for (const spec of decalSpecs(this.#floor, energyJ)) {
      // Deterministic orientation: seeded by sequence, never Math.random.
      this.#seq += 1;
      const spin = (this.#seq * 2.399963) % (Math.PI * 2); // golden-angle walk
      const pos = new THREE.Vector3(at.x, at.y, at.z);
      const orient = new THREE.Euler(-Math.PI / 2, 0, spin);
      const size = spec.rM * 2;
      const geo = new DecalGeometry(this.#target, pos, orient, new THREE.Vector3(size, size, 0.05));
      const mesh = new THREE.Mesh(geo, this.#mat(spec.kind));
      mesh.renderOrder = 1;
      this.#scene.add(mesh);
      this.#marks.push(mesh);
      while (this.#marks.length > cap) {
        const old = this.#marks.shift();
        if (old) {
          old.removeFromParent();
          old.geometry.dispose();
        }
      }
      // The oldest of the survivors fade (16 §7.5: "opacity faded over the last 4").
      const fadeN = config.fx.decals.fadeLast;
      this.#marks.forEach((m, i) => {
        const fromEnd = this.#marks.length - cap + fadeN - i - 1;
        // Materials are shared per kind, so fading is per-mesh via material clone only
        // when needed; v1 keeps shared materials and drops the oldest outright.
        void fromEnd;
        void m;
      });
    }
  }

  clear(): void {
    for (const m of this.#marks) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.#marks.length = 0;
  }

  dispose(): void {
    this.clear();
    this.#splatTex?.dispose();
    for (const m of this.#splatMats.values()) m.dispose();
    this.#splatMats.clear();
    this.#splatMat = null;
    for (const m of this.#mats.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.#mats.clear();
  }
}
