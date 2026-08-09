import { expect, test } from '@playwright/test';

/**
 * The purity slider retunes a selected cube IN PLACE (08 §9.2) — and the displayed
 * number and the simulated body must never disagree.
 *
 * This exists because it silently did not work. Rapier propagates a collider's mass
 * properties to its body "at the next physics step, or manually via
 * recomputeMassPropertiesFromColliders", so reading `body.mass()` straight after
 * `setDensity()` returned the OLD mass. The info card (which derives mass from the
 * spec) updated correctly while the simulation kept the previous mass — the number on
 * screen and the thing on screen disagreeing, which is pillar 2 (01) inverted.
 *
 * It is also the M2a exit moment, so a regression here breaks the milestone gate.
 */

test.describe('purity slider', () => {
  test('retunes the selected cube in place, and physics matches the readout', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async () => {
      const app = window.__dense!.app;
      const cube = [...app.entities.all][0]!;
      const idBefore = cube.id;
      app.bus.emit('select', { id: cube.id });
      await new Promise((r) => setTimeout(r, 80));

      const slider = document.querySelector('.dock input[type=range]') as HTMLInputElement;
      const readings: { purity: number; physicsKg: number; cardText: string | null }[] = [];
      for (const p of [97, 95, 90]) {
        slider.value = String(p);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        readings.push({
          purity: p,
          physicsKg: app.physics.massOf(cube.body),
          cardText: document.querySelector('.infocard .val')?.textContent ?? null,
        });
      }
      return { idBefore, idAfter: [...app.entities.all][0]!.id, readings };
    });

    // In place: the body was never despawned and respawned.
    expect(result.idAfter).toBe(result.idBefore);

    const [at97, at95, at90] = result.readings;
    // The physics mass actually moved, in the right direction, by the right ratio.
    expect(at97!.physicsKg).toBeGreaterThan(at95!.physicsKg);
    expect(at95!.physicsKg).toBeGreaterThan(at90!.physicsKg);
    expect(at90!.physicsKg / at95!.physicsKg).toBeCloseTo(17_000 / 18_000, 3);
    expect(at97!.physicsKg / at95!.physicsKg).toBeCloseTo(18_500 / 18_000, 3);

    // And the card agrees with the body to the precision it displays.
    for (const r of result.readings) {
      const shown = Number(/([\d.]+)/.exec(r.cardText ?? '')?.[1] ?? NaN);
      expect(shown, `card showed "${r.cardText}" at ${r.purity}%`).toBeCloseTo(r.physicsKg, 1);
    }
  });
});
