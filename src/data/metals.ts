import type { CombineRule, MetalId } from '../types.ts';

/**
 * The metal table (02 §3/§4). MVP-minimal: densities, contact coefficients and base
 * colours. The real-world twins catalog and per-metal audio voices land at M1 step 12 —
 * this file grows, it doesn't get replaced.
 *
 * No three.js import here (08 §5.2) — base colours are plain linear-sRGB triples and
 * `core/render.ts` turns them into THREE.Color. That is exactly why the rule exists.
 */

export interface MetalSpec {
  id: MetalId;
  label: string;
  symbol: string;
  /**
   * kg/m³. Undefined for tungsten, whose density is a function of purity —
   * use `densityOf()` rather than reading this directly.
   */
  densityKgM3?: number;
  /** Linear sRGB base colour, metalness 1.0. */
  baseColorLinear: [number, number, number];
  roughness: number;
  friction: number;
  /**
   * Coefficient of restitution against a hard surface. NOT one shared value.
   *
   * 08 §10 specified a single "metal CoR 0.5" for all five metals. Measured at M0, that
   * was wrong twice: 0.5 makes tungsten heavy alloy return ~22 % of its drop height off
   * concrete and ~68 % off another tungsten cube (two free bodies recoil, so the pair
   * bounces livelier than either material alone), and identical values across all five
   * metals delete the Sandbox's whole premise that each metal sounds AND bounces
   * differently (§9.1).
   *
   * WHA is dense and internally damped — the same property that makes its voice a dead
   * TUNK rather than a ring (02 §10) — so it belongs at the bottom of this range, and
   * hardened ferrous metal at the top.
   */
  restitution: number;
  /** See CombineRule. Metals damp, so they claim `min` and let a springy surface win. */
  restitutionRule: CombineRule;
}

/**
 * ASTM B777 anchor points: tungsten content (% W) → density (g/cm³), 02 §4.
 * Classes 1–4 are 90 / 92.5 / 95 / 97 % W. 93 % is a common *supplier* grade, not an
 * ASTM class — it sits on the curve but doesn't get a class label (02 §3).
 */
const WHA_ANCHORS: readonly (readonly [purityPctW: number, densityGCm3: number])[] = [
  [90, 17.0],
  [92.5, 17.5],
  [93, 17.7],
  [95, 18.0],
  [97, 18.5],
];

export const WHA_PURITY_MIN = 90;
export const WHA_PURITY_MAX = 97;
export const WHA_PURITY_DEFAULT = 95; // Class 3 — what consumer desk cubes actually are

/**
 * Tungsten heavy alloy density from tungsten content, linearly interpolated between
 * the ASTM anchors and clamped to the real product range.
 *
 * @param purityPctW tungsten content, 90–97 (%)
 * @returns density in kg/m³
 */
export function whaDensity(purityPctW: number): number {
  const p = Math.min(WHA_PURITY_MAX, Math.max(WHA_PURITY_MIN, purityPctW));
  const first = WHA_ANCHORS[0]!;
  const last = WHA_ANCHORS[WHA_ANCHORS.length - 1]!;
  if (p <= first[0]) return first[1] * 1000;
  if (p >= last[0]) return last[1] * 1000;

  for (let i = 1; i < WHA_ANCHORS.length; i++) {
    const lo = WHA_ANCHORS[i - 1]!;
    const hi = WHA_ANCHORS[i]!;
    if (p <= hi[0]) {
      const t = (p - lo[0]) / (hi[0] - lo[0]);
      return (lo[1] + (hi[1] - lo[1]) * t) * 1000;
    }
  }
  /* istanbul ignore next — unreachable: p is clamped into the anchor range above. */
  return last[1] * 1000;
}

export const METALS: Readonly<Record<MetalId, MetalSpec>> = {
  // Base colours from physicallybased.info (linear sRGB), except W — see note below.
  W: {
    id: 'W',
    label: 'Tungsten',
    symbol: 'W',
    // Density comes from whaDensity(purity); no fixed value.
    // NOTE: this is a *tuned* value for sintered W-Ni-Fe heavy alloy, not pure tungsten —
    // WHA reads as a dark warm grey (01 art direction). Re-verify against a real cube.
    baseColorLinear: [0.504, 0.498, 0.478],
    roughness: 0.35, // machined WHA is duller than a polished comparison metal
    friction: 0.45,
    restitution: 0.2, // dense, internally damped — the dead TUNK material
    restitutionRule: 'min',
  },
  Cu: {
    id: 'Cu',
    label: 'Copper',
    symbol: 'Cu',
    densityKgM3: 8960,
    baseColorLinear: [0.955, 0.638, 0.538],
    roughness: 0.25,
    friction: 0.45,
    restitution: 0.3, // soft, deforms readily, low rebound
    restitutionRule: 'min',
  },
  Fe: {
    id: 'Fe',
    label: 'Iron',
    symbol: 'Fe',
    densityKgM3: 7870,
    baseColorLinear: [0.56, 0.57, 0.58],
    roughness: 0.25,
    friction: 0.45,
    restitution: 0.6, // hardened ferrous metal is the classic bouncy one
    restitutionRule: 'min',
  },
  Ti: {
    id: 'Ti',
    label: 'Titanium',
    symbol: 'Ti',
    densityKgM3: 4510,
    baseColorLinear: [0.542, 0.497, 0.449],
    roughness: 0.25,
    friction: 0.45,
    restitution: 0.55, // springy: high strength for its stiffness
    restitutionRule: 'min',
  },
  Al: {
    id: 'Al',
    label: 'Aluminum',
    symbol: 'Al',
    densityKgM3: 2700,
    baseColorLinear: [0.912, 0.914, 0.92],
    roughness: 0.25,
    friction: 0.45,
    restitution: 0.35, // moderate, and it dents — plastic deformation eats the energy
    restitutionRule: 'min',
  },
};

/**
 * Density for a spec. Derived, never stored (08 §5.7) — the purity slider changes this
 * answer without anything needing to be invalidated.
 *
 * @returns kg/m³
 */
export function densityOf(metal: MetalId, purityPctW = WHA_PURITY_DEFAULT): number {
  if (metal === 'W') return whaDensity(purityPctW);
  return METALS[metal].densityKgM3!;
}

/** Mass of a solid cube, kg. */
export function cubeMassKg(metal: MetalId, sideM: number, purityPctW?: number): number {
  return densityOf(metal, purityPctW) * sideM ** 3;
}

/**
 * The ASTM class label for a purity, or the bracketing pair for a free slider position
 * (08 §16.7). The honesty rule (01 pillar 2) applies to grade labels too — 94 % is not
 * "Class 3", it is between Class 2 and 3.
 */
export function astmClassLabel(purityPctW: number): string {
  const CLASSES: readonly (readonly [pct: number, cls: number])[] = [
    [90, 1],
    [92.5, 2],
    [95, 3],
    [97, 4],
  ];
  const exact = CLASSES.find(([pct]) => Math.abs(pct - purityPctW) < 0.05);
  if (exact) return `Class ${exact[1]}`;
  if (purityPctW < 90) return 'Class 1';
  if (purityPctW > 97) return 'Class 4';
  for (let i = 1; i < CLASSES.length; i++) {
    const lo = CLASSES[i - 1]!;
    const hi = CLASSES[i]!;
    if (purityPctW < hi[0]) return `between Class ${lo[1]} and ${hi[1]}`;
  }
  /* istanbul ignore next — unreachable: purity is bracketed by the checks above. */
  return 'Class 3';
}
