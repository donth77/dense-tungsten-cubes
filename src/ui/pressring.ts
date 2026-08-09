/**
 * The long-press fill ring (12 §4).
 *
 * 450 ms of nothing feels like a dead app. The ring is also how the gesture becomes
 * discoverable at all, and it makes an ACCIDENTAL long-press obvious before it fires —
 * which is the half nobody thinks of until a cube appears where they were orbiting.
 */

const R = 18;
const CIRC = 2 * Math.PI * R;

export class PressRing {
  readonly root: HTMLElement;
  readonly #fill: SVGCircleElement;

  constructor() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 44 44');
    svg.setAttribute('class', 'press-ring');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'none';

    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '22');
      c.setAttribute('cy', '22');
      c.setAttribute('r', String(R));
      c.setAttribute('class', cls);
      c.setAttribute('transform', 'rotate(-90 22 22)');
      return c;
    };
    const track = mk('track');
    this.#fill = mk('fill');
    this.#fill.setAttribute('stroke-dasharray', `0 ${CIRC}`);
    this.#fill.setAttribute('stroke-linecap', 'round');
    svg.append(track, this.#fill);
    this.root = svg as unknown as HTMLElement;
  }

  update(progress: number, screen: { x: number; y: number } | null): void {
    if (!screen || progress <= 0) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    this.root.style.transform = `translate(${screen.x - 22}px, ${screen.y - 22}px)`;
    this.#fill.setAttribute('stroke-dasharray', `${CIRC * Math.min(1, progress)} ${CIRC}`);
  }
}
