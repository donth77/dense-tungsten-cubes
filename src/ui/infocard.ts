import { astmClassLabel, cubeMassKg, densityOf, METALS } from '../data/metals.ts';
import { cubeSide, density, mass, percent, volume } from '../data/format.ts';
import { massComparison, matchTwin } from '../data/twins.ts';
import { button, el, setText } from './dom.ts';
import { icon } from './icons.ts';
import type { SettingsStore } from './settings.ts';
import type { CubeSpec } from '../types.ts';

/**
 * The info card (08 §8.8), built from spec cells — 13 §5.1's signature component, which
 * is also the exact shape of the SI-primary / imperial-subtitle rule (08 §2.3).
 *
 * Everything here is derived from the spec on demand (08 §5.7). Nothing is cached, so
 * dragging the purity slider updates the card for free.
 */
export class InfoCard {
  readonly root: HTMLElement;
  #spec: CubeSpec | null = null;

  readonly #title = el('span.metal-name');
  readonly #chip = el('span.class-chip');
  readonly #twin = el('div.twin');
  readonly #cells = new Map<string, { value: HTMLElement; sub: HTMLElement }>();

  constructor(
    private readonly settings: SettingsStore,
    onDelete: () => void,
  ) {
    const grid = el('div.cells');
    for (const key of ['Mass', 'Side', 'Density', 'Volume']) {
      const value = el('div.val');
      const sub = el('div.val2');
      this.#cells.set(key, { value, sub });
      grid.appendChild(el('div.cell', {}, el('div.k', { text: key }), value, sub));
    }

    /*
     * The readout is the live region — NOT the whole card.
     *
     * `role="status"` used to sit on the root, which was fine while the card was pure
     * text. It stops being fine the moment it contains a button: a live region
     * re-announces its subtree on change, so every drag of the purity slider would read
     * the Remove button out again, and interactive controls inside a status region are
     * announced with the wrong role by several screen readers.
     */
    const readout = el(
      'div.infocard-live',
      { role: 'status', 'aria-live': 'polite' },
      el('div.head', {}, this.#title, this.#chip),
      grid,
      this.#twin,
    );

    const del = button('Remove', onDelete, {
      class: 'cardbtn danger',
      // The shortcut is announced rather than only written in a tooltip, so it reaches
      // someone who never sees the label.
      'aria-keyshortcuts': 'Delete',
      title: 'Remove this cube  (Del)',
    });
    del.prepend(icon('trash', 15));

    this.root = el(
      'div.infocard',
      { role: 'group', 'aria-label': 'Selected cube' },
      readout,
      el('div.infocard-actions', {}, del),
    );
    this.root.style.display = 'none';
    this.settings.subscribe(() => this.#render());
  }

  show(spec: CubeSpec): void {
    this.#spec = spec;
    this.root.style.display = '';
    this.#render();
  }

  hide(): void {
    this.#spec = null;
    this.root.style.display = 'none';
  }

  get isVisible(): boolean {
    return this.#spec !== null;
  }

  #render(): void {
    const spec = this.#spec;
    if (!spec) return;
    const metal = METALS[spec.metal];
    const rho = densityOf(spec.metal, spec.purityPctW);
    const kg = cubeMassKg(spec.metal, spec.sideM, spec.purityPctW);
    const units = this.settings.units;

    setText(
      this.#title,
      spec.metal === 'W' && spec.purityPctW !== undefined
        ? `${metal.label} ${percent(spec.purityPctW)}`
        : metal.label,
    );
    // Only tungsten carries an ASTM grade; the others are elements, not alloys.
    this.#chip.style.display = spec.metal === 'W' ? '' : 'none';
    if (spec.metal === 'W') {
      setText(this.#chip, astmClassLabel(spec.purityPctW ?? 95));
    }

    const m = mass(kg, units);
    const side = cubeSide(spec.sideM);
    const rhoR = density(rho);
    const vol = volume(spec.sideM ** 3);
    this.#set('Mass', m.primary, m.secondary);
    this.#set('Side', side.primary, side.secondary);
    this.#set('Density', rhoR.primary, rhoR.secondary);
    this.#set('Volume', vol.primary, vol.secondary);

    // Two different claims, and the card keeps them visually distinct: a PRODUCT twin is
    // a factual statement held to 01's honesty rule, a mass comparison is explicitly
    // approximate (see data/twins.ts).
    const twin = matchTwin(spec.metal, spec.sideM);
    const compare = massComparison(kg);
    if (twin) {
      this.#twin.innerHTML = '';
      this.#twin.append(
        el('b', { text: twin.label }),
        twin.note ? ` — ${twin.note}` : '',
        compare ? el('div', { text: `Weighs ${compare}.` }) : '',
      );
    } else if (compare) {
      this.#twin.innerHTML = '';
      this.#twin.append(`Weighs ${compare}.`);
    } else {
      setText(this.#twin, '');
    }
  }

  #set(key: string, primary: string, secondary: string): void {
    const cell = this.#cells.get(key);
    if (!cell) return;
    setText(cell.value, primary);
    setText(cell.sub, secondary);
  }
}
