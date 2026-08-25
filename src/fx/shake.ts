import { config } from '../config.ts';

/**
 * Camera shake (16 §10.1). An additive offset applied AFTER `CameraRig.update()` has
 * set the camera's position, so it leaves no residue in the rig's state and cannot
 * fight its damping. Deterministic: no random phase, a fixed phase offset between the
 * two axes. Off entirely under reduced motion (the app gates the application).
 */

/** `s = clamp(E_n/refJ, 0, 1)^0.5`, gated: below `minJ` an impact earns nothing. */
export function shakeScale(energyJ: number): number {
  const c = config.fx.shake;
  if (energyJ < c.minJ) return 0;
  return Math.sqrt(Math.max(0, Math.min(1, energyJ / c.refJ)));
}

export class CameraShake {
  /** Stacked intensity, saturating at 1 (a shower of impacts never exceeds A_max). */
  #s = 0;
  /** Seconds since the strongest live kick. */
  #t = 0;

  kick(energyJ: number): void {
    const s = shakeScale(energyJ);
    if (s <= 0) return;
    this.#s = Math.min(1, this.#s + s);
    this.#t = 0;
  }

  update(dtS: number): void {
    if (this.#s <= 0) return;
    this.#t += dtS;
    const c = config.fx.shake;
    // Envelope below floor: the shake is over. 4τ ≈ 2% residual.
    if (this.#t > c.tauS * 4) {
      this.#s = 0;
      this.#t = 0;
    }
  }

  get active(): boolean {
    return this.#s > 0;
  }

  /**
   * The offset at this instant, in metres, for a camera `distanceM` from its target
   * (`A = ampFrac · distance · s`: the same size ON SCREEN at any zoom).
   */
  offset(distanceM: number): { x: number; y: number } {
    if (this.#s <= 0) return { x: 0, y: 0 };
    const c = config.fx.shake;
    const a = c.ampFrac * distanceM * this.#s * Math.exp(-this.#t / c.tauS);
    const w = 2 * Math.PI * c.freqHz * this.#t;
    return { x: a * Math.sin(w), y: a * Math.sin(w + c.phaseRad) };
  }
}
