import type { Quat, Vec3 } from '../types.ts';

/**
 * The transform ring buffer and its playback (16 §9) — playback, never re-simulation.
 *
 * Recording runs every fixed step in every lab: 90 frames × 64 slots × 7 floats is
 * 161 kB once, and writing 60 poses a step measured far under the 0.05 ms budget in
 * D0.5. Lifecycle travels as a per-frame presence mask rather than the doc's
 * spawn/despawn rows — the same information, and the player needs exactly this form
 * (a body absent from a frame is invisible in it).
 *
 * A clip is a WINDOW onto the ring, not a copy. That is safe because playback freezes
 * the fixed step (App skips `fixedStep` while a replay runs), so nothing records over
 * the window while it is being watched; a clip must not be held across resumed
 * simulation, and `ReplayPlayer.stop()` is where its life ends.
 */

export interface ReplayMark {
  step: number;
}

export interface PoseTarget {
  setPose(p: Vec3, q: Quat): void;
  setVisible?(on: boolean): void;
}

type PoseReader = (outP: Vec3, outQ: Quat) => void;

const SLOTS = 64; // 60 cubes plus a handful of lab props
const F = 7; // x y z qx qy qz qw

export class ReplayRecorder {
  readonly #cap: number;
  readonly #poses: Float32Array;
  readonly #present: Uint8Array;
  readonly #steps: Int32Array;
  readonly #slotOf = new Map<number, number>();
  readonly #idOfSlot: (number | null)[] = new Array<number | null>(SLOTS).fill(null);
  readonly #readers = new Map<number, PoseReader>();
  readonly #free: number[] = [];
  #head = -1;
  #recorded = 0;
  readonly #p: Vec3 = { x: 0, y: 0, z: 0 };
  readonly #q: Quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(capacityFrames = 90) {
    this.#cap = capacityFrames;
    this.#poses = new Float32Array(capacityFrames * SLOTS * F);
    this.#present = new Uint8Array(capacityFrames * SLOTS);
    this.#steps = new Int32Array(capacityFrames).fill(-1);
    for (let i = SLOTS - 1; i >= 0; i--) this.#free.push(i);
  }

  track(id: number, read: PoseReader): void {
    if (this.#slotOf.has(id)) return;
    const slot = this.#free.pop();
    if (slot === undefined) return; // over 64 tracked bodies: the newcomer goes unrecorded
    /*
     * A recycled slot's OLD frames still carry the previous occupant's poses; wiping
     * its presence column makes misattribution impossible for the cost of a rare
     * 90-byte memset. (A cube despawned and another spawned within the same 1.5 s
     * would otherwise replay wearing the wrong history.)
     */
    for (let f = 0; f < this.#cap; f++) this.#present[f * SLOTS + slot] = 0;
    this.#slotOf.set(id, slot);
    this.#idOfSlot[slot] = id;
    this.#readers.set(id, read);
  }

  untrack(id: number): void {
    const slot = this.#slotOf.get(id);
    if (slot === undefined) return;
    this.#slotOf.delete(id);
    this.#readers.delete(id);
    this.#idOfSlot[slot] = null;
    this.#free.push(slot);
  }

  record(step: number): void {
    this.#head = (this.#head + 1) % this.#cap;
    this.#recorded++;
    const f = this.#head;
    this.#steps[f] = step;
    this.#present.fill(0, f * SLOTS, (f + 1) * SLOTS);
    for (const [id, slot] of this.#slotOf) {
      const read = this.#readers.get(id);
      if (!read) continue;
      read(this.#p, this.#q);
      const o = (f * SLOTS + slot) * F;
      this.#poses[o] = this.#p.x;
      this.#poses[o + 1] = this.#p.y;
      this.#poses[o + 2] = this.#p.z;
      this.#poses[o + 3] = this.#q.x;
      this.#poses[o + 4] = this.#q.y;
      this.#poses[o + 5] = this.#q.z;
      this.#poses[o + 6] = this.#q.w;
      this.#present[f * SLOTS + slot] = 1;
    }
  }

  get lastStep(): number {
    return this.#head >= 0 ? (this.#steps[this.#head] ?? -1) : -1;
  }

  markNow(): ReplayMark {
    return { step: this.lastStep };
  }

  /**
   * The frames from `mark − preS` to `mark + postS`, clipped to what the ring still
   * holds. Null when the mark has already been overwritten or nothing is recorded.
   */
  clip(mark: ReplayMark, preS: number, postS: number, hz = 60): ReplayClip | null {
    if (this.#head < 0 || mark.step < 0) return null;
    const newest = this.#steps[this.#head]!;
    const oldest = newest - Math.min(this.#recorded, this.#cap) + 1;
    const from = Math.max(oldest, mark.step - Math.round(preS * hz));
    const to = Math.min(newest, mark.step + Math.round(postS * hz));
    if (to < from || mark.step < oldest || mark.step > newest) return null;
    return new ReplayClip(this, from, to, hz);
  }

  clear(): void {
    this.#head = -1;
    this.#recorded = 0;
    this.#steps.fill(-1);
    this.#present.fill(0);
  }

  /** Internal to the clip: frame lookup by absolute step. */
  frameIndexOf(step: number): number {
    if (this.#head < 0) return -1;
    const newest = this.#steps[this.#head]!;
    const back = newest - step;
    if (back < 0 || back >= Math.min(this.#recorded, this.#cap)) return -1;
    return (((this.#head - back) % this.#cap) + this.#cap) % this.#cap;
  }

  /** Internal to the clip. */
  readSlot(frame: number, slot: number, outP: Vec3, outQ: Quat): boolean {
    if (!this.#present[frame * SLOTS + slot]) return false;
    const o = (frame * SLOTS + slot) * F;
    outP.x = this.#poses[o]!;
    outP.y = this.#poses[o + 1]!;
    outP.z = this.#poses[o + 2]!;
    outQ.x = this.#poses[o + 3]!;
    outQ.y = this.#poses[o + 4]!;
    outQ.z = this.#poses[o + 5]!;
    outQ.w = this.#poses[o + 6]!;
    return true;
  }

  /** Internal to the clip: ids seen anywhere in [from, to]. */
  idsIn(from: number, to: number): number[] {
    const out: number[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      const id = this.#idOfSlot[slot];
      if (id === null || id === undefined) continue;
      for (let step = from; step <= to; step++) {
        const f = this.frameIndexOf(step);
        if (f >= 0 && this.#present[f * SLOTS + slot]) {
          out.push(id);
          break;
        }
      }
    }
    return out;
  }

  slotFor(id: number): number | undefined {
    return this.#slotOf.get(id);
  }
}

export class ReplayClip {
  constructor(
    private readonly rec: ReplayRecorder,
    readonly fromStep: number,
    readonly toStep: number,
    readonly hz: number,
  ) {}

  get durationS(): number {
    return (this.toStep - this.fromStep) / this.hz;
  }

  ids(): number[] {
    return this.rec.idsIn(this.fromStep, this.toStep);
  }

  /**
   * Pose of `id` at clip-time `tS`, interpolated between the bounding frames —
   * nlerp on the rotation, which at recorded-frame spacing is indistinguishable from
   * slerp and allocation-free. False when the body is absent at that time.
   */
  sample(id: number, tS: number, outP: Vec3, outQ: Quat): boolean {
    const slot = this.rec.slotFor(id);
    if (slot === undefined) return false;
    const t = Math.max(0, Math.min(this.durationS, tS)) * this.hz;
    const s0 = this.fromStep + Math.floor(t);
    const s1 = Math.min(this.toStep, s0 + 1);
    const frac = t - Math.floor(t);
    const f0 = this.rec.frameIndexOf(s0);
    const f1 = this.rec.frameIndexOf(s1);
    if (f0 < 0) return false;
    if (!this.rec.readSlot(f0, slot, outP, outQ)) return false;
    if (f1 < 0 || f1 === f0 || frac === 0) return true;
    if (!this.rec.readSlot(f1, slot, P1, Q1)) return true;
    outP.x += (P1.x - outP.x) * frac;
    outP.y += (P1.y - outP.y) * frac;
    outP.z += (P1.z - outP.z) * frac;
    // nlerp with hemisphere correction
    const dot = outQ.x * Q1.x + outQ.y * Q1.y + outQ.z * Q1.z + outQ.w * Q1.w;
    const s = dot < 0 ? -frac : frac;
    outQ.x += (Q1.x * (dot < 0 ? -1 : 1) - outQ.x) * Math.abs(s);
    outQ.y += (Q1.y * (dot < 0 ? -1 : 1) - outQ.y) * Math.abs(s);
    outQ.z += (Q1.z * (dot < 0 ? -1 : 1) - outQ.z) * Math.abs(s);
    outQ.w += (Q1.w * (dot < 0 ? -1 : 1) - outQ.w) * Math.abs(s);
    const n = Math.hypot(outQ.x, outQ.y, outQ.z, outQ.w) || 1;
    outQ.x /= n;
    outQ.y /= n;
    outQ.z /= n;
    outQ.w /= n;
    return true;
  }
}

const P1: Vec3 = { x: 0, y: 0, z: 0 };
const Q1: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class ReplayPlayer {
  #clip: ReplayClip | null = null;
  #targets = new Map<number, PoseTarget>();
  #clockS = 0;
  #speed = 0.1;
  readonly #p: Vec3 = { x: 0, y: 0, z: 0 };
  readonly #q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  readonly #lastPos = new Map<number, Vec3>();

  start(clip: ReplayClip, bind: (id: number) => PoseTarget | null, speed = 0.1): void {
    this.stop();
    this.#clip = clip;
    this.#clockS = 0;
    this.#speed = speed;
    for (const id of clip.ids()) {
      const t = bind(id);
      if (t) this.#targets.set(id, t);
    }
    this.#apply();
  }

  get isPlaying(): boolean {
    return this.#clip !== null;
  }
  get clockS(): number {
    return this.#clockS;
  }
  get durationS(): number {
    return this.#clip?.durationS ?? 0;
  }
  setSpeed(x: number): void {
    this.#speed = x;
  }
  get speed(): number {
    return this.#speed;
  }
  scrub(tS: number): void {
    this.#clockS = Math.max(0, Math.min(this.durationS, tS));
    this.#apply();
  }

  /** Current interpolated position of one body — the follow camera's target. */
  positionOf(id: number): Vec3 | null {
    return this.#lastPos.get(id) ?? null;
  }

  /** Advance and apply. Returns false once the clip has finished. */
  update(dtFrameS: number): boolean {
    if (!this.#clip) return false;
    this.#clockS += dtFrameS * this.#speed;
    this.#apply();
    return this.#clockS < this.durationS;
  }

  #apply(): void {
    const clip = this.#clip;
    if (!clip) return;
    for (const [id, target] of this.#targets) {
      const on = clip.sample(id, this.#clockS, this.#p, this.#q);
      if (on) {
        target.setPose(this.#p, this.#q);
        let last = this.#lastPos.get(id);
        if (!last) {
          last = { x: 0, y: 0, z: 0 };
          this.#lastPos.set(id, last);
        }
        last.x = this.#p.x;
        last.y = this.#p.y;
        last.z = this.#p.z;
      }
      target.setVisible?.(on);
    }
  }

  /** Restore every target to visible and forget the clip; live rendering resumes. */
  stop(): void {
    for (const target of this.#targets.values()) target.setVisible?.(true);
    this.#targets.clear();
    this.#lastPos.clear();
    this.#clip = null;
    this.#clockS = 0;
  }
}
