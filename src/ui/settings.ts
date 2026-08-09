import type { Units } from '../data/format.ts';

/**
 * A ~40-line observable store persisted to localStorage (08 §8.8).
 *
 * Every formatted label subscribes and re-renders itself with a direct textContent swap.
 * At this scale a vDOM would be more machinery than the thing it manages.
 */

export interface Settings {
  units: Units;
  sound: boolean;
  /** The engraved periodic-table face (03 §6: "Engraved (default) / Plain"). */
  engraving: boolean;
}

const KEY = 'dense.settings.v1';

const DEFAULTS: Settings = {
  // 08 §2.3 / roadmap Q5: SI primary, imperial subtitle.
  units: 'si',
  // 08 §2.2 / roadmap Q3: on by default, with a visible mute. The thud is half the toy,
  // and a muted-by-default build fails its own pillar on the first drop.
  sound: true,
  // 03 §6 makes Engraved the default: it is what the real product looks like, and a
  // feature nobody sees by default is a feature nobody sees.
  engraving: true,
};

type Listener = (s: Readonly<Settings>) => void;

export class SettingsStore {
  #state: Settings;
  readonly #listeners = new Set<Listener>();

  constructor() {
    this.#state = { ...DEFAULTS, ...readStored() };
  }

  get value(): Readonly<Settings> {
    return this.#state;
  }
  get units(): Units {
    return this.#state.units;
  }
  get sound(): boolean {
    return this.#state.sound;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.#state[key] === value) return;
    this.#state = { ...this.#state, [key]: value };
    persist(this.#state);
    for (const fn of [...this.#listeners]) fn(this.#state);
  }

  toggleUnits(): void {
    this.set('units', this.#state.units === 'si' ? 'imperial' : 'si');
  }
  toggleSound(): void {
    this.set('sound', !this.#state.sound);
  }
  toggleEngraving(): void {
    this.set('engraving', !this.#state.engraving);
  }
  get engraving(): boolean {
    return this.#state.engraving;
  }

  /** @returns an unsubscribe. Called immediately so a new label renders itself once. */
  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => this.#listeners.delete(fn);
  }
}

function readStored(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Partial<Settings> = {};
    const rec = parsed as Record<string, unknown>;
    // Validate rather than trust: localStorage is user-editable and a bad value here
    // would render as "undefined kg" in every label at once.
    if (rec['units'] === 'si' || rec['units'] === 'imperial') out.units = rec['units'];
    if (typeof rec['sound'] === 'boolean') out.sound = rec['sound'];
    if (typeof rec['engraving'] === 'boolean') out.engraving = rec['engraving'];
    return out;
  } catch {
    // Private-mode Safari throws on localStorage access rather than returning null.
    return {};
  }
}

function persist(state: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — the session still works, it just won't be remembered */
  }
}
