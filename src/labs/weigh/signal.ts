import { config } from '../../config.ts';

/**
 * The scale's signal chain and state machine (15 §7.5–7.7, §9.2).
 *
 * PURE. No physics, no DOM, no clock — it takes numbers a step produced and returns the
 * instrument's state. That is what lets the honesty rules be tested exhaustively without
 * booting a solver, and the honesty rules are the product here: this file is the reason
 * the scale cannot show you a mass it has not earned.
 *
 * The chain, in order:
 *
 *   raw support force
 *     -> two-pole low-pass
 *     -> empty-zero and tare subtraction
 *     -> rolling stability window + motion checks
 *     -> gross / net / tare
 *     -> force-to-mass ONLY when stable
 *     -> quantisation to whole displayed divisions
 *
 * Everything upstream of "stable" is a FORCE. Mass appears at exactly one point, guarded
 * by a dwell that every disturbance resets. 15 §7.7's table is the contract.
 */

const S = config.weigh.scale;

export type ScaleStatus =
  'initializing' | 'dynamic' | 'stable' | 'under-min' | 'overload' | 'partial-support';

/** What one fixed step can tell the instrument about itself. */
export interface ScaleSample {
  /** The transducer force we applied this step — the raw sensor signal. */
  rawCellForceN: number;
  /** |v| of the platter along its axis. */
  platterSpeedMps: number;
  /** How far the platter has travelled from its unloaded height, metres, positive down. */
  platterTravelM: number;
  /** Fastest corner speed among cubes in the measurement volume (m/s). */
  loadMotionMps: number;
  /** Any cube in the volume is in the player's hand. */
  anyGrabbed: boolean;
  /** The platter is resting on its travel stop. */
  onStop: boolean;
  /** The cell has saturated at proof force. */
  atProof: boolean;
  /**
   * A load is bridging the platter and something fixed, so the cell sees only part of its
   * weight. Geometry establishes this, never the force reading — 15 §7.4 is explicit that
   * a low number must not be reported as a small mass.
   */
  partialSupport: boolean;
}

export interface ScaleState {
  rawCellForceN: number;
  filteredCellForceN: number;
  emptyOffsetN: number;
  tareOffsetN: number;
  grossForceN: number;
  netForceN: number;
  /** Only ever set when `status === 'stable'`. Null is the honest answer otherwise. */
  stableMassKg: number | null;
  /**
   * Whether the empty platter has been zeroed out yet. Until it has, every reading
   * includes the platter's own 5 kg and none of them may be shown as a mass.
   */
  zeroed: boolean;
  displayedDivisions: number | null;
  status: ScaleStatus;
  stableForS: number;
  lowerStop: boolean;
  upperStop: boolean;
}

/**
 * One first-order section: `y += a (x - y)`, with `a` derived from a cutoff in Hz rather
 * than picked as a bare coefficient. Because `dt` is the fixed step, the cutoff means the
 * same thing on every machine — a coefficient tuned at one frame rate would not.
 */
class OnePole {
  #y = 0;
  readonly #a: number;
  constructor(cutoffHz: number, dt: number) {
    this.#a = 1 - Math.exp(-2 * Math.PI * cutoffHz * dt);
  }
  reset(v: number): void {
    this.#y = v;
  }
  push(x: number): number {
    this.#y += this.#a * (x - this.#y);
    return this.#y;
  }
  get value(): number {
    return this.#y;
  }
}

/** Fixed-length ring of recent samples, for "how much has this moved lately". */
class Window {
  readonly #buf: number[];
  #i = 0;
  #filled = 0;
  constructor(readonly size: number) {
    this.#buf = new Array<number>(size).fill(0);
  }
  reset(): void {
    this.#i = 0;
    this.#filled = 0;
  }
  push(v: number): void {
    this.#buf[this.#i] = v;
    this.#i = (this.#i + 1) % this.size;
    if (this.#filled < this.size) this.#filled++;
  }
  get full(): boolean {
    return this.#filled === this.size;
  }
  /** Peak-to-peak over the window. Meaningless until `full`. */
  get span(): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < this.#filled; k++) {
      const v = this.#buf[k]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return this.#filled === 0 ? 0 : hi - lo;
  }
}

export class ScaleSignal {
  readonly #lp1: OnePole;
  readonly #lp2: OnePole;
  readonly #forceWindow: Window;
  readonly #travelWindow: Window;
  readonly #g: number;

  #emptyOffsetN = 0;
  #tareOffsetN = 0;
  #zeroed = false;
  #stableForS = 0;
  #overForS = 0;
  #status: ScaleStatus = 'initializing';
  #state: ScaleState;

  constructor(dt = config.loop.DT, gravityMps2 = config.physics.gravityMps2) {
    this.#g = gravityMps2;
    this.#lp1 = new OnePole(S.filterCutoffHz, dt);
    this.#lp2 = new OnePole(S.filterCutoffHz, dt);
    const n = Math.max(2, Math.round(S.stabilityWindowS / dt));
    this.#forceWindow = new Window(n);
    this.#travelWindow = new Window(n);
    this.#state = {
      rawCellForceN: 0,
      filteredCellForceN: 0,
      emptyOffsetN: 0,
      tareOffsetN: 0,
      grossForceN: 0,
      netForceN: 0,
      stableMassKg: null,
      displayedDivisions: null,
      zeroed: false,
      status: 'initializing',
      stableForS: 0,
      lowerStop: false,
      upperStop: false,
    };
  }

  get state(): Readonly<ScaleState> {
    return this.#state;
  }

  /** Whether a reading is currently trustworthy enough to act on. */
  get isStable(): boolean {
    return this.#status === 'stable' || this.#status === 'under-min';
  }

  update(s: ScaleSample, dt: number): Readonly<ScaleState> {
    const filtered = this.#lp2.push(this.#lp1.push(s.rawCellForceN));
    this.#forceWindow.push(filtered);
    this.#travelWindow.push(s.platterTravelM);

    const gross = filtered - this.#emptyOffsetN;
    const net = gross - this.#tareOffsetN;

    /*
     * Every one of these must hold for the whole dwell (15 §7.5). The load-motion and
     * grab tests exist for a case the force alone cannot see: a cube sliding sideways
     * across the platter keeps the vertical force perfectly constant while plainly not
     * being at rest. They gate the WORD "stable" and never touch the measured force.
     */
    const quiet =
      this.#forceWindow.full &&
      this.#forceWindow.span <= S.divisionKg * this.#g &&
      this.#travelWindow.span <= S.travelSpanM &&
      s.platterSpeedMps <= S.platterSpeedMps &&
      s.loadMotionMps <= S.loadMotionMps &&
      !s.anyGrabbed &&
      !s.onStop &&
      !s.atProof;

    this.#stableForS = quiet ? this.#stableForS + dt : 0;

    // Invalid states win over stability, and each one refuses to name a mass. Overload
    // has to PERSIST: a landing spike crosses proof force for a frame and is not one.
    const overCapacity = gross > S.ratedKg * this.#g;
    this.#overForS = s.atProof || s.onStop || overCapacity ? this.#overForS + dt : 0;
    if (this.#overForS >= S.overloadDwellS) {
      this.#status = 'overload';
    } else if (s.partialSupport) {
      this.#status = 'partial-support';
    } else if (this.#stableForS >= S.stabilityWindowS) {
      // Below the minimum indication, the honest answer is "less than 0.05 kg" — not a
      // number with two decimal places the instrument cannot actually resolve.
      this.#status = Math.abs(net) < S.minIndicationKg * this.#g ? 'under-min' : 'stable';
    } else {
      this.#status = 'dynamic';
    }

    const massKg = this.#status === 'stable' ? net / this.#g : null;
    // Quantise from an integer count of divisions, so 1.00 kg never presents as
    // 0.9999999999 through binary floating point (15 §7.7).
    const divisions = massKg === null ? null : Math.round(massKg / S.divisionKg);

    this.#state = {
      rawCellForceN: s.rawCellForceN,
      filteredCellForceN: filtered,
      emptyOffsetN: this.#emptyOffsetN,
      tareOffsetN: this.#tareOffsetN,
      grossForceN: gross,
      netForceN: net,
      stableMassKg: divisions === null ? null : divisions * S.divisionKg,
      displayedDivisions: divisions,
      zeroed: this.#zeroed,
      status: this.#status,
      stableForS: this.#stableForS,
      lowerStop: s.onStop,
      upperStop: false,
    };
    return this.#state;
  }

  /**
   * Calibrate the empty instrument. Refused unless the platter is settled and nothing is
   * on it — zeroing during a disturbance is how a scale learns the wrong dead load, and
   * zeroing with a load on it is how it learns to lie about that load forever.
   *
   * @returns whether it was allowed, so the UI can say why not.
   */
  zero(volumeEmpty: boolean): boolean {
    if (!this.isStable || !volumeEmpty) return false;
    this.#emptyOffsetN = this.#lp2.value;
    this.#tareOffsetN = 0;
    this.#zeroed = true;
    this.#resetDwell();
    return true;
  }

  /** Stores the current stable gross as the tare offset. Never changes capacity. */
  tare(): boolean {
    if (!this.isStable) return false;
    const gross = this.#lp2.value - this.#emptyOffsetN;
    if (gross > S.ratedKg * this.#g) return false;
    this.#tareOffsetN = gross;
    this.#resetDwell();
    return true;
  }

  clearTare(): void {
    this.#tareOffsetN = 0;
    this.#resetDwell();
  }

  /**
   * Something changed that invalidates the current sample without invalidating the
   * calibration — a purity edit, a body replacement. Tare SURVIVES: a tared force offset
   * is a fact about the container, not about which cube was edited (15 §9.4).
   */
  invalidate(): void {
    this.#resetDwell();
  }

  #resetDwell(): void {
    this.#stableForS = 0;
    this.#overForS = 0;
    this.#forceWindow.reset();
    this.#travelWindow.reset();
    this.#status = 'dynamic';
    // Published at once, not at the next update: a caller that zeroes and then reads
    // `state` in the same step must see the zero, or the LCD shows the platter's weight
    // for one more frame and a test reads a stale flag.
    this.#state = {
      ...this.#state,
      emptyOffsetN: this.#emptyOffsetN,
      tareOffsetN: this.#tareOffsetN,
      zeroed: this.#zeroed,
      status: 'dynamic',
      stableForS: 0,
      stableMassKg: null,
      displayedDivisions: null,
    };
  }
}
