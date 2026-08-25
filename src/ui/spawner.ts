import { astmClassLabel, METALS, WHA_PURITY_DEFAULT, whaDensity } from '../data/metals.ts';
import { bindSlider } from './slider.ts';
import { cubeSide, density, M_PER_IN, mass, percent } from '../data/format.ts';
import { cubeMassKg } from '../data/metals.ts';
import { button, el, setText } from './dom.ts';
import type { SettingsStore } from './settings.ts';
import type { CubeSpec, MetalId } from '../types.ts';

/**
 * The spawner (08 §8.8, 13 §5.4 / §8). Metal, purity, size — and the one primary action.
 *
 * Layout is not this component's business: it renders one DOM tree and `.dock`'s CSS
 * places it as a left panel, a bottom sheet or a right rail off the layout class.
 * Same DOM in every layout, class swap only (12 §3).
 */

/** 08 §8.8's preset ladder. On phone-portrait these become slider ticks (13 §8). */
const SIZE_PRESETS_IN = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;
const ASTM_TICKS = [90, 92.5, 95, 97] as const;

const SIZE_MIN_IN = 0.25;
const SIZE_MAX_IN = 15;

export interface SpawnerCallbacks {
  onSpawn(): void;
  /** Fires on every change, including live drags — the purity slider retunes a
   *  selected cube in place (08 §9.2). */
  onSpecChange(spec: CubeSpec): void;
}

export class Spawner {
  readonly root: HTMLElement;
  #metal: MetalId = 'W';
  #purity = WHA_PURITY_DEFAULT;
  #sizeIn = 2;

  readonly #metalButtons = new Map<MetalId, HTMLElement>();
  readonly #chipButtons = new Map<number, HTMLElement>();
  readonly #purityField: HTMLElement;
  #purityInput!: HTMLInputElement;
  #sizeInput!: HTMLInputElement;
  #purityValue!: HTMLElement;
  #purityBubble!: HTMLElement;
  #sizeValue!: HTMLElement;
  #sizeBubble!: HTMLElement;
  #classChip!: HTMLElement;
  #massLine!: HTMLElement;

  constructor(
    private readonly settings: SettingsStore,
    private readonly cb: SpawnerCallbacks,
  ) {
    this.#purityField = this.#buildPurity();
    this.root = el(
      'div.dock',
      { role: 'group', 'aria-label': 'Cube spawner' },
      el('div.handle'),
      this.#buildMetals(),
      this.#purityField,
      this.#buildSize(),
      this.#buildChips(),
      button('SPAWN', () => this.cb.onSpawn(), { class: 'primary' }),
      (this.#massLine = el('div.label-row', {}, el('span.k', { text: 'Mass' }), el('span.v'))),
    );

    // Units toggle has to reach every label that carries one.
    this.settings.subscribe(() => this.#refresh());
    this.#refresh();
  }

  get spec(): CubeSpec {
    const s: CubeSpec = { metal: this.#metal, sideM: this.#sizeIn * M_PER_IN };
    return this.#metal === 'W' ? { ...s, purityPctW: this.#purity } : s;
  }

  // ---- construction ---------------------------------------------------------------

  #buildMetals(): HTMLElement {
    const row = el('div.metals', { role: 'group', 'aria-label': 'Metal' });
    // Au sits second, right beside W: the two are 0.4 % apart in density and the whole
    // point is that you compare them. Separating them across the row hides the joke.
    for (const id of ['W', 'Au', 'Cu', 'Fe', 'Ti', 'Al'] as MetalId[]) {
      const spec = METALS[id];
      const [r, g, b] = spec.baseColorLinear;
      // The swatch shows TRUE material colour, so it must match what renders in the
      // scene — linear values converted the same way the material does.
      const rgb = [lin2srgb(r), lin2srgb(g), lin2srgb(b)] as const;
      const css = `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
      // The symbol sits ON the material colour, so its ink has to come FROM that colour.
      // Fixed light ink measured 1.32:1 on aluminium and 1.67:1 on copper — the audit
      // caught two swatches whose labels were effectively invisible.
      const onSwatch = readableInk(rgb);
      const btn = el(
        'button.metal',
        {
          type: 'button',
          style: `--swatch:${css}; --on-swatch:${onSwatch}`,
          'aria-pressed': String(id === this.#metal),
          'aria-label': spec.label,
          title: spec.label,
          onClick: () => this.#setMetal(id),
        },
        el('span', { text: spec.symbol }),
      );
      this.#metalButtons.set(id, btn);
      row.appendChild(btn);
    }
    return row;
  }

  #buildPurity(): HTMLElement {
    this.#purityValue = el('span.v');
    this.#classChip = el('span.class-chip');
    this.#purityBubble = el('div.bubble');
    this.#purityInput = el('input', {
      type: 'range',
      min: '90',
      max: '97',
      step: '0.5',
      value: String(this.#purity),
      'aria-label': 'Tungsten content',
    }) as HTMLInputElement;

    const ticks = el('div.ticks');
    for (const t of ASTM_TICKS) {
      ticks.appendChild(el('i', { style: `left:${((t - 90) / 7) * 100}%` }));
    }

    const slider = el('div.slider', {}, this.#purityInput, ticks, this.#purityBubble);
    bindSlider(this.#purityInput, slider, this.#purityBubble, (raw, committed) => {
      this.#purity = committed ? snapToTicks(raw, ASTM_TICKS, 0.6) : raw;
      if (committed) this.#purityInput.value = String(this.#purity);
      this.#refresh();
      this.cb.onSpecChange(this.spec);
    });

    return el(
      'div.field',
      {},
      el(
        'div.label-row',
        {},
        el('span.k', { text: 'Purity' }),
        el('span', {}, this.#classChip, ' ', this.#purityValue),
      ),
      slider,
    );
  }

  #buildSize(): HTMLElement {
    this.#sizeValue = el('span.v');
    this.#sizeBubble = el('div.bubble');
    // Logarithmic: 0.25–15" spans 60:1, and a linear slider spends three quarters of its
    // travel above 4" where nobody needs resolution.
    this.#sizeInput = el('input', {
      type: 'range',
      min: '0',
      max: '1000',
      step: '1',
      value: String(sizeToSlider(this.#sizeIn)),
      'aria-label': 'Cube size',
    }) as HTMLInputElement;

    const ticks = el('div.ticks');
    for (const p of SIZE_PRESETS_IN) {
      ticks.appendChild(el('i', { style: `left:${(sizeToSlider(p) / 1000) * 100}%` }));
    }

    const slider = el('div.slider', {}, this.#sizeInput, ticks, this.#sizeBubble);
    bindSlider(this.#sizeInput, slider, this.#sizeBubble, (raw, committed) => {
      const inches = sliderToSize(raw);
      // On phone the presets ARE the ticks, so snapping is how you hit exactly 2".
      this.#sizeIn = committed ? snapToTicks(inches, SIZE_PRESETS_IN, 0.06, true) : inches;
      if (committed) this.#sizeInput.value = String(sizeToSlider(this.#sizeIn));
      this.#refresh();
      this.cb.onSpecChange(this.spec);
    });

    return el(
      'div.field',
      {},
      el('div.label-row', {}, el('span.k', { text: 'Size' }), this.#sizeValue),
      slider,
    );
  }

  #buildChips(): HTMLElement {
    const row = el('div.chips', { role: 'group', 'aria-label': 'Size presets' });
    for (const p of SIZE_PRESETS_IN) {
      const btn = el('button.chip', {
        type: 'button',
        text: `${p}″`,
        'aria-pressed': String(Math.abs(p - this.#sizeIn) < 0.001),
        onClick: () => this.#setSize(p),
      });
      this.#chipButtons.set(p, btn);
      row.appendChild(btn);
    }
    return row;
  }

  // ---- state ----------------------------------------------------------------------

  /** Keyboard 1–5 picks a metal (bindings.ts). */
  setMetal(id: MetalId): void {
    this.#setMetal(id);
  }

  #setMetal(id: MetalId): void {
    this.#metal = id;
    this.#refresh();
    this.cb.onSpecChange(this.spec);
  }

  #setSize(inches: number): void {
    this.#sizeIn = inches;
    this.#sizeInput.value = String(sizeToSlider(inches));
    this.#refresh();
    this.cb.onSpecChange(this.spec);
  }

  #refresh(): void {
    for (const [id, btn] of this.#metalButtons) {
      btn.setAttribute('aria-pressed', String(id === this.#metal));
    }
    for (const [p, btn] of this.#chipButtons) {
      btn.setAttribute('aria-pressed', String(Math.abs(p - this.#sizeIn) < 0.001));
    }

    // Purity only exists for tungsten — the other four are elements, not alloys.
    this.#purityField.style.display = this.#metal === 'W' ? '' : 'none';

    const rho =
      this.#metal === 'W' ? whaDensity(this.#purity) : (METALS[this.#metal].densityKgM3 ?? 0);
    setText(this.#purityValue, percent(this.#purity));
    this.#purityInput.setAttribute(
      'aria-valuetext',
      `${percent(this.#purity)} tungsten, ${astmClassLabel(this.#purity)}`,
    );
    // 08 §16.7: a free slider position gets the bracketing classes, not a rounded lie.
    setText(this.#classChip, `${astmClassLabel(this.#purity)} · ρ ${density(rho).primary}`);
    setText(this.#purityBubble, percent(this.#purity));

    const side = cubeSide(this.#sizeIn * M_PER_IN);
    setText(this.#sizeValue, `${side.primary}  ${side.secondary}`);
    setText(this.#sizeBubble, side.primary);
    // Without this a screen reader announces the RAW slider position — and the size
    // slider is log-scaled 0–1000, so it would read "537" for a 2-inch cube.
    this.#sizeInput.setAttribute('aria-valuetext', `${side.primary}, ${side.secondary}`);

    const kg = cubeMassKg(this.#metal, this.#sizeIn * M_PER_IN, this.#purity);
    const m = mass(kg, this.settings.units);
    const value = this.#massLine.querySelector('.v');
    if (value instanceof HTMLElement) setText(value, `${m.primary}  ${m.secondary}`);
  }
}

// ---- helpers ----------------------------------------------------------------------

/**
 * Linear-sRGB (what the material uses) -> 0-255 sRGB for a CSS swatch.
 *
 * `SWATCH_EXPOSURE` matters: raw albedo is what the *material* is, not what the cube
 * *looks like*. Tungsten's 0.504 linear converts to a light grey, so an un-exposed
 * swatch shows W and Al as near-twins while the scene renders W distinctly dark — the
 * picker would be contradicting the thing it is picking. Scaling by roughly the stage's
 * effective exposure keeps the swatch row reading like the line-up it produces.
 */
const SWATCH_EXPOSURE = 0.62;

/** Black or white, whichever actually contrasts with the swatch behind it. */
function readableInk(rgb: readonly [number, number, number]): string {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  // Contrast against white vs against near-black; take whichever wins.
  const vsWhite = 1.05 / (L + 0.05);
  const vsBlack = (L + 0.05) / 0.05;
  return vsBlack > vsWhite ? '#101418' : '#f2f6f9';
}

function lin2srgb(c: number): number {
  const e = c * SWATCH_EXPOSURE;
  const v = e <= 0.0031308 ? e * 12.92 : 1.055 * Math.pow(e, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

const LOG_MIN = Math.log(SIZE_MIN_IN);
const LOG_MAX = Math.log(SIZE_MAX_IN);
export function sliderToSize(raw: number): number {
  return Math.exp(LOG_MIN + (raw / 1000) * (LOG_MAX - LOG_MIN));
}
export function sizeToSlider(inches: number): number {
  const clamped = Math.min(SIZE_MAX_IN, Math.max(SIZE_MIN_IN, inches));
  return Math.round(((Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000);
}

/**
 * Snap to a tick if within tolerance. `relative` compares proportionally, which is what
 * a log-scaled size slider needs — 0.06" is a big miss at 0.5" and nothing at 8".
 */
export function snapToTicks(
  value: number,
  ticks: readonly number[],
  tolerance: number,
  relative = false,
): number {
  let best = value;
  let bestErr = Infinity;
  for (const t of ticks) {
    const err = relative ? Math.abs(value / t - 1) : Math.abs(value - t);
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return bestErr <= tolerance ? best : value;
}
