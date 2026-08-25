import { describe, expect, it } from 'vitest';
import { decodeScene, encodeScene, SHARE_MAX_CUBES } from '../../src/core/share.ts';
import type { SceneState } from '../../src/core/share.ts';

function scene(cubes = 2): SceneState {
  return {
    lab: 'drop',
    cubes: Array.from({ length: cubes }, (_, i) => ({
      spec: { metal: 'W' as const, sideM: 0.0508, purityPctW: 95 },
      p: { x: 0.1234567 + i, y: 0.5, z: -0.25 },
      q: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
    })),
    cam: { azDeg: 45, elDeg: 30, distM: 2.2, target: { x: 0, y: 0.15, z: 0 } },
    drop: { hM: 2, floor: 'concrete', air: true },
  };
}

describe('the share codec v1 (16 §11.6)', () => {
  it('round-trips within its stated quantisation', () => {
    const { hash, droppedCubes } = encodeScene(scene());
    expect(droppedCubes).toBe(0);
    expect(hash.startsWith('#s=')).toBe(true);
    expect(hash).toMatch(/^#s=[A-Za-z0-9_-]+$/); // url-safe, no padding
    const back = decodeScene(hash)!;
    expect(back).not.toBeNull();
    expect(back.lab).toBe('drop');
    expect(back.cubes).toHaveLength(2);
    expect(back.cubes[0]!.p.x).toBeCloseTo(0.1234567, 3); // mm quantisation
    const q = back.cubes[0]!.q;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9); // renormalised
    expect(q.y).toBeCloseTo(0.3826834, 2);
    expect(back.drop).toEqual({ hM: 2, floor: 'concrete', air: true });
    expect(back.cam.distM).toBeCloseTo(2.2, 2);
  });

  it('caps at 30 cubes and says how many it dropped', () => {
    const { hash, droppedCubes } = encodeScene(scene(37));
    expect(droppedCubes).toBe(7);
    expect(decodeScene(hash)!.cubes).toHaveLength(SHARE_MAX_CUBES);
  });

  it('accepts a full URL and a bare fragment alike', () => {
    const { hash } = encodeScene(scene(1));
    expect(decodeScene(`https://example.com/${hash}`)).not.toBeNull();
    expect(decodeScene(hash.slice(1))).not.toBeNull();
  });

  it('returns null for anything it cannot vouch for — never a throw', () => {
    expect(decodeScene('')).toBeNull();
    expect(decodeScene('#s=!!!not-base64!!!')).toBeNull();
    expect(decodeScene('#other=abc')).toBeNull();
    const { hash } = encodeScene(scene(1));
    // Tamper: unknown version.
    const raw = JSON.parse(atob(hash.slice(3).replace(/-/g, '+').replace(/_/g, '/')));
    const tamper = (mut: (w: Record<string, unknown>) => void): string => {
      const w = structuredClone(raw) as Record<string, unknown>;
      mut(w);
      return `#s=${btoa(JSON.stringify(w)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    };
    expect(decodeScene(tamper((w) => (w['v'] = 2)))).toBeNull();
    expect(decodeScene(tamper((w) => (w['lab'] = 'crush')))).toBeNull();
    expect(decodeScene(tamper((w) => ((w['cubes'] as { m: string }[])[0]!.m = 'Pb')))).toBeNull();
    expect(
      decodeScene(tamper((w) => ((w['drop'] as { floor: string }).floor = 'lava'))),
    ).toBeNull();
    expect(decodeScene(tamper((w) => ((w['cubes'] as { s: number }[])[0]!.s = 99)))).toBeNull();
  });
});
