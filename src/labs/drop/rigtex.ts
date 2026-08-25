import * as THREE from 'three';

/**
 * The rig's generated textures (17 §4) — CanvasTexture maps, built once, deterministic,
 * no downloads. The doctrine they exist to satisfy: NO untextured bespoke surface
 * anywhere the player can look (user rule, 2026-08-24).
 *
 * Designed under the real light: RoomEnvironment at intensity 0.18, which starves
 * bare metalness — so these are painted and galvanised finishes whose roughness maps
 * do the talking, screenshot-proofed in R0 before anything was built on them.
 *
 * Node-safe the way the engraving pipeline is: no `document`, no texture — callers
 * fall back to flat colour, which only the physics suite ever sees.
 */

export interface RigMaps {
  map: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

/** Deterministic PRNG — the spangle pattern must not change between sessions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d');
}

function tex(ctx: CanvasRenderingContext2D): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Blotchy multi-scale value noise, drawn as soft rects — fast and band-free. */
function noise(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  passes: { n: number; size: number; alpha: number; light: string; dark: string }[],
): void {
  const { width: w, height: h } = ctx.canvas;
  for (const p of passes) {
    for (let i = 0; i < p.n; i++) {
      ctx.fillStyle = rnd() < 0.5 ? p.light : p.dark;
      ctx.globalAlpha = p.alpha * (0.5 + rnd() * 0.5);
      const s = p.size * (0.6 + rnd() * 0.8);
      ctx.fillRect(rnd() * w - s / 2, rnd() * h - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * T1 — galvanised steel: mid grey with crystalline spangle patches. The mast's
 * members stretch this along their length; the streaking that produces is what
 * rolled steel looks like, so the UV stretch works FOR the finish, not against it.
 */
export function galvanized(): RigMaps | null {
  const c = canvas(256, 256);
  const r = canvas(256, 256);
  if (!c || !r) return null;
  const rnd = mulberry32(0xd0d0);
  // Weathered zinc: darker base, strong vertical run-streaks, real tonal depth.
  c.fillStyle = '#828a92';
  c.fillRect(0, 0, 256, 256);
  for (let i2 = 0; i2 < 46; i2++) {
    const x = rnd() * 256;
    const w = 2 + rnd() * 9;
    c.globalAlpha = 0.05 + rnd() * 0.07;
    c.fillStyle = rnd() < 0.55 ? '#6a727a' : '#98a0a8';
    c.fillRect(x, 0, w, 256);
  }
  c.globalAlpha = 1;
  noise(c, rnd, [
    { n: 90, size: 70, alpha: 0.07, light: '#9aa2aa', dark: '#6a727a' },
    { n: 200, size: 18, alpha: 0.08, light: '#a4acb4', dark: '#666e76' },
  ]);
  // Faded spangle patches.
  for (let i2 = 0; i2 < 60; i2++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const sz = 10 + rnd() * 20;
    c.save();
    c.translate(x, y);
    c.rotate(rnd() * Math.PI);
    c.globalAlpha = 0.05 + rnd() * 0.05;
    c.fillStyle = rnd() < 0.5 ? '#aeb6be' : '#656d75';
    c.beginPath();
    c.moveTo(-sz / 2, 0);
    c.lineTo(0, -sz / 3);
    c.lineTo(sz / 2, 0);
    c.lineTo(0, sz / 3);
    c.closePath();
    c.fill();
    c.restore();
  }
  c.globalAlpha = 1;
  // Roughness: WIDE range — streak-aligned, splice smoother, stains rough.
  const rr = mulberry32(0xd0d1);
  r.fillStyle = '#8a8a8a';
  r.fillRect(0, 0, 256, 256);
  for (let i2 = 0; i2 < 70; i2++) {
    const x = rr() * 256;
    r.globalAlpha = 0.12 + rr() * 0.12;
    r.fillStyle = rr() < 0.5 ? '#5a5a5a' : '#b4b4b4';
    r.fillRect(x, 0, 2 + rr() * 8, 256);
  }
  r.globalAlpha = 1;
  noise(r, rr, [{ n: 130, size: 26, alpha: 0.2, light: '#c2c2c2', dark: '#525252' }]);
  const roughness = tex(r);
  roughness.colorSpace = THREE.NoColorSpace;
  return { map: tex(c), roughnessMap: roughness };
}

/** T2 — painted rig steel: flat coat, vertical streaking, worked edges. */
export function paintedSteel(): RigMaps | null {
  const c = canvas(256, 256);
  const r = canvas(256, 256);
  if (!c || !r) return null;
  const rnd = mulberry32(0xbeef);
  c.fillStyle = '#68737d';
  c.fillRect(0, 0, 256, 256);
  // Vertical weather streaks.
  for (let i = 0; i < 46; i++) {
    const x = rnd() * 256;
    c.globalAlpha = 0.05 + rnd() * 0.05;
    c.fillStyle = rnd() < 0.7 ? '#59636c' : '#77828c';
    c.fillRect(x, 0, 1 + rnd() * 3, 256);
  }
  noise(c, rnd, [{ n: 120, size: 30, alpha: 0.05, light: '#75808a', dark: '#5b656e' }]);
  // Working scratches: thin bright nicks a rig accumulates.
  for (let i2 = 0; i2 < 14; i2++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const len = 12 + rnd() * 46;
    const a = rnd() * Math.PI;
    c.save();
    c.translate(x, y);
    c.rotate(a);
    c.globalAlpha = 0.1 + rnd() * 0.12;
    c.fillStyle = '#98a2ab';
    c.fillRect(-len / 2, 0, len, 1.2);
    c.restore();
  }
  c.globalAlpha = 1;
  // Edge wear: darkened frame with chipped speckle.
  c.globalAlpha = 0.35;
  c.strokeStyle = '#4a545d';
  c.lineWidth = 10;
  c.strokeRect(3, 3, 250, 250);
  c.globalAlpha = 1;
  for (let i = 0; i < 70; i++) {
    const edge = Math.floor(rnd() * 4);
    const t = rnd() * 256;
    const pick = [
      [t, 4 + rnd() * 8],
      [t, 252 - rnd() * 8],
      [4 + rnd() * 8, t],
      [252 - rnd() * 8, t],
    ][edge]!;
    const x = pick[0]!;
    const y = pick[1]!;
    c.globalAlpha = 0.25 * rnd();
    c.fillStyle = '#3f474f';
    c.fillRect(x, y, 2 + rnd() * 3, 1 + rnd() * 2);
  }
  c.globalAlpha = 1;
  const rr = mulberry32(0xbef0);
  r.fillStyle = '#7d7d7d';
  r.fillRect(0, 0, 256, 256);
  noise(r, rr, [{ n: 120, size: 30, alpha: 0.15, light: '#939393', dark: '#666666' }]);
  const roughness = tex(r);
  roughness.colorSpace = THREE.NoColorSpace;
  return { map: tex(c), roughnessMap: roughness };
}

/**
 * T3 — hazard chevron, 45°, in the palette's own warn amber rather than raw safety
 * yellow (17 §4.4): the functional edges get marked, the family stays coherent.
 */
export function hazardChevron(): RigMaps | null {
  const c = canvas(256, 64);
  if (!c) return null;
  c.fillStyle = '#d9a13c';
  c.fillRect(0, 0, 256, 64);
  c.fillStyle = '#17140f';
  for (let x = -64; x < 256 + 64; x += 64) {
    c.beginPath();
    c.moveTo(x, 64);
    c.lineTo(x + 32, 64);
    c.lineTo(x + 96, 0);
    c.lineTo(x + 64, 0);
    c.closePath();
    c.fill();
  }
  // A little grime so it reads as paint, not UI.
  const rnd = mulberry32(0xcafe);
  noise(c, rnd, [{ n: 90, size: 10, alpha: 0.06, light: '#e6b45a', dark: '#0f0d0a' }]);
  return { map: tex(c) };
}

/** T4 — stencilled plate: deadpan machine-shop labelling (01's tone). */
export function stencilPlate(line1: string, line2: string): RigMaps | null {
  const c = canvas(512, 256);
  if (!c) return null;
  const rnd = mulberry32(0xfade);
  c.fillStyle = '#2b3138';
  c.fillRect(0, 0, 512, 256);
  noise(c, rnd, [{ n: 160, size: 26, alpha: 0.06, light: '#39404a', dark: '#20252b' }]);
  c.strokeStyle = '#4a545d';
  c.lineWidth = 4;
  c.strokeRect(10, 10, 492, 236);
  // Shrink-to-fit, the LCD's rule (weigh display): text that overflows its plate is
  // not signage, it is a bug (user-caught, twice).
  c.textAlign = 'center';
  const fit = (text: string, weight: number, startPx: number, maxW: number): void => {
    let px = startPx;
    c.font = `${weight} ${px}px ui-monospace, Menlo, monospace`;
    while (c.measureText(text).width > maxW && px > 18) {
      px -= 2;
      c.font = `${weight} ${px}px ui-monospace, Menlo, monospace`;
    }
  };
  c.fillStyle = '#cfd6dc';
  fit(line1, 700, 64, 440);
  c.fillText(line1, 256, 118);
  c.fillStyle = '#d9a13c';
  fit(line2, 600, 44, 400);
  c.fillText(line2, 256, 196);
  return { map: tex(c) };
}
