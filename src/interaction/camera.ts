import * as THREE from 'three';
import { config } from '../config.ts';
import type { Vec3 } from '../types.ts';

const DEG = Math.PI / 180;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * CameraRig — spherical orbit with goal-state damping (08 §8.5).
 *
 * Custom rather than OrbitControls (08 §2.5): gesture arbitration needs to own the
 * pointer pipeline, because one finger means The Hand *or* orbit depending on what the
 * ray hits, and fighting OrbitControls' internal state machine costs more than the
 * ~150 lines a spherical rig takes.
 *
 * The camera never moves without a hand on it — no auto-orbit, no pull-focus. That's
 * the motion-sickness rule, and it also means the toy never appears to act on its own.
 */
export class CameraRig {
  /** Where we're going. */
  #goal = {
    azimuthRad: config.camera.azimuthDeg * DEG,
    elevationRad: config.camera.elevationDeg * DEG,
    distM: config.camera.distanceM,
    target: new THREE.Vector3(
      config.camera.target.x,
      config.camera.target.y,
      config.camera.target.z,
    ),
  };
  /** Where we are. Chases #goal exponentially. */
  #state = {
    azimuthRad: this.#goal.azimuthRad,
    elevationRad: this.#goal.elevationRad,
    distM: this.#goal.distM,
    target: this.#goal.target.clone(),
  };

  // Scratch for pan — no allocation per pointer move.
  readonly #fwd = new THREE.Vector3();
  readonly #right = new THREE.Vector3();
  readonly #up = new THREE.Vector3();

  #viewOffsetPx = { x: 0, y: 0 };
  #reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(readonly camera: THREE.PerspectiveCamera) {
    this.#apply();
  }

  // ---- input-driven goals ------------------------------------------------------

  orbit(dxPx: number, dyPx: number): void {
    this.#goal.azimuthRad -= dxPx * config.camera.orbitSpeed;
    this.#goal.elevationRad = clamp(
      this.#goal.elevationRad + dyPx * config.camera.orbitSpeed,
      config.camera.polarMinDeg * DEG,
      config.camera.polarMaxDeg * DEG,
    );
  }

  /** @param delta positive zooms out. Scaled by current distance so it feels linear. */
  dolly(delta: number): void {
    this.#goal.distM = clamp(
      this.#goal.distM * (1 + delta * config.camera.dollySpeed),
      config.camera.distMinM,
      config.camera.distMaxM,
    );
  }

  /**
   * Slide the look-at target across the stage.
   *
   * Pan is the classic way to get lost in a 3D view, so two things bound it: the target
   * is clamped to the play area (you cannot end up staring at empty concrete two metres
   * from anything), and the movement scales with distance so it feels identical zoomed
   * right in or right out.
   *
   * 08 §8.5 didn't include pan and I argued against adding it — the objection was that
   * it strands people and that touch had no free gesture. A discoverable help panel and
   * a visible Reset View button answer the first; three fingers answer the second.
   */
  pan(dxPx: number, dyPx: number): void {
    const scale = this.#state.distM * config.camera.panSpeed;
    this.camera.getWorldDirection(this.#fwd);
    this.#right.crossVectors(this.#fwd, WORLD_UP).normalize();
    // Screen-up in the ground plane, so panning tracks the floor rather than the sky.
    this.#up.crossVectors(this.#right, this.#fwd).normalize();

    this.#goal.target
      .addScaledVector(this.#right, -dxPx * scale)
      .addScaledVector(this.#up, dyPx * scale);

    const lim = config.camera.panLimitM;
    this.#goal.target.x = clamp(this.#goal.target.x, -lim, lim);
    this.#goal.target.z = clamp(this.#goal.target.z, -lim, lim);
    this.#goal.target.y = clamp(this.#goal.target.y, 0, config.camera.panLimitYM);
  }

  /** Gentle re-target onto a selected cube. Deliberately does not orbit (08 §8.5). */
  focusOn(point: Vec3): void {
    this.#goal.target.set(point.x, point.y, point.z);
  }

  reset(sideM?: number): void {
    this.#goal.azimuthRad = config.camera.azimuthDeg * DEG;
    this.#goal.elevationRad = config.camera.elevationDeg * DEG;
    this.#goal.target.set(config.camera.target.x, config.camera.target.y, config.camera.target.z);
    if (sideM !== undefined) this.frameFor(sideM);
    else this.#goal.distM = config.camera.distanceM;
  }

  /**
   * Pull back to whatever distance frames a cube of this size (see config.distancePerSide).
   *
   * Only called at boot and on an explicit reset — NOT on every spawn. Re-framing each
   * time a cube appears would move the camera without a hand on it, which is the one
   * thing the rig promises never to do.
   */
  frameFor(sideM: number): void {
    this.#goal.distM = clamp(
      sideM * config.camera.distancePerSide,
      config.camera.distMinM,
      config.camera.distMaxM,
    );
    this.#goal.target.set(
      config.camera.target.x,
      Math.max(sideM * 1.2, 0.05),
      config.camera.target.z,
    );
  }

  /**
   * Frame a region of this radius around the stage centre.
   *
   * `frameFor(sideM)` frames a single cube, which is right on boot but wrong the moment
   * a lab lays out mats over a metre and a half — the default view would show one cube
   * and a wall of oak. A lab declares its own extent and this frames that instead.
   */
  frameRadius(radiusM: number): void {
    const vFov = (config.camera.fovDeg * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    // Fit BOTH axes. Fitting only the vertical looks right on a 16:9 desktop and then
    // hangs a lab's mats off both sides of a portrait phone, where the horizontal field
    // of view is the narrow one.
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const needed = Math.max(
      (radiusM * 1.25) / Math.tan(vFov / 2),
      (radiusM * 1.25) / Math.tan(hFov / 2),
    );
    this.#goal.distM = clamp(needed, config.camera.distMinM, config.camera.distMaxM);
    this.#goal.target.set(config.camera.target.x, radiusM * 0.12, config.camera.target.z);
  }

  /**
   * The camera has to know about the UI (12 §3): with a bottom sheet open, the visual
   * centre of the *free* area is well above the centre of the canvas, so a cube framed
   * at the geometric centre sits behind the sheet.
   *
   * @param yPx shift framed content up by this many CSS px (phone-portrait)
   * @param xPx shift framed content left by this many CSS px (landscape rail)
   */
  setViewportOffset(xPx: number, yPx: number): void {
    this.#viewOffsetPx = { x: xPx, y: yPx };
    this.#applyViewOffset();
  }

  #applyViewOffset(): void {
    const el = this.camera as THREE.PerspectiveCamera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.#viewOffsetPx.x === 0 && this.#viewOffsetPx.y === 0) {
      el.clearViewOffset();
      return;
    }
    el.setViewOffset(w, h, this.#viewOffsetPx.x, this.#viewOffsetPx.y, w, h);
  }

  // ---- per-frame ---------------------------------------------------------------

  /**
   * Framerate-independent exponential damping: state += (goal − state)·(1 − e^(−λ·dt)).
   * Using a fixed lerp factor instead would make the camera feel different at 30 fps
   * than at 120, which is exactly the class of bug that only shows up on someone
   * else's device.
   */
  update(dtS: number): void {
    const lambda = this.#reducedMotion ? config.camera.lambdaReducedMotion : config.camera.lambda;
    const k = 1 - Math.exp(-lambda * Math.min(dtS, 0.1));

    this.#state.azimuthRad += (this.#goal.azimuthRad - this.#state.azimuthRad) * k;
    this.#state.elevationRad += (this.#goal.elevationRad - this.#state.elevationRad) * k;
    this.#state.distM += (this.#goal.distM - this.#state.distM) * k;
    this.#state.target.lerp(this.#goal.target, k);
    this.#apply();
  }

  #apply(): void {
    const { azimuthRad: az, elevationRad: el, distM: d, target } = this.#state;
    const ce = Math.cos(el);
    this.camera.position.set(
      target.x + d * ce * Math.sin(az),
      target.y + d * Math.sin(el),
      target.z + d * ce * Math.cos(az),
    );
    this.camera.lookAt(target);
  }

  onResize(): void {
    this.#applyViewOffset();
  }

  setReducedMotion(reduced: boolean): void {
    this.#reducedMotion = reduced;
  }

  get distance(): number {
    return this.#state.distM;
  }
  get target(): THREE.Vector3 {
    return this.#state.target;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
