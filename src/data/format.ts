/**
 * Every number the UI shows goes through here (08 §5.4, §8.8). One rounding policy,
 * one place to test it.
 *
 * The house style is **SI primary with an imperial subtitle** (08 §2.3), with one
 * deliberate exception: cube *sizes* lead in inches, because that is how the product is
 * sold. Nothing else flips.
 *
 * Pure — no DOM, no three.js — so it is trivially testable (08 §5.2).
 */

export type Units = 'si' | 'imperial';

export const KG_PER_LB = 0.45359237;
export const LB_PER_KG = 1 / KG_PER_LB;
export const M_PER_IN = 0.0254;
export const IN_PER_M = 1 / M_PER_IN;

/** A value and its secondary reading, ready for a spec cell's `.val` / `.val2`. */
export interface Reading {
  primary: string;
  secondary: string;
}

/**
 * A non-finite value reaching a label means a bug upstream — but it must never render
 * as "NaN kg" in the middle of the info card. Every formatter guards through this.
 */
const NO_READING: Reading = { primary: '—', secondary: '—' };
const bad = (v: number): boolean => !Number.isFinite(v);

/**
 * Significant-figure rounding for display.
 *
 * Fixed decimal places lie at both ends of a 60:1 size range: 2 dp turns a 0.7 g cube
 * into "0.00 kg" and a 996 kg one into pointless precision. Significant figures keep
 * the same *information density* at every scale, which is what makes a live-updating
 * readout feel honest rather than twitchy.
 */
function sig(value: number, figures = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, Math.min(6, figures - 1 - mag));
  return value.toFixed(decimals);
}

// ---- mass ------------------------------------------------------------------------

/**
 * Mass, auto-scaled to the unit a human would use.
 *
 * The scale readout is the exception and does NOT use this — 02 §3 fixes it at two
 * decimals in kg so the 1.5" cube can honestly read `1.00 kg` (see `massFixed`).
 */
export function mass(kg: number, units: Units = 'si'): Reading {
  if (bad(kg)) return NO_READING;
  const lb = kg * LB_PER_KG;
  const si = kg < 0.001 ? `${sig(kg * 1e6)} mg` : kg < 1 ? `${sig(kg * 1000)} g` : `${sig(kg)} kg`;
  const imp = lb < 1 ? `${sig(lb * 16)} oz` : `${sig(lb)} lb`;
  return units === 'si' ? { primary: si, secondary: imp } : { primary: imp, secondary: si };
}

/** Fixed-decimal mass, for instruments that must not change width as they update. */
export function massFixed(kg: number, decimals = 2, units: Units = 'si'): Reading {
  if (bad(kg)) return NO_READING;
  // Never "-0.00". A zeroed scale's net reading sits a few thousandths either side of
  // zero, and `(-0.003).toFixed(2)` is "-0.00" — a minus sign on nothing. Anything that
  // would round to zero is zero, in both units, and the sign goes with it.
  const siKg = snapZero(kg, decimals);
  const lb = snapZero(kg * LB_PER_KG, decimals);
  const si = `${siKg.toFixed(decimals)} kg`;
  const imp = `${lb.toFixed(decimals)} lb`;
  return units === 'si' ? { primary: si, secondary: imp } : { primary: imp, secondary: si };
}

/** A value that would print as zero at this precision IS zero — and positive zero. */
function snapZero(v: number, decimals: number): number {
  return Math.abs(v) < 0.5 * 10 ** -decimals ? 0 : v;
}

// ---- length ----------------------------------------------------------------------

/**
 * Cube size. **Inches lead in both modes** — the one deliberate inversion (08 §2.3),
 * because a tungsten cube is a product sold by the inch and calling a 2" cube "50.8 mm"
 * makes it harder to recognise, not easier.
 */
export function cubeSide(sideM: number): Reading {
  if (bad(sideM)) return NO_READING;
  const mm = sideM * 1000;
  // Quantise before formatting. A 3" cube is stored as 0.0762 m, and 0.0762 / 0.0254
  // comes back as 2.9999999999999996 — so any "is it a whole number" test on the raw
  // value fails and the label reads "3.00″". Three decimals is enough for the 14.545"
  // meme cube and coarse enough to absorb the round-trip error.
  const inches = Math.round(sideM * IN_PER_M * 1000) / 1000;
  const inStr = trimZeros(inches.toFixed(3));
  return {
    primary: `${inStr}″`,
    secondary: mm < 10 ? `${sig(mm)} mm` : `${mm.toFixed(1)} mm`,
  };
}

/** General length, SI-primary (drop heights, stage distances). */
export function length(m: number, units: Units = 'si'): Reading {
  if (bad(m)) return NO_READING;
  const si = m < 0.01 ? `${sig(m * 1000)} mm` : m < 1 ? `${sig(m * 100)} cm` : `${sig(m)} m`;
  const inches = m * IN_PER_M;
  const imp = inches < 12 ? `${sig(inches)}″` : `${sig(inches / 12)} ft`;
  return units === 'si' ? { primary: si, secondary: imp } : { primary: imp, secondary: si };
}

// ---- the rest ---------------------------------------------------------------------

/** Density. g/cm³ leads because that is how every alloy datasheet quotes it (02). */
export function density(kgPerM3: number): Reading {
  if (bad(kgPerM3)) return NO_READING;
  return {
    primary: `${(kgPerM3 / 1000).toFixed(2)} g/cm³`,
    secondary: `${Math.round(kgPerM3)} kg/m³`,
  };
}

export function force(n: number): Reading {
  if (bad(n)) return NO_READING;
  return { primary: `${sig(n)} N`, secondary: `${sig(n * 0.2248089431)} lbf` };
}

export function energy(j: number): Reading {
  if (bad(j)) return NO_READING;
  return { primary: `${sig(j)} J`, secondary: `${sig(j * 0.7375621493)} ft·lb` };
}

/** Momentum, for the impact readout (16 §8.2). kg·m/s leads; lb·ft/s is the subtitle. */
export function momentum(kgMps: number, units: Units = 'si'): Reading {
  if (bad(kgMps)) return NO_READING;
  // lb·ft/s per kg·m/s: 2.2046226218 lb/kg × 3.280839895 ft/m.
  const si = `${sig(kgMps)} kg·m/s`;
  const imp = `${sig(kgMps * 7.2330114643)} lb·ft/s`;
  return units === 'si' ? { primary: si, secondary: imp } : { primary: imp, secondary: si };
}

export function speed(mps: number, units: Units = 'si'): Reading {
  if (bad(mps)) return NO_READING;
  const si = `${sig(mps)} m/s`;
  const imp = `${sig(mps * 2.2369362921)} mph`;
  return units === 'si' ? { primary: si, secondary: imp } : { primary: imp, secondary: si };
}

/** Volume, for the info card. */
export function volume(m3: number): Reading {
  if (bad(m3)) return NO_READING;
  const cm3 = m3 * 1e6;
  return { primary: `${sig(cm3)} cm³`, secondary: `${sig(m3 * 61023.7441)} in³` };
}

export function percent(value: number, decimals = 1): string {
  return `${trimZeros(value.toFixed(decimals))} %`;
}

/** `1.50` -> `1.5`, `2.00` -> `2`. Keeps size labels from reading like part numbers. */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
