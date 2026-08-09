import type { EventMap, EventName, Handler } from '../types.ts';

/**
 * A ~30-line typed emitter over EventMap (08 §6). Cross-system talk is events, not
 * calls, for anything that fans out — impacts reach audio, the meter and labs without
 * any of them knowing the others exist.
 */
export class EventBus {
  readonly #handlers = new Map<EventName, Set<(payload: never) => void>>();

  on<K extends EventName>(name: K, fn: Handler<K>): () => void {
    let set = this.#handlers.get(name);
    if (!set) {
      set = new Set();
      this.#handlers.set(name, set);
    }
    set.add(fn as (payload: never) => void);
    // Returning the unsubscribe is what keeps teardown honest: a lab that forgets to
    // call off() leaks a listener that fires into a torn-down scene.
    return () => {
      this.off(name, fn);
    };
  }

  off<K extends EventName>(name: K, fn: Handler<K>): void {
    const set = this.#handlers.get(name);
    if (!set) return;
    set.delete(fn as (payload: never) => void);
    if (set.size === 0) this.#handlers.delete(name);
  }

  emit<K extends EventName>(name: K, payload: EventMap[K]): void {
    const set = this.#handlers.get(name);
    if (!set) return;
    // Iterate a copy: a handler that unsubscribes itself (or spawns something that
    // subscribes) must not mutate the set we're walking.
    for (const fn of [...set]) (fn as Handler<K>)(payload);
  }

  /** Live handler count for a name — used by tests to prove off() actually detaches. */
  count(name: EventName): number {
    return this.#handlers.get(name)?.size ?? 0;
  }

  clear(): void {
    this.#handlers.clear();
  }
}
