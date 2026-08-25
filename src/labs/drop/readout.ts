import { config } from '../../config.ts';
import { energy, length, momentum, speed } from '../../data/format.ts';
import { energyComparison } from '../../data/ladder.ts';
import type { Units } from '../../data/format.ts';
import type { DropState, DropVerdict } from './drop-signal.ts';
import type { PanelFact } from '../lab.ts';

/**
 * Pure formatting for the Drop panel (16 §8.2, §13.1): measured values with the vacuum
 * ideals as facts, in the player's units. No DOM, no state — `index.ts` assembles the
 * model, this file words it, and the unit for every claim is a formatter, never string
 * math.
 */

const G = config.physics.gravityMps2;

export const VERDICT_LABEL: Readonly<Record<DropVerdict, string>> = {
  landed: 'LANDED',
  bounced: 'BOUNCED',
  chipped: 'CHIPPED',
  cracked: 'CRACKED',
  dented: 'DENTED',
  rang: 'RANG',
  cratered: 'CRATERED',
  caught: 'CAUGHT',
  absorbed: 'ABSORBED',
  'bottomed-out': 'BOTTOMED OUT',
  'hit-a-cube': 'HIT A CUBE',
  'off-the-plate': 'OFF THE PLATE',
  shattered: 'SHATTERED',
  splat: 'SPLAT',
  'crushed-flat': 'CRUSHED FLAT',
  survived: 'SURVIVED',
};

export function verdictTone(v: DropVerdict): 'ok' | 'warn' {
  return v === 'hit-a-cube' || v === 'off-the-plate' || v === 'bottomed-out' ? 'warn' : 'ok';
}

/** The facts below the big number, in the three-beat order (16 §8.4). */
export function impactFacts(state: DropState, releaseHM: number, units: Units): PanelFact[] {
  const imp = state.impact;
  if (!imp) return [];
  /*
   * ONE LINE PER FACT. The first cut packed primary AND secondary into the IMPACT
   * cell; it wrapped to four lines, the panel swelled, and collided with the spawner
   * card (screenshot review 2026-08-24). Primary + the ideal is the comparison that
   * matters; the other unit is one toggle away, as the info card treats it.
   */
  const facts: PanelFact[] = [];
  const v = speed(imp.vMps, units);
  const ideal = Math.sqrt(2 * G * releaseHM);
  facts.push({
    k: 'IMPACT',
    v: v.primary,
    v2: `ideal ${speed(ideal, units).primary}`,
  });
  const p = momentum(imp.momentumKgMps, units);
  facts.push({ k: 'MOMENTUM', v: p.primary, v2: p.secondary });
  if (state.reboundM !== null && state.phase === 'done') {
    const r = length(state.reboundM, units);
    const frac = releaseHM > 0 ? state.reboundM / releaseHM : 0;
    const e = Math.sqrt(Math.max(0, frac));
    facts.push({
      k: 'REBOUND',
      v: `${r.primary} (${Math.round(frac * 100)} %)`,
      v2: `e ${e.toFixed(2)} in-sim`,
    });
  }
  facts.push({
    k: 'FLIGHT',
    v: `${imp.tFlightS.toFixed(2)} s`,
    v2: `ideal ${Math.sqrt((2 * releaseHM) / G).toFixed(2)} s`,
  });
  // The row key IS the ≈ mark; the ladder string carries its own for other callers,
  // so it is stripped here — "≈≈ 4.5 ×" was live for about an hour (2026-08-24).
  facts.push({ k: '≈', v: energyComparison(imp.energyJ).replace(/^≈ /, ''), v2: '' });
  return facts;
}

/** The big number: the cube's kinetic energy at impact. */
export function energyReading(state: DropState): { value: string; sub: string } | null {
  const imp = state.impact;
  if (!imp) return null;
  const e = energy(imp.energyJ);
  return { value: e.primary, sub: e.secondary };
}

/** The altimeter while falling: instant swaps, no spam anywhere else (16 §13.3). */
export function altimeterText(state: DropState): string {
  return `${state.altitudeM.toFixed(1)} m ↓`;
}

// ---- the height slider's log mapping (0..1000 raw, like the size slider) ----------

const H_MIN = config.drop.tower.minHM;
const H_MAX = config.drop.tower.maxHM;
const LOG_MIN = Math.log(H_MIN);
const LOG_MAX = Math.log(H_MAX);

export const HEIGHT_TICKS_M: readonly number[] = [0.1, 0.5, 1, 2, 5, 10, 20];

export function rawToHeight(raw: number): number {
  return Math.exp(LOG_MIN + (raw / 1000) * (LOG_MAX - LOG_MIN));
}

export function heightToRaw(hM: number): number {
  const c = Math.min(H_MAX, Math.max(H_MIN, hM));
  return Math.round(((Math.log(c) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000);
}

export function heightLabel(hM: number, units: Units): { text: string; sub?: string } {
  const r = length(hM, units);
  return { text: r.primary, sub: r.secondary };
}
