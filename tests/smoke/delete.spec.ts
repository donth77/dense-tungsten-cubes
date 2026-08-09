import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Removing one cube — the Remove button, the Delete key, and fling-off-the-edge.
 *
 * The cull half of this exists because the gap was real: the floor is a finite 6 m slab
 * and nothing ever cleaned up what fell off it, so a discarded cube kept a Rapier body,
 * a mesh and a shadow blob alive off-screen forever AND counted against `maxCubes` —
 * meaning a full scene could evict cubes you could see to make room for cubes you
 * could not.
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
  await page.waitForTimeout(1000);
}

test.describe('removing a cube', () => {
  test('selection drives both the card and the 3D marker', async ({ page }) => {
    await boot(page);

    const selected = await page.evaluate(async () => {
      const app = window.__dense!.app;
      const cube = [...app.entities.all][0]!;
      // Wait for it to actually settle: the marker fades out while a cube is moving, so
      // testing it mid-drop would be testing the wrong state.
      for (let i = 0; i < 60; i++) {
        const v = cube.lastVel;
        if (Math.hypot(v.x, v.y, v.z) < 0.01) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      app.bus.emit('select', { id: cube.id });
      await new Promise((r) => setTimeout(r, 120));
      const marker = app.render.selection;
      return {
        cardShown: getComputedStyle(document.querySelector('.infocard')!).display !== 'none',
        markerVisible: marker.visible,
        // The brackets must actually be ON the cube, not parked at the origin.
        offsetFromCube: marker.position.distanceTo(cube.mesh.position),
        scale: marker.scale.x,
        sideM: cube.spec.sideM,
      };
    });

    expect(selected.cardShown).toBe(true);
    expect(selected.markerVisible).toBe(true);
    expect(selected.offsetFromCube).toBeLessThan(1e-6);
    // Sized to the cube it marks, and sitting just outside its faces.
    expect(selected.scale).toBeGreaterThan(selected.sideM);
    expect(selected.scale).toBeLessThan(selected.sideM * 1.2);

    const cleared = await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.bus.emit('select', { id: null });
      await new Promise((r) => setTimeout(r, 120));
      return {
        cardShown: getComputedStyle(document.querySelector('.infocard')!).display !== 'none',
        markerVisible: app.render.selection.visible,
      };
    });
    expect(cleared.cardShown).toBe(false);
    expect(cleared.markerVisible).toBe(false);
  });

  test('the Delete key removes exactly the selected cube', async ({ page }) => {
    await boot(page);

    const before = await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.spawn();
      app.spawn();
      await new Promise((r) => setTimeout(r, 200));
      const target = [...app.entities.all][1]!;
      app.bus.emit('select', { id: target.id });
      await new Promise((r) => setTimeout(r, 120));
      return { count: app.entities.size, targetId: target.id };
    });
    expect(before.count).toBe(3);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    const after = await page.evaluate(() => {
      const app = window.__dense!.app;
      return {
        count: app.entities.size,
        ids: [...app.entities.all].map((e) => e.id),
        markerVisible: app.render.selection.visible,
        cardShown: getComputedStyle(document.querySelector('.infocard')!).display !== 'none',
      };
    });

    expect(after.count).toBe(2);
    expect(after.ids).not.toContain(before.targetId);
    // Deleting the selection must take the whole selected state with it.
    expect(after.markerVisible).toBe(false);
    expect(after.cardShown).toBe(false);
  });

  test('Backspace works too, for keyboards with no Delete key', async ({ page }) => {
    await boot(page);
    await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.spawn();
      await new Promise((r) => setTimeout(r, 200));
      app.bus.emit('select', { id: [...app.entities.all][0]!.id });
      await new Promise((r) => setTimeout(r, 120));
    });
    const before = await page.evaluate(() => window.__dense!.app.entities.size);

    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.__dense!.app.entities.size)).toBe(before - 1);
  });

  test('the Remove button removes the selected cube', async ({ page }) => {
    await boot(page);
    await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.spawn();
      await new Promise((r) => setTimeout(r, 200));
      app.bus.emit('select', { id: [...app.entities.all][0]!.id });
      await new Promise((r) => setTimeout(r, 120));
    });
    const before = await page.evaluate(() => window.__dense!.app.entities.size);

    await page.getByRole('button', { name: /remove/i }).click();
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.__dense!.app.entities.size)).toBe(before - 1);
  });

  test('a cube flung off the slab is culled, and a held one never is', async ({ page }) => {
    await boot(page);

    const result = await page.evaluate(async () => {
      const app = window.__dense!.app;
      app.spawn();
      app.spawn();
      await new Promise((r) => setTimeout(r, 250));

      const [doomed, carried] = [...app.entities.all];
      const startCount = app.entities.size;

      // Straight to the far side of the kill plane, rather than waiting out a real
      // fall — the rule under test is the cull, not gravity.
      app.physics.setTransform(doomed!.body, { x: 4, y: -3, z: 0 }, true);
      // A cube in the player's hand is exempt: yanking it mid-drag reads as a bug.
      carried!.heldBy = 'hand';
      app.physics.setTransform(carried!.body, { x: -4, y: -3, z: 0 }, true);

      await new Promise((r) => setTimeout(r, 300));
      const ids = [...app.entities.all].map((e) => e.id);
      carried!.heldBy = null;
      return { startCount, ids, doomedId: doomed!.id, carriedId: carried!.id };
    });

    expect(result.ids).not.toContain(result.doomedId);
    expect(result.ids).toContain(result.carriedId);

    // And once released, the same cube is swept up on a later step.
    await page.waitForTimeout(300);
    const remaining = await page.evaluate(() =>
      [...window.__dense!.app.entities.all].map((e) => e.id),
    );
    expect(remaining).not.toContain(result.carriedId);
  });
});
