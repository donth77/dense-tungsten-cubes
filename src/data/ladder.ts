/**
 * The energy intuition ladder (02 §8; 16 §8.3) — the Drop Tower's plain-language line.
 *
 * Copy, never a measurement: every phrasing is marked ≈, the anchors are order-of-
 * magnitude reference points from 02's sourced table, and the rule is deterministic so
 * the same drop always says the same thing.
 */

export interface EnergyAnchor {
  j: number;
  label: string;
}

export const ENERGY_LADDER: readonly EnergyAnchor[] = [
  { j: 0.05, label: 'an egg-cracking tap' },
  { j: 2, label: 'a phone dropped from 1 m' },
  { j: 10, label: '1 kg dropped from 1 m' },
  { j: 117, label: 'a 90 mph fastball' },
  { j: 392, label: 'handgun-muzzle class' },
  { j: 1900, label: 'the 4 in tungsten cube from 10 m' },
  { j: 17_800, label: 'the one-ton cube from 2 m' },
  { j: 116_000, label: 'a 1,200 kg car at 50 km/h' },
];

/**
 * 16 §8.3's rule: the largest anchor ≤ E; within 1.5× it IS the anchor, beyond that
 * it is `N ×` the anchor — one decimal under 10, whole numbers above.
 */
export function energyComparison(j: number): string {
  if (!Number.isFinite(j) || j < 0) return '—';
  const first = ENERGY_LADDER[0]!;
  if (j < first.j) return `less than ${first.label}`;
  let anchor = first;
  for (const a of ENERGY_LADDER) {
    if (a.j <= j) anchor = a;
    else break;
  }
  const ratio = j / anchor.j;
  if (ratio < 1.5) return `≈ ${anchor.label}`;
  const n = ratio < 10 ? trimTrailingZero(ratio.toFixed(1)) : String(Math.round(ratio));
  return `≈ ${n} × ${anchor.label}`;
}

function trimTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
