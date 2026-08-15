import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The selection brackets are a label for a cube AT REST.
 *
 * Anything else hides them — a drag, a slide, a fall, a spin on the spot — because a
 * bright accent-orange cage riding a cube in motion competes with the collision, which is
 * the one event the whole toy exists to show. The two cases worth proving in the real app
 * are the two the unit tests can't reach: a cube held perfectly still by The Hand (still
 * by every velocity measure, and still must not show brackets), and a full drop-and-settle
 * cycle where they have to come back on their own without flickering on the way.
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
  await page.waitForTimeout(1000);
}

/** Waits for the boot cube to settle, then selects it. Returns its id. */
async function selectSettledCube(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const app = window.__dense!.app;
    const cube = [...app.entities.all][0]!;
    for (let i = 0; i < 80; i++) {
      const v = cube.lastVel;
      const w = app.physics.angularVelocityOf(cube.body);
      if (Math.hypot(v.x, v.y, v.z) < 0.01 && Math.hypot(w.x, w.y, w.z) < 0.05) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    app.bus.emit('select', { id: cube.id });
    return cube.id;
  });
}

const markerVisible = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.__dense!.app.render.selection.visible);

test.describe('the selection marker', () => {
  test('a cube held perfectly still still counts as moving', async ({ page }) => {
    await boot(page);
    const id = await selectSettledCube(page);

    await page.waitForFunction(() => window.__dense!.app.render.selection.visible, null, {
      timeout: 5000,
    });

    // Grab it at its own centre, with the drag target where the cube already is: the PD
    // spring has nothing to pull against, so the cube barely moves. Under a velocity-only
    // rule the brackets would sit there through the whole grab.
    const held = await page.evaluate(async (cubeId) => {
      const app = window.__dense!.app;
      const cube = app.entities.get(cubeId)!;
      app.hand.grab(cubeId, cube.mesh.position.clone(), app.render.camera);
      await new Promise((r) => setTimeout(r, 400));
      const v = cube.lastVel;
      return {
        markerVisible: app.render.selection.visible,
        stillSelected: app.entities.selectedId === cubeId,
        cardShown: getComputedStyle(document.querySelector('.infocard')!).display !== 'none',
        speedMps: Math.hypot(v.x, v.y, v.z),
      };
    }, id);

    expect(held.markerVisible).toBe(false);
    // The cube really is stationary — this is the held rule, not the speed rule.
    expect(held.speedMps).toBeLessThan(0.02);
    // Hiding the brackets must not drop the selection: the card and Delete still work.
    expect(held.stillSelected).toBe(true);
    expect(held.cardShown).toBe(true);

    await page.evaluate(() => window.__dense!.app.hand.release());
    await page.waitForFunction(() => window.__dense!.app.render.selection.visible, null, {
      timeout: 5000,
    });
    expect(await markerVisible(page)).toBe(true);
  });

  test('they leave when the cube is dropped and come back once it settles', async ({ page }) => {
    await boot(page);
    const id = await selectSettledCube(page);

    await page.waitForFunction(() => window.__dense!.app.render.selection.visible, null, {
      timeout: 5000,
    });

    // Lift and drop, rather than waiting out a real throw — the rule under test is the
    // fade, not gravity.
    await page.evaluate((cubeId) => {
      const app = window.__dense!.app;
      const cube = app.entities.get(cubeId)!;
      app.physics.setTransform(cube.body, { x: cube.curr.p.x, y: 0.6, z: cube.curr.p.z }, true);
    }, id);

    await page.waitForTimeout(150);
    expect(await markerVisible(page)).toBe(false);

    // Falling, landing, bouncing and rocking — none of it may flash the brackets back on.
    const flashes = await page.evaluate(async () => {
      const app = window.__dense!.app;
      let seen = 0;
      for (let i = 0; i < 40; i++) {
        const v = app.entities.get(app.entities.selectedId!)!.lastVel;
        if (Math.hypot(v.x, v.y, v.z) < 0.02) break;
        if (app.render.selection.visible) seen++;
        await new Promise((r) => setTimeout(r, 25));
      }
      return seen;
    });
    expect(flashes).toBe(0);

    await page.waitForFunction(() => window.__dense!.app.render.selection.visible, null, {
      timeout: 6000,
    });
    expect(await markerVisible(page)).toBe(true);
  });
});
