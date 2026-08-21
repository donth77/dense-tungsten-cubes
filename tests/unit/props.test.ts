import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PropStore } from '../../src/core/props.ts';
import type { PhysicsWorld } from '../../src/core/physics.ts';
import type { BodyHandle, Quat, Vec3 } from '../../src/types.ts';

/**
 * PropStore (15 §8.3). No wasm — interpolation is arithmetic, and a fake body whose pose
 * we set by hand is a far sharper instrument than a real one that has to be nudged into
 * position by a solver.
 *
 * The exit this covers: "a dynamic prop renders smoothly at display refresh rates above
 * 60 Hz". Drawn straight from the fixed-step pose on a 120 Hz display every second frame
 * repeats, and a juddering balance beam sits on screen right next to the smoothly
 * interpolated cubes in its pans.
 */

/** A stand-in world whose bodies are wherever the test last put them. */
function fakePhysics(): PhysicsWorld & {
  place(h: BodyHandle, p: Vec3, q?: Quat): void;
  kill(h: BodyHandle): void;
} {
  const poses = new Map<BodyHandle, { p: Vec3; q: Quat }>();
  const dead = new Set<BodyHandle>();
  const api = {
    place(h: BodyHandle, p: Vec3, q: Quat = { x: 0, y: 0, z: 0, w: 1 }) {
      poses.set(h, { p: { ...p }, q: { ...q } });
    },
    kill(h: BodyHandle) {
      dead.add(h);
    },
    hasBody: (h: BodyHandle) => !dead.has(h),
    transformOf: (h: BodyHandle) => {
      const t = poses.get(h)!;
      return { p: { ...t.p }, q: { ...t.q } };
    },
    readTransformInto: (h: BodyHandle, outP: Vec3, outQ: Quat) => {
      const t = poses.get(h)!;
      outP.x = t.p.x;
      outP.y = t.p.y;
      outP.z = t.p.z;
      outQ.x = t.q.x;
      outQ.y = t.q.y;
      outQ.z = t.q.z;
      outQ.w = t.q.w;
    },
  };
  return api as unknown as ReturnType<typeof fakePhysics>;
}

const BODY = 1 as BodyHandle;

describe('PropStore', () => {
  it('places a prop at its body immediately, not at the origin for one frame', () => {
    const physics = fakePhysics();
    physics.place(BODY, { x: 1, y: 2, z: 3 });
    const store = new PropStore(physics);
    const obj = new THREE.Object3D();
    store.add(BODY, obj);
    expect(obj.position.toArray()).toEqual([1, 2, 3]);
  });

  it('interpolates between the last two captured poses', () => {
    const physics = fakePhysics();
    physics.place(BODY, { x: 0, y: 0, z: 0 });
    const store = new PropStore(physics);
    const obj = new THREE.Object3D();
    store.add(BODY, obj);

    store.capture(); // curr = 0
    physics.place(BODY, { x: 0, y: 1, z: 0 });
    store.capture(); // prev = 0, curr = 1

    store.interpolate(0);
    expect(obj.position.y).toBeCloseTo(0, 9);
    store.interpolate(1);
    expect(obj.position.y).toBeCloseTo(1, 9);
    store.interpolate(0.5);
    expect(obj.position.y).toBeCloseTo(0.5, 9);
  });

  it('gives every frame of a 120 Hz display its own pose', () => {
    // The whole point. Two rendered frames inside one fixed step must not be identical,
    // or the prop stutters at exactly half the display rate.
    const physics = fakePhysics();
    physics.place(BODY, { x: 0, y: 0, z: 0 });
    const store = new PropStore(physics);
    const obj = new THREE.Object3D();
    store.add(BODY, obj);
    store.capture();
    physics.place(BODY, { x: 0, y: 0.02, z: 0 });
    store.capture();

    store.interpolate(0.25);
    const early = obj.position.y;
    store.interpolate(0.75);
    const late = obj.position.y;
    expect(late).toBeGreaterThan(early);
    expect(late - early).toBeCloseTo(0.01, 9);
  });

  it('interpolates rotation, which is most of what a swinging beam does', () => {
    const physics = fakePhysics();
    const flat = { x: 0, y: 0, z: 0, w: 1 };
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    physics.place(BODY, { x: 0, y: 0, z: 0 }, flat);
    const store = new PropStore(physics);
    const obj = new THREE.Object3D();
    store.add(BODY, obj);
    store.capture();
    physics.place(
      BODY,
      { x: 0, y: 0, z: 0 },
      { x: turned.x, y: turned.y, z: turned.z, w: turned.w },
    );
    store.capture();

    store.interpolate(0.5);
    const half = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ').z;
    expect(half).toBeCloseTo(Math.PI / 4, 5);
  });

  it('freezes a prop whose body is gone instead of throwing mid-teardown', () => {
    // Teardown order is a lab's business. A half-torn instrument must not take the frame
    // down with it.
    const physics = fakePhysics();
    physics.place(BODY, { x: 0, y: 5, z: 0 });
    const store = new PropStore(physics);
    const obj = new THREE.Object3D();
    store.add(BODY, obj);
    store.capture();
    physics.kill(BODY);

    expect(() => {
      store.capture();
      store.interpolate(0.5);
    }).not.toThrow();
    expect(obj.position.y).toBeCloseTo(5, 9);
  });

  it('forgets props on remove and clear', () => {
    const physics = fakePhysics();
    physics.place(BODY, { x: 0, y: 0, z: 0 });
    const store = new PropStore(physics);
    store.add(BODY, new THREE.Object3D());
    expect(store.size).toBe(1);
    expect(store.objectOf(BODY)).toBeDefined();
    store.remove(BODY);
    expect(store.size).toBe(0);
    expect(store.objectOf(BODY)).toBeUndefined();

    store.add(BODY, new THREE.Object3D());
    store.clear();
    expect(store.size).toBe(0);
  });
});
