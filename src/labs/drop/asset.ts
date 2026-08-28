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

/**
 * One memo per TARGET, not one for the lot.
 *
 * These used to be a single Promise.all over all ten GLBs, so choosing any target
 * downloaded every target: picking the egg, 239 KB of model, pulled 4 MB including the
 * watermelon and the soda can. Each group below is exactly what one target mounts and
 * bursts into, and nothing else is fetched until something asks for it.
 *
 * Fragments are paired with their source model because fragTemplates needs its skin —
 * the block's aggregate, the plinth's marble, the melon's rind, the glass itself.
 */
let glassGroup: Promise<{
  glass: THREE.Object3D;
  pedestal: THREE.Object3D;
  glassFrags: FragChunk[];
  plinthFrags: FragChunk[];
}> | null = null;
let melonGroup: Promise<{ melon: THREE.Object3D; melonFrags: FragChunk[] }> | null = null;
let canGroup: Promise<{ can: THREE.Object3D }> | null = null;
let eggGroup: Promise<{ egg: THREE.Object3D }> | null = null;
let structureGroup: Promise<{ block: THREE.Object3D; blockFrags: FragChunk[] }> | null = null;

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
/**
 * Show exactly one named melon part in a clone of the whole scene. Extracting the
 * node would lose its wrapper transforms (the 11.4 m plinth lesson); hiding the
 * siblings keeps every ancestor matrix intact.
 */
function melonPart(scene: THREE.Object3D, keep: RegExp): THREE.Object3D {
  const c = scene.clone();
  c.traverse((o) => {
    if (o instanceof THREE.Mesh) o.visible = keep.test(o.name);
  });
  return c;
}

/**
 * One pre-fractured break piece (tools/fracture-targets.mjs, via three-pinata).
 * The tool re-origined each fragment at its centroid: `offset` places it back in
 * the intact body's frame, `half` is its bbox, `points` is a subsampled vertex
 * cloud for the CONVEX-HULL collider (cells partition the body, so hulls spawn
 * touching, never penetrating — the bbox colliders' depenetration shove was the
 * realism audit's root finding), and the visual's outer faces carry the source
 * model's own material and UVs.
 */
export interface FragChunk {
  offset: { x: number; y: number; z: number };
  half: { x: number; y: number; z: number };
  points: readonly number[];
  visual: THREE.Object3D;
}

/**
 * Turn a fragments GLB scene into templates, resolving the tool's placeholder
 * material slots: `melon_outer`-style slots take the source model's real material,
 * `*_inner` slots take the cut-face material (flesh; for glass, glass again —
 * a shard of glass is glass all the way through). `inner` is a factory because
 * the melon flesh shader needs each fragment's own centroid offset.
 */
function fragTemplates(
  scene: THREE.Object3D,
  outer: THREE.Material | null,
  inner: (node: THREE.Object3D) => THREE.Material,
): FragChunk[] {
  const frags: FragChunk[] = [];
  for (const node of scene.children) {
    const box = new THREE.Box3();
    const points: number[] = [];
    node.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.Material;
      o.material = /_inner/.test(m.name) ? inner(node) : (outer ?? inner(node));
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox!);
      // Subsample the cloud for the hull — the hull of a subset of a convex cell's
      // vertices is still (nearly) the cell, and 60-odd points keep it cheap.
      const pos = o.geometry.attributes['position'];
      if (pos) {
        const stride = Math.max(1, Math.floor(pos.count / 60));
        for (let i = 0; i < pos.count; i += stride) {
          points.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
      }
    });
    if (box.isEmpty() || points.length < 12) continue;
    frags.push({
      offset: { x: node.position.x, y: node.position.y, z: node.position.z },
      half: {
        x: Math.max(0.006, (box.max.x - box.min.x) / 2),
        y: Math.max(0.006, (box.max.y - box.min.y) / 2),
        z: Math.max(0.006, (box.max.z - box.min.z) / 2),
      },
      points,
      visual: node,
    });
  }
  return frags;
}

/**
 * Watermelon flesh, painted in MELON-ANATOMY space (user, 2026-08-25: "realistic
 * texture, and seeds in the right places"). Fragment vertices are centroid-local;
 * adding the fragment's authoring offset restores melon-local position, so the
 * shader knows how deep in the fruit every cut-face point sits: white margin at
 * the rind boundary, fibrous radial streaks through the red, and seeds only in
 * the seed band — clustered along the three locules' walls (six arms in section),
 * where a real melon keeps them.
 */
function makeFleshMaterial(offset: THREE.Vector3): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    envMapIntensity: 0.5,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uFragOffset'] = { value: offset };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uFragOffset;\nvarying vec3 vMelonPos;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMelonPos = position + uFragOffset;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vMelonPos;
float melonHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  // Melon-local frame: centre mid-fruit, long axis on z (bbox 0.32 x 0.32 x 0.42).
  vec3 mp = vMelonPos - vec3(0.0, 0.161, 0.0);
  vec3 er = mp / vec3(0.162, 0.161, 0.211);
  float rho = length(er);
  float ang = atan(er.y, er.x);
  // Red flesh with radial fibre streaks, paling slightly toward the core.
  float fibre = 0.5 + 0.5 * sin(ang * 34.0 + sin(mp.z * 47.0) * 1.7);
  float grain = melonHash(floor(vec2(ang * 40.0, mp.z * 120.0)));
  vec3 flesh = mix(vec3(0.55, 0.075, 0.10), vec3(0.70, 0.14, 0.15), fibre * 0.55 + grain * 0.2);
  flesh = mix(flesh, vec3(0.78, 0.30, 0.30), smoothstep(0.35, 0.0, rho) * 0.3);
  // The pale margin, then the rind's own green, right at the true boundary.
  vec3 c = mix(flesh, vec3(0.90, 0.91, 0.78), smoothstep(0.84, 0.94, rho));
  c = mix(c, vec3(0.45, 0.62, 0.38), smoothstep(0.955, 1.0, rho));
  // Seeds: only in the band, clustered along the three locule walls (six arms).
  float arm = abs(cos(ang * 3.0));
  float band = smoothstep(0.50, 0.56, rho) * (1.0 - smoothstep(0.78, 0.84, rho));
  vec2 cell = vec2(ang * 4.7746, mp.z * 52.0);
  vec2 cid = floor(cell);
  vec2 cf = fract(cell) - 0.5;
  float rnd = melonHash(cid);
  vec2 jit = vec2(fract(rnd * 7.13), fract(rnd * 3.71)) - 0.5;
  float d = length((cf - jit * 0.45) * vec2(1.0, 1.55));
  float seed = (1.0 - smoothstep(0.15, 0.23, d)) * band * step(0.45, rnd + arm * 0.35);
  c = mix(c, vec3(0.14, 0.09, 0.05), seed);
  diffuseColor.rgb = c;
}`,
      );
  };
  return mat;
}

/** First mesh material in a scene — the model's own skin. */
function skinOf(scene: THREE.Object3D): THREE.Material | null {
  let mat: THREE.Material | null = null;
  scene.traverse((o) => {
    if (mat === null && o instanceof THREE.Mesh && o.visible) mat = o.material as THREE.Material;
  });
  return mat;
}

/**
 * What one bundle hands back. Fields are optional because a target only ever loads its
 * own models — ask for 'egg' and the melon fields are simply absent, which the burst
 * paths already handle as "no fractured mesh available".
 */
export interface CrushAssets {
  glass?: THREE.Object3D | undefined;
  pedestal?: THREE.Object3D | undefined;
  melonFull?: THREE.Object3D | undefined;
  /**
   * The can carries its crush as MORPH TARGETS — influences [dent, flat] on its
   * meshes; the rig animates them. Mesh.clone() gives each clone its own
   * influence array, so states never leak between mounts.
   */
  can?: THREE.Object3D | undefined;
  /** The intact shell; its break pieces are authored as thin caps, not fractured. */
  egg?: THREE.Object3D | undefined;
  /** A real cinder block, base-origined — the support pair under spanning targets. */
  block?: THREE.Object3D | undefined;
  /** Structure fragments: concrete for the blocks, marble for the plinth. */
  blockFrags?: FragChunk[] | undefined;
  plinthFrags?: FragChunk[] | undefined;
  melonFrags?: FragChunk[] | undefined;
  glassFrags?: FragChunk[] | undefined;
}

let crushOverride: CrushAssets | null = null;

/**
 * Physics tests run where GLTFLoader cannot (no fetch of real GLBs), but the burst
 * REGIMES live in the fragment path — this hands the loader synthetic fragments so
 * the regime pins exercise the shipping code, not the fallback.
 */
export function __setCrushAssetsForTests(a: CrushAssets | null): void {
  crushOverride = a;
}

/** Which target's models to fetch. Each maps to exactly one group memo above. */
export type CrushBundle = 'glass' | 'melon' | 'can' | 'egg' | 'structure';

/** Broken structure shows its raw interior: grey aggregate, pale stone. */
function concreteMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.95 });
}
function marbleMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xe4e1d8, roughness: 0.6 });
}

/**
 * Fetch just the models one target needs.
 *
 * Every field is optional and only the requested bundle's are filled: a caller reads
 * back what it asked for, and the burst paths already treat an absent fragment set as
 * "no fractured mesh available" and fall back to the same physical outcome.
 */
export function loadCrushAssets(bundle: CrushBundle): Promise<CrushAssets> {
  if (crushOverride) {
    const a = crushOverride;
    const clone = (f: FragChunk[] | undefined): FragChunk[] | undefined =>
      f?.map((x) => ({ ...x, visual: x.visual.clone() }));
    // Tests hand over one synthetic bundle covering everything; serve their slice of it.
    switch (bundle) {
      case 'glass':
        return Promise.resolve({
          glass: a.glass?.clone(),
          pedestal: a.pedestal?.clone(),
          glassFrags: clone(a.glassFrags),
          plinthFrags: clone(a.plinthFrags),
        });
      case 'melon':
        return Promise.resolve({
          melonFull: a.melonFull?.clone(),
          melonFrags: clone(a.melonFrags),
        });
      case 'can':
        return Promise.resolve({ can: a.can?.clone() });
      case 'egg':
        return Promise.resolve({ egg: a.egg?.clone() });
      case 'structure':
        return Promise.resolve({ block: a.block?.clone(), blockFrags: clone(a.blockFrags) });
    }
  }

  switch (bundle) {
    case 'glass': {
      glassGroup ??= Promise.all([
        loadScene('wine-glass.glb'),
        loadScene('pedestal.glb'),
        loadScene('glass-frags.glb'),
        loadScene('pedestal-frags.glb'),
      ]).then(([glass, pedestal, glassFragScene, plinthFragScene]) => {
        const glassSkin = skinOf(glass);
        const fallback = new THREE.MeshStandardMaterial({ color: 0x9c1a26, roughness: 0.9 });
        const marble = marbleMat();
        return {
          glass,
          pedestal,
          glassFrags: fragTemplates(glassFragScene, glassSkin, () => glassSkin ?? fallback),
          plinthFrags: fragTemplates(plinthFragScene, skinOf(pedestal), () => marble),
        };
      });
      return glassGroup.then((a) => ({
        glass: a.glass.clone(),
        pedestal: a.pedestal.clone(),
        glassFrags: a.glassFrags.map((f) => ({ ...f, visual: f.visual.clone() })),
        plinthFrags: a.plinthFrags.map((f) => ({ ...f, visual: f.visual.clone() })),
      }));
    }
    case 'melon': {
      melonGroup ??= Promise.all([loadScene('watermelon.glb'), loadScene('melon-frags.glb')]).then(
        ([melon, melonFragScene]) => ({
          melon,
          melonFrags: fragTemplates(melonFragScene, skinOf(melonPart(melon, /Full/)), (node) =>
            makeFleshMaterial(node.position.clone()),
          ),
        }),
      );
      return melonGroup.then((a) => ({
        melonFull: melonPart(a.melon, /Full/),
        melonFrags: a.melonFrags.map((f) => ({ ...f, visual: f.visual.clone() })),
      }));
    }
    case 'can': {
      canGroup ??= loadScene('soda-can.glb').then((can) => ({ can }));
      return canGroup.then((a) => ({ can: a.can.clone() }));
    }
    case 'egg': {
      eggGroup ??= loadScene('egg.glb').then((egg) => ({ egg }));
      return eggGroup.then((a) => ({ egg: a.egg.clone() }));
    }
    case 'structure': {
      structureGroup ??= Promise.all([
        loadScene('cinder-block.glb'),
        loadScene('block-frags.glb'),
      ]).then(([block, blockFragScene]) => {
        const concrete = concreteMat();
        return { block, blockFrags: fragTemplates(blockFragScene, skinOf(block), () => concrete) };
      });
      return structureGroup.then((a) => ({
        block: a.block.clone(),
        blockFrags: a.blockFrags.map((f) => ({ ...f, visual: f.visual.clone() })),
      }));
    }
  }
}

/** Tests only — the app keeps the caches for the session. */
export function clearDropAssetCache(): void {
  trampoline = null;
}
