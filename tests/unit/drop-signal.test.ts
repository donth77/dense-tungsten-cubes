import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { DropSignal } from '../../src/labs/drop/drop-signal.ts';
import type { DropSample } from '../../src/labs/drop/drop-signal.ts';
import type { ImpactEvent, SurfaceId } from '../../src/types.ts';

const DT = config.loop.DT;

function ev(over: Partial<ImpactEvent> = {}): ImpactEvent {
  return {
    a: 1,
    b: 'concrete',
    point: { x: 0, y: 0.02, z: 0 },
    normalSpeedMps: 6,
    energyJ: 40,
    effectiveMassKg: 2.36,
    forceN: 0,
    contactCount: 0,
    ...over,
  };
}

function sample(over: Partial<DropSample> = {}): DropSample {
  return {
    cubeYM: 1,
    cubeBottomYM: 0.975,
    speedMps: 6.26,
    angSpeedRadS: 0,
    massKg: 2.36,
    impacts: [],
    padBottomed: false,
    ...over,
  };
}

/** Run a canonical drop: fall n steps, impact, then rest until done. */
function runDrop(
  floor: SurfaceId,
  impact: ImpactEvent,
  over: { rebound?: number; padBottomed?: boolean } = {},
) {
  const sig = new DropSignal(1, 2, floor);
  for (let i = 0; i < 10; i++) sig.update(sample(), DT);
  // The impact SAMPLE is taken at the plate — the apex tracker seeds from it, so a
  // sample still carrying the falling height would inflate every rebound.
  sig.update(sample({ impacts: [impact], cubeYM: 0.045, cubeBottomYM: 0.021 }), DT);
  expect(sig.state.phase).toBe('settling');
  // Rise to the apex, then rest.
  const apex = 0.02 + (over.rebound ?? 0.01);
  sig.update(sample({ cubeBottomYM: apex, speedMps: 1 }), DT);
  const rest = sample({
    cubeBottomYM: 0.02,
    speedMps: 0,
    angSpeedRadS: 0,
    padBottomed: over.padBottomed ?? false,
  });
  for (let i = 0; i < 60; i++) sig.update(rest, DT);
  expect(sig.state.phase).toBe('done');
  return sig.state;
}

describe('the drop signal (16 §12.2) — three beats, nothing revised', () => {
  it("publishes the CUBE's energy at impact, with the delivered energy kept apart", () => {
    const sig = new DropSignal(1, 2, 'concrete');
    sig.update(sample(), DT);
    expect(sig.state.phase).toBe('falling');
    expect(sig.state.impact).toBeNull();
    sig.update(sample({ impacts: [ev({ energyJ: 33 })] }), DT);
    const imp = sig.state.impact!;
    expect(imp.vMps).toBeCloseTo(6.26, 6);
    expect(imp.energyJ).toBeCloseTo(0.5 * 2.36 * 6.26 ** 2, 6);
    expect(imp.momentumKgMps).toBeCloseTo(2.36 * 6.26, 6);
    expect(imp.deliveredJ).toBe(33);
    expect(imp.tFlightS).toBeCloseTo(2 * DT, 9);
    // Never revised: later samples change nothing about the impact beat.
    sig.update(sample({ speedMps: 99, impacts: [ev({ energyJ: 999 })] }), DT);
    expect(sig.state.impact).toEqual(imp);
  });

  it('the altimeter tracks the bottom face above the plate', () => {
    const sig = new DropSignal(1, 2, 'concrete');
    sig.update(sample({ cubeBottomYM: 1.52 }), DT);
    expect(sig.state.altitudeM).toBeCloseTo(1.5, 6);
  });

  it('rebound is measured from the post-impact apex', () => {
    const state = runDrop('steel', ev({ b: 'steel', energyJ: 100 }), { rebound: 0.72 });
    expect(state.reboundM).toBeCloseTo(0.72, 6);
    expect(state.verdict).toBe('rang');
  });

  it('waits out the rest dwell, but never forever', () => {
    const sig = new DropSignal(1, 2, 'concrete');
    sig.update(sample({ impacts: [ev()] }), DT);
    // Perpetual motion: the timeout closes the case.
    const jitter = sample({ speedMps: 1 });
    const steps = Math.ceil(config.drop.signal.settleTimeoutS / DT) + 2;
    for (let i = 0; i < steps; i++) sig.update(jitter, DT);
    expect(sig.state.phase).toBe('done');
    expect(sig.state.verdict).not.toBeNull();
  });

  it('speaks every verdict in the table (16 §7.6)', () => {
    expect(runDrop('concrete', ev({ energyJ: 450 })).verdict).toBe('cracked');
    expect(runDrop('concrete', ev({ energyJ: 250 })).verdict).toBe('chipped');
    expect(runDrop('concrete', ev({ energyJ: 50 })).verdict).toBe('landed');
    expect(runDrop('concrete', ev({ energyJ: 50 }), { rebound: 0.4 }).verdict).toBe('bounced');
    expect(runDrop('oak', ev({ b: 'oak', energyJ: 15 })).verdict).toBe('dented');
    expect(runDrop('sand', ev({ b: 'sand', energyJ: 15 })).verdict).toBe('cratered');
    expect(runDrop('steel', ev({ b: 'steel', energyJ: 6 })).verdict).toBe('rang');
    expect(
      runDrop('trampoline', ev({ b: 'trampoline', energyJ: 60 }), { rebound: 0.9 }).verdict,
    ).toBe('caught');
    expect(runDrop('foam', ev({ b: 'foam', energyJ: 30 })).verdict).toBe('absorbed');
    expect(
      runDrop('trampoline', ev({ b: 'trampoline', energyJ: 900 }), { padBottomed: true }).verdict,
    ).toBe('bottomed-out');
  });

  it('partner verdicts outrank everything', () => {
    expect(runDrop('concrete', ev({ b: 7, energyJ: 900 })).verdict).toBe('hit-a-cube');
    expect(runDrop('concrete', ev({ point: { x: 0.9, y: 0, z: 0 }, energyJ: 900 })).verdict).toBe(
      'off-the-plate',
    );
  });
});
