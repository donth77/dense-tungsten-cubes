import type { CombineRule, SurfaceId } from '../types.ts';

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
  /**
   * 08 §8.1 called this unsolvable — "no single rule reproduces the whole table (foam
   * wants the lower value, rubber and trampoline want the higher)". It is solvable,
   * because the rule is per-collider, not global: Rapier resolves a pair by taking the
   * higher-priority rule of the two (average < min < multiply < max).
   *
   * So damping materials claim `min` and springy ones claim `max`. A tungsten cube
   * (min, 0.2) thuds on concrete and dies in foam, while rubber (max, 0.75) outranks it
   * and bounces the cube anyway — which is right, a trampoline bounces a bowling ball.
   */
  restitutionRule: CombineRule;
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
    restitutionRule: 'min',
    voice: 'crack_concrete',
    /*
     * Cool blue-grey, and deliberately NOT a neutral grey.
     *
     * The cubes are neutral-to-warm greys, so a neutral floor gives a tungsten cube
     * almost no separation from its own background — the two sit at similar value in
     * the same hue family and the subject disappears into the ground. Shifting the
     * floor cool separates them by HUE instead of by brightness, which keeps the
     * chamber dim (so bright metals still pop) without crushing it to black and losing
     * the contact shadow.
     *
     * It also pairs with the warm key light (0xfff2e6): warm subject against cool
     * ground is the oldest separation trick there is, and it lands on the same
     * blueprint-navy family as the app chrome (13 §2).
     */
    baseColorLinear: [0.026, 0.032, 0.041],
    roughness: 0.92,
    metalness: 0,
  },
  steel: {
    id: 'steel',
    label: 'Steel',
    friction: 0.45,
    restitution: 0.6,
    restitutionRule: 'min',
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
    restitutionRule: 'min',
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
    restitutionRule: 'max', // springy wins the pair: a trampoline bounces anything you put on it
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
    restitutionRule: 'min', // kills the bounce of anything, however springy the cube
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
    restitutionRule: 'min',
    voice: 'tick_ice',
    baseColorLinear: [0.62, 0.72, 0.78],
    roughness: 0.12,
    metalness: 0,
  },
};
