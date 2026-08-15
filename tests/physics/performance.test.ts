/**
 * Fixed-step cost (14 §9, "Performance"; test gap 9).
 *
 * The old adaptive substepping made this measurement matter more than usual: a scene
 * containing one fast 0.25" cube could demand twelve substeps for EVERY body, so the
 * worst supported mixture of tiny and large bodies was also the most expensive one. The
 * fixed step removes that coupling, and this file is what keeps it removed.
 *
 * These are wall-clock numbers on whatever machine runs them, so the thresholds are
 * deliberately loose — they are a regression tripwire, not a device budget. The device
 * budget (p95 < 4 ms on a named phone) needs a real phone and is still open.
 */
import { describe, it, expect } from 'vitest';
import { config } from '../../src/config.ts';
import { IN, cube, run, worldWithFloor } from './harness.ts';
import type { ImpactEvent } from '../../src/types.ts';

/** Median and p95 of the per-step cost, ms. */
function stepCost(pw: Awaited<ReturnType<typeof worldWithFloor>>, frames: number) {
  const scratch: ImpactEvent[] = [];
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    scratch.length = 0;
    pw.step(config.loop.DT, scratch);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length * 0.5)]!,
    p95: samples[Math.floor(samples.length * 0.95)]!,
  };
}

describe('fixed-step cost', () => {
  it('a full scene at the cube limit stays well inside one frame', async () => {
    const pw = await worldWithFloor('concrete');
    for (let i = 0; i < config.limits.maxCubes; i++) {
      const sideIn = [0.25, 0.5, 1, 2, 4][i % 5]!;
      cube(pw, 'W', sideIn, {
        x: (i % 10) * 0.25 - 1.2,
        y: 0.3 + i * 0.06,
        z: Math.floor(i / 10) * 0.25 - 0.6,
      });
    }
    run(pw, 2); // let them land
    const { median, p95 } = stepCost(pw, 300);
    pw.free();
    console.log(
      `[perf] ${config.limits.maxCubes} bodies: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
    );
    expect(p95).toBeLessThan(16.6); // one 60 Hz frame, entirely to physics
  });

  it('one fast tiny cube no longer taxes the whole scene', async () => {
    /*
     * The regression this file exists for. Under the old policy the tiny cube's
     * half-extent set the substep count for every body in the world, so this scene cost
     * up to 12x the quiet one — measured at 0.079 ms/frame for 1 substep against
     * 1.158 ms/frame for 12, on 60 bodies.
     */
    async function scene(withFastTiny: boolean) {
      const pw = await worldWithFloor('concrete');
      for (let i = 0; i < 30; i++) {
        cube(pw, 'W', 2, {
          x: (i % 6) * 0.12 - 0.3,
          y: 0.3 + i * 0.06,
          z: Math.floor(i / 6) * 0.12,
        });
      }
      run(pw, 2);
      if (withFastTiny) {
        const tiny = cube(pw, 'W', 0.25, { x: -2, y: 1, z: -2 });
        pw.setVelocity(tiny, { x: 40, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      }
      const cost = stepCost(pw, 200);
      pw.free();
      return cost;
    }
    const quiet = await scene(false);
    const busy = await scene(true);
    console.log(
      `[perf] quiet median ${quiet.median.toFixed(3)} ms, with a 40 m/s 0.25" cube ${busy.median.toFixed(3)} ms`,
    );
    // Allow generous headroom for CCD's real cost on the one body that needs it, but
    // nothing like the order of magnitude the global substep used to add.
    expect(busy.median).toBeLessThan(Math.max(quiet.median * 4, 1));
  });

  it('an empty-ish scene is essentially free', async () => {
    const pw = await worldWithFloor('concrete');
    cube(pw, 'W', 2, { x: 0, y: (2 * IN) / 2 + 1e-4, z: 0 });
    run(pw, 2);
    const { median } = stepCost(pw, 200);
    pw.free();
    expect(median).toBeLessThan(1);
  });
});
