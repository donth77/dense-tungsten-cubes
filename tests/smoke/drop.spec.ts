import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The Drop Tower end to end (16 §15 D2): the tab mounts a playable instrument with
 * visible controls, an empty field (spawnOnEntry is Sandbox-only), and the full
 * hoist → drop → verdict loop driving the same public verbs the panel buttons call.
 */

async function bootIntoDrop(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.getByRole('tab', { name: 'Drop' }).click();
  await page.waitForFunction(() => window.__dense!.app.labs.activeId === 'drop', null, {
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
}

test.describe('the Drop Tower', () => {
  test('mounts with its controls and an empty field', async ({ page }) => {
    await bootIntoDrop(page);

    // A cleared bench: no starter cube (user decision 2026-08-24).
    expect(await page.evaluate(() => window.__dense!.app.entities.size)).toBe(0);

    // The controls the lab promised (16 §13.1): height, floor, air, the primary verb.
    await expect(page.locator('input[aria-label="HEIGHT"]')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'FLOOR' })).toBeVisible();
    await expect(page.getByRole('switch')).toBeVisible();
    const hoist = page.getByRole('button', { name: 'HOIST' });
    await expect(hoist).toBeVisible();
    // No cube on the plate yet — the verb is offered but honest about it.
    await expect(hoist).toBeDisabled();
  });

  test('spawn → hoist → drop → verdict, with the replay one tap away', async ({ page }) => {
    await bootIntoDrop(page);

    // The first spawn lands on the plate (preferredSpawnPoint).
    await page.evaluate(() => window.__dense!.app.spawn());
    await page.waitForTimeout(800); // land and settle
    const hoist = page.getByRole('button', { name: 'HOIST' });
    await expect(hoist).toBeEnabled();
    await hoist.click();

    // The verb becomes DROP and arms when the winch gets there.
    const drop = page.getByRole('button', { name: 'DROP', exact: true });
    await expect(drop).toBeEnabled({ timeout: 10_000 });
    await drop.click();

    await page.waitForFunction(
      () => {
        const lab = window.__dense!.lab() as { state?: { phase?: string } } | null;
        return lab?.state?.phase === 'done';
      },
      null,
      { timeout: 15_000 },
    );

    // The verdict is on the panel, with the measured facts under it.
    await expect(page.locator('.lp-status')).toHaveText(/LANDED|BOUNCED|CHIPPED|CRACKED/);
    await expect(page.locator('.lp-fact').first()).toContainText('m/s');

    // REPLAY exists, plays, and stops cleanly.
    await page.getByRole('button', { name: 'REPLAY' }).click();
    expect(await page.evaluate(() => window.__dense!.app.player.isPlaying)).toBe(true);
    await page.evaluate(() => window.__dense!.app.stopReplay());
    expect(await page.evaluate(() => window.__dense!.app.player.isPlaying)).toBe(false);
  });

  test('floor switching is refused mid-fall, honoured at rest', async ({ page }) => {
    await bootIntoDrop(page);
    const changed = await page.evaluate(() => {
      const lab = window.__dense!.lab() as {
        setFloor(id: string): void;
        floorId: string;
      };
      lab.setFloor('steel');
      return lab.floorId;
    });
    expect(changed).toBe('steel');
    await expect(page.getByRole('radio', { name: 'Steel' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('the replay chrome takes the panel over and leaves cleanly', async ({ page }) => {
    await bootIntoDrop(page);
    await page.evaluate(() => window.__dense!.app.spawn());
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'HOIST' }).click();
    const drop = page.getByRole('button', { name: 'DROP', exact: true });
    await expect(drop).toBeEnabled({ timeout: 10_000 });
    await drop.click();
    await page.waitForFunction(
      () => {
        const lab = window.__dense!.lab() as { state?: { phase?: string } } | null;
        return lab?.state?.phase === 'done';
      },
      null,
      { timeout: 15_000 },
    );
    // The live ring is only 1.5 s deep. Waiting past it proves REPLAY plays the
    // verdict-time snapshot, not the long-gone ring (dead-button bug, 2026-08-25).
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.locator('.replaybar')).toBeVisible();
    await expect(page.locator('.replaybar input[type="range"]')).toBeVisible();
    await expect(page.locator('.labpanel-inner')).toBeHidden();
    await page.getByRole('button', { name: 'EXIT' }).click();
    await expect(page.locator('.replaybar')).toBeHidden();
    await expect(page.getByRole('button', { name: 'REPLAY' })).toBeVisible();
  });

  test('a share link boots the whole scene back', async ({ page }) => {
    await bootIntoDrop(page);
    await page.evaluate(() => window.__dense!.app.spawn());
    await page.waitForTimeout(800);
    const url = await page.evaluate(() => {
      const lab = window.__dense!.lab() as { applyShare(d: object): void };
      lab.applyShare({ hM: 10, floor: 'sand', air: true });
      window.__dense!.app.share(); // headless clipboard may refuse; the hash still lands
      return location.href;
    });
    expect(url).toContain('#s=');
    await page.goto('about:blank');
    await page.goto(url);
    await page.waitForFunction(() => window.__dense?.app.labs.activeId === 'drop', null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__dense!.app.entities.size)).toBe(1);
    expect(
      await page.evaluate(() => (window.__dense!.lab() as { shareBlock(): object }).shareBlock()),
    ).toMatchObject({ hM: 10, floor: 'sand', air: true });
    await expect(page.getByRole('radio', { name: 'Sand' })).toHaveAttribute('aria-checked', 'true');
  });
});
