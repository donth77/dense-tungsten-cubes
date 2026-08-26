import { config } from '../config.ts';

/**
 * The one haptics seam (16 §10.4). Capability-gated, never assumed: Android Chrome has
 * `navigator.vibrate`, iOS Safari does not (12 §4), and the physics test runner has no
 * `navigator` at all.
 */
/**
 * Browsers refuse `navigator.vibrate` before the page has been touched, and log a
 * console error for every attempt. The capability gate below is not enough on its
 * own: a phone or tablet HAS the API, so a cube landing at boot — which is exactly
 * what the Sandbox does — buzzed the error out before the player had touched
 * anything (smoke caught it on the tablet viewport, 2026-08-26). The app arms this
 * from the same first gesture that unlocks audio.
 */
let gestured = false;
export function enableHaptics(): void {
  gestured = true;
}

function vibrate(ms: number): void {
  if (!gestured) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(ms);
  }
}

/** The slider's detent tick. */
export function hapticTick(): void {
  vibrate(config.fx.hapticTickMs);
}

/** An impact's thump, scaled by intensity 0..1 (the FX bus computes it from energy). */
export function hapticImpact(intensity01: number): void {
  const s = Math.max(0, Math.min(1, intensity01));
  vibrate(Math.round(config.fx.hapticImpactBaseMs + config.fx.hapticImpactScaleMs * s));
}
