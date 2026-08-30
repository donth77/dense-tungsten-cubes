import { config } from '../../config.ts';
import { BalanceInstrument } from './balance.ts';
import { ScaleInstrument } from './scale.ts';
import type { BalanceState } from './balance-signal.ts';
import type { ScaleState } from './signal.ts';
import type { Lab, LabContext, LabControlGroup } from '../lab.ts';
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

/**
 * Gap between a spawned cube and the surface it is being placed on.
 *
 * A SETTLE, not a drop. The load path has a filter in it precisely because a cube
 * landing on a pan delivers a contact spike of several times its weight
 * (config.weigh.balance.loadFilterHz), and there is no reason to spend that spike when
 * the player asked for a cube in the pan rather than a cube thrown at it. Not zero
 * either: spawning a collider already touching another one is how you get a shove out
 * of the solver that came from nowhere.
 */
const SET_DOWN_GAP = 0.004;
/** Clearance between neighbours in one layer, so contact is not overlap. */
const NEIGHBOUR_GAP = 0.006;

const TAU = Math.PI * 2;

export class WeighLab implements Lab {
  readonly id = 'weigh' as const;
  readonly title = 'Weigh Station';

  #ctx!: LabContext;
  #mode: WeighModeId = 'balance';
  #balance: BalanceInstrument | null = null;
  #scale: ScaleInstrument | null = null;
  /**
   * Which pan the next cube goes into. LEFT by default (user, 2026-08-30) — a balance
   * asks you to put something on one side, and picking a side for you is what makes the
   * plain SPAWN button, the space bar and the pan chips all mean the same thing.
   */
  #spawnSide: 0 | 1 = 0;

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
    this.#publishControls();
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
    // A fresh instrument starts from the default side, so "left unless you say
    // otherwise" stays true after a switch rather than depending on what you did last.
    this.#spawnSide = 0;
    this.#mount(mode);
    this.#publishControls();
    this.#ctx.ui.toast(
      mode === 'balance' ? 'Balance — SPAWN fills the left pan' : 'Digital scale — 5 kg max',
    );
  }

  /**
   * The panel: which instrument, and — on the balance — which pan.
   *
   * Both rows are STATE-BEARING chips, which the old row was not: nothing on screen said
   * which instrument you were looking at, and a spawn side is useless if you cannot see
   * which one is armed.
   *
   * The pan chips only AIM (user, 2026-08-30). They pointedly do not spawn: SPAWN is the
   * dock's one primary action and the only thing that puts a cube on the stage, so a
   * second control that quietly also spawns splits that in two.
   */
  #publishControls(): void {
    const onBalance = this.#mode === 'balance';
    const groups: LabControlGroup[] = [
      {
        label: 'Instrument',
        controls: [
          { label: 'Balance', selected: onBalance, onSelect: () => this.setMode('balance') },
          {
            label: 'Digital Scale',
            selected: !onBalance,
            onSelect: () => this.setMode('digital-scale'),
          },
        ],
      },
    ];
    if (onBalance) {
      groups.push({
        label: 'Spawn onto',
        controls: ([0, 1] as const).map((side) => ({
          label: side === 0 ? 'Left pan' : 'Right pan',
          selected: this.#spawnSide === side,
          title: `SPAWN drops into the ${side === 0 ? 'left' : 'right'} pan`,
          onSelect: () => {
            this.#spawnSide = side;
            this.#publishControls();
          },
        })),
      });
    }
    this.#ctx.ui.setControls(groups);
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
    this.#spawnSide = 0;
    this.#mount(this.#mode);
    this.#publishControls();
  }

  /**
   * Cubes go ON the instrument (user, 2026-08-30): the armed pan, or the platter.
   *
   * They used to land on the bench in front of it, which is a fine place for a cube and
   * the wrong place for the ONE thing either instrument is for — every spawn then needed
   * a drag across the stage before the lab could answer anything. So the instrument gets
   * first refusal and the bench is what catches the overflow.
   *
   * `app.ts` still owns spawning, the spec, the cap and the Hand (15 §8.7). This only
   * answers where, for a cube this big.
   */
  preferredSpawnPoint(sideM: number): Vec3 | null {
    const surface = this.#instrumentSurface();
    const slot = surface && this.#freeSlotOn(surface.centre, surface.radiusM, sideM);
    return slot ?? this.#benchSlot(sideM);
  }

  /** The mounted instrument's load-bearing face, and how much of it a cube may use. */
  #instrumentSurface(): { centre: Vec3; radiusM: number } | null {
    if (this.#balance) {
      return {
        centre: this.#balance.dishFloor(this.#spawnSide),
        radiusM: this.#balance.dishRadiusM,
      };
    }
    if (this.#scale) {
      /*
       * NOT until it has zeroed. The auto-zero fires once, and only on a platter that is
       * both settled and EMPTY (15 §7.6) — the cell is carrying a 5 kg platter, so an
       * unzeroed scale reads 5 kg with nothing on it. A cube that beats the zero onto the
       * platter therefore does not just delay it, it cancels it: the load never leaves,
       * the LCD sits at ZEROING… with a kilo of tungsten in front of it, and nothing on
       * screen says why. Measured 1.3 s from mount, which is well inside the time it
       * takes to switch to this instrument and press SPAWN.
       *
       * So for that second and a bit the bench takes them, exactly as it did before
       * spawns landed on instruments at all.
       */
      if (!this.#scale.state.zeroed) return null;
      return {
        centre: { x: 0, y: this.#scale.platterTopY, z: 0 },
        radiusM: config.weigh.scale.platterHalfM.x,
      };
    }
    return null;
  }

  /**
   * A free spot on a load-bearing surface — centre first, then rings outward — or null
   * when this layer is full.
   *
   * ONE LAYER, never a tower. The signature demonstration is seven 2″ cubes side by side
   * in one 0.32 m dish (15 §1), which is what the rings are for; a fourth cube balanced
   * on top of a third would topple off a tilting pan and read as the instrument being
   * broken. When the layer is full the answer is the bench, not a taller pile.
   *
   * Deterministic rings rather than rejection sampling, for the same reason as the
   * Sandbox tray: it terminates, and it does not depend on Math.random for correctness.
   */
  #freeSlotOn(centre: Vec3, radiusM: number, sideM: number): Vec3 | null {
    const half = sideM / 2;
    const y = centre.y + half + SET_DOWN_GAP;
    // Only what is actually ON this surface: a cube on the floor under a pan, or in the
    // other pan, must not veto a slot.
    const near: { x: number; z: number; half: number }[] = [];
    for (const e of this.#ctx.entities.all) {
      const eHalf = e.spec.sideM / 2;
      if (Math.hypot(e.curr.p.x - centre.x, e.curr.p.z - centre.z) > radiusM + eHalf) continue;
      if (e.curr.p.y < centre.y - eHalf || e.curr.p.y > centre.y + 0.5) continue;
      near.push({ x: e.curr.p.x, z: e.curr.p.z, half: eHalf });
    }
    const clears = (x: number, z: number): boolean =>
      near.every(
        (o) => Math.max(Math.abs(x - o.x), Math.abs(z - o.z)) >= o.half + half + NEIGHBOUR_GAP,
      );

    if (clears(centre.x, centre.z)) return { x: centre.x, y, z: centre.z };
    // Rings sized to the cube, so a big one steps out in big strides and runs out of
    // surface immediately — which is the correct answer for a cube wider than the dish.
    const step = sideM + NEIGHBOUR_GAP;
    const reach = radiusM - half;
    for (let ring = 1; ring * step <= reach; ring++) {
      const r = ring * step;
      const n = ring * 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const x = centre.x + Math.cos(a) * r;
        const z = centre.z + Math.sin(a) * r;
        if (clears(x, z)) return { x, y, z };
      }
    }
    return null;
  }

  /**
   * The bench in FRONT of the instrument, for what the instrument has no room for —
   * never the Sandbox tray (15 §5.1), and never across the room either.
   *
   * "In front" is a different distance for each instrument, and using one number for
   * both was wrong (user, 2026-08-30). The balance is 1.06 m wide and framed to match,
   * so its bench is the shipped staging row at z = 0.48. The scale is a 0.35 m
   * instrument framed by HEIGHT at about 1.3 m, and a cube parked at 0.48 lands at the
   * bottom of the shot or outside it — so its row sits just clear of the housing,
   * where it is still obviously a cube waiting beside the scale.
   *
   * The next free spot along the row, not a fixed point: spawning twice at one
   * coordinate drops a cube onto the one already there.
   */
  #benchSlot(sideM: number): Vec3 {
    const half = sideM / 2;
    const onBalance = this.#mode === 'balance';
    const S = config.weigh.scale;
    // Clear of the instrument's own footprint AND of the cube's own width: a wide cube
    // has to stand further out, or it stands on the housing.
    const z = onBalance ? config.weigh.stagingZ : S.housingHalfM.z + half + 0.04;
    const rowHalf = onBalance ? STAGING_ROW_HALF : S.housingHalfM.x;

    let cursor = -rowHalf;
    for (const e of this.#ctx.entities.all) {
      if (Math.abs(e.curr.p.z - z) > 0.12) continue;
      cursor = Math.max(cursor, e.curr.p.x + e.spec.sideM / 2);
    }

    /*
     * The drop is unchanged for both, with one floor under it: the scale's
     * `platterRestHeightM + 0.12` is 0.17 m, which for anything above a 13″ cube is
     * BELOW its own half-height — the cube would be born with its underside through the
     * concrete, and the solver answers that with a shove out of nowhere.
     */
    const drop = onBalance ? config.weigh.balance.pivotHeightM * 0.55 : S.platterRestHeightM + 0.12;
    return {
      // Half a cube's width is the other new part — the row used to assume every cube
      // was about 2″ across, and packed 15″ ones into each other.
      x: cursor + STAGING_GAP + half,
      y: Math.max(drop, half + SET_DOWN_GAP),
      z,
    };
  }

  teardown(): void {
    this.#unmount();
    this.#ctx.ui.setControls([]);
  }
}
