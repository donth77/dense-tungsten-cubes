import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * A lab switch starts from an empty field (user decision 2026-08-23).
 *
 * 08 §9 had cubes persist across labs. In practice a cube on the balance's pan had the
 * balance torn down from under it and fell 40 cm, and a cube on a Sandbox mat did the
 * same — so the switch clears the field. Whether the NEW lab gets a starter cube is the
 * lab's own call (`spawnOnEntry`, user decision 2026-08-24): the Sandbox spawns one —
 * the first thud is its opening move — and the instrument labs greet you as a cleared
 * bench. The held cube is released first, not thrown, and the selection is dropped.
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
  await page.waitForTimeout(1000);
}

test.describe('switching labs', () => {
  test('clears the field; only the Sandbox seeds a starter cube', async ({ page }) => {
    await boot(page);

    const before = await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.spawn();
      app.spawn();
      await new Promise((r) => setTimeout(r, 300));
      app.bus.emit('select', { id: [...app.entities.all][0]!.id });
      await new Promise((r) => setTimeout(r, 100));
      return { count: app.entities.size, lab: app.labs.activeId };
    });
    expect(before.count).toBe(3);
    expect(before.lab).toBe('sandbox');

    await page.getByRole('tab', { name: 'Weigh' }).click();
    await page.waitForFunction(() => window.__dense!.app.labs.activeId === 'weigh', null, {
      timeout: 10_000,
    });
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => {
      const app = window.__dense!.app;
      return {
        count: app.entities.size,
        cardShown: getComputedStyle(document.querySelector('.infocard')!).display !== 'none',
        markerVisible: app.render.selection.visible,
        holding: app.hand.isHolding,
      };
    });
    // The three Sandbox cubes are gone, and Weigh starts EMPTY — no starter cube.
    expect(after.count).toBe(0);
    expect(after.cardShown).toBe(false);
    expect(after.markerVisible).toBe(false);
    expect(after.holding).toBe(false);

    // And back again: Sandbox spawns its starter, the way boot does.
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.waitForFunction(() => window.__dense!.app.labs.activeId === 'sandbox', null, {
      timeout: 10_000,
    });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__dense!.app.entities.size)).toBe(1);
  });

  test('releases a held cube rather than flinging it into the next lab', async ({ page }) => {
    await boot(page);
    await page.evaluate(async () => {
      const app = window.__dense!.app;
      const cube = [...app.entities.all][0]!;
      app.hand.grab(cube.id, cube.mesh.position.clone(), app.render.camera);
    });
    expect(await page.evaluate(() => window.__dense!.app.hand.isHolding)).toBe(true);

    await page.getByRole('tab', { name: 'Weigh' }).click();
    await page.waitForFunction(() => window.__dense!.app.labs.activeId === 'weigh', null, {
      timeout: 10_000,
    });
    const state = await page.evaluate(() => {
      const app = window.__dense!.app;
      return { holding: app.hand.isHolding, count: app.entities.size };
    });
    expect(state.holding).toBe(false);
    expect(state.count).toBe(0);
  });
});
