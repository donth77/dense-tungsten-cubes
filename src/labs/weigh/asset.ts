import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loads the prepared balance asset (15 §11.2).
 *
 * `public/balance.glb` is produced by `tools/prepare-balance.py` from the 11.2 MB
 * Sketchfab source: four named parts, 2,580 triangles, 129 kB. See that script for what
 * had to happen and why — in particular that the 212 static chain-link meshes are gone,
 * because the lab draws six live rope runs and a rigid chain cannot follow a simulated
 * pan.
 *
 * Cached across mode switches: a player toggling Balance / Digital Scale must not
 * re-download or re-parse it, and the GPU buffers are worth keeping too.
 */

export type BalancePartId = 'stand' | 'beam' | 'leftPan' | 'rightPan';
export type ScalePartId = 'housing' | 'platter';

export interface BalanceAsset {
  /** Each part's geometry, already posed so its origin IS the physics body's origin. */
  parts: Record<BalancePartId, THREE.Object3D>;
}

export interface ScaleAsset {
  parts: Record<ScalePartId, THREE.Object3D>;
}

let cached: Promise<BalanceAsset> | null = null;
let cachedScale: Promise<ScaleAsset> | null = null;

export function loadBalanceAsset(): Promise<BalanceAsset> {
  cached ??= new Promise<BalanceAsset>((resolve, reject) => {
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}balance.glb`,
      (gltf) => {
        const parts: Partial<Record<BalancePartId, THREE.Object3D>> = {};
        for (const child of [...gltf.scene.children]) {
          const id = child.name as BalancePartId;
          child.traverse((o) => {
            if (!(o instanceof THREE.Mesh)) return;
            o.castShadow = true;
            o.receiveShadow = true;
          });
          // Detach from the glTF scene root: each part is bound to its own body and must
          // not inherit a parent transform from anything.
          child.removeFromParent();
          parts[id] = child;
        }
        const required: BalancePartId[] = ['stand', 'beam', 'leftPan', 'rightPan'];
        const missing = required.filter((id) => !parts[id]);
        if (missing.length > 0) {
          reject(new Error(`balance.glb is missing ${missing.join(', ')}`));
          return;
        }
        resolve({ parts: parts as Record<BalancePartId, THREE.Object3D> });
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  return cached;
}

/**
 * The prepared kitchen scale — `public/scale.glb`, from `tools/prepare-scale.py`.
 *
 * Two parts, split by node name rather than by geometry: this export was authored with
 * real names, so `Scale` is the platter and everything else is the fixed housing.
 */
export function loadScaleAsset(): Promise<ScaleAsset> {
  cachedScale ??= new Promise<ScaleAsset>((resolve, reject) => {
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}scale.glb`,
      (gltf) => {
        const parts: Partial<Record<ScalePartId, THREE.Object3D>> = {};
        for (const child of [...gltf.scene.children]) {
          child.traverse((o) => {
            if (!(o instanceof THREE.Mesh)) return;
            o.castShadow = true;
            o.receiveShadow = true;
          });
          child.removeFromParent();
          parts[child.name as ScalePartId] = child;
        }
        if (!parts.housing || !parts.platter) {
          reject(new Error('scale.glb is missing housing or platter'));
          return;
        }
        resolve({ parts: parts as Record<ScalePartId, THREE.Object3D> });
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  return cachedScale;
}

/** Frees the cached assets. Tests only — the app keeps them for the session. */
export function clearBalanceAssetCache(): void {
  cached = null;
  cachedScale = null;
}
