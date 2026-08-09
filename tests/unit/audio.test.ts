import { describe, expect, it } from 'vitest';
import { RECIPES, synthVoice, type VoiceId } from '../../src/fx/audio.ts';

/**
 * The synthesis is the only part of the audio path with real maths in it; everything
 * downstream is Web Audio plumbing a test could only re-assert. M0 ships synthesised
 * voices rather than samples, so these are the properties that decide whether the thud
 * lands (08 §11 step 7).
 */

const SR = 48_000;

/** RMS over a window given in seconds. */
function rms(samples: Float32Array, fromS: number, toS: number): number {
  const a = Math.max(0, Math.floor(fromS * SR));
  const b = Math.min(samples.length, Math.ceil(toS * SR));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (b - a));
}

const ALL = Object.keys(RECIPES) as VoiceId[];

describe('synthVoice — every voice is real, finite, click-free audio', () => {
  it.each(ALL)('%s', (id) => {
    const s = synthVoice(RECIPES[id], SR);

    expect(s.length).toBeGreaterThan(SR * 0.05); // at least 50 ms of tail
    for (let i = 0; i < s.length; i++) {
      if (!Number.isFinite(s[i]!)) throw new Error(`non-finite sample at ${i} in ${id}`);
    }

    // Peak-normalised, so the energy->gain curve is the only thing setting loudness.
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.85, 2);

    // Starts from silence: the 1.5 ms attack ramp is what stops every hit opening with
    // a step-edge click, which on a phone speaker is the whole difference between
    // "impact" and "glitch".
    expect(Math.abs(s[0]!)).toBeLessThan(0.02);

    // It's a strike, not a tone: the tail must be well below the attack.
    const early = rms(s, 0, 0.01);
    const late = rms(s, s.length / SR - 0.01, s.length / SR);
    expect(late).toBeLessThan(early * 0.5);
  });
});

describe('material identity lives in the decay, not the pitch (02 §10)', () => {
  it('tungsten is dead — it stops before copper has started to fade', () => {
    const w = synthVoice(RECIPES.thud_deep, SR);
    const cu = synthVoice(RECIPES.ring_cu, SR);
    // At 150 ms the WHA cube should be essentially silent while copper still rings.
    const wAt150 = rms(w, 0.14, 0.15);
    const cuAt150 = rms(cu, 0.14, 0.15);
    expect(cuAt150).toBeGreaterThan(wAt150 * 5);
  });

  it('tungsten carries a sub-bass thump the comparison metals do not', () => {
    expect(RECIPES.thud_deep.thump).toBeGreaterThan(0);
    expect(RECIPES.thud_deep.thumpHz).toBeLessThan(60);
    expect(RECIPES.clank_al.thump).toBeUndefined();
    expect(RECIPES.ring_cu.thump).toBeUndefined();
  });

  it('orders the metals low-to-high the way the real cubes sound', () => {
    // W (dead, low) < Fe < Cu < Al < Ti (bright tink) — 02 §10's voice descriptions.
    expect(RECIPES.thud_deep.freq).toBeLessThan(RECIPES.ring_fe.freq);
    expect(RECIPES.ring_fe.freq).toBeLessThan(RECIPES.ring_cu.freq);
    expect(RECIPES.ring_cu.freq).toBeLessThan(RECIPES.clank_al.freq);
    expect(RECIPES.clank_al.freq).toBeLessThan(RECIPES.tink_ti.freq);
  });

  it('uses inharmonic partials — harmonic ratios would sound like a musical note', () => {
    for (const id of ALL) {
      const partials = RECIPES[id].partials;
      expect(partials[0]).toBe(1);
      // Any partial beyond the fundamental must be off an integer ratio.
      for (const p of partials.slice(1)) {
        expect(Math.abs(p - Math.round(p))).toBeGreaterThan(0.05);
      }
    }
  });
});

describe('sample rate independence', () => {
  it('produces the same duration and peak at 44.1 kHz as at 48 kHz', () => {
    const a = synthVoice(RECIPES.thud_deep, 48_000);
    const b = synthVoice(RECIPES.thud_deep, 44_100);
    expect(a.length / 48_000).toBeCloseTo(b.length / 44_100, 3);
    let peakA = 0;
    let peakB = 0;
    for (const v of a) peakA = Math.max(peakA, Math.abs(v));
    for (const v of b) peakB = Math.max(peakB, Math.abs(v));
    expect(peakA).toBeCloseTo(peakB, 2);
  });
});
