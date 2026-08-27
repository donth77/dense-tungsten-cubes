import type { FluidId } from '../types.ts';

/**
 * The tank's liquids (02 §6, 19 §4).
 *
 * Densities are the published values at 20 °C; viscosities are stored in SI **Pa·s**
 * (02 quotes mPa·s, which is 1000× larger — the conversion lives here, once, so no
 * caller ever has to remember it).
 *
 * Honey is a range in the literature (2–10 Pa·s) because "honey" is not one substance;
 * `viscosityPaS` is the working mid-point and `viscosityRangePaS` keeps the honest
 * span for the panel. If honey proves un-tunable at 60 Hz, 19 §7.2 falls back to
 * glycerin, which is why glycerin is in this table without being in the tab strip.
 */
export interface FluidSpec {
  id: FluidId;
  label: string;
  densityKgM3: number;
  viscosityPaS: number;
  viscosityRangePaS?: readonly [number, number];
  /** Shown in the tank; the others are data the lab may not offer. */
  inTankV1: boolean;
  note: string;
}

export const FLUIDS: Readonly<Record<FluidId, FluidSpec>> = {
  water: {
    id: 'water',
    label: 'Water',
    densityKgM3: 998,
    viscosityPaS: 0.001,
    inTankV1: true,
    note: 'everything sinks — the race is about how fast',
  },
  seawater: {
    id: 'seawater',
    label: 'Seawater',
    densityKgM3: 1025,
    viscosityPaS: 0.00108,
    inTankV1: false,
    note: 'variant skin (02 §6); 2.7 % denser than fresh',
  },
  glycerin: {
    id: 'glycerin',
    label: 'Glycerin',
    densityKgM3: 1260,
    viscosityPaS: 1.412,
    inTankV1: false,
    note: "02's backup viscous fluid if honey will not tune",
  },
  honey: {
    id: 'honey',
    label: 'Honey',
    densityKgM3: 1420,
    viscosityPaS: 5,
    viscosityRangePaS: [2, 10],
    inTankV1: true,
    note: 'slow cinema — the only fluid where the viscous term leads',
  },
  mercury: {
    id: 'mercury',
    label: 'Mercury',
    densityKgM3: 13534,
    viscosityPaS: 0.00153,
    inTankV1: true,
    note: 'sealed simulation tank — do not attempt',
  },
};

export const TANK_FLUID_IDS: readonly FluidId[] = (Object.keys(FLUIDS) as FluidId[]).filter(
  (id) => FLUIDS[id].inTankV1,
);

/**
 * The entry voice for each fluid (19 §F1). Kept beside the fluid data rather than inside
 * the lab so the calibration gate can assert that every fluid has one and that they are
 * three different events, not one sound repitched.
 *
 * The names are declared as literals rather than as `VoiceId` because `data/` sits below
 * `fx/` and may not import from it (08 §5). That the two agree is precisely what the F4
 * gate checks — a cross-layer claim is exactly the kind a gate should be holding, rather
 * than a type that would quietly make it unfalsifiable.
 */
export type TankVoice = 'splash_water' | 'glug_honey' | 'plink_mercury';

export const TANK_VOICES: Readonly<Record<FluidId, TankVoice>> = {
  water: 'splash_water',
  seawater: 'splash_water',
  glycerin: 'glug_honey',
  honey: 'glug_honey',
  mercury: 'plink_mercury',
};

export function densityOfFluid(id: FluidId): number {
  return FLUIDS[id].densityKgM3;
}

/**
 * Does a body of this density float in this fluid, and how deep does it ride?
 *
 * Returns the submerged fraction at rest — `rho_c / rho_f`, straight out of Archimedes
 * — or `null` when the body sinks. This is the lab's readout AND the whole lesson: it
 * is not a table, it is a division (19 §2).
 */
export function floatFraction(bodyDensityKgM3: number, fluid: FluidId): number | null {
  const rhoF = FLUIDS[fluid].densityKgM3;
  return bodyDensityKgM3 >= rhoF ? null : bodyDensityKgM3 / rhoF;
}
