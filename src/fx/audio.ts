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
  | 'thud_au'
  | 'clank_al'
  | 'ring_cu'
  | 'tink_ti'
  | 'ring_fe'
  | 'ring_steel'
  | 'knock_oak'
  | 'thump_rubber'
  | 'fumpf_foam'
  | 'tick_ice'
  | 'crack_concrete'
  | 'thump_sand'
  | 'boing_trampoline'
  | 'clack_hook'
  | 'tinkle_glass'
  | 'splat_melon'
  | 'crunch_can'
  | 'crack_egg'
  | 'snap_wood'
  | 'creak_wood'
  | 'splash_water'
  | 'glug_honey'
  | 'plink_mercury';

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
  /**
   * Optional crumple crackle (Farnell, *Designing Sound*): a crumple is not one
   * noise burst but a POISSON TRAIN of discrete micro-buckling clicks with
   * power-law amplitudes. `crackle` is the click count over `crackleSpanS`,
   * front-loaded the way a crush starts dense and peters out.
   */
  crackle?: number;
  crackleSpanS?: number;
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
  /*
   * Au — a dead, low "DUMP", and deliberately the deadest voice here.
   *
   * A struck bar's pitch scales with sqrt(E/ρ), and gold is the outlier: 79 GPa against
   * tungsten's 411 at essentially the same density, which is ~2,020 m/s against ~4,620.
   * So gold sits well below WHA even though the two weigh the same — the one cue that
   * tells the cubes apart when mass and size cannot.
   *
   * Held above the literal ratio (which lands near 45 Hz) because a phone speaker
   * simply does not reproduce that: a voice nobody can hear is not a voice.
   */
  thud_au: {
    freq: 78,
    partials: [1, 2.17, 3.62],
    decayS: 0.055, // shorter even than WHA — soft, ductile, energy goes into the dent
    noise: 0.6,
    noiseHz: 380,
    noiseDecayS: 0.028,
    noiseQ: 0.8,
    thump: 0.8,
    thumpHz: 44,
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
  /*
   * Sand — a dead granular WHUMP (16 §10.5). Almost all noise: sand has no ringing
   * body, just a broad low shove of displaced grains, so the noise term carries it
   * and the tonal part is a formality.
   */
  thump_sand: {
    freq: 66,
    partials: [1, 1.83, 2.62],
    decayS: 0.1,
    noise: 0.85,
    noiseHz: 750,
    noiseDecayS: 0.09,
    noiseQ: 0.4,
    thump: 0.5,
    thumpHz: 44,
  },
  /*
   * Trampoline — the BOING (16 §10.5). The recipe format has no pitch glide, so the
   * wobble comes from close inharmonic partials beating against each other over a
   * long-for-this-table decay; the fabric slap is the short noise burst on top.
   */
  boing_trampoline: {
    freq: 92,
    partials: [1, 1.07, 2.13, 3.4],
    decayS: 0.42,
    noise: 0.2,
    noiseHz: 420,
    noiseDecayS: 0.04,
    noiseQ: 1.6,
  },
  /*
   * The winch hook's release CLACK (16 §6.1) — the one voice no impact ever picks;
   * the Drop lab plays it through `play()`. Bright, tiny, over in 40 ms.
   */
  clack_hook: {
    freq: 1860,
    partials: [1, 1.78, 2.94],
    decayS: 0.035,
    noise: 0.5,
    noiseHz: 3300,
    noiseDecayS: 0.012,
    noiseQ: 1.3,
  },
  /*
   * The wine glass's death (18 §5.3): a bright inharmonic tinkle cluster, played by
   * the lab at the shard swap — never by the impact bus.
   */
  /* Fattened 2026-08-25 — the first cut rendered thin next to the landing thud
   * and the user could not pick it out. */
  tinkle_glass: {
    freq: 2950,
    partials: [1, 1.51, 2.32, 3.17],
    decayS: 0.65,
    noise: 0.6,
    noiseHz: 5200,
    noiseDecayS: 0.09,
    noiseQ: 1.6,
  },
  /* The hero's death (18 §6 C2): a wet, low burst — mostly noise, a soft body
   * thump underneath, over fast. Nothing metallic about it. */
  splat_melon: {
    freq: 210,
    partials: [1, 1.43, 2.18],
    decayS: 0.16,
    noise: 0.85,
    noiseHz: 850,
    noiseDecayS: 0.14,
    noiseQ: 0.7,
    thump: 0.5,
    thumpHz: 85,
  },
  /* Thin aluminium giving way (18 §6 C2): a Poisson crackle of micro-buckling
   * clicks over a modest metallic body — the Farnell crumple model, not a noise
   * burst. The dent plays the same voice quieter; the flatten gets full gain. */
  /* A shell giving way (18 §6 C2): one dry snap of brittle calcite, then the wet
   * slop of what was inside. Short — an egg is over before you register it. */
  /* A shell caving in: a short dry tick of calcite giving way and then the wet
   * slump of what was inside. Duller and wetter than a tinkle — an egg crushed
   * under weight sounds nothing like glass (review, 2026-08-25). */
  crack_egg: {
    freq: 900,
    partials: [1, 1.74, 2.41],
    decayS: 0.05,
    noise: 0.85,
    noiseHz: 1500,
    noiseDecayS: 0.11,
    noiseQ: 0.8,
    thump: 0.35,
    thumpHz: 120,
    crackle: 4,
    crackleSpanS: 0.06,
  },
  /* A pine board letting go across the grain: a hard low CRACK, the fibres tearing
   * as a fast crackle behind it, and no ring at all. This is the loudest thing in
   * the target set and it should read that way. */
  snap_wood: {
    freq: 320,
    partials: [1, 1.58, 2.24, 3.1],
    decayS: 0.19,
    noise: 0.7,
    noiseHz: 1400,
    noiseDecayS: 0.13,
    noiseQ: 0.9,
    thump: 0.55,
    thumpHz: 95,
    crackle: 14,
    crackleSpanS: 0.1,
  },
  /* Sub-threshold: the board takes the hit and complains — a short groan of fibre
   * without the break (18 §5.2's "the board creaks"). */
  creak_wood: {
    freq: 260,
    partials: [1, 1.33, 1.91],
    decayS: 0.22,
    noise: 0.4,
    noiseHz: 700,
    noiseDecayS: 0.18,
    noiseQ: 2.2,
    thump: 0.3,
    thumpHz: 90,
    crackle: 3,
    crackleSpanS: 0.14,
  },
  crunch_can: {
    freq: 480,
    partials: [1, 1.62, 2.41, 3.55],
    decayS: 0.12,
    noise: 0.45,
    noiseHz: 2400,
    noiseDecayS: 0.09,
    noiseQ: 0.9,
    thump: 0.18,
    thumpHz: 140,
    crackle: 26,
    crackleSpanS: 0.16,
  },
  /*
   * Entry splashes (19 §F1). A splash is NOT a metal voice: there is no body to ring,
   * so `partials` is vestigial and the whole character lives in the noise stage.
   *
   * Water is a broadband burst with a low thump under it — the cavity collapsing is
   * what you actually hear, and it is lower and slower than the surface break.
   */
  splash_water: {
    freq: 320,
    partials: [1, 1.7],
    decayS: 0.09,
    noise: 1,
    noiseHz: 1500,
    noiseDecayS: 0.28,
    noiseQ: 0.5,
    thump: 0.45,
    thumpHz: 120,
  },
  /* Honey does not splash, it swallows: almost no transient, a long dull closing. */
  glug_honey: {
    freq: 150,
    partials: [1, 1.4],
    decayS: 0.3,
    noise: 0.5,
    noiseHz: 420,
    noiseDecayS: 0.45,
    noiseQ: 1.4,
    thump: 0.7,
    thumpHz: 70,
  },
  /*
   * Mercury is 13.5x the density of water and barely wets anything, so entry reads
   * hard and metallic rather than wet — closer to dropping a cube into ball bearings
   * than into a pool. Short, bright, and almost no tail.
   */
  plink_mercury: {
    freq: 640,
    partials: [1, 2.4, 3.9],
    decayS: 0.11,
    noise: 0.75,
    noiseHz: 2600,
    noiseDecayS: 0.09,
    noiseQ: 1.1,
    thump: 0.55,
    thumpHz: 150,
  },
};

const METAL_VOICE: Record<MetalId, VoiceId> = {
  W: 'thud_deep',
  Au: 'thud_au',
  Al: 'clank_al',
  Cu: 'ring_cu',
  Ti: 'tink_ti',
  Fe: 'ring_fe',
};

/**
 * Which metal "wins" a cube-on-cube collision — the harder hitter speaks (08 §8.7).
 * Ordered by Mohs, which puts gold at the bottom: at 2.5 it is softer than aluminium,
 * so it never speaks over anything it lands on.
 */
const METAL_HARDNESS: Record<MetalId, number> = { W: 5, Fe: 4, Ti: 3, Cu: 2, Al: 1, Au: 0 };

/** The first sound anyone hears is a cube landing on concrete. Everything else waits. */
const WARM_VOICES: readonly VoiceId[] = ['thud_deep', 'crack_concrete'];

export class AudioBus {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #buffers = new Map<VoiceId, AudioBuffer>();
  /** Live sources per voice, for the oldest-steals polyphony cap. */
  #live = new Map<VoiceId, AudioBufferSourceNode[]>();
  #muted = false;
  #unlocking = false;
  /** Diagnostics for `__dense.audio()` — why a hit did or did not make a sound. */
  readonly #stats = {
    impacts: 0,
    played: 0,
    cooled: 0,
    noVoice: 0,
    tooQuiet: 0,
    stolen: 0,
    resumes: 0,
    /** Non-running states seen since boot — an interruption leaves a trail here. */
    seen: '' as string,
  };
  /** `a|b` -> `performance.now()` of the last thud played for that pair. See `#onImpact`. */
  #pairCooldown = new Map<string, number>();

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

      /*
       * Render the voices we are about to need, and defer the rest.
       *
       * Rendering all eleven synchronously here measured 61.7 ms on desktop — and this
       * runs inside the first pointerdown, i.e. a visible freeze at the exact moment
       * someone first touches the toy, on a phone likely several times worse. The first
       * thing anyone hears is a cube hitting concrete, so warm those two and let the
       * others render on first use (a few ms each, spread out) with an idle pass
       * mopping up whatever is left.
       */
      for (const id of WARM_VOICES) this.#buffers.set(id, renderVoice(ctx, RECIPES[id]));
      await ctx.resume();
      this.#renderRemainingWhenIdle();
      document.addEventListener('visibilitychange', this.#onVisibility);
      // The context announces its own stalls; take them as the cue to restart.
      ctx.addEventListener('statechange', this.#onStateChange);
    } finally {
      this.#unlocking = false;
    }
  }

  readonly #onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.#kick();
  };

  /** The context stalled on its own (interruption, device change) — restart it. */
  readonly #onStateChange = (): void => {
    this.#kick();
  };

  /**
   * Nudge a stalled context back to life.
   *
   * The ONE resume trigger used to be `visibilitychange`, which does not fire for the
   * cases that actually stop the clock while the page stays visible: iOS marks the
   * context `interrupted` for a call or a Siri activation, and a desktop browser can
   * `suspend` one when another tab takes the audio focus or the output device changes.
   * The context then never restarts, every later sound is scheduled into a stopped
   * clock, and the app is silent with no visible cause — "audio randomly disabled"
   * (user, 2026-08-25). So every play attempt checks the state and resumes.
   */
  #kick(): void {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === 'running') return;
    this.#stats.resumes++;
    if (!this.#stats.seen.includes(ctx.state)) {
      this.#stats.seen = this.#stats.seen ? `${this.#stats.seen},${ctx.state}` : ctx.state;
    }
    void ctx.resume().catch(() => {
      /* a resume outside a gesture can be refused; the next gesture retries */
    });
  }

  /**
   * Live diagnostics (debug facade only). `state` is the AudioContext's own — a
   * browser may suspend it under us, which sounds exactly like the sound
   * "randomly turning off".
   */
  get dbg(): Record<string, unknown> {
    const live: Record<string, number> = {};
    for (const [voice, list] of this.#live) if (list.length) live[voice] = list.length;
    return {
      state: this.#ctx?.state ?? 'none',
      /** Non-running states seen since boot, and how often we restarted. */
      stalls: this.#stats.seen || 'none',
      muted: this.#muted,
      masterGain: this.#master?.gain.value ?? null,
      buffers: this.#buffers.size,
      pairKeys: this.#pairCooldown.size,
      live,
      ...this.#stats,
    };
  }

  /**
   * A one-shot on demand — the first non-impact trigger (16 §10.5). Labs reach it
   * through `LabContext.fx`, never by import. Same pipeline as impacts: polyphony
   * cap, oldest-steals, master gain, mute; silent before unlock, like everything.
   */
  play(voice: VoiceId, gain = 0.5, rate = 1): void {
    if (!this.#ctx || this.#muted) return;
    this.#play(voice, Math.max(0, Math.min(1, gain)), rate);
  }

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
    this.#kick();

    /*
     * Per-pair debounce, so one landing is one thud rather than a machine-gun burst.
     *
     * This used to live inside `PhysicsWorld.#drainImpacts`, where it gated the event for
     * EVERY consumer — a real rapid rebound simply never reached the bus (14 PHY-06).
     * Debouncing is an ear problem, so it is solved at the ear. Keyed on the ordered pair
     * and evaluated on the audio clock, which is the clock a listener actually has.
     */
    const key = pairKey(ev);
    const now = performance.now();
    const last = this.#pairCooldown.get(key);
    this.#stats.impacts++;
    if (last !== undefined && now - last < config.audio.pairCooldownMs) {
      this.#stats.cooled++;
      return;
    }
    this.#pairCooldown.set(key, now);

    const voice = this.#pickVoice(ev);
    if (!voice) {
      this.#stats.noVoice++;
      return;
    }

    // gain = clamp01((log10(E) + 2) / 3.5): 0.01 J whispers, 300 J is full scale.
    const gain = clamp01(
      (Math.log10(Math.max(ev.energyJ, 1e-6)) + config.audio.gainOffset) / config.audio.gainRange,
    );
    if (gain <= 0.001) {
      this.#stats.tooQuiet++;
      return;
    }

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

  /** Lazily renders a voice the first time it is actually heard. */
  #bufferFor(voice: VoiceId): AudioBuffer | undefined {
    const ctx = this.#ctx;
    if (!ctx) return undefined;
    let buf = this.#buffers.get(voice);
    if (!buf) {
      buf = renderVoice(ctx, RECIPES[voice]);
      this.#buffers.set(voice, buf);
    }
    return buf;
  }

  /** Fills in the un-warmed voices during idle time, one per callback. */
  #renderRemainingWhenIdle(): void {
    const pending = (Object.keys(RECIPES) as VoiceId[]).filter((id) => !this.#buffers.has(id));
    if (pending.length === 0 || !this.#ctx) return;
    const schedule =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 32);
    const next = (): void => {
      const id = pending.shift();
      if (!id || !this.#ctx) return;
      this.#bufferFor(id);
      if (pending.length) schedule(next);
    };
    schedule(next);
  }

  #play(voice: VoiceId, gain: number, rate: number): void {
    const ctx = this.#ctx!;
    const buf = this.#bufferFor(voice);
    if (!buf) return;

    const list = this.#live.get(voice) ?? [];
    // Oldest-steals: a machine-gun of clangs is worse than a dropped one.
    while (list.length >= config.audio.polyphony) {
      const oldest = list.shift();
      this.#stats.stolen++;
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
      // Let the graph shrink: an orphan gain per hit adds up over a long session.
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* already torn down */
      }
    };
    src.start();
    this.#stats.played++;
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
    // Drop this entity's debounce entries too, or the map grows for the whole session and
    // a recycled pairing inherits a stale timestamp.
    for (const key of this.#pairCooldown.keys()) {
      if (key.startsWith(`${id}|`) || key.endsWith(`|${id}`)) this.#pairCooldown.delete(key);
    }
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
    this.#ctx?.removeEventListener('statechange', this.#onStateChange);
    this.bus.off('impact', this.#onImpact);
    this.#pairCooldown.clear();
    this.#hints.clear();
    void this.#ctx?.close();
    this.#ctx = null;
  }
}

/** Ordered pair key for the audio debounce — `a|b` and `b|a` must be the same landing. */
function pairKey(ev: ImpactEvent): string {
  const b = String(ev.b);
  const a = String(ev.a);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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

  if (r.crackle) {
    // Micro-buckling clicks: each a millisecond ring at its own frequency. The
    // train, not the tone, is what reads as "crinkle".
    const span = r.crackleSpanS ?? 0.15;
    for (let k = 0; k < r.crackle; k++) {
      const start = Math.floor(Math.pow(Math.random(), 0.8) * span * sr);
      const amp = 0.55 * Math.pow(Math.random(), 1.7) + 0.08;
      const fc = 1800 + 2600 * Math.random();
      const phase = Math.random() * Math.PI * 2;
      const dur = Math.floor(0.006 * sr);
      for (let j = 0; j < dur && start + j < n; j++) {
        const tt = j / sr;
        out[start + j]! += amp * Math.exp(-tt / 0.0016) * Math.sin(2 * Math.PI * fc * tt + phase);
      }
    }
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
