import { config } from '../../config.ts';
import { TARGET_IDS, TARGET_LABELS, TargetRig } from './targets.ts';
import type { TargetId } from './targets.ts';
import type { ReplayClip } from '../../core/replay.ts';
import { dragForceInto } from '../../core/aero.ts';
import { length, mass } from '../../data/format.ts';
import { DropSignal } from './drop-signal.ts';
import { FLOOR_IDS, FLOOR_LABELS, Floors } from './floors.ts';
import {
  altimeterText,
  energyReading,
  heightLabel,
  heightToRaw,
  HEIGHT_TICKS_M,
  impactFacts,
  rawToHeight,
  VERDICT_LABEL,
  verdictTone,
} from './readout.ts';
import { CARRIAGE_INTERIOR_HALF_M, Tower } from './tower.ts';
import type { Entity } from '../../core/entities.ts';
import type { DropState } from './drop-signal.ts';
import type { FloorId } from './floors.ts';
import type {
  Lab,
  LabContext,
  LabPanelHandle,
  LabPanelModel,
  PanelAction,
  PanelControl,
} from '../lab.ts';
import type { EntityId, ImpactEvent, Vec3, SurfaceId } from '../../types.ts';

/**
 * The Drop Tower (docs/16) — stage D2: the instrument, playable.
 *
 * Winch a cube (jointless: the carry is a body-kind switch), pick a height on the log
 * slider, DROP; the floor reacts, the signal measures, the panel reports in three
 * beats, and REPLAY plays the ring back at 0.1× with the follow camera. FX — marks,
 * particles, shake — are D3; what exists here is real physics and honest numbers.
 */

const D = config.drop;
const DT = config.loop.DT;

/**
 * How close the cube's bottom face has to get to the mat's resting surface before the
 * two count as touching. A hair of slack, because the solver settles a resting contact
 * a fraction of a millimetre inside the surface rather than exactly on it.
 */
const CONTACT_M = 0.004;

export class DropLab implements Lab {
  readonly id = 'drop' as const;
  readonly title = 'Drop Tower';

  #ctx!: LabContext;
  #tower!: Tower;
  #floors!: Floors;
  #signal: DropSignal | null = null;
  #panel: LabPanelHandle | null = null;
  /** AIR by default; VACUUM is the Galileo toggle (16 §6.3). */
  air = true;

  /** Everything released by the last DROP; the SUBJECT (heaviest) owns the readout. */
  #droppedIds = new Set<EntityId>();
  #subjectId: EntityId | null = null;
  #targets!: TargetRig;
  /** DROP pressed before the load settled over the target — release when it has. */
  #pendingDrop = false;
  /**
   * "This load will bottom the mat out", decided while it was still falling and spent
   * the moment it touches down. Cleared whenever the mat is left alone to heal.
   */
  #padWillBottom = false;
  #mark: { step: number } | null = null;
  /** Steps since the mark — the clip is cut the moment the post-window completes. */
  #postMarkSteps = 0;
  /** The clip cut at verdict time — the ring is only 1.5 s deep (16 §9). */
  #clip: ReplayClip | null = null;
  #prevSpeedMps = 0;
  #ccdReleased = false;
  readonly #drag: Vec3 = { x: 0, y: 0, z: 0 };

  // ---- read surface for tests and the debug facade --------------------------------
  get state(): DropState | null {
    return this.#signal?.state ?? null;
  }
  get towerPhase(): string {
    return this.#tower.phase;
  }
  get floorId(): FloorId {
    return this.#floors.active;
  }
  /** The mounted compliant pad, for tests that assert its regime. */
  get pad(): Floors['pad'] {
    return this.#floors.pad;
  }
  get heightM(): number {
    return this.#tower.targetHM;
  }

  build(ctx: LabContext): void {
    this.#ctx = ctx;
    this.#floors = new Floors(ctx);
    this.#floors.build('steel');
    this.#tower = new Tower(ctx, () => this.#floors.topYM);
    this.#tower.build();
    this.#targets = new TargetRig(ctx);
    this.#applyFraming();
    this.#publish();
  }

  // ---- the player's verbs (public: the panel, smoke and the physics tests all
  // drive these same paths) ---------------------------------------------------------

  /** Load EVERY cube in the carriage footprint and hoist to the slider height. */
  hoist(): void {
    if (this.#tower.phase !== 'idle' && this.#tower.phase !== 'dropped') return;
    const cubes = this.#cubesInFootprint();
    if (cubes.length === 0) {
      const heldNearby = [...this.#ctx.entities.all].some(
        (e) => e.heldBy !== null && Math.hypot(e.curr.p.x, e.curr.p.z) < D.plate.halfM,
      );
      this.#ctx.ui.toast(
        heldNearby ? 'Let go of the cube first' : 'Place a cube on the platform first',
      );
      return;
    }
    this.#signal = null;
    this.#mark = null;
    this.#clip = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
    this.#pendingDrop = false;
    this.#targets.refresh(); // a fresh target (and a swept debris field) per cycle
    this.#padWillBottom = false;
    this.#floors.pad?.resetBottoming();
    // A target drop must LAND on the target: the heaviest cube (the readout's
    // subject) glides to plate centre during the climb (18 §5.5 amendment).
    const heaviest =
      this.#targets.selected !== 'none'
        ? cubes.reduce((a, b) => (b.massKg > a.massKg ? b : a)).id
        : undefined;
    this.#tower.load(cubes, heaviest);
    this.#publish();
  }

  /** Release the batch. The pad's regime is decided HERE, before anything falls. */
  dropNow(): void {
    /*
     * A click with cargo aboard is NEVER lost.
     *
     * This used to enumerate the states that may swallow a press — not centred yet,
     * then the armed→hoisting flap — and each was found the hard way, the second one
     * by a smoke run that hung for 15 s on a dead button. A third still ate a click
     * landing within ~300 ms of ARMED. Enumerating windows is the losing strategy, so
     * the rule is inverted: if there is something to drop and the winch is not ready
     * to drop it, LATCH, and let afterPhysics release the moment it is armed and
     * centred (crane discipline: the load settles over the target, then releases).
     * The only silent no-op left is the honest one — no cargo, nothing to do.
     */
    const ready =
      this.#tower.phase === 'armed' && this.#tower.centredForDrop && this.#tower.hasCargo;
    if (!ready) {
      if (this.#tower.hasCargo) this.#pendingDrop = true;
      return;
    }
    const cargo: Entity[] = [];
    for (const id of this.#tower.cargoIds) {
      const e = this.#ctx.entities.get(id);
      if (e) cargo.push(e);
    }
    if (cargo.length === 0) return;
    const totalKg = cargo.reduce((sum, e) => sum + e.massKg, 0);
    const subject = cargo.reduce((a, b) => (b.massKg > a.massKg ? b : a));
    const hM = this.#tower.carriedHeightM;
    const pad = this.#floors.pad;
    let crushTravelM = 0;
    if (pad) {
      // Gate on the vacuum arrival speed and the TOTAL cargo mass — the batch lands
      // together, and the mat answers to everything it catches at once.
      const vVac = Math.sqrt(2 * config.physics.gravityMps2 * hM);
      crushTravelM = pad.wouldBottomOut(totalKg, vVac) ? pad.params.travelM : 0;
      // The PREDICTION is needed here and now — DropSignal measures the fall to the
      // surface the cube will actually meet. Applying it is beforePhysics's job, once
      // the cube is nearly down; setting the regime here collapsed the mat at release.
      if (crushTravelM === 0) pad.setRegime('live');
    }
    const ids = this.#tower.drop();
    if (ids.length === 0) return;
    this.#droppedIds = new Set(ids);
    // The readout follows the HEAVIEST cube — the one the floor's verdict is about;
    // the panel says so whenever more than one was released (user, 2026-08-24).
    this.#subjectId = subject.id;
    this.#ccdReleased = false;
    this.#prevSpeedMps = 0;
    // A crushed drop lands on the BOTTOMED fabric, a full stroke lower — measure to
    // the surface the cube actually meets (16 §7.3 amendment, 2026-08-25).
    this.#signal = new DropSignal(
      subject.id,
      hM + crushTravelM,
      this.#floors.active,
      this.#floors.topYM - crushTravelM,
    );
    this.#signalReleaseH = hM;
    this.#publish();
  }

  /** Change floors — never under a falling cube (16 §7.4). */
  setFloor(id: FloorId): void {
    if (id === this.#floors.active) return;
    const phase = this.#signal?.state.phase;
    if (phase === 'falling' || phase === 'settling') {
      this.#ctx.ui.toast('Wait for the landing');
      return;
    }
    if (id !== 'steel' && this.#targets.selected !== 'none') {
      this.#targets.select('none');
      this.#ctx.ui.toast('Targets need the steel floor');
    }
    this.#floors.mount(id);
    // The last verdict described the floor that just left; a reading must never
    // outlive the surface it measured (screenshot review 2026-08-24).
    this.#signal = null;
    this.#mark = null;
    this.#clip = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
    this.#publish();
  }

  setHeight(hM: number): void {
    // With a target standing 0.47 m proud of the plate, releases below it would
    // spawn the carry inside the pedestal zone.
    const minH = this.#targets.selected !== 'none' ? 0.6 : D.tower.minHM;
    this.#tower.targetHM = Math.min(D.tower.maxHM, Math.max(minH, hM));
    this.#publish();
  }

  /** Debug/testing passthrough. */
  get dbgCable(): { y: number; target: number; v: number } {
    return this.#tower.dbgCable;
  }

  /** The loading platform's top surface — where spawns land (2026-08-25 redesign). */
  get platformY(): number {
    return this.#tower.idleDoorPlaneY;
  }

  get targetId(): TargetId {
    return this.#targets.selected;
  }

  /** Debug/testing: the target's cycle state. */
  get targetState(): {
    deployed: boolean;
    broken: boolean;
    wasHit: boolean;
    canState: 'intact' | 'dent' | 'flat';
  } {
    return {
      deployed: this.#targets.deployed,
      broken: this.#targets.broken,
      wasHit: this.#targets.wasHit,
      canState: this.#targets.canState,
    };
  }

  setTarget(id: TargetId): void {
    if (id !== 'none' && this.#floors.active !== 'steel') {
      this.#ctx.ui.toast('Targets need the steel floor');
      return;
    }
    this.#targets.select(id);
    if (id !== 'none' && this.#tower.targetHM < 0.6) this.#tower.targetHM = 0.6;
    this.#publish();
  }

  playReplay(): void {
    if (this.#subjectId === null) return;
    // Prefer the verdict-time snapshot: the live ring has long rolled past the mark
    // by the time a person reaches for REPLAY (dead-button bug, caught 2026-08-25).
    if (this.#clip) this.#ctx.replay.playClip(this.#clip, this.#subjectId);
    else if (this.#mark) this.#ctx.replay.play(this.#mark, 0.9, 0.6, this.#subjectId);
  }

  /** Every un-held dynamic cube standing inside the carriage's footprint (17 §3.1). */
  #cubesInFootprint(): Entity[] {
    // ON THE PLATFORM (2026-08-25 redesign): dynamic, un-held, inside the bay, and
    // resting at the platform band — cubes on the PLATE belong to the floor now.
    const platY = this.#tower.idleDoorPlaneY;
    const out: Entity[] = [];
    for (const e of this.#ctx.entities.all) {
      if (e.kind !== 'dynamic' || e.heldBy !== null) continue;
      const half = e.spec.sideM / 2;
      if (
        Math.max(Math.abs(e.curr.p.x), Math.abs(e.curr.p.z)) + half >
        CARRIAGE_INTERIOR_HALF_M - 0.01
      )
        continue;
      const bottom = e.curr.p.y - half;
      if (bottom < platY - 0.05 || bottom > platY + 0.4) continue;
      out.push(e);
    }
    return out;
  }

  /** The first cube standing ON THE PLATFORM (2026-08-25 redesign). */
  #cubeOnPlate(): Entity | null {
    return this.#cubesInFootprint()[0] ?? null;
  }

  // ---- lifecycle -------------------------------------------------------------------

  beforePhysics(dt: number): void {
    this.#tower.beforePhysics(dt);
    this.#floors.beforePhysics();
    this.#targets.beforePhysics();
    /*
     * The capacity gate guards EVERY landing, not only the winch's release. It used
     * to be decided solely in dropNow(), so a hand-dropped cube met whatever regime
     * the LAST winch drop had left - a mat crushed once played concrete for the rest
     * of the session (user-caught, 2026-08-25). Judged from live arrival energy
     * (current KE plus the fall still to come), the same pre-contact rule as D0.
     * The mat also HEALS: once nothing occupies the footprint, it stands back up.
     */

    const pad = this.#floors.pad;
    if (pad) {
      const padTop = pad.padTopRestY;
      let arrivalJ = 0;
      let occupied = false;
      let touchedPad = false;

      for (const e of this.#ctx.entities.all) {
        const p = e.curr.p;
        if (Math.hypot(p.x, p.z) > pad.halfM + e.spec.sideM / 2) continue;
        /*
         * A cube standing on the LOADING PLATFORM is not on its way to the mat.
         *
         * The gate charges a cube its remaining fall, and the platform sits 0.85 m
         * above the pad — so an 8" tungsten cube spawned on it was credited with
         * 63.7 kg x 9.81 x 0.54 = 337 J and bottomed the trampoline (150 J) the
         * instant it appeared, without anything being dropped at all. Foam (30 J)
         * went the same way (user-caught, 2026-08-26). Anything resting on the
         * platform, inside the platform's own footprint, is the carriage's business:
         * it neither loads the mat nor keeps it from healing.
         */
        const half = e.spec.sideM / 2;
        const onPlatform =
          this.#tower.hasPlatform &&
          p.y - half >= this.#tower.idleDoorPlaneY - 0.02 &&
          Math.abs(p.x) <= CARRIAGE_INTERIOR_HALF_M + half &&
          Math.abs(p.z) <= CARRIAGE_INTERIOR_HALF_M + half;
        if (onPlatform) continue;
        occupied = true;
        if (e.kind !== 'dynamic' || e.heldBy !== null || e.lastVel.y >= 0) continue;
        const dropM = p.y - e.spec.sideM / 2 - padTop;
        if (dropM > 0.01) {
          arrivalJ +=
            0.5 * e.massKg * e.lastVel.y * e.lastVel.y +
            e.massKg * config.physics.gravityMps2 * dropM;
        }
        // Touching yet? dropM is the gap from the cube's bottom face to the fabric at
        // rest, so at or below zero the two are in contact on screen.
        if (dropM <= CONTACT_M) touchedPad = true;
      }
      /*
       * Decide while it falls, collapse when it lands.
       *
       * The verdict is knowable the moment anything is falling — the gate charges each
       * cube its REMAINING fall, so arrivalJ clears the threshold at release from any
       * height — but acting on it there made the mat give way while the cube was still
       * in the air. Arming it a fixed time ahead only shortened that; the cube still
       * never touched the mat the player was looking at (user, 2026-08-28).
       *
       * So LATCH the verdict while it is still computable, and spend it only once the
       * mat has been touched AND has actually run out of travel under the load. The
       * first two cannot be read in the same breath: arrivalJ is only accumulated while
       * the cube is clear of the fabric, so it falls to zero in the very step that
       * touchedPad becomes true.
       *
       * bottomed() is what makes the collapse legible rather than instantaneous. On
       * contact alone the mat gave way 14 ms later — one frame, indistinguishable from
       * breaking on touch. Waiting for the fabric to genuinely exhaust its stroke buys
       * 48 ms at a 2 m drop and 105 ms at 0.4 m: the slower the landing, the longer it
       * visibly stretches first, which is what a mat actually does.
       *
       * Landing on the mat at rest height is also what keeps the impact honest. The
       * eager flatten existed because a slam teleport close to contact ate the landing
       * (0.87 m/s recorded for a 9.5 m/s strike, 16 §7.3); here the collision happens
       * against a pad that has been standing still all along, and the collapse follows
       * it rather than replacing it.
       */
      if (arrivalJ > pad.params.bottomOutJ) this.#padWillBottom = true;
      if (this.#padWillBottom && touchedPad && pad.bottomed()) {
        pad.setRegime('crushed');
      } else if (!occupied) {
        this.#padWillBottom = false;
        pad.setRegime('live'); // no-op unless it was crushed
      }
    }
    if (this.air) {
      // The air column applies to EVERY dynamic cube in the lab — a thrown cube slows
      // too; consistency beats a special case (16 §6.3). Never to instrument bodies.
      for (const e of this.#ctx.entities.all) {
        if (e.kind !== 'dynamic') continue;
        dragForceInto(e.lastVel, e.spec.sideM, e.massKg, dt, this.#drag);
        if (this.#drag.x !== 0 || this.#drag.y !== 0 || this.#drag.z !== 0) {
          this.#ctx.physics.applyForce(e.body, this.#drag);
        }
      }
    }
  }

  afterPhysics(): void {
    this.#applyFraming(); // key-gated; live only while the subject falls
    this.#floors.afterPhysics();
    if (this.#pendingDrop && this.#tower.phase === 'armed' && this.#tower.centredForDrop) {
      this.#pendingDrop = false;
      this.dropNow();
    }
    this.#targets.syncPhase(this.#tower.phase);
    this.#targets.afterPhysics();
  }

  /**
   * The measurement tick (16 §11.1): every step, post-solver, pre-fan-out. The
   * replay mark is stamped on the impact frame, which the recorder has just written.
   */
  onImpacts(events: readonly ImpactEvent[]): void {
    const targetHit = this.#targets.checkImpacts(events, (id) => {
      const e = this.#ctx.entities.get(id);
      return e ? e.massKg : null;
    });
    if (targetHit === 'broke') this.#signal?.setTargetVerdict(this.#targets.breakVerdict);
    /*
     * Cut the replay snapshot as soon as mark+0.6 s is recorded — NOT at the verdict.
     * The ring is 1.5 s deep and a trampoline bounce takes >2 s to settle, so a
     * verdict-time cut came back empty on exactly the floor whose replay is most fun
     * (user-visible as a dead REPLAY button, 2026-08-25).
     */
    if (this.#mark && !this.#clip && ++this.#postMarkSteps >= 36) {
      this.#clip = this.#ctx.replay.snapshot(this.#mark, 0.9, 0.6);
    }
    /*
     * The panel follows EVERYTHING it renders, not just the drop signal. Two bugs of
     * the same species, both user-caught on 2026-08-24: pressing HOIST armed the
     * winch internally while the button stayed a disabled DROP (no publish on tower
     * phase change), and a spawned cube landed on the plate while HOIST stayed
     * disabled under a stale PLACE A CUBE (no publish when #cubeOnPlate flipped).
     * The cure is one derived key of every world fact the model reads outside the
     * signal path; the signal path already publishes per step while it runs.
     */
    const key = `${this.#tower.phase}|${this.#cubeOnPlate() ? 1 : 0}|${this.#targets.selected}|${this.#targets.broken ? 1 : 0}`;
    if (key !== this.#publishedKey) this.#publish();
    const sig = this.#signal;
    if (!sig) return;
    const id = sig.cubeId;
    const e = this.#ctx.entities.get(id);
    if (!e) {
      // The dropped cube was deleted mid-flight; the drop is over.
      this.#signal = null;
      this.#tower.finishDrop();
      this.#publish();
      return;
    }
    const mine = sig.state.phase === 'falling' ? events.filter((ev) => ev.a === id) : [];
    // The replay mark is the FIRST landing of ANY released cube, not just the subject.
    if (
      !this.#mark &&
      sig.state.phase === 'falling' &&
      events.some((ev) => typeof ev.a === 'number' && this.#droppedIds.has(ev.a))
    ) {
      this.#mark = this.#ctx.replay.markNow();
      this.#postMarkSteps = 0;
    }

    const v = e.lastVel;
    const speedNow = Math.hypot(v.x, v.y, v.z);
    const w = this.#ctx.physics.angularVelocityOf(e.body);
    const state = sig.update(
      {
        cubeYM: e.curr.p.y,
        cubeBottomYM: e.curr.p.y - e.spec.sideM / 2,
        // The impact beat uses the PREVIOUS step's speed — the last one before the
        // solver ate the landing — exactly as the D0 spike measured it.
        speedMps: mine.length ? this.#prevSpeedMps : speedNow,
        angSpeedRadS: Math.hypot(w.x, w.y, w.z),
        massKg: e.massKg,
        impacts: mine,
        padBottomed: this.#floors.pad?.bottomed() ?? false,
      },
      DT,
    );
    this.#prevSpeedMps = speedNow;

    /*
     * SURVIVED is judged DURING SETTLING — before the verdict freezes. The signal
     * deliberately never revises a done verdict (three-beat honesty), so a target
     * verdict must be in hand at the freeze; and a feather-tap's impact event can
     * arrive gated-late in the settle wobble, so a once-only transition check
     * missed it (both measured, 2026-08-25). A break overwrites: last word wins
     * pre-freeze, and nothing wins after.
     */
    if (
      (state.phase === 'settling' || state.phase === 'done') &&
      this.#targets.wasHit &&
      !this.#targets.broken
    ) {
      sig.setTargetVerdict('survived');
    }
    if (state.phase === 'done' && !this.#ccdReleased) {
      if (this.#mark && !this.#clip) {
        this.#clip = this.#ctx.replay.snapshot(this.#mark, 0.9, 0.6);
      }
      this.#ccdReleased = true;
      for (const droppedId of this.#droppedIds) {
        const de = this.#ctx.entities.get(droppedId);
        if (de) this.#ctx.physics.setCcd(de.body, false);
      }
      this.#tower.finishDrop();
    }
    this.#publish();
  }

  render(alpha: number): void {
    this.#tower.render(alpha);
    this.#floors.render(alpha);
    this.#targets.render(alpha);
  }

  reset(): void {
    this.#pendingDrop = false;
    this.#targets.stow(); // fresh target next deploy; shards leave with the cubes
    this.#lastFrameKey = ''; // the R-key rig reset moved the camera; re-frame from scratch
    this.#ctx.fx.decals.clear(); // marks are session history; RESET starts a new session (16 §7.5)
    // Keep floor, height, air — clearing cubes is the app's half (16 §11.8).
    this.#tower.unload();
    this.#signal = null;
    this.#mark = null;
    this.#clip = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
    this.#padWillBottom = false;
    this.#floors.pad?.setRegime('live');
    this.#floors.pad?.resetBottoming();
    this.#publish();
  }

  /**
   * Spawns FILL the carriage footprint while there is room and the winch is not
   * carrying — that is what makes batch drops the default flow (17, amended) — then
   * fall back to the staging row.
   */
  preferredSpawnPoint(): Vec3 | null {
    const carrying =
      this.#tower.phase === 'loading' ||
      this.#tower.phase === 'hoisting' ||
      this.#tower.phase === 'armed';
    if (!carrying) {
      // Spawns land ON THE PLATFORM (2026-08-25 redesign): centre slot first, ring
      // slots after — the plate below belongs to the floor and its target.
      const platY = this.#tower.idleDoorPlaneY;
      const slots: readonly [number, number][] = [
        [0, 0],
        [0.15, 0],
        [-0.15, 0],
        [0, 0.15],
        [0, -0.15],
        [0.15, 0.15],
        [-0.15, -0.15],
        [0.15, -0.15],
        [-0.15, 0.15],
      ];
      const near = [...this.#ctx.entities.all].filter(
        (e) => Math.hypot(e.curr.p.x, e.curr.p.z) < D.plate.halfM + 0.3 && e.curr.p.y > platY - 0.1,
      );
      for (const [sx, sz] of slots) {
        const clear = near.every(
          (e) =>
            Math.max(Math.abs(e.curr.p.x - sx), Math.abs(e.curr.p.z - sz)) >=
            e.spec.sideM / 2 + 0.075,
        );
        if (clear) return { x: sx, y: platY + 0.12, z: sz };
      }
    }
    const S = D.staging;
    let cursor = -S.rowHalfM;
    for (const e of this.#ctx.entities.all) {
      if (Math.abs(e.curr.p.z - S.zM) > 0.12) continue;
      cursor = Math.max(cursor, e.curr.p.x + e.spec.sideM / 2);
    }
    return { x: cursor + S.gapM + 0.03, y: 0.25, z: S.zM };
  }

  teardown(): void {
    this.#panel?.dispose();
    this.#panel = null;
    this.#tower.teardown();
    this.#floors.teardown();
    this.#targets.teardown();
  }

  // ---- the panel (16 §13.1) --------------------------------------------------------

  #publishedKey = '';

  #publish(): void {
    this.#publishedKey = `${this.#tower.phase}|${this.#cubeOnPlate() ? 1 : 0}|${this.#targets.selected}|${this.#targets.broken ? 1 : 0}`;
    this.#applyFraming();
    const model = this.#model();
    if (this.#panel) this.#panel.update(model);
    else this.#panel = this.#ctx.ui.mountPanel(model);
  }

  /**
   * HOIST must be VISIBLE (user, 2026-08-24: the cube rose straight out of the fixed
   * landing-zone framing and the verb read as a no-op). While the winch is carrying,
   * the camera frames from the plate up to the carried cube — capped, so a 20 m arm
   * still hands over to the altimeter — and the moment of release it returns to the
   * landing zone, because the landing is the shot (16 §5.1 amended).
   */
  #lastFrameKey = '';
  frameCamera(): void {
    this.#lastFrameKey = ''; // the rig moved the camera; re-frame from scratch
    this.#applyFraming();
  }

  #applyFraming(): void {
    const phase = this.#tower.phase;
    const carrying = phase === 'loading' || phase === 'hoisting' || phase === 'armed';
    /*
     * FALLING frames the whole drop, live: plate to the subject cube, following it
     * down — "when I increase the tower height and drop a cube, the drop is not
     * shown" (user, 2026-08-25). The rig's damped goal-chase smooths the ride, and
     * the view hands over to the landing zone as the cube arrives.
     */
    const subject = this.#subjectId !== null ? this.#ctx.entities.get(this.#subjectId) : null;
    const falling = this.#signal?.state?.phase === 'falling' && subject !== null;
    let key: string;
    let topM = 0;
    if (falling && subject) {
      topM = Math.max(subject.curr.p.y + subject.spec.sideM, 1.6);
      key = `fall:${(Math.round(topM * 4) / 4).toFixed(2)}`;
    } else if (carrying) {
      // The carriage stands ~0.95 m over its door plane; +1.15 covers the spreader.
      topM = Math.min(this.#floors.topYM + this.#tower.targetHM + 1.15, 6.5);
      key = `carry:${topM.toFixed(1)}`;
    } else {
      key = 'zone';
    }
    if (key === this.#lastFrameKey) return;
    this.#lastFrameKey = key;
    if (falling) {
      this.#ctx.camera.frameRadius((topM / 2) * 1.08, { fit: 'subject', centreYM: topM / 2 });
    } else if (carrying) {
      this.#ctx.camera.frameRadius((topM / 2) * 1.08, { fit: 'subject', centreYM: topM / 2 });
    } else {
      this.#ctx.camera.frameRadius(D.camera.radiusM, {
        fit: 'subject',
        centreYM: D.camera.centreYM,
        elevationDeg: 16, // low shot: a cube on the platform reads in silhouette
        azimuthDeg: -15, // past the sign side: mast off the cube's backdrop AND the placard face-on
      });
    }
  }

  #model(): LabPanelModel {
    const units = this.#ctx.units();
    const st = this.#signal?.state ?? null;
    const phase = st?.phase;
    const towerPhase = this.#tower.phase;

    let statusText: string;
    let tone: LabPanelModel['status']['tone'] = 'neutral';
    let announce: string | undefined;
    if (phase === 'falling') statusText = 'FALLING';
    else if (phase === 'settling') statusText = 'SETTLING';
    else if (phase === 'done' && st?.verdict) {
      statusText = VERDICT_LABEL[st.verdict];
      tone = verdictTone(st.verdict);
      const e = energyReading(st);
      announce = e ? `${VERDICT_LABEL[st.verdict]} — ${e.value}` : VERDICT_LABEL[st.verdict];
    } else if (towerPhase === 'hoisting' || towerPhase === 'loading') statusText = 'HOISTING';
    else if (towerPhase === 'armed') {
      statusText = `ARMED ${length(this.#tower.targetHM, units).primary}`;
      announce = `Armed at ${length(this.#tower.targetHM, units).primary}`;
    } else statusText = this.#cubeOnPlate() ? 'READY' : 'PLACE A CUBE';

    const cargoN = this.#tower.cargoIds.length;
    let cargoKg = 0;
    for (const cid of this.#tower.cargoIds) cargoKg += this.#ctx.entities.get(cid)?.massKg ?? 0;

    let primary: LabPanelModel['primary'];
    if (phase === 'falling' && st) {
      primary = { label: 'Altitude', value: altimeterText(st), provisional: true };
    } else if (st?.impact) {
      const e = energyReading(st);
      if (e) {
        primary = {
          label: 'Energy',
          value: e.value,
          sub: e.sub,
          provisional: phase !== 'done',
        };
      }
    }

    const controls: PanelControl[] = [
      {
        kind: 'slider',
        id: 'height',
        label: 'HEIGHT',
        min: 0,
        max: 1000,
        value: heightToRaw(this.#tower.targetHM),
        ticks: HEIGHT_TICKS_M.map(heightToRaw),
        format: (raw) => heightLabel(rawToHeight(raw), units),
        onChange: (raw) => this.setHeight(rawToHeight(raw)),
      },
      {
        kind: 'segmented',
        id: 'floor',
        label: 'FLOOR',
        value: this.#floors.active,
        options: FLOOR_IDS.map((id) => ({ id, label: FLOOR_LABELS[id] })),
        onChange: (id) => this.setFloor(id as FloorId),
      },
      {
        /*
         * A SEGMENTED pair, not a switch (user, 2026-08-26: "the label updates which
         * is confusing UX"). The switch swapped its own label between "AIR — drag on"
         * and "VACUUM — Galileo mode", so it was impossible to tell whether the text
         * described the current state or the thing a press would do — and the
         * accessibility semantics were inverted outright: with vacuum ON, a screen
         * reader read "VACUUM — Galileo mode, switch, NOT CHECKED", which says the
         * opposite of the truth. A switch's name must name what it CONTROLS; its
         * state belongs to aria-checked.
         *
         * Two named options fix both: the label never moves, both states are always
         * visible, and it matches the FLOOR and TARGET rows next to it.
         */
        kind: 'segmented',
        id: 'air',
        label: 'ATMOSPHERE',
        value: this.air ? 'air' : 'vacuum',
        options: [
          { id: 'air', label: 'Air' },
          { id: 'vacuum', label: 'Vacuum' },
        ],
        onChange: (id) => {
          this.air = id === 'air';
          this.#publish();
        },
      },
      ...(this.#floors.active === 'steel'
        ? [
            {
              id: 'target',
              label: 'TARGET',
              kind: 'segmented',
              options: TARGET_IDS.map((id) => ({ id, label: TARGET_LABELS[id] })),
              value: this.#targets.selected,
              onChange: (id: string) => this.setTarget(id as TargetId),
            } as const,
          ]
        : []),
    ];

    const busy = phase === 'falling' || phase === 'settling';
    const actions: PanelAction[] = [];
    if (towerPhase === 'armed' || towerPhase === 'hoisting' || towerPhase === 'loading') {
      actions.push({
        id: 'drop',
        label: 'DROP',
        primary: true,
        disabled: towerPhase !== 'armed',
        onSelect: () => this.dropNow(),
      });
    } else {
      actions.push({
        id: 'hoist',
        label: busy ? 'FALLING…' : 'HOIST',
        primary: true,
        disabled: busy || !this.#cubeOnPlate(),
        onSelect: () => this.hoist(),
      });
    }
    // REPLAY and SHARE left the panel on 2026-08-25 (user: "remove share and replay
    // functionality that doesn't make sense for now") — the plumbing stays dormant.
    actions.push({ id: 'reset', label: 'RESET', onSelect: () => this.#ctx.ui.resetLab() });

    return {
      id: 'drop',
      title: 'DROP TOWER',
      status: { text: statusText, tone },
      ...(primary ? { primary } : {}),
      facts: [
        ...(this.#targets.selected !== 'none'
          ? [
              {
                k: 'TARGET',
                v: TARGET_LABELS[this.#targets.selected],
                v2: this.#targets.broken
                  ? VERDICT_LABEL[this.#targets.breakVerdict].toLowerCase()
                  : `breaks ≈ ${this.#targets.thresholdJ} J`,
              },
            ]
          : []),
        ...(cargoN > 1
          ? [{ k: 'CARGO', v: `${cargoN} cubes`, v2: mass(cargoKg, units).primary }]
          : []),
        ...(st ? impactFacts(st, this.#signal ? this.#releaseH() : 0, units) : []),
        ...(st?.phase === 'done' && this.#droppedIds.size > 1
          ? [
              {
                k: '+',
                v: `${this.#droppedIds.size - 1} more released`,
                v2: 'readout: heaviest',
              },
            ]
          : []),
      ],
      controls,
      actions,
      ...(announce ? { announce } : {}),
    };
  }

  /** The drop block for the share codec (16 §12). */
  shareBlock(): { hM: number; floor: SurfaceId; air: boolean } {
    return { hM: this.#tower.targetHM, floor: this.#floors.active, air: this.air };
  }

  /** A decoded share block on load: floor, height, drag — then the panel re-publishes. */
  applyShare(drop: { hM: number; floor: SurfaceId; air: boolean }): void {
    if ((FLOOR_IDS as readonly string[]).includes(drop.floor)) {
      this.setFloor(drop.floor as FloorId);
    }
    const clamped = Math.min(config.drop.tower.maxHM, Math.max(config.drop.tower.minHM, drop.hM));
    this.#tower.targetHM = clamped;
    this.air = drop.air;
    this.#publish(); // setFloor published mid-way with the old height; say it all again
  }

  #releaseH(): number {
    // The signal was built with the true release height; expose it via tFlight's
    // ideal instead of re-deriving — the tower's slider may have moved since.
    return this.#signalReleaseH ?? this.#tower.targetHM;
  }
  #signalReleaseH: number | null = null;
}
