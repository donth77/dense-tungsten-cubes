import * as THREE from 'three';
import { config } from './config.ts';
import { EntityStore } from './core/entities.ts';
import { EventBus } from './core/events.ts';
import { ReplayPlayer, ReplayRecorder } from './core/replay.ts';
import type { ReplayClip } from './core/replay.ts';
import { enableHaptics, hapticImpact } from './fx/haptics.ts';
import { Loop } from './core/loop.ts';
import type { Stepper } from './core/loop.ts';
import type { PhysicsWorld } from './core/physics.ts';
import { RenderWorld } from './core/render.ts';
import { AudioBus } from './fx/audio.ts';
import { ImpactFx } from './fx/impactfx.ts';
import { labFromPath, pathForLab } from './core/routes.ts';
import { decodeScene, encodeScene, SHARE_MAX_CUBES } from './core/share.ts';
import type { SceneState } from './core/share.ts';
import { ImpactPuffs } from './fx/particles.ts';
import { DecalSystem } from './fx/decals.ts';
import { CameraRig } from './interaction/camera.ts';
import { TheHand } from './interaction/hand.ts';
import { InputRouter } from './interaction/input.ts';
import { densityOf } from './data/metals.ts';
import { LabManager } from './labs/lab.ts';
import { Hud } from './ui/hud.ts';
import { SettingsStore } from './ui/settings.ts';
import type { LabId, CubeSpec, EntityId, ImpactEvent, MetalId, Vec3 } from './types.ts';
import type { ActionId } from './interaction/bindings.ts';

/** One key press is worth this much pointer travel — key repeat does the rest. */
const KEY_ORBIT_PX = 18;
const KEY_PAN_PX = 24;
const KEY_ZOOM = 90;

/**
 * App — the composition root (08 §4). Constructs and wires every system, and owns the
 * frame loop. Nothing else knows how the pieces fit together.
 */

/**
 * Show the room-switch spinner, returning the function that hides it.
 *
 * Held back by a beat so a switch that lands quickly — a warm chunk, a fast phone —
 * never flashes it. The element is static markup in index.html rather than something
 * built here: whatever is stalling the switch must not also be what draws the sign
 * that a switch is stalling.
 */
function showSwitching(): () => void {
  const el = document.getElementById('switching');
  const noop = (): void => {
    /* nothing to hide */
  };
  if (!el) return noop;
  const timer = window.setTimeout(() => el.setAttribute('data-on', '1'), 150);
  return () => {
    window.clearTimeout(timer);
    el.removeAttribute('data-on');
  };
}

export class App implements Stepper {
  readonly bus = new EventBus();
  readonly render: RenderWorld;
  readonly physics: PhysicsWorld;
  readonly entities: EntityStore;
  readonly rig: CameraRig;
  readonly hand: TheHand;
  readonly audio: AudioBus;
  readonly puffs: ImpactPuffs;
  readonly decals: DecalSystem;
  readonly impactFx: ImpactFx;
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

  /** The transform ring buffer and its playback (16 §9). Recording never stops... */
  readonly replay = new ReplayRecorder();
  readonly player = new ReplayPlayer();
  /** ...except while a clip plays: fixedStep is skipped, so the ring holds still. */
  #stepCount = 0;

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
      if (!e) return;
      this.audio.registerEntity(id, e.spec.metal, e.spec.sideM);
      this.replay.track(id, (p, q) => this.physics.readTransformInto(e.body, p, q));
    });
    this.bus.on('despawn', ({ id }) => {
      this.audio.unregisterEntity(id);
      this.replay.untrack(id);
      if (this.#selected === id) this.#select(null);
      // A despawned cube must not stay held. reset() and #switchLab release the hand
      // themselves before clearing, but a lab clearing entities on its own (Weigh's
      // instrument switch) has no way to reach the hand, and deleteSelected never
      // released it at all — Delete on a cube you were dragging left #heldId pointing
      // at a dead body until the next release.
      if (this.hand.heldId === id) this.hand.release('cancel');
    });

    const uiRoot = document.getElementById('ui');
    const appEl = document.getElementById('app');
    if (!uiRoot || !appEl) throw new Error('missing #ui / #app');
    this.hud = new Hud(uiRoot, appEl, this.settings, {
      onSpawn: () => this.spawn(),
      onSpecChange: (spec) => this.#onSpecChange(spec),
      onResetView: () => this.rig.reset(this.spec.sideM),
      onLabChange: (lab) => void this.#switchLab(lab),
      onHandMode: (mode) => this.hand.setMode(mode),
      onDeleteSelected: () => this.deleteSelected(),
      onViewportOffset: (o) => this.rig.setViewportOffset(o.x, o.y, o.reframe),
    });

    // The tab follows the lab that actually mounted, not the one that was clicked: a
    // switch can lose a race to a newer one, and a tab claiming a lab the player is not
    // in is worse than a tab that lags by a frame.
    this.bus.on('lab-changed', ({ lab }) => this.hud.setActiveTab(lab));
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
      // (12 §3). The HUD measures what it covers and reports through onViewportOffset;
      // this subscription only keeps the landscape/tablet cases current on resize.
      this.hud.layout.subscribe((s) => {
        // Phone layouts are measured by the HUD (onViewportOffset); the rest are fixed.
        if (s.layout === 'tablet' || s.layout === 'desktop') {
          this.rig.setViewportOffset(s.offset.x, s.offset.y);
        }
        this.rig.refit();
      }),
    );

    this.#armAudioUnlock();

    this.puffs = new ImpactPuffs(this.render.scene);
    this.decals = new DecalSystem(this.render.scene);
    this.impactFx = new ImpactFx(
      this.puffs,
      this.decals,
      () => this.render.resolutionScale < 1,
      () => this.rig.reducedMotion,
    );

    this.labs = new LabManager({
      physics: this.physics,
      entities: this.entities,
      render: this.render,
      scene: this.render.scene,
      bus: this.bus,
      camera: { frameRadius: (r, opts) => this.rig.frameRadius(r, opts) },
      units: () => this.settings.units,
      layoutClass: () => this.hud.layout.state.layout,
      fx: {
        play: (voice, gain, rate) => this.audio.play(voice, gain, rate),
        haptic: (s) => hapticImpact(s),
        particles: (at, spec) =>
          this.puffs.emit(at, spec, {
            lowTier: this.render.resolutionScale < 1,
            reducedMotion: this.rig.reducedMotion,
          }),
        decals: {
          setTarget: (mesh, floor) => this.decals.setTarget(mesh as never, floor),
          setSplatTarget: (mesh) => this.decals.setSplatTarget(mesh as never),
          splat: (at, rM, tint) => this.decals.splat(at, rM, tint),
          clear: () => this.decals.clear(),
        },
      },
      replay: {
        track: (id, read) => this.replay.track(id, read),
        untrack: (id) => this.replay.untrack(id),
        markNow: () => this.replay.markNow(),
        play: (mark, preS, postS, followId) => this.startReplay(mark, preS, postS, followId),
        snapshot: (mark, preS, postS) => this.replay.clip(mark, preS, postS),
        playClip: (clip, followId) => this.startReplayClip(clip, followId),
        isPlaying: () => this.player.isPlaying,
      },
      ui: {
        setControls: (groups) => this.hud.setLabControls(groups),
        mountPanel: (model) => this.hud.mountPanel(model),
        toast: (m) => this.hud.toast(m),
        share: () => this.share(),
        resetLab: () => this.reset(),
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
        // Rig first, lab second — the lab's framing must land last, exactly as in reset().
        this.rig.reset(this.spec.sideM);
        this.labs.active?.frameCamera?.();
        break;
      case 'toggleUnits':
        this.settings.toggleUnits();
        break;
      case 'toggleSound':
        this.settings.toggleSound();
        /*
         * Say it out loud. M is one keystroke, the setting PERSISTS, and the only
         * feedback was a 24px icon in the top bar — so a stray press left the app
         * silent across reloads with no visible cause, which is indistinguishable
         * from broken audio (user report, 2026-08-25).
         */
        this.hud.toast(this.settings.sound ? 'Sound on (M)' : 'Sound off (M)', 1800);
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
        if (this.player.isPlaying) this.stopReplay();
        else if (this.hud.help.isOpen) this.hud.help.close();
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
    // The active lab may prefer somewhere else — beside the instrument rather than in
    // the Sandbox tray. It only gets to ANSWER; spawning, the cap and the Hand all stay
    // here (15 §8.7).
    const p =
      at ?? this.labs.preferredSpawnPoint(this.spec.sideM) ?? this.#freeTraySlot(this.spec.sideM);
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

  /**
   * A lab switch starts from an EMPTY field.
   *
   * 08 §9 had cubes persist across labs as "the player's tray", and that is what shipped
   * first. It does not survive contact with instruments: a cube sitting on the balance's
   * pan has the balance torn down from under it and drops 40 cm to the floor; a cube on a
   * Sandbox mat does the same when the mat goes; and whatever is left standing where the
   * next lab mounts has to be shoved somewhere by that lab. Clearing is simpler, it is what
   * a person expects of a tab switch, and each lab has the same spawner anyway
   * (user decision 2026-08-23).
   */
  async #switchLab(lab: LabId): Promise<void> {
    if (this.labs.activeId === lab) return;
    this.#pushRoute(lab);
    this.stopReplay();
    this.replay.clear();
    this.hand.release('cancel');
    this.#select(null);
    this.entities.clear();
    // One lab's chosen camera angle must not leak into the next (user, 2026-08-25).
    this.rig.resetOrientation();
    const busy = showSwitching();
    try {
      await this.labs.switchTo(lab);
    } finally {
      busy();
    }
    // Only if THIS switch is the one that landed — a quicker switch to a third lab may
    // have won the race — and only if the lab WANTS a starter cube (Lab.spawnOnEntry):
    // the Sandbox opens with its thud; the instrument labs open as a cleared bench
    // (user decision 2026-08-24).
    if (this.labs.activeId === lab && this.labs.active?.spawnOnEntry) this.spawn();
  }

  reset(): void {
    this.stopReplay();
    this.hand.release();
    this.#select(null);
    this.entities.clear();
    // Clearing the player's cubes does not touch a tare offset, a settled reading, or a
    // beam left against its stop. The lab owns that state and has to be told (15 §8.1).
    // Rig first, lab second: the lab's own framing must land LAST, or RESET leaves
    // a cube-sized view instead of the boot view (user-caught, 2026-08-25). Labs
    // without their own framing (Sandbox) keep the rig's cube reset as before.
    this.rig.reset(this.spec.sideM);
    this.labs.reset();
    if (this.labs.active?.spawnOnEntry) this.spawn();
  }

  /**
   * Assemble and copy a share link for the scene as it stands (16 §12): the lab, every
   * cube (capped at the codec's 30), the camera, and the active lab's own block.
   */
  share(): void {
    const lab = this.labs.activeId;
    if (!lab) return;
    const cubes = [...this.entities.all].map((e) => ({
      spec: { ...e.spec },
      p: { x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z },
      q: {
        x: e.mesh.quaternion.x,
        y: e.mesh.quaternion.y,
        z: e.mesh.quaternion.z,
        w: e.mesh.quaternion.w,
      },
    }));
    const drop = this.labs.active?.shareBlock?.();
    const { hash, droppedCubes } = encodeScene({
      lab,
      cubes,
      cam: this.rig.view,
      ...(drop ? { drop } : {}),
    });
    // The address bar carries the link too — the fallback copy surface everywhere.
    history.replaceState(null, '', hash);
    const url = `${location.origin}${location.pathname}${hash}`;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () =>
          this.hud.toast(
            droppedCubes > 0
              ? `Link copied — first ${SHARE_MAX_CUBES} cubes (${droppedCubes} over the cap)`
              : 'Link copied',
          ),
        () => this.hud.toast('Copy blocked — the link is in the address bar'),
      );
    } else {
      this.hud.toast('Link is in the address bar');
    }
  }

  /**
   * Boot from a decoded share link: its lab, its cubes at their positions (orientation
   * settles — the codec keeps q for an exact-restore later), its camera, its lab block.
   */
  async #bootShared(state: SceneState): Promise<void> {
    await this.labs.switchTo(state.lab);
    if (this.labs.activeId !== state.lab) return; // a quicker manual switch won
    for (const c of state.cubes) this.entities.spawn({ ...c.spec }, c.p);
    this.rig.setView(state.cam);
    if (state.drop) this.labs.active?.applyShare?.(state.drop);
    this.hud.toast('Scene restored from link');
  }

  /** Freeze the world and play a clip (16 §9). No-op if the mark is gone. */
  startReplay(mark: { step: number }, preS: number, postS: number, followId?: EntityId): void {
    const clip = this.replay.clip(mark, preS, postS);
    if (!clip) return;
    this.startReplayClip(clip, followId);
  }

  /** Play an already-cut clip — a lab's verdict-time snapshot (16 §9). */
  startReplayClip(clip: ReplayClip, followId?: EntityId): void {
    this.hand.release('cancel');
    this.player.start(clip, (id) => {
      const e = this.entities.get(id);
      if (!e) return null;
      return {
        setPose: (p, q) => {
          e.mesh.position.set(p.x, p.y, p.z);
          e.mesh.quaternion.set(q.x, q.y, q.z, q.w);
          e.blob.visible = false;
        },
        setVisible: (on) => {
          e.mesh.visible = on;
          e.blob.visible = on;
        },
      };
    });
    if (followId !== undefined && !this.rig.reducedMotion) {
      // The one sanctioned auto-motion: player-initiated, λ-damped, replay-only (16 §9.3).
      this.rig.follow(() => this.player.positionOf(followId));
    }
    this.hud.showReplay({
      durationS: this.player.durationS,
      onScrub: (tS) => this.player.scrub(tS),
      onSpeed: (x) => this.player.setSpeed(x),
      onExit: () => this.stopReplay(),
    });
  }

  stopReplay(): void {
    if (!this.player.isPlaying) return;
    this.player.stop();
    this.rig.follow(null);
    this.hud.hideReplay();
  }

  // ---- the fixedStep contract (08 §7). This ordering is load-bearing. -------------

  fixedStep(dt: number): void {
    // 0. A replay holds the world still. The loop keeps draining its accumulator
    // through these cheap calls, so exiting a replay never causes a catch-up burst.
    if (this.player.isPlaying) return;
    // 1. input is event-driven and already latched by the browser; nothing to snapshot.
    // 2. Hand forces go on PRE-step, so the solver resolves them in the same step.
    this.hand.applyForces();
    // 3. Lab PRE-solver hook: instrument support forces and pivot damping. A step late
    //    here is a load cell that reads the previous frame's weight (15 §8.1).
    this.labs.beforePhysics(dt);
    // 4. Step, draining gated impacts.
    this.#impacts.length = 0;
    this.physics.step(dt, this.#impacts);
    // 5. curr -> prev, then read the new state.
    this.entities.captureTransforms();
    // 6. Lab POST-solver hook: capture instrument transforms, sample angle/force/stops.
    //    BEFORE the impact fan-out, so a listener that asks an instrument what it reads
    //    gets this step's answer rather than the last one's.
    this.labs.afterPhysics(dt);
    // 6b. Record the frame, then hand the step's impacts to the lab BEFORE the bus
    // fan-out (16 §11.1) — a mark taken in onImpacts must name a recorded frame.
    this.replay.record(this.#stepCount++);
    this.labs.onImpacts(this.#impacts);
    // 7. Fan out.
    for (const ev of this.#impacts) {
      this.lastImpact = ev;
      this.impactFx.onImpact(ev);
      this.bus.emit('impact', ev);
    }
    // 8. Sweep up anything flung off the slab. AFTER the fan-out, deliberately: an
    //    impact event carries entity ids, and culling first could hand a listener an
    //    id whose voice the audio bus has already unregistered.
    this.entities.cullBelow(config.stage.killPlaneY);
    // 9. Advance the selection marker's fade — last, so it never spends a step tracking
    //    a cube that step 8 has already swept off the slab.
    this.entities.updateSelectionFade(dt);
  }

  /**
   * Per-frame FX: puff ballistics and the shake offset. Applied AFTER the rig has set
   * the camera (additive, residue-free — 16 §10.1) and BEFORE the draw. Shake is off
   * under reduced motion; the puffs run at half count instead (they are not camera
   * motion).
   */
  #fxFrame(dtFrameS: number): void {
    this.puffs.update(dtFrameS);
    const shake = this.impactFx.shake;
    shake.update(dtFrameS);
    if (shake.active && !this.rig.reducedMotion) {
      const o = shake.offset(this.rig.distanceM);
      this.rig.camera.position.x += o.x;
      this.rig.camera.position.y += o.y;
    }
  }

  renderStep(alpha: number, dtFrameS: number): void {
    if (this.player.isPlaying) {
      // Playback drives the meshes; the live prev/curr stay untouched underneath and
      // the first normal frame after stop() restores them (16 §9.2).
      const alive = this.player.update(dtFrameS);
      this.hud.updateReplay(this.player.clockS, this.player.speed);
      this.rig.update(dtFrameS);
      this.#fxFrame(dtFrameS);
      this.render.render();
      if (!alive) this.stopReplay();
      return;
    }
    this.entities.interpolate(alpha);
    // Instruments interpolate on the same alpha as the cubes. A balance beam drawn
    // straight from the fixed-step pose judders beside the cubes sitting in its pans,
    // and the two are on screen together (15 §8.3).
    this.labs.render(alpha);
    this.rig.update(dtFrameS);
    this.#fxFrame(dtFrameS);
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

  /**
   * Unlock audio on the first user gesture ANYWHERE on the page.
   *
   * The router's `onFirstGesture` is bound to the CANVAS, so it only fires when the
   * player touches the 3D stage — and the whole Drop Tower flow is panel buttons
   * (pick a target, HOIST, DROP). A player who never clicked the stage got a silent
   * app and no way to know why: every impact hit `#onImpact`'s null-context guard and
   * vanished ("why doesn't audio work until I manually spawn a cube with left click",
   * user 2026-08-26 — and the likely root of the earlier "randomly on and off"
   * reports, which depended on whether the stage had been clicked that session).
   *
   * Capture phase and one-shot: a browser only needs one gesture to allow audio, and
   * this must not care which element it landed on.
   */
  #armAudioUnlock(): void {
    const kinds = ['pointerdown', 'keydown', 'touchstart'] as const;
    const fire = (): void => {
      for (const k of kinds) document.removeEventListener(k, fire, true);
      void this.audio.unlock();
      // Haptics answer to the same policy, and to the same gesture.
      enableHaptics();
    };
    for (const k of kinds) document.addEventListener(k, fire, true);
    this.#teardown.push(() => {
      for (const k of kinds) document.removeEventListener(k, fire, true);
    });
  }

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
    this.puffs.dispose();
    this.decals.dispose();
    this.labs.teardown();
    this.entities.clear();
    this.physics.free();
  }

  async start(): Promise<void> {
    this.rig.frameFor(this.spec.sideM);
    // Initial labs are lazy modules. Boot awaits the chosen one so the opaque loading
    // cover stays over the canvas until the scene, its camera frame and its starter cube
    // all exist. Letting the loop run during this await exposed an empty floor at the
    // temporary cube-sized frame, then zoomed back out when the lab finally mounted.
    const shared = decodeScene(location.hash);
    if (shared) {
      // A share link takes over the boot (16 §12): its lab, its cubes, its camera. It
      // outranks the path, because it names a whole SCENE and the path only names a tab.
      await this.#bootShared(shared);
    } else {
      const routed = labFromPath(location.pathname, import.meta.env.BASE_URL) ?? 'sandbox';
      this.hud.setActiveTab(routed);
      await this.labs.switchTo(routed);
      if (this.labs.active?.spawnOnEntry) this.spawn();
    }

    // The lab's frame is now authoritative. Pay the first render's shader/texture cost
    // under the loading cover and expose a settled camera on the next frame; neither is
    // player-authored motion, so damping them into view only reads as startup flicker.
    this.rig.snapToGoal();
    this.entities.interpolate(0);
    this.labs.render(0);
    this.render.render();

    // Back and forward walk the tabs.
    window.addEventListener('popstate', () => {
      const lab = labFromPath(location.pathname, import.meta.env.BASE_URL);
      if (lab && lab !== this.labs.activeId) {
        this.hud.setActiveTab(lab);
        void this.#switchLab(lab);
      }
    });
    this.loop.start();
  }

  /**
   * Keep the address bar on the current lab (`/`, `/weigh`, `/drop`, `/tank`).
   *
   * `pushState` so Back walks the tabs, which is what a URL per tab is FOR. The share
   * fragment is carried across deliberately: a share link names a lab and a scene, and
   * changing tabs should not silently strip the scene half of it.
   */
  #pushRoute(lab: LabId): void {
    const path = pathForLab(lab, import.meta.env.BASE_URL);
    if (location.pathname === path) return;
    history.pushState({ lab }, '', `${path}${location.hash}`);
  }

  /** Screen position of the grab point, for the force meter (M1 step 17). */
  grabPointScreen(): { x: number; y: number } | null {
    if (!this.hand.isHolding) return null;
    const v = new THREE.Vector3().copy(this.hand.grabPointWorld).project(this.render.camera);
    const r = this.render.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
  }
}
