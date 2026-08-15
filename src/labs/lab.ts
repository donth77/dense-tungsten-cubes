import type * as THREE from 'three';
import type { EntityStore } from '../core/entities.ts';
import type { EventBus } from '../core/events.ts';
import type { PhysicsWorld } from '../core/physics.ts';
import type { RenderWorld } from '../core/render.ts';

/**
 * The lab contract (05, 08 §9).
 *
 * A lab owns its statics, its props and its panel — and `teardown()` must remove
 * everything `build()` added. Player cubes are NOT a lab's property: they persist
 * across lab switches because they are the player's tray (08 §9).
 */

export interface LabContext {
  physics: PhysicsWorld;
  entities: EntityStore;
  render: RenderWorld;
  scene: THREE.Scene;
  bus: EventBus;
  ui: LabUi;
  /** Narrow camera seam — a lab may frame its own stage, nothing more. */
  camera: { frameRadius(radiusM: number): void };
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

export interface Lab {
  id: LabId;
  title: string;
  build(ctx: LabContext): void;
  /** Per-fixed-step hook (the weigh station samples its readout here). */
  update?(dt: number): void;
  teardown(): void;
}

/**
 * Swaps labs and keeps the player's cubes. Lab modules are dynamic-`import`ed on first
 * entry so a lab nobody opens costs nothing (08 §9).
 */
export class LabManager {
  #active: Lab | null = null;
  #activeId: LabId | null = null;

  constructor(private readonly ctx: LabContext) {}

  get activeId(): LabId | null {
    return this.#activeId;
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

    const lab = await loadLab(id);
    // Someone asked for a different lab while this one was loading. Drop it on the floor:
    // it was never built, so there is nothing to tear down.
    if (token !== this.#transition) return;

    lab.build(this.ctx);
    this.#active = lab;
    this.#activeId = id;
    this.ctx.bus.emit('lab-changed', { lab: id });
  }

  update(dt: number): void {
    this.#active?.update?.(dt);
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
    case 'weigh':
    default:
      // M2a. Named here so the switch is exhaustive and the failure is legible.
      throw new Error(`lab "${id}" is not built yet`);
  }
}
