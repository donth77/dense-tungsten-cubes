import './components.css';
import { button, el, setText } from './dom.ts';
import { InfoCard } from './infocard.ts';
import { LayoutManager } from './layout.ts';
import { ForceMeter } from './meter.ts';
import { PressRing } from './pressring.ts';
import { Spawner } from './spawner.ts';
import type { SpawnerCallbacks } from './spawner.ts';
import type { SettingsStore } from './settings.ts';
import type { LayoutState } from './layout.ts';

/**
 * The HUD shell (08 §8.8): top bar, the dock, the info card, the meter, toasts.
 *
 * Owns *assembly and layout*, not behaviour — `app.ts` wires it to the simulation. It
 * imports nothing from `core/`, which is what keeps `ui/` testable as plain DOM (08 §5.2).
 */

export type HandModeId = 'one' | 'two' | 'forklift';

export interface HudCallbacks extends SpawnerCallbacks {
  onResetView(): void;
  onLabChange(lab: 'sandbox' | 'weigh'): void;
  onHandMode(mode: HandModeId): void;
}

export class Hud {
  readonly layout: LayoutManager;
  readonly spawner: Spawner;
  readonly infocard: InfoCard;
  readonly meter: ForceMeter;
  readonly pressRing: PressRing;

  readonly #toast: HTMLElement;
  #toastTimer: number | null = null;
  readonly #unitsBtn: HTMLElement;
  readonly #soundBtn: HTMLElement;
  readonly #handBtn: HTMLElement;
  readonly #engraveBtn: HTMLElement;
  #handMode: HandModeId = 'one';
  /** The forklift is an easter egg, not a feature — it stays hidden until found. */
  #forkliftUnlocked = false;
  /** Where labs mount their own panel (08 §9). */
  readonly labPanel: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly appEl: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly cb: HudCallbacks,
  ) {
    this.layout = new LayoutManager(this.appEl);
    this.spawner = new Spawner(settings, cb);
    this.infocard = new InfoCard(settings);
    this.meter = new ForceMeter();
    this.pressRing = new PressRing();
    this.labPanel = el('div.labpanel');

    this.#unitsBtn = button('KG', () => this.settings.toggleUnits(), {
      class: 'iconbtn',
      'aria-label': 'Toggle units',
      title: 'Units',
    });
    this.#soundBtn = button('♪', () => this.settings.toggleSound(), {
      class: 'iconbtn',
      'aria-label': 'Mute',
      title: 'Sound',
    });
    // Engraved / plain (03 §6). Engraved is the default — it is what the real cubes
    // look like, and it is what turns a size line-up into a periodic-table line-up.
    this.#engraveBtn = button('⊞', () => this.settings.toggleEngraving(), {
      class: 'iconbtn',
      'aria-label': 'Toggle engraved face',
      title: 'Engraved face',
    });

    /*
     * Hand mode. 08 §11 step 17 proposed long-pressing the meter to unlock the forklift,
     * but the meter is `pointer-events: none` and only exists while you are already
     * holding something — it cannot receive a press. This button carries the same idea:
     * tap cycles one/two hands, and a long press finds the 50 kN forklift.
     */
    this.#handBtn = button('1H', () => this.#cycleHand(), {
      class: 'iconbtn',
      'aria-label': 'Grip strength',
      title: 'Grip: one hand (350 N)',
    });
    this.#bindForkliftUnlock();

    const tabs = el(
      'div.tabs',
      { role: 'tablist' },
      el('button.tab', {
        type: 'button',
        role: 'tab',
        text: 'Sandbox',
        'aria-selected': 'true',
        onClick: () => this.cb.onLabChange('sandbox'),
      }),
    );

    this.#toast = el('div.toast', { role: 'status', 'aria-live': 'polite' });

    this.root.append(
      el(
        'div.topbar',
        {},
        el('span.wordmark', { text: 'Dense' }),
        tabs,
        el('div.spacer'),
        // A single reset-view control, not a camera panel: double-tap-to-reset is
        // undiscoverable and a stuck angle is the one camera failure with no visible
        // escape. Everything else stays direct manipulation.
        button('⟲', () => this.cb.onResetView(), {
          class: 'iconbtn',
          'aria-label': 'Reset view',
          title: 'Reset view',
        }),
        this.#engraveBtn,
        this.#handBtn,
        this.#unitsBtn,
        this.#soundBtn,
      ),
      this.spawner.root,
      this.infocard.root,
      this.meter.root,
      this.pressRing.root,
      this.labPanel,
      this.#toast,
    );

    this.settings.subscribe((s) => {
      setText(this.#unitsBtn, s.units === 'si' ? 'KG' : 'LB');
      setText(this.#soundBtn, s.sound ? '♪' : '✕');
      this.#soundBtn.setAttribute('aria-pressed', String(!s.sound));
      this.#soundBtn.setAttribute('aria-label', s.sound ? 'Mute' : 'Unmute');
      this.#engraveBtn.setAttribute('aria-pressed', String(s.engraving));
      this.#engraveBtn.setAttribute('title', s.engraving ? 'Engraved face' : 'Plain face');
      this.#engraveBtn.classList.toggle('active', s.engraving);
    });

    // Keep the info card clear of the sheet in portrait: the sheet's height is content-
    // driven, so it is measured rather than assumed.
    this.layout.subscribe(() => this.#syncSheetMetrics());
    requestAnimationFrame(() => this.#syncSheetMetrics());
  }

  #cycleHand(): void {
    const order: HandModeId[] = this.#forkliftUnlocked
      ? ['one', 'two', 'forklift']
      : ['one', 'two'];
    const next = order[(order.indexOf(this.#handMode) + 1) % order.length] ?? 'one';
    this.setHandMode(next);
    this.cb.onHandMode(next);
  }

  setHandMode(mode: HandModeId): void {
    this.#handMode = mode;
    const label = mode === 'one' ? '1H' : mode === 'two' ? '2H' : 'FL';
    const title =
      mode === 'one'
        ? 'Grip: one hand (350 N)'
        : mode === 'two'
          ? 'Grip: two hands (700 N)'
          : 'Grip: forklift (50 kN)';
    setText(this.#handBtn, label);
    this.#handBtn.setAttribute('title', title);
    this.#handBtn.classList.toggle('forklift', mode === 'forklift');
  }

  #bindForkliftUnlock(): void {
    let timer: number | null = null;
    const start = (): void => {
      timer = window.setTimeout(() => {
        timer = null;
        if (this.#forkliftUnlocked) return;
        this.#forkliftUnlocked = true;
        this.setHandMode('forklift');
        this.cb.onHandMode('forklift');
        this.toast('Forklift unlocked — 50 kN. Nothing is heavy now.');
      }, 700);
    };
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    this.#handBtn.addEventListener('pointerdown', start);
    this.#handBtn.addEventListener('pointerup', stop);
    this.#handBtn.addEventListener('pointercancel', stop);
    this.#handBtn.addEventListener('pointerleave', stop);
  }

  get layoutState(): Readonly<LayoutState> {
    return this.layout.state;
  }

  #syncSheetMetrics(): void {
    const h = this.spawner.root.offsetHeight;
    this.appEl.style.setProperty('--dock-height', `${h}px`);
    this.appEl.style.setProperty('--infocard-bottom', `${h + 12}px`);
  }

  /**
   * Renders the controls a lab asked for. Labs describe, the HUD builds — see LabUi.
   */
  setLabControls(
    groupLabel: string,
    controls: readonly { label: string; onSelect(): void }[],
  ): void {
    this.labPanel.replaceChildren();
    if (controls.length === 0) return;
    this.labPanel.append(
      el(
        'div.labpanel-inner',
        {},
        el('div.k', { text: groupLabel }),
        el(
          'div.lineup-buttons',
          {},
          ...controls.map((c) => button(c.label, c.onSelect, { class: 'chip' })),
        ),
      ),
    );
  }

  clearLabControls(): void {
    this.labPanel.replaceChildren();
  }

  toast(message: string, ms = 2500): void {
    setText(this.#toast, message);
    this.#toast.classList.add('on');
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => this.#toast.classList.remove('on'), ms);
  }

  dispose(): void {
    this.layout.dispose();
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
  }
}
