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

/** One key press is worth this much pointer travel — key repeat does the rest. */
const KEY_ORBIT_PX = 18;
const KEY_PAN_PX = 24;
const KEY_ZOOM = 90;

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
      onDeleteSelected: () => this.deleteSelected(),
    });

    this.bus.on('select', ({ id }) => this.#select(id));
    // Both of these return an unsubscribe, and both used to be dropped on the floor.
    this.#teardown.push(
      this.settings.subscribe((s) => {
        this.audio.setMuted(!s.sound);
        if (s.engraving !== this.render.engravingEnabled) {
          this.render.setEngravingEnabled(s.engraving);
          this.entities.refreshMaterials();
        }
      }),
      // The camera has to know about the UI, or a selected cube sits behind the sheet
      // (12 §3). The layout class is the single source both read.
      this.hud.layout.subscribe((s) => this.rig.setViewportOffset(s.offset.x, s.offset.y)),
    );

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
      case 'deleteSelected':
        this.deleteSelected();
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
      // Keyboard camera control. The canvas was completely keyboard-dead before this:
      // a keyboard-only visitor could spawn a cube and never look at it from any angle.
      case 'orbitLeft':
        this.rig.orbit(-KEY_ORBIT_PX, 0);
        break;
      case 'orbitRight':
        this.rig.orbit(KEY_ORBIT_PX, 0);
        break;
      case 'orbitUp':
        this.rig.orbit(0, -KEY_ORBIT_PX);
        break;
      case 'orbitDown':
        this.rig.orbit(0, KEY_ORBIT_PX);
        break;
      case 'panLeft':
        this.rig.pan(-KEY_PAN_PX, 0);
        break;
      case 'panRight':
        this.rig.pan(KEY_PAN_PX, 0);
        break;
      case 'panUp':
        this.rig.pan(0, -KEY_PAN_PX);
        break;
      case 'panDown':
        this.rig.pan(0, KEY_PAN_PX);
        break;
      case 'zoomIn':
        this.rig.dolly(-KEY_ZOOM);
        break;
      case 'zoomOut':
        this.rig.dolly(KEY_ZOOM);
        break;
      case 'metal1':
      case 'metal2':
      case 'metal3':
      case 'metal4':
      case 'metal5':
      case 'metal6': {
        // Same order as the swatch row, so "3" is always the third swatch.
        const metals: MetalId[] = ['W', 'Au', 'Cu', 'Fe', 'Ti', 'Al'];
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
    // The card and the corner brackets are one state, shown two ways.
    this.entities.setSelected(e ? id : null);
  }

  /**
   * Removes the selected cube — the Remove button and the Delete key both land here.
   *
   * The hand is released first when it happens to be holding the target. `applyForces()`
   * does self-heal if its entity vanishes, but it heals silently: no `release` event, and
   * a stale force-meter reading left on screen.
   */
  deleteSelected(): void {
    const id = this.#selected;
    if (id === null) return;
    if (this.hand.heldId === id) this.hand.release();
    this.entities.despawn(id);
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
    const p = at ?? this.#freeTraySlot(this.spec.sideM);
    const before = this.entities.size;
    this.entities.spawn({ ...this.spec }, p);
    if (before >= config.limits.maxCubes) {
      this.hud.toast(`Cube limit reached (${config.limits.maxCubes}) — oldest removed`);
    }
  }

  /**
   * A drop point in the tray whose footprint clears every live cube (14 PHY-11).
   *
   * The old version picked `x`/`z` at random inside a fixed ±0.06 m square with no regard
   * for the new cube's size. Two default spawns in a row could therefore start
   * interpenetrating, and any cube wider than 0.12 m *had* to; the solver then resolves
   * the overlap by inventing a separating impulse, which is a shove that came from
   * nowhere and can knock over a stack that was standing perfectly well.
   *
   * Deterministic outward ring search rather than rejection sampling: it terminates, it
   * does not depend on `Math.random` for correctness, and the fallback is a stated place
   * rather than "wherever the last attempt happened to land".
   */
  #freeTraySlot(sideM: number): Vec3 {
    const tray = config.stage.trayCentre;
    const y = tray.y + sideM / 2;
    const live: { x: number; z: number; half: number }[] = [];
    for (const e of this.entities.all) {
      live.push({ x: e.curr.p.x, z: e.curr.p.z, half: e.spec.sideM / 2 });
    }
    const clears = (x: number, z: number): boolean =>
      live.every((o) => {
        // AABB gap in the horizontal plane, with a small margin so contact is not overlap.
        const need = o.half + sideM / 2 + 0.002;
        return Math.abs(x - o.x) >= need || Math.abs(z - o.z) >= need;
      });

    if (clears(tray.x, tray.z)) return { x: tray.x, y, z: tray.z };
    // Rings sized to the cube being placed, so a 15" cube steps out in 15" strides.
    const step = Math.max(sideM + 0.004, config.stage.trayScatterM);
    for (let ring = 1; ring <= 6; ring++) {
      const r = ring * step;
      for (let i = 0; i < ring * 8; i++) {
        const a = (i / (ring * 8)) * Math.PI * 2;
        const x = tray.x + Math.cos(a) * r;
        const z = tray.z + Math.sin(a) * r;
        if (Math.abs(x) > config.stage.floorHalfSizeM - sideM) continue;
        if (Math.abs(z) > config.stage.floorHalfSizeM - sideM) continue;
        if (clears(x, z)) return { x, y, z };
      }
    }
    // Nowhere clear: stage it above the tray rather than inside whatever is there.
    return { x: tray.x, y: tray.y + sideM * 2, z: tray.z };
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
    // 7. Sweep up anything flung off the slab. AFTER the fan-out, deliberately: an
    //    impact event carries entity ids, and culling first could hand a listener an
    //    id whose voice the audio bus has already unregistered.
    this.entities.cullBelow(config.stage.killPlaneY);
    // 8. Advance the selection marker's fade — last, so it never spends a step tracking
    //    a cube that step 7 has already swept off the slab.
    this.entities.updateSelectionFade(dt);
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

  /** Everything that must be undone by `dispose()`, in the order it was set up. */
  readonly #teardown: (() => void)[] = [];

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
    this.#teardown.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    });
    onResize();
  }

  /**
   * Idempotent teardown (14 ENG-03).
   *
   * One long-lived page never needed this, which is why it did not exist. Anything that
   * mounts the app twice — hot reload, an embed, a mount/dispose/mount integration test —
   * did, and without it each mount left behind live resize handlers, a settings
   * subscription and a physics world.
   */
  dispose(): void {
    this.loop.stop();
    for (const off of this.#teardown.splice(0)) off();
    this.input.dispose();
    this.audio.dispose();
    this.labs.teardown();
    this.entities.clear();
    this.physics.free();
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
