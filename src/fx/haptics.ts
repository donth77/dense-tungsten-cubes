import { config } from '../config.ts';

/**
 * The one haptics seam (16 §10.4). Capability-gated, never assumed: Android Chrome has
 * `navigator.vibrate`, iOS Safari does not (12 §4), and the physics test runner has no
 * `navigator` at all.
 */
function vibrate(ms: number): void {
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
