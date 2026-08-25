import { config } from '../../config.ts';
import { PROP_ID_BASE } from '../../types.ts';
import type { EntityId, ImpactEvent, SurfaceId } from '../../types.ts';

/**
 * The measurement half of the Drop Tower (16 §8, §12.2) — a pure state machine, no
 * Rapier, no DOM, unit-tested in `tests/unit/drop-signal.test.ts`.
 *
 * Three-beat honesty (16 §8.4): the impact numbers are published on the impact step
 * and never revised; the rebound appears when the apex is known; the verdict arrives
 * when the cube rests (or the settle timeout says enough). Nothing shown is ever
 * taken back.
 */

export type DropVerdict =
  | 'landed'
  | 'bounced'
  | 'chipped'
  | 'cracked'
  | 'dented'
  | 'rang'
  | 'cratered'
  | 'caught'
  | 'absorbed'
  | 'bottomed-out'
  | 'hit-a-cube'
  | 'off-the-plate'
  | 'shattered'
  | 'survived';

export interface DropSample {
  /** Centre and bottom-face heights of the dropped cube, and its motion. */
  cubeYM: number;
  cubeBottomYM: number;
  speedMps: number;
  angSpeedRadS: number;
  massKg: number;
  /** This step's impacts (the lab's onImpacts hook), already filtered to `a === cube`. */
  impacts: readonly ImpactEvent[];
  /** True once the mounted pad has bottomed (crushed regime, or travel exhausted). */
  padBottomed: boolean;
}

export interface DropImpactReading {
  vMps: number;
  energyJ: number;
  momentumKgMps: number;
  tFlightS: number;
  /** E_n — what the floor received along the normal; drives verdict thresholds, FX. */
  deliveredJ: number;
  partner: ImpactEvent['b'];
}

export interface DropState {
  phase: 'falling' | 'settling' | 'done';
  /** Bottom face above the plate top — the altimeter. */
  altitudeM: number;
  impact: DropImpactReading | null;
  /** Bottom-face rebound above the plate, final only at `done`. */
  reboundM: number | null;
  verdict: DropVerdict | null;
}

const S = config.drop.signal;
const V = config.drop.verdicts;

export class DropSignal {
  readonly #floor: SurfaceId;
  readonly #releaseHM: number;
  readonly #cubeId: EntityId;
  readonly #plateTopYM: number;
  readonly #plateHalfM: number;
  #phase: DropState['phase'] = 'falling';
  #tFlightS = 0;
  #sinceImpactS = 0;
  #restForS = 0;
  #impact: DropImpactReading | null = null;
  #offPlate = false;
  #hitCube = false;
  #apexBottomYM = -Infinity;
  #state: DropState;

  constructor(
    cubeId: EntityId,
    releaseHM: number,
    floor: SurfaceId,
    /** The landing surface's top — a pad's mat sits well above the plate (16 §7.1). */
    floorTopYM = config.drop.plate.topYM,
  ) {
    this.#cubeId = cubeId;
    this.#releaseHM = releaseHM;
    this.#floor = floor;
    this.#plateTopYM = floorTopYM;
    this.#plateHalfM = config.drop.plate.halfM;
    this.#state = {
      phase: 'falling',
      altitudeM: releaseHM,
      impact: null,
      reboundM: null,
      verdict: null,
    };
  }

  get cubeId(): EntityId {
    return this.#cubeId;
  }

  get state(): DropState {
    return this.#state;
  }

  update(s: DropSample, dt: number): DropState {
    if (this.#phase === 'done') return this.#state;

    if (this.#phase === 'falling') {
      this.#tFlightS += dt;
      const hit = s.impacts[0];
      if (hit) {
        /*
         * The readout's speed is the cube's own pre-impact speed and the energy is
         * ½mv² of THE CUBE — the number the player asked about. `energyJ` on the
         * event is the effective-mass energy delivered along the normal; it drives
         * the floor's verdict and the FX, and is published as `deliveredJ`, never as
         * "the energy" (16 §8.2).
         */
        const v = s.speedMps;
        this.#impact = {
          vMps: v,
          energyJ: 0.5 * s.massKg * v * v,
          momentumKgMps: s.massKg * v,
          tFlightS: this.#tFlightS,
          deliveredJ: hit.energyJ,
          partner: hit.b,
        };
        // Props carry numeric ids too (18 §5.1) — "another cube" means BELOW the range.
        this.#hitCube = typeof hit.b === 'number' && hit.b < PROP_ID_BASE;
        this.#offPlate =
          !this.#hitCube &&
          (Math.abs(hit.point.x) > this.#plateHalfM || Math.abs(hit.point.z) > this.#plateHalfM);
        this.#phase = 'settling';
        this.#apexBottomYM = s.cubeBottomYM;
      }
    } else {
      // settling
      this.#sinceImpactS += dt;
      this.#apexBottomYM = Math.max(this.#apexBottomYM, s.cubeBottomYM);
      const atRest = s.speedMps < S.restSpeedMps && s.angSpeedRadS < S.restAngSpeedRadS;
      this.#restForS = atRest ? this.#restForS + dt : 0;
      if (this.#restForS >= S.restDwellS || this.#sinceImpactS >= S.settleTimeoutS) {
        this.#phase = 'done';
      }
    }

    const reboundM =
      this.#phase === 'falling' ? null : Math.max(0, this.#apexBottomYM - this.#plateTopYM);
    this.#state = {
      phase: this.#phase,
      altitudeM: Math.max(0, s.cubeBottomYM - this.#plateTopYM),
      impact: this.#impact,
      reboundM,
      verdict: this.#phase === 'done' ? this.#verdict(reboundM ?? 0, s.padBottomed) : null,
    };
    return this.#state;
  }

  /** 16 §7.6, with its precedence: partner, then pads, then marks, then bounce. */
  /** Target verdicts outrank everything (18 §5.4) — the break IS the story. */
  #targetVerdict: DropVerdict | null = null;

  setTargetVerdict(v: DropVerdict): void {
    this.#targetVerdict = v;
  }

  #verdict(reboundM: number, padBottomed: boolean): DropVerdict {
    if (this.#targetVerdict) return this.#targetVerdict;
    if (this.#hitCube) return 'hit-a-cube';
    if (this.#offPlate) return 'off-the-plate';
    const e = this.#impact?.deliveredJ ?? 0;
    const bounced = reboundM >= V.bounceFrac * this.#releaseHM;
    switch (this.#floor) {
      case 'trampoline':
      case 'foam':
        if (padBottomed) return 'bottomed-out';
        // The 8 kN/m retune made the mat a real thrower: past thrownFrac the honest
        // word is BOUNCED; "caught" is reserved for the modest, held-onto return.
        if (reboundM >= V.thrownFrac * this.#releaseHM) return 'bounced';
        return bounced ? 'caught' : 'absorbed';
      case 'steel':
        if (e >= V.ringJ) return 'rang';
        break;
      default:
        break;
    }
    return bounced ? 'bounced' : 'landed';
  }
}
