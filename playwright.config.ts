import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite (08 §13). Runs against the dev server with the debug facade exposed.
 *
 * The three mobile projects come from 12 §6. The fps probe is deliberately NOT a CI
 * gate: hosted runners rasterize through SwiftShader, so the number measures the runner
 * rather than the build. CI asserts no-crash and frames-advance; real numbers come from
 * a headed run on a real GPU and the per-milestone phone pass.
 */
const PORT = Number(process.env['DENSE_PORT'] ?? 5199);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false, // one WebGL context at a time keeps timings meaningful
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  timeout: 45_000,
  use: {
    baseURL: BASE,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    // 12 §6 — the layout classes land at M1 step 14; the viewports are wired now so the
    // reflow assertions have somewhere to go the moment the classes exist.
    {
      name: 'phone-portrait',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'phone-landscape',
      use: { ...devices['Pixel 7'], viewport: { width: 844, height: 390 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
