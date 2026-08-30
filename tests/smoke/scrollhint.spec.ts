import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * A row that scrolls sideways has to say so (user, 2026-08-30).
 *
 * The Drop Tower's TARGET row is 607 px of chips in a 227 px phone half with its
 * scrollbar deliberately hidden, so four of its seven targets were off the edge and
 * undiscoverable. `ui/scrollhint.ts` reports the state and CSS draws a caret on the edge
 * that has more behind it.
 *
 * The measurements are the point of testing this in a real browser: the caret is a flex
 * item, so a careless version of it would ADD to the scroll width, and a row that only
 * just fits would then grow a marker announcing an overflow it caused itself, offering
 * 30 px of scrolling to nothing. That is checked by measuring each row with its carets
 * and without them, rather than against a fixed pixel width — how much of a 390 px phone
 * the panel half gets differs between a plain window and an emulated device, and the
 * invariant does not.
 */

const rowState = (page: Page, label: string) =>
  page.evaluate((l) => {
    const row = [...document.querySelectorAll<HTMLElement>('.lp-seg')].find(
      (r) => r.getAttribute('aria-label') === l,
    );
    if (!row) return null;
    return {
      overflow: row.dataset['overflow'] ?? null,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      caret: getComputedStyle(row, '::after').visibility,
    };
  }, label);

/** The split band, where these rows scroll instead of wrapping, is phone-portrait only. */
function phoneOnly(): void {
  test.skip(test.info().project.name !== 'phone-portrait', 'the split band is phone-portrait');
}

test.describe('horizontally scrolling option rows', () => {
  test('marks the row that overflows, and leaves the one that fits alone', async ({ page }) => {
    phoneOnly();
    await page.goto('/drop');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('.lp-seg').length >= 3);

    // Seven targets never fit a phone half, on any device metric.
    const target = (await rowState(page, 'TARGET'))!;
    expect(target.scrollWidth).toBeGreaterThan(target.clientWidth);
    expect(target.overflow).toBe('end');
    expect(target.caret).toBe('visible');

    // Every row: the caret shows exactly when there is something behind it, and never
    // because of itself.
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.lp-seg')].map((row) => {
        const saved = row.dataset['overflow'] ?? '';
        const withCaret = row.scrollWidth;
        // The rules are keyed off the attribute, so dropping it drops both pseudos.
        row.removeAttribute('data-overflow');
        const bare = row.scrollWidth;
        row.dataset['overflow'] = saved;
        return {
          label: row.getAttribute('aria-label') ?? '?',
          state: saved,
          scrolls: bare > row.clientWidth + 2,
          caret: getComputedStyle(row, '::after').visibility,
          withCaret,
          bare,
        };
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.withCaret, `${r.label} measures the same with the caret as without`).toBe(r.bare);
      expect(r.state === 'none', `${r.label} state matches its real overflow`).toBe(!r.scrolls);
      expect(r.caret, `${r.label} caret`).toBe(r.scrolls ? 'visible' : 'hidden');
    }
  });

  test('follows the row to the end and stops claiming there is more', async ({ page }) => {
    phoneOnly();
    await page.goto('/drop');
    await page.waitForFunction(() => !!window.__dense, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('.lp-seg').length >= 3);

    const scrollTo = (x: number): Promise<void> =>
      page.evaluate((sx) => {
        const row = [...document.querySelectorAll<HTMLElement>('.lp-seg')].find(
          (r) => r.getAttribute('aria-label') === 'TARGET',
        )!;
        row.scrollLeft = sx;
      }, x);

    const width = (await rowState(page, 'TARGET'))!.scrollWidth;

    await scrollTo(180);
    await page.waitForTimeout(120);
    expect((await rowState(page, 'TARGET'))!.overflow).toBe('both');

    await scrollTo(99999);
    await page.waitForTimeout(120);
    const atEnd = (await rowState(page, 'TARGET'))!;
    expect(atEnd.overflow).toBe('start');
    expect(atEnd.caret).toBe('hidden');
    // The marker never changes the thing it is measuring, or the state would oscillate.
    expect(atEnd.scrollWidth).toBe(width);
  });
});
