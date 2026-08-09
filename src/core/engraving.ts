import * as THREE from 'three';
import { METALS } from '../data/metals.ts';
import type { MetalId } from '../types.ts';

/**
 * The engraved periodic-table face (03 §6, 02 §11) — a user idea from 2026-08-07, and
 * the thing that makes a grey box read as *the* tungsten cube.
 *
 * Generated into a canvas at runtime, so it ships **zero bytes**. 08 §12's "no textures
 * in MVP" exists to protect the 2 MB payload budget; a texture that isn't downloaded
 * doesn't spend it.
 *
 * Two deliberate deviations from the eventual V1 version, both cheap to close:
 *   - The lettering uses the system monospace, not the Gorton-style engraving face.
 *     11 §9 settled that (Routed Gothic, OFL — Open Gorton, MIT — never Gorton
 *     Perfected, which is paid), but a webfont means a download and a CREDITS entry,
 *     and neither belongs in the MVP. Swapping the family later changes one constant.
 *   - Normal + roughness only. 02 §11 also calls for AO; at this groove depth it adds
 *     almost nothing over the normal map's own shading.
 *
 * The real cubes carry this on ONE face. We put it on all six, because the toy is
 * orbited freely and a single engraved face is invisible five sixths of the time —
 * and because a RoundedBoxGeometry is one material group, so per-face maps would mean
 * splitting the geometry for a detail nobody would find.
 */

/** Face texture resolution. 512 holds the lettering crisply at any distance we allow. */
const SIZE = 512;
/**
 * How deep the grooves read in the normal map.
 *
 * Tuned down hard from a first pass at 2.6, which looked like a 3 mm chisel cut rather
 * than an engraving — and perturbed the normals so violently that the faces scattered
 * their environment reflection into near-black. Real machine engraving on these cubes
 * is a few tenths of a millimetre: you read it by the shadow in the groove, not by the
 * relief. If in doubt, go shallower.
 */
const DEPTH = 0.75;

export interface EngravingSpec {
  metal: MetalId;
  /** Tungsten only — "ASTM B777 CL 3" tracks the purity slider (02 §11). */
  astmLine?: string;
}

export interface EngravedMaps {
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  dispose(): void;
}

/**
 * Renders the element tile as a height field, then derives a normal map and a
 * roughness map from it. Grooves are lower AND rougher — a cut surface scatters where
 * the polished face reflects, which is most of what sells it as machined rather than
 * printed.
 */
export function makeEngraving(spec: EngravingSpec): EngravedMaps {
  const height = renderHeightField(spec);
  const normalMap = heightToNormal(height);
  const roughnessMap = heightToRoughness(height, METALS[spec.metal].roughness);
  return {
    normalMap,
    roughnessMap,
    dispose() {
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/** White = the flat face, black = the bottom of a groove. */
function renderHeightField(spec: EngravingSpec): ImageData {
  const metal = METALS[spec.metal];
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;

  g.fillStyle = '#fff';
  g.fillRect(0, 0, SIZE, SIZE);

  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // Atomic number, top-left — where a periodic table puts it.
  g.textAlign = 'left';
  g.font = `600 ${SIZE * 0.11}px ${mono}`;
  g.fillText(String(metal.atomicNumber), SIZE * 0.14, SIZE * 0.2);

  // The symbol, big and centred: the part you read from across the room.
  g.textAlign = 'center';
  g.font = `600 ${SIZE * 0.3}px ${mono}`;
  g.fillText(metal.symbol, SIZE / 2, SIZE * 0.46);

  // Name, letterspaced the way engraved plates are.
  g.font = `500 ${SIZE * 0.075}px ${mono}`;
  drawTracked(g, metal.label.toUpperCase(), SIZE / 2, SIZE * 0.68, SIZE * 0.035);

  // Standard atomic weight.
  g.font = `400 ${SIZE * 0.068}px ${mono}`;
  g.fillText(
    metal.atomicMass.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''),
    SIZE / 2,
    SIZE * 0.78,
  );

  // The alloy grade, tungsten only — it tracks the purity slider, which quietly ties
  // the engraving to the mechanic rather than leaving it decoration.
  if (spec.astmLine) {
    g.font = `500 ${SIZE * 0.05}px ${mono}`;
    drawTracked(g, spec.astmLine.toUpperCase(), SIZE / 2, SIZE * 0.88, SIZE * 0.022);
  }

  // Soften the walls so the groove has a bevel rather than a cliff — a hard step
  // produces a normal map that reads as a printed decal, not a cut.
  g.filter = 'blur(1.1px)';
  g.drawImage(c, 0, 0);
  g.filter = 'none';

  return g.getImageData(0, 0, SIZE, SIZE);
}

/** Canvas has no letter-spacing, and engraved plates are always tracked out. */
function drawTracked(
  g: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  tracking: number,
): void {
  const widths = [...text].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
  let x = cx - total / 2;
  const prev = g.textAlign;
  g.textAlign = 'left';
  [...text].forEach((ch, i) => {
    g.fillText(ch, x, y);
    x += widths[i]! + tracking;
  });
  g.textAlign = prev;
}

/** Sobel over the height field -> tangent-space normal map. */
function heightToNormal(height: ImageData): THREE.Texture {
  const { width: w, height: h, data } = height;
  const out = new ImageData(w, h);
  const at = (x: number, y: number): number => {
    const cx = Math.min(w - 1, Math.max(0, x));
    const cy = Math.min(h - 1, Math.max(0, y));
    return data[(cy * w + cx) * 4]! / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x - 1, y - 1) +
        2 * at(x - 1, y) +
        at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) +
        2 * at(x, y - 1) +
        at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));

      // Normalise (dx*DEPTH, dy*DEPTH, 1) into the 0..255 encoding three expects.
      const nx = dx * DEPTH;
      const ny = dy * DEPTH;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  return toTexture(out, THREE.LinearSRGBColorSpace);
}

/** Grooves scatter; the machined face reflects. */
function heightToRoughness(height: ImageData, base: number): THREE.Texture {
  const { width: w, height: h, data } = height;
  const out = new ImageData(w, h);
  for (let i = 0; i < data.length; i += 4) {
    const flat = data[i]! / 255;
    // 0 (deep groove) -> distinctly rougher; 1 (flat face) -> the metal's own value.
    const r = Math.min(1, base + (1 - flat) * 0.3);
    const v = r * 255;
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return toTexture(out, THREE.LinearSRGBColorSpace);
}

function toTexture(image: ImageData, colorSpace: THREE.ColorSpace): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d')!.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = colorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
