import './components.css';
import { LabPanel } from './labpanel.ts';
import type { LabPanelHandle, LabPanelModel } from '../labs/lab.ts';
import type { LabId } from '../labs/lab.ts';
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
  onLabChange(lab: LabId): void;
  onHandMode(mode: HandModeId): void;
  onDeleteSelected(): void;
  /**
   * Where the camera should centre its framing, in CSS px off the viewport centre.
   * Fires whenever the UI's coverage changes — layout class, sheet height, the info card
   * appearing or going — so the camera follows the *free* area, not the canvas (12 §3).
   */
  onViewportOffset(offset: { x: number; y: number }): void;
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
  #tabs!: Record<LabId, HTMLElement>;

  constructor(
    private readonly root: HTMLElement,
    private readonly appEl: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly cb: HudCallbacks,
  ) {
    this.layout = new LayoutManager(this.appEl);
    this.spawner = new Spawner(settings, cb);
    this.infocard = new InfoCard(settings, () => this.cb.onDeleteSelected());
    this.meter = new ForceMeter();
    this.pressRing = new PressRing();
    this.labPanel = el('div.labpanel');
    this.#replayBar = el('div.replaybar', { role: 'region', 'aria-label': 'Replay' });

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
      class: 'iconbtn toggle engravebtn',
      'aria-label': 'Engraved face',
      title: 'Engraved face',
    });
    this.#engraveBtn.appendChild(icon('engrave'));

    this.#helpBtn = button('', () => this.help.toggle(), {
      class: 'iconbtn',
      'aria-label': 'Help',
      title: 'Help  (?)',
      'aria-haspopup': 'dialog',
    });
    this.#helpBtn.appendChild(icon('help'));

    this.#viewBtn = button('', () => this.cb.onResetView(), {
      class: 'iconbtn viewbtn',
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
      class: 'iconbtn text gripbtn',
      'aria-label': 'Grip strength',
      title: 'Grip: one hand — 350 N  (G)',
    });
    this.#bindForkliftUnlock();

    /*
     * Real tab semantics (15 §8.4): `aria-selected` actually tracks the active lab rather
     * than being hardcoded true, because a tablist where every tab claims to be selected
     * tells a screen-reader user nothing. Roving arrow-key focus lands with the rest of
     * the Weigh panel work.
     */
    const mkTab = (label: string, lab: LabId): HTMLElement =>
      el('button.tab', {
        type: 'button',
        role: 'tab',
        text: label,
        'aria-selected': String(lab === 'sandbox'),
        onClick: () => {
          this.setActiveTab(lab);
          this.cb.onLabChange(lab);
        },
      });
    this.#tabs = {
      sandbox: mkTab('Sandbox', 'sandbox'),
      weigh: mkTab('Weigh', 'weigh'),
      drop: mkTab('Drop', 'drop'),
    };
    const tabs = el(
      'div.tabs',
      { role: 'tablist' },
      this.#tabs.sandbox,
      this.#tabs.weigh,
      this.#tabs.drop,
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
    this.infocard.onVisibility = (on): void => {
      this.appEl.classList.toggle('has-card', on);
      this.#syncSheetMetrics();
    };
    requestAnimationFrame(() => this.#syncSheetMetrics());
  }

  /** Moves the selected state. Called on click, and by app.ts when a lab switch lands. */
  setActiveTab(lab: LabId): void {
    for (const [id, node] of Object.entries(this.#tabs)) {
      node.setAttribute('aria-selected', String(id === lab));
    }
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

    /*
     * Camera offset from MEASURED coverage, not a fixed fraction. 12 §3's "about a sixth
     * of the height" is the sheet alone; with the info card stacked on it the free area
     * on a 390 x 844 phone shrinks from 493 px to under 300, and a cube framed for the
     * sheet alone sits behind the card. Half the covered height is where the free area's
     * centre actually is. Other layouts keep the layout manager's own answer.
     */
    const { layout, offset: base } = this.layout.state;
    const cardOn = this.infocard.isVisible;
    if (layout === 'phone-portrait') {
      const card = cardOn ? this.infocard.root.offsetHeight + 12 : 0;
      this.cb.onViewportOffset({ x: 0, y: (h + card) / 2 });
    } else if (layout === 'phone-landscape') {
      // The rail is on the right and the card sits against it, so together they cover
      // the right side; the free area's centre is half that coverage left of centre.
      const rail = this.spawner.root.offsetWidth;
      const card = cardOn ? this.infocard.root.offsetWidth + 12 : 0;
      this.cb.onViewportOffset({ x: (rail + card) / 2, y: 0 });
    } else {
      this.cb.onViewportOffset(base);
    }
  }

  /**
   * Renders the controls a lab asked for. Labs describe, the HUD builds — see LabUi.
   */
  /** Mounts a lab's panel model (16 §11.5); replaces whatever idiom was there. */
  mountPanel(model: LabPanelModel): LabPanelHandle {
    this.#panelView?.dispose();
    this.#panelView = new LabPanel(this.labPanel);
    const handle = this.#panelView.mount(model);
    return {
      update: (next) => handle.update(next),
      dispose: () => {
        handle.dispose();
        this.#panelView = null;
      },
    };
  }

  #panelView: LabPanel | null = null;
  readonly #replayBar: HTMLElement;
  #replayScrub: HTMLInputElement | null = null;
  #replayTime: HTMLElement | null = null;
  #replaySpeedLabel: HTMLElement | null = null;
  #replayChips: { x: number; el: HTMLElement }[] = [];

  /**
   * The replay chrome (16 §9.4): a sheet row in the panel's place —
   * `▶ 0.1× ——●—— 1.2 s [0.1×|0.25×|1×] EXIT`. Tokens only, no new colours; the
   * status line reads REPLAY for the screen reader; Escape and EXIT both leave.
   */
  showReplay(ctl: {
    durationS: number;
    onScrub(tS: number): void;
    onSpeed(x: number): void;
    onExit(): void;
  }): void {
    const scrub = el('input.replayscrub') as HTMLInputElement;
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = ctl.durationS.toFixed(2);
    scrub.step = '0.01';
    scrub.value = '0';
    scrub.setAttribute('aria-label', 'Replay position');
    scrub.addEventListener('input', () => ctl.onScrub(Number(scrub.value)));
    this.#replayScrub = scrub;
    this.#replayTime = el('span.replaytime', { text: `${ctl.durationS.toFixed(1)} s` });
    this.#replaySpeedLabel = el('span.replayspeed', { text: '0.1×' });
    this.#replayChips = [0.1, 0.25, 1].map((x) => {
      const b = button(`${x}×`, () => ctl.onSpeed(x), { class: 'chip' });
      b.setAttribute('aria-pressed', x === 0.1 ? 'true' : 'false');
      return { x, el: b };
    });
    this.#replayBar.replaceChildren(
      el('span.replayglyph', { text: '▶', 'aria-hidden': 'true' }),
      this.#replaySpeedLabel,
      scrub,
      this.#replayTime,
      ...this.#replayChips.map((c) => c.el),
      button('EXIT', () => ctl.onExit(), { class: 'chip action' }),
      el('span.visually-hidden', { role: 'status', text: 'REPLAY' }),
    );
    this.labPanel.append(this.#replayBar); // mountPanel may have wiped it; append re-adopts
    this.labPanel.classList.add('replaying');
  }

  updateReplay(tS: number, speed: number): void {
    if (this.#replayScrub) this.#replayScrub.value = tS.toFixed(2);
    this.#replayScrub?.setAttribute('aria-valuetext', `${tS.toFixed(1)} s`);
    if (this.#replayTime) this.#replayTime.textContent = `${tS.toFixed(1)} s`;
    if (this.#replaySpeedLabel) this.#replaySpeedLabel.textContent = `${speed}×`;
    for (const c of this.#replayChips)
      c.el.setAttribute('aria-pressed', c.x === speed ? 'true' : 'false');
  }

  hideReplay(): void {
    this.labPanel.classList.remove('replaying');
  }

  setLabControls(
    groupLabel: string,
    controls: readonly { label: string; onSelect(): void }[],
  ): void {
    this.#panelView?.dispose();
    this.#panelView = null;
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
