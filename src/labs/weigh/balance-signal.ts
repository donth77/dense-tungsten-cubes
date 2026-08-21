import { config } from '../../config.ts';

/**
 * Reading the beam (15 §9.3). Pure — angle in, status out.
 *
 * The one rule that matters: **the status sign comes from the ANGLE, never from the pan
 * hints.** The hints know what is in each pan and could compute the answer arithmetically,
 * which is exactly why they must not: an instrument that tells you which side is heavier
 * by adding up masses is a calculator wearing a balance costume. The beam has to be
 * right, and the display has to be reading the beam.
 *
 * BALANCED gets the same treatment as the scale's STABLE — a tolerance and a dwell, with
 * every disturbance resetting the clock — because "these are equal" is a claim, and a
 * beam still drifting through zero has not made it yet.
 */

const B = config.weigh.balance;

/** Rolling window of recent angles — "has this stopped moving" judged by POSITION. */
class AngleWindow {
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

export type BalanceStatus =
  'initializing' | 'moving' | 'balanced' | 'left-heavy' | 'right-heavy' | 'at-stop' | 'overload';

export interface BalanceSample {
  /** Signed beam angle, radians. Positive is left-down. */
  angleRad: number;
  angularSpeedRadS: number;
  leftPanSpeedRadS: number;
  rightPanSpeedRadS: number;
  leftLoadKg: number;
  rightLoadKg: number;
  anyGrabbed: boolean;
}

export interface BalanceState {
  angleRad: number;
  angleDeg: number;
  angularSpeedRadS: number;
  zeroAngleRad: number;
  status: BalanceStatus;
  settledForS: number;
  /** Heavier side's excess, kg — a HINT for the panel, never the source of the sign. */
  differenceKg: number;
  atStop: boolean;
}

const DEG = 180 / Math.PI;

export class BalanceSignal {
  #zeroAngleRad = 0;
  #settledForS = 0;
  readonly #angles = new AngleWindow(Math.max(2, Math.round(B.settleWindowS / config.loop.DT)));
  #status: BalanceStatus = 'initializing';
  #state: BalanceState = {
    angleRad: 0,
    angleDeg: 0,
    angularSpeedRadS: 0,
    zeroAngleRad: 0,
    status: 'initializing',
    settledForS: 0,
    differenceKg: 0,
    atStop: false,
  };

  get state(): Readonly<BalanceState> {
    return this.#state;
  }

  update(s: BalanceSample, dt: number): Readonly<BalanceState> {
    const rel = s.angleRad - this.#zeroAngleRad;
    const relDeg = rel * DEG;
    const atStop = Math.abs(relDeg) >= B.limitDeg - B.atStopMarginDeg;

    /*
     * Settled is judged on the ANGLE HOLDING STILL, not on angular velocity.
     *
     * Velocity is the obvious test and it does not survive contact. Measured: a beam
     * carrying one cube per pan sat at 4.4 degrees for ten seconds, its angle wandering by
     * 0.05 degrees in total — plainly at rest to anyone looking — while the instantaneous
     * angular velocity chattered across the 0.02 rad/s threshold and the instrument
     * reported MOVING forever. Cubes shifting by microns on a pan do that.
     *
     * A span over the whole window is the same shape as the scale's force-span test, and
     * it answers the question a person actually asks: has the pointer stopped drifting?
     */
    this.#angles.push(relDeg);
    const settled =
      this.#angles.full &&
      this.#angles.span <= B.settledAngleSpanDeg &&
      Math.abs(s.leftPanSpeedRadS) <= B.settledPanSpeedRadS &&
      Math.abs(s.rightPanSpeedRadS) <= B.settledPanSpeedRadS &&
      !s.anyGrabbed;
    this.#settledForS = settled ? this.#settledForS + dt : 0;

    const overloaded = s.leftLoadKg > B.capacityKgPerPan || s.rightLoadKg > B.capacityKgPerPan;

    /*
     * AT-STOP is checked before the settle dwell, and it carries NO motion test at all.
     *
     * The difference is what each status claims. "Left-heavy" and "balanced" are claims
     * about EQUALITY, which is only knowable once everything is quiet — so those wait out
     * the dwell. "At the stop" is a claim about where the BEAM is, and the limit is what
     * decides that.
     *
     * Requiring the beam to be slow as well looks reasonable and is wrong. Measured: a
     * beam pinned by a 2.5 kg imbalance sat at 12.38 degrees for ten seconds, its angle
     * varying by 0.018 degrees in total, while its angular velocity chattered between
     * 0.02 and 0.06 rad/s against the soft limit. Judged on velocity it flickered between
     * MOVING and AT-STOP forever; judged on position it is simply pinned, which is what a
     * person looking at it would say.
     */
    if (overloaded) {
      this.#status = 'overload';
    } else if (atStop) {
      // The beam is saying the difference is bigger than it can show — a different
      // statement from "this much heavier".
      this.#status = 'at-stop';
    } else if (this.#settledForS < B.settleWindowS) {
      this.#status = 'moving';
    } else if (Math.abs(relDeg) <= B.balancedToleranceDeg) {
      this.#status = 'balanced';
    } else {
      this.#status = relDeg > 0 ? 'left-heavy' : 'right-heavy';
    }

    this.#state = {
      angleRad: rel,
      angleDeg: relDeg,
      angularSpeedRadS: s.angularSpeedRadS,
      zeroAngleRad: this.#zeroAngleRad,
      status: this.#status,
      settledForS: this.#settledForS,
      differenceKg: Math.abs(s.leftLoadKg - s.rightLoadKg),
      atStop,
    };
    return this.#state;
  }

  /** Records the current angle as level. Only meaningful on a settled, empty beam. */
  zero(currentAngleRad: number, settled: boolean): boolean {
    if (!settled) return false;
    this.#zeroAngleRad = currentAngleRad;
    this.#settledForS = 0;
    this.#angles.reset();
    return true;
  }

  invalidate(): void {
    this.#settledForS = 0;
    this.#angles.reset();
    this.#status = 'moving';
  }
}
