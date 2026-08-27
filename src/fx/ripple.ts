import * as THREE from 'three';

/**
 * A GPU ripple heightfield — the Evan Wallace / jeantimex water technique (04, 07, 11 §5).
 *
 * The surface is a texture, not geometry: `r` holds height and `g` holds vertical
 * velocity, and one pass of the discrete wave equation is run per frame over a
 * ping-ponged pair of render targets. Anything that touches the water writes a bump into
 * that texture with `drop()`, and the wave equation does the rest — the ring spreads,
 * reflects off the tank walls, interferes with its neighbours and decays, none of which
 * is authored anywhere.
 *
 * This is what a scrolling normal map cannot do. A normal map moves the same wave across
 * the surface forever no matter what happens in the tank; a heightfield actually knows
 * where the cube went in.
 *
 * Boundaries are `ClampToEdge`, so waves bounce off the glass instead of wrapping — the
 * correct behaviour for a tank and the wrong one for an ocean.
 */

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/*
 * One step of the wave equation. The neighbour average minus the centre is the discrete
 * Laplacian; feeding it into velocity and velocity into height is what propagates.
 */
const SIM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform float uTexel;
uniform float uDamping;
uniform float uSettle;
varying vec2 vUv;
void main() {
  vec2 info = texture2D(uField, vUv).rg;
  float avg = (
    texture2D(uField, vUv + vec2(uTexel, 0.0)).r +
    texture2D(uField, vUv - vec2(uTexel, 0.0)).r +
    texture2D(uField, vUv + vec2(0.0, uTexel)).r +
    texture2D(uField, vUv - vec2(0.0, uTexel)).r
  ) * 0.25;
  info.g += (avg - info.r) * 2.0;
  info.g *= uDamping;
  info.r += info.g;

  /*
   * Pull height back toward flat as well as damping velocity. Damping velocity alone
   * conserves any offset the field has drifted to, so the surface can hold a shape
   * forever.
   */
  info.r *= uSettle;

  /*
   * THE DEADZONE, and the reason it is not optional.
   *
   * These targets are HALF float: ten bits of mantissa. Below a certain amplitude the
   * decrement is smaller than one ulp, the value stops decaying and dithers in its last
   * bit instead — so the field never reaches flat, it lands on a permanent noise floor.
   * Multiplied by the surface's normal scale that reads as a surface which shimmers
   * forever and never settles, which is exactly what it looked like (measured: the
   * frame-to-frame difference was still 10k at 8 s and would not go to zero).
   *
   * Snapping the last sliver to exactly zero is what makes still water actually still.
   */
  if (abs(info.r) < 0.012 && abs(info.g) < 0.004) info = vec2(0.0);

  gl_FragColor = vec4(info, 0.0, 1.0);
}
`;

/** A raised-cosine bump, so a drop has soft shoulders instead of a hard disc. */
const DROP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStrength;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 info = texture2D(uField, vUv).rg;
  vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
  float drop = max(0.0, 1.0 - length(d) / uRadius);
  drop = 0.5 - cos(drop * 3.14159265) * 0.5;
  info.r += drop * uStrength;
  gl_FragColor = vec4(info, 0.0, 1.0);
}
`;

/**
 * Volume displacement — the reference's `moveSphere`, which is the half that makes a body
 * and the water look coupled.
 *
 * It is NOT a ripple trigger. Each frame the body's OLD displaced volume is added back
 * and its NEW one subtracted, so a submerged body holds a persistent depression that
 * travels with it, and the water closes behind it on its own. Injecting one-shot bumps
 * instead gives a cube that rings the surface and then sits in perfectly flat water,
 * which is the thing that reads as wrong however good the wave equation underneath is.
 *
 * `c.z` is the body centre's height above the surface in radius units, so the smooth
 * `exp(-(1.5t)^6)` profile is clipped by how much of the body is actually below the
 * waterline — a body well clear of the surface displaces nothing.
 */
/**
 * Volume displacement — the reference's `moveSphere`, batched.
 *
 * It is NOT a ripple trigger. Each frame every body's OLD displaced volume is added back
 * and its NEW one subtracted, so a submerged body holds a persistent depression that
 * travels with it and the water closes behind it.
 *
 * ALL bodies are handled in ONE pass. The first cut ran a pass per body per physics
 * step — six cubes at 60 Hz is 360 render-target switches a second, which a software
 * rasteriser shrugs off and a real (especially tiled) GPU does not, because every switch
 * costs a tile flush. That is a stutter you cannot see in a headless benchmark.
 */
const MAX_BODIES = 8;

const DISPLACE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform vec4 uPrev[${MAX_BODIES}];
uniform vec4 uCurr[${MAX_BODIES}];
uniform int uCount;
uniform float uAspect;
uniform float uScale;
varying vec2 vUv;

/*
 * How much of the body sits BELOW the waterline over this texel. c.xy is the body centre
 * in uv, c.z its height above the surface in radius units, c.w its radius in uv.
 *
 * The reference clips with ymin = min(0, cy - dy) and ymax = min(max(0, cy + dy),
 * ymin + 2dy), which is correct only while the body stays near the water — its demo
 * keeps the sphere in the pool. Fed a body well ABOVE the surface it returns 2dy, a
 * large spurious displacement, which is what a cube resting on the tank floor produced
 * here. Clipping the body span to the half-space below y = 0 is unconditional.
 */
float volumeAt(vec4 c) {
  vec2 d = (vUv - c.xy) * vec2(uAspect, 1.0);
  float t = length(d) / max(c.w, 1e-5);
  float dy = exp(-pow(t * 1.5, 6.0));
  float bottom = c.z - dy;
  float top = c.z + dy;
  return max(0.0, min(top, 0.0) - min(bottom, 0.0)) * uScale;
}

void main() {
  vec2 info = texture2D(uField, vUv).rg;
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i >= uCount) break;
    info.r += volumeAt(uPrev[i]);
    info.r -= volumeAt(uCurr[i]);
  }
  gl_FragColor = vec4(info, 0.0, 1.0);
}
`;

export class RippleField {
  readonly #renderer: THREE.WebGLRenderer;
  readonly #targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly #quad: THREE.Mesh;
  readonly #sim: THREE.ShaderMaterial;
  readonly #drop: THREE.ShaderMaterial;
  readonly #displace: THREE.ShaderMaterial;
  #cur = 0;

  /**
   * @param size field resolution; 256 is plenty for a tank and costs two small passes.
   * @param aspect width / depth of the surface, so a drop stays round on a long tank.
   */
  constructor(renderer: THREE.WebGLRenderer, size = 256, aspect = 1) {
    this.#renderer = renderer;
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.#targets = [
      new THREE.WebGLRenderTarget(size, size, opts),
      new THREE.WebGLRenderTarget(size, size, opts),
    ];

    this.#sim = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
      uniforms: {
        uField: { value: null },
        uTexel: { value: 1 / size },
        uDamping: { value: 0.985 },
        uSettle: { value: 0.995 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.#drop = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: DROP_FRAG,
      uniforms: {
        uField: { value: null },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uRadius: { value: 0.05 },
        uStrength: { value: 0.1 },
        uAspect: { value: aspect },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.#displace = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: DISPLACE_FRAG,
      uniforms: {
        uField: { value: null },
        uPrev: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
        uCurr: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
        uCount: { value: 0 },
        uAspect: { value: aspect },
        uScale: { value: 0.1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.#quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.#sim);
    this.#quad.frustumCulled = false;
    this.#scene.add(this.#quad);
    this.clear();
  }

  /** The live height/velocity field. Bind this into a surface material. */
  get texture(): THREE.Texture {
    return this.#targets[this.#cur]!.texture;
  }

  set damping(v: number) {
    this.#sim.uniforms['uDamping']!.value = v;
  }

  /** How fast height is pulled back to flat; 1 = never. */
  set settle(v: number) {
    this.#sim.uniforms['uSettle']!.value = v;
  }

  /**
   * Flat, still water.
   *
   * The clear colour is forced to opaque black and restored afterwards. `clear()` uses
   * whatever the renderer's current clear colour happens to be, which is the scene's
   * background — so a fresh field started at that value instead of zero, every vertex
   * was displaced by it, and the surface rendered as an enormous tilted sheet hanging
   * outside the tank. Height must start at exactly 0.
   */
  clear(): void {
    const prevTarget = this.#renderer.getRenderTarget();
    const prevColor = new THREE.Color();
    this.#renderer.getClearColor(prevColor);
    const prevAlpha = this.#renderer.getClearAlpha();
    this.#renderer.setClearColor(0x000000, 1);
    for (const t of this.#targets) {
      this.#renderer.setRenderTarget(t);
      this.#renderer.clear(true, false, false);
    }
    this.#renderer.setClearColor(prevColor, prevAlpha);
    this.#renderer.setRenderTarget(prevTarget);
  }

  #pass(material: THREE.ShaderMaterial): void {
    const src = this.#targets[this.#cur]!;
    const dst = this.#targets[this.#cur ^ 1]!;
    material.uniforms['uField']!.value = src.texture;
    this.#quad.material = material;
    const prevTarget = this.#renderer.getRenderTarget();
    this.#renderer.setRenderTarget(dst);
    this.#renderer.render(this.#scene, this.#camera);
    this.#renderer.setRenderTarget(prevTarget);
    this.#cur ^= 1;
  }

  /** Advance the simulation one frame. */
  step(): void {
    this.#pass(this.#sim);
  }

  /**
   * Disturb the surface. `u`/`v` are 0..1 across the surface; positive strength pushes
   * the water DOWN, which is what an entering object does.
   */
  drop(u: number, v: number, radius: number, strength: number): void {
    this.#drop.uniforms['uCenter']!.value.set(u, v);
    this.#drop.uniforms['uRadius']!.value = radius;
    this.#drop.uniforms['uStrength']!.value = strength;
    this.#pass(this.#drop);
  }

  /**
   * Move every displacing body from its previous pose to its current one, in a single
   * pass. Each entry is (u, v, yInRadii, radiusInUv); arrays are packed vec4s.
   */
  displaceBatch(prev: Float32Array, curr: Float32Array, count: number, scale: number): void {
    if (count <= 0) return;
    const u = this.#displace.uniforms;
    const p = u['uPrev']!.value as THREE.Vector4[];
    const c = u['uCurr']!.value as THREE.Vector4[];
    const n = Math.min(count, MAX_BODIES);
    for (let i = 0; i < n; i++) {
      p[i]!.set(prev[i * 4]!, prev[i * 4 + 1]!, prev[i * 4 + 2]!, prev[i * 4 + 3]!);
      c[i]!.set(curr[i * 4]!, curr[i * 4 + 1]!, curr[i * 4 + 2]!, curr[i * 4 + 3]!);
    }
    u['uCount']!.value = n;
    u['uScale']!.value = scale;
    this.#pass(this.#displace);
  }

  dispose(): void {
    for (const t of this.#targets) t.dispose();
    this.#quad.geometry.dispose();
    this.#sim.dispose();
    this.#drop.dispose();
    this.#displace.dispose();
  }
}
