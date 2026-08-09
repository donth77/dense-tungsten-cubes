import { config } from '../config.ts';

/**
 * The layout system (12 §3). **One source of truth.**
 *
 * The class is computed once here and set on `#app`. CSS styles off it and the camera
 * *reads* it. Two independent breakpoint systems — one in CSS, one in JS deciding
 * gesture and camera behaviour — is exactly how a UI ends up in bottom-sheet mode while
 * the camera still thinks it is on desktop.
 */

export type LayoutClass = 'phone-portrait' | 'phone-landscape' | 'tablet' | 'desktop';

export const LAYOUT_CLASSES: readonly LayoutClass[] = [
  'phone-portrait',
  'phone-landscape',
  'tablet',
  'desktop',
];

/**
 * Pure, so the breakpoint logic is unit-testable without a browser.
 *
 * ORDER MATTERS. The short/landscape test comes first and keys on **height**, because a
 * phone in landscape is 844 px wide — comfortably past the 700 px "phone" width — while
 * being only 390 px tall. Check width first and a landscape phone resolves to `tablet`
 * and gets a bottom sheet covering most of the screen, which is the exact failure 12 §3
 * exists to prevent. It also correctly catches a short desktop window.
 */
export function computeLayout(widthPx: number, heightPx: number): LayoutClass {
  if (heightPx <= config.layout.shortMaxHeightPx) return 'phone-landscape';
  if (widthPx <= config.layout.phoneMaxWidthPx) return 'phone-portrait';
  if (widthPx <= config.layout.tabletMaxWidthPx) return 'tablet';
  return 'desktop';
}

/**
 * How far to shift framed content so a selected cube is never behind an open panel
 * (12 §3). Positive Y lifts content up (out from under a bottom sheet); positive X
 * shifts it left (out from under a right-hand rail).
 */
export function cameraOffsetFor(
  layout: LayoutClass,
  _widthPx: number,
  heightPx: number,
): { x: number; y: number } {
  switch (layout) {
    case 'phone-portrait':
      return { x: 0, y: heightPx * config.layout.cameraOffsetPortraitFrac };
    case 'phone-landscape':
      return { x: config.layout.cameraOffsetRailPx / 2, y: 0 };
    case 'tablet':
    case 'desktop':
    default:
      // Panels float over the edges rather than claiming a band, so the stage centre is
      // still the visual centre. Deliberately zero rather than a token nudge.
      return { x: 0, y: 0 };
  }
}

export interface LayoutState {
  layout: LayoutClass;
  widthPx: number;
  heightPx: number;
  offset: { x: number; y: number };
}

/**
 * Watches the viewport and applies the class. Listens to `visualViewport` as well as
 * `resize`, because on iOS the two disagree while the toolbar animates (12 §2).
 */
export class LayoutManager {
  #state: LayoutState;
  readonly #listeners = new Set<(s: LayoutState) => void>();

  constructor(private readonly root: HTMLElement) {
    this.#state = this.#measure();
    this.#apply();
    window.addEventListener('resize', this.#onResize);
    window.addEventListener('orientationchange', this.#onResize);
    window.visualViewport?.addEventListener('resize', this.#onResize);
  }

  get state(): Readonly<LayoutState> {
    return this.#state;
  }
  get layout(): LayoutClass {
    return this.#state.layout;
  }
  get isTouchLayout(): boolean {
    return this.#state.layout === 'phone-portrait' || this.#state.layout === 'phone-landscape';
  }

  subscribe(fn: (s: LayoutState) => void): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => this.#listeners.delete(fn);
  }

  #measure(): LayoutState {
    // visualViewport is the honest size while a mobile toolbar is mid-animation.
    const w = window.visualViewport?.width ?? window.innerWidth;
    const h = window.visualViewport?.height ?? window.innerHeight;
    const layout = computeLayout(w, h);
    return { layout, widthPx: w, heightPx: h, offset: cameraOffsetFor(layout, w, h) };
  }

  #apply(): void {
    for (const c of LAYOUT_CLASSES) this.root.classList.toggle(c, c === this.#state.layout);
  }

  readonly #onResize = (): void => {
    const next = this.#measure();
    const changed =
      next.layout !== this.#state.layout ||
      Math.abs(next.widthPx - this.#state.widthPx) > 1 ||
      Math.abs(next.heightPx - this.#state.heightPx) > 1;
    if (!changed) return;
    this.#state = next;
    this.#apply();
    for (const fn of [...this.#listeners]) fn(next);
  };

  dispose(): void {
    window.removeEventListener('resize', this.#onResize);
    window.removeEventListener('orientationchange', this.#onResize);
    window.visualViewport?.removeEventListener('resize', this.#onResize);
    this.#listeners.clear();
  }
}
