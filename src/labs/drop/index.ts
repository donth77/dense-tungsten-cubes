import { config } from '../../config.ts';
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
import type { EntityId, ImpactEvent, Vec3 } from '../../types.ts';

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
  #mark: { step: number } | null = null;
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
  get heightM(): number {
    return this.#tower.targetHM;
  }

  build(ctx: LabContext): void {
    this.#ctx = ctx;
    this.#floors = new Floors(ctx);
    this.#floors.build('concrete');
    this.#tower = new Tower(ctx, () => this.#floors.topYM);
    this.#tower.build();
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
        heldNearby ? 'Let go of the cube first' : 'Place a cube on the plate first',
      );
      return;
    }
    this.#signal = null;
    this.#mark = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
    this.#floors.pad?.resetBottoming();
    this.#tower.load(cubes);
    this.#publish();
  }

  /** Release the batch. The pad's regime is decided HERE, before anything falls. */
  dropNow(): void {
    if (this.#tower.phase !== 'armed' || !this.#tower.hasCargo) return;
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
    if (pad) {
      // Gate on the vacuum arrival speed and the TOTAL cargo mass — the batch lands
      // together, and the mat answers to everything it catches at once.
      const vVac = Math.sqrt(2 * config.physics.gravityMps2 * hM);
      pad.setRegime(pad.wouldBottomOut(totalKg, vVac) ? 'crushed' : 'live');
    }
    const ids = this.#tower.drop();
    if (ids.length === 0) return;
    this.#droppedIds = new Set(ids);
    // The readout follows the HEAVIEST cube — the one the floor's verdict is about;
    // the panel says so whenever more than one was released (user, 2026-08-24).
    this.#subjectId = subject.id;
    this.#ccdReleased = false;
    this.#prevSpeedMps = 0;
    this.#signal = new DropSignal(subject.id, hM, this.#floors.active, this.#floors.topYM);
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
    this.#floors.mount(id);
    // The last verdict described the floor that just left; a reading must never
    // outlive the surface it measured (screenshot review 2026-08-24).
    this.#signal = null;
    this.#mark = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
    this.#publish();
  }

  setHeight(hM: number): void {
    this.#tower.targetHM = Math.min(D.tower.maxHM, Math.max(D.tower.minHM, hM));
    this.#publish();
  }

  playReplay(): void {
    if (!this.#mark || this.#subjectId === null) return;
    this.#ctx.replay.play(this.#mark, 0.9, 0.6, this.#subjectId);
  }

  /** Every un-held dynamic cube standing inside the carriage's footprint (17 §3.1). */
  #cubesInFootprint(): Entity[] {
    const out: Entity[] = [];
    const lim = CARRIAGE_INTERIOR_HALF_M - 0.01;
    for (const e of this.#ctx.entities.all) {
      if (e.kind !== 'dynamic' || e.heldBy !== null) continue;
      const half = e.spec.sideM / 2;
      const p = e.curr.p;
      if (Math.abs(p.x) + half > lim || Math.abs(p.z) + half > lim) continue;
      if (p.y > this.#floors.topYM + 0.6) continue;
      out.push(e);
    }
    return out;
  }

  /** The nearest un-held dynamic cube standing on the plate. */
  #cubeOnPlate(): Entity | null {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of this.#ctx.entities.all) {
      if (e.kind !== 'dynamic') continue;
      const p = e.curr.p;
      if (Math.abs(p.x) > D.plate.halfM || Math.abs(p.z) > D.plate.halfM) continue;
      if (p.y > this.#floors.topYM + 0.6) continue;
      const d = Math.hypot(p.x, p.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // ---- lifecycle -------------------------------------------------------------------

  beforePhysics(dt: number): void {
    this.#tower.beforePhysics(dt);
    this.#floors.beforePhysics();
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
    this.#floors.afterPhysics();
  }

  /**
   * The measurement tick (16 §11.1): every step, post-solver, pre-fan-out. The
   * replay mark is stamped on the impact frame, which the recorder has just written.
   */
  onImpacts(events: readonly ImpactEvent[]): void {
    /*
     * The panel follows EVERYTHING it renders, not just the drop signal. Two bugs of
     * the same species, both user-caught on 2026-08-24: pressing HOIST armed the
     * winch internally while the button stayed a disabled DROP (no publish on tower
     * phase change), and a spawned cube landed on the plate while HOIST stayed
     * disabled under a stale PLACE A CUBE (no publish when #cubeOnPlate flipped).
     * The cure is one derived key of every world fact the model reads outside the
     * signal path; the signal path already publishes per step while it runs.
     */
    const key = `${this.#tower.phase}|${this.#cubeOnPlate() ? 1 : 0}`;
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

    if (state.phase === 'done' && !this.#ccdReleased) {
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
  }

  reset(): void {
    // Keep floor, height, air — clearing cubes is the app's half (16 §11.8).
    this.#tower.unload();
    this.#signal = null;
    this.#mark = null;
    this.#droppedIds.clear();
    this.#subjectId = null;
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
        (e) => Math.hypot(e.curr.p.x, e.curr.p.z) < D.plate.halfM + 0.3,
      );
      for (const [sx, sz] of slots) {
        const clear = near.every(
          (e) =>
            Math.max(Math.abs(e.curr.p.x - sx), Math.abs(e.curr.p.z - sz)) >=
            e.spec.sideM / 2 + 0.075,
        );
        if (clear) return { x: sx, y: this.#floors.topYM + 0.25, z: sz };
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
  }

  // ---- the panel (16 §13.1) --------------------------------------------------------

  #publishedKey = '';

  #publish(): void {
    this.#publishedKey = `${this.#tower.phase}|${this.#cubeOnPlate() ? 1 : 0}`;
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
  #applyFraming(): void {
    const phase = this.#tower.phase;
    const carrying = phase === 'loading' || phase === 'hoisting' || phase === 'armed';
    let key: string;
    let topM = 0;
    if (carrying) {
      // The carriage stands ~0.95 m over its door plane; +1.15 covers the spreader.
      topM = Math.min(this.#floors.topYM + this.#tower.targetHM + 1.15, 6.5);
      key = `carry:${topM.toFixed(1)}`;
    } else {
      key = 'zone';
    }
    if (key === this.#lastFrameKey) return;
    this.#lastFrameKey = key;
    if (carrying) {
      this.#ctx.camera.frameRadius((topM / 2) * 1.08, { fit: 'subject', centreYM: topM / 2 });
    } else {
      this.#ctx.camera.frameRadius(D.camera.radiusM, {
        fit: 'subject',
        centreYM: D.camera.centreYM,
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
        kind: 'toggle',
        id: 'air',
        label: this.air ? 'AIR — drag on' : 'VACUUM — Galileo mode',
        value: this.air,
        onChange: (on) => {
          this.air = on;
          this.#publish();
        },
      },
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
    if (this.#mark && phase === 'done') {
      actions.push({ id: 'replay', label: 'REPLAY', onSelect: () => this.playReplay() });
    }
    actions.push({ id: 'reset', label: 'RESET', onSelect: () => this.reset() });

    return {
      id: 'drop',
      title: 'DROP TOWER',
      status: { text: statusText, tone },
      ...(primary ? { primary } : {}),
      facts: [
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

  #releaseH(): number {
    // The signal was built with the true release height; expose it via tFlight's
    // ideal instead of re-deriving — the tower's slider may have moved since.
    return this.#signalReleaseH ?? this.#tower.targetHM;
  }
  #signalReleaseH: number | null = null;
}
