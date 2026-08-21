import { config } from '../../config.ts';
import { BalanceInstrument } from './balance.ts';
import { ScaleInstrument } from './scale.ts';
import type { BalanceState } from './balance-signal.ts';
import type { ScaleState } from './signal.ts';
import type { Lab, LabContext } from '../lab.ts';
import type { Vec3 } from '../../types.ts';

/**
 * The Weigh Station (15). One lab, two mutually exclusive modes.
 *
 * **Only the active instrument is mounted.** Not hidden, not disabled — absent. An
 * unmounted balance would keep six rope constraints and a swinging beam in the solver
 * while nobody watched it, which costs a stack of contacts to simulate and gives a
 * hanging pan the chance to drift somewhere strange before you ever switch back to it.
 *
 * The Sandbox lab describes button groups and lets the HUD build them; this one does the
 * same. Instrument readings reach the panel as a view model at W3 — for now the state is
 * public and the debug facade is the readout, which is exactly what 15 §12 W2's exit asks
 * for: each mode working independently "without HUD UI beyond debug readings".
 */

export type WeighModeId = 'balance' | 'digital-scale';

export class WeighLab implements Lab {
  readonly id = 'weigh' as const;
  readonly title = 'Weigh Station';

  #ctx!: LabContext;
  #mode: WeighModeId = 'balance';
  #balance: BalanceInstrument | null = null;
  #scale: ScaleInstrument | null = null;

  get mode(): WeighModeId {
    return this.#mode;
  }
  get balance(): BalanceInstrument | null {
    return this.#balance;
  }
  get scale(): ScaleInstrument | null {
    return this.#scale;
  }
  /** Whichever instrument is mounted, as its own state shape. */
  get reading(): BalanceState | ScaleState | null {
    return this.#balance?.state ?? this.#scale?.state ?? null;
  }

  build(ctx: LabContext): void {
    this.#ctx = ctx;
    this.#mount(this.#mode);
    ctx.ui.setControls('Instrument', [
      { label: 'Balance', onSelect: () => this.setMode('balance') },
      { label: 'Digital Scale', onSelect: () => this.setMode('digital-scale') },
    ]);
  }

  setMode(mode: WeighModeId): void {
    if (mode === this.#mode && (this.#balance ?? this.#scale)) return;
    this.#unmount();
    this.#mode = mode;
    this.#mount(mode);
    this.#ctx.ui.toast(mode === 'balance' ? 'Balance' : 'Digital scale — 5 kg max');
  }

  #mount(mode: WeighModeId): void {
    if (mode === 'balance') {
      this.#balance = new BalanceInstrument(this.#ctx);
      this.#balance.build();
      // Frame the whole beam, not just the pivot.
      this.#ctx.camera.frameRadius(config.weigh.balance.armM * 1.6);
    } else {
      this.#scale = new ScaleInstrument(this.#ctx);
      this.#scale.build();
      this.#ctx.camera.frameRadius(config.weigh.scale.housingHalfM.z * 4);
    }
  }

  #unmount(): void {
    this.#balance?.teardown();
    this.#scale?.teardown();
    this.#balance = null;
    this.#scale = null;
  }

  beforePhysics(): void {
    this.#balance?.beforePhysics();
    this.#scale?.beforePhysics();
  }

  afterPhysics(dt: number): void {
    this.#balance?.afterPhysics(dt);
    this.#scale?.afterPhysics(dt);
  }

  render(alpha: number): void {
    this.#balance?.render(alpha);
    this.#scale?.render(alpha);
  }

  /**
   * Reset rebuilds the instrument outright rather than zeroing it in place. A beam left
   * against its stop, a platter mid-bounce and a stale tare are all state the player just
   * asked to be rid of, and rebuilding is the only way to be sure none of it survived.
   */
  reset(): void {
    this.#unmount();
    this.#mount(this.#mode);
  }

  /**
   * Cubes land in the staging area in FRONT of the instrument, never in the Sandbox tray
   * and never on top of a swinging balance (15 §5.1). `app.ts` still owns spawning; this
   * only answers where.
   */
  preferredSpawnPoint(): Vec3 | null {
    const drop =
      this.#mode === 'balance'
        ? config.weigh.balance.pivotHeightM * 0.55
        : config.weigh.scale.platterRestHeightM + 0.12;
    return { x: 0, y: drop, z: config.weigh.stagingZ };
  }

  teardown(): void {
    this.#unmount();
    this.#ctx.ui.setControls('', []);
  }
}
