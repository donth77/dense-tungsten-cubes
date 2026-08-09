import * as THREE from 'three';
import { config } from '../config.ts';
import { cubeMassKg } from '../data/metals.ts';
import type { BodyHandle, CubeSpec, EntityId, Transform, Vec3 } from '../types.ts';
import type { EventBus } from './events.ts';
import type { PhysicsWorld } from './physics.ts';
import type { RenderWorld } from './render.ts';

export interface Entity {
  id: EntityId;
  spec: CubeSpec;
  massKg: number;
  body: BodyHandle;
  mesh: THREE.Mesh;
  /** The soft contact blob under the cube — cheap grounding (08 §8.3). */
  blob: THREE.Mesh;
  /** Previous and current fixed-step transforms; render interpolates between them. */
  prev: Transform;
  curr: Transform;
  /** Pre-step linear velocity, for audio and the Hand's damping term. */
  lastVel: Vec3;
  heldBy: 'hand' | null;
}

/**
 * EntityStore — owns the EntityId -> Entity map and the physics/render pairing (08 §8.2).
 *
 * Nothing derived is stored: mass is computed from the spec at spawn, density comes from
 * `whaDensity()` on demand. The purity slider can therefore change what a cube weighs
 * without anything needing to be invalidated (08 §5.7).
 */
export class EntityStore {
  readonly #map = new Map<EntityId, Entity>();
  readonly #byBody = new Map<BodyHandle, EntityId>();
  #nextId: EntityId = 1;

  // Scratch objects — spawning allocations into the render loop is how a toy that runs
  // at 60 fps for ten seconds runs at 50 after a minute of GC pressure.
  readonly #vA = new THREE.Vector3();
  readonly #vB = new THREE.Vector3();
  readonly #qA = new THREE.Quaternion();
  readonly #qB = new THREE.Quaternion();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly render: RenderWorld,
    private readonly bus: EventBus,
  ) {}

  get size(): number {
    return this.#map.size;
  }
  get all(): Iterable<Entity> {
    return this.#map.values();
  }
  get(id: EntityId): Entity | undefined {
    return this.#map.get(id);
  }
  byBody(h: BodyHandle): Entity | undefined {
    const id = this.#byBody.get(h);
    return id === undefined ? undefined : this.#map.get(id);
  }

  spawn(spec: CubeSpec, at: Vec3): Entity {
    this.#enforceCap();

    const id = this.#nextId++;
    const body = this.physics.addCube(spec, at, { entityId: id });
    const massKg = cubeMassKg(spec.metal, spec.sideM, spec.purityPctW);

    const mesh = new THREE.Mesh(
      this.render.cubeGeometry(spec.sideM),
      this.render.cubeMaterial(spec.metal, spec.sideM, spec.purityPctW),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(at.x, at.y, at.z);
    mesh.userData['entityId'] = id;
    this.render.scene.add(mesh);

    const blob = this.render.contactBlob(spec.sideM);
    this.render.scene.add(blob);

    const t = this.physics.transformOf(body);
    const entity: Entity = {
      id,
      spec,
      massKg,
      body,
      mesh,
      blob,
      prev: cloneTransform(t),
      curr: cloneTransform(t),
      lastVel: { x: 0, y: 0, z: 0 },
      heldBy: null,
    };
    this.#map.set(id, entity);
    this.#byBody.set(body, id);
    this.bus.emit('spawn', { id });
    return entity;
  }

  despawn(id: EntityId): void {
    const e = this.#map.get(id);
    if (!e) return;
    this.physics.remove(e.body);
    this.render.scene.remove(e.mesh);
    this.render.scene.remove(e.blob);
    // The cube's material is a shared per-metal cache owned by RenderWorld and must NOT
    // be disposed here. Its geometry IS refcounted, so hand the reference back.
    this.render.releaseCubeGeometry(e.spec.sideM);
    e.blob.geometry.dispose();
    (e.blob.material as THREE.Material).dispose();
    this.#byBody.delete(e.body);
    this.#map.delete(id);
    this.bus.emit('despawn', { id });
  }

  /** Purity edits mutate in place — the body keeps its pose, velocity, contacts and grab. */
  setPurity(id: EntityId, purityPctW: number, densityKgM3: number): void {
    const e = this.#map.get(id);
    if (!e || e.spec.metal !== 'W') return;
    e.spec = { ...e.spec, purityPctW };
    this.physics.setDensity(e.body, densityKgM3);
    e.massKg = this.physics.massOf(e.body);
    // The engraved face carries the ASTM grade, so it changes with the slider too.
    e.mesh.material = this.render.cubeMaterial(e.spec.metal, e.spec.sideM, purityPctW);
  }

  #enforceCap(): void {
    if (this.#map.size < config.limits.maxCubes) return;
    // Oldest un-held first: yanking the cube out of the player's hand to make room is
    // the one eviction that would feel like a bug.
    for (const e of this.#map.values()) {
      if (e.heldBy === null) {
        this.despawn(e.id);
        return;
      }
    }
  }

  /**
   * Step 5 of the fixedStep contract: curr -> prev, then read the new state from physics.
   * Velocities are latched here too — they feed impact energy and the Hand's damping.
   */
  captureTransforms(): void {
    for (const e of this.#map.values()) {
      const t = e.curr;
      e.prev.p.x = t.p.x;
      e.prev.p.y = t.p.y;
      e.prev.p.z = t.p.z;
      e.prev.q.x = t.q.x;
      e.prev.q.y = t.q.y;
      e.prev.q.z = t.q.z;
      e.prev.q.w = t.q.w;

      // Written into the entity's own objects. The obvious version — assigning the
      // result of transformOf()/velocityOf() — mints four objects per entity per step,
      // which at 60 bodies and 60 Hz is ~14k allocations a second of pure garbage.
      // Measured before this change: ~90 KB/s of heap growth with 30 *resting* cubes.
      this.physics.readTransformInto(e.body, e.curr.p, e.curr.q);
      this.physics.readVelocityInto(e.body, e.lastVel);
    }
  }

  /** Render-side only: never write interpolated values back into physics. */
  interpolate(alpha: number): void {
    for (const e of this.#map.values()) {
      this.#vA.set(e.prev.p.x, e.prev.p.y, e.prev.p.z);
      this.#vB.set(e.curr.p.x, e.curr.p.y, e.curr.p.z);
      e.mesh.position.lerpVectors(this.#vA, this.#vB, alpha);

      this.#qA.set(e.prev.q.x, e.prev.q.y, e.prev.q.z, e.prev.q.w);
      this.#qB.set(e.curr.q.x, e.curr.q.y, e.curr.q.z, e.curr.q.w);
      e.mesh.quaternion.slerpQuaternions(this.#qA, this.#qB, alpha);

      // The blob tracks the cube's ground shadow: directly below, fading with height.
      const y = e.mesh.position.y;
      const side = e.spec.sideM;
      e.blob.position.set(e.mesh.position.x, 0.0015, e.mesh.position.z);
      const lift = Math.max(0, y - side / 2);
      const fade = Math.max(0, 1 - lift / (side * 3));
      const mat = e.blob.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 * fade;
      e.blob.visible = fade > 0.01;
      e.blob.scale.setScalar(side * (1.3 + lift * 1.5));
    }
  }

  /** Re-skins every live cube — used when the engraving toggle flips. */
  refreshMaterials(): void {
    for (const e of this.#map.values()) {
      e.mesh.material = this.render.cubeMaterial(e.spec.metal, e.spec.sideM, e.spec.purityPctW);
    }
  }

  clear(): void {
    for (const id of [...this.#map.keys()]) this.despawn(id);
  }
}

function cloneTransform(t: Transform): Transform {
  return { p: { ...t.p }, q: { ...t.q } };
}
