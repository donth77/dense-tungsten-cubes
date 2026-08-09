import type { SurfaceId } from '../types.ts';

/**
 * Surface table (02 §5). MVP-minimal: contact coefficients + the audio voice key.
 *
 * IMPORTANT (08 §8.1): 02 §5's table reads like *pair* values ("CoR vs metal"), but
 * Rapier stores a coefficient per collider and combines the two — with the default
 * `Average` rule a 0.45 concrete floor under a 0.5 cube yields 0.475, and no single
 * rule reproduces the whole table. Treat these as **target behaviour**: the calibration
 * page tunes the surface number until the observed bounce matches the row.
 */

export interface SurfaceSpec {
  id: SurfaceId;
  label: string;
  friction: number;
  restitution: number;
  /** Audio voice key (08 §8.7). */
  voice: string;
  /** Linear sRGB base colour for the mat/floor material. */
  baseColorLinear: [number, number, number];
  roughness: number;
  metalness: number;
}

export const SURFACES: Readonly<Record<SurfaceId, SurfaceSpec>> = {
  concrete: {
    id: 'concrete',
    label: 'Concrete',
    friction: 0.55,
    restitution: 0.45,
    voice: 'crack_concrete',
    // Dim test chamber, not a showroom. Measured at M0 by sampling the framebuffer:
    // 0.18 linear rendered the floor at 43 % sRGB — brighter than the cube's own side
    // faces, which reads as a dark object on a light table rather than metal in a shop.
    baseColorLinear: [0.05, 0.049, 0.047],
    roughness: 0.92,
    metalness: 0,
  },
  steel: {
    id: 'steel',
    label: 'Steel',
    friction: 0.45,
    restitution: 0.6,
    voice: 'ring_steel',
    baseColorLinear: [0.56, 0.57, 0.58],
    roughness: 0.3,
    metalness: 1,
  },
  oak: {
    id: 'oak',
    label: 'Oak',
    friction: 0.4,
    restitution: 0.4,
    voice: 'knock_oak',
    baseColorLinear: [0.28, 0.18, 0.09],
    roughness: 0.7,
    metalness: 0,
  },
  rubber: {
    id: 'rubber',
    label: 'Rubber',
    friction: 0.9,
    restitution: 0.75,
    voice: 'thump_rubber',
    baseColorLinear: [0.035, 0.035, 0.038],
    roughness: 0.88,
    metalness: 0,
  },
  foam: {
    id: 'foam',
    label: 'Foam',
    friction: 0.8,
    restitution: 0.1,
    voice: 'fumpf_foam',
    baseColorLinear: [0.32, 0.3, 0.26],
    roughness: 0.98,
    metalness: 0,
  },
  ice: {
    id: 'ice',
    label: 'Ice',
    friction: 0.04,
    restitution: 0.1,
    voice: 'tick_ice',
    baseColorLinear: [0.62, 0.72, 0.78],
    roughness: 0.12,
    metalness: 0,
  },
};
