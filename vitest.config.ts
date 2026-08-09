import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — pure modules, no wasm, no DOM (08 §13). `tests/smoke/` is Playwright
 * and must not be collected here: its `test.describe` is a different `test`.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
