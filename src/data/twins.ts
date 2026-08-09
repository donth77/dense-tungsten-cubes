import type { MetalId } from '../types.ts';

/**
 * Real-world twins — the "…which is the 1 kg cube" line on the info card (08 §8.8).
 *
 * Split out of `metals.ts` rather than added to it: that file was already near 08 §4's
 * ~300-line soft cap, and the rule there is that a file which wants to be bigger is two
 * modules. Nothing else about the data layer changes.
 *
 * Two different jobs live here, and they must not be confused:
 *   1. PRODUCT twins  — a spawned cube matching a real thing you can buy (size-based).
 *   2. MASS anchors   — "this weighs about as much as a bowling ball" (mass-based).
 * The first is a factual claim about a product and is held to 01's honesty rule; the
 * second is a comparison aid and is explicitly approximate.
 */

export interface CubeTwin {
  metal: MetalId;
  sideIn: number;
  /** Short label for the info card. */
  label: string;
  /** The honest caveat, where the marketing name and the physics disagree. */
  note?: string;
}

/**
 * Cubes you can actually buy or point at.
 *
 * Deliberately short. Only entries the docs vouch for are here: 02 §3 covers the 1.5"
 * kilo cube and its nominal-vs-marketing gap, 02/08 §13 give the 4" cube at 41.62 lb as
 * an exact catalog figure, and 01 covers the 14.545" one-ton NFT cube. Plausible-looking
 * SKUs are NOT invented to pad this list — a fabricated product claim would breach
 * pillar 2 (01) far more seriously than a short catalog does.
 */
export const CUBE_TWINS: readonly CubeTwin[] = [
  {
    metal: 'W',
    sideIn: 1.5,
    label: 'the 1 kg cube',
    // 02 §3: at nominal Class-3 density this computes to 0.9955 kg. A physical cube
    // really does weigh a kilo (ρ 18.08 sits inside Class 3's band); our nominal figure
    // is what reads 0.996. Say both rather than quietly rounding.
    note: 'sold as the 1 kg cube; 0.996 kg at nominal Class-3 density',
  },
  {
    metal: 'W',
    sideIn: 4,
    label: 'the 4-inch desk cube',
    note: '41.62 lb — the size that broke a lot of desks in 2021',
  },
  {
    metal: 'W',
    sideIn: 14.545,
    label: 'the one-ton NFT cube',
    note: 'sold for ~$250k in 2021, with quarterly visitation rights',
  },
];

/**
 * @param sideM cube side in metres
 * @param tolerancePct how close counts as a match (08 §13: 1.49" matches, 1.4" doesn't)
 */
export function matchTwin(metal: MetalId, sideM: number, tolerancePct = 2): CubeTwin | null {
  const sideIn = sideM / 0.0254;
  let best: CubeTwin | null = null;
  let bestErr = Infinity;
  for (const twin of CUBE_TWINS) {
    if (twin.metal !== metal) continue;
    const err = Math.abs(sideIn - twin.sideIn) / twin.sideIn;
    if (err <= tolerancePct / 100 && err < bestErr) {
      best = twin;
      bestErr = err;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------

export interface MassAnchor {
  kg: number;
  /** Reads after "about the same as …" and after a multiplier ("about 3× …"). */
  label: string;
}

/**
 * A mass ladder for "what does this actually weigh?". Everyday objects only, spanning
 * the full range a cube can hit: a 0.25" aluminium cube is 0.7 g, a 15" tungsten one is
 * 996 kg.
 *
 * These are approximations and the UI must present them as such (01 pillar 2 draws the
 * line at *displayed physics*, not at "roughly a bowling ball").
 */
export const MASS_ANCHORS: readonly MassAnchor[] = [
  { kg: 0.001, label: 'a paperclip' },
  { kg: 0.0075, label: 'a sheet of paper' },
  { kg: 0.024, label: 'a AA battery' },
  { kg: 0.05, label: 'a golf ball' },
  { kg: 0.145, label: 'a baseball' },
  { kg: 0.2, label: 'an apple' },
  { kg: 0.39, label: 'a can of soda' },
  { kg: 1.0, label: 'a litre of water' },
  { kg: 2.3, label: 'a house brick' },
  { kg: 3.8, label: 'a gallon of milk' },
  { kg: 4.5, label: 'a house cat' },
  { kg: 7.3, label: 'a bowling ball' },
  { kg: 18, label: 'a car battery' },
  { kg: 25, label: 'a sack of cement' },
  { kg: 60, label: 'a full beer keg' },
  { kg: 80, label: 'an adult person' },
  { kg: 300, label: 'an upright piano' },
  { kg: 700, label: 'a grand piano' },
  { kg: 1200, label: 'a small car' },
];

/**
 * Plain-language mass comparison.
 *
 * Prefers a near-exact anchor ("about the same as a bowling ball") and otherwise falls
 * back to a multiple of the closest one ("about 3× a house cat"), because "0.43× a sack
 * of cement" is not something a human says.
 *
 * @returns a phrase with no leading capital, or null if the mass is off the ladder
 */
/** 2 -> "half", 3 -> "third" … so the phrase reads like speech, not arithmetic. */
function ordinalFraction(denom: number): string {
  const names: Record<number, string> = {
    2: 'half',
    3: 'third',
    4: 'quarter',
    5: 'fifth',
    6: 'sixth',
    7: 'seventh',
    8: 'eighth',
    9: 'ninth',
    10: 'tenth',
  };
  return names[denom] ?? `1/${denom}`;
}

export function massComparison(kg: number): string | null {
  if (!Number.isFinite(kg) || kg <= 0) return null;

  let best: MassAnchor | undefined;
  let bestRatioErr = Infinity;
  for (const a of MASS_ANCHORS) {
    // Compare in log space: being 2x off is equally wrong in both directions, which a
    // linear difference gets badly wrong across four orders of magnitude.
    const err = Math.abs(Math.log(kg / a.kg));
    if (err < bestRatioErr) {
      bestRatioErr = err;
      best = a;
    }
  }
  if (!best) return null;

  const ratio = kg / best.kg;
  if (ratio > 0.85 && ratio < 1.18) return `about the same as ${best.label}`;

  /*
   * Only offer a multiple when it is a number people actually say.
   *
   * Multiples tolerate halves ("about 2.5× a house cat"), but FRACTIONS do not: the
   * reciprocal of 1.5 is "1/1.5", which nobody has ever uttered. Fractions are therefore
   * restricted to whole denominators, and anything that doesn't land on one falls back
   * to "about the same as" — a slightly loose comparison reads far better than a
   * precisely-worded absurdity.
   */
  if (ratio >= 1) {
    if (ratio > 12) return null;
    const rounded = ratio >= 3 ? Math.round(ratio) : Math.round(ratio * 2) / 2;
    if (rounded < 1.5) return `about the same as ${best.label}`;
    const times = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
    return `about ${times}× ${best.label}`;
  }

  const denom = Math.round(1 / ratio);
  if (denom < 2 || denom > 10) return `about the same as ${best.label}`;
  // Reject a denominator that misrepresents the value by more than ~15 %.
  if (Math.abs(1 / denom / ratio - 1) > 0.15) return `about the same as ${best.label}`;
  return `about a ${ordinalFraction(denom)} of ${best.label}`;
}
