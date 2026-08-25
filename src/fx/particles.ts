import * as THREE from 'three';
import { config } from '../config.ts';
import { SURFACES } from '../data/surfaces.ts';
import type { SurfaceId } from '../types.ts';

/**
 * Impact puffs (16 §10.2): one pooled Points system, 256 slots, recycled
 * oldest-first, one draw call. Colours come from the struck surface's own base
 * colour; sparks and chips override. Foam and the trampoline stay silent — a catch
 * is not a strike.
 */

export interface BurstSpec {
  count: number;
  lifeS: number;
  color: [number, number, number];
  /** Initial speed range, m/s. */
  vMin: number;
  vMax: number;
  /** Upward bias 0..1 (sand sprays up, sparks fly flat). */
  up: number;
}

/** The §10.2 recipe table as a pure law, unit-testable. `null` = no particles. */
export function burstSpec(surface: SurfaceId, s: number, energyJ: number): BurstSpec | null {
  if (energyJ < config.fx.particles.minJ) return null;
  const base = SURFACES[surface].baseColorLinear;
  const lift = (c: readonly [number, number, number], k: number): [number, number, number] => [
    Math.min(1, c[0] * k),
    Math.min(1, c[1] * k),
    Math.min(1, c[2] * k),
  ];
  switch (surface) {
    case 'concrete':
      return {
        count: Math.round(6 + 42 * s),
        lifeS: 0.9,
        color: lift(base, 1.6),
        vMin: 0.4,
        vMax: 1.6,
        up: 0.75,
      };
    case 'steel':
      if (energyJ < config.fx.particles.sparkMinJ) return null;
      return {
        count: Math.round(10 * s),
        lifeS: 0.3,
        color: [1, 0.85, 0.55],
        vMin: 1.5,
        vMax: 3.5,
        up: 0.35,
      };
    case 'oak':
      return {
        count: Math.round(4 + 16 * s),
        lifeS: 0.8,
        color: lift(base, 1.4),
        vMin: 0.5,
        vMax: 1.8,
        up: 0.65,
      };
    case 'sand':
      return {
        count: Math.min(60, Math.round(10 + 50 * s)),
        lifeS: 1.0,
        color: lift(base, 1.3),
        vMin: 0.5,
        vMax: 2.2,
        up: 0.85,
      };
    default:
      return null; // foam, trampoline, rubber, ice: nothing in v1
  }
}

/**
 * Watermelon juice (18 §6 C2 realism audit). A melon is ~92% water in a shell:
 * as the cube-plate gap closes the flesh must escape SIDEWAYS — squeeze-flow — so
 * the spray is fast, flat and radial, and it scales with the energy the rind
 * couldn't absorb. This is the fluid: particles for the flight, decals for the
 * landing. A real solver-coupled fluid would cost the frame budget and Rapier has
 * none; this is the honest cartoon of the real mechanism.
 */
export function juiceSpec(excessJ: number): BurstSpec {
  return {
    count: Math.min(90, Math.round(24 + excessJ * 0.06)),
    lifeS: 0.9,
    color: [0.5, 0.05, 0.06],
    vMin: 0.8,
    vMax: Math.min(7, 1.5 + Math.sqrt(Math.max(0, excessJ)) * 0.16),
    up: 0.3,
  };
}

/**
 * Fine glass debris at heavy overkill — real fragmentation multiplies with energy,
 * and ten rigid shards can't show it; a short-lived glitter cloud can.
 */
export function glintSpec(excessJ: number): BurstSpec {
  return {
    count: Math.min(40, Math.round(10 + excessJ * 0.03)),
    lifeS: 0.5,
    color: [0.85, 0.92, 1],
    vMin: 1,
    vMax: Math.min(5, 1 + Math.sqrt(Math.max(0, excessJ)) * 0.12),
    up: 0.45,
  };
}

const POOL = 256;

export class ImpactPuffs {
  readonly #points: THREE.Points;
  readonly #geo: THREE.BufferGeometry;
  readonly #posAttr: THREE.BufferAttribute;
  readonly #colAttr: THREE.BufferAttribute;
  readonly #mat: THREE.PointsMaterial;
  readonly #pos: Float32Array;
  readonly #col: Float32Array;
  readonly #vel = new Float32Array(POOL * 3);
  readonly #life = new Float32Array(POOL); // remaining seconds; ≤0 = dead
  #cursor = 0;
  /** Deterministic pool-local PRNG: FX only, never physics. */
  #rand = 1;

  constructor(scene: THREE.Scene) {
    this.#pos = new Float32Array(POOL * 3).fill(-999);
    this.#col = new Float32Array(POOL * 3);
    this.#geo = new THREE.BufferGeometry();
    this.#posAttr = new THREE.BufferAttribute(this.#pos, 3);
    this.#colAttr = new THREE.BufferAttribute(this.#col, 3);
    this.#geo.setAttribute('position', this.#posAttr);
    this.#geo.setAttribute('color', this.#colAttr);
    this.#mat = new THREE.PointsMaterial({
      size: 0.02,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.#points = new THREE.Points(this.#geo, this.#mat);
    this.#points.frustumCulled = false;
    scene.add(this.#points);
  }

  #next01(): number {
    // mulberry32-style: deterministic across runs, seeded per-construction.
    this.#rand = (this.#rand + 0x6d2b79f5) | 0;
    let t = this.#rand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  burst(
    at: { x: number; y: number; z: number },
    surface: SurfaceId,
    s: number,
    energyJ: number,
    opts: { lowTier: boolean; reducedMotion: boolean },
  ): void {
    const spec = burstSpec(surface, s, energyJ);
    if (!spec) return;
    this.emit(at, spec, opts);
  }

  /** Direct emission for lab-authored bursts (juice, glints) — same pool, same laws. */
  emit(
    at: { x: number; y: number; z: number },
    spec: BurstSpec,
    opts: { lowTier: boolean; reducedMotion: boolean },
  ): void {
    let n = spec.count;
    if (opts.lowTier) n = Math.ceil(n / 4); // low tier quarters counts (16 §10.2)
    if (opts.reducedMotion) n = Math.ceil(n / 2); // particles are not camera motion
    for (let i = 0; i < n; i++) {
      const k = this.#cursor;
      this.#cursor = (this.#cursor + 1) % POOL;
      const az = this.#next01() * Math.PI * 2;
      const v = spec.vMin + (spec.vMax - spec.vMin) * this.#next01();
      const upFrac = spec.up * (0.5 + 0.5 * this.#next01());
      const flat = v * (1 - upFrac);
      this.#pos[k * 3] = at.x;
      this.#pos[k * 3 + 1] = at.y + 0.01;
      this.#pos[k * 3 + 2] = at.z;
      this.#vel[k * 3] = Math.cos(az) * flat;
      this.#vel[k * 3 + 1] = v * upFrac;
      this.#vel[k * 3 + 2] = Math.sin(az) * flat;
      this.#col[k * 3] = spec.color[0];
      this.#col[k * 3 + 1] = spec.color[1];
      this.#col[k * 3 + 2] = spec.color[2];
      this.#life[k] = spec.lifeS * (0.6 + 0.6 * this.#next01());
    }
    this.#colAttr.needsUpdate = true;
  }

  /** Ballistic integration on the render clock — FX never touch the physics step. */
  update(dtS: number): void {
    let any = false;
    for (let k = 0; k < POOL; k++) {
      const life = this.#life[k] ?? 0;
      if (life <= 0) continue;
      any = true;
      const left = life - dtS;
      this.#life[k] = left;
      const i = k * 3;
      if (left <= 0) {
        this.#pos[i + 1] = -999; // park the dead slot below the kill plane
        continue;
      }
      let vx = this.#vel[i] ?? 0;
      let vy = (this.#vel[i + 1] ?? 0) - 9.81 * dtS;
      let vz = this.#vel[i + 2] ?? 0;
      const x = (this.#pos[i] ?? 0) + vx * dtS;
      let y = (this.#pos[i + 1] ?? 0) + vy * dtS;
      const z = (this.#pos[i + 2] ?? 0) + vz * dtS;
      // Ground stop: dust settles rather than raining through the stage.
      if (y < 0.005) {
        y = 0.005;
        vx *= 0.6;
        vy = 0;
        vz *= 0.6;
      }
      this.#pos[i] = x;
      this.#pos[i + 1] = y;
      this.#pos[i + 2] = z;
      this.#vel[i] = vx;
      this.#vel[i + 1] = vy;
      this.#vel[i + 2] = vz;
    }
    if (any) this.#posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.#points.removeFromParent();
    this.#geo.dispose();
    this.#mat.dispose();
  }
}
