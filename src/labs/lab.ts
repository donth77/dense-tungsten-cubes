import type * as THREE from 'three';
import type { EntityStore } from '../core/entities.ts';
import type { EventBus } from '../core/events.ts';
import type { PhysicsWorld } from '../core/physics.ts';
import type { RenderWorld } from '../core/render.ts';
import type { Vec3 } from '../types.ts';

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
      opts?: { fit?: 'stage' | 'subject'; centreYM?: number; margin?: number },
    ): void;
  };
  /**
   * The player's unit setting, as a getter.
   *
   * A function rather than a value because it changes while a lab is mounted, and a seam
   * rather than a `ui/` import because labs/ sits below ui/ and the lint rule enforces it.
   */
  units(): 'si' | 'imperial';
}

/** One button a lab wants offered. */
export interface LabControl {
  label: string;
  onSelect(): void;
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
  setControls(groupLabel: string, controls: readonly LabControl[]): void;
  toast(message: string): void;
}

export type LabId = 'sandbox' | 'weigh';

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
  build(ctx: LabContext): void;
  /** Pre-solver: apply the instrument's own forces and torques. */
  beforePhysics?(dt: number): void;
  /** Post-solver: capture instrument transforms, sample readings, advance state. */
  afterPhysics?(dt: number): void;
  /** Once per rendered frame, at the interpolation alpha. Never writes to physics. */
  render?(alpha: number): void;
  /**
   * The global Reset action. A lab that owns an instrument has state Reset must clear —
   * a tare offset, a settled reading, a beam left against its stop — and clearing the
   * player's cubes does not touch any of it.
   */
  reset?(): void;
  teardown(): void;
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
    default:
      throw new Error(`lab "${String(id)}" is not built`);
  }
}
