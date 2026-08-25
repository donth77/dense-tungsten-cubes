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
/** How `frameRadius` should frame a region — see the note inside it. */
export interface FrameOptions {
  /** 'stage': everything in view on both axes. 'subject': fit the height, let width overflow. */
  fit?: 'stage' | 'subject';
  /** Height of the look-at point, metres. Defaults to a little above the floor. */
  centreYM?: number;
  /** Breathing room as a multiple of the radius. */
  margin?: number;
}

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
  /** Replay-only tracking (16 §9.3): while set, the goal target follows this. */
  #follow: (() => Vec3 | null) | null = null;

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
  frameRadius(radiusM: number, opts: FrameOptions = {}): void {
    this.#lastFrame = { radiusM, opts };
    const fit = opts.fit ?? 'stage';
    const vFov = (config.camera.fovDeg * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    /*
     * 'stage' fits both axes so the whole thing is in view; 'subject' fits the height
     * only and lets the surroundings run off the sides.
     *
     * Which one is the LAB's call, not the layout's. The Sandbox frames a cube — the
     * point of the toy — in front of mats that are scenery, and fitting 1.1 m of mats
     * across a portrait phone's 18-degree horizontal field put the camera 4.3 m away and
     * made a 2 in cube a dot. The balance is the opposite case: 1.06 m wide and the
     * subject itself, so on the same phone the height-only fit cropped both pans and the
     * top of the stand. One rule cannot serve both, and the lab knows which it is.
     */
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const margin = radiusM * (opts.margin ?? 1.25);
    const byHeight = margin / Math.tan(vFov / 2);
    const byWidth = margin / Math.tan(hFov / 2);
    const needed = fit === 'subject' ? byHeight : Math.max(byHeight, byWidth);
    this.#goal.distM = clamp(needed, config.camera.distMinM, config.camera.distMaxM);
    this.#goal.target.set(
      config.camera.target.x,
      opts.centreYM ?? radiusM * 0.12,
      config.camera.target.z,
    );
  }

  /**
   * Re-applies the last frame at the current aspect. The layout manager calls this on
   * resize and orientation change (12 §3: "re-fit the camera distance so the stage still
   * frames"), which is the only time the fit can change without a lab asking.
   */
  refit(): void {
    if (this.#lastFrame) this.frameRadius(this.#lastFrame.radiusM, this.#lastFrame.opts);
  }

  #lastFrame: { radiusM: number; opts: FrameOptions } | null = null;

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
    if (this.#follow) {
      const p = this.#follow();
      // Straight onto the GOAL, through the same damping as every other camera move,
      // and past pan's clamps — a cube 20 m up is exactly what this exists to watch.
      if (p) this.#goal.target.set(p.x, p.y, p.z);
    }
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

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  /**
   * Install or clear the follow source. The ONE sanctioned auto-motion (16 §9.3): it
   * runs only inside a replay the player started, and the caller must not install it
   * under reduced motion. Cleared, the goal target stays where the follow left it —
   * the caller re-frames.
   */
  follow(get: (() => Vec3 | null) | null): void {
    this.#follow = get;
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
