import type { CubeSpec, LabId, MetalId, Quat, SurfaceId, Vec3 } from '../types.ts';

/**
 * The share codec, v1 (05; 16 §11.6): `#s=` + base64url(JSON). Applied on load,
 * written only when the player presses SHARE — never per frame.
 *
 * Quantised on purpose: positions to the millimetre, rotations to three decimals
 * (renormalised on decode), so a full 30-cube scene stays under ~2 kB of URL. Decoding
 * is total: anything malformed — wrong version, unknown metal or floor, a hostile
 * payload — returns null and the app boots normally. A share link is input from the
 * internet and gets treated like one.
 */

export interface SceneCube {
  spec: CubeSpec;
  p: Vec3;
  q: Quat;
}

export interface SceneState {
  lab: LabId;
  cubes: readonly SceneCube[];
  cam: { azDeg: number; elDeg: number; distM: number; target: Vec3 };
  drop?: { hM: number; floor: SurfaceId; air: boolean };
}

export const SHARE_MAX_CUBES = 30;

const LABS: readonly LabId[] = ['sandbox', 'weigh', 'drop'];
const METALS: readonly MetalId[] = ['W', 'Au', 'Cu', 'Fe', 'Ti', 'Al'];
const SURFACES: readonly SurfaceId[] = [
  'concrete',
  'steel',
  'oak',
  'rubber',
  'foam',
  'ice',
  'sand',
  'trampoline',
];

interface WireCube {
  m: MetalId;
  s: number;
  p?: number;
  pos: [number, number, number];
  q: [number, number, number, number];
}
interface Wire {
  v: 1;
  lab: LabId;
  cubes: WireCube[];
  cam: { az: number; el: number; d: number; t: [number, number, number] };
  drop?: { h: number; floor: SurfaceId; air: boolean };
}

const mm = (m: number): number => Math.round(m * 1000);
const q3 = (v: number): number => Math.round(v * 1000);

export function encodeScene(state: SceneState): { hash: string; droppedCubes: number } {
  const kept = state.cubes.slice(0, SHARE_MAX_CUBES);
  const wire: Wire = {
    v: 1,
    lab: state.lab,
    cubes: kept.map((c) => ({
      m: c.spec.metal,
      s: Number(c.spec.sideM.toFixed(4)),
      ...(c.spec.purityPctW !== undefined ? { p: c.spec.purityPctW } : {}),
      pos: [mm(c.p.x), mm(c.p.y), mm(c.p.z)],
      q: [q3(c.q.x), q3(c.q.y), q3(c.q.z), q3(c.q.w)],
    })),
    cam: {
      az: Number(state.cam.azDeg.toFixed(1)),
      el: Number(state.cam.elDeg.toFixed(1)),
      d: Number(state.cam.distM.toFixed(2)),
      t: [mm(state.cam.target.x), mm(state.cam.target.y), mm(state.cam.target.z)],
    },
    ...(state.drop
      ? {
          drop: {
            h: Number(state.drop.hM.toFixed(2)),
            floor: state.drop.floor,
            air: state.drop.air,
          },
        }
      : {}),
  };
  const b64 = btoa(JSON.stringify(wire)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { hash: `#s=${b64}`, droppedCubes: state.cubes.length - kept.length };
}

/** Accepts `#s=…`, `s=…`, or a full URL; null on anything it cannot vouch for. */
export function decodeScene(hashOrUrl: string): SceneState | null {
  try {
    const hashAt = hashOrUrl.indexOf('#');
    const frag = hashAt >= 0 ? hashOrUrl.slice(hashAt + 1) : hashOrUrl;
    const part = frag.split('&').find((p) => p.startsWith('s='));
    if (!part) return null;
    const b64 = part.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const wire: unknown = JSON.parse(atob(b64));
    return fromWire(wire);
  } catch {
    return null;
  }
}

function fromWire(w: unknown): SceneState | null {
  if (typeof w !== 'object' || w === null) return null;
  const o = w as Partial<Wire>;
  if (o.v !== 1) return null;
  if (!o.lab || !LABS.includes(o.lab)) return null;
  if (!Array.isArray(o.cubes) || o.cubes.length > SHARE_MAX_CUBES) return null;
  if (!o.cam || !isFiniteTriple(o.cam.t) || !fin(o.cam.az) || !fin(o.cam.el) || !fin(o.cam.d)) {
    return null;
  }
  const cubes: SceneCube[] = [];
  for (const c of o.cubes) {
    if (!c || !METALS.includes(c.m)) return null;
    if (!fin(c.s) || c.s < 0.005 || c.s > 0.4) return null;
    if (c.p !== undefined && (!fin(c.p) || c.p < 90 || c.p > 97)) return null;
    if (!isFiniteTriple(c.pos) || !isFiniteQuad(c.q)) return null;
    const len = Math.hypot(c.q[0], c.q[1], c.q[2], c.q[3]);
    if (len < 1e-6) return null;
    cubes.push({
      spec: { metal: c.m, sideM: c.s, ...(c.p !== undefined ? { purityPctW: c.p } : {}) },
      p: { x: c.pos[0] / 1000, y: c.pos[1] / 1000, z: c.pos[2] / 1000 },
      q: { x: c.q[0] / len, y: c.q[1] / len, z: c.q[2] / len, w: c.q[3] / len },
    });
  }
  let drop: SceneState['drop'];
  if (o.drop !== undefined) {
    const d = o.drop;
    if (!fin(d.h) || d.h < 0.05 || d.h > 25) return null;
    if (!SURFACES.includes(d.floor)) return null;
    if (typeof d.air !== 'boolean') return null;
    drop = { hM: d.h, floor: d.floor, air: d.air };
  }
  return {
    lab: o.lab,
    cubes,
    cam: {
      azDeg: o.cam.az,
      elDeg: o.cam.el,
      distM: o.cam.d,
      target: { x: o.cam.t[0] / 1000, y: o.cam.t[1] / 1000, z: o.cam.t[2] / 1000 },
    },
    ...(drop ? { drop } : {}),
  };
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isFiniteTriple = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(fin);
const isFiniteQuad = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(fin);
