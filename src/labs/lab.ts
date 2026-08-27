import type * as THREE from 'three';
import type { EntityStore } from '../core/entities.ts';
import type { EventBus } from '../core/events.ts';
import type { PhysicsWorld } from '../core/physics.ts';
import type { RenderWorld } from '../core/render.ts';
import type { EntityId, ImpactEvent, LabId, LayoutClass, Quat, Vec3 } from '../types.ts';

export type { LabId } from '../types.ts';
import type { ReplayClip, ReplayMark } from '../core/replay.ts';
import type { SurfaceId } from '../types.ts';
import type { VoiceId } from '../fx/audio.ts';
import type { BurstSpec } from '../fx/particles.ts';

/**
 * The lab contract (05, 08 §9).
 *
 * A lab owns its statics, its props and its panel — and `teardown()` must remove
 * everything `build()` added. Player cubes are NOT a lab's property either: `app.ts`
 * clears them before a switch and spawns the new lab's first one after. 08 §9 had them
 * persist as "the player's tray"; see `App.#switchLab` for why that was dropped.
 */

export interface LabContext {
  physics: PhysicsWorld;
  entities: EntityStore;
  render: RenderWorld;
  scene: THREE.Scene;
  bus: EventBus;
  ui: LabUi;
  /**
   * Narrow camera seam — a lab may frame its own stage, nothing more. Whether the width
   * must fit too is the lab's call: a wide instrument says 'stage', a cube among
   * scenery says 'subject'.
   */
  camera: {
    frameRadius(
      radiusM: number,
      opts?: {
        fit?: 'stage' | 'subject';
        centreYM?: number;
        margin?: number;
        elevationDeg?: number;
        azimuthDeg?: number;
      },
    ): void;
  };
  /**
   * The player's unit setting, as a getter.
   *
   * A function rather than a value because it changes while a lab is mounted, and a seam
   * rather than a `ui/` import because labs/ sits below ui/ and the lint rule enforces it.
   */
  units(): 'si' | 'imperial';
  /**
   * The current layout class, as a getter, for the rare framing decision that genuinely
   * differs by screen — a tank that fits a desktop frame is tight on a phone, where the
   * panels eat the edges. Same seam shape and same reason as `units()`: it changes while
   * a lab is mounted, and `labs/` sits below `ui/`.
   */
  layoutClass(): LayoutClass;
  /**
   * Sound and touch a lab may trigger directly (16 §10.5, §10.4) — the hook clack, a
   * detent buzz. Impact FX stay on the bus; this is only for what a lab CAUSES itself.
   */
  fx: {
    play(voice: VoiceId, gain?: number, rate?: number): void;
    haptic(intensity01: number): void;
    /**
     * A lab-authored particle burst (juice, glass glints) through the shared pool.
     * Recipes are pure functions in `fx/particles.ts` — labs pick one, never invent
     * numbers inline.
     */
    particles(at: Vec3, spec: BurstSpec): void;
    /**
     * Floor-mark registration (16 §10.3): the Drop plate offers its top face as the
     * decal target on mount; `setTarget(null, null)` (or any re-target) clears the
     * marks. Labs that never register get no marks — the default is silence.
     */
    decals: {
      setTarget(mesh: unknown, floor: 'concrete' | 'oak' | 'sand' | null): void;
      setSplatTarget(mesh: unknown): void;
      splat(at: Vec3, rM: number, tint?: number): void;
      clear(): void;
    };
  };
  /**
   * The transform ring buffer (16 §9). `track`/`untrack` are for lab PROPS (pads, the
   * hook) — entities are tracked by the app; `markNow` stamps the impact frame;
   * `play` freezes the world and runs the clip, following `followId` unless reduced
   * motion forbids it. All of it no-ops gracefully when nothing is recorded.
   */
  replay: {
    track(id: number, read: (outP: Vec3, outQ: Quat) => void): void;
    untrack(id: number): void;
    markNow(): ReplayMark;
    play(mark: ReplayMark, preS: number, postS: number, followId?: EntityId): void;
    /**
     * Cut the clip around `mark` NOW, while the ring still holds it. The ring is
     * only 1.5 s deep and keeps recording at rest, so a lab that offers REPLAY
     * beyond that window must snapshot at verdict time and play the snapshot
     * (dead-button bug, caught live 2026-08-25).
     */
    snapshot(mark: ReplayMark, preS: number, postS: number): ReplayClip | null;
    playClip(clip: ReplayClip, followId?: EntityId): void;
    isPlaying(): boolean;
  };
}

/** One button a lab wants offered. */
export interface LabControl {
  label: string;
  onSelect(): void;
}

/*
 * The lab panel contract (16 §11.5) — 15 §8.4's WeighPanelModel made lab-agnostic.
 * A lab DESCRIBES its panel; `ui/labpanel.ts` renders it with keyed DOM and instant
 * textContent swaps (13 §7). Weigh's cards and Sandbox's line-ups move onto this in
 * D3; the Drop Tower's panel is born on it in D2/D3.
 */

export interface PanelReading {
  label: string;
  value: string;
  sub?: string;
  /** Dimmed: live but not yet vouched for — the scale's SETTLING treatment (15 §7.7). */
  provisional?: boolean;
}

export interface PanelFact {
  k: string;
  v: string;
  v2?: string;
}

export type PanelControl =
  | {
      kind: 'slider';
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      value: number;
      /** Tick positions in raw slider units; rendering maps them linearly. */
      ticks?: readonly number[];
      /** The human reading of a raw value — the bubble and the value line. */
      format(v: number): { text: string; sub?: string };
      onChange(v: number, committed: boolean): void;
    }
  | {
      kind: 'segmented';
      id: string;
      label: string;
      value: string;
      options: readonly { id: string; label: string }[];
      onChange(id: string): void;
    }
  | {
      kind: 'toggle';
      id: string;
      label: string;
      value: boolean;
      onChange(on: boolean): void;
    };

export interface PanelAction {
  id: string;
  label: string;
  /** Takes the accent while its lab is mounted (13 §2.1 as amended by 16 §13.5). */
  primary?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

export interface LabPanelModel {
  id: string;
  title: string;
  status: { text: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' };
  /** The one big number (13 §3's --t-xl). */
  primary?: PanelReading;
  secondary?: readonly PanelReading[];
  facts: readonly PanelFact[];
  controls: readonly PanelControl[];
  actions: readonly PanelAction[];
  /** Live-region text; spoken when it CHANGES, throttled — never numeric spam. */
  announce?: string;
}

export interface LabPanelHandle {
  update(next: LabPanelModel): void;
  dispose(): void;
}

/**
 * A lab's window onto the UI — and deliberately NOT a DOM node.
 *
 * `labs/` sits below `ui/` (08 §5) so it must not import DOM helpers; the lint rule
 * caught exactly that. Describing controls instead of building them is the better
 * shape anyway: the HUD renders a lab's controls in whatever idiom the current layout
 * uses, so a lab never learns whether it is in a desktop panel or a bottom sheet.
 */
export interface LabUi {
  /** @deprecated D3 moves every lab onto `mountPanel`; this survives until then. */
  setControls(groupLabel: string, controls: readonly LabControl[]): void;
  mountPanel(model: LabPanelModel): LabPanelHandle;
  toast(message: string): void;
  /** Copy a share link for the whole current scene (16 §12); the app assembles it. */
  share(): void;
  /**
   * The FULL reset — clears the player's cubes, resets the lab, reframes the camera
   * (what the R key does). A panel button labelled RESET must mean this: a lab-only
   * reset leaves cubes behind to silently contaminate the next batch capture
   * (user-felt on the trampoline, 2026-08-25).
   */
  resetLab(): void;
}

/**
 * The lab lifecycle (15 §8.1).
 *
 * One `update(dt)` was ambiguous about the only thing that matters here: which side of
 * the solver a hook runs on. Support forces and pivot damping MUST go in before the step
 * or they are a step late; readings, angles and stop states MUST be sampled after it or
 * they describe the previous one. The phase names are part of the physics contract and
 * must not be collapsed back into a single update.
 */
export interface Lab {
  id: LabId;
  title: string;
  /**
   * Whether entering this lab (a tab switch, a Reset, the boot) spawns one starter
   * cube. The Sandbox does — the first thud within seconds is its whole opening move
   * (01). The instrument labs do NOT (user decision 2026-08-24): a weigh station or a
   * drop tower greets you as a cleared bench, and the spawner is right there.
   */
  spawnOnEntry?: boolean;
  build(ctx: LabContext): void;
  /** Pre-solver: apply the instrument's own forces and torques. */
  beforePhysics?(dt: number): void;
  /** Post-solver: capture instrument transforms, sample readings, advance state. */
  afterPhysics?(dt: number): void;
  /** Once per rendered frame, at the interpolation alpha. Never writes to physics. */
  render?(alpha: number): void;
  /**
   * Re-apply this lab's own camera framing.
   *
   * The toolbar's Reset View resets the RIG to a cube-sized view, which is right in the
   * Sandbox and wrong everywhere else — a tank, a tower or a balance is the subject, not
   * a 2" cube, so the button zoomed into nothing (user-caught, 2026-08-27). `App.reset`
   * already relies on labs re-framing themselves; this gives Reset View the same seam
   * without also clearing instrument state, which that button must not touch.
   */
  frameCamera?(): void;

  /**
   * The global Reset action. A lab that owns an instrument has state Reset must clear —
   * a tare offset, a settled reading, a beam left against its stop — and clearing the
   * player's cubes does not touch any of it.
   */
  reset?(): void;
  teardown(): void;
  /**
   * EVERY step's impacts (usually an empty list), AFTER `afterPhysics` and the replay
   * record, BEFORE the bus fan-out — the Drop signal's measurement hook (16 §11.1).
   * A lab must not subscribe to the bus for its own measurement: subscription order
   * is not a contract, and this ordering is. Called each fixed step so a signal can
   * tick between impacts too.
   */
  onImpacts?(events: readonly ImpactEvent[]): void;
  /** This lab's block for the share codec (16 §12), if it keeps one. */
  shareBlock?(): { hM: number; floor: SurfaceId; air: boolean };
  /** Apply a decoded share block on load. The codec has already vouched for shape. */
  applyShare?(drop: { hM: number; floor: SurfaceId; air: boolean }): void;
  /**
   * Where this lab would rather a new cube appeared, in world space.
   *
   * A seam, not a transfer of ownership (15 §8.7): `app.ts` still owns spawning, the cap,
   * and the Hand. The Weigh Station answers with a spot beside the active instrument,
   * because a cube that lands in the Sandbox tray is a cube the player has to carry
   * across the stage before the lab can do anything with it.
   */
  preferredSpawnPoint?(): Vec3 | null;
}

/**
 * Swaps labs and keeps the player's cubes. Lab modules are dynamic-`import`ed on first
 * entry so a lab nobody opens costs nothing (08 §9).
 */
export class LabManager {
  #active: Lab | null = null;
  #activeId: LabId | null = null;

  /**
   * @param loadLabModule injectable only so the transition-token guarantee can be TESTED.
   *   A race between two dynamic imports is not reproducible against the real loader, and
   *   "an older import must never build over the newer lab" is a correctness property
   *   worth a test rather than a comment (15 §8.4).
   */
  constructor(
    private readonly ctx: LabContext,
    private readonly loadLabModule: (id: LabId) => Promise<Lab> = loadLab,
  ) {}

  get activeId(): LabId | null {
    return this.#activeId;
  }

  /**
   * The mounted lab itself.
   *
   * Exists so the debug facade can read an instrument before there is any HUD to show it
   * — which is exactly the state 15 §12 W2 exits in ("each mode works independently
   * without HUD UI beyond debug readings"). Without it those readings are unreachable and
   * the claim is untestable by hand.
   */
  get active(): Lab | null {
    return this.#active;
  }

  /**
   * Monotonic transition token. A lab module is dynamic-`import`ed, so two quick switches
   * are two outstanding promises with no ordering guarantee between them — the slower
   * one can resolve last and build a lab nobody asked for, over the top of the one that
   * is on screen (14 ENG-04). Only the newest request is allowed to commit.
   */
  #transition = 0;

  async switchTo(id: LabId): Promise<void> {
    if (this.#activeId === id) return;
    const token = ++this.#transition;
    this.#active?.teardown();
    this.#active = null;
    this.#activeId = null;
    this.ctx.ui.setControls('', []);

    const lab = await this.loadLabModule(id);
    // Someone asked for a different lab while this one was loading. Drop it on the floor:
    // it was never built, so there is nothing to tear down.
    if (token !== this.#transition) return;

    lab.build(this.ctx);
    this.#active = lab;
    this.#activeId = id;
    this.ctx.bus.emit('lab-changed', { lab: id });
  }

  /*
   * Every phase goes through `#active`, which `switchTo` clears BEFORE awaiting the
   * dynamic import and only sets after the transition token check. So a lab that lost a
   * race is never dispatched to: it was never assigned, and a torn-down lab is null.
   */
  beforePhysics(dt: number): void {
    this.#active?.beforePhysics?.(dt);
  }

  afterPhysics(dt: number): void {
    this.#active?.afterPhysics?.(dt);
  }

  onImpacts(events: readonly ImpactEvent[]): void {
    // Every step, empty or not: the Drop signal TICKS here (altimeter, rest dwell),
    // not just on eventful steps — a hook that only fired on impacts would freeze the
    // measurement between them.
    this.#active?.onImpacts?.(events);
  }

  render(alpha: number): void {
    this.#active?.render?.(alpha);
  }

  reset(): void {
    this.#active?.reset?.();
  }

  preferredSpawnPoint(): Vec3 | null {
    return this.#active?.preferredSpawnPoint?.() ?? null;
  }

  teardown(): void {
    this.#active?.teardown();
    this.#active = null;
    this.#activeId = null;
  }
}

async function loadLab(id: LabId): Promise<Lab> {
  switch (id) {
    case 'sandbox': {
      const mod = await import('./sandbox/index.ts');
      return new mod.SandboxLab();
    }
    case 'weigh': {
      const mod = await import('./weigh/index.ts');
      return new mod.WeighLab();
    }
    case 'drop': {
      const mod = await import('./drop/index.ts');
      return new mod.DropLab();
    }
    case 'fluid': {
      const mod = await import('./fluid/index.ts');
      return new mod.FluidLab();
    }
    default:
      throw new Error(`lab "${String(id)}" is not built`);
  }
}
