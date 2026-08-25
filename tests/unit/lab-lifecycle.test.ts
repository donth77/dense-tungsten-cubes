import { describe, expect, it, vi } from 'vitest';
import { LabManager } from '../../src/labs/lab.ts';
import type { Lab, LabContext, LabId } from '../../src/labs/lab.ts';

/**
 * The lab lifecycle (15 §8.1, §8.4). No wasm and no DOM — this is about ORDER and
 * STALENESS, both of which are pure control flow.
 *
 * The phases exist because one `update(dt)` could not say which side of the solver it
 * ran on, and an instrument gets that wrong in opposite directions: support forces
 * applied after the step are a frame late, readings sampled before it describe the
 * previous one.
 */

function ctx(): LabContext {
  return {
    physics: {} as LabContext['physics'],
    entities: {} as LabContext['entities'],
    render: {} as LabContext['render'],
    scene: {} as LabContext['scene'],
    // Only what LabManager itself touches: it emits 'lab-changed' on a successful build.
    bus: { emit: () => undefined } as unknown as LabContext['bus'],
    camera: { frameRadius: () => undefined },
    units: () => 'si' as const,
    ui: {
      setControls: () => undefined,
      mountPanel: () => ({ update: () => undefined, dispose: () => undefined }),
      toast: () => undefined,
      share: () => undefined,
      resetLab: () => undefined,
    },
    fx: {
      play: () => undefined,
      haptic: () => undefined,
      decals: { setTarget: () => undefined, clear: () => undefined },
    },
    replay: {
      track: () => undefined,
      untrack: () => undefined,
      markNow: () => ({ step: -1 }),
      snapshot: () => null,
      playClip: () => undefined,
      play: () => undefined,
      isPlaying: () => false,
    },
  };
}

function fakeLab(id: LabId): Lab & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    title: id,
    calls,
    build: () => calls.push('build'),
    beforePhysics: () => calls.push('beforePhysics'),
    afterPhysics: () => calls.push('afterPhysics'),
    render: () => calls.push('render'),
    reset: () => calls.push('reset'),
    teardown: () => calls.push('teardown'),
    preferredSpawnPoint: () => ({ x: 1, y: 2, z: 3 }),
  };
}

describe('LabManager phases', () => {
  it('dispatches every phase to the active lab', async () => {
    const lab = fakeLab('weigh');
    const m = new LabManager(ctx(), () => Promise.resolve(lab));
    await m.switchTo('weigh');

    m.beforePhysics(1 / 60);
    m.afterPhysics(1 / 60);
    m.render(0.5);
    m.reset();

    expect(lab.calls).toEqual(['build', 'beforePhysics', 'afterPhysics', 'render', 'reset']);
  });

  it('answers the spawn seam from the active lab, and null with no lab', () => {
    const m = new LabManager(ctx(), () => Promise.resolve(fakeLab('weigh')));
    expect(m.preferredSpawnPoint()).toBeNull();
  });

  it('routes the spawn seam through the lab once one is active', async () => {
    const m = new LabManager(ctx(), () => Promise.resolve(fakeLab('weigh')));
    await m.switchTo('weigh');
    expect(m.preferredSpawnPoint()).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('goes silent after teardown rather than dispatching into a dead lab', async () => {
    const lab = fakeLab('weigh');
    const m = new LabManager(ctx(), () => Promise.resolve(lab));
    await m.switchTo('weigh');
    m.teardown();
    lab.calls.length = 0;

    m.beforePhysics(1 / 60);
    m.afterPhysics(1 / 60);
    m.render(0.5);
    m.reset();

    expect(lab.calls).toEqual([]);
    expect(m.activeId).toBeNull();
  });

  it('never lets a slow import build over the lab that was asked for later', async () => {
    // 15 §8.4 / 14 ENG-04. Two dynamic imports are two outstanding promises with no
    // ordering guarantee; the slow one resolving last must be dropped on the floor.
    const slow = fakeLab('weigh');
    const fast = fakeLab('sandbox');
    let releaseSlow: () => void = () => undefined;

    const m = new LabManager(ctx(), (id) =>
      id === 'weigh'
        ? new Promise<Lab>((resolve) => {
            releaseSlow = () => resolve(slow);
          })
        : Promise.resolve(fast),
    );

    const first = m.switchTo('weigh');
    const second = m.switchTo('sandbox');
    await second;
    releaseSlow();
    await first;

    expect(slow.calls).toEqual([]); // never built
    expect(m.activeId).toBe('sandbox');

    // ...and the phases go to the lab the player actually chose.
    fast.calls.length = 0;
    m.beforePhysics(1 / 60);
    expect(fast.calls).toEqual(['beforePhysics']);
  });

  it('tears the old lab down before building the new one', async () => {
    const order: string[] = [];
    const a: Lab = {
      id: 'sandbox',
      title: 'a',
      build: () => order.push('build a'),
      teardown: () => order.push('teardown a'),
    };
    const b: Lab = {
      id: 'weigh',
      title: 'b',
      build: () => order.push('build b'),
      teardown: () => order.push('teardown b'),
    };
    const m = new LabManager(ctx(), (id) => Promise.resolve(id === 'sandbox' ? a : b));
    await m.switchTo('sandbox');
    await m.switchTo('weigh');
    expect(order).toEqual(['build a', 'teardown a', 'build b']);
  });

  it('tolerates a lab that implements no optional hook at all', async () => {
    const bare: Lab = { id: 'weigh', title: 'bare', build: vi.fn(), teardown: vi.fn() };
    const m = new LabManager(ctx(), () => Promise.resolve(bare));
    await m.switchTo('weigh');
    expect(() => {
      m.beforePhysics(1 / 60);
      m.afterPhysics(1 / 60);
      m.render(0.5);
      m.reset();
    }).not.toThrow();
    expect(m.preferredSpawnPoint()).toBeNull();
  });
});
