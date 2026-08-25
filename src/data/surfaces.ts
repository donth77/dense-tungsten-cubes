import type { SurfaceId } from '../types.ts';

/**
 * Surface table (02 §5). MVP-minimal: contact coefficients + the audio voice key.
 *
 * 02 §5's table reads like *pair* values ("CoR vs metal") — and it is right to. Both
 * numbers below are the coefficient of the **reference metal** (hardened ferrous) against
 * this surface. `data/contact.ts` owns the model that turns a metal row and a surface row
 * into the pair the solver actually produces; read that file before touching a number
 * here, because these are no longer free knobs.
 *
 * Previously these were combined with a per-collider `min`/`max` rule, which collapsed
 * concrete, steel and oak to the same measured bounce (0.184/0.182/0.182 against a
 * configured 0.45/0.60/0.40) and averaged ice's friction with the cube's, giving 0.245
 * against a configured 0.04. Audit 14 PHY-01/PHY-02; no constant changed, only the law.
 */

export interface SurfaceSpec {
  id: SurfaceId;
  label: string;
  /**
   * Kinetic mu of the REFERENCE METAL on this surface. A material-pair property; see
   * `data/contact.ts`. Rapier has no static/kinetic split, so stiction is not modelled.
   */
  friction: number;
  /**
   * CoR of the REFERENCE METAL on this surface, flat face, low speed. A material-pair
   * property. Rapier's restitution is speed-independent — see `data/contact.ts`.
   */
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
  /*
   * The Drop Tower floors (16 §7.1). Sand kills a bounce almost completely — its 0.05
   * is the lowest in the table, and the crater decal is what makes the energy visible
   * (10 §4.9: no geometry change in v1).
   */
  sand: {
    id: 'sand',
    label: 'Sand',
    friction: 0.6,
    restitution: 0.05,
    voice: 'thump_sand',
    baseColorLinear: [0.43, 0.32, 0.18],
    roughness: 0.96,
    metalness: 0,
  },
  /*
   * The trampoline FABRIC, not the trampoline: the mat's throw comes from the membrane
   * contact (a 1.5 kg mat is a wall to a 44 g cube), while the travel and the capacity
   * gate defeat heavy cubes (16 §7.3 amendment). 0.85 is the vs-reference-metal pair
   * value, like every number in this column.
   */
  trampoline: {
    id: 'trampoline',
    label: 'Trampoline',
    friction: 0.8,
    restitution: 0.85,
    voice: 'boing_trampoline',
    baseColorLinear: [0.04, 0.042, 0.05],
    roughness: 0.9,
    metalness: 0,
  },
};
