import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events.ts';

describe('EventBus', () => {
  it('delivers a payload to every subscriber', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('spawn', a);
    bus.on('spawn', b);

    bus.emit('spawn', { id: 7 });

    expect(a).toHaveBeenCalledExactlyOnceWith({ id: 7 });
    expect(b).toHaveBeenCalledExactlyOnceWith({ id: 7 });
  });

  it('does not cross the streams', () => {
    const bus = new EventBus();
    const onSpawn = vi.fn();
    bus.on('spawn', onSpawn);

    bus.emit('despawn', { id: 1 });

    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('leaks nothing after off()', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('impact', fn);
    expect(bus.count('impact')).toBe(1);

    bus.off('impact', fn);

    expect(bus.count('impact')).toBe(0);
    bus.emit('impact', {
      a: 1,
      b: 'concrete',
      point: { x: 0, y: 0, z: 0 },
      normalSpeedMps: 3,
      energyJ: 1,
      forceN: 100,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe from on()', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('grab', fn);

    off();

    expect(bus.count('grab')).toBe(0);
  });

  it('survives a handler unsubscribing itself mid-emit', () => {
    // A lab tearing down inside an impact handler is the real case here: without
    // iterating a copy, removing from the live Set skips the next subscriber.
    const bus = new EventBus();
    const seen: string[] = [];
    const first = () => {
      seen.push('first');
      bus.off('spawn', first);
    };
    bus.on('spawn', first);
    bus.on('spawn', () => seen.push('second'));

    bus.emit('spawn', { id: 1 });

    expect(seen).toEqual(['first', 'second']);
    expect(bus.count('spawn')).toBe(1);
  });

  it('emitting with no subscribers is a no-op, not a throw', () => {
    const bus = new EventBus();
    expect(() => bus.emit('select', { id: null })).not.toThrow();
  });
});
