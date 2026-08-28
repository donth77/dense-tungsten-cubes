import { expect, test } from '@playwright/test';

/**
 * Boot smoke (08 §13): the page loads, WebGL2 comes up, no console errors, and the
 * landing cube actually lands.
 */
test.describe('boot', () => {
  test('keeps the loading cover up until the initial lab is ready', async ({ page }) => {
    // A first visit has to fetch the lazy Sandbox chunk. Hold that request long enough
    // to inspect the in-between state: an empty, temporarily framed canvas must never be
    // exposed just because this chunk is cold or the connection is slow.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawRequest!: () => void;
    const requested = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    await page.route('**/src/labs/sandbox/index.ts*', async (route) => {
      sawRequest();
      await held;
      await route.continue();
    });

    const navigation = page.goto('/', { waitUntil: 'domcontentloaded' });
    await requested;
    await expect(page.locator('#boot')).toBeVisible();

    release();
    await navigation;
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    await expect(page.locator('#boot')).toHaveCount(0);
    expect(await page.evaluate(() => window.__dense?.app.labs.activeId)).toBe('sandbox');
    expect(await page.evaluate(() => window.__dense?.bodyCount())).toBe(1);
  });

  test('loads with a WebGL2 context, no console errors, and lands the first cube', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });

    // Neither failure card should be showing.
    await expect(page.locator('#fail-webgl')).toBeHidden();
    await expect(page.locator('#fail-physics')).toBeHidden();
    // The boot placeholder is removed once the loop is running.
    await expect(page.locator('#boot')).toHaveCount(0);

    // Pillar 3: the first cube is already falling when you arrive, so the first thud
    // costs zero clicks. It must actually reach the floor.
    await page.waitForFunction(() => window.__dense?.lastImpact() != null, null, {
      timeout: 10_000,
    });
    const impact = await page.evaluate(() => window.__dense!.lastImpact());
    expect(impact?.b).toBe('concrete');
    expect(impact?.energyJ).toBeGreaterThan(0);

    expect(await page.evaluate(() => window.__dense!.bodyCount())).toBe(1);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('frames advance', async ({ page }) => {
    // Not an fps *threshold* — hosted runners rasterize through SwiftShader, so the
    // number would measure the runner (08 §13). This asserts the loop is alive.
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    const before = await page.evaluate(() => window.__dense!.app.entities.get(1)?.curr.p.y ?? 0);
    await page.waitForTimeout(500);
    const fps = await page.evaluate(() => window.__dense!.fps());
    expect(fps).toBeGreaterThan(0);
    expect(Number.isFinite(before)).toBe(true);
  });

  test('no horizontal overflow at any viewport (12 §6)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
