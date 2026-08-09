import * as THREE from 'three';
import { config } from './config.ts';
import { EntityStore } from './core/entities.ts';
import { EventBus } from './core/events.ts';
import { Loop } from './core/loop.ts';
import type { Stepper } from './core/loop.ts';
import type { PhysicsWorld } from './core/physics.ts';
import { RenderWorld } from './core/render.ts';
import { AudioBus } from './fx/audio.ts';
import { CameraRig } from './interaction/camera.ts';
import { TheHand } from './interaction/hand.ts';
import { InputRouter } from './interaction/input.ts';
import type { CubeSpec, ImpactEvent, Vec3 } from './types.ts';

/**
 * App — the composition root (08 §4). Constructs and wires every system, and owns the
 * frame loop. Nothing else knows how the pieces fit together.
 */
export class App implements Stepper {
  readonly bus = new EventBus();
  readonly render: RenderWorld;
  readonly physics: PhysicsWorld;
  readonly entities: EntityStore;
  readonly rig: CameraRig;
  readonly hand: TheHand;
  readonly audio: AudioBus;
  readonly input: InputRouter;
  readonly loop: Loop;

  /** Reused each step — the impact list must not allocate at 60 Hz. */
  readonly #impacts: ImpactEvent[] = [];
  lastImpact: ImpactEvent | null = null;

  /** The current spawner selection. M0 has no UI, so it's a constant (08 §11 step 3). */
  spec: CubeSpec = { metal: 'W', sideM: 2 * 0.0254, purityPctW: 95 };

  constructor(canvas: HTMLCanvasElement, physics: PhysicsWorld) {
    this.physics = physics;
    this.render = new RenderWorld(canvas);
    this.entities = new EntityStore(this.physics, this.render, this.bus);
    this.rig = new CameraRig(this.render.camera);
    this.hand = new TheHand(this.physics, this.entities, this.bus);
    this.audio = new AudioBus(this.bus);

    this.input = new InputRouter(
      canvas,
      this.render.camera,
      this.rig,
      this.hand,
      this.physics,
      this.entities,
      this.bus,
      {
        onSpawnRequest: (at) => this.spawn(at ? { x: at.x, y: at.y, z: at.z } : undefined),
        onFirstGesture: () => void this.audio.unlock(),
        onResetRequest: () => this.reset(),
      },
    );

    // Keep the audio bus's voice lookup in step with the world without giving fx/ a
    // reference to core/ (08 §5.3: fan-out is events, not calls).
    this.bus.on('spawn', ({ id }) => {
      const e = this.entities.get(id);
      if (e) this.audio.registerEntity(id, e.spec.metal, e.spec.sideM);
    });
    this.bus.on('despawn', ({ id }) => this.audio.unregisterEntity(id));

    this.#buildStage();
    this.loop = new Loop(this);
    this.#bindResize();
  }

  #buildStage(): void {
    // Physics floor: a static box, its top face at y = 0.
    const half = config.stage.floorHalfSizeM;
    const t = config.stage.floorThicknessM;
    this.physics.addStaticBox(
      { x: half, y: t / 2, z: half },
      { x: 0, y: -t / 2, z: 0 },
      'concrete',
    );
  }

  /**
   * The landing state (08 §11 step 25, pillar 3 "ten seconds to delight"): the first
   * cube is already falling when you arrive, so the first thud costs zero clicks.
   */
  spawn(at?: Vec3): void {
    const p = at ?? {
      x: config.stage.trayCentre.x + (Math.random() * 2 - 1) * config.stage.trayScatterM,
      y: config.stage.trayCentre.y,
      z: config.stage.trayCentre.z + (Math.random() * 2 - 1) * config.stage.trayScatterM,
    };
    this.entities.spawn({ ...this.spec }, p);
  }

  reset(): void {
    this.hand.release();
    this.entities.clear();
    this.rig.reset(this.spec.sideM);
    this.spawn();
  }

  // ---- the fixedStep contract (08 §7). This ordering is load-bearing. -------------

  fixedStep(dt: number): void {
    // 1. input is event-driven and already latched by the browser; nothing to snapshot.
    // 2. Hand forces go on PRE-step, so the solver resolves them in the same step.
    this.hand.applyForces();
    // 3. labs.active.update?.(dt) — no labs until M1.
    // 4. Step, draining gated impacts.
    this.#impacts.length = 0;
    this.physics.step(dt, this.#impacts);
    // 5. curr -> prev, then read the new state.
    this.entities.captureTransforms();
    // 6. Fan out.
    for (const ev of this.#impacts) {
      this.lastImpact = ev;
      this.bus.emit('impact', ev);
    }
  }

  renderStep(alpha: number, dtFrameS: number): void {
    this.entities.interpolate(alpha);
    this.rig.update(dtFrameS);
    this.render.render();

    // Dynamic resolution: sustained slow frames shrink the render target. Physics is
    // untouched — the fixed step never scales (12 §5).
    if (
      this.loop.sustainedSlow &&
      this.render.resolutionScale > config.quality.resolutionScaleFloor
    ) {
      this.render.setResolutionScale(
        this.render.resolutionScale * config.quality.resolutionScaleStep,
      );
      this.loop.resetSlowCounter();
    }
  }

  // ---- viewport -------------------------------------------------------------------

  #bindResize(): void {
    const onResize = (): void => {
      this.render.resize();
      this.rig.onResize();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    // visualViewport, not just window: on iOS the two disagree while the toolbar
    // animates, and visualViewport is what actually tracks it (12 §2).
    window.visualViewport?.addEventListener('resize', onResize);
    onResize();
  }

  start(): void {
    this.rig.frameFor(this.spec.sideM);
    this.spawn();
    this.loop.start();
  }

  /** Screen position of the grab point, for the force meter (M1 step 17). */
  grabPointScreen(): { x: number; y: number } | null {
    if (!this.hand.isHolding) return null;
    const v = new THREE.Vector3().copy(this.hand.grabPointWorld).project(this.render.camera);
    const r = this.render.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
  }
}
