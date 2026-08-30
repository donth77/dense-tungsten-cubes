/**
 * "This row keeps going." (user, 2026-08-30)
 *
 * Several option rows scroll sideways on a phone rather than wrap — the size presets,
 * and every segmented row in a lab panel. That is the right call for a 195 px half of a
 * split band, but it was silent: the Drop Tower's TARGET row is 607 px of chips in a
 * 227 px window, so four of its seven targets — the glass pane, the soda can, the
 * watermelon, the pine board — were off the edge with nothing to say so. The scrollbar
 * is deliberately hidden (it is a thumb-scrolled row, and a bar there is noise), which
 * is exactly what removes the usual cue.
 *
 * So the row reports its own state and CSS marks whichever edge has more behind it:
 * `data-overflow` is `none`, `start`, `end` or `both`, and components.css draws a caret
 * over a short gradient there.
 *
 * The alternative — arrow BUTTONS — was not taken: they cost two 44 px targets out of a
 * 195 px row, which is most of the row they exist to reveal.
 */

/**
 * Sub-pixel slack. A row that fits exactly can still report a fraction of a pixel of
 * overflow from fractional widths, and a permanent caret on a row that cannot scroll is
 * a lie.
 */
const EPS = 2;

/** Overflow values that actually produce a scrollport. */
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);

/**
 * Watch a horizontally scrolling row and keep `data-overflow` current on it.
 *
 * @returns an unsubscribe — the caller owns it, and every row here is rebuilt often
 * enough (a panel structure change, an instrument swap) that leaking the listener and
 * the observer would matter.
 */
export function attachScrollHint(row: HTMLElement): () => void {
  const sync = (): void => {
    /*
     * Content wider than the box is not the same claim as a row you can scroll. The
     * same rows WRAP on a pointer device (a hidden scrollbar there is unreachable, not
     * merely undiscoverable — components.css says so at `.chips`), and one that simply
     * overflows visible would otherwise grow a caret pointing at content no gesture can
     * reach.
     */
    const max = SCROLLS.has(getComputedStyle(row).overflowX)
      ? row.scrollWidth - row.clientWidth
      : 0;
    const at = row.scrollLeft;
    const state = max <= EPS ? 'none' : at <= EPS ? 'end' : at >= max - EPS ? 'start' : 'both';
    // Only on change: this runs from a ResizeObserver, and writing an attribute that
    // is already set invalidates style for nothing.
    if (row.dataset['overflow'] !== state) row.dataset['overflow'] = state;
  };

  row.addEventListener('scroll', sync, { passive: true });
  /*
   * The row's own box covers rotation and the sheet resizing. Its CHILDREN cover the
   * other half: a chip whose label changes with the unit setting changes the content
   * width without touching the row's box, and a ResizeObserver on the row alone would
   * never hear about it. Observing also delivers once on attach, which is what gets the
   * first state in after layout — attach time is usually too early to measure.
   */
  const ro = new ResizeObserver(sync);
  ro.observe(row);
  for (const child of row.children) ro.observe(child);

  return () => {
    row.removeEventListener('scroll', sync);
    ro.disconnect();
  };
}
