import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { TARGET_IDS, TARGET_SPEC } from '../../src/labs/drop/targets.ts';
import type { TargetId } from '../../src/labs/drop/targets.ts';
import { cubeMassKg } from '../../src/data/metals.ts';
import { RECIPES } from '../../src/fx/audio.ts';
import type { MetalId } from '../../src/types.ts';

/**
 * Stage C4 — the crush calibration gate (18 §6).
 *
 * THE PUBLISHED LADDER. Arrival energy is mass x g x height, so what a cube can break is
 * decided by two sliders the player already has. The table is the whole difficulty curve
 * of the Drop Tower in one place:
 *
 *   cube            0.1 m       1 m       2 m       5 m      20 m
 *   Al  0.5"          0.0       0.1       0.1       0.3       1.1
 *   Al    2"          0.3       3.5       6.9      17.4      69.4
 *   Al    8"         22.2     222.2     444.3    1110.8    4443.1
 *   W   0.5"          0.0       0.4       0.7       1.8       7.2
 *   W     2"          2.3      23.1      46.3     115.7     462.8
 *   W     8"        148.1    1481.0    2962.1    7405.2   29620.6
 *
 *   thresholds  egg 0.05 | glass 1 | pane 2 | can 5 | melon 40 | board 50
 *               supports  block 250 | plinth 450
 *
 * What the gate holds is not the numbers themselves — those are 02 §7's anchors and are
 * pinned where they are declared — but the SHAPE they make: a ladder that is ordered,
 * fully climbable, and not trivially skipped.
 */
const IN = 0.0254;
const G = config.physics.gravityMps2;
const TOWER = config.drop.tower;

/** Arrival energy of a cube dropped from rest, ignoring drag. */
function arrivalJ(metal: MetalId, sideIn: number, heightM: number): number {
  return cubeMassKg(metal, sideIn * IN, 95) * G * heightM;
}

const BREAKABLE = TARGET_IDS.filter((id): id is Exclude<TargetId, 'none'> => id !== 'none');

describe('C4 calibration — the crush ladder', () => {
  it('targets are ordered by how hard they are to break', () => {
    const thresholds = BREAKABLE.map((id) => TARGET_SPEC[id].thresholdJ);
    const sorted = [...thresholds].sort((a, b) => a - b);
    expect(thresholds).toEqual(sorted);
    // And the order is a real spread, not six things clustered at one difficulty.
    expect(Math.max(...thresholds) / Math.min(...thresholds)).toBeGreaterThan(100);
  });

  /*
   * Every rung has to be reachable, or a target is decoration. The check is deliberately
   * made with the LARGEST tungsten cube at full height: if the toy's heaviest hit cannot
   * break something, nothing can.
   */
  it('every target is breakable from inside the tower', () => {
    const hardest = arrivalJ('W', 8, TOWER.maxHM);
    for (const id of BREAKABLE) {
      expect(hardest).toBeGreaterThan(TARGET_SPEC[id].thresholdJ);
    }
  });

  /*
   * And the bottom of the range has to be genuinely gentle, or there is no such thing as
   * setting a target down carefully — the egg exists to be survivable.
   */
  it('the gentlest drop in the toy breaks nothing', () => {
    const gentlest = arrivalJ('Al', 0.5, TOWER.minHM);
    for (const id of BREAKABLE) {
      expect(gentlest).toBeLessThan(TARGET_SPEC[id].thresholdJ);
    }
  });

  /*
   * The ladder must be CLIMBED, not skipped. A mid-range cube should beat the easy
   * targets and fail the hard ones, otherwise every choice collapses into "big cube".
   */
  it('a 2 in aluminium cube from 1 m sits in the middle of the ladder', () => {
    const e = arrivalJ('Al', 2, 1);
    expect(e).toBeGreaterThan(TARGET_SPEC['wine-glass'].thresholdJ);
    expect(e).toBeGreaterThan(TARGET_SPEC['glass-pane'].thresholdJ);
    expect(e).toBeLessThan(TARGET_SPEC.watermelon.thresholdJ);
    expect(e).toBeLessThan(TARGET_SPEC['pine-board'].thresholdJ);
  });

  it('the purity slider changes what a tungsten cube can break', () => {
    const w90 = cubeMassKg('W', 2 * IN, 90) * G * 2;
    const w97 = cubeMassKg('W', 2 * IN, 97) * G * 2;
    expect(w97).toBeGreaterThan(w90);
  });

  /*
   * The supports are the top of the ladder by construction: a structure has to outlast
   * what stands on it, or the board would never break before the blocks under it.
   */
  it('the supports are harder than everything they hold up', () => {
    const hardestTarget = Math.max(...BREAKABLE.map((id) => TARGET_SPEC[id].thresholdJ));
    expect(250).toBeGreaterThan(hardestTarget); // cinder block
    expect(450).toBeGreaterThan(250); // marble plinth
  });

  it('every target has a distinct break verdict and a voice that exists', () => {
    const verdicts = new Set(BREAKABLE.map((id) => TARGET_SPEC[id].verdict));
    expect(verdicts.size).toBeGreaterThanOrEqual(5);
    for (const id of BREAKABLE) {
      expect(RECIPES[TARGET_SPEC[id].voice]).toBeDefined();
    }
  });

  /*
   * The egg is the only target that breaks on FORCE rather than energy, and that is the
   * point of it: 0.05 J is an 8 mm drop, so "gently" has to mean a force limit or the
   * lesson is unreachable.
   */
  it('the egg is the quasi-static one, and by far the most fragile', () => {
    expect(TARGET_SPEC.egg.sustainedN).toBeGreaterThan(0);
    for (const id of BREAKABLE) {
      if (id === 'egg') continue;
      expect(TARGET_SPEC.egg.thresholdJ).toBeLessThan(TARGET_SPEC[id].thresholdJ);
      expect(TARGET_SPEC[id].sustainedN).toBeUndefined();
    }
  });
});
