import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { buildBalance, buildScale, spikeWorld, DT, G, tail, tailSpan } from './weigh-rig.ts';

const S = config.weigh.scale;
const B = config.weigh.balance;

/**
 * Stage W0 — the Weigh Station's numerical and API gates (15 §12 W0).
 *
 * These do not test a lab; there is no lab yet. They test that the NUMBERS in
 * `config.weigh` still produce an instrument, so W1 can add the physics facade knowing
 * what it has to be able to express. Everything runs against real Rapier at the app's own
 * fixed 60 Hz and solver settings — see `weigh-rig.ts` for why that matters.
 *
 * The exits, from 15 §12:
 *   - no NaNs, tunnelling, growing accumulators or persistent jitter;
 *   - a 1 kg load's stable raw force converges to its weight;
 *   - empty / 1 kg / 5 kg all settle without changing global timestep or solver settings;
 *   - equal loads return the beam to zero with gravity alone, no motor.
 */

/** Settle the empty cell, place a load, run, and report the steady reading. */
async function weigh(loadKg: number, seconds = 3) {
  const world = await spikeWorld();
  const rig = buildScale(world, {
    platterKg: S.platterKg,
    ratedKg: S.ratedKg,
    travelM: S.travelM,
    zeta: S.zeta,
    clampDamping: S.clampDamping,
    proofFactor: S.proofFactor,
  });
  for (let i = 0; i < 120; i++) rig.step();
  const tareN = tail([rig.step()], 1);
  if (loadKg > 0) rig.addLoad(loadKg, 0.05);
  const f: number[] = [];
  let maxCompressMm = 0;
  for (let i = 0; i < seconds * 60; i++) {
    f.push(rig.step());
    maxCompressMm = Math.max(maxCompressMm, (rig.y0 - rig.platter.translation().y) * 1000);
  }
  return {
    grossKg: tail(f, 30) / G,
    netKg: (tail(f, 30) - tareN) / G,
    spanN: tailSpan(f, 30),
    maxCompressMm,
    stopMm: S.travelM * S.stopFactor * 1000,
    finite: f.every(Number.isFinite),
  };
}

describe('the load cell', () => {
  it('reads the platter alone as its own dead load', async () => {
    const r = await weigh(0);
    expect(r.finite).toBe(true);
    expect(r.grossKg).toBeCloseTo(S.platterKg, 3);
    // Tare is what removes it (15 §7.6) — gross is honest about carrying it.
    expect(r.netKg).toBeCloseTo(0, 3);
  });

  it.each([0.5, 1, 2.5, 5])('converges to the true weight of a %s kg load', async (loadKg) => {
    const r = await weigh(loadKg);
    expect(r.finite).toBe(true);
    // 15 §13.2's raw gate: max(1 g, 100 ppm).
    const tol = Math.max(0.001, 1e-4 * (S.platterKg + loadKg));
    expect(Math.abs(r.netKg - loadKg)).toBeLessThan(tol);
  });

  it('holds a quiet signal once settled, well inside one division', async () => {
    const r = await weigh(1);
    // 15 §13.2: stable force span <= d x g over the window.
    expect(r.spanN).toBeLessThan(S.divisionKg * G);
  });

  it('settles a careful in-range placement inside the 2 s gate', async () => {
    const world = await spikeWorld();
    const rig = buildScale(world, {
      platterKg: S.platterKg,
      ratedKg: S.ratedKg,
      travelM: S.travelM,
      zeta: S.zeta,
      clampDamping: S.clampDamping,
    });
    for (let i = 0; i < 120; i++) rig.step();
    rig.addLoad(1, 0.05);
    const target = (S.platterKg + 1) * G;
    const tolN = Math.max(0.001, 1e-4 * (S.platterKg + 1)) * G;
    let settled = -1;
    const f: number[] = [];
    for (let i = 0; i < 180; i++) f.push(rig.step());
    for (let i = f.length - 1; i >= 0; i--) {
      if (Math.abs(f[i]! - target) > tolN) {
        settled = i + 1;
        break;
      }
      if (i === 0) settled = 0;
    }
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(settled * DT).toBeLessThan(2);
  });

  it('keeps a legitimate rated placement clear of the lower stop', async () => {
    // The stop is the OVERLOAD tell (15 §7.4). If a valid 5 kg weighing touched it, the
    // scale would flash OL on a reading it is supposed to be able to make.
    const r = await weigh(S.ratedKg);
    expect(r.maxCompressMm).toBeLessThan(r.stopMm);
  });

  it('is stable at the extremes of its own range, not just in the middle', async () => {
    // The empty platter is the hard case: it is the lightest mass the spring ever acts on.
    for (const loadKg of [0, S.ratedKg]) {
      const r = await weigh(loadKg, 5);
      expect(r.finite, `${loadKg} kg went non-finite`).toBe(true);
      expect(r.spanN, `${loadKg} kg never went quiet`).toBeLessThan(S.divisionKg * G);
    }
  });
});

// ---------------------------------------------------------------------------------

/*
 * FROZEN AT THE W0 VALUES, not read from `config.weigh.balance`.
 *
 * W0's job was to choose parameters, and it recorded what those parameters do. W2 then
 * built the real instrument and retuned several of them for reasons W0 could not see —
 * pans an order of magnitude heavier so a 2 in tungsten cube cannot flip a dish, a
 * shallower counterweight to buy the sensitivity that cost. Left reading live config,
 * these gates silently start measuring an instrument they never validated, and the first
 * symptom was a 5 % difference pinning the beam at its stop.
 *
 * The live gates for the shipped balance are in `weigh-instruments.test.ts`, which drives
 * `BalanceInstrument` itself.
 */
const W0_BALANCE = {
  beamKg: 1.4,
  panKg: 0.3,
  armM: 0.37,
  dropM: 0.2,
  keelDropM: 0.12,
  keelMassFraction: 0.7,
  pivotDamping: 0.75,
  limitDeg: 12,
  panRadiusM: 0.115,
  panThicknessM: 0.004,
  panRimHeightM: 0.012,
  hookRingM: 0.02,
  panLinearDamping: 1.6,
  panAngularDamping: 2.2,
} as const;

async function balance(loads: [number, number], nudgeRadS = 0, seconds = 7) {
  const world = await spikeWorld();
  const rig = buildBalance(world, { ...W0_BALANCE });
  for (let i = 0; i < 300; i++) rig.step();
  if (loads[0] > 0) rig.addLoad(0, loads[0], 0.05);
  if (loads[1] > 0) rig.addLoad(1, loads[1], 0.05);
  for (let i = 0; i < 400; i++) rig.step();
  const restDeg = rig.angleDeg();
  if (nudgeRadS) rig.beam.setAngvel({ x: 0, y: 0, z: nudgeRadS }, true);
  const angles: number[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    rig.step();
    angles.push(rig.angleDeg());
  }
  let settle = angles.length;
  for (let i = angles.length - 1; i >= 0; i--) {
    if (Math.abs(angles[i]! - restDeg) > 0.25) {
      settle = i + 1;
      break;
    }
    if (i === 0) settle = 0;
  }
  return {
    restDeg,
    settleS: settle * DT,
    settled: settle < angles.length,
    finalDeg: angles[angles.length - 1]!,
    peakDeg: Math.max(...angles.map(Math.abs)),
    finite: angles.every(Number.isFinite),
  };
}

describe('the equal-arm balance', () => {
  it('rests level when empty', async () => {
    const r = await balance([0, 0]);
    expect(r.finite).toBe(true);
    expect(Math.abs(r.restDeg)).toBeLessThan(0.25);
  });

  it('rests level under equal loads', async () => {
    // The one that caught two real bugs: an un-mirrored bridle (1.0 deg off), and
    // constraint-creation order handing the last-built pan a smaller residual.
    const r = await balance([1, 1]);
    expect(Math.abs(r.restDeg)).toBeLessThan(0.25);
  });

  it('returns to level after a nudge, with no motor anywhere in the rig', async () => {
    // 15 §6.2: gravity restores, damping only dissipates. If this passes, the below-pivot
    // centre of mass is doing the work — there is nothing else in `buildBalance` that could.
    const r = await balance([1, 1], 1.2);
    expect(r.finite).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.settleS).toBeLessThan(3);
    expect(Math.abs(r.finalDeg)).toBeLessThan(0.25);
  });

  it('tips the correct way, every time', async () => {
    const heavierRight = await balance([1, 1.5]);
    const heavierLeft = await balance([1.5, 1]);
    // Positive is left-down, so a heavier right pan must read negative.
    expect(heavierRight.restDeg).toBeLessThan(-1);
    expect(heavierLeft.restDeg).toBeGreaterThan(1);
  });

  it('shows a 5 % difference as a readable angle rather than pinning the beam', async () => {
    // 15 §1's signature demonstration: seven aluminium cubes against one tungsten are
    // about 5 % heavier. If that slams into the stop, every mismatch looks the same.
    const small = await balance([1, 1.05]);
    const large = await balance([1, 2]);
    expect(Math.abs(small.restDeg)).toBeGreaterThan(1);
    expect(Math.abs(small.restDeg)).toBeLessThan(B.limitDeg - 1);
    expect(Math.abs(large.restDeg)).toBeGreaterThan(Math.abs(small.restDeg));
  });

  it('never travels past its stop by more than solver tolerance', async () => {
    const r = await balance([1, 3]);
    expect(r.peakDeg).toBeLessThan(B.limitDeg + 0.5);
  });

  it('is deterministic — the same inputs give the same angle', async () => {
    // 15 §9.5. Nothing in the rig reads wall-clock or a random source; this pins it.
    const a = await balance([1, 1.05]);
    const b = await balance([1, 1.05]);
    expect(a.restDeg).toBe(b.restDeg);
  });
});
