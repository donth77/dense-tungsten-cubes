import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The Hand's force cap — the signature mechanic (01), and the one behaviour the whole
 * product rests on: "a 6-inch tungsten cube cannot be lifted one-handed *at all*."
 *
 * This exists because it was silently broken once and looked fine. Rapier's `addForce`
 * is persistent, not per-step, so a "350 N" clamp re-applied every step accumulated
 * (350, 700, 1050 …) and by step two exceeded the cube's 625 N weight. The meter still
 * read a saturated clamp the whole time — the toy looked correct while doing the exact
 * opposite of the thing it exists to demonstrate. Any regression here is fatal to the
 * design, so it gets a test even though it needs wasm and can't be a unit test.
 */

const IN = 0.0254;

/** Grab a freshly spawned cube by its top face and ask the Hand to lift it 300 mm. */
async function tryLift(
  page: Page,
  metal: 'W' | 'Al',
  sizeIn: number,
): Promise<{ massKg: number; weightN: number; appliedN: number; meter: number; risenMm: number }> {
  return page.evaluate(
    async ([metalId, size, inch]) => {
      const app = window.__dense!.app;
      const V3 = app.render.camera.position.constructor as new (
        x: number,
        y: number,
        z: number,
      ) => { x: number; y: number; z: number };
      app.hand.release();
      app.entities.clear();
      app.spec = { metal: metalId as 'W' | 'Al', sideM: (size as number) * (inch as number) };
      const side = (size as number) * (inch as number);
      const e = app.entities.spawn({ ...app.spec }, { x: 0, y: side / 2, z: 0 });
      await new Promise((r) => setTimeout(r, 500));
      const startY = e.curr.p.y;
      app.hand.grab(e.id, new V3(0, startY + side / 2, 0) as never, app.render.camera);
      // Fake ray: resolve the drag plane straight to a point 300 mm above the start.
      app.hand.aim({
        intersectPlane: (
          _plane: unknown,
          t: { set: (x: number, y: number, z: number) => unknown },
        ) => t.set(0, startY + 0.3, 0),
      } as never);
      await new Promise((r) => setTimeout(r, 2000));
      const risenMm = (e.curr.p.y - startY) * 1000;
      const out = {
        massKg: e.massKg,
        // The one authoritative g, not a fourth copy of it (14 PHY-14).
        weightN: e.massKg * app.physics.gravityMps2,
        appliedN: app.hand.appliedN,
        meter: app.hand.meter,
        risenMm,
      };
      app.hand.release();
      return out;
    },
    [metal, sizeIn, IN] as const,
  );
}

test.describe('The Hand — force cap', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
  });

  test('a 4" tungsten cube lifts, and the meter shows the effort', async ({ page }) => {
    const r = await tryLift(page, 'W', 4);
    expect(r.massKg).toBeCloseTo(18.88, 1);
    expect(r.weightN).toBeCloseTo(185, 0);
    expect(r.risenMm).toBeGreaterThan(100);
    // At equilibrium the PD demand equals the cube's weight — that is what makes the
    // meter honest rather than decorative.
    expect(r.appliedN).toBeCloseTo(185, -1);
    expect(r.meter).toBeGreaterThan(0.4);
    expect(r.meter).toBeLessThan(0.7);
  });

  test('a 4" aluminum cube snaps up with the meter barely moving', async ({ page }) => {
    const r = await tryLift(page, 'Al', 4);
    expect(r.massKg).toBeCloseTo(2.83, 1);
    expect(r.risenMm).toBeGreaterThan(100);
    expect(r.meter).toBeLessThan(0.15);
  });

  test('a 6" tungsten cube CANNOT be lifted one-handed (01)', async ({ page }) => {
    const r = await tryLift(page, 'W', 6);
    expect(r.massKg).toBeCloseTo(63.71, 1);
    expect(r.weightN).toBeCloseTo(625, 0);
    // The clamp holds at exactly one hand's worth...
    expect(r.appliedN).toBeCloseTo(350, 0);
    expect(r.meter).toBe(1);
    // ...and 350 N against 625 N of weight moves it nowhere.
    expect(r.risenMm).toBeLessThan(5);
  });
});
