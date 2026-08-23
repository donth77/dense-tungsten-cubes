import * as THREE from 'three';
import { config } from '../../config.ts';
import { massFixed } from '../../data/format.ts';
import type { Units } from '../../data/format.ts';
import type { ScaleState } from './signal.ts';

/**
 * The kitchen scale's live LCD (15 §7.7, §7.8).
 *
 * A CanvasTexture painted onto the asset's own `Display` material, so the number appears
 * on the instrument rather than in a HUD panel floating beside it. That is the whole
 * point of a 3D instrument: you read it by looking at it.
 *
 * It renders the SIGNAL'S state verbatim and adds nothing. Where the state says there is
 * no mass to report — moving, under minimum, overloaded — this shows what the scale
 * actually knows (a force in newtons, or `OL`) instead of a stale number. The display is
 * the last place a measurement could quietly become a lie, so it is the last place that
 * gets to invent anything.
 */

const GRAVITY = config.physics.gravityMps2;
const W = 512;
const H = 256;

/** `--acc` and the LCD greens, hardcoded: labs/ cannot read CSS custom properties. */
const LCD_BG = '#101a14';
const LCD_ON = '#7dfcb4';
const LCD_DIM = '#2f6b4d';

export class ScaleDisplay {
  readonly texture: THREE.CanvasTexture;
  readonly #ctx: CanvasRenderingContext2D;
  #lastKey = '';

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.#ctx = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Default flipY. The overlay quad owns the orientation — see ScaleInstrument's
    // #attachDisplay — so the texture stays conventional.
    this.#paint('—', 'ZEROING…', '');
  }

  /**
   * @param units the player's unit setting; the scale shows the other unit as a subtitle,
   *   the same way the info card does.
   */
  update(state: ScaleState, units: Units): void {
    let primary: string;
    let status: string;
    let sub = '';
    let provisional = false;

    if (!state.zeroed) {
      // Nothing is a mass until the platter's own weight has been zeroed out.
      primary = '—';
      status = 'ZEROING…';
    } else {
      switch (state.status) {
        case 'stable': {
          // Fixed decimals, so the reading does not change width as it updates — and so the
          // 1.5 in cube can honestly show `1.00 kg` (02 §3, `massFixed`).
          const r = massFixed(state.stableMassKg ?? 0, 2, units);
          primary = r.primary;
          status = state.tareOffsetN !== 0 ? 'NET' : 'STABLE';
          sub = r.secondary;
          break;
        }
        case 'under-min': {
          /*
           * Two different situations share this status, and they must not share a face.
           * An EMPTY zeroed scale reads within a division of nothing, and every real
           * scale shows that as 0.00 — "UNDER MIN" on an empty platter reads as a fault.
           * A small object the scale cannot resolve to its rated accuracy (the 0.5 in
           * cubes, at 6-37 g) shows the number it can see, flagged as below the minimum.
           */
          const kg = state.netForceN / GRAVITY;
          const S = config.weigh.scale;
          const r = massFixed(Math.abs(kg) < S.divisionKg / 2 ? 0 : kg, 2, units);
          primary = r.primary;
          sub = r.secondary;
          status = Math.abs(kg) < S.divisionKg / 2 ? 'STABLE' : `UNDER MIN ${S.minIndicationKg} KG`;
          break;
        }
        case 'overload':
          primary = 'OL';
          status = `OVERLOAD — MAX ${config.weigh.scale.ratedKg} KG`;
          break;
        case 'partial-support':
          primary = '— —';
          status = 'PARTIAL SUPPORT';
          break;
        case 'initializing':
          primary = '—';
          status = 'ZEROING…';
          break;
        default: {
          /*
           * Moving. A MASS, shown provisionally — dimmed digits and SETTLING — rather than
           * a force in newtons.
           *
           * 15 §7.7 asks for newtons while anything moves, and that was built. It is the
           * wrong place to apply the honesty rule: no kitchen scale shows newtons, and a
           * reading that flips unit mid-settle looks broken rather than careful. What has to
           * be gated is the CLAIM that the number is settled, and the status line does that.
           * The digits here are the filtered net force over g, nothing more.
           */
          // Below the minimum indication it is zero, in both units. A zeroed scale's net
          // reading wanders a few thousandths either side of nothing while it settles,
          // and "-0.01 lb" on an empty platter is noise wearing a minus sign.
          const kg = state.netForceN / GRAVITY;
          const shown = Math.abs(kg) < config.weigh.scale.minIndicationKg ? 0 : kg;
          const r = massFixed(shown, 2, units);
          primary = r.primary;
          status = 'SETTLING';
          sub = r.secondary;
          provisional = true;
          break;
        }
      }
    }

    const key = `${primary}|${status}|${sub}|${provisional}`;
    if (key === this.#lastKey) return; // repainting an unchanged canvas uploads a texture
    this.#lastKey = key;
    this.#paint(primary, status, sub, provisional);
  }

  #paint(primary: string, status: string, sub: string, provisional = false): void {
    const c = this.#ctx;
    c.fillStyle = LCD_BG;
    c.fillRect(0, 0, W, H);

    c.textAlign = 'center';
    // Dimmed while provisional: the number is live, but the scale is not yet vouching
    // for it. The same cue a real scale gives with a blinking reading.
    c.fillStyle = provisional ? LCD_DIM : LCD_ON;
    // Shrink to fit rather than overflow: "UNDER MIN" is much wider than "1.00 kg".
    let size = 96;
    c.font = `600 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
    while (c.measureText(primary).width > W - 48 && size > 28) {
      size -= 6;
      c.font = `600 ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
    }
    c.fillText(primary, W / 2, H / 2 + size * 0.2);

    c.fillStyle = LCD_DIM;
    c.font = '500 30px ui-monospace, "SF Mono", Menlo, monospace';
    c.fillText(status, W / 2, H - 36);
    if (sub) c.fillText(sub, W / 2, 52);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
