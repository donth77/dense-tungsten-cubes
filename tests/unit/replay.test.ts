import { describe, expect, it } from 'vitest';
import { ReplayPlayer, ReplayRecorder } from '../../src/core/replay.ts';
import type { Quat, Vec3 } from '../../src/types.ts';

/** A scripted body: pose = f(step), so every frame is predictable. */
function scripted(rec: ReplayRecorder, id: number, getY: (step: number) => number) {
  let step = 0;
  rec.track(id, (p: Vec3, q: Quat) => {
    p.x = id;
    p.y = getY(step);
    p.z = 0;
    q.x = 0;
    q.y = 0;
    q.z = 0;
    q.w = 1;
  });
  return { tick: (s: number) => (step = s) };
}

describe('the replay ring (16 §9)', () => {
  it('round-trips poses and interpolates between frames', () => {
    const rec = new ReplayRecorder(90);
    const a = scripted(rec, 1, (s) => s * 0.1);
    for (let s = 0; s < 10; s++) {
      a.tick(s);
      rec.record(s);
    }
    const clip = rec.clip(rec.markNow(), 1, 0)!;
    expect(clip).not.toBeNull();
    expect(clip.durationS).toBeCloseTo(9 / 60, 9);
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    const q: Quat = { x: 0, y: 0, z: 0, w: 1 };
    expect(clip.sample(1, 0, p, q)).toBe(true);
    expect(p.y).toBeCloseTo(0, 6);
    expect(clip.sample(1, clip.durationS, p, q)).toBe(true);
    expect(p.y).toBeCloseTo(0.9, 6);
    // Halfway between recorded frames 4 and 5: lerped.
    expect(clip.sample(1, 4.5 / 60, p, q)).toBe(true);
    expect(p.y).toBeCloseTo(0.45, 6);
  });

  it('clips clamp to what the ring still holds, and a lost mark returns null', () => {
    const rec = new ReplayRecorder(30);
    scripted(rec, 1, () => 0);
    for (let s = 0; s < 100; s++) rec.record(s);
    // Oldest surviving step is 70.
    expect(rec.clip({ step: 40 }, 0.5, 0.5)).toBeNull();
    const clip = rec.clip({ step: 90 }, 10, 10)!;
    expect(clip.fromStep).toBe(70);
    expect(clip.toStep).toBe(99);
  });

  it('presence follows track/untrack, and a recycled slot never inherits history', () => {
    const rec = new ReplayRecorder(90);
    const a = scripted(rec, 1, (s) => s);
    for (let s = 0; s < 5; s++) {
      a.tick(s);
      rec.record(s);
    }
    rec.untrack(1);
    for (let s = 5; s < 8; s++) rec.record(s);
    // Slot recycled by a NEW id: the old frames must not attribute to it.
    scripted(rec, 2, () => 42);
    for (let s = 8; s < 10; s++) rec.record(s);
    const clip = rec.clip({ step: 9 }, 1, 0)!;
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    const q: Quat = { x: 0, y: 0, z: 0, w: 1 };
    // id 2 exists only from step 8 — sampling at the start of the clip finds nothing.
    expect(clip.sample(2, 0, p, q)).toBe(false);
    expect(clip.sample(2, clip.durationS, p, q)).toBe(true);
    expect(p.y).toBe(42);
    expect(clip.ids()).toEqual([2]);
  });

  it('the player advances at its speed, reports the end, and restores visibility', () => {
    const rec = new ReplayRecorder(90);
    const a = scripted(rec, 1, (s) => s * 0.01);
    for (let s = 0; s < 60; s++) {
      a.tick(s);
      rec.record(s);
    }
    const clip = rec.clip({ step: 59 }, 1, 0)!;
    const player = new ReplayPlayer();
    const seen: number[] = [];
    let visible = true;
    player.start(
      clip,
      () => ({
        setPose: (p) => seen.push(p.y),
        setVisible: (on) => (visible = on),
      }),
      0.1,
    );
    expect(player.isPlaying).toBe(true);
    // 59 frames at 0.1x = 9.83 s of playback; after 1 s of wall clock: 0.1 s of clip.
    for (let i = 0; i < 60; i++) player.update(1 / 60);
    expect(player.clockS).toBeCloseTo(0.1, 6);
    expect(seen.at(-1)!).toBeCloseTo(0.06, 3);
    // Scrub to the end: one more update finishes it.
    player.scrub(player.durationS - 0.001);
    expect(player.update(1 / 60)).toBe(false);
    player.stop();
    expect(player.isPlaying).toBe(false);
    expect(visible).toBe(true);
  });

  it('markNow before anything is recorded yields no clip, never a crash', () => {
    const rec = new ReplayRecorder(90);
    expect(rec.clip(rec.markNow(), 1, 1)).toBeNull();
  });
});
