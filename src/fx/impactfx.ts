import type { ImpactEvent, SurfaceId } from '../types.ts';
import { config } from '../config.ts';
import { CameraShake, shakeScale } from './shake.ts';
import { hapticImpact } from './haptics.ts';
import type { ImpactPuffs } from './particles.ts';
import type { DecalSystem } from './decals.ts';

const SURFACE_IDS: readonly SurfaceId[] = [
  'concrete',
  'steel',
  'oak',
  'rubber',
  'foam',
  'ice',
  'sand',
  'trampoline',
];

/**
 * The one bus consumer that turns an ImpactEvent into juice (16 §10): shake, puffs,
 * decal marks, and the haptic thump, each behind its own energy gate. Never in the
 * physics path — the app forwards events from the fan-out (step 7).
 */
export class ImpactFx {
  readonly shake = new CameraShake();

  constructor(
    private readonly puffs: ImpactPuffs,
    private readonly decals: DecalSystem,
    /** Low quality tier — the adaptive-resolution scaler is already the judge. */
    private readonly lowTier: () => boolean,
    private readonly reducedMotion: () => boolean,
  ) {}

  onImpact(ev: ImpactEvent): void {
    const s = shakeScale(ev.energyJ);
    this.shake.kick(ev.energyJ);
    if (ev.energyJ >= config.fx.hapticImpactMinJ) hapticImpact(s);
    const surface =
      typeof ev.b === 'string' && (SURFACE_IDS as readonly string[]).includes(ev.b)
        ? (ev.b as SurfaceId)
        : null;
    if (surface) {
      this.puffs.burst(ev.point, surface, s, ev.energyJ, {
        lowTier: this.lowTier(),
        reducedMotion: this.reducedMotion(),
      });
      this.decals.mark(ev.point, ev.energyJ, this.lowTier());
    }
  }
}
