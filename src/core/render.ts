import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { config } from '../config.ts';
import { METALS } from '../data/metals.ts';
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
export function isPhoneClass(): boolean {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) <= 600;
  return coarse && small;
}

export class RenderWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  readonly #phone = isPhoneClass();
  readonly #geometryCache = new Map<number, THREE.BufferGeometry>();
  readonly #materialCache = new Map<MetalId, THREE.MeshStandardMaterial>();
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
  cubeGeometry(sideM: number): THREE.BufferGeometry {
    // Quantise the key so a fine size slider doesn't mint a geometry per pixel of travel.
    const key = Math.round(sideM * 1e5) / 1e5;
    let geo = this.#geometryCache.get(key);
    if (!geo) {
      geo = new RoundedBoxGeometry(sideM, sideM, sideM, 2, sideM * 0.03);
      this.#geometryCache.set(key, geo);
    }
    return geo;
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
    this.#geometryCache.clear();
    this.#materialCache.clear();
    this.#blobTexture?.dispose();
    this.renderer.dispose();
  }
}

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
