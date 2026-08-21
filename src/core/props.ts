import * as THREE from 'three';
import type { PhysicsWorld } from './physics.ts';
import type { BodyHandle, Quat, Transform, Vec3 } from '../types.ts';

/**
 * PropStore — render interpolation for a lab's own dynamic bodies (15 §8.3).
 *
 * `EntityStore` stays about the player's cubes. An instrument is not a cube: it is not
 * spawnable, not selectable, not culled, not counted against `maxCubes`, and it belongs
 * to whichever lab built it. But it needs the one thing EntityStore does for cubes —
 * interpolation — because the simulation runs at a fixed 60 Hz and displays do not.
 *
 * Skipping this does not look like a small imperfection. Drawn straight from the latest
 * fixed-step pose on a 120 Hz display, every second frame repeats: a swinging balance
 * beam and its hanging pans judder while the cubes sitting *in those pans* glide, and the
 * two are on screen together. The instrument would read as the fake thing in the scene.
 *
 * Same contract as EntityStore: `capture()` runs once per fixed step AFTER the solver,
 * `interpolate(alpha)` runs once per rendered frame, and interpolated values are never
 * written back into physics.
 */
export class PropStore {
  readonly #props = new Map<BodyHandle, Prop>();

  // Scratch. A store that allocates per prop per frame undoes the reason it exists.
  readonly #vA = new THREE.Vector3();
  readonly #vB = new THREE.Vector3();
  readonly #qA = new THREE.Quaternion();
  readonly #qB = new THREE.Quaternion();

  constructor(private readonly physics: PhysicsWorld) {}

  get size(): number {
    return this.#props.size;
  }

  /**
   * Binds an Object3D to a body. The object jumps to the body's current pose immediately,
   * so a prop is never visible for one frame at the origin before its first interpolation.
   */
  add(body: BodyHandle, object: THREE.Object3D): void {
    const t = this.physics.transformOf(body);
    this.#props.set(body, {
      object,
      prev: cloneTransform(t),
      curr: cloneTransform(t),
    });
    object.position.set(t.p.x, t.p.y, t.p.z);
    object.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
  }

  remove(body: BodyHandle): void {
    this.#props.delete(body);
  }

  /** Step 5's counterpart for instruments: curr -> prev, then read the new pose. */
  capture(): void {
    for (const [body, p] of this.#props) {
      copyTransform(p.curr, p.prev);
      // A prop whose body has already been removed keeps its last pose rather than
      // throwing: teardown order is a lab's business, and a half-torn instrument should
      // not take the frame down with it.
      if (!this.physics.hasBody(body)) continue;
      this.physics.readTransformInto(body, p.curr.p, p.curr.q);
    }
  }

  interpolate(alpha: number): void {
    for (const p of this.#props.values()) {
      this.#vA.set(p.prev.p.x, p.prev.p.y, p.prev.p.z);
      this.#vB.set(p.curr.p.x, p.curr.p.y, p.curr.p.z);
      p.object.position.lerpVectors(this.#vA, this.#vB, alpha);

      this.#qA.set(p.prev.q.x, p.prev.q.y, p.prev.q.z, p.prev.q.w);
      this.#qB.set(p.curr.q.x, p.curr.q.y, p.curr.q.z, p.curr.q.w);
      p.object.quaternion.slerpQuaternions(this.#qA, this.#qB, alpha);
    }
  }

  /**
   * The interpolated pose of one prop, for anything that has to be positioned FROM a
   * prop rather than as one — the chain runs spanning a beam hook and a pan rim, say.
   */
  objectOf(body: BodyHandle): THREE.Object3D | undefined {
    return this.#props.get(body)?.object;
  }

  /** Forgets every prop. Does NOT dispose geometry — the lab that made it owns that. */
  clear(): void {
    this.#props.clear();
  }
}

interface Prop {
  object: THREE.Object3D;
  prev: Transform;
  curr: Transform;
}

function cloneTransform(t: Transform): Transform {
  return { p: { ...t.p }, q: { ...t.q } };
}

function copyTransform(from: Transform, to: Transform): void {
  const p: Vec3 = to.p;
  const q: Quat = to.q;
  p.x = from.p.x;
  p.y = from.p.y;
  p.z = from.p.z;
  q.x = from.q.x;
  q.y = from.q.y;
  q.z = from.q.z;
  q.w = from.q.w;
}
