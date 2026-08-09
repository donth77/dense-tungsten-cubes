import { config } from '../config.ts';

export interface Stepper {
  /** Fixed 60 Hz. The order inside this is a contract (08 §7). */
  fixedStep(dt: number): void;
  /** @param alpha interpolation factor in [0,1) between the last two fixed states. */
  renderStep(alpha: number, dtFrameS: number): void;
}

/**
 * Fixed-timestep accumulator with render interpolation (08 §7, 05's core loop).
 *
 * Physics runs at exactly 60 Hz regardless of display refresh, so a 120 Hz monitor and
 * a 30 fps phone simulate identically — which is what makes tuned constants mean the
 * same thing on every device. Rendering interpolates between the last two fixed states,
 * so motion is smooth even when the two rates disagree.
 */
export class Loop {
  #raf = 0;
  #last = 0;
  #acc = 0;
  #running = false;

  /** Rolling frame-time stats for the fps probe and dynamic resolution. */
  #frameMs = 16.7;
  #slowFrames = 0;

  constructor(private readonly stepper: Stepper) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    this.#acc = 0;
    this.#raf = requestAnimationFrame(this.#frame);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
  }

  readonly #frame = (now: number): void => {
    if (!this.#running) return;
    const dtFrameS = (now - this.#last) / 1000;
    // The clamp guards the tab-return spiral: without it, coming back after a minute
    // in another tab tries to simulate a minute of physics in one frame, which stalls
    // hard enough to look like a crash.
    this.#acc += Math.min(dtFrameS, config.loop.accumulatorClampS);
    this.#last = now;

    const DT = config.loop.DT;
    while (this.#acc >= DT) {
      this.stepper.fixedStep(DT);
      this.#acc -= DT;
    }
    this.stepper.renderStep(this.#acc / DT, dtFrameS);

    // Exponential moving average — one slow frame is noise, thirty in a row is a device.
    this.#frameMs += (dtFrameS * 1000 - this.#frameMs) * 0.1;
    this.#slowFrames = dtFrameS * 1000 > config.quality.slowFrameMs ? this.#slowFrames + 1 : 0;

    this.#raf = requestAnimationFrame(this.#frame);
  };

  get fps(): number {
    return this.#frameMs > 0 ? 1000 / this.#frameMs : 0;
  }
  get frameMs(): number {
    return this.#frameMs;
  }
  /** True once frames have been slow long enough to justify dropping resolution (12 §5). */
  get sustainedSlow(): boolean {
    return this.#slowFrames >= config.quality.slowFrameCount;
  }
  resetSlowCounter(): void {
    this.#slowFrames = 0;
  }
  get running(): boolean {
    return this.#running;
  }
}
