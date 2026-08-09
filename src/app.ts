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
import { densityOf } from './data/metals.ts';
import { LabManager } from './labs/lab.ts';
import { Hud } from './ui/hud.ts';
import { SettingsStore } from './ui/settings.ts';
import type { CubeSpec, EntityId, ImpactEvent, MetalId, Vec3 } from './types.ts';
import type { ActionId } from './interaction/bindings.ts';

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
  readonly settings = new SettingsStore();
  readonly hud: Hud;
  readonly labs: LabManager;

  /** The cube the info card is describing, and the one the purity slider retunes. */
  #selected: EntityId | null = null;

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
        onLongPressProgress: (p, at) => this.hud.pressRing.update(p, at),
        onAction: (a) => this.#runAction(a),
        onKeyboardUsed: () => this.hud.help.noteKeyboardUsed(),
      },
    );

    // Keep the audio bus's voice lookup in step with the world without giving fx/ a
    // reference to core/ (08 §5.3: fan-out is events, not calls).
    this.bus.on('spawn', ({ id }) => {
      const e = this.entities.get(id);
      if (e) this.audio.registerEntity(id, e.spec.metal, e.spec.sideM);
    });
    this.bus.on('despawn', ({ id }) => {
      this.audio.unregisterEntity(id);
      if (this.#selected === id) this.#select(null);
    });

    const uiRoot = document.getElementById('ui');
    const appEl = document.getElementById('app');
    if (!uiRoot || !appEl) throw new Error('missing #ui / #app');
    this.hud = new Hud(uiRoot, appEl, this.settings, {
      onSpawn: () => this.spawn(),
      onSpecChange: (spec) => this.#onSpecChange(spec),
      onResetView: () => this.rig.reset(this.spec.sideM),
      onLabChange: (lab) => void this.labs.switchTo(lab),
      onHandMode: (mode) => this.hand.setMode(mode),
    });

    this.bus.on('select', ({ id }) => this.#select(id));
    this.settings.subscribe((s) => {
      this.audio.setMuted(!s.sound);
      if (s.engraving !== this.render.engravingEnabled) {
        this.render.setEngravingEnabled(s.engraving);
        this.entities.refreshMaterials();
      }
    });
    // The camera has to know about the UI, or a selected cube sits behind the sheet
    // (12 §3). The layout class is the single source both read.
    this.hud.layout.subscribe((s) => this.rig.setViewportOffset(s.offset.x, s.offset.y));

    this.labs = new LabManager({
      physics: this.physics,
      entities: this.entities,
      render: this.render,
      scene: this.render.scene,
      bus: this.bus,
      camera: { frameRadius: (r) => this.rig.frameRadius(r) },
      ui: {
        setControls: (label, controls) => this.hud.setLabControls(label, controls),
        toast: (m) => this.hud.toast(m),
      },
    });

    this.#buildStage();
    this.loop = new Loop(this);
    this.#bindResize();
  }

  /**
   * A spec change from the spawner. If a cube is selected, the purity slider retunes
   * **that cube in place** (08 §9.2) — `collider.setDensity` recomputes its mass
   * properties without dropping its pose, velocity, contacts or grab.
   */
  #onSpecChange(spec: CubeSpec): void {
    this.spec = spec;
    const id = this.#selected;
    if (id === null) return;
    const e = this.entities.get(id);
    if (!e || e.spec.metal !== 'W' || spec.metal !== 'W' || spec.purityPctW === undefined) return;
    this.entities.setPurity(id, spec.purityPctW, densityOf('W', spec.purityPctW));
    this.hud.infocard.show(e.spec);
  }

  /** Every keyboard shortcut resolves here, from the shared table (bindings.ts). */
  #runAction(action: ActionId): void {
    switch (action) {
      case 'spawn':
        this.spawn();
        break;
      case 'resetLab':
        this.reset();
        break;
      case 'resetView':
        this.rig.reset(this.spec.sideM);
        break;
      case 'toggleUnits':
        this.settings.toggleUnits();
        break;
      case 'toggleSound':
        this.settings.toggleSound();
        break;
      case 'toggleEngraving':
        this.settings.toggleEngraving();
        break;
      case 'cycleGrip':
        this.hud.cycleHandMode();
        break;
      case 'toggleHelp':
        this.hud.help.toggle();
        break;
      case 'dismiss':
        if (this.hud.help.isOpen) this.hud.help.close();
        else this.#select(null);
        break;
      case 'metal1':
      case 'metal2':
      case 'metal3':
      case 'metal4':
      case 'metal5': {
        const metals: MetalId[] = ['W', 'Cu', 'Fe', 'Ti', 'Al'];
        const picked = metals[Number(action.slice(-1)) - 1];
        if (picked) this.hud.spawner.setMetal(picked);
        break;
      }
    }
  }

  #select(id: EntityId | null): void {
    this.#selected = id;
    const e = id === null ? undefined : this.entities.get(id);
    if (e) this.hud.infocard.show(e.spec);
    else this.hud.infocard.hide();
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
    const before = this.entities.size;
    this.entities.spawn({ ...this.spec }, p);
    if (before >= config.limits.maxCubes) {
      this.hud.toast(`Cube limit reached (${config.limits.maxCubes}) — oldest removed`);
    }
  }

  reset(): void {
    this.hand.release();
    this.#select(null);
    this.entities.clear();
    this.rig.reset(this.spec.sideM);
    this.spawn();
  }

  // ---- the fixedStep contract (08 §7). This ordering is load-bearing. -------------

  fixedStep(dt: number): void {
    // 1. input is event-driven and already latched by the browser; nothing to snapshot.
    // 2. Hand forces go on PRE-step, so the solver resolves them in the same step.
    this.hand.applyForces();
    // 3. Lab hook (the weigh station samples its readout here at M2a).
    this.labs.update(dt);
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

    // The meter reads a live clamped force, so it updates every frame rather than on an
    // event — it is an instrument, not a notification (13 §5.3).
    this.hud.meter.update(
      this.hand.meter,
      this.hand.isHolding ? this.grabPointScreen() : null,
      this.hud.layout.isTouchLayout,
    );

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
      this.#fastFrames = 0;
      return;
    }

    /*
     * ...and recovers when the pressure passes (12 §5 says "recover slowly"; the first
     * implementation only ever scaled down, so one thermal blip or one heavy moment
     * permanently degraded the image for the rest of the session).
     *
     * Recovery is deliberately far slower than the drop and needs a long clean run:
     * scaling back up is what *causes* the next slow frame, so an eager version
     * oscillates between two resolutions and looks worse than either.
     */
    if (this.render.resolutionScale < 1) {
      this.#fastFrames =
        this.loop.frameMs < config.quality.slowFrameMs * 0.75 ? this.#fastFrames + 1 : 0;
      if (this.#fastFrames >= config.quality.recoverAfterFrames) {
        this.render.setResolutionScale(
          Math.min(1, this.render.resolutionScale / config.quality.resolutionScaleStep),
        );
        this.#fastFrames = 0;
      }
    }
  }

  /** Consecutive comfortably-fast frames, for dynamic-resolution recovery. */
  #fastFrames = 0;

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
    void this.labs.switchTo('sandbox');
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
