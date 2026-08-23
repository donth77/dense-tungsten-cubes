import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { ScaleSignal } from '../../src/labs/weigh/signal.ts';
import { BalanceSignal } from '../../src/labs/weigh/balance-signal.ts';
import type { ScaleSample } from '../../src/labs/weigh/signal.ts';
import type { BalanceSample } from '../../src/labs/weigh/balance-signal.ts';

const DT = config.loop.DT;
const G = config.physics.gravityMps2;
const S = config.weigh.scale;
const B = config.weigh.balance;

/**
 * The honesty rules (15 §7.5–7.7, §9.2–9.3).
 *
 * This is the file that decides whether the Weigh Station is an instrument or a prop. The
 * measurement is a FORCE at every stage but one: mass appears at exactly one point, and
 * only after a dwell that every disturbance resets. These tests exist to make it hard to
 * quietly loosen that.
 */

/** A perfectly settled sample carrying `n` newtons. */
function quiet(rawCellForceN: number, over: Partial<ScaleSample> = {}): ScaleSample {
  return {
    rawCellForceN,
    platterSpeedMps: 0,
    platterTravelM: 0,
    loadMotionMps: 0,
    anyGrabbed: false,
    onStop: false,
    atProof: false,
    partialSupport: false,
    ...over,
  };
}

/** Runs the signal to convergence at a fixed force, long enough to go stable. */
function settle(sig: ScaleSignal, forceN: number, seconds = 3, over: Partial<ScaleSample> = {}) {
  let last = sig.state;
  for (let i = 0; i < seconds * 60; i++) last = sig.update(quiet(forceN, over), DT);
  return last;
}

describe('the scale refuses to name a mass it has not earned', () => {
  it('says DYNAMIC, never a mass, while the force is still moving', () => {
    const sig = new ScaleSignal();
    // A force ramping upward can never satisfy the span test. Kept inside capacity, or
    // it would report the (also correct) OVERLOAD instead and prove nothing about dwell.
    let state = sig.state;
    for (let i = 0; i < 300; i++) state = sig.update(quiet(i * 0.1), DT);
    expect(state.status).toBe('dynamic');
    expect(state.stableMassKg).toBeNull();
    expect(state.displayedDivisions).toBeNull();
  });

  it('only converts to mass once the dwell has fully elapsed', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    // Right after a step change the filter is still moving, so nothing may be claimed.
    const mid = sig.update(quiet((S.platterKg + 1) * G), DT);
    expect(mid.stableMassKg).toBeNull();
    const done = settle(sig, (S.platterKg + 1) * G, 3);
    expect(done.status).toBe('stable');
    expect(done.stableMassKg).toBeCloseTo(1, 2);
  });

  it('resets the dwell whenever the load is grabbed, even if the force is constant', () => {
    // The case the force alone cannot see. A cube held perfectly still by the Hand puts
    // exactly its weight on the platter, and is emphatically not a settled measurement.
    const sig = new ScaleSignal();
    settle(sig, (S.platterKg + 1) * G, 3);
    sig.zero(true);
    const held = settle(sig, (S.platterKg + 1) * G, 3, { anyGrabbed: true });
    expect(held.status).toBe('dynamic');
    expect(held.stableMassKg).toBeNull();
  });

  it('resets the dwell for a cube sliding sideways at constant vertical force', () => {
    const sig = new ScaleSignal();
    const moving = settle(sig, (S.platterKg + 1) * G, 3, { loadMotionMps: 0.5 });
    expect(moving.stableMassKg).toBeNull();
  });
});

describe('zero and tare', () => {
  it('reports itself unzeroed until zero() is called, so nothing shows as mass before', () => {
    const sig = new ScaleSignal();
    const s = settle(sig, S.platterKg * G, 3);
    expect(s.zeroed).toBe(false);
    expect(sig.zero(true)).toBe(true);
    expect(sig.state.zeroed).toBe(true);
  });

  it('zeroes the empty platter to 0.00 kg', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    expect(sig.zero(true)).toBe(true);
    const after = settle(sig, S.platterKg * G, 3);
    expect(after.status).toBe('under-min');
    expect(after.grossForceN).toBeCloseTo(0, 3);
  });

  it('refuses to zero with something on the platter', () => {
    const sig = new ScaleSignal();
    settle(sig, (S.platterKg + 1) * G, 3);
    expect(sig.zero(false)).toBe(false);
  });

  it('refuses to zero or tare while the reading is moving', () => {
    const sig = new ScaleSignal();
    sig.update(quiet(50, { platterSpeedMps: 1 }), DT);
    expect(sig.zero(true)).toBe(false);
    expect(sig.tare()).toBe(false);
  });

  it('tares a container and then reads the net load', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    // A 0.5 kg container.
    settle(sig, (S.platterKg + 0.5) * G, 3);
    expect(sig.tare()).toBe(true);
    // Add 1 kg into it.
    const loaded = settle(sig, (S.platterKg + 1.5) * G, 3);
    expect(loaded.stableMassKg).toBeCloseTo(1, 2);
    expect(loaded.grossForceN).toBeCloseTo(1.5 * G, 1);
  });

  it('reads negative when a tared container is taken away', () => {
    // 15 §7.6 calls this legitimate, and it is: the pan is lighter than what was zeroed.
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    settle(sig, (S.platterKg + 0.5) * G, 3);
    sig.tare();
    const removed = settle(sig, S.platterKg * G, 3);
    expect(removed.stableMassKg).toBeLessThan(0);
    expect(removed.stableMassKg).toBeCloseTo(-0.5, 2);
  });

  it('does not let tare buy extra capacity', () => {
    // Tare shifts the net reading; it must not raise the gross the instrument accepts.
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    settle(sig, (S.platterKg + S.ratedKg * 0.8) * G, 3);
    expect(sig.tare()).toBe(true);
    const over = settle(sig, (S.platterKg + S.ratedKg * 1.2) * G, 3);
    expect(over.status).toBe('overload');
    expect(over.stableMassKg).toBeNull();
  });

  it('keeps tare through a purity edit, which invalidates only the sample', () => {
    // 15 §9.4: a tared force offset is a fact about the container, not about which cube
    // was edited.
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    settle(sig, (S.platterKg + 0.5) * G, 3);
    sig.tare();
    const tareBefore = sig.state.tareOffsetN;
    sig.invalidate();
    expect(sig.state.tareOffsetN).toBe(tareBefore);
    expect(settle(sig, (S.platterKg + 0.5) * G, 3).stableMassKg).toBeCloseTo(0, 2);
  });
});

describe('range and invalid states', () => {
  it('says UNDER MIN rather than inventing hundredths', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    const tiny = settle(sig, (S.platterKg + 0.02) * G, 3);
    expect(tiny.status).toBe('under-min');
    expect(tiny.stableMassKg).toBeNull();
  });

  it('says OL above capacity, on a stop, and at proof force — with no stale mass', () => {
    for (const over of [
      { force: (S.platterKg + S.ratedKg + 1) * G, sample: {} },
      { force: (S.platterKg + 1) * G, sample: { onStop: true } },
      { force: (S.platterKg + 1) * G, sample: { atProof: true } },
    ]) {
      const sig = new ScaleSignal();
      settle(sig, S.platterKg * G, 3);
      sig.zero(true);
      const state = settle(sig, over.force, 3, over.sample);
      expect(state.status).toBe('overload');
      expect(state.stableMassKg).toBeNull();
    }
  });

  it('flags partial support from geometry rather than reporting a small mass', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    const bridged = settle(sig, (S.platterKg + 1) * G, 3, { partialSupport: true });
    expect(bridged.status).toBe('partial-support');
    expect(bridged.stableMassKg).toBeNull();
  });

  it('quantises to whole divisions, so 1 kg never shows as 0.9999999', () => {
    const sig = new ScaleSignal();
    settle(sig, S.platterKg * G, 3);
    sig.zero(true);
    const s = settle(sig, (S.platterKg + 1) * G, 3);
    expect(s.displayedDivisions).toBe(100);
    expect(s.stableMassKg).toBe(100 * S.divisionKg);
  });

  it('is deterministic — identical input sequences give identical output', () => {
    const run = (): number | null => {
      const sig = new ScaleSignal();
      settle(sig, S.platterKg * G, 3);
      sig.zero(true);
      return settle(sig, (S.platterKg + 2.5) * G, 3).stableMassKg;
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------------

const DEG = Math.PI / 180;

function beam(over: Partial<BalanceSample> = {}): BalanceSample {
  return {
    angleRad: 0,
    angularSpeedRadS: 0,
    leftPanSpeedRadS: 0,
    rightPanSpeedRadS: 0,
    leftLoadKg: 0,
    rightLoadKg: 0,
    anyGrabbed: false,
    ...over,
  };
}

function settleBeam(sig: BalanceSignal, over: Partial<BalanceSample>, seconds = 2) {
  let last = sig.state;
  for (let i = 0; i < seconds * 60; i++) last = sig.update(beam(over), DT);
  return last;
}

describe('the balance reads its beam, not its arithmetic', () => {
  it('takes the sign from the ANGLE even when the loads say otherwise', () => {
    /*
     * The load hints could compute which side is heavier directly. They must not: an
     * instrument that tells you the answer by adding up masses is a calculator wearing a
     * balance costume, and it would report BALANCED for a beam jammed against its stop.
     * Here the hints claim the left is heavier while the beam is tipped right.
     */
    const sig = new BalanceSignal();
    const s = settleBeam(sig, { angleRad: -4 * DEG, leftLoadKg: 5, rightLoadKg: 1 });
    expect(s.status).toBe('right-heavy');
  });

  it('says MOVING while the beam is still travelling', () => {
    // Settling is judged on the angle HOLDING STILL, so a moving beam has to actually
    // move — feeding a constant angle and a large velocity would be describing a beam
    // that is somehow rotating without changing angle.
    const sig = new BalanceSignal();
    let last = sig.state;
    for (let i = 0; i < 120; i++) last = sig.update(beam({ angleRad: i * 0.01 * DEG }), DT);
    expect(last.status).toBe('moving');
  });

  it('says MOVING while a pan is still swinging, or a cube is in hand', () => {
    expect(settleBeam(new BalanceSignal(), { leftPanSpeedRadS: 1 }).status).toBe('moving');
    expect(settleBeam(new BalanceSignal(), { anyGrabbed: true }).status).toBe('moving');
  });

  it('calls level BALANCED only inside its tolerance', () => {
    expect(settleBeam(new BalanceSignal(), { angleRad: 0.1 * DEG }).status).toBe('balanced');
    expect(settleBeam(new BalanceSignal(), { angleRad: 1 * DEG }).status).toBe('left-heavy');
  });

  it('distinguishes pinned against the stop from merely tilted', () => {
    // At the stop the beam is saying "more than I can show", which is a different claim
    // from "this much heavier".
    const s = settleBeam(new BalanceSignal(), { angleRad: -B.limitDeg * DEG });
    expect(s.status).toBe('at-stop');
    expect(s.atStop).toBe(true);
  });

  it('refuses to read a pan loaded past its capacity', () => {
    const s = settleBeam(new BalanceSignal(), {
      angleRad: 2 * DEG,
      leftLoadKg: B.capacityKgPerPan + 1,
    });
    expect(s.status).toBe('overload');
  });

  it('zeroes only a settled beam, and then reads relative to that', () => {
    const sig = new BalanceSignal();
    settleBeam(sig, { angleRad: 0.5 * DEG });
    expect(sig.zero(0.5 * DEG, false)).toBe(false);
    expect(sig.zero(0.5 * DEG, true)).toBe(true);
    const s = settleBeam(sig, { angleRad: 0.5 * DEG });
    expect(s.angleDeg).toBeCloseTo(0, 6);
    expect(s.status).toBe('balanced');
  });
});
