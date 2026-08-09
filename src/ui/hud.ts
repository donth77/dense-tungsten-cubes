import './components.css';
import { button, clear, el, setText } from './dom.ts';
import { InfoCard } from './infocard.ts';
import { LayoutManager } from './layout.ts';
import { ForceMeter } from './meter.ts';
import { HelpPanel } from './help.ts';
import { icon } from './icons.ts';
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
  readonly help: HelpPanel;

  readonly #toast: HTMLElement;
  #toastTimer: number | null = null;
  readonly #unitsBtn: HTMLElement;
  readonly #soundBtn: HTMLElement;
  readonly #handBtn: HTMLElement;
  readonly #engraveBtn: HTMLElement;
  readonly #helpBtn: HTMLElement;
  readonly #viewBtn: HTMLElement;
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
      class: 'iconbtn text',
      'aria-label': 'Toggle units',
      title: 'Units: kilograms  (U)',
    });
    // Icons, with the descriptive label as the hover tooltip. State-bearing readouts
    // (grip, units) stay as short text — an icon cannot show "1H" vs "2H" vs "FL", and
    // their whole job is to display a value.
    this.#soundBtn = button('', () => this.settings.toggleSound(), {
      class: 'iconbtn toggle',
      'aria-label': 'Mute',
      title: 'Sound',
    });
    // Engraved / plain (03 §6). Engraved is the default — it is what the real cubes
    // look like, and it is what turns a size line-up into a periodic-table line-up.
    this.#engraveBtn = button('', () => this.settings.toggleEngraving(), {
      class: 'iconbtn toggle',
      'aria-label': 'Engraved face',
      title: 'Engraved face',
    });
    this.#engraveBtn.appendChild(icon('engrave'));

    this.#helpBtn = button('', () => this.help.toggle(), {
      class: 'iconbtn',
      'aria-label': 'Controls and shortcuts',
      title: 'Controls  (?)',
      'aria-haspopup': 'dialog',
    });
    this.#helpBtn.appendChild(icon('help'));

    this.#viewBtn = button('', () => this.cb.onResetView(), {
      class: 'iconbtn',
      'aria-label': 'Reset the camera',
      title: 'Reset view  (F)',
    });
    this.#viewBtn.appendChild(icon('recenter'));

    /*
     * Hand mode. 08 §11 step 17 proposed long-pressing the meter to unlock the forklift,
     * but the meter is `pointer-events: none` and only exists while you are already
     * holding something — it cannot receive a press. This button carries the same idea:
     * tap cycles one/two hands, and a long press finds the 50 kN forklift.
     */
    this.#handBtn = button('350 N', () => this.#cycleHand(), {
      class: 'iconbtn text',
      'aria-label': 'Grip strength',
      title: 'Grip: one hand — 350 N  (G)',
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
    this.help = new HelpPanel(() => this.#helpBtn.focus());

    this.root.append(
      el(
        'div.topbar',
        {},
        el('h1.wordmark', { text: 'Dense' }),
        tabs,
        el('div.spacer'),
        // A reset-view control and a help sheet, not a camera panel: everything else
        // stays direct manipulation.
        this.#viewBtn,
        this.#engraveBtn,
        this.#handBtn,
        this.#unitsBtn,
        this.#soundBtn,
        this.#helpBtn,
      ),
      this.spawner.root,
      this.infocard.root,
      this.meter.root,
      this.pressRing.root,
      this.labPanel,
      this.#toast,
      this.help.root,
    );

    this.settings.subscribe((s) => {
      setText(this.#unitsBtn, s.units === 'si' ? 'KG' : 'LB');
      this.#unitsBtn.setAttribute(
        'title',
        s.units === 'si' ? 'Units: kilograms  (U)' : 'Units: pounds  (U)',
      );
      clear(this.#soundBtn);
      this.#soundBtn.appendChild(icon(s.sound ? 'sound' : 'muted'));
      this.#soundBtn.setAttribute('aria-pressed', String(s.sound));
      this.#soundBtn.setAttribute('aria-label', s.sound ? 'Mute' : 'Unmute');
      clear(this.#engraveBtn);
      this.#engraveBtn.appendChild(icon(s.engraving ? 'engrave' : 'engraveOff'));
      this.#engraveBtn.setAttribute('aria-pressed', String(s.engraving));
      this.#engraveBtn.setAttribute(
        'title',
        s.engraving ? 'Engraved face — on  (E)' : 'Engraved face — off  (E)',
      );
    });

    // Keep the info card clear of the sheet in portrait: the sheet's height is content-
    // driven, so it is measured rather than assumed.
    this.layout.subscribe(() => this.#syncSheetMetrics());
    requestAnimationFrame(() => this.#syncSheetMetrics());
  }

  cycleHandMode(): void {
    this.#cycleHand();
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
    /*
     * The label is the FORCE, not a hand count.
     *
     * It shipped as "1H / 2H / FL" and the first person to see it asked what it meant —
     * which is the whole answer. The force cap is self-explanatory next to a force
     * meter that reads in newtons, it is the number 01's Hand table is written in, and
     * it teaches the mechanic instead of encoding it.
     */
    const label = mode === 'one' ? '350 N' : mode === 'two' ? '700 N' : '50 kN';
    const title =
      mode === 'one'
        ? 'Grip: one hand — 350 N'
        : mode === 'two'
          ? 'Grip: two hands — 700 N'
          : 'Grip: forklift — 50 kN';
    setText(this.#handBtn, label);
    this.#handBtn.setAttribute('title', `${title}  (G)`);
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
          ...controls.map((c) => button(c.label, c.onSelect, { class: 'chip action' })),
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
