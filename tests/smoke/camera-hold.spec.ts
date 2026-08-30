import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Tapping a cube must not move the camera (user, 2026-08-30).
 *
 * It did, and by a route nobody would guess from the call site: selecting shows the info
 * card, the card is UI coverage, the HUD reports coverage to the rig, and the rig re-fit
 * the stage to the new free area — so every tap on a cube threw away the zoom the player
 * had set and snapped back to the lab's own framing distance. Measured before the fix:
 * zoomed in to 1.93 m, tapped a cube, sat at 1.997 m.
 *
 * A unit test cannot see it. The bug lives in the seam between three components that are
 * each behaving correctly, and only a real tap through the real HUD strings them together
 * — which is exactly what this does.
 */

/** Where a cube is on screen, in CSS px. */
async function cubeAt(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const app = window.__dense!.app;
    const cube = [...app.entities.all][0]!;
    const v = cube.mesh.position.clone();
    v.project(app.render.camera);
    return {
      x: ((v.x + 1) / 2) * window.innerWidth,
      y: ((1 - v.y) / 2) * window.innerHeight,
    };
  });
}

const view = (
  page: Page,
): Promise<{ distM: number; target: { x: number; y: number; z: number } }> =>
  page.evaluate(() => {
    const v = window.__dense!.app.rig.view;
    return { distM: v.distM, target: v.target };
  });

test.describe('selecting a cube', () => {
  test('leaves the camera exactly where the player put it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    // Let the boot cube land, or the tap lands on a moving target.
    await page.waitForTimeout(1500);

    // Zoom in as a player would, and let the damping arrive.
    await page.evaluate(() => window.__dense!.app.rig.dolly(-25));
    await page.waitForTimeout(1200);
    const before = await view(page);

    const at = await cubeAt(page);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(1200);

    // It really was a select: the card is up.
    expect(await page.evaluate(() => window.__dense!.app.hud.infocard.isVisible)).toBe(true);

    const after = await view(page);
    expect(after.distM).toBeCloseTo(before.distM, 4);
    expect(after.target.x).toBeCloseTo(before.target.x, 4);
    expect(after.target.y).toBeCloseTo(before.target.y, 4);
    expect(after.target.z).toBeCloseTo(before.target.z, 4);

    // And dismissing it does not move anything back either.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    const dismissed = await view(page);
    expect(dismissed.distM).toBeCloseTo(before.distM, 4);
    expect(await page.evaluate(() => window.__dense!.app.hud.infocard.isVisible)).toBe(false);
  });
});
