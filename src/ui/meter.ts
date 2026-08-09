/**
 * The force meter (13 §5.3).
 *
 * The Hand's force cap is the product's central mechanic (01) and this is its only
 * visible channel — it is the reason a 6" tungsten cube refusing to move reads as
 * "too heavy" rather than "broken".
 *
 * Two rules it must not break:
 *   - The fill NEVER animates. It is an instrument reading a real clamped force; easing
 *     it would make it lie. Only the colour transitions.
 *   - On touch it sits ABOVE-LEFT of the contact point, never under the hand (12 §4).
 */

const R = 24;
const CIRC = 2 * Math.PI * R;
/** 240° of sweep, leaving a gap at the bottom so the ends read as an instrument. */
const SWEEP = 240 / 360;

export class ForceMeter {
  readonly root: HTMLElement;
  readonly #fill: SVGCircleElement;
  #visible = false;

  constructor() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 56 56');
    svg.setAttribute('class', 'meter');
    svg.setAttribute('aria-hidden', 'true');

    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '28');
      c.setAttribute('cy', '28');
      c.setAttribute('r', String(R));
      c.setAttribute('class', cls);
      // Rotate so the gap sits at the bottom.
      c.setAttribute('transform', 'rotate(138 28 28)');
      c.setAttribute('stroke-dasharray', `${CIRC * SWEEP} ${CIRC}`);
      return c;
    };

    const track = mk('track');
    this.#fill = mk('fill');
    this.#fill.setAttribute('stroke-dasharray', `0 ${CIRC}`);
    svg.append(track, this.#fill);

    this.root = svg as unknown as HTMLElement;
  }

  /**
   * @param meter 0..1, where 1 means the clamp is saturated
   * @param screen where the grab point is, in CSS px
   * @param touch true on a coarse pointer — shifts the meter clear of the hand
   */
  update(meter: number, screen: { x: number; y: number } | null, touch: boolean): void {
    if (!screen) {
      this.hide();
      return;
    }
    if (!this.#visible) {
      this.#visible = true;
      this.root.classList.add('on');
    }

    const clamped = Math.max(0, Math.min(1, meter));
    this.#fill.setAttribute('stroke-dasharray', `${CIRC * SWEEP * clamped} ${CIRC}`);
    // The tell that matters: amber approaching the cap, accent AT it (13 §2.1, §5.3).
    this.root.classList.toggle('warn', clamped >= 0.9 && clamped < 0.999);
    this.root.classList.toggle('clamped', clamped >= 0.999);

    // Desktop trails the cursor; touch goes up and left so a thumb never covers it.
    const dx = touch ? -64 : 32;
    const dy = touch ? -76 : -32;
    this.root.style.transform = `translate(${screen.x + dx}px, ${screen.y + dy}px)`;
  }

  hide(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.root.classList.remove('on', 'warn', 'clamped');
  }
}
