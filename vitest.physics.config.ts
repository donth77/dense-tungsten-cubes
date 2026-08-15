import { defineConfig } from 'vitest/config';

/**
 * The actual-Rapier calibration suite (14 §7). Separate from `vitest.config.ts` because
 * these tests boot the real WASM solver and run whole seconds of simulated time: they are
 * measurements, not unit tests, and they must not slow the fast `pnpm test` loop.
 *
 * Single-threaded on purpose. Each file builds its own `World`s, and letting several
 * wasm instances share a machine makes wall-clock timings — and therefore any timeout —
 * depend on how many workers happened to be scheduled.
 */
export default defineConfig({
  test: {
    include: ['tests/physics/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
