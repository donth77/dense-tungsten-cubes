import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The Drop Tower's prepared assets (16 §14.1) — same discipline as the Weigh
 * Station's: prepared offline into small named-part GLBs, cached for the session,
 * every part re-origined so binding it to its anchor is an identity.
 *
 *   public/trampoline.glb  tools/prepare-trampoline.py  frame + mat (mat follows the pad)
 *
 * The hook and ground-winch GLBs retired with the carriage redesign (17 §4.3); their
 * prep scripts remain in tools/ as working history.
 */

export interface TrampolineAsset {
  frame: THREE.Object3D;
  mat: THREE.Object3D;
}

let trampoline: Promise<TrampolineAsset> | null = null;

function loadParts(
  file: string,
  required: readonly string[],
): Promise<Record<string, THREE.Object3D>> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}${file}`,
      (gltf) => {
        const parts: Record<string, THREE.Object3D> = {};
        for (const child of [...gltf.scene.children]) {
          child.traverse((o) => {
            if (!(o instanceof THREE.Mesh)) return;
            o.castShadow = true;
            o.receiveShadow = true;
          });
          child.removeFromParent();
          parts[child.name] = child;
        }
        const missing = required.filter((id) => !parts[id]);
        if (missing.length > 0) reject(new Error(`${file} is missing ${missing.join(', ')}`));
        else resolve(parts);
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

export function loadTrampolineAsset(): Promise<TrampolineAsset> {
  trampoline ??= loadParts('trampoline.glb', ['frame', 'mat']).then((p) => ({
    frame: p['frame']!,
    mat: p['mat']!,
  }));
  /*
   * Hand out CLONES. The cache used to return the actual scene nodes: the first
   * trampoline mount adopted them, the teardown orphaned them, and every LATER
   * mount re-adopted whatever was left - by the third visit the mat floated alone
   * with no frame under it (user-caught, 2026-08-25). Geometry and materials stay
   * shared; floors only disposes what it created itself.
   */
  return trampoline.then((a) => ({ frame: a.frame.clone(), mat: a.mat.clone() }));
}

let crush: Promise<{ glass: THREE.Object3D; pedestal: THREE.Object3D }> | null = null;

function loadScene(file: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}${file}`,
      (gltf) => {
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        resolve(gltf.scene);
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/**
 * The crush targets' real models (18 §5.3; assets-lib is the curated source
 * library). CLONES per call — the trampoline's cannibalised-cache lesson.
 */
export function loadCrushAssets(): Promise<{ glass: THREE.Object3D; pedestal: THREE.Object3D }> {
  crush ??= Promise.all([loadScene('wine-glass.glb'), loadScene('pedestal.glb')]).then(
    ([glass, pedestal]) => ({ glass, pedestal }),
  );
  return crush.then((a) => ({ glass: a.glass.clone(), pedestal: a.pedestal.clone() }));
}

/** Tests only — the app keeps the caches for the session. */
export function clearDropAssetCache(): void {
  trampoline = null;
}
