import { config } from '../config.ts';
import { SURFACES } from '../data/surfaces.ts';
import type { EventBus } from '../core/events.ts';
import type { ImpactEvent, MetalId, SurfaceId } from '../types.ts';

/**
 * AudioBus — the impact voice matrix (08 §8.7). Half the product is the thud.
 *
 * M0 SYNTHESISES its voices rather than loading samples. Two reasons: it unblocks the
 * M0 gate ("a non-developer drops the cube and reacts audibly") with zero asset
 * downloads, and modal synthesis is genuinely the right tool for metal — tungsten's
 * dead "TUNK" is a heavily damped low mode with almost no ring, which is easier to
 * synthesise convincingly than to find as a sample.
 *
 * The buffers are rendered ONCE at unlock into the same AudioBuffer pool that samples
 * will occupy, so swapping in the Kenney CC0 set at M1 changes where a buffer comes
 * from and nothing else (08 §12).
 */

export type VoiceId =
  | 'thud_deep'
  | 'clank_al'
  | 'ring_cu'
  | 'tink_ti'
  | 'ring_fe'
  | 'ring_steel'
  | 'knock_oak'
  | 'thump_rubber'
  | 'fumpf_foam'
  | 'tick_ice'
  | 'crack_concrete';

export interface VoiceRecipe {
  /** Fundamental of the metallic body, Hz. */
  freq: number;
  /** Inharmonic partial ratios. Inharmonicity is what makes metal read as metal. */
  partials: number[];
  /** Time to −60 dB for the fundamental, seconds. */
  decayS: number;
  /** Transient noise burst: level, bandpass centre, decay. */
  noise: number;
  noiseHz: number;
  noiseDecayS: number;
  noiseQ: number;
  /** Optional low-frequency body thump under everything. */
  thump?: number;
  thumpHz?: number;
}

/**
 * 02 §10's voice descriptions, as numbers. The characteristic is the *decay*: copper
 * rings for the best part of a second, tungsten is over in 80 ms. That contrast is
 * doing as much work as the pitch is.
 */
export const RECIPES: Record<VoiceId, VoiceRecipe> = {
  // W — dead "TUNK". Almost no ring: WHA is dense and internally damped.
  thud_deep: {
    freq: 104,
    partials: [1, 2.31, 3.84],
    decayS: 0.085,
    noise: 0.55,
    noiseHz: 480,
    noiseDecayS: 0.03,
    noiseQ: 0.9,
    thump: 0.7,
    thumpHz: 52,
  },
  clank_al: {
    freq: 690,
    // 6.31, not 6.03: a partial that close to a 6x harmonic makes the clank read as a
    // musical note rather than a struck object. Caught by the inharmonicity unit test.
    partials: [1, 2.42, 4.11, 6.31],
    decayS: 0.26,
    noise: 0.5,
    noiseHz: 2600,
    noiseDecayS: 0.02,
    noiseQ: 1.4,
  },
  ring_cu: {
    freq: 523,
    partials: [1, 2.76, 5.4, 8.93],
    decayS: 0.92,
    noise: 0.3,
    noiseHz: 3200,
    noiseDecayS: 0.015,
    noiseQ: 1.6,
  },
  tink_ti: {
    freq: 905,
    partials: [1, 2.68, 5.12, 7.9],
    decayS: 0.34,
    noise: 0.42,
    noiseHz: 4200,
    noiseDecayS: 0.012,
    noiseQ: 1.8,
  },
  ring_fe: {
    freq: 372,
    partials: [1, 2.57, 4.72, 7.3],
    decayS: 0.52,
    noise: 0.38,
    noiseHz: 1900,
    noiseDecayS: 0.02,
    noiseQ: 1.3,
  },
  ring_steel: {
    freq: 1420,
    partials: [1, 2.44, 4.9, 7.1],
    decayS: 0.7,
    noise: 0.35,
    noiseHz: 5200,
    noiseDecayS: 0.012,
    noiseQ: 2.0,
  },
  knock_oak: {
    freq: 214,
    partials: [1, 3.1, 5.6],
    decayS: 0.115,
    noise: 0.6,
    noiseHz: 1100,
    noiseDecayS: 0.025,
    noiseQ: 0.8,
  },
  thump_rubber: {
    freq: 88,
    partials: [1, 2.1],
    decayS: 0.07,
    noise: 0.3,
    noiseHz: 330,
    noiseDecayS: 0.03,
    noiseQ: 0.6,
  },
  fumpf_foam: {
    freq: 70,
    partials: [1],
    decayS: 0.05,
    noise: 0.85,
    noiseHz: 300,
    noiseDecayS: 0.055,
    noiseQ: 0.5,
  },
  tick_ice: {
    freq: 2250,
    partials: [1, 2.9, 5.7],
    decayS: 0.055,
    noise: 0.7,
    noiseHz: 6500,
    noiseDecayS: 0.008,
    noiseQ: 2.4,
  },
  crack_concrete: {
    freq: 168,
    partials: [1, 2.9, 4.6],
    decayS: 0.09,
    noise: 0.95,
    noiseHz: 1500,
    noiseDecayS: 0.035,
    noiseQ: 0.7,
  },
};

const METAL_VOICE: Record<MetalId, VoiceId> = {
  W: 'thud_deep',
  Al: 'clank_al',
  Cu: 'ring_cu',
  Ti: 'tink_ti',
  Fe: 'ring_fe',
};

/** Which metal "wins" a cube-on-cube collision — the harder hitter speaks (08 §8.7). */
const METAL_HARDNESS: Record<MetalId, number> = { W: 5, Fe: 4, Ti: 3, Cu: 2, Al: 1 };

export class AudioBus {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #buffers = new Map<VoiceId, AudioBuffer>();
  /** Live sources per voice, for the oldest-steals polyphony cap. */
  #live = new Map<VoiceId, AudioBufferSourceNode[]>();
  #muted = false;
  #unlocking = false;

  constructor(private readonly bus: EventBus) {
    this.bus.on('impact', this.#onImpact);
  }

  /**
   * iOS will not start an AudioContext outside a user gesture, so this is called from
   * the first pointerdown. It also has to be re-armed on `visibilitychange`, or sound
   * silently dies after the first phone call (12 §5).
   */
  async unlock(): Promise<void> {
    if (this.#ctx || this.#unlocking) {
      await this.#ctx?.resume();
      return;
    }
    this.#unlocking = true;
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = config.audio.masterGain;
      master.connect(ctx.destination);
      this.#ctx = ctx;
      this.#master = master;

      for (const id of Object.keys(RECIPES) as VoiceId[]) {
        this.#buffers.set(id, renderVoice(ctx, RECIPES[id]));
      }
      await ctx.resume();
      document.addEventListener('visibilitychange', this.#onVisibility);
    } finally {
      this.#unlocking = false;
    }
  }

  readonly #onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.#ctx?.resume();
  };

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#master) this.#master.gain.value = muted ? 0 : config.audio.masterGain;
  }
  get muted(): boolean {
    return this.#muted;
  }
  get ready(): boolean {
    return this.#ctx !== null;
  }

  readonly #onImpact = (ev: ImpactEvent): void => {
    if (!this.#ctx || this.#muted) return;
    const voice = this.#pickVoice(ev);
    if (!voice) return;

    // gain = clamp01((log10(E) + 2) / 3.5): 0.01 J whispers, 300 J is full scale.
    const gain = clamp01(
      (Math.log10(Math.max(ev.energyJ, 1e-6)) + config.audio.gainOffset) / config.audio.gainRange,
    );
    if (gain <= 0.001) return;

    const side = this.#sideHint(ev);
    // Small cubes ring higher. 2" is the reference pitch.
    const rate =
      (config.audio.pitchRefSideM / side) ** config.audio.pitchExp *
      (1 + (Math.random() * 2 - 1) * config.audio.pitchJitter);

    this.#play(voice, gain, rate);

    // Tungsten's sub-bass signature: a low sine layered under a hard hit. This is the
    // channel that carries mass when the speaker is a phone and can't reproduce 50 Hz
    // properly — you feel the envelope even when you can't hear the fundamental.
    if (this.#isTungsten(ev) && ev.energyJ > config.audio.subLayerMinEnergyJ) {
      this.#playSub(gain, ev.energyJ);
    }
  };

  #play(voice: VoiceId, gain: number, rate: number): void {
    const ctx = this.#ctx!;
    const buf = this.#buffers.get(voice);
    if (!buf) return;

    const list = this.#live.get(voice) ?? [];
    // Oldest-steals: a machine-gun of clangs is worse than a dropped one.
    while (list.length >= config.audio.polyphony) {
      const oldest = list.shift();
      try {
        oldest?.stop();
      } catch {
        /* already ended */
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.#master!);
    src.onended = () => {
      const i = list.indexOf(src);
      if (i >= 0) list.splice(i, 1);
    };
    src.start();
    list.push(src);
    this.#live.set(voice, list);
  }

  #playSub(gain: number, energyJ: number): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const level = Math.min(0.55, gain * 0.5 * Math.log10(energyJ) * 0.5);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(64, t);
    // A falling pitch is what a heavy thing landing sounds like; a static tone is a beep.
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(level, 0.001), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(g).connect(this.#master!);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  // ---- voice selection ---------------------------------------------------------
  // M0 has no EntityStore lookup wired in here yet, so the impact carries what it can.
  // At M1 (step 15) this reads the real specs off both entities. The shape does not change.

  #hints = new Map<number, { metal: MetalId; sideM: number }>();
  /** Registered by the app on spawn so the bus can name a voice without importing core/. */
  registerEntity(id: number, metal: MetalId, sideM: number): void {
    this.#hints.set(id, { metal, sideM });
  }
  unregisterEntity(id: number): void {
    this.#hints.delete(id);
  }

  #pickVoice(ev: ImpactEvent): VoiceId | null {
    const a = this.#hints.get(ev.a);
    if (typeof ev.b === 'string') {
      // Static partner -> the surface speaks.
      const surface = SURFACES[ev.b as SurfaceId];
      return (surface?.voice as VoiceId) ?? 'crack_concrete';
    }
    const b = this.#hints.get(ev.b);
    if (!a && !b) return 'thud_deep';
    if (!b) return METAL_VOICE[a!.metal];
    if (!a) return METAL_VOICE[b.metal];
    return METAL_HARDNESS[a.metal] >= METAL_HARDNESS[b.metal]
      ? METAL_VOICE[a.metal]
      : METAL_VOICE[b.metal];
  }

  #sideHint(ev: ImpactEvent): number {
    return this.#hints.get(ev.a)?.sideM ?? config.audio.pitchRefSideM;
  }

  #isTungsten(ev: ImpactEvent): boolean {
    if (this.#hints.get(ev.a)?.metal === 'W') return true;
    return typeof ev.b === 'number' && this.#hints.get(ev.b)?.metal === 'W';
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.bus.off('impact', this.#onImpact);
    void this.#ctx?.close();
    this.#ctx = null;
  }
}

// ---- synthesis ----------------------------------------------------------------

/** Wraps the pure synth below into an AudioBuffer for the sample pool. */
function renderVoice(ctx: AudioContext, r: VoiceRecipe): AudioBuffer {
  const samples = synthVoice(r, ctx.sampleRate);
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.getChannelData(0).set(samples);
  return buf;
}

/**
 * Modal synthesis: a sum of exponentially decaying inharmonic sines (the body) plus a
 * resonator-filtered noise burst (the strike transient).
 *
 * Deliberately pure — no AudioContext, no DOM — so the one part of the audio path with
 * real maths in it is unit-testable without a browser. Everything downstream is Web
 * Audio plumbing that a test could only re-assert.
 *
 * @param sampleRate Hz
 * @returns mono samples, peak-normalised
 */
export function synthVoice(r: VoiceRecipe, sampleRate: number): Float32Array {
  const sr = sampleRate;
  const tail = Math.max(r.decayS, r.noiseDecayS) * 1.6 + 0.02;
  const n = Math.ceil(tail * sr);
  const out = new Float32Array(n);

  // Band-passed noise via a state-variable filter — 6 lines and it sounds like a strike.
  const f = 2 * Math.sin((Math.PI * Math.min(r.noiseHz, sr * 0.45)) / sr);
  const q = 1 / Math.max(0.35, r.noiseQ);
  let low = 0;
  let band = 0;

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;

    for (let p = 0; p < r.partials.length; p++) {
      const ratio = r.partials[p]!;
      // Higher modes die faster — that decay gradient is most of "this is a solid object".
      const tau = r.decayS / (6.908 * (1 + p * 0.55));
      const amp = 1 / (1 + p * 1.7);
      s += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * r.freq * ratio * t);
    }

    const white = Math.random() * 2 - 1;
    const high = white - low - q * band;
    band += f * high;
    low += f * band;
    s += r.noise * band * Math.exp(-t / (r.noiseDecayS / 6.908));

    if (r.thump && r.thumpHz) {
      s += r.thump * Math.exp(-t / (0.06 / 6.908)) * Math.sin(2 * Math.PI * r.thumpHz * t);
    }

    // 1.5 ms attack ramp: without it every hit starts with a click from the step edge.
    const attack = Math.min(1, t / 0.0015);
    out[i] = s * attack * 0.42;
  }

  // Normalise so the energy->gain curve is the only thing setting loudness.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0.001) {
    const k = 0.85 / peak;
    for (let i = 0; i < n; i++) out[i]! *= k;
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
