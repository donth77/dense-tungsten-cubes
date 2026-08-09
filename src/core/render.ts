import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { config } from '../config.ts';
import { astmClassLabel, METALS } from '../data/metals.ts';
import { makeEngraving } from './engraving.ts';
import type { EngravedMaps } from './engraving.ts';
import { SURFACES } from '../data/surfaces.ts';
import type { MetalId, SurfaceId } from '../types.ts';

/**
 * RenderWorld — renderer, scene, lights, environment, resize, quality (08 §8.3).
 *
 * Owns everything about *how it looks*; owns nothing about what exists. The camera
 * object lives here but its transform belongs to `interaction/camera.ts`.
 */

/** physicallybased.info values are linear-sRGB, and data/ can't import three (08 §5.2). */
function linearColor([r, g, b]: readonly [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

/**
 * A phone, for quality purposes: a coarse pointer on a small viewport. Deliberately
 * not user-agent sniffing — a touchscreen laptop should get desktop quality, and a
 * 3× DPR phone should not render 4× the pixels of a 1.5× one for no visible gain
 * at arm's length (12 §5).
 */
/**
 * Below this the engraved lettering is sub-pixel at any camera distance we allow.
 * 0.25" cubes get the plain material — cheaper, and it looks better than mush.
 */
const ENGRAVING_MIN_SIDE_M = 0.9 * 0.0254;

export function isPhoneClass(): boolean {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) <= 600;
  return coarse && small;
}

/**
 * The selection marker sits this much outside the cube's own faces. Enough to clear the
 * surface (and the 3 % chamfer) without reading as a separate floating object.
 */
const SELECTION_INFLATE = 1.06;
/** Bracket arm length, as a fraction of the side. Corners only — never a full wireframe. */
const SELECTION_ARM = 0.24;
/** `--acc` from tokens.css. Hardcoded like `--bg` above: data/ and core/ can't read CSS. */
const SELECTION_COLOR = 0xff6b1f;
/** m/s. Below this a cube is resting (Rapier's own sleep threshold territory). */
const SELECTION_FADE_START = 0.02;
/** m/s. Anything moving this fast is doing the thing you are meant to be watching. */
const SELECTION_FADE_END = 0.35;

/**
 * How strongly the selection brackets draw at a given speed: full at rest, gone in
 * motion.
 *
 * The impact is the product. A bright accent-orange cage wrapped around a cube at the
 * exact moment it lands competes with the one event the whole toy exists to show, so
 * the marker gets out of the way and comes back when there is something to label.
 *
 * A continuous ramp rather than a still/moving switch, deliberately. A binary rule needs
 * hysteresis and a timer to survive contact with reality — a cube settling onto a stack,
 * or rocking on one edge, crosses any fixed threshold repeatedly and would strobe. Here
 * that same jitter produces a few percent of opacity wobble, which nobody can see.
 *
 * A 2" cube dropped from the tray lands at ~2.8 m/s, so the brackets are long gone
 * before contact.
 */
export function selectionOpacityForSpeed(speedMps: number): number {
  const t = (speedMps - SELECTION_FADE_START) / (SELECTION_FADE_END - SELECTION_FADE_START);
  return 1 - Math.min(1, Math.max(0, t));
}

export class RenderWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Corner brackets around the selected cube, positioned by `EntityStore.interpolate()`.
   *
   * It has to be a separate object rather than a material tweak: `cubeMaterial()` returns
   * a **shared per-metal cache**, so setting `emissive` on the selected cube's material
   * would light up every other cube of that metal at the same time.
   *
   * Brackets rather than a full wireframe or an outline shell, because the cube is
   * chamfered and orbited freely — corners are the one feature that stays readable from
   * every angle and at every size from 0.25" to 15".
   */
  readonly selection: THREE.LineSegments;

  readonly #phone = isPhoneClass();
  readonly #geometryCache = new Map<number, THREE.BufferGeometry>();
  readonly #geometryRefs = new Map<number, number>();
  readonly #materialCache = new Map<MetalId, THREE.MeshStandardMaterial>();
  /** Engraved variants, keyed by metal AND grade — tungsten's line tracks purity. */
  readonly #engravedCache = new Map<string, THREE.MeshStandardMaterial>();
  readonly #engravedMaps = new Map<string, EngravedMaps>();
  #engravingEnabled = true;
  #blobTexture: THREE.Texture | null = null;
  #resolutionScale = 1;
  #disposers: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // The stage always fills the frame; nothing behind it needs to show through.
      alpha: false,
    });
    // AgX is deliberately flat — it holds metal highlights instead of clipping them
    // to white, which is the whole point when the subject is five shiny cubes (04).
    this.renderer.toneMapping = THREE.AgXToneMapping;
    // Tuned down from 08 §8.3's 1.15 after seeing it: AgX + a hot key light + IBL blew
    // the concrete to near-white and flattened the cube. 0.95 puts the floor back in
    // "dim test chamber" territory and lets the metal carry the highlights.
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    // 08 §8.3 specified PCFSoftShadowMap; three r185 deprecates it and silently falls
    // back to PCFShadowMap anyway. Asking for it directly, so the console stays clean.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f151c);

    this.camera = new THREE.PerspectiveCamera(config.camera.fovDeg, 1, 0.05, 100);

    this.#buildEnvironment();
    this.#buildLights();
    this.#buildStage();
    this.selection = makeSelectionMarker();
    this.scene.add(this.selection);
    this.#disposers.push(() => {
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
    });
    this.resize();
  }

  // ---- environment & lighting ------------------------------------------------

  /** RoomEnvironment → PMREM → scene.environment. Zero downloads (08 §8.3). */
  #buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    this.scene.environment = envRT.texture;
    /*
     * RoomEnvironment is a bright white studio box, and at `metalness: 1.0` a cube's
     * appearance is ENTIRELY its environment reflection — so env intensity is really
     * "how white is the tungsten". Measured at M0: 0.85 rendered W95 as a near-white
     * cube with no material identity at all. 0.18 (with the key light raised to carry
     * the form instead) is where the five metals separate and tungsten reads dark.
     */
    this.scene.environmentIntensity = 0.18;
    room.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    pmrem.dispose();
    this.#disposers.push(() => envRT.dispose());
  }

  #buildLights(): void {
    // One key light. The IBL does the ambient work, so this exists mostly to cast the
    // shadow that grounds a cube — and a grounded cube is half of "this thing is heavy".
    // Carries almost all the form now that the IBL is turned down to 0.18 (see above).
    const key = new THREE.DirectionalLight(0xfff2e6, 3.2);
    key.position.set(2.2, 3.4, 1.8);
    key.castShadow = true;
    const map = this.#phone ? config.quality.shadowMapPhone : config.quality.shadowMapDesktop;
    key.shadow.mapSize.set(map, map);

    // Cover the play area, NOT the whole 6 m floor. Cubes live within ~1.2 m of centre,
    // and spanning 7 m instead spends 2048 texels on empty concrete: a 2" cube's shadow
    // lands in ~15 texels and reads as mush. This is a 4.6x texel-density win for free.
    const half = config.stage.shadowHalfSizeM;
    const cam = key.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 0.1;
    cam.far = 14;
    cam.updateProjectionMatrix();
    // Peter-panning vs acne: normalBias handles the thin-geometry case, and a small
    // negative bias keeps a resting cube's contact shadow touching the floor.
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.018;
    this.scene.add(key);

    /*
     * Rim light — the fix for "the cube and the floor are the same grey".
     *
     * Measured at M0: a tungsten cube's vertical faces sat at contrast 1.06 against the
     * floor, i.e. the silhouette was carried entirely by the contact shadow. Darkening
     * the floor does NOT fix that, because at `metalness: 1.0` the cube's faces are
     * mostly a reflection OF the environment — darken the ground and the cube darkens
     * with it, and the two chase each other down.
     *
     * A LOW, grazing light from opposite the key does fix it, geometrically: the floor
     * normal is (0,1,0), so at this elevation it receives N·L ≈ 0.17, while a vertical
     * cube face receives ≈ 0.75. That is a 4x bias toward exactly the surfaces that
     * needed separating — and rim highlights on the chamfers are also what sells an
     * object as metal in the first place.
     */
    const rim = new THREE.DirectionalLight(0xa8c8e8, 1.9);
    rim.position.set(-2.6, 0.62, -2.2);
    this.scene.add(rim);
  }

  #buildStage(): void {
    const s = SURFACES.concrete;
    const size = config.stage.floorHalfSizeM * 2;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        color: linearColor(s.baseColorLinear),
        roughness: s.roughness,
        metalness: s.metalness,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.scene.add(floor);
    this.#disposers.push(() => {
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
    });
  }

  // ---- factories used by EntityStore -----------------------------------------

  /**
   * One shared geometry per size. The chamfer radius is ~3 % of the side — the machined
   * edge the real product has, and the thing that makes a render read as metal stock
   * rather than a programmer's cube.
   */
  /**
   * Acquire the shared geometry for a cube of this size. **Every call must be paired
   * with `releaseCubeGeometry(sideM)`** — see below.
   *
   * Quantised to 0.1 mm, which is finer than anything visible at any camera distance we
   * allow. The original 0.01 mm key allowed 37,465 distinct geometries across the
   * 0.25–15" slider range and nothing ever evicted them, so one slow drag of the size
   * slider would mint hundreds of RoundedBoxGeometry and leak every one.
   *
   * Refcounted rather than LRU-evicted: a geometry is shared by every cube of that size,
   * and disposing one that a live mesh still references leaves an un-renderable mesh.
   * Recency tells you nothing about whether something is still on screen.
   */
  cubeGeometry(sideM: number): THREE.BufferGeometry {
    const key = Math.round(sideM * 1e4);
    let geo = this.#geometryCache.get(key);
    if (!geo) {
      geo = new RoundedBoxGeometry(sideM, sideM, sideM, 2, sideM * 0.03);
      this.#geometryCache.set(key, geo);
    }
    this.#geometryRefs.set(key, (this.#geometryRefs.get(key) ?? 0) + 1);
    return geo;
  }

  /** Drops a reference; frees the GPU buffers once the last cube of that size is gone. */
  releaseCubeGeometry(sideM: number): void {
    const key = Math.round(sideM * 1e4);
    const refs = (this.#geometryRefs.get(key) ?? 0) - 1;
    if (refs > 0) {
      this.#geometryRefs.set(key, refs);
      return;
    }
    this.#geometryRefs.delete(key);
    this.#geometryCache.get(key)?.dispose();
    this.#geometryCache.delete(key);
  }

  metalMaterial(metal: MetalId): THREE.MeshStandardMaterial {
    let mat = this.#materialCache.get(metal);
    if (!mat) {
      const spec = METALS[metal];
      mat = new THREE.MeshStandardMaterial({
        color: linearColor(spec.baseColorLinear),
        metalness: 1.0,
        roughness: spec.roughness,
      });
      this.#materialCache.set(metal, mat);
    }
    return mat;
  }

  setEngravingEnabled(on: boolean): void {
    this.#engravingEnabled = on;
  }
  get engravingEnabled(): boolean {
    return this.#engravingEnabled;
  }

  /**
   * The material a cube should actually use: engraved when the setting is on and the
   * cube is big enough to read, plain otherwise.
   *
   * Below ~1" the lettering is sub-pixel at any camera distance we allow, so it costs a
   * texture fetch to render mush. Falling back to the plain material there is both
   * cheaper and better-looking.
   */
  cubeMaterial(metal: MetalId, sideM: number, purityPctW?: number): THREE.MeshStandardMaterial {
    if (!this.#engravingEnabled || sideM < ENGRAVING_MIN_SIDE_M) return this.metalMaterial(metal);

    // Tungsten carries "ASTM B777 CL n", which moves with the purity slider (02 §11) —
    // so the grade is part of the cache key, not just the metal.
    const grade = metal === 'W' ? astmClassLabel(purityPctW ?? 95) : '';
    const key = `${metal}|${grade}`;
    let mat = this.#engravedCache.get(key);
    if (mat) return mat;

    const spec = METALS[metal];
    const maps = makeEngraving({
      metal,
      ...(metal === 'W' ? { astmLine: `ASTM B777 ${grade.replace('Class', 'CL')}` } : {}),
    });
    mat = new THREE.MeshStandardMaterial({
      color: linearColor(spec.baseColorLinear),
      metalness: 1.0,
      roughness: spec.roughness,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
    });
    mat.normalScale.set(1, 1);
    this.#engravedMaps.set(key, maps);
    this.#engravedCache.set(key, mat);
    return mat;
  }

  surfaceMaterial(surface: SurfaceId): THREE.MeshStandardMaterial {
    const s = SURFACES[surface];
    return new THREE.MeshStandardMaterial({
      color: linearColor(s.baseColorLinear),
      roughness: s.roughness,
      metalness: s.metalness,
    });
  }

  /**
   * The per-cube contact blob: a soft radial sprite that darkens the floor right under
   * a cube. Cheap grounding that reads better than the shadow map alone on mobile,
   * where the map is 1024 and its penumbra is coarse (08 §8.3).
   */
  contactBlob(sideM: number): THREE.Mesh {
    this.#blobTexture ??= makeBlobTexture();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.#blobTexture,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        color: 0x000000,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(sideM * 1.3);
    mesh.renderOrder = -1;
    return mesh;
  }

  // ---- frame & viewport -------------------------------------------------------

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Sizing is driven by the *canvas element's* box, not `window.innerWidth`: on iOS the
   * two disagree while the toolbar animates, and `visualViewport` is what actually tracks
   * it (12 §2). `setSize(…, false)` leaves the CSS size alone so `100dvh` stays in charge.
   */
  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;

    const cap = this.#phone ? config.limits.pixelRatioMaxPhone : config.limits.pixelRatioMax;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap) * this.#resolutionScale);
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Dynamic resolution (12 §5). Physics is untouched — the fixed step never scales. */
  setResolutionScale(scale: number): void {
    const clamped = Math.min(1, Math.max(config.quality.resolutionScaleFloor, scale));
    if (Math.abs(clamped - this.#resolutionScale) < 0.001) return;
    this.#resolutionScale = clamped;
    this.resize();
  }

  get resolutionScale(): number {
    return this.#resolutionScale;
  }
  get isPhone(): boolean {
    return this.#phone;
  }

  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers = [];
    for (const g of this.#geometryCache.values()) g.dispose();
    for (const m of this.#materialCache.values()) m.dispose();
    for (const m of this.#engravedCache.values()) m.dispose();
    for (const m of this.#engravedMaps.values()) m.dispose();
    this.#engravedCache.clear();
    this.#engravedMaps.clear();
    this.#geometryCache.clear();
    this.#materialCache.clear();
    this.#blobTexture?.dispose();
    this.renderer.dispose();
  }
}

/**
 * 24 short segments — three arms at each of the 8 corners of a unit cube, so the whole
 * thing scales to any cube by setting `scale`. 48 vertices, one draw call.
 *
 * `toneMapped: false` matters: this is UI drawn into a 3D scene, and AgX would otherwise
 * pull the accent orange toward the same desaturated range as everything else on stage —
 * which is exactly the separation the marker exists to provide.
 *
 * `depthTest` stays ON. An always-on-top marker is easier to find in a pile, but it
 * shows through cubes stacked in front of it, and a selection ring that floats over
 * solid metal breaks the "these are real objects" contract the rest of the toy keeps.
 */
function makeSelectionMarker(): THREE.LineSegments {
  const h = 0.5;
  const inner = h - SELECTION_ARM;
  const pts: number[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const [cx, cy, cz] = [sx * h, sy * h, sz * h];
        pts.push(cx, cy, cz, sx * inner, cy, cz);
        pts.push(cx, cy, cz, cx, sy * inner, cz);
        pts.push(cx, cy, cz, cx, cy, sz * inner);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mesh = new THREE.LineSegments(
    geo,
    // transparent, so the marker can fade out while its cube is in motion — see
    // selectionOpacityForSpeed().
    new THREE.LineBasicMaterial({ color: SELECTION_COLOR, toneMapped: false, transparent: true }),
  );
  mesh.visible = false;
  mesh.renderOrder = 2;
  return mesh;
}

/** How far outside the cube the marker sits — `EntityStore` applies it to the scale. */
export { SELECTION_INFLATE };

/** 64×64 radial gradient, generated rather than shipped (08 §12: ~2 kB saved is ~2 kB). */
function makeBlobTexture(): THREE.Texture {
  const N = 64;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
