import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite (08 §13). Runs against the dev server with the debug facade exposed.
 *
 * The three mobile projects come from 12 §6. The fps probe is deliberately NOT a CI
 * gate: hosted runners rasterize through SwiftShader, so the number measures the runner
 * rather than the build. CI asserts no-crash and frames-advance; real numbers come from
 * a headed run on a real GPU and the per-milestone phone pass.
 */
/*
 * 5181, and deliberately NOT the dev server's 5180.
 *
 * Two reasons, both learned the hard way. 5199 was already taken on this machine by an
 * unrelated `python -m http.server`, and because `reuseExistingServer` only probes for a
 * 200 it happily adopted it — all 56 tests then ran against somebody else's app and timed
 * out waiting for `window.__dense`, which reads exactly like a catastrophic regression.
 *
 * And keeping it off the dev port means the suite always starts its own server instead of
 * adopting whatever `pnpm dev` happens to be running. A dev server restarted or killed
 * mid-run took smoke down with it more than once.
 */
const PORT = Number(process.env['DENSE_PORT'] ?? 5181);
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
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
