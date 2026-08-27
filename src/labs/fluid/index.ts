import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PropStore } from '../../core/props.ts';
import { RippleField } from '../../fx/ripple.ts';
import { config } from '../../config.ts';
import {
  SurfaceWaves,
  fluidForces,
  makeFluidForces,
  stepVelocityQuantum,
} from '../../core/fluid.ts';
import { FLUIDS, TANK_FLUID_IDS, TANK_VOICES, floatFraction } from '../../data/fluids.ts';
import { M_PER_IN } from '../../data/format.ts';
import { densityOf } from '../../data/metals.ts';
import type { Lab, LabContext, LabPanelHandle, LabPanelModel, PanelFact } from '../lab.ts';
import type { BodyHandle, EntityId, FluidId, MetalId, Vec3 } from '../../types.ts';

/**
 * The Fluid Tank (19) — buoyancy, and the one place in this toy where gold and tungsten
 * come apart.
 *
 * The force model lives in `core/fluid.ts` and was validated in F0 against numbers 02 §6
 * published before any of it existed. This file is the instrument around it: the tank,
 * the fluid, the panel, and the rest-snap that F0 handed forward (19 §2.4).
 */

/** Interior, in metres. Depth is set by 19 §2.2: below ~0.40 m the Au/W finish is a tie. */
const IN_W = 0.8;
const IN_H = 0.55;
const IN_D = 0.4;
const WALL = 0.01;
/** The aquarium frame — what actually makes a glass box READ as a glass box. */
const RIM = 0.016;
/** Surface height above the tank floor — headroom so a splash has somewhere to go. */
const FILL_H = 0.46;
/*
 * The tank's interior floor sits a few millimetres ABOVE the stage floor, and that gap
 * is load-bearing rather than cosmetic.
 *
 * At 0 the stage floor, the glass shell's bottom face and the liquid body's bottom face
 * were all exactly coplanar. Coplanar polygons have no depth between them, so which one
 * wins is decided by floating-point noise in the depth buffer — and that decision
 * changes as the camera moves, which is z-fighting: the bottom of the tank flickering
 * on movement. Nothing about the surface simulation was involved.
 *
 * 6 mm is 0.75 % of the tank's width, invisible against the frame's bottom rail, and far
 * more depth than the depth buffer's precision at this range needs to stay decisive.
 */
const FLOOR_Y = 0.006;
const SURFACE_Y = FLOOR_Y + FILL_H;

const LINEUP: readonly MetalId[] = ['W', 'Au', 'Cu', 'Fe', 'Ti', 'Al'];
const LINEUP_SIDE_IN = 2;

/**
 * The duck (19 §3) — the intuition anchor.
 *
 * Everyone already knows what a duck does in water, so it calibrates the whole tank for
 * free: whatever the cubes do, you can read it against something you have seen float
 * since you were three. In mercury it sits absurdly high, which is the same lesson the
 * metals teach, told by an object nobody has to think about.
 *
 * ~50 g over its bounding box is roughly 120 kg/m3 — a hollow rubber duck. It floats a
 * few per cent submerged in mercury and about an eighth submerged in water, and it does
 * that through exactly the same `fluidForces` call the cubes use. It is not scripted to
 * float; it floats because it is light.
 */
const DUCK_LEN_M = 0.085;
const DUCK_H_M = 0.074;
const DUCK_W_M = 0.066;
const DUCK_MASS_KG = 0.05;
/** Mass over the bounding box — what the buoyancy model actually sees. */
const DUCK_DENSITY = DUCK_MASS_KG / (DUCK_LEN_M * DUCK_H_M * DUCK_W_M);

/** Where the duck starts and where RESET puts it back — the far corner (19 §3). */
function duckStart(): Vec3 {
  return {
    x: -IN_W / 2 + DUCK_LEN_M,
    y: SURFACE_Y + DUCK_H_M,
    z: -IN_D / 2 + DUCK_W_M * 1.6,
  };
}

/**
 * How each fluid is rendered.
 *
 * Two different material regimes, because two different physical things:
 *
 *   - A TRANSPARENT liquid is done with `transmission`, not `opacity`. In three.js those
 *     are separate mechanisms and mixing them renders muddy — transmission wants
 *     `opacity: 1` and `transparent: false`, and gets its depth cue from
 *     `attenuationColor`/`attenuationDistance`, which is what makes a deep tank read
 *     deeper than a shallow one for free.
 *   - MERCURY is not transparent at all. It is a mirror, so it is an opaque metal with
 *     its environment reflection turned up: the scene's `environmentIntensity` is 0.18
 *     by design (08 §8.3 keeps tungsten a dark warm grey), and at that level a
 *     `metalness: 1` liquid renders as a flat grey box — which is exactly how the first
 *     screenshot of this lab came out.
 */
interface FluidLook {
  color: number;
  metal: number;
  rough: number;
  transmission: number;
  /** 1 = opaque (mercury). Below that the body is translucent and you see cubes in it. */
  bodyOpacity: number;
  /**
   * Beer-Lambert extinction per metre, per channel — how fast the liquid eats light with
   * DEPTH. This is what makes a tank of something read as a deep transparent medium
   * rather than as a slab of coloured plastic: near the surface you get the liquid's
   * thin-layer colour, and further down it goes to near-black.
   */
  absorb: [number, number, number];
  ior?: number;
  envIntensity: number;
  /** Surface (`Water` addon) — reflection tint, ripple strength and ripple scale. */
  surfaceColor: number;
  /** A transparent liquid must let its own depth through; mercury must not. */
  surfaceAlpha: number;
  surfaceEnv: number;
  /** Heightfield: vertical scale (m), normal strength, and how fast waves die. */
  rippleAmp: number;
  rippleNormal: number;
  rippleDamping: number;
  rippleSettle: number;
  /** Metres of surface pushed down per m/s of entry speed. */
  dropStrength: number;
  /** Physics-side wave amplitude (m) a full-energy entry puts into the surface. */
  waveAmp: number;
  /** How hard a submerged body dents the surface (the moveSphere scale). */
  displaceScale: number;
  /** Entry splash: particle look and the voice that goes with it. */
  splashColor: number;
  splashCount: number;
  splashLifeS: number;
  splashVMin: number;
  splashVMax: number;
  splashUp: number;
  dropletSizeM: number;
}

const LOOK: Readonly<Record<FluidId, FluidLook>> = {
  water: {
    color: 0x2d86b4,
    metal: 0,
    rough: 0.05,
    transmission: 0,
    bodyOpacity: 0.42,
    /*
     * Real water is almost colourless at this scale — its blue-green only accumulates
     * over metres — so honest extinction would render a 46 cm tank clear and the lab
     * would not read as holding a liquid at all. These are water's absorption ratios
     * (red first, blue last) pushed up until the tank reads. Stylised, deliberately.
     */
    absorb: [2.2, 0.9, 0.5],
    ior: 1.33,
    envIntensity: 1,
    surfaceColor: 0x5aa8cc,
    surfaceAlpha: 0.6,
    surfaceEnv: 3.2,
    rippleAmp: 0.06,
    rippleNormal: 9,
    rippleDamping: 0.978,
    rippleSettle: 0.992,
    dropStrength: 0.3,
    waveAmp: 0.02,
    displaceScale: 0.09,
    splashColor: 0xbfe4f2,
    splashCount: 34,
    splashLifeS: 0.38,
    splashVMin: 0.5,
    splashVMax: 1.3,
    splashUp: 0.93,
    dropletSizeM: 0.012,
  },
  seawater: {
    color: 0x1d8b95,
    metal: 0,
    rough: 0.06,
    transmission: 0,
    bodyOpacity: 0.46,
    absorb: [2.6, 1.0, 0.7],
    ior: 1.34,
    envIntensity: 1,
    surfaceColor: 0x3d9aa2,
    surfaceAlpha: 0.6,
    surfaceEnv: 3.2,
    rippleAmp: 0.06,
    rippleNormal: 9,
    rippleDamping: 0.978,
    rippleSettle: 0.992,
    dropStrength: 0.3,
    waveAmp: 0.02,
    displaceScale: 0.09,
    splashColor: 0xb6e0dd,
    splashCount: 34,
    splashLifeS: 0.38,
    splashVMin: 0.5,
    splashVMax: 1.3,
    splashUp: 0.93,
    dropletSizeM: 0.012,
  },
  glycerin: {
    color: 0xa89a52,
    metal: 0,
    rough: 0.1,
    transmission: 0,
    bodyOpacity: 0.5,
    absorb: [1.6, 2.2, 5.0],
    ior: 1.47,
    envIntensity: 1,
    surfaceColor: 0xb0a75e,
    surfaceAlpha: 0.72,
    surfaceEnv: 1.8,
    rippleAmp: 0.035,
    rippleNormal: 7,
    rippleDamping: 0.955,
    rippleSettle: 0.985,
    dropStrength: 0.1,
    waveAmp: 0.012,
    displaceScale: 0.06,
    splashColor: 0xd8cf9a,
    splashCount: 14,
    splashLifeS: 0.8,
    splashVMin: 0.2,
    splashVMax: 0.7,
    splashUp: 0.7,
    dropletSizeM: 0.016,
  },
  /*
   * Honey (19 §2.8). There is no single "honey colour" — the Pfund scale runs from
   * water-white acacia through amber to near-black buckwheat — so this is a mid amber,
   * the tone most people picture.
   *
   * What makes it read as honey rather than as orange plastic is not the hue, it is the
   * DEPTH FALL-OFF and the gloss. Absorption is strong and strongly blue-biased, so the
   * top centimetres glow amber and 46 cm down goes to a deep red-brown that you cannot
   * see through — which is what a tank of honey actually looks like. Roughness is near
   * mirror: honey's refractive index is ~1.49, the property refractometers use to read
   * its moisture, and it is a very glossy liquid.
   */
  honey: {
    color: 0xd98d1f,
    metal: 0,
    rough: 0.05,
    transmission: 0,
    bodyOpacity: 0.93,
    absorb: [2.4, 6.5, 15.0],
    ior: 1.49,
    /*
     * The body's environment reflection is turned DOWN because absorption only dims the
     * medium's own colour — an un-attenuated reflection puts a floor under how dark the
     * column can get, and honey stopped at rust instead of going to deep brown. The
     * gloss lives on the SURFACE (`surfaceEnv`), where it belongs.
     */
    envIntensity: 0.35,
    /* Honey barely waves at all: the disturbance sinks in and dies almost at once. */
    surfaceColor: 0xe0a134,
    surfaceAlpha: 0.95,
    surfaceEnv: 2.4,
    rippleAmp: 0.022,
    rippleNormal: 6,
    rippleDamping: 0.86,
    rippleSettle: 0.97,
    dropStrength: 0.05,
    waveAmp: 0.004,
    displaceScale: 0.03,
    /* Honey does not throw a crown — it lifts a slow bead and swallows. */
    splashColor: 0xd9922e,
    splashCount: 9,
    splashLifeS: 1.1,
    splashVMin: 0.12,
    splashVMax: 0.4,
    splashUp: 0.85,
    dropletSizeM: 0.02,
  },
  /*
   * Mercury is carried entirely by `envMapIntensity`, and neither of the two obvious
   * alternatives works. The scene sets `environmentIntensity` to 0.18 so tungsten reads
   * as a dark warm grey (08 §8.3), and at that level a mirror has nothing to reflect and
   * renders as a flat grey box. Lifting it with `emissive` instead swung it the other
   * way — a uniform glow kills the specular contrast that MAKES it read as metal, and it
   * came out looking like matte white foam. Both were screenshotted before this landed.
   * Turning the reflection up keeps the contrast and simply makes it bright.
   */
  mercury: {
    color: 0xc6ccd4,
    metal: 1,
    rough: 0.03,
    transmission: 0,
    bodyOpacity: 1,
    absorb: [0, 0, 0],
    envIntensity: 7,
    /*
     * Mercury ripples tightly and rings for a long time — enormous surface tension, very
     * low viscosity — so small amplitude and high damping-resistance. It is also a
     * mirror, so its surface is opaque and its normals do the whole job.
     */
    surfaceColor: 0xdde3ea,
    surfaceAlpha: 1,
    surfaceEnv: 6,
    rippleAmp: 0.014,
    rippleNormal: 11,
    rippleDamping: 0.984,
    rippleSettle: 0.994,
    dropStrength: 0.07,
    waveAmp: 0.008,
    displaceScale: 0.05,
    /* Dense and barely wetting: few, fast, heavy beads that fall straight back. */
    splashColor: 0xdfe4ea,
    splashCount: 20,
    splashLifeS: 0.3,
    splashVMin: 0.35,
    splashVMax: 0.9,
    splashUp: 0.9,
    dropletSizeM: 0.014,
  },
};

interface Pose {
  u: number;
  v: number;
  y: number;
  r: number;
}

/** Matches MAX_BODIES in `fx/ripple.ts` — the batched pass handles this many at once. */
const MAX_DISPLACERS = 8;

/**
 * How far below the surface (in body radii) a body still dents it. Beyond this the water
 * has closed over it and the dent is released — which also keeps deep, resting cubes
 * from occupying the batch's limited slots.
 */
const DEEP_RADII = 2.5;

/** Consecutive quiet steps before a floater is parked. */
const REST_DWELL = 20;

/** The duck needs a stable key in the displacement maps; cube ids never reach here. */
const DUCK_ID = -1 as EntityId;

interface Droplet {
  p: Vec3;
  v: Vec3;
  life: number;
  maxLife: number;
  size: number;
}

/** Hard cap so a `DROP ALL` into water cannot unbound the buffer. */
const MAX_DROPLETS = 900;

interface Reading {
  id: EntityId;
  metal: MetalId;
  frac: number;
  floats: boolean;
  speedMps: number;
  displacedM3: number;
  buoyN: number;
}

export class FluidLab implements Lab {
  readonly id = 'fluid' as const;
  readonly title = 'Tank';
  readonly spawnOnEntry = false;

  #ctx: LabContext | null = null;
  #panel: LabPanelHandle | null = null;
  #fluid: FluidId = 'water';

  readonly #bodies: BodyHandle[] = [];
  readonly #objects: THREE.Object3D[] = [];
  readonly #disposables: { dispose(): void }[] = [];

  #fluidMat: THREE.MeshPhysicalMaterial | null = null;
  #ripple: RippleField | null = null;
  #surfaceMat: THREE.MeshPhysicalMaterial | null = null;
  #surfaceUniforms: Record<string, { value: unknown }> | null = null;
  #floorUniforms: Record<string, { value: unknown }> | null = null;
  #absorbUniforms: { uSurfaceY: { value: number }; uAbsorb: { value: THREE.Vector3 } } | null =
    null;
  /** Live droplets — position, velocity, remaining life, radius. */
  readonly #drops: Droplet[] = [];
  #dropPoints: THREE.Points | null = null;
  #dropGeo: THREE.BufferGeometry | null = null;
  #props: PropStore | null = null;
  #duck: BodyHandle | null = null;
  #crownMesh: THREE.Mesh | null = null;
  #crownT = 0;
  #crownLife = 0.3;
  #crownR = 0.05;
  #crownH = 0.05;

  readonly #forces = makeFluidForces();
  /**
   * The physics side of the surface. Driven by the same splashes as the visible
   * heightfield, so what lifts the duck is the wave you can see arriving.
   */
  readonly #waves = new SurfaceWaves();
  /** Consecutive steps each cube has been quiet at its analytic depth (the rest-snap). */
  readonly #quiet = new Map<EntityId, { n: number; sumY: number; parkY?: number }>();
  /** Last step's submerged fraction per cube — a splash is the 0 -> wet transition. */
  readonly #wasWet = new Map<EntityId, boolean>();
  /** Last frame's displacement pose per cube, for the moveSphere-style carry-forward. */
  readonly #lastPose = new Map<EntityId, Pose>();
  /** This frame's poses, recorded at physics rate and flushed once at render time. */
  readonly #pose = new Map<EntityId, Pose>();
  readonly #prevBuf = new Float32Array(MAX_DISPLACERS * 4);
  readonly #currBuf = new Float32Array(MAX_DISPLACERS * 4);
  #readings: Reading[] = [];
  /** Simulation clock, accumulated on the fixed step so split times are deterministic. */
  #simT = 0;
  /** Set when DROP ALL stages the line-up; the split times are measured from it. */
  #raceStart: number | null = null;
  /** Seconds from release to touching the tank floor, per cube that sinks. */
  readonly #finish = new Map<EntityId, { metal: MetalId; t: number }>();
  /** The reveal's caption, once the line-up has resolved. */
  #caption: string | null = null;

  build(ctx: LabContext): void {
    this.#ctx = ctx;
    this.#buildTank(ctx);
    this.#buildFluid(ctx);
    this.#buildPanel(ctx);
    this.#frame(ctx);
  }

  /**
   * 'subject', not 'stage': the tank IS the subject here, and a stage fit leaves it
   * small in the middle of an empty floor.
   *
   * Shared by `build` and `reset` because `App.reset` deliberately runs the rig's
   * cube-sized reset FIRST and expects the lab's own framing to land last — a lab that
   * does not re-frame on reset is left zoomed into nothing (the exact failure that
   * comment in `App.reset` warns about, and the one this lab shipped with).
   */
  #frame(ctx: LabContext): void {
    ctx.camera.frameRadius(Math.max(IN_W, IN_H) * 0.52, {
      fit: 'subject',
      centreYM: FLOOR_Y + IN_H * 0.5,
    });
  }

  // ---- the instrument ---------------------------------------------------------------

  #buildTank(ctx: LabContext): void {
    /*
     * The walls are ALPHA-transparent, not transmissive, and this is not a stylistic
     * preference — it is forced.
     *
     * A `transmission` material builds its backdrop by re-rendering the scene behind it,
     * and that pass captures OPAQUE objects only. With transmissive walls the tank
     * therefore showed the cubes (opaque) while silently dropping the translucent liquid
     * (transparent) — a tank with a blue surface, an empty volume, and cubes apparently
     * sitting in mid-air. Ordinary alpha blending composites both.
     *
     * Low opacity plus a tight specular keeps it reading as glass; the frame in
     * `#buildFrame` is what actually gives the tank its silhouette.
     */
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xdceef5,
      transmission: 0,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.#disposables.push(glass);

    const oW = IN_W / 2 + WALL;
    const oD = IN_D / 2 + WALL;
    const panes: readonly (readonly [Vec3, Vec3])[] = [
      [
        { x: oW, y: WALL / 2, z: oD },
        { x: 0, y: FLOOR_Y - WALL / 2, z: 0 },
      ],
      [
        { x: WALL / 2, y: IN_H / 2, z: oD },
        { x: -(IN_W / 2 + WALL / 2), y: FLOOR_Y + IN_H / 2, z: 0 },
      ],
      [
        { x: WALL / 2, y: IN_H / 2, z: oD },
        { x: IN_W / 2 + WALL / 2, y: FLOOR_Y + IN_H / 2, z: 0 },
      ],
      [
        { x: oW, y: IN_H / 2, z: WALL / 2 },
        { x: 0, y: FLOOR_Y + IN_H / 2, z: -(IN_D / 2 + WALL / 2) },
      ],
      [
        { x: oW, y: IN_H / 2, z: WALL / 2 },
        { x: 0, y: FLOOR_Y + IN_H / 2, z: IN_D / 2 + WALL / 2 },
      ],
    ];

    // Colliders stay as five boxes; only the VISUAL is merged (see below).
    for (const [half, at] of panes) {
      this.#bodies.push(ctx.physics.addStaticBox(half, at, 'glass'));
    }

    /*
     * ONE mesh for all four walls, drawn BACK FACES ONLY — and this is a flicker fix,
     * not a tidy-up.
     *
     * Five separate transparent panes with `depthWrite: false` share a render order, so
     * three sorts them against each other by camera distance EVERY FRAME. Orbit the
     * camera and near/far panes swap which draws on top; with no depth writes that flips
     * what you see through them, and it reads as the tank flickering. It only happens
     * while the camera moves, which is why a static frame-difference test says the scene
     * is perfectly still and misses it completely.
     *
     * One mesh cannot sort against itself, and `BackSide` draws only the far walls —
     * which is what you actually want looking into a tank, and removes the front-face vs
     * back-face fight as well.
     */
    const shell = new THREE.BoxGeometry(IN_W + WALL * 2, IN_H, IN_D + WALL * 2);
    const shellMesh = new THREE.Mesh(shell, glass);
    shellMesh.position.set(0, FLOOR_Y + IN_H / 2, 0);
    shellMesh.renderOrder = 0;
    ctx.scene.add(shellMesh);
    this.#objects.push(shellMesh);
    this.#disposables.push(shell);

    this.#buildFrame(ctx);
    this.#buildTankFloor(ctx);
  }

  /**
   * The tank floor — a tiled bed that REFRACTS and catches CAUSTICS, both computed in
   * this one shader from the ripple heightfield we already have.
   *
   * Why a tiled floor at all: refraction and caustics are distortions of what lies under
   * the water, so they are only visible against a PATTERN. Evan Wallace's pool is tiled
   * for exactly this reason (04, 07, 11 §5). Over a plain floor, perfect refraction bends
   * a uniform colour into a uniform colour and shows nothing — which is what this tank
   * did, and most of why it read as a tinted pane rather than as water.
   *
   * Why it costs nothing: the floor is a known plane at a known depth below a known
   * surface, so the refracted lookup is analytic — offset the tile UV by the surface
   * gradient. No transmission pass, no extra render target, no second scene render. The
   * caustic term reuses the same four height samples the gradient needs, so the whole
   * effect is five texture fetches on one quad. Draw calls and render-target switches
   * per frame are unchanged.
   *
   * The tile is generated in the shader rather than uploaded: crisper at any zoom, and
   * no texture memory.
   */
  #buildTankFloor(ctx: LabContext): void {
    const geo = new THREE.PlaneGeometry(IN_W - 0.002, IN_D - 0.002);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 });
    mat.defines = { ...(mat.defines ?? {}), USE_UV: '' };

    const u = {
      uHeight: { value: this.#ripple?.texture ?? null },
      uTexel: { value: 1 / 256 },
      uRefract: { value: 2.6 },
      uCaustic: { value: 3.2 },
      uTile: { value: new THREE.Vector2(9, 5) },
      uTileA: { value: new THREE.Color(0xc3d4dc) },
      uTileB: { value: new THREE.Color(0xaec3cd) },
      uGrout: { value: new THREE.Color(0x6d8590) },
    };
    this.#floorUniforms = u;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uHeight;
          uniform float uTexel;
          uniform float uRefract;
          uniform float uCaustic;
          uniform vec2 uTile;
          uniform vec3 uTileA;
          uniform vec3 uTileB;
          uniform vec3 uGrout;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            // Four taps serve BOTH the refraction gradient and the caustic Laplacian.
            float hL = texture2D(uHeight, vUv - vec2(uTexel, 0.0)).r;
            float hR = texture2D(uHeight, vUv + vec2(uTexel, 0.0)).r;
            float hD = texture2D(uHeight, vUv - vec2(0.0, uTexel)).r;
            float hU = texture2D(uHeight, vUv + vec2(0.0, uTexel)).r;
            float hC = texture2D(uHeight, vUv).r;

            /*
             * DEADZONE, and it is a portability fix rather than a nicety.
             *
             * These are half-float targets and the simulation's own snap-to-flat depends
             * on a precision floor that is not identical across GPUs. Anything the sim
             * leaves behind gets amplified here — the caustic term multiplies the
             * Laplacian by 90 — so a residual invisible on one machine becomes a frozen
             * ripple pattern on the floor of another. Thresholding here means a still
             * field renders as a still floor on ANY hardware, without relying on the
             * simulation having reached exactly zero.
             */
            vec2 grad = vec2(hL - hR, hD - hU);
            float gm = length(grad);
            grad *= smoothstep(0.00012, 0.0009, gm);

            // Refraction: the eye ray bends at the surface, so the floor point we see is
            // displaced along the surface gradient.
            vec2 ruv = vUv + grad * uRefract;

            vec2 t = ruv * uTile;
            vec2 cell = floor(t);
            vec2 f = abs(fract(t) - 0.5);
            float grout = smoothstep(0.40, 0.49, max(f.x, f.y));
            float checker = mod(cell.x + cell.y, 2.0);
            vec3 tile = mix(uTileA, uTileB, checker);
            tile = mix(tile, uGrout, grout);

            /*
             * Caustics: where the surface is concave it focuses light and where it is
             * convex it spreads it. The discrete Laplacian is that curvature, and it is
             * free here — the same four taps the gradient already needed.
             */
            float lap = (hL + hR + hD + hU) - 4.0 * hC;
            lap = sign(lap) * max(0.0, abs(lap) - 0.0004);
            float caustic = clamp(1.0 - lap * uCaustic * 90.0, 0.45, 2.6);

            diffuseColor.rgb *= tile * caustic;
          }`,
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, FLOOR_Y + 0.0012, 0);
    mesh.receiveShadow = true;
    ctx.scene.add(mesh);
    this.#objects.push(mesh);
    this.#disposables.push(geo, mat);
  }

  /**
   * The aquarium frame: rails top and bottom, posts at the four corners.
   *
   * Not decoration — it is the fix for "I can't see the tank". Near-perfect glass
   * against a flat background is, correctly, almost invisible: it has no silhouette of
   * its own and only shows where something behind it bends. A real tank reads instantly
   * because of its trim and its silicone seams, and that is what is being borrowed here.
   */
  #buildFrame(ctx: LabContext): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x11161b,
      roughness: 0.55,
      metalness: 0.35,
    });
    this.#disposables.push(mat);

    const oW = IN_W / 2 + WALL;
    const oD = IN_D / 2 + WALL;
    const add = (sx: number, sy: number, sz: number, x: number, y: number, z: number): void => {
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      ctx.scene.add(mesh);
      this.#objects.push(mesh);
      this.#disposables.push(geo);
    };

    for (const y of [FLOOR_Y + RIM / 2, FLOOR_Y + IN_H - RIM / 2]) {
      add(oW * 2 + RIM, RIM, RIM, 0, y, oD + RIM / 2 - 0.001);
      add(oW * 2 + RIM, RIM, RIM, 0, y, -(oD + RIM / 2 - 0.001));
      add(RIM, RIM, oD * 2, oW + RIM / 2 - 0.001, y, 0);
      add(RIM, RIM, oD * 2, -(oW + RIM / 2 - 0.001), y, 0);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(
          RIM,
          IN_H,
          RIM,
          sx * (oW + RIM / 2 - 0.001),
          FLOOR_Y + IN_H / 2,
          sz * (oD + RIM / 2 - 0.001),
        );
      }
    }
  }

  #buildFluid(ctx: LabContext): void {
    /*
     * The BODY sits 3 mm below the surface plane on purpose.
     *
     * Both were at exactly SURFACE_Y in the first cut, which makes them coplanar — and
     * coplanar transparent geometry z-fights, so the water flickered as the camera
     * moved. Depth-sorting cannot break the tie when there is no depth between them.
     */
    const bodyH = FILL_H - 0.003;
    const geo = new THREE.BoxGeometry(IN_W - 0.001, bodyH, IN_D - 0.001);
    const mat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });

    /*
     * Beer-Lambert depth absorption, injected into the body material.
     *
     * Without it a liquid is one flat tint from surface to floor, which is why the first
     * honey read as a slab of orange plastic. A real liquid eats light exponentially with
     * path length, so the top of the column shows its thin-layer colour and the bottom
     * goes to near-black. That gradient is most of what separates "a deep tank of
     * something" from "a coloured box".
     *
     * Applied at `color_fragment`, before lighting, so it dims the medium's own colour
     * rather than fighting the specular — the surface stays glossy at any depth.
     */
    const absorbUniforms = {
      uSurfaceY: { value: SURFACE_Y },
      uAbsorb: { value: new THREE.Vector3() },
    };
    this.#absorbUniforms = absorbUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, absorbUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vWorldY;\nuniform float uSurfaceY;\nuniform vec3 uAbsorb;',
        )
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\nfloat depthM = max(0.0, uSurfaceY - vWorldY);\ndiffuseColor.rgb *= exp(-uAbsorb * depthM);',
        );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, FLOOR_Y + bodyH / 2, 0);
    /*
     * Explicit draw order for the transparent stack. three sorts transparent objects by
     * camera distance every frame, and near-equal keys can swap from frame to frame,
     * which reads as flicker. Fixing the order removes that as a variable.
     */
    mesh.renderOrder = 1;
    ctx.scene.add(mesh);
    this.#fluidMat = mat;
    this.#objects.push(mesh);
    this.#disposables.push(geo, mat);

    this.#ripple = new RippleField(ctx.render.renderer, 256, IN_W / IN_D);
    this.#waves.configure(FILL_H, 1.6);
    this.#buildSurface(ctx);
    this.#buildDroplets(ctx);
    this.#buildCrown(ctx);
    this.#props = new PropStore(ctx.physics);
    void this.#buildDuck(ctx);
    this.#applyLook();
  }

  /**
   * The liquid surface: a subdivided plane displaced by the ripple heightfield, with its
   * normals taken from the same texture.
   *
   * Built as a `MeshPhysicalMaterial` with `onBeforeCompile` rather than a bespoke
   * shader — the same trick the melon flesh uses — so the surface keeps three's PBR,
   * its environment reflection and its fresnel, and only the geometry and normal are
   * ours. That matters here: what sells a liquid is the way the environment slides
   * across a moving surface, and re-implementing that by hand would be worse.
   *
   * The normal is computed per FRAGMENT from height differences, not per vertex. A
   * 160-segment grid is far too coarse to carry a ripple's shape in its vertices, but
   * the lighting only needs the derivative, and that can be sampled at full texture
   * resolution.
   */
  #buildSurface(ctx: LabContext): void {
    const geo = new THREE.PlaneGeometry(IN_W - 0.002, IN_D - 0.002, 160, 160);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    mat.defines = { ...(mat.defines ?? {}), USE_UV: '' };

    const uniforms = {
      uHeight: { value: this.#ripple?.texture ?? null },
      uAmp: { value: 0.05 },
      uNormalScale: { value: 12 },
      uTexel: { value: 1 / 256 },
    };
    this.#surfaceUniforms = uniforms;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D uHeight;\nuniform float uAmp;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\ntransformed.y += clamp(texture2D(uHeight, uv).r, -1.0, 1.0) * uAmp;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D uHeight;\nuniform float uNormalScale;\nuniform float uTexel;',
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          {
            float hL = texture2D(uHeight, vUv - vec2(uTexel, 0.0)).r;
            float hR = texture2D(uHeight, vUv + vec2(uTexel, 0.0)).r;
            float hD = texture2D(uHeight, vUv - vec2(0.0, uTexel)).r;
            float hU = texture2D(uHeight, vUv + vec2(0.0, uTexel)).r;
            // three's fragment 'normal' is in VIEW space. 'normalMatrix' is a
            // vertex-only uniform, but 'viewMatrix' is available here — and the surface
            // mesh has identity rotation and unit scale, so object space IS world space.
            // Same half-float deadzone as the floor: a residual must not tilt the
            // surface normal, or still water shimmers on hardware whose precision floor
            // differs from the one the simulation's snap-to-flat was tuned against.
            vec2 sg = vec2(hL - hR, hD - hU);
            sg *= smoothstep(0.00012, 0.0009, length(sg));
            vec3 nWorld = normalize(vec3(sg.x * uNormalScale, 1.0, sg.y * uNormalScale));
            normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
          }`,
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, SURFACE_Y, 0);
    mesh.renderOrder = 2;
    ctx.scene.add(mesh);
    this.#surfaceMat = mat;
    this.#objects.push(mesh);
    this.#disposables.push(geo, mat);
  }

  #applyLook(): void {
    const look = LOOK[this.#fluid];

    const mat = this.#fluidMat;
    if (mat) {
      /*
       * The BODY is a plain translucent volume, not a transmissive one. `transmission`
       * is the physically-right mechanism and renders as near-invisible glass at tank
       * scale, because its tint lives in `attenuationDistance` and 40 cm is not enough
       * depth to accumulate any. Opacity carries colour reliably at any depth.
       */
      mat.color.setHex(look.color);
      mat.metalness = look.metal;
      mat.roughness = look.rough;
      mat.transmission = 0;
      mat.envMapIntensity = look.envIntensity;
      mat.transparent = look.bodyOpacity < 1;
      mat.opacity = look.bodyOpacity;
      mat.depthWrite = look.bodyOpacity >= 1;
      mat.needsUpdate = true;
    }

    const au = this.#absorbUniforms;
    if (au) {
      au.uAbsorb.value.set(look.absorb[0], look.absorb[1], look.absorb[2]);
    }

    const sm = this.#surfaceMat;
    if (sm) {
      sm.color.setHex(look.surfaceColor);
      sm.opacity = look.surfaceAlpha;
      sm.transparent = look.surfaceAlpha < 1;
      sm.metalness = look.metal;
      sm.roughness = look.rough;
      sm.envMapIntensity = look.surfaceEnv;
      sm.needsUpdate = true;
    }

    const u = this.#surfaceUniforms;
    if (u) {
      u['uAmp']!.value = look.rippleAmp;
      u['uNormalScale']!.value = look.rippleNormal;
    }
    // Honey's waves die almost at once; mercury's ring on and on.
    if (this.#ripple) {
      this.#ripple.damping = look.rippleDamping;
      this.#ripple.settle = look.rippleSettle;
    }
  }

  /**
   * Loads asynchronously and simply never appears if the asset is missing — the tank is
   * fully usable without it, so a failed fetch must not take the lab down with it.
   */
  async #buildDuck(ctx: LabContext): Promise<void> {
    let scene: THREE.Group;
    try {
      const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}rubber-duck.glb`);
      scene = gltf.scene;
    } catch {
      return;
    }
    // The lab may have been torn down while the GLB was in flight.
    if (!this.#ctx || !this.#props) return;

    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    // Model origin is its base (prep tool); the body origin is its centre.
    scene.position.y = -DUCK_H_M / 2;
    const holder = new THREE.Group();
    holder.add(scene);
    ctx.scene.add(holder);
    this.#objects.push(holder);

    const body = ctx.physics.addCompound({
      kind: 'dynamic',
      at: duckStart(),
      parts: [
        {
          shape: {
            kind: 'box',
            halfExtents: { x: DUCK_LEN_M / 2, y: DUCK_H_M / 2, z: DUCK_W_M / 2 },
          },
          material: 'rubber',
          massKg: DUCK_MASS_KG,
        },
      ],
    });
    ctx.physics.setAngularDamping(body, 1.2);
    this.#duck = body;
    this.#bodies.push(body);
    this.#props.add(body, holder);
  }

  // ---- physics ----------------------------------------------------------------------

  beforePhysics(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const dt = config.loop.DT;
    this.#simT += dt;
    this.#waves.step(dt);
    const readings: Reading[] = [];

    for (const e of ctx.entities.all) {
      if (e.heldBy !== null) {
        this.#quiet.delete(e.id);
        this.#wasWet.delete(e.id);
        this.#lastPose.delete(e.id);
        this.#pose.delete(e.id);
        continue;
      }
      const sideM = e.spec.sideM;
      const t = ctx.physics.transformOf(e.body);
      const v = ctx.physics.velocityOf(e.body);
      const w = ctx.physics.angularVelocityOf(e.body);
      const f = this.#forces;
      const localY = SURFACE_Y + this.#waves.heightAt(t.p.x, t.p.z);
      fluidForces(this.#fluid, sideM, e.massKg, t.p, t.q, v, w, localY, dt, f);

      /*
       * The rest decision comes FIRST, because a parked body must not be given the very
       * forces it was parked to escape.
       *
       * Clamping the pose and then applying buoyancy in the same `beforePhysics` is
       * useless: the step that follows applies those forces and moves the body straight
       * back off the clamp. The duck held a 3 mm bob through every threshold change for
       * exactly this reason — the park was real and was being undone one line later.
       *
       * A parked body gets ONE force: gravity cancelled. Net zero, so it stays where it
       * was put without being frozen or made kinematic.
       */
      const parked = this.#restSnap(
        ctx,
        e.id,
        e.body,
        this.#density(e.spec),
        sideM,
        t.p,
        v,
        w,
        localY,
      );
      if (parked) {
        ctx.physics.applyForce(e.body, { x: 0, y: e.massKg * config.physics.gravityMps2, z: 0 });
        ctx.physics.setLinearDamping(e.body, 0);
      } else {
        if (f.frac > 0) {
          ctx.physics.applyForceAtPoint(e.body, { x: 0, y: f.buoyN, z: 0 }, f.centre);
          ctx.physics.applyForce(e.body, f.resistN);
          ctx.physics.applyForce(e.body, f.inertiaN);
          ctx.physics.applyTorque(e.body, f.torqueNm);
        }
        ctx.physics.setLinearDamping(e.body, f.dampingPerS);
      }

      // The moment of entry: dry last step, wet now, and still heading down.
      const wet = f.frac > 0;
      if (wet && this.#wasWet.get(e.id) === false && v.y < 0) {
        this.#splash(ctx, t.p, -v.y, e.massKg);
      }
      this.#wasWet.set(e.id, wet);

      this.#displaceFor(e.id, t.p, sideM);

      /*
       * A sinker's finish is TOUCHING DOWN, judged by position rather than by speed —
       * the same rule the rest-snap uses, and for the same reason: a cube settling onto
       * the floor still carries contact chatter in its velocity long after it has
       * arrived.
       */
      if (this.#raceStart !== null && !this.#finish.has(e.id)) {
        const floats = floatFraction(this.#density(e.spec), this.#fluid) !== null;
        if (!floats && t.p.y < FLOOR_Y + sideM * 0.62) {
          this.#finish.set(e.id, { metal: e.spec.metal, t: this.#simT - this.#raceStart });
        }
      }

      const volume = sideM * sideM * sideM;
      readings.push({
        id: e.id,
        metal: e.spec.metal,
        frac: f.frac,
        floats: floatFraction(this.#density(e.spec), this.#fluid) !== null,
        speedMps: Math.hypot(v.x, v.y, v.z),
        displacedM3: volume * f.frac,
        buoyN: f.buoyN,
      });
    }
    this.#readings = readings;
    this.#floatDuck(ctx, dt);
  }

  /**
   * The duck rides on the SAME `fluidForces` the cubes do — it is not a scripted float.
   * Its own volume displacement goes into the batch too, so it dents the surface and
   * leaves a wake like anything else in the tank.
   */
  #floatDuck(ctx: LabContext, dt: number): void {
    const body = this.#duck;
    if (body === null) return;
    const t = ctx.physics.transformOf(body);
    const v = ctx.physics.velocityOf(body);
    const w = ctx.physics.angularVelocityOf(body);
    const f = this.#forces;
    // A box of the duck's footprint stands in for the hull; the mass is the real thing.
    const side = Math.cbrt(DUCK_LEN_M * DUCK_H_M * DUCK_W_M);
    const localY = SURFACE_Y + this.#waves.heightAt(t.p.x, t.p.z);
    fluidForces(this.#fluid, side, DUCK_MASS_KG, t.p, t.q, v, w, localY, dt, f);
    const parked = this.#restSnap(ctx, DUCK_ID, body, DUCK_DENSITY, side, t.p, v, w, localY);
    if (parked) {
      ctx.physics.applyForce(body, { x: 0, y: DUCK_MASS_KG * config.physics.gravityMps2, z: 0 });
      ctx.physics.setLinearDamping(body, 0);
    } else {
      if (f.frac > 0) {
        ctx.physics.applyForceAtPoint(body, { x: 0, y: f.buoyN, z: 0 }, f.centre);
        ctx.physics.applyForce(body, f.resistN);
        ctx.physics.applyForce(body, f.inertiaN);
        ctx.physics.applyTorque(body, f.torqueNm);
      }
      ctx.physics.setLinearDamping(body, f.dampingPerS);
    }

    /*
     * The duck needs the rest-snap MORE than any cube does, and the first cut forgot to
     * give it one — it only ran in the cube loop, so the duck bounced forever.
     *
     * It is the extreme case of F0's finding (19 §2.4). Buoyancy near the surface is a
     * saturating ramp, and the lighter the floater the bigger the one-step velocity
     * quantum: a hollow duck at ~120 kg/m3 in water lands near 0.18 m/s, several times
     * any cube's. Damping cannot reach that — the limit cycle is regenerated at every
     * crossing — so without the velocity-level bleed and the park it never settles.
     */
    this.#displaceFor(DUCK_ID, t.p, side);
  }

  #density(spec: { metal: MetalId; purityPctW?: number }): number {
    return densityOf(spec.metal, spec.purityPctW);
  }

  /**
   * Entry splash (03 §5) — fired on the step a cube first touches the surface.
   *
   * Scaled by ENTRY ENERGY rather than speed, so a tungsten cube arrives like a tungsten
   * cube: at the same speed it carries seven times the kinetic energy of aluminium, and
   * the splash is the one moment where the tank gets to say so.
   *
   * The spray is thrown nearly straight up (`splashUp` ~0.9) and dies fast. That is
   * partly real — a crown rises rather than sprays sideways — and partly a containment
   * fix: the particle pool has no collision, so a wide, long-lived burst sails straight
   * through the glass and rains down outside the tank, which was visible in review.
   *
   * The three fluids are deliberately different events, not one sound at three pitches:
   * water breaks and throws a crown, honey swallows with almost no transient, and
   * mercury — barely wetting, 13.5x the density — reads hard and metallic, closer to
   * dropping a cube into ball bearings than into a pool.
   */
  #splash(ctx: LabContext, at: Vec3, speedMps: number, massKg: number): void {
    const energyJ = 0.5 * massKg * speedMps * speedMps;
    if (energyJ < 0.02) return;
    const look = LOOK[this.#fluid];
    const k = Math.min(1, Math.sqrt(energyJ) / 3);

    /*
     * No explicit ring is injected here any more, and it is not a loss: the entering
     * cube's own volume displacement (see `#flushDisplacement`) already digs the cavity,
     * which is both more correct and free — it rides in the one batched pass.
     *
     * It also removes the last per-EVENT GPU pass. Six cubes entering on the same step
     * fired six render-target switches in a single frame, and a frame that costs several
     * times its neighbours is exactly what a stutter is.
     */
    const rimM = 0.028 + 0.045 * k;

    // The physics wave, alongside the visual one — same event, same place.
    this.#waves.add(at.x, at.z, look.waveAmp * (0.35 + 0.65 * k));
    this.#crown(at, look, k, rimM);
    this.#droplets(ctx, at, look, k, rimM);
    ctx.fx.play(TANK_VOICES[this.#fluid], Math.min(1, 0.3 + 0.7 * k), 0.9 + 0.25 * k);
    ctx.fx.haptic(0.25 + 0.5 * k);
  }

  /**
   * Carry one cube's displaced volume forward — the reference's `moveSphere`, per body.
   *
   * Adding back where it WAS and subtracting where it IS conserves the disturbance, so a
   * submerged cube keeps a dent that travels with it and the water closes behind it
   * without anything scripting that. The first cut instead injected one-shot bumps
   * scaled by `sign(v.y)`, which alternated every frame as a cube bobbed — wrong
   * physically and a flicker source in its own right.
   */
  #displaceFor(id: EntityId, p: Vec3, sideM: number): void {
    const radius = (sideM * 0.75) / IN_W;
    const u = (p.x + IN_W / 2) / IN_W;
    const v = (p.z + IN_D / 2) / IN_D;
    // Centre height above the surface, in radius units — how deep it is biting.
    const y = (p.y - SURFACE_Y) / (sideM * 0.75);

    /*
     * A body only displaces the SURFACE while it is near the surface.
     *
     * The clamp here used to be symmetric — `sign(y) * 3` — which is right above the
     * water and badly wrong below it: a cube resting on the tank floor sits at y ~ -12,
     * clamped to -3, where it reads as fully submerged and returns FULL displacement.
     * With prev == curr every frame that dent never changed and never released, so every
     * sunk cube left a permanent dimple in the surface. That is what "a ripple getting
     * stuck indefinitely" was — a frozen dent, not a stuck wave.
     *
     * Physically, the surface dimple from a body several diameters down is negligible;
     * the water has closed over it. Past that depth the body is dropped from the set,
     * which releases its dent and lets the surface heal.
     */
    if (y > 3 || y < -DEEP_RADII) {
      this.#pose.delete(id);
      return;
    }
    this.#pose.set(id, { u, v, y, r: radius });
  }

  /**
   * Push the whole frame's displacement to the GPU in ONE pass.
   *
   * Recording poses during `beforePhysics` and flushing here is the difference between
   * six render-target switches per physics step and one per frame. Switches are nearly
   * free on a software rasteriser and expensive on a real GPU — a tiled one has to flush
   * tiles on each — so the cost of the first version was invisible in a headless
   * benchmark and very visible on a machine, as lag and stutter on DROP ALL.
   */
  #flushDisplacement(): void {
    const r = this.#ripple;
    if (!r) return;
    let n = 0;
    for (const [id, cur] of this.#pose) {
      if (n >= MAX_DISPLACERS) break;
      const prev = this.#lastPose.get(id) ?? { u: cur.u, v: cur.v, y: 3, r: cur.r };
      const o = n * 4;
      this.#prevBuf[o] = prev.u;
      this.#prevBuf[o + 1] = prev.v;
      this.#prevBuf[o + 2] = prev.y;
      this.#prevBuf[o + 3] = prev.r;
      this.#currBuf[o] = cur.u;
      this.#currBuf[o + 1] = cur.v;
      this.#currBuf[o + 2] = cur.y;
      this.#currBuf[o + 3] = cur.r;
      this.#lastPose.set(id, cur);
      n++;
    }
    // Bodies that vanished this frame release their dent, so the water closes over them.
    for (const [id, prev] of this.#lastPose) {
      if (n >= MAX_DISPLACERS) break;
      if (this.#pose.has(id)) continue;
      const o = n * 4;
      this.#prevBuf[o] = prev.u;
      this.#prevBuf[o + 1] = prev.v;
      this.#prevBuf[o + 2] = prev.y;
      this.#prevBuf[o + 3] = prev.r;
      this.#currBuf[o] = prev.u;
      this.#currBuf[o + 1] = prev.v;
      this.#currBuf[o + 2] = 3;
      this.#currBuf[o + 3] = prev.r;
      this.#lastPose.delete(id);
      n++;
    }
    this.#pose.clear();
    if (n > 0) r.displaceBatch(this.#prevBuf, this.#currBuf, n, LOOK[this.#fluid].displaceScale);
  }

  /**
   * The crown: a lab-local droplet system rather than the shared particle pool.
   *
   * The pool draws square, fixed-size, unlit points, which is right for glass glints and
   * concrete dust and wrong for water — a splash is round, varied and falls under
   * gravity. These are billboarded sprites off a generated radial-gradient texture, with
   * their own ballistic integration, thrown in a RING rather than a sphere so they read
   * as a crown rising off the impact instead of an explosion.
   */
  #droplets(ctx: LabContext, at: Vec3, look: FluidLook, k: number, rimM: number): void {
    void ctx;
    const n = Math.round(look.splashCount * (0.4 + 0.6 * k));
    for (let i = 0; i < n && this.#drops.length < MAX_DROPLETS; i++) {
      const a = i * 2.399963; // golden angle — an even ring without dice (house rule)
      const h = ((i * 7919) % 1000) / 1000;

      /*
       * Droplets are thrown from the CRATER RIM, not from a point. A real splash is a
       * cavity whose collapsing wall throws a ring of water outward and up; spawning
       * everything at the impact point gives a firework, which is what the first cut
       * looked like.
       */
      const rim = rimM * (0.85 + 0.3 * h);
      const px = at.x + Math.cos(a) * rim;
      const pz = at.z + Math.sin(a) * rim;

      /*
       * Sizes follow a POWER LAW: mostly fine spray with a few fat droplets. A uniform
       * distribution reads as identical beads, which is the other half of why it looked
       * artificial. The big ones are slower and live longer, as they do in life.
       */
      const fine = Math.pow(h, 2.2);
      const size = look.dropletSizeM * (0.35 + 2.4 * fine);
      const speed =
        (look.splashVMin + (look.splashVMax - look.splashVMin) * (1 - fine * 0.75)) * (0.55 + k);
      const out = 1 - look.splashUp;
      const life = look.splashLifeS * (0.55 + 1.1 * fine);

      this.#drops.push({
        p: { x: px, y: SURFACE_Y + 0.004, z: pz },
        v: {
          x: Math.cos(a) * speed * out,
          y: speed * look.splashUp * (0.7 + 0.6 * h),
          z: Math.sin(a) * speed * out,
        },
        life,
        maxLife: life,
        size,
      });
    }
  }

  /**
   * The crown: a thin ring of water standing up around the cavity, which then falls back.
   *
   * This is the shape people actually recognise as a splash — the discrete droplets are
   * the garnish on top of it. It is one open cone that grows outward, sinks, and fades
   * over about a quarter of a second, which is roughly the life of a real crown.
   */
  #crown(at: Vec3, look: FluidLook, k: number, rimM: number): void {
    const m = this.#crownMesh;
    if (!m) return;
    m.visible = true;
    m.position.set(at.x, SURFACE_Y, at.z);
    (m.material as THREE.MeshBasicMaterial).color.setHex(look.splashColor);
    this.#crownT = 0;
    this.#crownLife = 0.2 + 0.1 * k;
    /*
     * Scaled to the CAVITY, not to the splash energy. The first cut ran to a 19 cm
     * radius in an 80 cm tank and read as a translucent lampshade over the water; a real
     * crown is about as tall as the object is wide.
     */
    this.#crownR = rimM * (0.75 + 0.35 * k);
    this.#crownH = rimM * (0.5 + 0.6 * k);
  }

  #stepCrown(dt: number): void {
    const m = this.#crownMesh;
    if (!m || !m.visible) return;
    this.#crownT += dt;
    const t = this.#crownT / this.#crownLife;
    if (t >= 1) {
      m.visible = false;
      return;
    }
    // Grows outward fast, stands up, then collapses back into the surface.
    const grow = Math.sqrt(t);
    const stand = Math.sin(Math.PI * Math.min(1, t * 1.15));
    m.scale.set(this.#crownR * (0.35 + grow), this.#crownH * stand, this.#crownR * (0.35 + grow));
    (m.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - t) * (1 - t);
  }

  /** An open cone, wider at the top — the crown's silhouette. */
  #buildCrown(ctx: LabContext): void {
    const geo = new THREE.CylinderGeometry(1, 0.55, 1, 28, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 3;
    ctx.scene.add(mesh);
    this.#crownMesh = mesh;
    this.#objects.push(mesh);
    this.#disposables.push(geo, mat);
  }

  /**
   * The F2 half of F0's finding (19 §2.4).
   *
   * A small floater cannot be brought to rest by damping: buoyancy at the surface is a
   * saturating ramp, so the cube is fully wet one step and fully dry the next, and that
   * bang-bang limit cycle is regenerated at every crossing. Measured residual for a 0.25"
   * aluminium cube in mercury is 0.31-0.37 m/s against a 0.150 m/s one-step quantum, and
   * it moved by less than 0.06 m/s when the damping was tripled or its band widened 160x.
   *
   * So this bleeds velocity DIRECTLY once a cube is near the depth `floatFraction` gives,
   * and parks it there once it is quiet. Two things keep it honest:
   *
   *   - It can only ever touch a body that FLOATS, because it is gated on having an
   *     analytic equilibrium at all. A sinking cube has none, is never in the band, and
   *     so 02 §6's terminal velocities cannot be affected by anything in here.
   *   - The depth it snaps to is `rho_c / rho_f` — an exact division, not a fitted pose.
   *     It snaps to the known answer, not to an artefact.
   */
  #restSnap(
    ctx: LabContext,
    id: EntityId,
    body: BodyHandle,
    densityKgM3: number,
    sideM: number,
    p: Vec3,
    v: Vec3,
    w: Vec3,
    localSurfaceY: number,
  ): boolean {
    const want = floatFraction(densityKgM3, this.#fluid);
    if (want === null) {
      this.#quiet.delete(id);
      return false;
    }

    /*
     * Rest is judged by POSITION, not by submerged fraction — the same lesson the Rapier
     * work taught, for a sharper reason here.
     *
     * The fraction cannot be trusted for a shallow floater. The duck rides 0.9 %
     * submerged in mercury, which is 0.67 mm of a 74 mm body, while the 4x4x4 lattice's
     * finest ramp is ~18 mm — it physically cannot resolve a fraction that shallow, so a
     * fraction-based "is it at its float depth" test is never satisfiable and the park
     * never fires. Measured: the duck sat in a 3 mm limit cycle indefinitely while speed
     * and spin were both well inside their limits.
     *
     * The analytic float POSE has no such problem: it is an exact division, and the same
     * value is used to test rest and to park. Nothing here depends on the lattice.
     */
    /*
     * A PASSING WAVE UN-PARKS A FLOATER. This is the whole point of the parked state
     * being conditional rather than a freeze: the tank would otherwise hold the duck
     * rigid while a splash rolled visibly underneath it.
     */
    if (Math.abs(localSurfaceY - SURFACE_Y) > 0.0006) {
      this.#quiet.delete(id);
      return false;
    }
    const parkY = localSurfaceY + sideM * (0.5 - want);
    const dy = Math.abs(p.y - parkY);
    if (dy > sideM * 0.6) {
      this.#quiet.delete(id);
      return false;
    }

    const speed = Math.hypot(v.x, v.y, v.z);
    const spin = Math.hypot(w.x, w.y, w.z);
    const quantum = stepVelocityQuantum(densityKgM3, this.#fluid, config.loop.DT);

    // Inside the band: bleed the limit cycle at the velocity level, where forces cannot
    // reach it. Light floaters have the biggest quantum and need the harder bleed.
    if (speed < quantum * 4) {
      const keep = quantum > 0.15 ? 0.7 : 0.82;
      ctx.physics.setVelocity(
        body,
        { x: v.x * keep, y: v.y * keep, z: v.z * keep },
        { x: w.x * keep, y: w.y * keep, z: w.z * keep },
      );
    }

    /*
     * Both thresholds SCALE WITH THE QUANTUM. A fixed 0.012 m/s works for a 2" cube and
     * is unreachable for a hollow duck on mercury, whose quantum is 0.239 m/s. F0's
     * finding was that the residual scales with the quantum; the test for "at rest" has
     * to scale with it too, or it only ever holds for the heavy cases.
     */
    /*
     * REST IS POSITION, NOT VELOCITY — the house rule, and this is the case that proves
     * it is not a stylistic preference.
     *
     * A body in the surface bang-bang takes a large impulse every step that reverses on
     * the next, so its SPEED stays high while it goes nowhere. Measured for the duck on
     * mercury: speed alternating 0.107 / 0.184 m/s while its position moved 0.1 mm and
     * sat 1 mm from its analytic float pose. Any speed threshold low enough to mean
     * "at rest" is therefore unreachable, and gating on one kept the park from ever
     * firing however the numbers were tuned.
     *
     * Position has no such problem, and the dwell is what makes it safe: a body actually
     * in motion cannot stay within a few millimetres of its float pose for 20 consecutive
     * steps — at the speeds above it would travel 60 mm in that time.
     */
    /*
     * Tight, because the parked depth IS the readout. At 8 % of the body a 2" cube could
     * park 6 mm off its true float depth, which is 12 % of its side — copper reported
     * 60 % submerged against its published 66 %, and the whole point of the mercury
     * reveal is that those fractions are an exact division rather than a table.
     */
    const restDy = Math.max(0.0008, sideM * 0.03);
    const settled = spin < 0.05 && dy < restDy;

    /*
     * PARK AT THE MEAN OF THE OSCILLATION, not at the analytic pose.
     *
     * Parking at the exact analytic depth looks right and does not hold: the lattice
     * cannot resolve a very shallow floater (the duck rides 0.67 mm deep in mercury
     * against an ~18 mm ramp), so at that position the SIMULATION computes a different
     * submerged fraction, applies a net force, and pushes the body straight back out.
     * It oscillated around wherever the lattice balanced instead — measured at a
     * stubborn 2.86 mm that no threshold change touched.
     *
     * The mean of the cycle IS the position where the simulated forces cancel, which is
     * the only place a park can actually stay put. Measure it rather than assume it.
     */
    const prev = this.#quiet.get(id);
    if (!settled) {
      this.#quiet.delete(id);
      return false;
    }
    const n = (prev?.n ?? 0) + 1;
    const sumY = (prev?.sumY ?? 0) + p.y;

    /*
     * The park HOLDS — it is re-applied every step, not fired once.
     *
     * Parking once and then resuming the forces just puts the body straight back into
     * its limit cycle, because the force imbalance that caused the cycle is still there
     * on the very next step. F0 said as much ("the lab must stop applying forces to do
     * it") and the first cut parked once anyway, which is why the duck kept a stubborn
     * 3 mm bob in mercury that no threshold change would touch.
     *
     * Holding is safe because it is conditional: the clamp only runs while the body
     * still reads as settled, so the step after anything disturbs it — a cube landing, a
     * fluid change — `settled` goes false, the record is dropped, and it is free again.
     */
    /*
     * Park at the ANALYTIC float pose, not at the measured mean of the cycle.
     *
     * The mean was a workaround from when the park did not hold: forces resumed on the
     * next step and pushed the body off any exact position, so the only place it could
     * sit was wherever the simulation happened to balance. Now that a parked body stops
     * receiving forces, the exact pose holds — and it should be exact, because this
     * depth is what the panel reports as the submerged fraction.
     */
    this.#quiet.set(id, { n, sumY });
    if (n < REST_DWELL) return false;
    ctx.physics.setTransform(body, { x: p.x, y: parkY, z: p.z }, true);
    return true;
  }

  /**
   * Droplets are drawn as round, size-varied, additive sprites off a generated radial
   * gradient — the shared pool's square unlit points read as debris, not water.
   */
  #buildDroplets(ctx: LabContext): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DROPLETS * 3), 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_DROPLETS), 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(MAX_DROPLETS), 1));
    geo.setDrawRange(0, 0);

    const tex = this.#dropletTexture();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 900.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColor, t.a * vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    ctx.scene.add(pts);
    this.#dropPoints = pts;
    this.#dropGeo = geo;
    this.#objects.push(pts);
    this.#disposables.push(geo, mat, tex);
  }

  #dropletTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(32, 32, 32, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #writeDroplets(): void {
    const geo = this.#dropGeo;
    const pts = this.#dropPoints;
    if (!geo || !pts) return;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const size = geo.getAttribute('size') as THREE.BufferAttribute;
    const alpha = geo.getAttribute('alpha') as THREE.BufferAttribute;
    const n = Math.min(this.#drops.length, MAX_DROPLETS);
    for (let i = 0; i < n; i++) {
      const d = this.#drops[i]!;
      pos.setXYZ(i, d.p.x, d.p.y, d.p.z);
      size.setX(i, d.size);
      // Fade over the last third of life so they thin out rather than blink off.
      alpha.setX(i, Math.min(1, (d.life / d.maxLife) * 3));
    }
    pos.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;
    geo.setDrawRange(0, n);
    const mat = pts.material as THREE.ShaderMaterial;
    (mat.uniforms['uColor']!.value as THREE.Color).setHex(LOOK[this.#fluid].splashColor);
  }

  // ---- panel ------------------------------------------------------------------------

  #buildPanel(ctx: LabContext): void {
    this.#panel = ctx.ui.mountPanel(this.#model());
  }

  #publish(): void {
    this.#panel?.update(this.#model());
  }

  #model(): LabPanelModel {
    const subject = this.#subject();
    const facts: PanelFact[] = [];
    if (subject) {
      facts.push({
        k: 'DISPLACED',
        v: `${(subject.displacedM3 * 1e6).toFixed(0)} cm³`,
        v2: `${(subject.displacedM3 * FLUIDS[this.#fluid].densityKgM3 * 1000).toFixed(0)} g of ${FLUIDS[this.#fluid].label.toLowerCase()}`,
      });
      facts.push({ k: 'BUOYANCY', v: `${subject.buoyN.toFixed(2)} N`, v2: '' });
    }
    if (this.#caption) facts.push({ k: 'LINE-UP', v: this.#caption, v2: '' });
    facts.push({
      k: 'DENSITY',
      v: `${FLUIDS[this.#fluid].densityKgM3.toLocaleString()} kg/m³`,
      v2: FLUIDS[this.#fluid].note,
    });

    const model: LabPanelModel = {
      id: 'fluid',
      title: 'FLUID TANK',
      status: this.#status(),
      facts,
      controls: [
        {
          kind: 'segmented' as const,
          id: 'fluid',
          label: 'FLUID',
          value: this.#fluid,
          options: TANK_FLUID_IDS.map((id) => ({ id, label: FLUIDS[id].label })),
          onChange: (id: string) => this.#setFluid(id as FluidId),
        },
      ],
      actions: [
        { id: 'all', label: 'DROP ALL', primary: true, onSelect: () => this.#dropAll() },
        { id: 'reset', label: 'RESET', onSelect: () => this.#ctx?.ui.resetLab() },
      ],
    };
    if (subject) {
      model.primary = {
        label: subject.metal,
        value: subject.floats
          ? `${Math.round(subject.frac * 100)} %`
          : `${subject.speedMps.toFixed(2)} m/s`,
        sub: subject.floats ? 'submerged' : 'sinking',
      };
    }
    return model;
  }

  /**
   * The reveal's caption (03 §wow, 19 §2.2) — written once the line-up has resolved.
   *
   * It carries BOTH beats, because the mercury shot is not one. Four metals float, at
   * fractions that are a division and not a table; and the two the scale cannot tell
   * apart — gold and tungsten, the whole bullion-fraud story — come apart on the way
   * down. Buoyancy subtracts the fluid's density from both, so a 7.3 % density gap
   * becomes a 29.6 % gap in driving force, and gold reaches the bottom first.
   *
   * Nothing here is authored text about physics: every number is read back out of the
   * running simulation.
   */
  #buildCaption(): void {
    if (this.#raceStart === null || this.#caption !== null) return;
    const floaters = this.#readings.filter((r) => r.floats);
    const sunk = [...this.#finish.values()].sort((a, b) => a.t - b.t);
    if (floaters.length + sunk.length < LINEUP.length) return;
    /*
     * Wait for every floater to be PARKED, not merely slow.
     *
     * The caption is written once and then stands, so it must not be latched mid-settle.
     * Judging by speed alone did exactly that: copper was still easing down at under
     * 0.02 m/s when the caption fired, and it reported 60 % submerged against its true
     * 66 % — which the cube then reached and held, leaving the headline number wrong
     * about the very thing the reveal exists to show. Parked means it has held its
     * analytic float pose for the full dwell, so the measured fraction and the exact
     * division have converged.
     */
    if (this.#readings.some((r) => r.speedMps > 0.02)) return;
    for (const r of floaters) {
      if ((this.#quiet.get(r.id)?.n ?? 0) < REST_DWELL) return;
    }

    const depths = floaters
      .slice()
      .sort((a, b) => b.frac - a.frac)
      .map((r) => `${r.metal} ${Math.round(r.frac * 100)} %`)
      .join(' · ');

    if (sunk.length >= 2) {
      const [first, second] = sunk as [
        { metal: MetalId; t: number },
        { metal: MetalId; t: number },
      ];
      const gapS = second.t - first.t;
      const gap = gapS.toFixed(2);
      /*
       * A dead heat is the OTHER half of the story, not a failure to report one. In
       * water gold and tungsten arrive together — indistinguishable, exactly as they are
       * on the scale — and it is mercury that pulls them apart.
       */
      const finish =
        gapS < 0.03
          ? `${first.metal} and ${second.metal} hit bottom together.`
          : `${first.metal} hit bottom ${gap} s before ${second.metal}.`;
      this.#caption =
        floaters.length > 0
          ? `${floaters.length} float — ${depths}. ${finish}`
          : `All six sank. ${finish}`;
    } else if (floaters.length > 0) {
      this.#caption = `${floaters.length} float — ${depths}.`;
    }
    if (this.#caption) this.#ctx?.ui.toast(this.#caption);
  }

  #status(): { text: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' } {
    const n = this.#readings.length;
    if (n === 0) return { text: `${FLUIDS[this.#fluid].label} — drop a cube in`, tone: 'neutral' };
    const floating = this.#readings.filter((r) => r.floats).length;
    if (floating === 0) return { text: `${n} in the tank — all sinking`, tone: 'neutral' };
    return { text: `${floating} of ${n} floating`, tone: 'ok' };
  }

  /** The cube the readouts describe: the one most recently in the fluid and moving. */
  #subject(): Reading | null {
    if (this.#readings.length === 0) return null;
    const wet = this.#readings.filter((r) => r.frac > 0);
    const pool = wet.length > 0 ? wet : this.#readings;
    return pool.reduce((a, b) => (b.speedMps > a.speedMps ? b : a), pool[0]!);
  }

  #setFluid(id: FluidId): void {
    if (id === this.#fluid) return;
    this.#fluid = id;
    this.#quiet.clear();
    this.#drops.length = 0;
    this.#waves.clear();
    this.#ripple?.clear();
    this.#raceStart = null;
    this.#finish.clear();
    this.#caption = null;
    this.#applyLook();
    this.#publish();
    this.#ctx?.ui.toast(`${FLUIDS[id].label} — ${FLUIDS[id].note}`);
  }

  /**
   * 19 §7.3: scripted, because this is 06's launch clip and it is the only staging that
   * guarantees the Au-vs-W finish (§2.2) is actually in frame.
   */
  #dropAll(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const e of [...ctx.entities.all]) ctx.entities.despawn(e.id);
    this.#quiet.clear();
    this.#wasWet.clear();
    this.#lastPose.clear();
    this.#pose.clear();

    const sideM = LINEUP_SIDE_IN * M_PER_IN;
    const gap = sideM * 1.35;
    const startX = -((LINEUP.length - 1) * gap) / 2;
    LINEUP.forEach((metal, i) => {
      ctx.entities.spawn(
        { metal, sideM, ...(metal === 'W' ? { purityPctW: 95 } : {}) },
        { x: startX + i * gap, y: SURFACE_Y + sideM * 1.6, z: 0 },
      );
    });
    /*
     * Arm the reveal. The caption is written from what the simulation DOES, so nothing
     * is promised here — the toast below only says what is about to be attempted.
     */
    this.#raceStart = this.#simT;
    this.#finish.clear();
    this.#caption = null;
    this.#frame(ctx);
    ctx.ui.toast(
      this.#fluid === 'mercury'
        ? 'Six metals into mercury — watch the bottom of the tank.'
        : `Six metals, one ${FLUIDS[this.#fluid].label.toLowerCase()} tank.`,
    );
  }

  afterPhysics(): void {
    this.#props?.capture();
    this.#buildCaption();
    this.#publish();
  }

  /**
   * The surface has to keep moving on the RENDER clock, not the fixed step: the water
   * is scenery, and freezing it whenever physics is quiet would make the whole tank
   * look paused.
   */
  render(dtAlpha: number): void {
    this.#props?.interpolate(dtAlpha);
    const dt = 1 / 60;

    /*
     * The heightfield runs on the RENDER clock. It is scenery, and freezing it whenever
     * physics is quiet would make the tank look paused; it also has to keep ringing
     * after the last cube has settled, which is exactly when a real tank still moves.
     */
    this.#flushDisplacement();
    const r = this.#ripple;
    if (r) r.step();
    this.#stepDroplets(dt);
    this.#stepCrown(dt);

    /*
     * Bind the field LAST, after every pass this frame has run.
     *
     * The ping-pong flips its front buffer on every pass — `step`, each `drop`, each
     * `displace`. Binding straight after `step()` meant that on any frame where a
     * droplet landed (a `drop`) the surface sampled the buffer that had just become the
     * BACK one, and on frames where none landed it sampled the front. The surface
     * therefore alternated between the current field and a stale one from frame to
     * frame, which is flicker in the literal sense — and invisible to a
     * "has anything changed" test, because plenty was changing either way.
     */
    const u = this.#surfaceUniforms;
    if (r && u) u['uHeight']!.value = r.texture;
    // The floor reads the same field, bound at the same moment for the same reason.
    if (r && this.#floorUniforms) this.#floorUniforms['uHeight']!.value = r.texture;
  }

  /** Ballistic droplets, retired on their own lifetime or when they fall back in. */
  #stepDroplets(dt: number): void {
    const g = config.physics.gravityMps2;
    /*
     * Compaction in place: survivors are written back at `w`, which never runs ahead of
     * the read cursor, so the array is safe to write while iterating it.
     */
    let w = 0;
    for (const d of this.#drops) {
      d.life -= dt;
      d.v.y -= g * dt;
      d.p.x += d.v.x * dt;
      d.p.y += d.v.y * dt;
      d.p.z += d.v.z * dt;
      /*
       * A landing droplet just retires. It used to ring the surface where it fell back
       * in, which is a nice touch and cost one full render-target switch EACH — dozens
       * per frame during a DROP ALL. Not worth it.
       */
      if (d.p.y <= SURFACE_Y && d.v.y < 0) continue;
      if (d.life <= 0) continue;
      this.#drops[w++] = d;
    }
    this.#drops.length = w;
    this.#writeDroplets();
  }

  /** Cubes enter from above the tank, never beside it. */
  preferredSpawnPoint(): Vec3 {
    return { x: 0, y: SURFACE_Y + 0.12, z: 0 };
  }

  reset(): void {
    const ctx = this.#ctx;
    if (ctx) {
      this.#frame(ctx);
      // The duck is the lab's own prop, so RESET has to put it back like any instrument
      // state — clearing the player's cubes does not touch it.
      if (this.#duck !== null) {
        ctx.physics.setTransform(this.#duck, duckStart(), true);
        this.#lastPose.delete(DUCK_ID);
      }
    }
    this.#quiet.clear();
    this.#wasWet.clear();
    this.#lastPose.clear();
    this.#pose.clear();
    this.#lastPose.clear();
    this.#pose.clear();
    this.#drops.length = 0;
    this.#waves.clear();
    this.#ripple?.clear();
    this.#raceStart = null;
    this.#finish.clear();
    this.#caption = null;
    this.#readings = [];
    this.#publish();
  }

  teardown(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const h of this.#bodies) ctx.physics.remove(h);
    for (const o of this.#objects) ctx.scene.remove(o);
    for (const d of this.#disposables) d.dispose();
    this.#bodies.length = 0;
    this.#objects.length = 0;
    this.#disposables.length = 0;
    this.#panel?.dispose();
    this.#panel = null;
    this.#fluidMat = null;
    this.#ripple?.dispose();
    this.#ripple = null;
    this.#surfaceMat = null;
    this.#surfaceUniforms = null;
    this.#absorbUniforms = null;
    this.#floorUniforms = null;
    this.#drops.length = 0;
    this.#dropPoints = null;
    this.#dropGeo = null;
    this.#crownMesh = null;
    this.#props = null;
    this.#duck = null;
    this.#quiet.clear();
    this.#wasWet.clear();
    this.#lastPose.clear();
    this.#pose.clear();
    this.#readings = [];
    this.#ctx = null;
  }
}
