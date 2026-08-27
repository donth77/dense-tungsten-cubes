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

/** The staging row runs from -this to +this in x, in front of the instrument bay. */
const STAGING_ROW_HALF = 0.42;
const STAGING_GAP = 0.02;

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
    // Clear the bench before the swap, not after (user, 2026-08-27). The two instruments
    // share one spot and answer different questions, so carrying cubes across meant
    // arriving at a fresh instrument with someone else's setup already on it. Cubes
    // first, while the pan they may be resting on still exists.
    this.#ctx.entities.clear();
    this.#unmount();
    this.#mode = mode;
    this.#mount(mode);
    this.#ctx.ui.toast(mode === 'balance' ? 'Balance' : 'Digital scale — 5 kg max');
  }

  /**
   * Moves anything standing where the instrument is about to mount out to the staging
   * row. Both routes into `#mount` now arrive with an empty field — a lab switch clears
   * (see `App.#switchLab`) and so does the mode switch above — so this earns its keep
   * only for the paths that mount an instrument with cubes already placed, such as
   * restoring a share link. Left in place because the failure it prevents is silent.
   *
   * Found by hand, not by test, back when cubes did persist across labs: the 2.4 kg boot
   * cube sat under the platter holding it at rest height, and the scale read a flat zero
   * with a kilo of tungsten on it.
   *
   * 15 §5.1: deterministic, non-overlapping staging slots, never random scatter beside a
   * moving instrument.
   */
  #clearInstrumentVolume(): void {
    const halfX =
      this.#mode === 'balance'
        ? config.weigh.balance.armM + config.weigh.balance.panRadiusM + 0.08
        : config.weigh.scale.housingHalfM.x + 0.12;
    const halfZ = 0.3;
    const ceiling = config.weigh.balance.pivotHeightM + 0.2;

    let cursor = -STAGING_ROW_HALF;
    for (const e of this.#ctx.entities.all) {
      const p = e.curr.p;
      const inside = Math.abs(p.x) < halfX && Math.abs(p.z) < halfZ && p.y < ceiling;
      if (!inside) continue;
      const half = e.spec.sideM / 2;
      cursor += half + STAGING_GAP;
      this.#ctx.physics.setTransform(
        e.body,
        { x: cursor, y: half + 0.004, z: config.weigh.stagingZ },
        true,
      );
      cursor += half;
    }
  }

  /** Reset View resets the rig to a cube; the instrument is the subject here. */
  frameCamera(): void {
    if (!this.#ctx) return;
    if (this.#balance) this.#frameBalance();
    else if (this.#scale) this.#frameScale();
  }

  #frameBalance(): void {
    // The WHOLE instrument, on every screen: 1.06 m wide, 0.78 m tall, and the subject.
    const B = config.weigh.balance;
    const halfW = B.armM + B.panRadiusM;
    const top = B.pivotHeightM + 0.1;
    this.#ctx?.camera.frameRadius(Math.hypot(halfW, top / 2), {
      fit: 'stage',
      centreYM: top / 2,
      margin: 1.1,
    });
  }

  #frameScale(): void {
    this.#ctx?.camera.frameRadius(0.4, {
      fit: 'subject',
      centreYM: config.weigh.scale.platterRestHeightM + 0.06,
      margin: 1.15,
    });
  }

  #mount(mode: WeighModeId): void {
    if (mode === 'balance') {
      this.#balance = new BalanceInstrument(this.#ctx);
      this.#balance.build();
      this.#frameBalance();
    } else {
      this.#scale = new ScaleInstrument(this.#ctx);
      // The LCD shows whichever unit the player picked, without labs/ importing ui/.
      this.#scale.units = (): 'si' | 'imperial' => this.#ctx.units();
      this.#scale.build();
      /*
       * The scale is the SUBJECT, so it fits by HEIGHT — the same call the Sandbox
       * makes for a cube, and for the same reason (camera.ts's own note). Fitting
       * the 0.84 m staging row across a portrait phone's 19-degree horizontal field
       * put the camera 5.3 m from a 35 cm instrument and the LCD was unreadable
       * (measured, user-caught 2026-08-25); the balance keeps 'stage' because it IS
       * 1.06 m wide. Distance is now aspect-independent: ~1.3 m on every screen,
       * with the staging row running off the sides on the narrowest ones.
       */
      this.#frameScale();
    }
    this.#clearInstrumentVolume();
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
    // The next free spot along the staging row, not a fixed point — spawning twice at one
    // coordinate drops a cube onto the one already there (15 §5.1).
    let cursor = -STAGING_ROW_HALF;
    for (const e of this.#ctx.entities.all) {
      if (Math.abs(e.curr.p.z - config.weigh.stagingZ) > 0.12) continue;
      cursor = Math.max(cursor, e.curr.p.x + e.spec.sideM / 2);
    }
    const drop =
      this.#mode === 'balance'
        ? config.weigh.balance.pivotHeightM * 0.55
        : config.weigh.scale.platterRestHeightM + 0.12;
    return { x: cursor + STAGING_GAP + 0.03, y: drop, z: config.weigh.stagingZ };
  }

  teardown(): void {
    this.#unmount();
    this.#ctx.ui.setControls('', []);
  }
}
